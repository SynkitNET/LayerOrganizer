const { app, core, action, imaging } = require("photoshop");
const fs = require("uxp").storage.localFileSystem;

// Global state
let lastProposedStructure = null;

// =====================================================
// COLOR SETTINGS
// =====================================================

const DEFAULT_COLORS = {
    background: "green",
    subject: "orange",
    headline: "yellow",
    text: "blue",
    graphics: "violet",
    logo: "red",
    texture: "gray",
    effect: "seafoam",
    fill: "gray"
};

let colorSettings = {};

// Map user color names to Photoshop color enum values
function getPSColor(type) {
    var userColor = colorSettings[type] || DEFAULT_COLORS[type] || "gray";
    var psColorMap = {
        "none": "none",
        "red": "red",
        "orange": "orange",
        "yellow": "yellowColor",
        "green": "grain",
        "seafoam": "seafoam",
        "blue": "blue",
        "indigo": "indigo",
        "magenta": "magenta",
        "fuchsia": "fuchsia",
        "violet": "violet",
        "gray": "gray"
    };
    return psColorMap[userColor] || "gray";
}

async function loadColorSettings() {
    colorSettings = Object.assign({}, DEFAULT_COLORS);
    try {
        const dataFolder = await fs.getDataFolder();
        const settingsFile = await dataFolder.getEntry("color-settings.json");
        if (settingsFile) {
            const content = await settingsFile.read();
            const saved = JSON.parse(content);
            Object.assign(colorSettings, saved);
        }
    } catch (e) {
        // Use defaults
    }
}

async function saveColorSettings() {
    try {
        const dataFolder = await fs.getDataFolder();
        const settingsFile = await dataFolder.createFile("color-settings.json", { overwrite: true });
        await settingsFile.write(JSON.stringify(colorSettings, null, 2));
    } catch (e) {
        // Ignore
    }
}

function updateColorUI() {
    var rows = document.querySelectorAll(".color-row");
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var type = row.getAttribute("data-type");
        var color = colorSettings[type];
        if (color) {
            var dots = row.querySelectorAll(".dot");
            for (var j = 0; j < dots.length; j++) {
                dots[j].classList.remove("selected");
                if (dots[j].getAttribute("data-c") === color) {
                    dots[j].classList.add("selected");
                }
            }
        }
    }
}

function setupColorHandlers() {
    var allDots = document.querySelectorAll(".dot");
    for (var i = 0; i < allDots.length; i++) {
        (function(dot) {
            dot.onclick = function() {
                var row = dot.parentElement;
                while (row && !row.classList.contains("color-row")) {
                    row = row.parentElement;
                }
                if (!row) return;

                var rowType = row.getAttribute("data-type");
                var color = dot.getAttribute("data-c");

                var rowDots = row.querySelectorAll(".dot");
                for (var j = 0; j < rowDots.length; j++) {
                    rowDots[j].classList.remove("selected");
                }
                dot.classList.add("selected");

                colorSettings[rowType] = color;
                saveColorSettings();
            };
        })(allDots[i]);
    }
}

function setStatus(message, type) {
    var btn = document.getElementById("organizeBtn");
    if (btn) {
        if (message) {
            btn.textContent = message;
            btn.disabled = (type === "working");
        } else {
            btn.textContent = "Organize Layers";
            btn.disabled = false;
        }
    }
}




// =====================================================

// =====================================================
// ADVANCED RECOGNITION ENGINE v2
// Multi-pass contextual analysis with weighted voting
// =====================================================

// =====================================================
// IMAGING API - Real pixel transparency analysis
// =====================================================

async function analyzeLayerAlpha(layerId, layerBounds, docWidth, docHeight) {
    // Analyze actual pixel transparency using Photoshop's Imaging API
    //
    // KEY METRICS for layer classification:
    // - solidContentRatio: pixels with alpha > 200 / visible pixels → high = solid graphic
    // - softContentRatio: pixels with alpha 20-150 / visible pixels → high = soft glow/effect
    // - isSolidElement: mostly opaque content with thin anti-alias edges
    // - isSoftElement: mostly semi-transparent, soft brush/glow type
    //
    const result = {
        hasAlphaData: false,
        // Core alpha metrics
        totalPixels: 0,
        visiblePixels: 0,           // Pixels with alpha > 20 (actually visible)
        opaquePixels: 0,            // Pixels with alpha > 250 (fully solid)
        solidPixels: 0,             // Pixels with alpha > 200 (solid content)
        semiTransparentPixels: 0,   // Pixels with alpha 21-200
        softPixels: 0,              // Pixels with alpha 20-150 (soft/glow territory)
        transparentPixels: 0,       // Pixels with alpha <= 20

        // Derived ratios (all relative to VISIBLE pixels, not total)
        opaquePixelRatio: 1.0,      // opaquePixels / visiblePixels
        solidContentRatio: 1.0,     // solidPixels / visiblePixels (>0.7 = solid element)
        softContentRatio: 0.0,      // softPixels / visiblePixels (>0.5 = soft element)
        averageAlpha: 1.0,          // Average alpha of visible pixels (0-1)

        // CRITICAL: How much of the bounding box is actually filled
        // A 2px cross spanning the doc has high opaqueRatio but LOW boundsFilledRatio
        boundsFilledRatio: 1.0,     // visiblePixels / totalPixels (how much of bounds is filled)

        // Element type flags
        isSolidElement: true,       // Mostly solid content (logo, graphic, subject)
        isSoftElement: false,       // Mostly soft content (glow, effect, soft brush)
        hasGradientAlpha: false,    // Wide alpha transitions (>20px)

        // Color analysis
        hasColorData: false,
        dominantColorCount: 0,
        colorVariance: 0,
        isSingleColor: false,
        isLowColorVariance: false,

        // Debug metrics
        alphaDistribution: null,    // Object showing alpha bucket counts
        avgTransitionDistance: 0
    };

    try {
        // Calculate layer dimensions
        const layerWidth = layerBounds.right - layerBounds.left;
        const layerHeight = layerBounds.bottom - layerBounds.top;

        if (layerWidth <= 0 || layerHeight <= 0) return result;

        // Get pixel data from the layer using Imaging API at FULL resolution
        // No downsampling - accuracy is critical for correct classification
        const pixelResult = await imaging.getPixels({
            layerID: layerId,
            colorSpace: "RGB",
            componentSize: 8
        });

        if (!pixelResult || !pixelResult.imageData) {
            return result;
        }

        const imageData = pixelResult.imageData;
        const hasAlpha = imageData.hasAlpha;
        const components = imageData.components;

        // Get the raw pixel data
        const pixelData = await imageData.getData({ chunky: true });

        if (!pixelData || pixelData.length === 0) {
            return result;
        }

        result.hasAlphaData = hasAlpha;
        result.totalPixels = (pixelData.length / components);

        if (hasAlpha && components >= 4) {
            // =====================================================
            // ALPHA ANALYSIS - Categorize pixels by transparency
            // =====================================================
            //
            // Alpha ranges and what they mean:
            // 0-20:     Transparent (not visible)
            // 21-150:   Soft content (glows, soft brushes, effects)
            // 151-200:  Semi-solid (could be anti-alias or soft edge)
            // 201-250:  Near-opaque (anti-aliased edges of solid content)
            // 251-255:  Fully opaque (solid content)
            //
            let totalVisibleAlpha = 0;
            let opaqueCount = 0;      // alpha > 250
            let solidCount = 0;       // alpha > 200
            let softCount = 0;        // alpha 21-150
            let semiCount = 0;        // alpha 21-200
            let transparentCount = 0; // alpha <= 20
            let visibleCount = 0;     // alpha > 20

            // Alpha distribution buckets for analysis
            const alphaBuckets = {
                transparent: 0,  // 0-20
                veryLight: 0,    // 21-50
                light: 0,        // 51-100
                medium: 0,       // 101-150
                semiSolid: 0,    // 151-200
                nearOpaque: 0,   // 201-250
                opaque: 0        // 251-255
            };

            // Color analysis
            const colorBuckets = new Map();
            let totalR = 0, totalG = 0, totalB = 0;

            for (let i = 0; i < pixelData.length; i += components) {
                const r = pixelData[i];
                const g = pixelData[i + 1];
                const b = pixelData[i + 2];
                const alpha = pixelData[i + 3];

                // Categorize by alpha
                if (alpha <= 20) {
                    transparentCount++;
                    alphaBuckets.transparent++;
                } else {
                    visibleCount++;
                    totalVisibleAlpha += alpha;

                    if (alpha <= 50) {
                        alphaBuckets.veryLight++;
                        softCount++;
                        semiCount++;
                    } else if (alpha <= 100) {
                        alphaBuckets.light++;
                        softCount++;
                        semiCount++;
                    } else if (alpha <= 150) {
                        alphaBuckets.medium++;
                        softCount++;
                        semiCount++;
                    } else if (alpha <= 200) {
                        alphaBuckets.semiSolid++;
                        semiCount++;
                    } else if (alpha <= 250) {
                        alphaBuckets.nearOpaque++;
                        solidCount++;
                    } else {
                        alphaBuckets.opaque++;
                        solidCount++;
                        opaqueCount++;
                    }

                    // Color analysis for visible pixels
                    totalR += r;
                    totalG += g;
                    totalB += b;

                    const rq = Math.floor(r / 8);
                    const gq = Math.floor(g / 8);
                    const bq = Math.floor(b / 8);
                    const colorKey = `${rq}-${gq}-${bq}`;
                    colorBuckets.set(colorKey, (colorBuckets.get(colorKey) || 0) + 1);
                }
            }

            // Store raw counts
            const pixelCount = result.totalPixels;
            result.visiblePixels = visibleCount;
            result.opaquePixels = opaqueCount;
            result.solidPixels = solidCount;
            result.softPixels = softCount;
            result.semiTransparentPixels = semiCount;
            result.transparentPixels = transparentCount;
            result.alphaDistribution = alphaBuckets;

            // Calculate ratios RELATIVE TO VISIBLE PIXELS (not total)
            // This is key - we care about what the visible content looks like
            if (visibleCount > 0) {
                result.opaquePixelRatio = opaqueCount / visibleCount;
                result.solidContentRatio = solidCount / visibleCount;
                result.softContentRatio = softCount / visibleCount;
                result.averageAlpha = (totalVisibleAlpha / visibleCount) / 255;
            } else {
                // No visible pixels
                result.opaquePixelRatio = 0;
                result.solidContentRatio = 0;
                result.softContentRatio = 0;
                result.averageAlpha = 0;
            }

            // CRITICAL: Bounds filled ratio - how much of the bounding box has actual content
            // A 2px cross spanning document has boundsFilledRatio ~0.01 despite opaqueRatio = 1.0
            result.boundsFilledRatio = pixelCount > 0 ? visibleCount / pixelCount : 0;

            console.log(`      BOUNDS FILL: ${(result.boundsFilledRatio * 100).toFixed(1)}% of bounds has content`);

            // Determine element type based on alpha distribution
            // SOLID ELEMENT: >60% of visible pixels are solid (alpha > 200)
            // SOFT ELEMENT: >40% of visible pixels are soft (alpha 21-150)
            result.isSolidElement = result.solidContentRatio > 0.6;
            result.isSoftElement = result.softContentRatio > 0.4;

            console.log(`      ALPHA: visible=${visibleCount}, solid=${solidCount} (${(result.solidContentRatio*100).toFixed(0)}%), soft=${softCount} (${(result.softContentRatio*100).toFixed(0)}%)`);
            console.log(`        → isSolidElement=${result.isSolidElement}, isSoftElement=${result.isSoftElement}`);

            // Color analysis
            result.hasColorData = visibleCount > 0;

            if (visibleCount > 0) {
                // Count significant color clusters
                const minBucketSize = visibleCount * 0.01;
                let significantColors = 0;

                for (const count of colorBuckets.values()) {
                    if (count > minBucketSize) {
                        significantColors++;
                    }
                }

                result.dominantColorCount = significantColors;

                // Calculate color variance
                const avgR = totalR / visibleCount;
                const avgG = totalG / visibleCount;
                const avgB = totalB / visibleCount;

                let varianceSum = 0;
                let sampleCount = 0;
                const sampleStep = Math.max(1, Math.floor(pixelData.length / (components * 1000)));

                for (let i = 0; i < pixelData.length; i += components * sampleStep) {
                    const alpha = pixelData[i + 3];
                    if (alpha > 20) {
                        const r = pixelData[i];
                        const g = pixelData[i + 1];
                        const b = pixelData[i + 2];
                        varianceSum += Math.pow(r - avgR, 2) + Math.pow(g - avgG, 2) + Math.pow(b - avgB, 2);
                        sampleCount++;
                    }
                }

                const maxVariance = 3 * 255 * 255;
                result.colorVariance = sampleCount > 0 ? Math.sqrt(varianceSum / sampleCount) / Math.sqrt(maxVariance) : 0;

                result.isSingleColor = significantColors <= 2 && result.colorVariance < 0.15;
                result.isLowColorVariance = significantColors <= 5 && result.colorVariance < 0.3;

                // GRADIENT ALPHA DETECTION - DISTANCE BASED
                // Measures how wide the semi-transparent zones are
                // Wide zones (>20px) = gradient/soft brush
                // Narrow zones (<=20px) = anti-aliased edges
                // Now using REAL pixel data, no scaling needed
                const rowsToSample = Math.min(10, layerHeight);
                const rowStep = Math.max(1, Math.floor(layerHeight / rowsToSample));
                let totalTransitionDistance = 0;
                let transitionCount = 0;

                for (let row = 0; row < layerHeight; row += rowStep) {
                    const rowStart = row * layerWidth * components;
                    let inTransition = false;
                    let transitionStart = -1;

                    for (let col = 0; col < layerWidth; col++) {
                        const idx = rowStart + col * components;
                        const alpha = pixelData[idx + 3];
                        const isSemi = alpha > 20 && alpha < 230;

                        if (isSemi && !inTransition) {
                            inTransition = true;
                            transitionStart = col;
                        } else if (!isSemi && inTransition) {
                            totalTransitionDistance += col - transitionStart;
                            transitionCount++;
                            inTransition = false;
                        }
                    }

                    if (inTransition) {
                        totalTransitionDistance += layerWidth - transitionStart;
                        transitionCount++;
                    }
                }

                // No scaling needed - we have real pixel data
                const avgTransitionDistance = transitionCount > 0 ?
                    (totalTransitionDistance / transitionCount) : 0;

                result.avgTransitionDistance = avgTransitionDistance;
                result.hasGradientAlpha = avgTransitionDistance > 20 && result.softContentRatio > 0.1;

                console.log(`      COLOR: variance=${result.colorVariance.toFixed(2)}, colors=${significantColors}, singleColor=${result.isSingleColor}`);
                console.log(`      GRADIENT: avgDist=${avgTransitionDistance.toFixed(1)}px, hasGradient=${result.hasGradientAlpha}`);
            }

        } else {
            // No alpha channel = fully opaque
            result.opaquePixelRatio = 1.0;
            result.averageAlpha = 1.0;
            result.opaquePixels = result.totalPixels;

            // Still analyze colors for non-alpha images
            if (components >= 3) {
                const colorBuckets = new Map();
                let totalR = 0, totalG = 0, totalB = 0;
                const pixelCount = result.totalPixels;

                for (let i = 0; i < pixelData.length; i += components) {
                    const r = pixelData[i];
                    const g = pixelData[i + 1];
                    const b = pixelData[i + 2];
                    totalR += r;
                    totalG += g;
                    totalB += b;

                    const rq = Math.floor(r / 8);
                    const gq = Math.floor(g / 8);
                    const bq = Math.floor(b / 8);
                    const colorKey = `${rq}-${gq}-${bq}`;
                    colorBuckets.set(colorKey, (colorBuckets.get(colorKey) || 0) + 1);
                }

                result.hasColorData = true;
                const minBucketSize = pixelCount * 0.01;
                let significantColors = 0;
                for (const count of colorBuckets.values()) {
                    if (count > minBucketSize) significantColors++;
                }
                result.dominantColorCount = significantColors;

                // Color variance
                const avgR = totalR / pixelCount;
                const avgG = totalG / pixelCount;
                const avgB = totalB / pixelCount;
                let varianceSum = 0;
                let sampleCount = 0;
                const sampleStep = Math.max(1, Math.floor(pixelData.length / (components * 1000)));

                for (let i = 0; i < pixelData.length; i += components * sampleStep) {
                    const r = pixelData[i];
                    const g = pixelData[i + 1];
                    const b = pixelData[i + 2];
                    varianceSum += Math.pow(r - avgR, 2) + Math.pow(g - avgG, 2) + Math.pow(b - avgB, 2);
                    sampleCount++;
                }

                const maxVariance = 3 * 255 * 255;
                result.colorVariance = sampleCount > 0 ? Math.sqrt(varianceSum / sampleCount) / Math.sqrt(maxVariance) : 0;
                result.isSingleColor = significantColors <= 2 && result.colorVariance < 0.15;
                result.isLowColorVariance = significantColors <= 5 && result.colorVariance < 0.3;
            }
        }

        // Clean up
        imageData.dispose();

    } catch (e) {
        console.log(`  Alpha analysis error for layer ${layerId}:`, e.message);
    }

    return result;
}

// =====================================================
// MASK ANALYSIS - Determine effective visible area
// =====================================================
// A layer with a mask that reveals only a small area is effectively
// a small element, even if its pixels are 100% solid
//
async function analyzeLayerMask(layer, docWidth, docHeight) {
    const result = {
        hasMask: false,
        maskDensity: 1.0,        // 1.0 = fully visible, 0.1 = 10% visible
        effectiveCoverage: null  // Coverage after mask applied
    };

    try {
        // Check if layer has a mask
        if (!layer.mask) {
            return result;
        }

        result.hasMask = true;

        // Try to get the mask bounds to estimate visibility
        const maskBounds = layer.mask.bounds;
        if (maskBounds) {
            const maskWidth = maskBounds.right - maskBounds.left;
            const maskHeight = maskBounds.bottom - maskBounds.top;
            const maskArea = maskWidth * maskHeight;

            // Compare mask bounds to layer bounds
            const layerBounds = layer.bounds;
            if (layerBounds) {
                const layerWidth = layerBounds.right - layerBounds.left;
                const layerHeight = layerBounds.bottom - layerBounds.top;
                const layerArea = layerWidth * layerHeight;

                // If mask bounds are significantly smaller than layer bounds,
                // the effective visible area is reduced
                if (layerArea > 0) {
                    result.maskDensity = Math.min(1.0, maskArea / layerArea);
                }

                // Calculate effective coverage on canvas
                const effectiveArea = maskArea;
                result.effectiveCoverage = (effectiveArea / (docWidth * docHeight)) * 100;
            }
        }

        // Try to analyze mask pixel data for more accurate density
        try {
            const maskId = layer.mask.id || layer.id;
            const pixelResult = await imaging.getPixels({
                layerID: layer.id,
                applyMask: true,  // Get pixels with mask applied
                colorSpace: "RGB",
                componentSize: 8
            });

            if (pixelResult && pixelResult.imageData) {
                const imageData = pixelResult.imageData;
                const pixelData = await imageData.getData({ chunky: true });
                const components = imageData.components;

                if (imageData.hasAlpha && components >= 4) {
                    let visiblePixels = 0;
                    let totalPixels = pixelData.length / components;

                    for (let i = 0; i < pixelData.length; i += components) {
                        const alpha = pixelData[i + 3];
                        if (alpha > 20) visiblePixels++;
                    }

                    result.maskDensity = totalPixels > 0 ? visiblePixels / totalPixels : 1.0;

                    // Calculate effective coverage
                    const layerBounds = layer.bounds;
                    if (layerBounds) {
                        const layerArea = (layerBounds.right - layerBounds.left) * (layerBounds.bottom - layerBounds.top);
                        const effectiveArea = layerArea * result.maskDensity;
                        result.effectiveCoverage = (effectiveArea / (docWidth * docHeight)) * 100;
                    }

                    console.log(`      MASK: density=${(result.maskDensity * 100).toFixed(1)}%, effective coverage=${result.effectiveCoverage?.toFixed(1)}%`);
                }
            }
        } catch (pixelError) {
            // Pixel analysis failed, use bounds-based estimate
            console.log(`      MASK: pixel analysis failed, using bounds estimate`);
        }

    } catch (e) {
        // Mask analysis failed, assume fully visible
        console.log(`      MASK: analysis error - ${e.message}`);
    }

    return result;
}

// =====================================================
// RULE-BASED CLASSIFICATION ENGINE v3
// Clear rules with logical structure
// =====================================================

/*
CLASSIFICATION HIERARCHY:
1. DEFINITIVE: Layer type determines classification (adjustments, fills)
2. EXPLICIT: Name explicitly states what it is (contains "logo", "texture", etc.)
3. INFERRED: Use evidence to determine most likely classification
4. DEFAULT: Fall back to sensible default based on layer type

CATEGORIES:
- adjustment: Color/tonal adjustment layers
- fill: Solid color, gradient, pattern fills
- text: Text layers (readable text content)
- headline: Large/prominent text
- caption: Small credit/caption text
- logo: Brand marks, watermarks, logos
- subject: Main subject (person, product, etc.)
- background: Base/background layers
- texture: Texture overlays, grain, noise
- graphics: Shapes, lines, decorative elements
- effect: Glow, flare, light effects
- unknown: Cannot determine
*/

function classifyLayer(layer) {
    const result = {
        category: "unknown",
        confidence: 50,
        rule: "none",
        reasons: []
    };

    // Gather all evidence
    const evidence = gatherEvidence(layer);

    // Apply rules in order of priority
    // RULE 1: Definitive layer types
    const rule1 = applyDefinitiveRules(layer, evidence);
    if (rule1.match) {
        return rule1.result;
    }

    // RULE 2: Explicit name patterns
    const rule2 = applyExplicitNameRules(layer, evidence);
    if (rule2.match) {
        return rule2.result;
    }

    // RULE 3: Text layer classification
    const rule3 = applyTextRules(layer, evidence);
    if (rule3.match) {
        return rule3.result;
    }

    // RULE 4: Inferred classification from evidence
    const rule4 = applyInferredRules(layer, evidence);
    if (rule4.match) {
        return rule4.result;
    }

    // RULE 5: Default classification
    return applyDefaultRules(layer, evidence);
}

function gatherEvidence(layer) {
    const name = layer.nameLower || "";
    const rawName = layer.name || "";

    // Check for intentional (non-generic) naming
    const genericPatterns = [
        /^layer\s*\d*$/i, /^group\s*\d*$/i, /^rectangle\s*\d*$/i,
        /^ellipse\s*\d*$/i, /^shape\s*\d*$/i, /^path\s*\d*$/i,
        /^polygon\s*\d*$/i, /^line\s*\d*$/i, /^star\s*\d*$/i,
        /^copy(\s*\d*)?$/i, /^.+\s+copy(\s*\d*)?$/i, /^untitled/i
    ];
    const hasIntentionalName = !genericPatterns.some(p => p.test(rawName)) && rawName.length > 2;

    // NEW: Generic SHAPE name specifically (Rectangle 1, Polygon 2, Ellipse, etc.)
    // These are basic shapes created in Photoshop, NOT logos
    const isGenericShapeName = /^(rectangle|ellipse|polygon|shape|path|line|star|rounded rectangle)\s*\d*(\s+copy\s*\d*)?$/i.test(rawName);

    // Human name pattern detection
    const looksLikeHumanName = hasIntentionalName && (
        (/^[A-Z][a-z]+/.test(rawName) && !/\d/.test(rawName) && !/_/.test(rawName)) ||
        /^[A-Z][a-z]+(\s+[A-Z][a-z]+)+/.test(rawName) ||  // "John Smith"
        /^[A-Z]+\s*\(\d+\)/.test(rawName) ||  // "DRYAD (1)"
        /^[A-Z]{3,}$/.test(rawName)  // "ZHOBIII"
    );

    // Date pattern in name (suggests photo shoot subject)
    const hasDateInName = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*\d{0,4}/i.test(rawName);

    // NEW: Subject/Player naming patterns (from training - NRG_*, nrg_*_r, etc.)
    // Team/org prefix patterns (esports, sports, brands)
    const hasTeamPrefix = /^(nrg|100t|faze|tsm|c9|cloud9|g2|fnatic|optic|eg|liquid|sentinels|sen|t1|drx|loud|kru|lev|prx|fpx|edg|gen|dk|dwg|geng|kcorp|koi|vitality|vit|mad|misfits|rogue|sk|astralis|navi|nip|ence|furia|mibr|imperial|pain|keyd|intz|red|fluxo)_/i.test(rawName);

    // Alpha/PNG cutout pattern (suggests extracted subject image)
    const hasAlphaPngPattern = /alpha|alphapng|cutout|isolated|extracted|render|_png|_alpha/i.test(rawName);

    // CAMERA FILE NAMING PATTERN - Strong subject indicator
    // These are raw camera output names = photos = subjects
    // DSCF#### (Fujifilm), DSC_#### (Nikon), IMG_#### (Canon/iPhone),
    // _DSC#### (Nikon alt), SAM_#### (Samsung), GOPR#### (GoPro),
    // DJI_#### (DJI drones), P####### (Panasonic), DCIM####
    const hasCameraFileName = /^(DSCF|DSC_|_DSC|DSC|IMG_|IMG|SAM_|GOPR|DJI_|DCIM|P\d{6,}|_MG_|MG_)\d{3,}/i.test(rawName);

    // Player/gamertag naming pattern: PREFIX_name or name_SUFFIX with common suffixes
    const hasPlayerNamingPattern = /^[a-z0-9]{2,6}_[a-z]+/i.test(rawName) ||  // NRG_Ethan, 100T_Bang
        /_r\s*(\(\d+\))?$/i.test(rawName) ||  // nrg_atomic_r, nrg_daniel_r (1)
        /^[a-z]+_[a-z]+_[a-z]*png/i.test(rawName);  // NRG_skuba_AlphaPNGs

    // Smart object with sequential numbering pattern (subject batch)
    const hasSequentialPattern = /_\d{3,}$|_\d{3,}\)$/.test(rawName);  // _060, _037 (frame numbers)

    // RASTERIZED TEXT DETECTION: Name looks like readable text content
    // When you rasterize/convert text to smart object, name inherits the text
    // "See you soon, G2" is a phrase, not a layer name like "glow" or "Layer 1"
    //
    // Signals:
    // - Multiple words (3+) forming a phrase
    // - Contains punctuation (commas, periods, !, ?)
    // - Contains common phrase words (the, a, an, is, are, you, we, etc.)
    // - Looks like a sentence or tagline
    const words = rawName.replace(/\s*(copy\s*\d*|\(\d+\))$/i, '').trim().split(/\s+/);
    const wordCount = words.length;
    const hasPunctuation = /[,!?;:]/.test(rawName);
    const hasCommonPhraseWords = /\b(the|a|an|is|are|was|were|you|we|us|our|your|my|to|for|with|and|or|but|in|on|at|of|it|its|this|that|be|have|has|do|does|will|can|see|get|let|go|come|back|up|down|out|now|soon|here|there|new|next|more|all|just|only|first|last)\b/i.test(rawName);
    const looksLikePhrase = wordCount >= 3 && (hasPunctuation || hasCommonPhraseWords);
    const looksLikeTextContent = looksLikePhrase || (wordCount >= 2 && hasPunctuation);

    return {
        // Layer type
        isTextLayer: layer.kind === "text",
        isAdjustment: isAdjustmentType(layer.kind),
        isFill: ["solidColor", "gradientFill", "patternFill"].includes(layer.kind),
        isShape: layer.kind === "shape" || layer.kind === "vector",
        isSmartObject: layer.kind === "smartObject",
        isPixel: layer.kind === "pixel" || layer.kind === "normal",

        // Name evidence
        nameContainsLogo: /logo|watermark|marca|brand/i.test(name),
        nameContainsText: /text|txt|type|word|letter/i.test(name),
        nameContainsSubject: /subject|player|athlete|person|model|portrait|hero|cutout/i.test(name),
        nameContainsBackground: /background|bg|fondo|back/i.test(name),
        nameContainsTexture: /texture|grain|noise|grunge|dust|scratch|paper|overlay/i.test(name),
        nameContainsGraphics: /graphic|shape|line|stroke|element|decoration|border|frame/i.test(name),
        nameContainsEffect: /effect|fx|glow|flare|light|bokeh|particle|sparkle/i.test(name),
        nameContainsHeadline: /headline|title|header|heading|main/i.test(name),
        // NEW: Lighting/color layer name patterns
        nameContainsLighting: /light|lights|lighting|highlight|highlights|shadow|shadows|dark|darken|brighten|bright|glow|shine|ray|rays|beam|beams|ambient|rim|rimlight|backlight|fill.?light|key.?light|vignette|gradient|fade|falloff|atmosphere|haze|fog|mist|sun|sunlight|flare|lens/i.test(name),
        nameContainsColor: /color|colour|tint|tone|hue|saturation|vibrance|warm|cool|cold|hot|orange|blue|red|green|yellow|purple|pink|cyan|magenta|sepia|duotone|split.?tone|grade|grading|correction|adjust/i.test(name),
        nameContainsFill: /fill|solid|flat|base|wash|overlay|blend|multiply|screen|softlight|hardlight|dodge|burn/i.test(name),

        // NEW: Intentional naming evidence (from training)
        hasIntentionalName: hasIntentionalName,
        looksLikeHumanName: looksLikeHumanName,
        hasDateInName: hasDateInName,

        // RASTERIZED TEXT: Name looks like readable text/phrase content
        // "See you soon, G2" = rasterized text (graphics), not an effect layer
        looksLikeTextContent: looksLikeTextContent,

        // NEW: Subject/player naming patterns (from training)
        hasTeamPrefix: hasTeamPrefix,               // NRG_, 100T_, FaZe_, etc.
        hasAlphaPngPattern: hasAlphaPngPattern,     // AlphaPNGs, cutout, render
        hasPlayerNamingPattern: hasPlayerNamingPattern, // PREFIX_name, name_r
        hasSequentialPattern: hasSequentialPattern, // _060, _037 (batch numbers)
        hasCameraFileName: hasCameraFileName,       // DSCF####, DSC_####, IMG_#### (camera photos = subjects)

        // NEW: Generic shape name - basic shapes are NOT logos
        // "Rectangle 1", "Polygon 2", "Ellipse" = just a shape, not a logo
        isGenericShapeName: isGenericShapeName,

        // Alpha/geometry evidence - NEW METRICS
        hasAlphaData: layer.hasAlphaData === true,
        coverage: layer.coveragePercent || 0,
        boundsFilledRatio: layer.boundsFilledRatio || 1.0,  // How much of bounds is filled (vs thin line/cross)

        // Coverage flags - must consider BOTH bounds coverage AND actual fill
        // A 2px cross has high bounds coverage but low boundsFilledRatio
        isFullCoverage: (layer.coveragePercent || 0) > 90 && (layer.boundsFilledRatio || 1) > 0.7,
        isLargeCoverage: (layer.coveragePercent || 0) > 50 && (layer.boundsFilledRatio || 1) > 0.5,
        isSmallElement: (layer.coveragePercent || 0) < 15,
        isTinyElement: (layer.coveragePercent || 0) < 5,
        isThinElement: (layer.boundsFilledRatio || 1) < 0.3,  // Thin lines, crosses, strokes

        // NEW: Better alpha metrics (relative to VISIBLE pixels)
        solidContentRatio: layer.solidContentRatio || 1.0,  // % of visible pixels that are solid (alpha > 200)
        softContentRatio: layer.softContentRatio || 0,      // % of visible pixels that are soft (alpha 20-150)
        opaqueRatio: layer.opaquePixelRatio || 1.0,         // % of visible pixels fully opaque (alpha > 250)

        // Element type flags based on alpha distribution
        isSolidElement: layer.isSolidElement !== false,     // Mostly solid content (logo, graphic, subject)
        isSoftElement: layer.isSoftElement === true,        // Mostly soft content (glow, effect)
        hasGradientAlpha: layer.hasGradientAlpha === true,  // Wide alpha transitions (soft brush)

        // Derived flags for backwards compatibility
        isSparse: (layer.solidContentRatio || 1.0) < 0.5,   // Less than half is solid
        isVerySparse: (layer.solidContentRatio || 1.0) < 0.25,
        isHighFill: (layer.solidContentRatio || 1.0) > 0.85,

        // Color evidence
        hasColorData: layer.hasColorData === true,
        isSingleColor: layer.isSingleColor === true,
        isLowColorVariance: layer.isLowColorVariance === true,
        colorVariance: layer.colorVariance || 0,
        dominantColorCount: layer.dominantColorCount || 0,

        // Position evidence
        isTopOfStack: layer.stackPosition < 0.15,
        isBottomOfStack: layer.stackPosition > 0.85,

        // Edge/border detection - elements that span full height or width
        // A vertical stripe (T0 to B100) is NOT a corner element, it's a border
        spansFullHeight: layer.normTop < 0.1 && layer.normBottom > 0.9,
        spansFullWidth: layer.normLeft < 0.1 && layer.normRight > 0.9,
        isVerticalBorder: layer.normTop < 0.1 && layer.normBottom > 0.9 && (layer.normRight - layer.normLeft) < 0.2,
        isHorizontalBorder: layer.normLeft < 0.1 && layer.normRight > 0.9 && (layer.normBottom - layer.normTop) < 0.2,

        // Corner detection - must be in corner AND not span full dimension
        isInCorner: (layer.normLeft < 0.2 || layer.normRight > 0.8) &&
                    !(layer.normTop < 0.1 && layer.normBottom > 0.9),  // Not a vertical stripe
        isInTrueCorner: (
            (layer.normLeft < 0.2 && layer.normTop < 0.2) ||
            (layer.normRight > 0.8 && layer.normTop < 0.2) ||
            (layer.normLeft < 0.2 && layer.normBottom > 0.8) ||
            (layer.normRight > 0.8 && layer.normBottom > 0.8)
        ) && !(layer.normTop < 0.1 && layer.normBottom > 0.9)   // Not a vertical stripe
          && !(layer.normLeft < 0.1 && layer.normRight > 0.9),  // Not a horizontal stripe
        isCentered: layer.normCenterX > 0.3 && layer.normCenterX < 0.7 &&
                    layer.normCenterY > 0.3 && layer.normCenterY < 0.7,
        isPartialCoverage: (layer.coveragePercent || 0) > 5 && (layer.coveragePercent || 0) < 70,

        // Blend mode evidence
        hasOverlayBlend: ["overlay", "softLight", "hardLight"].includes(layer.blendMode),
        hasMultiplyBlend: ["multiply", "darken", "colorBurn"].includes(layer.blendMode),
        hasScreenBlend: ["screen", "lighten", "colorDodge"].includes(layer.blendMode),
        hasNonNormalBlend: layer.blendMode && layer.blendMode !== "normal" && layer.blendMode !== "passThrough",

        // Opacity evidence
        hasLowOpacity: (layer.opacity || 100) < 50,
        hasVeryLowOpacity: (layer.opacity || 100) < 25,

        // Clipping evidence
        isClipped: layer.isClipped === true,
        clippingBase: layer.clippingChainBase || null,
        hasClippedContent: layer.hasClippedContent === true,  // Other layers clipped TO this one
        hasClippedAdjustment: layer.hasClippedAdjustment === true,  // Has adjustment clipped to it
        clippedLayerCount: layer.clippedLayerCount || 0,

        // Mask evidence
        hasMask: layer.hasMask === true,
        maskDensity: layer.maskDensity || 1.0,  // 1.0 = fully visible, 0.1 = 10% visible
        effectiveCoverage: layer.effectiveCoverage || layer.coveragePercent || 0,
        hasMaskRestriction: layer.hasMaskRestriction === true  // Mask reveals <50%
    };
}

function isAdjustmentType(kind) {
    const adjustmentTypes = [
        "brightnessContrast", "levels", "curves", "exposure",
        "vibrance", "hueSaturation", "colorBalance", "blackAndWhite",
        "photoFilter", "channelMixer", "colorLookup", "invert",
        "posterize", "threshold", "gradientMap", "selectiveColor"
    ];
    return adjustmentTypes.includes(kind);
}

// RULE 1: Definitive layer types (cannot be overridden)
// TIER 1 signals from HIVE-MIND: These end the conversation for that layer
function applyDefinitiveRules(layer, e) {
    // Adjustment layers ARE adjustments (95 weight)
    if (e.isAdjustment) {
        return {
            match: true,
            result: {
                category: "adjustment",
                confidence: 95,
                rule: "DEFINITIVE_ADJUSTMENT",
                reasons: [`adjustment layer (${layer.kind})`]
            }
        };
    }

    // Fill layers ARE fills (solid color, gradient, pattern layers) (90 weight)
    // Even if named "background", they're technically fill layers
    if (e.isFill) {
        return {
            match: true,
            result: {
                category: "fill",
                confidence: 90,
                rule: "DEFINITIVE_FILL",
                reasons: [`fill layer (${layer.kind})`]
            }
        };
    }

    // TEXT LAYERS ARE TEXT (90 weight) - TIER 1 DEFINITIVE
    // A text layer is ALWAYS text, regardless of clipping, position, or anything else
    // This is the purest form of classification - the layer type itself speaks
    if (e.isTextLayer) {
        return {
            match: true,
            result: {
                category: "text",
                confidence: 90,
                rule: "DEFINITIVE_TEXT",
                reasons: ["text layer (kind=text)"]
            }
        };
    }

    return { match: false };
}

// RULE 2: Explicit name patterns
function applyExplicitNameRules(layer, e) {
    const name = layer.nameLower || "";

    // Explicit "logo" or "watermark" in name
    if (e.nameContainsLogo && !e.nameContainsText) {
        return {
            match: true,
            result: {
                category: "logo",
                confidence: 85,
                rule: "EXPLICIT_LOGO_NAME",
                reasons: ["name contains logo/watermark"]
            }
        };
    }

    // Explicit "background" in name
    if (e.nameContainsBackground) {
        return {
            match: true,
            result: {
                category: "background",
                confidence: 85,
                rule: "EXPLICIT_BACKGROUND_NAME",
                reasons: ["name contains background"]
            }
        };
    }

    // Explicit "subject/player/athlete" in name
    if (e.nameContainsSubject) {
        return {
            match: true,
            result: {
                category: "subject",
                confidence: 85,
                rule: "EXPLICIT_SUBJECT_NAME",
                reasons: ["name contains subject indicator"]
            }
        };
    }

    // Explicit "texture/grain/noise" in name (but NOT if sparse - then it's graphics)
    if (e.nameContainsTexture && !e.isSparse) {
        return {
            match: true,
            result: {
                category: "texture",
                confidence: 80,
                rule: "EXPLICIT_TEXTURE_NAME",
                reasons: ["name contains texture indicator"]
            }
        };
    }

    // Explicit "effect/glow/flare" in name
    if (e.nameContainsEffect) {
        return {
            match: true,
            result: {
                category: "effect",
                confidence: 75,
                rule: "EXPLICIT_EFFECT_NAME",
                reasons: ["name contains effect indicator"]
            }
        };
    }

    return { match: false };
}

// RULE 3: Text layer classification
function applyTextRules(layer, e) {
    if (!e.isTextLayer) {
        return { match: false };
    }

    // Text layer with "logo" in name = logo
    if (e.nameContainsLogo) {
        return {
            match: true,
            result: {
                category: "logo",
                confidence: 85,
                rule: "TEXT_NAMED_LOGO",
                reasons: ["text layer named as logo"]
            }
        };
    }

    // Text layer with "headline/title" in name or large size
    if (e.nameContainsHeadline) {
        return {
            match: true,
            result: {
                category: "headline",
                confidence: 80,
                rule: "TEXT_HEADLINE_NAME",
                reasons: ["text named as headline"]
            }
        };
    }

    // Small text in corner = possibly caption
    if (e.isTinyElement && (e.isBottomOfStack || layer.normBottom > 0.85)) {
        return {
            match: true,
            result: {
                category: "caption",
                confidence: 70,
                rule: "TEXT_SMALL_BOTTOM",
                reasons: ["small text at bottom"]
            }
        };
    }

    // Default: text layer = text
    return {
        match: true,
        result: {
            category: "text",
            confidence: 85,
            rule: "TEXT_DEFAULT",
            reasons: ["text layer"]
        }
    };
}

// RULE 4: Inferred classification - NOW WITH FULL CONTEXT
// This is where the "AI magic" happens - we look at EVERYTHING
function applyInferredRules(layer, e) {
    const scores = {
        logo: 0,
        subject: 0,
        background: 0,
        texture: 0,
        graphics: 0,
        effect: 0,
        fill: 0  // NEW: fill scoring for gradient alpha + single color layers
    };
    const reasons = {
        logo: [],
        subject: [],
        background: [],
        texture: [],
        graphics: [],
        effect: [],
        fill: []  // NEW
    };

    // =====================================================
    // BACKGROUND vs TEXTURE - The Critical Distinction
    // Background: solid base, normal blend, high opacity, BOTTOM, FULL ALPHA, NOT CLIPPED
    // Texture: overlay on top, blend mode OR low opacity
    // =====================================================

    const hasTextureBlend = e.hasOverlayBlend || e.hasMultiplyBlend || e.hasScreenBlend;
    const hasNormalBlend = !hasTextureBlend && layer.blendMode === "normal";
    const hasFullOpacity = (layer.opacity || 100) >= 95;
    const hasReducedOpacity = (layer.opacity || 100) < 90;

    // NEW RULE: Clipped layers are NEVER background - they're fill
    // A clipping mask is an overlay/modifier, not a base layer
    if (e.isClipped) {
        scores.background -= 100; // Strong anti-background
        scores.fill += 40;
        reasons.fill.push("clipped layer (overlay/modifier)");
    }

    // NEW RULE: Background must have FULL ALPHA (not just coverage)
    // A frame with a hole is graphics, not background
    // opaqueRatio < 0.9 means there's significant transparency = not a solid background
    const hasFullAlpha = e.opaqueRatio >= 0.85; // 85%+ opaque pixels

    // BACKGROUND: Must have ALL of these
    // - Full coverage (bounds fill document)
    // - Full alpha (no holes/transparency - not a frame)
    // - Normal blend mode
    // - High opacity (95%+)
    // - NOT sparse
    // - NOT clipped
    if (e.isFullCoverage && hasFullAlpha && hasNormalBlend && hasFullOpacity && !e.isSparse && !e.isClipped) {
        // Strong background signal
        scores.background += 50;
        reasons.background.push("full coverage + full alpha + normal blend");

        // Boost if at bottom
        if (e.isBottomOfStack) {
            scores.background += 30;
            reasons.background.push("bottom of layer stack");
        }
    }

    // NEW: Frame detection - full coverage but NOT full alpha = graphics (frame with hole)
    if (e.isFullCoverage && !hasFullAlpha && !e.isClipped) {
        scores.graphics += 45;
        reasons.graphics.push("frame shape (coverage without full alpha)");
        scores.background -= 30;
    }

    // SOFT SIGNAL: Layer with adjustments clipped to it might be effect, not background
    // "Layer 7 copy 2" with Hue/Saturation clipped = being styled = effect layer
    if (e.hasClippedAdjustment) {
        scores.effect += 25;
        reasons.effect.push("has adjustment clipped");
        // Soft penalty on background - this layer is being treated specially
        scores.background -= 15;
    }

    // MASK RESTRICTION: Layer with mask that reveals only a small area
    // Full solid layer + mask revealing 20% = effectively a small effect element
    if (e.hasMaskRestriction) {
        const maskPct = Math.round(e.maskDensity * 100);
        scores.effect += 40;
        reasons.effect.push(`mask reveals only ${maskPct}%`);
        // Strong penalty on background - can't be background if most is masked
        scores.background -= 50;
        // Small effective area often = effect or graphics
        if (e.effectiveCoverage < 30) {
            scores.effect += 20;
            reasons.effect.push("small effective area");
        }
    }

    // HIVE-MIND COUNTER-SIGNAL: Player photo cutouts with masks
    // A smart object with multi-color content + restrictive mask + high bounds fill = likely player cutout
    // NOT an effect - players are cut out with masks showing only parts of the image
    if (e.hasMaskRestriction && e.isSmartObject) {
        const isMultiColor = e.colorVariance > 0.15 && !e.isSingleColor;
        const hasSubstantialContent = e.boundsFillPercent > 40;
        const notInCorner = !e.isInCorner;
        const notTinyElement = e.coveragePercent > 5 || e.boundsFillPercent > 30;

        if (isMultiColor && hasSubstantialContent) {
            // This looks like a masked photo cutout, not an effect
            scores.subject += 55;
            reasons.subject.push("masked photo cutout (multi-color smart object)");
            // Reduce the effect score we just added
            scores.effect -= 45;

            if (notInCorner && notTinyElement) {
                scores.subject += 25;
                reasons.subject.push("positioned like subject (not corner)");
            }
        }
    }

    // HIVE-MIND: Pixel layers with masks + photo-like content = also likely cutouts
    if (e.hasMaskRestriction && layer.kind === "pixel") {
        const isMultiColor = e.colorVariance > 0.15 && !e.isSingleColor;
        const hasSubstantialContent = e.boundsFillPercent > 40;

        if (isMultiColor && hasSubstantialContent) {
            scores.subject += 40;
            reasons.subject.push("masked pixel cutout (multi-color)");
            scores.effect -= 30;
        }
    }

    // TEXTURE: Any of these patterns
    // Pattern 1: Full coverage + blend mode (overlay/multiply/screen)
    if (e.isFullCoverage && hasTextureBlend) {
        scores.texture += 60;
        reasons.texture.push(`full coverage + ${layer.blendMode} blend`);
    }

    // Pattern 2: Full coverage + reduced opacity
    if (e.isFullCoverage && hasReducedOpacity) {
        scores.texture += 55;
        reasons.texture.push(`full coverage + ${layer.opacity}% opacity`);
    }

    // Pattern 3: High fill + blend mode (even without full coverage)
    if (e.isHighFill && hasTextureBlend && !e.isSparse) {
        scores.texture += 45;
        reasons.texture.push(`high fill + ${layer.blendMode} blend`);
    }

    // Pattern 4: NOT at bottom + full coverage + any non-normal state
    if (!e.isBottomOfStack && e.isFullCoverage && (hasTextureBlend || hasReducedOpacity)) {
        scores.texture += 25;
        reasons.texture.push("overlay layer (not bottom)");
    }

    // ANTI-BACKGROUND: If it has texture signals, reduce background score
    if (hasTextureBlend || hasReducedOpacity) {
        scores.background -= 40;
        // Don't add negative reason, just reduce
    }

    // =====================================================
    // LOGO SCORING
    // =====================================================
    if (e.isSmallElement && e.isInCorner && !e.isSparse) {
        scores.logo += 35;
        reasons.logo.push("small corner element");
    }
    if (e.isSmartObject && e.isSmallElement && e.isInCorner) {
        scores.logo += 25;
        reasons.logo.push("smart object in corner");
    }
    // NEW: True corner detection (all 4 corners)
    if (e.isInTrueCorner && !e.isTextLayer) {
        scores.logo += 20;
        reasons.logo.push("corner position (non-text)");
    }
    // NEW: Intentional name in corner
    if (e.isInTrueCorner && e.hasIntentionalName && e.isSmallElement) {
        scores.logo += 15;
        reasons.logo.push("named corner element");
    }

    // ANTI-LOGO: Player/subject naming patterns should NOT be logos
    if (e.hasTeamPrefix || e.hasPlayerNamingPattern || e.hasAlphaPngPattern) {
        scores.logo -= 40;
        // Team prefix + large = definitely not a logo
        if ((e.hasTeamPrefix || e.hasPlayerNamingPattern) && e.isLargeCoverage) {
            scores.logo -= 30;
        }
    }

    // ANTI-LOGO: Generic shape names are just shapes, NOT logos
    // "Rectangle 1", "Polygon 2", "Ellipse" = basic graphic element
    // Logos have intentional names or are imported smart objects
    if (e.isGenericShapeName) {
        scores.logo -= 50;
        scores.graphics += 40;
        reasons.graphics.push("generic shape name");
    }

    // ANTI-LOGO: Shape layer + no intentional name = probably just a shape
    if (e.isShape && !e.hasIntentionalName) {
        scores.logo -= 25;
        scores.graphics += 20;
    }

    // ANTI-LOGO: Human name patterns are subjects not logos
    if (e.looksLikeHumanName || e.hasDateInName) {
        scores.logo -= 25;
    }

    // ANTI-LOGO: Vertical/horizontal borders are NOT logos
    // A full-height stripe on the side is a decorative border, not a logo
    if (e.isVerticalBorder) {
        scores.logo -= 60;
        scores.graphics += 50;
        reasons.graphics.push("vertical border/stripe");
    }
    if (e.isHorizontalBorder) {
        scores.logo -= 60;
        scores.graphics += 50;
        reasons.graphics.push("horizontal border/stripe");
    }

    // =====================================================
    // SUBJECT SCORING
    // =====================================================
    if (e.isLargeCoverage && e.isCentered && !e.isFullCoverage) {
        scores.subject += 40;
        reasons.subject.push("large centered element");
    }
    if (e.isSmartObject && e.isLargeCoverage && e.isCentered) {
        scores.subject += 30;
        reasons.subject.push("centered smart object");
    }
    if (e.hasAlphaData && !e.isSparse && !e.isHighFill && e.isCentered) {
        scores.subject += 25;
        reasons.subject.push("distinct centered shape");
    }
    // NEW: Human name pattern suggests subject (DRYAD, athxna, SIERRA DAWN)
    if (e.looksLikeHumanName) {
        scores.subject += 30;
        reasons.subject.push("name looks like person");
    }
    // NEW: Date in name suggests photo subject
    if (e.hasDateInName) {
        scores.subject += 25;
        reasons.subject.push("date pattern (photo/subject)");
    }
    // NEW: Smart object + intentional name = likely subject
    if (e.isSmartObject && e.hasIntentionalName && !e.isInTrueCorner) {
        scores.subject += 20;
        reasons.subject.push("named smart object");
    }
    // NEW: Clipped to something (will be boosted in contextual pass if clipped to shape)
    if (e.isClipped && (e.isSmartObject || e.isPixel)) {
        scores.subject += 15;
        reasons.subject.push("clipped image layer");
    }
    // NEW: Shape with partial coverage could be subject frame
    if (e.isShape && e.isPartialCoverage && !e.isSmallElement) {
        scores.subject += 10;
        reasons.subject.push("partial coverage shape (possible frame)");
        // Reduce graphics for shape frames
        scores.graphics -= 20;
    }

    // =====================================================
    // SUBJECT SCORING - Player/Team Naming Patterns (from training)
    // =====================================================
    // Team prefix (NRG_, 100T_, FaZe_, etc.) - STRONG subject signal
    if (e.hasTeamPrefix) {
        scores.subject += 55;
        reasons.subject.push("team/org prefix (player)");
        // Reduce logo score - team prefix doesn't mean logo
        scores.logo -= 30;
    }
    // Alpha/PNG/cutout pattern - indicates extracted subject
    if (e.hasAlphaPngPattern) {
        scores.subject += 50;
        reasons.subject.push("alpha/cutout naming (extracted subject)");
        scores.graphics -= 25;
    }
    // Player naming pattern (PREFIX_name, name_r)
    if (e.hasPlayerNamingPattern) {
        scores.subject += 45;
        reasons.subject.push("player naming pattern");
        scores.logo -= 20;
    }
    // Sequential batch numbering (_060, _037) with smart object = subject batch
    if (e.hasSequentialPattern && e.isSmartObject) {
        scores.subject += 35;
        reasons.subject.push("batch numbered smart object");
    }
    // Combo: team prefix + smart object = almost certainly player subject
    if (e.hasTeamPrefix && e.isSmartObject) {
        scores.subject += 25;
        reasons.subject.push("team prefix smart object");
    }
    // Combo: alpha pattern + smart object
    if (e.hasAlphaPngPattern && e.isSmartObject) {
        scores.subject += 20;
        reasons.subject.push("cutout smart object");
    }

    // CAMERA FILE NAME: DSCF####, DSC_####, IMG_#### = photo = subject
    // This is a STRONG signal - camera file names are almost always subject photos
    if (e.hasCameraFileName) {
        scores.subject += 65;
        reasons.subject.push("camera file name (photo)");
        // Strong penalty on effect - photos aren't effects
        scores.effect -= 50;
        // Penalty on graphics too
        scores.graphics -= 30;
    }

    // =====================================================
    // GRAPHICS SCORING
    // =====================================================
    if (e.isShape) {
        scores.graphics += 55;
        reasons.graphics.push("shape layer");
    }

    // SOLID ELEMENTS: graphics based on solid content
    // Solid element (>60% solid pixels) + normal blend = graphics
    // Solid element + blend mode = could be texture overlay
    if (e.isSolidElement && e.hasAlphaData && !e.isSoftElement) {
        if (e.hasNonNormalBlend && e.isLargeCoverage) {
            // Solid with blend mode + large coverage = texture
            scores.texture += 45;
            reasons.texture.push("solid overlay with blend");
        } else if (!e.hasNonNormalBlend) {
            // Solid with normal blend = graphics
            scores.graphics += 40;
            reasons.graphics.push(`solid element (${Math.round(e.solidContentRatio * 100)}% solid)`);
        }
    }

    // Very sparse solid content = decorative graphic
    if (e.isVerySparse && e.isSolidElement && !e.hasNonNormalBlend && !e.isSoftElement) {
        scores.graphics += 30;
        reasons.graphics.push("sparse solid element");
    }
    if (e.isSmallElement && !e.isInCorner && !e.isTinyElement) {
        scores.graphics += 20;
        reasons.graphics.push("small element");
    }

    // THIN ELEMENTS (lines, crosses, strokes) = graphics, NOT texture
    // These have large bounds but low boundsFilledRatio
    if (e.isThinElement) {
        scores.graphics += 50;
        reasons.graphics.push(`thin element (${Math.round(e.boundsFilledRatio * 100)}% fill)`);
        // Strongly penalize texture for thin elements
        scores.texture -= 40;
    }

    // RASTERIZED TEXT: Name looks like readable text content = graphics
    // "See you soon, G2" is text converted to smart object with effects
    // Even with soft edges/blur, it's a stylized text graphic, not an effect layer
    if (e.looksLikeTextContent) {
        scores.graphics += 45;
        reasons.graphics.push("name looks like text content");
        // Penalize effect - this isn't a glow layer, it's stylized text
        scores.effect -= 35;
    }

    // =====================================================
    // FILL SCORING - CONSERVATIVE (only definitive patterns)
    // =====================================================
    // Fill should ONLY match layers with clear fill characteristics
    // NOT logos, NOT graphics, NOT subjects

    // Clipped single-color layer with blend mode = likely color overlay/fill
    if (e.isClipped && e.isSingleColor && e.hasNonNormalBlend && e.isFullCoverage) {
        scores.fill = (scores.fill || 0) + 45;
        reasons.fill = reasons.fill || [];
        reasons.fill.push("clipped full-coverage color overlay");
    }
    // Full coverage single color with non-normal blend = fill/overlay
    if (e.isFullCoverage && e.isSingleColor && e.hasNonNormalBlend && !e.isClipped) {
        scores.fill = (scores.fill || 0) + 40;
        reasons.fill = reasons.fill || [];
        reasons.fill.push("full coverage color blend");
    }

    // =====================================================
    // TEXTURE vs EFFECT SCORING - Based on alpha distribution
    // =====================================================
    //
    // KEY DISTINCTION:
    // - SOLID ELEMENT (isSolidElement): mostly opaque pixels → graphics, logos, subjects
    // - SOFT ELEMENT (isSoftElement): mostly semi-transparent → effects, glows
    // - Coverage determines texture vs effect: large = texture, small = effect
    //
    const hasGenericName = !e.hasIntentionalName;

    // SOFT ELEMENTS: mostly semi-transparent pixels (soft brush, glow, light)
    if (e.isSoftElement) {
        if (e.isLargeCoverage) {
            // Large soft element = texture overlay (color wash, lighting overlay)
            scores.texture += 55;
            reasons.texture.push("soft overlay (large coverage)");
            scores.graphics -= 40;
        } else {
            // Small/medium soft element = effect (glow, light beam)
            scores.effect += 55;
            reasons.effect.push("soft element (glow/light)");
            scores.graphics -= 30;
        }
    }

    // SOLID ELEMENTS with blend modes = texture
    if (e.isSolidElement && e.hasNonNormalBlend && e.isLargeCoverage) {
        scores.texture += 40;
        reasons.texture.push("solid overlay with blend mode");
    }

    // Gradient alpha + large coverage = texture
    if (e.hasGradientAlpha && e.isLargeCoverage) {
        scores.texture += 35;
        reasons.texture.push("gradient alpha + large coverage");
    }

    // Gradient alpha + small coverage = effect
    if (e.hasGradientAlpha && !e.isLargeCoverage) {
        scores.effect += 35;
        reasons.effect.push("localized gradient element");
    }

    // Generic name + soft element = texture/effect (lighting layers)
    if (hasGenericName && e.isSoftElement) {
        if (e.isLargeCoverage) {
            scores.texture += 25;
            reasons.texture.push("generic soft overlay");
        } else {
            scores.effect += 25;
            reasons.effect.push("generic soft element");
        }
    }

    // Low color variance + blend mode = texture
    if (e.isLowColorVariance && e.hasNonNormalBlend && e.isFullCoverage) {
        scores.texture += 35;
        reasons.texture.push("low variance + blend + full coverage");
    }

    // Name-based signals
    if (e.nameContainsLighting) {
        scores.texture += 40;
        reasons.texture.push("name suggests lighting");
    }
    if (e.nameContainsColor && e.hasNonNormalBlend) {
        scores.texture += 30;
        reasons.texture.push("color layer with blend");
    }
    if (e.nameContainsFill) {
        scores.fill += 35;
        reasons.fill.push("fill/overlay layer name");
        scores.texture += 20;
        reasons.texture.push("overlay layer name");
    }

    // =====================================================
    // EFFECT SCORING - Screen/lighten blend effects
    // =====================================================
    if (e.hasScreenBlend && e.isTopOfStack && e.hasLowOpacity) {
        scores.effect += 40;
        reasons.effect.push("screen blend overlay");
    }
    if (e.hasScreenBlend && e.hasVeryLowOpacity) {
        scores.effect += 35;
        reasons.effect.push("faint screen layer");
    }
    if (e.hasScreenBlend && e.isSoftElement) {
        scores.effect += 35;
        reasons.effect.push("screen blend + soft content");
    }
    if (e.hasGradientAlpha && !e.isFullCoverage && !e.isLargeCoverage) {
        scores.effect += 30;
        reasons.effect.push("gradient light element");
    }

    // SOFT EDGES EFFECT PATTERN: gradient alpha + low opaque ratio = glow/effect
    // Even if not technically "isSoftElement", faded edges + mostly semi-transparent = glow
    // "Layer 1 copy" pattern: bleeds canvas, faded edges, <50% opaque = effect
    if (e.hasGradientAlpha && e.opaqueRatio < 0.5 && e.softContentRatio > 0.25) {
        scores.effect += 45;
        reasons.effect.push("faded edges + low opacity (glow)");
    }

    // Bleeds beyond canvas + gradient alpha = likely glow/effect bleed
    if (e.coverage > 100 && e.hasGradientAlpha && e.opaqueRatio < 0.6) {
        scores.effect += 35;
        reasons.effect.push("bleeds canvas with soft edges");
    }

    // Name suggests effect/glow/light
    if (e.nameContainsEffect) {
        scores.effect += 45;
        reasons.effect.push("name suggests effect");
    }

    // Combo: generic name + soft element + NOT large = effect
    if (!e.hasIntentionalName && e.isSoftElement && !e.isLargeCoverage) {
        scores.effect += 25;
        reasons.effect.push("generic soft element");
    }

    // Find winner (must be positive score)
    let maxScore = 0;
    let winner = null;
    for (const [category, score] of Object.entries(scores)) {
        if (score > maxScore) {
            maxScore = score;
            winner = category;
        }
    }

    if (winner && maxScore >= 20) {
        const sortedScores = Object.values(scores).sort((a, b) => b - a);
        const margin = sortedScores[0] - (sortedScores[1] || 0);
        let confidence = Math.min(85, 45 + Math.round(maxScore / 2) + Math.round(margin / 4));

        return {
            match: true,
            result: {
                category: winner,
                confidence: confidence,
                rule: "INFERRED_" + winner.toUpperCase(),
                reasons: reasons[winner]
            }
        };
    }

    return { match: false };
}

// RULE 5: Default classification
function applyDefaultRules(layer, e) {
    // Smart objects default to graphics
    if (e.isSmartObject) {
        return {
            category: "graphics",
            confidence: 40,
            rule: "DEFAULT_SMART_OBJECT",
            reasons: ["smart object (unclassified)"]
        };
    }

    // Pixel layers default to graphics
    if (e.isPixel) {
        return {
            category: "graphics",
            confidence: 35,
            rule: "DEFAULT_PIXEL",
            reasons: ["pixel layer (unclassified)"]
        };
    }

    // Shape layers default to graphics
    if (e.isShape) {
        return {
            category: "graphics",
            confidence: 50,
            rule: "DEFAULT_SHAPE",
            reasons: ["shape layer"]
        };
    }

    // Unknown
    return {
        category: "unknown",
        confidence: 25,
        rule: "DEFAULT_UNKNOWN",
        reasons: ["could not classify"]
    };
}

// =====================================================
// SEQUENCE DETECTION - Find similar layers that should be grouped
// This is the "hive mind" - layers vote on each other
// =====================================================

function detectSimilarSequences(layers) {
    const sequences = [];
    const assigned = new Set();

    for (let i = 0; i < layers.length; i++) {
        if (assigned.has(i)) continue;

        const layer = layers[i];

        // Skip text layers - they should never be grouped in sequences
        if (layer.kind === "text") continue;

        const members = [layer];
        const memberIndices = [i];

        // Check for similarity patterns
        const isGenericName = /^layer\s*\d+$/i.test(layer.name);
        const hasBlendMode = layer.blendMode && layer.blendMode !== "normal";
        const isSparse = (layer.solidContentRatio || 1) < 0.5;
        const isSoftElement = layer.isSoftElement === true;
        const hasGradientAlpha = layer.hasGradientAlpha === true;
        const coverage = layer.coveragePercent || 0;

        // Look at nearby layers (within 10 positions)
        for (let j = i + 1; j < Math.min(i + 10, layers.length); j++) {
            if (assigned.has(j)) continue;

            const other = layers[j];

            // Skip text layers
            if (other.kind === "text") continue;

            let similarity = 0;
            let reasons = [];

            // Check various similarity signals
            const otherGenericName = /^layer\s*\d+$/i.test(other.name);
            const otherHasBlendMode = other.blendMode && other.blendMode !== "normal";
            const otherSparse = (other.solidContentRatio || 1) < 0.5;
            const otherSoftElement = other.isSoftElement === true;
            const otherHasGradientAlpha = other.hasGradientAlpha === true;
            const otherCoverage = other.coveragePercent || 0;

            // Generic names match
            if (isGenericName && otherGenericName) {
                similarity += 3;
                reasons.push("generic names");
            }

            // Both have blend modes
            if (hasBlendMode && otherHasBlendMode) {
                similarity += 2;
                reasons.push("blend modes");
            }

            // Same blend mode
            if (layer.blendMode === other.blendMode && hasBlendMode) {
                similarity += 2;
                reasons.push("same blend");
            }

            // Both sparse
            if (isSparse && otherSparse) {
                similarity += 2;
                reasons.push("sparse");
            }

            // Similar coverage (within 20% - tighter)
            if (coverage > 0 && otherCoverage > 0 && Math.abs(coverage - otherCoverage) < 20) {
                similarity += 1;
                reasons.push("similar coverage");
            }

            // Both soft elements (glows, light layers, pure gradients)
            // Only count if BOTH are - this is specific
            if (isSoftElement && otherSoftElement) {
                similarity += 2;
                reasons.push("both soft elements");
            }

            // If similarity score >= 4, they're part of the sequence (raised threshold)
            // ALSO require that BOTH have generic names - sequences are for "Layer X" patterns
            if (similarity >= 4 && isGenericName && otherGenericName) {
                members.push(other);
                memberIndices.push(j);
            }
        }

        // If we found a sequence of 3+, record it
        if (members.length >= 3) {
            memberIndices.forEach(idx => assigned.add(idx));
            sequences.push({
                members: members,
                reason: `${members.length} similar layers`
            });
        }
    }

    return sequences;
}

// =====================================================
// HOLISTIC CONTEXT ANALYSIS
// Look at ALL layers together and find patterns
// This is the "AI magic" - connected thinking
// =====================================================

function applyHolisticContext(layers) {
    // Get non-group layers sorted by stack position (bottom to top)
    const realLayers = layers
        .filter(l => !l.isGroup)
        .sort((a, b) => b.index - a.index); // Higher index = lower in stack

    if (realLayers.length === 0) return;

    console.log(`  Analyzing ${realLayers.length} layers holistically...`);

    // =====================================================
    // STEP 0: GUARDRAILS - Enforce type constraints
    // Some layer types can NEVER be certain categories
    // =====================================================

    // Adjustment layer kinds - these can NEVER be background/texture/subject/graphics
    // Using both UXP kind values and batchPlay descriptor values for safety
    const ADJUSTMENT_KINDS = [
        "brightnessContrast", "levels", "curves", "exposure", "vibrance",
        "hueSaturation", "colorBalance", "blackAndWhite", "photoFilter",
        "channelMixer", "colorLookup", "invert", "posterize", "threshold",
        "selectiveColor", "gradientMap"
    ];

    // Fill layer kinds - these can NEVER be background (they're fills, not backgrounds)
    // UXP uses: solidColor, gradientFill, patternFill
    const FILL_KINDS = ["solidColor", "gradientFill", "patternFill",
                        "solidColorLayer", "gradientLayer", "patternLayer"];

    for (const layer of realLayers) {
        const kind = layer.kind || "";
        const isAdjustment = ADJUSTMENT_KINDS.includes(kind) || layer.isAdjustmentLayer;
        const isFill = FILL_KINDS.includes(kind);

        // GUARDRAIL: Adjustment layers are ALWAYS adjustments
        if (isAdjustment && !isFill) {
            if (layer.finalGroup !== "adjustment") {
                console.log(`    GUARDRAIL: "${layer.name}" (${kind}) forced to adjustment (was ${layer.finalGroup})`);
                layer.finalGroup = "adjustment";
                layer.confidence = 95;
                layer.reason = `adjustment layer (${kind})`;
            }
        }

        // GUARDRAIL: Fill layers are ALWAYS fills (not backgrounds)
        if (isFill) {
            if (layer.finalGroup === "background") {
                console.log(`    GUARDRAIL: "${layer.name}" (${kind}) is fill, not background`);
                layer.finalGroup = "fill";
                layer.confidence = 90;
                layer.reason = `fill layer (${kind})`;
            }
        }

        // GUARDRAIL: Text layers are ALWAYS text-related
        // Check layer.kind directly since isTextLayer may not be set
        if (layer.kind === "text") {
            if (!["text", "headline", "caption"].includes(layer.finalGroup)) {
                console.log(`    GUARDRAIL: "${layer.name}" forced to text (was ${layer.finalGroup})`);
                layer.finalGroup = "text";
                layer.confidence = 90;
                layer.reason = "text layer";
            }
        }

        // GUARDRAIL: Clipped layers are NEVER background - they're fill
        // A clipping mask is an overlay/modifier, not a base layer
        if (layer.isClipped === true && layer.finalGroup === "background") {
            console.log(`    GUARDRAIL: "${layer.name}" clipped layer forced to fill (was background)`);
            layer.finalGroup = "fill";
            layer.confidence = 80;
            layer.reason = "clipped layer (not background)";
        }

        // GUARDRAIL: Frames/thin elements are graphics, not background
        // Check BOTH: low alpha ratio OR low bounds fill (catches thin crosses/lines)
        const opaqueRatio = layer.opaquePixelRatio || 1;
        const boundsFilledRatio = layer.boundsFilledRatio || 1;
        const coverage = layer.coveragePercent || 0;
        const isFrame = opaqueRatio < 0.85;  // Has transparency holes
        const isThinElement = boundsFilledRatio < 0.80;  // Doesn't fill its bounds (thin line/cross)

        if (layer.finalGroup === "background" && coverage > 80 && (isFrame || isThinElement)) {
            const reason = isThinElement ?
                `thin element (${Math.round(boundsFilledRatio*100)}% fill)` :
                `frame (${Math.round(opaqueRatio*100)}% alpha)`;
            console.log(`    GUARDRAIL: "${layer.name}" is ${reason}, not background`);
            layer.finalGroup = "graphics";
            layer.confidence = 75;
            layer.reason = reason;
        }
    }

    // =====================================================
    // STEP 0.5: SEQUENCE DETECTION - Similar layers vote together
    // If 3+ similar layers are near each other, they influence each other
    // This is the "hive mind" - context-aware classification
    // =====================================================
    const sequences = detectSimilarSequences(realLayers);
    for (const seq of sequences) {
        if (seq.members.length >= 3) {
            // Count votes for each classification
            const votes = {};
            for (const layer of seq.members) {
                const group = layer.finalGroup;
                votes[group] = (votes[group] || 0) + 1;
            }

            // Find winning classification
            let winner = null;
            let maxVotes = 0;
            for (const [group, count] of Object.entries(votes)) {
                if (count > maxVotes) {
                    maxVotes = count;
                    winner = group;
                }
            }

            // If there's a clear majority (>50%), align the sequence
            if (winner && maxVotes > seq.members.length / 2) {
                const names = seq.members.map(l => l.name).join(", ");
                console.log(`    SEQUENCE: ${seq.members.length} similar layers → ${winner} (${seq.reason})`);

                for (const layer of seq.members) {
                    // PROTECTION: Never override text, adjustment, or fill layers
                    const isProtected = layer.kind === "text" ||
                        ADJUSTMENT_KINDS.includes(layer.kind || "") ||
                        FILL_KINDS.includes(layer.kind || "");

                    if (layer.finalGroup !== winner && !isProtected) {
                        layer.finalGroup = winner;
                        layer.confidence = Math.max(layer.confidence, 70);
                        layer.reason = `sequence alignment (${seq.reason})`;
                    }
                }
            }
        }
    }

    // =====================================================
    // STEP 1: Find the TRUE background
    // The bottom-most layer that is solid, full coverage, normal blend
    // MUST be a pixel layer (not adjustment, not text, not fill)
    // =====================================================
    let trueBackground = null;
    let trueBackgroundIndex = -1;

    for (let i = realLayers.length - 1; i >= 0; i--) {
        const layer = realLayers[i];
        const kind = layer.kind || "";

        // Skip non-pixel layers - these can NEVER be background
        const isAdjustment = ADJUSTMENT_KINDS.includes(kind) || layer.isAdjustmentLayer;
        const isFill = FILL_KINDS.includes(kind);
        const isText = kind === "text";
        const isClipped = layer.isClipped === true;

        if (isAdjustment || isFill || isText) {
            continue; // These can never be true background
        }

        // NEW: Clipped layers can NEVER be background - they're fills/overlays
        if (isClipped) {
            continue;
        }

        const coverage = layer.coveragePercent || 0;
        const opacity = layer.opacity || 100;
        const blend = layer.blendMode || "normal";
        const isNormalBlend = blend === "normal" || blend === "passThrough";

        // CRITICAL: Check TWO things:
        // 1. opaqueRatio: Is the content that's there solid? (relative to visible pixels)
        // 2. boundsFilledRatio: Does it actually FILL its bounds? (catches thin lines/crosses)
        const opaqueRatio = layer.opaquePixelRatio || 1;
        const boundsFilledRatio = layer.boundsFilledRatio || 1;

        // Must have both: solid content AND fills its bounds (not a thin cross/line)
        const hasFullAlpha = opaqueRatio >= 0.85;
        const actuallFillsBounds = boundsFilledRatio >= 0.80;  // 80% of bounds must be filled

        // True background: full coverage + FULL ALPHA + FILLS BOUNDS + high opacity + normal blend + NOT clipped
        if (coverage > 85 && hasFullAlpha && actuallFillsBounds && opacity > 90 && isNormalBlend) {
            trueBackground = layer;
            trueBackgroundIndex = i;
            console.log(`    Found true background: "${layer.name}" (${kind}) at position ${i}, alpha=${Math.round(opaqueRatio*100)}%, fill=${Math.round(boundsFilledRatio*100)}%`);
            break;
        }
    }

    // =====================================================
    // STEP 2: Reclassify full-coverage layers ABOVE background
    // If above background + has blend mode or low opacity = TEXTURE
    // (Skip protected layer types - adjustments, text, fills)
    // =====================================================
    if (trueBackground) {
        // Mark the true background
        if (trueBackground.finalGroup !== "background") {
            console.log(`    Correcting "${trueBackground.name}": ${trueBackground.finalGroup} -> background`);
            trueBackground.finalGroup = "background";
            trueBackground.confidence = 85;
            trueBackground.reason = "true background (solid base)";
        }

        // Check layers ABOVE the background
        for (let i = 0; i < trueBackgroundIndex; i++) {
            const layer = realLayers[i];
            const kind = layer.kind || "";

            // Skip protected layer types - they keep their guardrail classification
            const isProtectedKind = ADJUSTMENT_KINDS.includes(kind) || FILL_KINDS.includes(kind);
            if (layer.isAdjustmentLayer || layer.isTextLayer || isProtectedKind) {
                continue;
            }

            const coverage = layer.coveragePercent || 0;
            const opacity = layer.opacity || 100;
            const blend = layer.blendMode || "normal";
            const hasTextureBlend = ["overlay", "softLight", "hardLight", "multiply", "screen",
                                     "colorDodge", "colorBurn", "linearDodge", "linearBurn",
                                     "vividLight", "linearLight", "pinLight"].includes(blend);
            const hasReducedOpacity = opacity < 90;

            // Full coverage layer above background with texture indicators
            if (coverage > 80 && (hasTextureBlend || hasReducedOpacity)) {
                if (layer.finalGroup === "background") {
                    console.log(`    Correcting "${layer.name}": background -> texture (above true bg, ${hasTextureBlend ? blend : opacity + '% opacity'})`);
                    layer.finalGroup = "texture";
                    layer.confidence = 80;
                    layer.reason = `texture overlay (${hasTextureBlend ? blend + ' blend' : opacity + '% opacity'})`;
                }
            }
        }
    }

    // =====================================================
    // STEP 3: Find texture clusters
    // Multiple adjacent layers with texture characteristics
    // =====================================================
    let textureClusterStart = -1;
    let textureClusterCount = 0;

    for (let i = 0; i < realLayers.length; i++) {
        const layer = realLayers[i];
        const isTextureCandidate =
            layer.finalGroup === "texture" ||
            (layer.coveragePercent > 70 &&
             (["overlay", "softLight", "multiply", "screen"].includes(layer.blendMode) ||
              (layer.opacity || 100) < 80));

        if (isTextureCandidate) {
            if (textureClusterStart === -1) textureClusterStart = i;
            textureClusterCount++;
        } else {
            // End of cluster - if 3+ layers, boost their texture classification
            if (textureClusterCount >= 2) {
                console.log(`    Found texture cluster: ${textureClusterCount} layers starting at ${textureClusterStart}`);
                for (let j = textureClusterStart; j < textureClusterStart + textureClusterCount; j++) {
                    const clusterLayer = realLayers[j];
                    if (clusterLayer.finalGroup !== "texture") {
                        console.log(`      Adjusting "${clusterLayer.name}": ${clusterLayer.finalGroup} -> texture (part of cluster)`);
                        clusterLayer.finalGroup = "texture";
                        clusterLayer.confidence = Math.min(clusterLayer.confidence + 15, 85);
                        clusterLayer.reason += "; texture cluster";
                    }
                }
            }
            textureClusterStart = -1;
            textureClusterCount = 0;
        }
    }

    // =====================================================
    // STEP 4: Logo validation
    // Logos should be small, in corners, distinct shapes
    // If something is classified as logo but doesn't fit, reclassify
    // =====================================================
    for (const layer of realLayers) {
        if (layer.finalGroup === "logo") {
            const coverage = layer.coveragePercent || 0;
            const inCorner = layer.normLeft < 0.25 || layer.normRight > 0.75;

            // Logo shouldn't be large
            if (coverage > 30) {
                console.log(`    Correcting "${layer.name}": logo -> graphics (too large: ${coverage}%)`);
                layer.finalGroup = "graphics";
                layer.confidence = 60;
                layer.reason = "reclassified from logo (too large)";
            }
            // Logo should be in corner or small
            else if (!inCorner && coverage > 10) {
                console.log(`    Correcting "${layer.name}": logo -> graphics (not in corner)`);
                layer.finalGroup = "graphics";
                layer.confidence = 55;
                layer.reason = "reclassified from logo (not in corner)";
            }
        }
    }

    // =====================================================
    // STEP 5: Clipping mask context (MOVED BEFORE subject demotion)
    // Shape frames with clipped subjects should both be "subject"
    // =====================================================
    console.log(`  Analyzing clipping relationships (early pass)...`);

    // Build a map of what's clipped to what
    const clippingBases = new Map(); // baseId -> [clipped layers]
    for (const layer of layers) {
        if (layer.isClipped && layer.clippingChainBase) {
            if (!clippingBases.has(layer.clippingChainBase)) {
                clippingBases.set(layer.clippingChainBase, []);
            }
            clippingBases.get(layer.clippingChainBase).push(layer);
        }
    }

    // Mark base layers that have content clipped to them
    // This is a signal that the layer might be an effect/styling layer, not just background
    for (const [baseId, clippedLayers] of clippingBases) {
        const base = layers.find(l => l.id === baseId);
        if (base) {
            base.hasClippedContent = true;
            base.clippedLayerCount = clippedLayers.length;
            // Check if any clipped layer is an adjustment
            base.hasClippedAdjustment = clippedLayers.some(l =>
                ADJUSTMENT_KINDS.includes(l.kind) || l.kind === "hueSaturation" || l.kind === "levels" || l.kind === "curves"
            );
        }
    }

    // Track which subjects are in frames (should NOT be demoted)
    const subjectsInFrames = new Set();

    // Process each clipping base
    console.log(`    Found ${clippingBases.size} clipping bases to analyze`);

    for (const [baseId, clippedLayers] of clippingBases) {
        const base = layers.find(l => l.id === baseId);
        if (!base) continue;

        console.log(`    Checking base "${base.name}" (kind: ${base.kind}, coverage: ${(base.coveragePercent || 0).toFixed(1)}%)`);
        console.log(`      Clipped layers: ${clippedLayers.map(l => l.name).join(", ")}`);

        // Check if any clipped layer is or should be a subject
        let hasSubjectClipped = false;
        let subjectCandidate = null;

        for (const clipped of clippedLayers) {
            const isSubjectType = clipped.kind === "smartObject" || clipped.kind === "pixel";
            const hasSubjectName = /subject|player|athlete|person|model|portrait/i.test(clipped.name || "");
            const looksLikeHumanName = (
                /^[A-Z][a-z]+/.test(clipped.name || "") ||
                /^[A-Z]+\s*\(\d+\)/.test(clipped.name || "") ||
                /^[A-Z]{3,}/.test(clipped.name || "")
            );
            const hasDateName = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(clipped.name || "");
            const currentlySubject = clipped.finalGroup === "subject";

            // NEW: Check if it looks like an IMAGE (high color variance) vs LOGO (single/few colors)
            // Subjects are typically photos with many colors, logos are flat/single color
            const colorVariance = clipped.colorVariance || 0;
            const isSingleColor = clipped.isSingleColor === true;
            const dominantColorCount = clipped.dominantColorCount || 0;
            const looksLikeImage = colorVariance > 0.15 || dominantColorCount > 5; // Photo-like
            const looksLikeLogo = isSingleColor || dominantColorCount <= 3; // Flat/logo-like

            console.log(`      - "${clipped.name}": kind=${clipped.kind}, isSubjectType=${isSubjectType}, looksLikeHumanName=${looksLikeHumanName}, currentlySubject=${currentlySubject}`);
            console.log(`        colorVariance=${colorVariance.toFixed(2)}, dominantColors=${dominantColorCount}, looksLikeImage=${looksLikeImage}, looksLikeLogo=${looksLikeLogo}`);

            // Only treat as subject if it LOOKS LIKE AN IMAGE (not a flat logo)
            // Skip if it's clearly a logo (single color, low variance)
            if (looksLikeLogo && !hasSubjectName && !hasDateName) {
                console.log(`      → Skipping "${clipped.name}" - looks like logo, not subject`);
                continue;
            }

            if (currentlySubject || (isSubjectType && looksLikeImage && (hasSubjectName || looksLikeHumanName || hasDateName))) {
                hasSubjectClipped = true;
                subjectCandidate = clipped;
                console.log(`      → Found subject candidate: "${clipped.name}" (looks like image)`);
                break;
            }

            // Fallback: if it has subject name/human name, still consider it even without image check
            if (isSubjectType && (hasSubjectName || hasDateName)) {
                hasSubjectClipped = true;
                subjectCandidate = clipped;
                console.log(`      → Found subject candidate: "${clipped.name}" (by name)`);
                break;
            }
        }

        // If a subject is clipped to this base, and base is a frame-like layer, both are subject
        const isNativeShape = base.kind === "shape" || base.kind === "solidColor" || base.kind === "vector";
        // Also detect rasterized shapes by name (Rectangle, Ellipse, etc.)
        const isNamedLikeShape = /^(rectangle|ellipse|polygon|shape|frame|mask|holder)/i.test(base.name || "");
        // Pixel layers with partial coverage that have subjects clipped = likely frames
        const isPixelFrame = base.kind === "pixel" && hasSubjectClipped;
        const isShapeBase = isNativeShape || isNamedLikeShape || isPixelFrame;
        const isPartialCoverage = (base.coveragePercent || 0) > 5 && (base.coveragePercent || 0) < 70;
        console.log(`      Base check: isNativeShape=${isNativeShape}, isNamedLikeShape=${isNamedLikeShape}, isPixelFrame=${isPixelFrame}, isPartialCoverage=${isPartialCoverage}, hasSubjectClipped=${hasSubjectClipped}`);

        if (hasSubjectClipped && isShapeBase && isPartialCoverage) {
            // Mark the clipped subject as "in a frame" so it won't be demoted
            subjectsInFrames.add(subjectCandidate.id);

            // The shape frame should also be subject
            if (base.finalGroup !== "subject") {
                console.log(`    CLIPPING: "${base.name}" (${base.finalGroup}) -> subject (frame for "${subjectCandidate.name}")`);
                base.finalGroup = "subject";
                base.confidence = Math.max(base.confidence, 70);
                base.reason = `subject frame (clipped: ${subjectCandidate.name})`;
            }

            // Ensure the clipped subject stays as subject
            if (subjectCandidate.finalGroup !== "subject") {
                console.log(`    CLIPPING: "${subjectCandidate.name}" (${subjectCandidate.finalGroup}) -> subject (clipped to frame)`);
                subjectCandidate.finalGroup = "subject";
                subjectCandidate.confidence = Math.max(subjectCandidate.confidence, 75);
                subjectCandidate.reason = `subject clipped to frame "${base.name}"`;
            }
        } else if (!hasSubjectClipped && isShapeBase) {
            // No subject clipped (likely logo or other element) - frame stays as graphics
            // This ensures shape frames with logos don't become subject
            if (base.finalGroup === "subject" || base.finalGroup === "logo") {
                console.log(`    CLIPPING: "${base.name}" keeping as graphics (frame for non-subject)`);
                base.finalGroup = "graphics";
                base.confidence = Math.max(base.confidence, 65);
                base.reason = "shape frame (graphic element)";
            }
        }
    }

    // =====================================================
    // STEP 5B: Subject validation (SMARTER)
    // Only demote subjects that are NOT in frames
    // If ALL subjects are in frames, keep them all
    // =====================================================
    const subjects = realLayers.filter(l => l.finalGroup === "subject");

    // Check if this looks like a multi-subject composite
    const subjectsInFramesCount = subjects.filter(s => subjectsInFrames.has(s.id)).length;
    const isMultiSubjectComposite = subjectsInFramesCount >= 2;

    if (subjects.length > 1 && !isMultiSubjectComposite) {
        console.log(`    Found ${subjects.length} potential subjects, keeping best one (not a multi-subject composite)`);

        // Score each subject
        let bestSubject = null;
        let bestScore = 0;

        for (const layer of subjects) {
            // Skip subjects that are in frames
            if (subjectsInFrames.has(layer.id)) continue;

            let score = 0;
            const coverage = layer.coveragePercent || 0;
            const centered = layer.normCenterX > 0.3 && layer.normCenterX < 0.7;

            // Score based on size, position, confidence
            if (coverage > 20 && coverage < 80) score += 30;
            if (centered) score += 25;
            score += layer.confidence * 0.5;

            if (score > bestScore) {
                bestScore = score;
                bestSubject = layer;
            }
        }

        // Demote others to graphics (but NOT those in frames)
        for (const layer of subjects) {
            if (layer !== bestSubject && !subjectsInFrames.has(layer.id)) {
                console.log(`    Demoting "${layer.name}": subject -> graphics`);
                layer.finalGroup = "graphics";
                layer.confidence = 50;
                layer.reason = "demoted from subject (not primary)";
            }
        }
    } else if (isMultiSubjectComposite) {
        console.log(`    Found ${subjects.length} subjects in frames - keeping all (multi-subject composite)`);
    }

    // =====================================================
    // STEP 6: Text alignment detection
    // Text layers that align horizontally or vertically are likely related
    // =====================================================
    const textLayers = realLayers.filter(l =>
        l.finalGroup === "text" || l.finalGroup === "headline" || l.finalGroup === "caption"
    );

    if (textLayers.length >= 2) {
        // Find horizontal alignment groups (similar Y position)
        const yGroups = new Map();
        for (const layer of textLayers) {
            const yCenter = Math.round((layer.normTop + layer.normBottom) / 2 * 10) / 10; // Round to 0.1
            if (!yGroups.has(yCenter)) yGroups.set(yCenter, []);
            yGroups.get(yCenter).push(layer);
        }

        // Mark aligned text layers
        for (const [y, group] of yGroups) {
            if (group.length >= 2) {
                console.log(`    Found ${group.length} horizontally aligned text layers at y≈${y}`);
                for (const layer of group) {
                    layer.textAlignment = "horizontal";
                    layer.textAlignGroup = y;
                }
            }
        }

        // Find vertical alignment groups (similar X position)
        const xGroups = new Map();
        for (const layer of textLayers) {
            const xCenter = Math.round((layer.normLeft + layer.normRight) / 2 * 10) / 10;
            if (!xGroups.has(xCenter)) xGroups.set(xCenter, []);
            xGroups.get(xCenter).push(layer);
        }

        for (const [x, group] of xGroups) {
            if (group.length >= 2) {
                console.log(`    Found ${group.length} vertically aligned text layers at x≈${x}`);
                for (const layer of group) {
                    layer.textAlignment = layer.textAlignment ? "both" : "vertical";
                    layer.textAlignGroup = layer.textAlignGroup || x;
                }
            }
        }
    }

    // =====================================================
    // STEP 7: Edge element detection
    // Elements near edges are likely headers, footers, sidebars, or UI
    // =====================================================
    const edgeThreshold = 0.15; // Within 15% of edge
    for (const layer of realLayers) {
        const nearTop = layer.normTop < edgeThreshold;
        const nearBottom = layer.normBottom > (1 - edgeThreshold);
        const nearLeft = layer.normLeft < edgeThreshold;
        const nearRight = layer.normRight > (1 - edgeThreshold);

        // Small element near corner = likely logo or icon
        const coverage = layer.coveragePercent || 0;
        const isSmall = coverage < 15;
        const inCorner = (nearTop || nearBottom) && (nearLeft || nearRight);

        if (inCorner && isSmall && layer.finalGroup === "graphics") {
            // Small corner graphic - could be logo
            layer.cornerPosition = true;
            // Don't change classification, just note it
            console.log(`    Corner element: "${layer.name}" (${layer.finalGroup})`);
        }

        // Wide element at top or bottom = likely header/footer
        const isWide = (layer.normRight - layer.normLeft) > 0.7;
        if (isWide && (nearTop || nearBottom)) {
            layer.isEdgeBanner = true;
            if (nearTop) layer.bannerPosition = "top";
            if (nearBottom) layer.bannerPosition = "bottom";
        }
    }

    // =====================================================
    // STEP 8: Graphics + Text proximity = Logo candidate
    // If small graphic is very close to text, might be logo+text combo
    // =====================================================
    for (const gfx of realLayers.filter(l => l.finalGroup === "graphics" && (l.coveragePercent || 0) < 20)) {
        for (const txt of textLayers) {
            // Check if they're adjacent (within 10% of document size)
            const gfxCenterX = (gfx.normLeft + gfx.normRight) / 2;
            const gfxCenterY = (gfx.normTop + gfx.normBottom) / 2;
            const txtCenterX = (txt.normLeft + txt.normRight) / 2;
            const txtCenterY = (txt.normTop + txt.normBottom) / 2;

            const distance = Math.sqrt(
                Math.pow(gfxCenterX - txtCenterX, 2) +
                Math.pow(gfxCenterY - txtCenterY, 2)
            );

            if (distance < 0.15) {
                // Very close - might be logo + text combo
                gfx.nearbyText = txt.name;
                txt.nearbyGraphic = gfx.name;
                console.log(`    Proximity detected: "${gfx.name}" (graphic) near "${txt.name}" (text)`);
            }
        }
    }

    // =====================================================
    // STEP 9: SIBLING CONSENSUS - Similar consecutive siblings should have consistent classification
    // If effect/texture alternates among similar siblings, apply majority vote
    // =====================================================
    const layersByParent = new Map();
    for (const layer of realLayers) {
        const parentId = layer.parentId || 'root';
        if (!layersByParent.has(parentId)) {
            layersByParent.set(parentId, []);
        }
        layersByParent.get(parentId).push(layer);
    }

    for (const [parentId, siblings] of layersByParent) {
        if (siblings.length < 3) continue;

        // Find runs of consecutive soft elements (potential effect/texture confusion)
        let runStart = -1;
        let currentRun = [];

        for (let i = 0; i <= siblings.length; i++) {
            const layer = siblings[i];
            const isSoftOrGradient = layer && (layer.isSoftElement || layer.hasGradientAlpha);
            const isEffectOrTexture = layer && (layer.finalGroup === 'effect' || layer.finalGroup === 'texture');

            if (isSoftOrGradient && isEffectOrTexture) {
                if (runStart === -1) runStart = i;
                currentRun.push(layer);
            } else {
                // End of run - check for consensus
                if (currentRun.length >= 3) {
                    const effectCount = currentRun.filter(l => l.finalGroup === 'effect').length;
                    const textureCount = currentRun.filter(l => l.finalGroup === 'texture').length;

                    // Only apply consensus if there's a mix
                    if (effectCount > 0 && textureCount > 0) {
                        let consensusType;
                        if (effectCount > textureCount) {
                            consensusType = 'effect';
                        } else if (textureCount > effectCount) {
                            consensusType = 'texture';
                        } else {
                            // Tied - use position: top of stack (lower index in doc) = effect
                            // Soft elements at top are usually lighting effects
                            const avgPosition = currentRun.reduce((sum, l) => sum + (l.normTop || 0.5), 0) / currentRun.length;
                            consensusType = avgPosition < 0.5 ? 'effect' : 'texture';
                        }

                        // Apply consensus to minority
                        for (const layer of currentRun) {
                            if (layer.finalGroup !== consensusType) {
                                console.log(`    SIBLING CONSENSUS: "${layer.name}" ${layer.finalGroup} -> ${consensusType} (${effectCount} effects, ${textureCount} textures in group)`);
                                layer.originalGroup = layer.finalGroup;
                                layer.finalGroup = consensusType;
                                layer.consensusApplied = true;
                            }
                        }
                    }
                }

                // Reset for next run
                runStart = -1;
                currentRun = [];
            }
        }
    }

    console.log(`  Holistic analysis complete.`);
}

// Classify groups based on their children
function classifyGroups(layers, byId) {
    // Process groups from deepest to shallowest
    const groups = layers.filter(l => l.isGroup).sort((a, b) => b.depth - a.depth);

    for (const group of groups) {
        const children = layers.filter(l => l.parentId === group.id && !l.isGroup);
        if (children.length === 0) continue;

        // Count categories
        const counts = {};
        for (const child of children) {
            const cat = child.finalGroup;
            counts[cat] = (counts[cat] || 0) + 1;
        }

        // Find dominant category
        let maxCount = 0;
        let dominant = "mixed";
        for (const [cat, count] of Object.entries(counts)) {
            if (count > maxCount) {
                maxCount = count;
                dominant = cat;
            }
        }

        const ratio = maxCount / children.length;

        // Classify group based on children
        if (ratio >= 0.7) {
            // Strong majority - group inherits category
            group.finalGroup = dominant + "-group";
            group.confidence = Math.round(ratio * 80);
            group.reason = `${Math.round(ratio * 100)}% ${dominant}`;
        } else if (ratio >= 0.5) {
            // Simple majority
            group.finalGroup = dominant + "-group";
            group.confidence = Math.round(ratio * 60);
            group.reason = `mostly ${dominant} (${Math.round(ratio * 100)}%)`;
        } else {
            // Mixed content
            group.finalGroup = "composition-group";
            group.confidence = 40;
            const types = Object.keys(counts).join(", ");
            group.reason = `mixed: ${types}`;
        }
    }
}

// =====================================================
// PHASE 1: DATA COLLECTION
// Gather all raw information about every layer
// =====================================================

function collectLayerData(layer, docWidth, docHeight, index, parentId = null) {
    const data = {
        id: layer.id,
        index: index,
        parentId: parentId,
        name: layer.name,
        nameLower: layer.name.toLowerCase(),
        kind: layer.kind,
        visible: true,
        locked: false,

        // Bounds & geometry
        bounds: null,
        boundsNoEffects: null,
        width: 0,
        height: 0,
        area: 0,
        centerX: 0,
        centerY: 0,
        coveragePercent: 0,
        aspectRatio: 1,

        // Normalized positions (0-1)
        normLeft: 0,
        normRight: 1,
        normTop: 0,
        normBottom: 1,
        normCenterX: 0.5,
        normCenterY: 0.5,

        // Style properties
        blendMode: "normal",
        opacity: 100,
        fillOpacity: 100,

        // Clipping
        isClipped: false,
        hasClippedLayers: false,
        clippingChainBase: null,

        // Alpha/content analysis
        hasMask: false,
        hasVectorMask: false,
        hasEffects: false,
        isShape: false,
        estimatedFillRatio: 1.0, // Estimated: how much of bounds is actually filled

        // Group info
        isGroup: layer.kind === "group",
        childCount: 0,
        children: [],
        depth: 0,

        // Analysis results (filled in later passes)
        signals: [],
        votes: {},
        finalGroup: "unknown",
        confidence: 0,
        reason: ""
    };

    // Get visibility and lock state
    try { data.visible = layer.visible; } catch (e) {}
    try { data.locked = layer.locked; } catch (e) {}

    // Get bounds
    try {
        data.bounds = layer.bounds;
        data.width = data.bounds.right - data.bounds.left;
        data.height = data.bounds.bottom - data.bounds.top;
        data.area = data.width * data.height;
        data.centerX = data.bounds.left + data.width / 2;
        data.centerY = data.bounds.top + data.height / 2;
        data.coveragePercent = (data.area / (docWidth * docHeight)) * 100;
        data.aspectRatio = data.width / Math.max(data.height, 1);

        // Normalized positions
        data.normLeft = data.bounds.left / docWidth;
        data.normRight = data.bounds.right / docWidth;
        data.normTop = data.bounds.top / docHeight;
        data.normBottom = data.bounds.bottom / docHeight;
        data.normCenterX = data.centerX / docWidth;
        data.normCenterY = data.centerY / docHeight;
    } catch (e) {}

    // Get bounds without effects (more accurate for actual content)
    try {
        data.boundsNoEffects = layer.boundsNoEffects;
        if (data.boundsNoEffects && data.bounds) {
            const actualWidth = data.boundsNoEffects.right - data.boundsNoEffects.left;
            const actualHeight = data.boundsNoEffects.bottom - data.boundsNoEffects.top;
            const actualArea = actualWidth * actualHeight;
            // If boundsNoEffects is significantly smaller, layer has effects expanding it
            if (actualArea < data.area * 0.8) {
                data.hasEffects = true;
            }
        }
    } catch (e) {}

    // Get style properties
    try { data.blendMode = layer.blendMode; } catch (e) {}
    try { data.opacity = layer.opacity; } catch (e) {}
    try { data.fillOpacity = layer.fillOpacity; } catch (e) {}

    // Get clipping info - try DOM first, then batchPlay fallback
    try { data.isClipped = layer.isClippingMask; } catch (e) {}

    // batchPlay fallback for clipping detection - DOM API can be unreliable
    if (!data.isClipped) {
        try {
            const batchPlay = require('photoshop').action.batchPlay;
            const clipResult = batchPlay([{
                _obj: "get",
                _target: [{ _ref: "layer", _id: layer.id }],
                _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });

            if (clipResult && clipResult[0] && clipResult[0].group === true) {
                data.isClipped = true;
            }
        } catch (e) {}
    }

    // Check for masks - UXP has both raster masks and vector masks
    try {
        // Raster/user mask
        if (layer.mask) {
            data.hasMask = true;
            data.maskType = 'raster';
        }
    } catch (e) {}

    try {
        // Vector mask (shape-based)
        if (layer.vectorMask) {
            data.hasMask = true;
            data.maskType = data.maskType ? 'both' : 'vector';
        }
    } catch (e) {}

    // Alternative detection via batchPlay - some layers report masks differently
    try {
        const batchPlay = require('photoshop').action.batchPlay;
        const result = batchPlay([{
            _obj: "get",
            _target: [{ _ref: "layer", _id: layer.id }],
            _options: { dialogOptions: "dontDisplay" }
        }], { synchronousExecution: true });

        if (result && result[0]) {
            // Check for user mask
            if (result[0].userMaskEnabled !== undefined || result[0].userMaskDensity !== undefined) {
                data.hasMask = true;
                data.maskType = data.maskType || 'raster';
                data.userMaskEnabled = result[0].userMaskEnabled;
            }
            // Check for vector mask
            if (result[0].vectorMaskEnabled !== undefined) {
                data.hasMask = true;
                data.maskType = data.maskType === 'raster' ? 'both' : 'vector';
                data.vectorMaskEnabled = result[0].vectorMaskEnabled;
            }
        }
    } catch (e) {}

    try {
        // Vector mask check - shape layers typically have this
        if (layer.kind === "solidColor" || layer.kind === "gradientFill" || layer.kind === "patternFill") {
            data.isShape = true;
        }
    } catch (e) {}

    // Estimate fill ratio based on layer characteristics
    // This is a heuristic since we can't read actual pixels
    data.estimatedFillRatio = estimateLayerFillRatio(data, layer);

    // Count children for groups
    if (layer.layers) {
        data.childCount = layer.layers.length;
    }

    return data;
}

// Estimate how much of a layer's bounding box is actually filled with content
// Returns 0.0 to 1.0 (1.0 = fully filled, 0.1 = mostly empty)
function estimateLayerFillRatio(data, layer) {
    // Fill layers are always 100% filled within their mask
    if (data.isShape) {
        return 1.0;
    }

    // Text layers - estimate based on typical text density
    if (layer.kind === "text") {
        // Text usually fills about 30-60% of its bounding box
        return 0.4;
    }

    // Extreme aspect ratios suggest lines/thin elements
    if (data.aspectRatio > 10 || data.aspectRatio < 0.1) {
        // Very thin = probably a line, low fill
        return 0.1;
    }

    if (data.aspectRatio > 5 || data.aspectRatio < 0.2) {
        // Moderately thin
        return 0.3;
    }

    // Check name patterns that suggest sparse content
    const nameLower = data.nameLower;
    const sparsePatterns = ["line", "border", "stroke", "frame", "outline", "cross", "grid", "dots", "particles"];
    for (const pattern of sparsePatterns) {
        if (nameLower.includes(pattern)) {
            return 0.2;
        }
    }

    // Smart objects with very large coverage might be cutouts/subjects
    if (layer.kind === "smartObject" && data.coveragePercent > 30 && data.coveragePercent < 80) {
        // Likely a photo cutout - estimate 40-60% actual content
        return 0.5;
    }

    // Pixel layers with very high coverage are likely backgrounds
    if (layer.kind === "pixel" && data.coveragePercent > 90) {
        return 0.95;
    }

    // Default: assume moderate fill for unknown cases
    return 0.7;
}

async function collectAllLayers(doc) {
    const docWidth = doc.width;
    const docHeight = doc.height;
    const allLayers = [];
    let globalIndex = 0;

    function traverseSync(layers, depth = 0, parentId = null) {
        for (const layer of layers) {
            const data = collectLayerData(layer, docWidth, docHeight, globalIndex, parentId);
            data.depth = depth;
            allLayers.push(data);
            globalIndex++;

            if (layer.layers && layer.layers.length > 0) {
                const childIds = [];
                const startIdx = globalIndex;
                traverseSync(layer.layers, depth + 1, data.id);
                // Mark children
                for (let i = startIdx; i < globalIndex; i++) {
                    if (allLayers[i].parentId === data.id) {
                        childIds.push(allLayers[i].id);
                    }
                }
                data.children = childIds;
            }
        }
    }

    // First pass: collect basic data synchronously
    traverseSync(doc.layers);

    // Second pass: analyze actual pixel transparency using Imaging API
    // PERFORMANCE: Process layers in parallel batches for speed
    console.log("  Analyzing layer alpha channels...");
    let analyzedCount = 0;

    // Skip adjustment and fill layers (they don't have pixel content)
    const skipKinds = ["brightnessContrast", "levels", "curves", "exposure",
        "vibrance", "hueSaturation", "colorBalance", "blackAndWhite",
        "photoFilter", "channelMixer", "colorLookup", "invert",
        "posterize", "threshold", "gradientMap", "selectiveColor",
        "solidColor", "gradientFill", "patternFill"];

    // Filter layers that need alpha analysis
    const layersToAnalyze = allLayers.filter(layer =>
        !layer.isGroup && layer.bounds && !skipKinds.includes(layer.kind)
    );

    // Process in parallel batches for performance
    const BATCH_SIZE = 5; // Process 5 layers concurrently

    async function analyzeLayer(layer) {
        try {
            const alphaData = await analyzeLayerAlpha(
                layer.id,
                layer.bounds,
                docWidth,
                docHeight
            );

            if (alphaData.hasAlphaData) {
                layer.hasAlphaData = true;
                layer.opaquePixelRatio = alphaData.opaquePixelRatio;
                layer.averageAlpha = alphaData.averageAlpha;
                layer.transparentPixels = alphaData.transparentPixels;
                layer.opaquePixels = alphaData.opaquePixels;
                layer.semiTransparentPixels = alphaData.semiTransparentPixels;

                // Transfer the key alpha distribution metrics
                layer.solidContentRatio = alphaData.solidContentRatio;
                layer.softContentRatio = alphaData.softContentRatio;
                layer.isSolidElement = alphaData.isSolidElement;
                layer.isSoftElement = alphaData.isSoftElement;
                layer.visiblePixels = alphaData.visiblePixels;
                layer.solidPixels = alphaData.solidPixels;
                layer.softPixels = alphaData.softPixels;
                layer.boundsFilledRatio = alphaData.boundsFilledRatio;

                // Transfer color analysis data
                layer.hasColorData = alphaData.hasColorData;
                layer.dominantColorCount = alphaData.dominantColorCount;
                layer.colorVariance = alphaData.colorVariance;
                layer.hasGradientAlpha = alphaData.hasGradientAlpha;
                layer.alphaSpreadScore = alphaData.alphaSpreadScore;
                layer.filledAlphaBuckets = alphaData.filledAlphaBuckets;
                layer.isSingleColor = alphaData.isSingleColor;
                layer.isLowColorVariance = alphaData.isLowColorVariance;

                // Update fill ratio with real alpha data
                layer.estimatedFillRatio = alphaData.opaquePixelRatio;

                // Log ALL layers with alpha data for debugging
                const solidPct = (alphaData.solidContentRatio * 100).toFixed(0);
                const softPct = (alphaData.softContentRatio * 100).toFixed(0);
                const typeFlag = alphaData.isSolidElement ? 'SOLID' : (alphaData.isSoftElement ? 'SOFT' : 'MIXED');
                console.log(`    ${layer.name}: ${typeFlag} solid=${solidPct}% soft=${softPct}% gradient=${alphaData.hasGradientAlpha}`);

                return true; // Analyzed successfully
            }
        } catch (e) {
            // Silently continue if a layer can't be analyzed
        }
        return false;
    }

    async function analyzeMask(layer) {
        if (!layer.hasMask) return;

        console.log(`    MASK DETECTED on ${layer.name} (type: ${layer.maskType || 'unknown'})`);
        try {
            const maskKind = layer.maskType === 'vector' ? 'vector' : 'user';

            const maskResult = await imaging.getLayerMask({
                documentID: doc.id,
                layerID: layer.id,
                kind: maskKind
            });

            if (maskResult && maskResult.imageData) {
                const maskData = maskResult.imageData;
                const pixelData = await maskData.getData({ chunky: true });

                // Mask is single channel grayscale
                let hiddenPixels = 0;
                let partialPixels = 0;
                let visiblePixels = 0;
                const totalPixels = pixelData.length;

                for (let i = 0; i < pixelData.length; i++) {
                    const value = pixelData[i];
                    if (value <= 50) hiddenPixels++;
                    else if (value >= 205) visiblePixels++;
                    else partialPixels++;
                }

                if (totalPixels > 0) {
                    layer.maskDensity = visiblePixels / totalPixels;
                    layer.maskHiddenRatio = hiddenPixels / totalPixels;
                    layer.maskPartialRatio = partialPixels / totalPixels;
                }

                layer.effectiveCoverage = (layer.coveragePercent || 100) * layer.maskDensity;

                if (layer.maskDensity < 0.5) {
                    layer.hasMaskRestriction = true;
                }

                console.log(`      MASK: ${layer.name} visible=${(layer.maskDensity * 100).toFixed(1)}% hidden=${(layer.maskHiddenRatio * 100).toFixed(1)}% partial=${(layer.maskPartialRatio * 100).toFixed(1)}%`);
            } else {
                console.log(`      MASK: ${layer.name} - no mask data returned`);
                layer.maskDensity = 1.0;
            }
        } catch (maskErr) {
            console.log(`      MASK ERROR on ${layer.name}: ${maskErr.message}`);
            layer.maskDensity = 1.0;
        }
    }

    // Process in batches
    for (let i = 0; i < layersToAnalyze.length; i += BATCH_SIZE) {
        const batch = layersToAnalyze.slice(i, i + BATCH_SIZE);

        // Analyze alpha in parallel
        const results = await Promise.all(batch.map(analyzeLayer));
        analyzedCount += results.filter(r => r).length;

        // Analyze masks in parallel
        await Promise.all(batch.map(analyzeMask));
    }

    console.log(`  Analyzed ${analyzedCount} layers with alpha data`);

    return allLayers;
}

// =====================================================
// PHASE 2: RELATIONSHIP MAPPING
// Build connections between layers
// =====================================================

function buildRelationships(layers) {
    const byId = new Map();
    layers.forEach(l => byId.set(l.id, l));

    // Build clipping chains - must be per-parent-group since clipping only works within same parent
    // Group layers by their parentId
    const layersByParent = new Map();
    for (const layer of layers) {
        const parentId = layer.parentId || 'root';
        if (!layersByParent.has(parentId)) {
            layersByParent.set(parentId, []);
        }
        layersByParent.get(parentId).push(layer);
    }

    // Build clipping chains within each parent group
    for (const [parentId, siblings] of layersByParent) {
        // Sort siblings by their index in the original layers array (maintains stack order)
        siblings.sort((a, b) => layers.indexOf(a) - layers.indexOf(b));

        let currentClipBase = null;
        // Iterate bottom to top (higher index = lower in stack in Photoshop)
        for (let i = siblings.length - 1; i >= 0; i--) {
            const layer = siblings[i];
            if (!layer.isClipped) {
                currentClipBase = layer.id;
            } else {
                layer.clippingChainBase = currentClipBase;
                if (currentClipBase) {
                    const base = byId.get(currentClipBase);
                    if (base) base.hasClippedLayers = true;
                }
            }
        }
    }

    // Find siblings (same parent, same depth)
    for (const layer of layers) {
        layer.siblings = layers.filter(l =>
            l.id !== layer.id &&
            l.parentId === layer.parentId &&
            l.depth === layer.depth
        ).map(l => l.id);
    }

    // Find spatial neighbors (overlapping or adjacent)
    for (const layer of layers) {
        if (!layer.bounds) continue;
        layer.spatialNeighbors = [];

        for (const other of layers) {
            if (other.id === layer.id || !other.bounds) continue;

            // Check overlap or proximity
            const xOverlap = !(layer.bounds.right < other.bounds.left || layer.bounds.left > other.bounds.right);
            const yOverlap = !(layer.bounds.bottom < other.bounds.top || layer.bounds.top > other.bounds.bottom);

            if (xOverlap && yOverlap) {
                layer.spatialNeighbors.push({ id: other.id, relation: "overlaps" });
            }
        }
    }

    return { layers, byId };
}

// =====================================================
// PHASE 3: SIGNAL DETECTION
// Each detector adds weighted signals/votes
// =====================================================

// Signal weight reference (actual weights are in detection functions)
// TIER 1: Layer type (85-95) - strongest evidence
// TIER 2: Exact name match (75-85) - strong evidence
// TIER 3: Name contains (50-70) - good evidence
// TIER 4: Alpha/geometry (30-50) - supporting evidence
// TIER 5: Context/position (10-25) - weak hints
const SIGNALS = {
    // TIER 1: Layer type signals (highest weight)
    ADJUSTMENT_LAYER: { group: "adjustment", weight: 95 },
    FILL_LAYER: { group: "fill", weight: 90 },
    IS_TEXT_LAYER: { group: "text", weight: 85 },

    // TIER 2: Exact name matches
    NAME_EXACT_BACKGROUND: { group: "background", weight: 80 },
    NAME_EXACT_SUBJECT: { group: "subject", weight: 80 },
    NAME_EXACT_LOGO: { group: "logo", weight: 80 },

    // TIER 3: Name contains patterns
    NAME_CONTAINS_TEXTURE: { group: "texture", weight: 60 },
    NAME_CONTAINS_EFFECT: { group: "texture", weight: 55 },

    // TIER 4: Alpha/geometry evidence
    ALPHA_HIGH_FILL: { group: "texture", weight: 35 },
    ALPHA_SPARSE: { group: "graphics", weight: 40 },
    BLEND_MODE_OVERLAY: { group: "texture", weight: 35 },

    // TIER 5: Context hints (weak)
    TOP_OF_STACK: { group: "texture", weight: 15 },
    BOTTOM_OF_STACK: { group: "background", weight: 25 },
    LOW_OPACITY: { group: "texture", weight: 15 },
    CORNER_SMALL: { group: "graphics", weight: 20 },

    // Text signals
    TEXT_LARGE_TOP: { group: "headline", weight: 70 },
    TEXT_MEDIUM: { group: "text", weight: 55 },
    TEXT_SMALL: { group: "text", weight: 45 },

    // Shape signals
    THIN_SPANNING: { group: "graphics", weight: 50 },
    SMALL_ELEMENT: { group: "graphics", weight: 30 },

    // Contextual signals (applied in phase 4)
    UNDER_LOGO: { group: "logo-bg", weight: 75 },
    CLIPPED_TO_SUBJECT: { group: "subject-detail", weight: 70 },
    GROUP_MOSTLY_TEXT: { group: "text-group", weight: 80 },
    GROUP_CONTAINS_SUBJECT: { group: "subject-group", weight: 85 },
    GROUP_MOSTLY_GRAPHICS: { group: "graphics-group", weight: 70 },
};

// Name pattern detectors
const NAME_PATTERNS = {
    background: {
        exact: ["background", "bg", "fondo", "fond", "hintergrund", "backdrop"],
        contains: [],
        group: "background",
        weight: 95
    },
    logo: {
        exact: ["logo", "watermark", "marca", "badge", "emblem"],
        contains: ["logo", "watermark"],  // Reduced - only clear logo indicators
        group: "logo",
        weight: 80  // Reduced from 90
    },
    subject: {
        exact: ["subject", "player", "athlete", "person", "model", "portrait", "hero"],
        contains: ["subject", "player", "athlete", "person", "model", "cutout", "render"],
        group: "subject",
        weight: 85
    },
    headline: {
        exact: ["headline", "title", "header", "titulo", "heading", "main text"],
        contains: ["headline", "title", "header", "heading"],
        group: "headline",
        weight: 85
    },
    texture: {
        exact: ["texture", "grain", "noise", "dust", "scratches", "paper"],
        contains: ["texture", "grain", "noise", "overlay", "dust", "grunge", "distress"],
        group: "texture",
        weight: 80
    },
    effect: {
        exact: ["effect", "fx", "glow", "flare", "light", "bokeh", "particles"],
        contains: ["effect", "fx", "glow", "flare", "light leak", "bokeh", "particles", "sparkle"],
        group: "texture",
        weight: 75
    },
    shadow: {
        exact: ["shadow", "shade", "sombra"],
        contains: ["shadow", "drop shadow", "shade"],
        group: "effect",
        weight: 70
    }
};

// Prefix patterns (common naming conventions)
const PREFIX_PATTERNS = {
    "img_": "image",
    "txt_": "text",
    "grp_": "group",
    "lyr_": "layer",
    "so_": "smartobject",
    "bg_": "background",
    "fx_": "effect",
    "adj_": "adjustment"
};

function detectNameSignals(layer) {
    const signals = [];
    const name = layer.nameLower;

    // Check prefixes
    for (const [prefix, meaning] of Object.entries(PREFIX_PATTERNS)) {
        if (name.startsWith(prefix)) {
            layer.detectedPrefix = meaning;
            break;
        }
    }

    // Check name patterns
    for (const [patternName, pattern] of Object.entries(NAME_PATTERNS)) {
        // Exact match (higher weight)
        for (const exact of pattern.exact) {
            if (name === exact || name === exact.replace(/ /g, "_") || name === exact.replace(/ /g, "-")) {
                signals.push({
                    type: `NAME_EXACT_${patternName.toUpperCase()}`,
                    group: pattern.group,
                    weight: pattern.weight,
                    reason: `name exactly matches '${exact}'`
                });
            }
        }

        // Contains match
        for (const contains of pattern.contains) {
            if (name.includes(contains)) {
                signals.push({
                    type: `NAME_CONTAINS_${patternName.toUpperCase()}`,
                    group: pattern.group,
                    weight: pattern.weight - 10,
                    reason: `name contains '${contains}'`
                });
            }
        }
    }

    // Detect numbered sequences (frame_001, layer copy 2, etc)
    const numberMatch = name.match(/(\d{2,})|copy\s*(\d*)|#(\d+)/);
    if (numberMatch) {
        layer.isSequenced = true;
        layer.sequenceNumber = parseInt(numberMatch[1] || numberMatch[2] || numberMatch[3]) || 0;
    }

    return signals;
}

function detectTypeSignals(layer) {
    const signals = [];

    // =========================================
    // PRIMARY SIGNALS - Layer type is strongest evidence
    // These should almost always win unless contradicted
    // =========================================

    // Adjustment layers - very high confidence
    const adjustmentTypes = [
        "brightnessContrast", "levels", "curves", "exposure",
        "vibrance", "hueSaturation", "colorBalance", "blackAndWhite",
        "photoFilter", "channelMixer", "colorLookup", "invert",
        "posterize", "threshold", "gradientMap", "selectiveColor"
    ];

    if (adjustmentTypes.includes(layer.kind)) {
        signals.push({
            type: "ADJUSTMENT_LAYER",
            group: "adjustment",
            weight: 95, // Very high - this IS an adjustment
            reason: `adjustment layer (${layer.kind})`
        });
    }

    // Fill layers
    if (layer.kind === "solidColor" || layer.kind === "gradientFill" || layer.kind === "patternFill") {
        signals.push({
            type: "FILL_LAYER",
            group: "fill",
            weight: 90,
            reason: `fill layer (${layer.kind})`
        });
    }

    // TEXT LAYERS - HIGH BASE SIGNAL
    // A text layer IS text unless it's named something specific like "logo"
    if (layer.kind === "text") {
        // Check if it's specifically named as logo
        const isNamedLogo = layer.nameLower && (
            layer.nameLower.includes("logo") ||
            layer.nameLower.includes("brand") ||
            layer.nameLower.includes("watermark")
        );

        if (isNamedLogo) {
            signals.push({
                type: "TEXT_LAYER_NAMED_LOGO",
                group: "logo",
                weight: 85,
                reason: "text layer named as logo"
            });
        } else {
            signals.push({
                type: "IS_TEXT_LAYER",
                group: "text",
                weight: 85, // HIGH - text layers are text
                reason: "text layer"
            });
        }
    }

    // Shape layers - graphics
    if (layer.kind === "shape" || layer.kind === "vector") {
        signals.push({
            type: "IS_SHAPE_LAYER",
            group: "graphics",
            weight: 70,
            reason: "shape/vector layer"
        });
    }

    // Smart objects - versatile, lower base weight
    if (layer.kind === "smartObject") {
        signals.push({
            type: "IS_SMART_OBJECT",
            group: "graphics",
            weight: 30, // Low - needs other signals to determine
            reason: "smart object"
        });
    }

    // Pixel/normal layers - need other signals
    if (layer.kind === "pixel" || layer.kind === "normal") {
        // No strong signal - let other detection decide
        signals.push({
            type: "IS_PIXEL_LAYER",
            group: "graphics",
            weight: 15, // Very low base
            reason: "pixel layer"
        });
    }

    return signals;
}

function detectPortraitSignals(layer) {
    // Detect likely portraits/people based on heuristics
    const signals = [];

    if (layer.isGroup) return signals;

    const nameLower = layer.nameLower || layer.name.toLowerCase();

    // Name-based portrait detection
    const portraitNames = ["face", "portrait", "person", "head", "model", "player", "athlete", "human", "man", "woman", "guy", "girl", "photo"];
    for (const name of portraitNames) {
        if (nameLower.includes(name)) {
            signals.push({
                type: "NAME_PORTRAIT",
                group: "subject",
                weight: 70,
                reason: `name suggests portrait ('${name}')`
            });
            break;
        }
    }

    // Proportion-based detection (portrait aspect ratio + upper positioning)
    if ((layer.kind === "pixel" || layer.kind === "smartObject") && layer.bounds) {
        const aspectRatio = layer.aspectRatio;
        const isPortraitRatio = aspectRatio > 0.6 && aspectRatio < 1.2; // Roughly square to portrait
        const isUpperArea = layer.normCenterY < 0.6; // Upper 60% of canvas
        const isCentered = layer.normCenterX > 0.25 && layer.normCenterX < 0.75;
        const hasGoodSize = layer.coveragePercent > 8 && layer.coveragePercent < 60;

        if (isPortraitRatio && isUpperArea && isCentered && hasGoodSize) {
            signals.push({
                type: "PORTRAIT_PROPORTIONS",
                group: "subject",
                weight: 45,
                reason: "portrait-like proportions and position"
            });
        }
    }

    return signals;
}

// =====================================================
// NEW HIVE SIGNALS - Training-based improvements
// These ADD to existing signals, never replace
// =====================================================

function detectIntentionalNameSignals(layer) {
    // Detect if layer has an INTENTIONAL custom name vs generic auto-name
    // Custom names suggest the layer is important/meaningful
    const signals = [];
    const name = layer.name || "";
    const nameLower = name.toLowerCase();

    // Generic/auto-generated name patterns (NOT intentional)
    const genericPatterns = [
        /^layer\s*\d*$/i,                    // "Layer", "Layer 1", "Layer 23"
        /^group\s*\d*$/i,                    // "Group", "Group 1"
        /^rectangle\s*\d*$/i,                // "Rectangle 1"
        /^ellipse\s*\d*$/i,                  // "Ellipse 1"
        /^polygon\s*\d*$/i,                  // "Polygon 1"
        /^shape\s*\d*$/i,                    // "Shape 1"
        /^path\s*\d*$/i,                     // "Path 1"
        /^line\s*\d*$/i,                     // "Line 1"
        /^copy(\s*\d*)?$/i,                  // "copy", "copy 2"
        /^.+\s+copy(\s*\d*)?$/i,             // "Layer 1 copy", "something copy 2"
        /^untitled/i,                        // "Untitled"
        /^background$/i,                     // Default "Background"
        /^layer\s*\d+\s*copy/i,              // "Layer 1 copy"
    ];

    const isGenericName = genericPatterns.some(pattern => pattern.test(name));

    if (!isGenericName && name.length > 2) {
        // This is an INTENTIONAL name - someone named it on purpose
        layer.hasIntentionalName = true;

        // Check if it looks like a human/person name (for subject detection)
        // Human names: usually capitalized, no numbers, no technical terms
        const looksLikeHumanName = (
            /^[A-Z][a-z]+/.test(name) &&           // Starts with capital
            !/\d/.test(name) &&                     // No numbers
            !/_/.test(name) &&                      // No underscores
            !/^(bg|fx|img|txt|grp|adj)/i.test(name) && // Not a prefix convention
            name.length >= 3 && name.length <= 30 && // Reasonable name length
            !/\.(png|jpg|psd|ai|eps)$/i.test(name)   // Not a filename
        );

        // Names with spaces that look like person names
        const looksLikeFullName = /^[A-Z][a-z]+(\s+[A-Z][a-z]+)+/.test(name) || // "John Smith"
                                  /^[A-Z][a-z]+\s*-\s*[A-Z][a-z]+/.test(name) || // "Sierra - Dawn"
                                  /^[A-Z]+\s*\(\d+\)/.test(name);  // "DRYAD (1)" style

        if (looksLikeHumanName || looksLikeFullName) {
            signals.push({
                type: "HUMAN_NAME_PATTERN",
                group: "subject",
                weight: 25,
                reason: `intentional name looks like person: '${name}'`
            });
        }

        // Month/date patterns in name often indicate photo shoots (subjects)
        if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*\d{0,4}/i.test(name)) {
            signals.push({
                type: "DATE_IN_NAME",
                group: "subject",
                weight: 20,
                reason: "date pattern suggests photo/subject"
            });
        }

        // All caps names often are subjects or important elements (DRYAD, ZHOBIII)
        if (/^[A-Z]{3,}(\s*\(\d+\))?$/.test(name)) {
            signals.push({
                type: "ALL_CAPS_NAME",
                group: "subject",
                weight: 15,
                reason: "all-caps suggests important element"
            });
        }
    } else {
        layer.hasIntentionalName = false;
    }

    return signals;
}

function detectShapeFrameSignals(layer, layers, byId) {
    // Detect shape layers that serve as FRAMES for clipped subjects
    const signals = [];

    // Only process shape layers
    if (layer.kind !== "shape" && layer.kind !== "solidColor") return signals;

    // Check if this shape has content clipped TO it
    const clippedToThis = layers.filter(l => l.clippingChainBase === layer.id);

    if (clippedToThis.length > 0) {
        // Something is clipped to this shape - it's a frame
        signals.push({
            type: "SHAPE_HAS_CLIPPED_CONTENT",
            group: "subject",
            weight: 20,
            reason: `shape with ${clippedToThis.length} clipped layer(s)`
        });

        // Check if any clipped layer might be a subject
        for (const clipped of clippedToThis) {
            const isSmartObject = clipped.kind === "smartObject";
            const isPixel = clipped.kind === "pixel";
            const hasIntentionalName = clipped.hasIntentionalName;
            const hasSubjectSignals = clipped.signals?.some(s => s.group === "subject");

            if ((isSmartObject || isPixel) && (hasIntentionalName || hasSubjectSignals)) {
                signals.push({
                    type: "FRAME_FOR_LIKELY_SUBJECT",
                    group: "subject",
                    weight: 30,
                    reason: `frame for '${clipped.name}' (likely subject)`
                });
                break; // One strong signal is enough
            }
        }
    }

    // Partial coverage shape (not full canvas) more likely to be frame
    if (layer.coveragePercent > 5 && layer.coveragePercent < 70) {
        signals.push({
            type: "PARTIAL_COVERAGE_SHAPE",
            group: "subject",
            weight: 15,
            reason: `shape covers ${Math.round(layer.coveragePercent)}% (frame-like)`
        });
    }

    return signals;
}

function detectClippedSubjectSignals(layer, byId) {
    // Detect layers that are clipped TO shapes (likely subjects in frames)
    const signals = [];

    if (!layer.isClipped || !layer.clippingChainBase) return signals;

    const base = byId.get(layer.clippingChainBase);
    if (!base) return signals;

    // Clipped to a shape layer = likely subject in frame
    if (base.kind === "shape" || base.kind === "solidColor") {
        signals.push({
            type: "CLIPPED_TO_SHAPE_FRAME",
            group: "subject",
            weight: 25,
            reason: `clipped to shape '${base.name}'`
        });

        // Smart object clipped to shape = strong subject signal
        if (layer.kind === "smartObject") {
            signals.push({
                type: "SMART_OBJECT_IN_FRAME",
                group: "subject",
                weight: 30,
                reason: "smart object clipped to shape frame"
            });
        }

        // Pixel layer clipped to shape
        if (layer.kind === "pixel") {
            signals.push({
                type: "PIXEL_LAYER_IN_FRAME",
                group: "subject",
                weight: 25,
                reason: "pixel layer clipped to shape frame"
            });
        }
    }

    return signals;
}

function detectFillSignals(layer) {
    // Detect fill/color/light layers using gradient alpha + color analysis
    const signals = [];

    // Need color data from Imaging API
    if (!layer.hasColorData) return signals;

    // NOTE: Gradient alpha fill signals REMOVED - was causing false positives on logos
    // Fill detection now relies only on:
    // - Explicit fill layer types (solidColor, gradientFill, patternFill)
    // - Clipped color overlays with blend modes
    // - Full coverage single color with blend modes

    return signals;
}

function detectTextureSequenceSignals(layer, layers, index) {
    // Detect layers that are part of texture/lighting sequences
    const signals = [];

    // Look for similar layers nearby (within 5 positions)
    const searchRange = 5;
    const startIdx = Math.max(0, index - searchRange);
    const endIdx = Math.min(layers.length - 1, index + searchRange);

    let similarCount = 0;
    const similarLayers = [];

    for (let i = startIdx; i <= endIdx; i++) {
        if (i === index) continue;
        const other = layers[i];

        // Check for similarity: similar blend mode, similar coverage, gradient alpha
        const sameBlendy = (
            (layer.blendMode !== "normal" && other.blendMode !== "normal") ||
            layer.blendMode === other.blendMode
        );
        const similarCoverage = Math.abs((layer.coveragePercent || 0) - (other.coveragePercent || 0)) < 30;
        const bothHaveGradientAlpha = layer.hasGradientAlpha && other.hasGradientAlpha;
        const bothLowColorVariance = layer.isLowColorVariance && other.isLowColorVariance;

        if ((sameBlendy && similarCoverage) || bothHaveGradientAlpha || bothLowColorVariance) {
            similarCount++;
            similarLayers.push(other.name);
        }
    }

    // 2+ similar layers nearby = sequence pattern
    if (similarCount >= 2) {
        signals.push({
            type: "IN_TEXTURE_SEQUENCE",
            group: "texture",
            weight: 25,
            reason: `part of sequence with ${similarCount} similar layers`
        });

        // If all have gradient alpha, stronger signal
        if (layer.hasGradientAlpha) {
            signals.push({
                type: "SEQUENCE_GRADIENT_ALPHA",
                group: "texture",
                weight: 20,
                reason: "gradient alpha in sequence"
            });
        }
    }

    // Gradient alpha + low color variance + overlay blend = texture/light
    if (layer.hasGradientAlpha && layer.isLowColorVariance && layer.blendMode !== "normal") {
        signals.push({
            type: "GRADIENT_OVERLAY_PATTERN",
            group: "texture",
            weight: 30,
            reason: "gradient alpha + overlay blend = light/texture"
        });
    }

    return signals;
}

function detectCornerLogoSignals(layer) {
    // Enhanced logo detection for corner elements
    const signals = [];

    if (!layer.bounds) return signals;

    // Check if in corner
    const inCorner = (
        (layer.normLeft < 0.2 && layer.normTop < 0.2) ||
        (layer.normRight > 0.8 && layer.normTop < 0.2) ||
        (layer.normLeft < 0.2 && layer.normBottom > 0.8) ||
        (layer.normRight > 0.8 && layer.normBottom > 0.8)
    );

    if (!inCorner) return signals;

    // Corner + NOT text = more likely logo
    if (layer.kind !== "text") {
        signals.push({
            type: "CORNER_NON_TEXT",
            group: "logo",
            weight: 20,
            reason: "corner element (not text)"
        });
    }

    // Corner + smart object = likely logo
    if (layer.kind === "smartObject") {
        signals.push({
            type: "CORNER_SMART_OBJECT",
            group: "logo",
            weight: 25,
            reason: "smart object in corner"
        });
    }

    // Corner + small size + distinct shape
    if (layer.coveragePercent < 10 && layer.opaquePixelRatio > 0.3) {
        signals.push({
            type: "CORNER_SMALL_DISTINCT",
            group: "logo",
            weight: 20,
            reason: "small distinct element in corner"
        });
    }

    // Corner + intentional name (not "Layer 1")
    if (layer.hasIntentionalName) {
        signals.push({
            type: "CORNER_INTENTIONAL_NAME",
            group: "logo",
            weight: 15,
            reason: `named corner element: '${layer.name}'`
        });
    }

    return signals;
}

function detectBlendSignals(layer) {
    const signals = [];

    // Blend modes suggest texture/overlay BUT shouldn't override other signals
    // These are weak supporting signals only
    const overlayModes = ["overlay", "softLight", "hardLight", "vividLight", "linearLight", "pinLight"];
    const multiplyModes = ["multiply", "darken", "colorBurn", "linearBurn", "darkerColor"];
    const screenModes = ["screen", "lighten", "colorDodge", "linearDodge", "lighterColor"];
    const differenceModes = ["difference", "exclusion", "subtract", "divide"];

    if (overlayModes.includes(layer.blendMode)) {
        signals.push({
            type: "BLEND_MODE_OVERLAY",
            group: "texture",
            weight: 35,  // Reduced - supporting evidence only
            reason: `blend: ${layer.blendMode}`
        });
    }

    if (multiplyModes.includes(layer.blendMode)) {
        signals.push({
            type: "BLEND_MODE_MULTIPLY",
            group: "texture",
            weight: 30,  // Reduced
            reason: `blend: ${layer.blendMode}`
        });
    }

    if (screenModes.includes(layer.blendMode)) {
        signals.push({
            type: "BLEND_MODE_SCREEN",
            group: "texture",
            weight: 30,  // Reduced
            reason: `blend: ${layer.blendMode}`
        });
    }

    if (differenceModes.includes(layer.blendMode)) {
        signals.push({
            type: "BLEND_MODE_DIFFERENCE",
            group: "texture",
            weight: 25,  // Reduced
            reason: `blend: ${layer.blendMode}`
        });
    }

    return signals;
}

function detectOpacitySignals(layer) {
    const signals = [];

    // Low opacity suggests overlay/texture, but weakly
    // Many layer types use reduced opacity
    if (layer.opacity < 20) {
        signals.push({
            type: "VERY_LOW_OPACITY",
            group: "texture",
            weight: 25,  // Reduced - weak signal
            reason: `very low opacity (${layer.opacity}%)`
        });
    } else if (layer.opacity < 50) {
        signals.push({
            type: "LOW_OPACITY",
            group: "texture",
            weight: 15,  // Reduced - very weak
            reason: `low opacity (${layer.opacity}%)`
        });
    }

    if (layer.fillOpacity < 50 && layer.fillOpacity !== layer.opacity) {
        signals.push({
            type: "LOW_FILL_OPACITY",
            group: "texture",
            weight: 15,  // Reduced
            reason: `low fill (${layer.fillOpacity}%)`
        });
    }

    return signals;
}

function detectGeometrySignals(layer, totalLayers) {
    const signals = [];

    if (!layer.bounds) return signals;

    // Use REAL alpha data if available from Imaging API
    const hasRealAlpha = layer.hasAlphaData === true;
    const fillRatio = hasRealAlpha ? layer.opaquePixelRatio : layer.estimatedFillRatio;
    const effectiveCoverage = layer.coveragePercent * fillRatio;
    const aspectRatio = layer.aspectRatio;

    // SPARSE LAYER DETECTION - large bounds but low actual content (like crosses, lines)
    if (layer.coveragePercent > 40 && fillRatio < 0.5) {
        const weight = hasRealAlpha ? 90 : 60; // Much higher confidence with real pixel data
        signals.push({
            type: "SPARSE_LARGE_BOUNDS",
            group: "graphics",
            weight: weight,
            reason: `large bounds but only ${Math.round(fillRatio * 100)}% opaque${hasRealAlpha ? ' (pixel verified)' : ''}`
        });
    }

    // VERY SPARSE - almost empty layer spanning canvas
    if (layer.coveragePercent > 60 && fillRatio < 0.2 && hasRealAlpha) {
        signals.push({
            type: "VERY_SPARSE_LAYER",
            group: "graphics",
            weight: 95,
            reason: `only ${Math.round(fillRatio * 100)}% opaque pixels (thin element)`
        });
    }

    // Full canvas coverage - only if actually filled
    if (layer.coveragePercent > 95 && fillRatio > 0.8) {
        const weight = hasRealAlpha ? 75 : 60;
        signals.push({
            type: "FULL_COVERAGE",
            group: "background",
            weight: weight,
            reason: `covers ${Math.round(layer.coveragePercent)}% of canvas (${Math.round(fillRatio * 100)}% opaque)`
        });
    } else if (layer.coveragePercent > 95 && fillRatio <= 0.8) {
        // Large bounds but not solid - probably graphics (like a cross)
        const weight = hasRealAlpha ? 85 : 50;
        signals.push({
            type: "FULL_BOUNDS_SPARSE",
            group: "graphics",
            weight: weight,
            reason: `full canvas but only ${Math.round(fillRatio * 100)}% opaque${hasRealAlpha ? ' (verified)' : ''}`
        });
    }

    // Very large but not full (might be subject or background element)
    if (layer.coveragePercent > 70 && layer.coveragePercent <= 95 && fillRatio > 0.5) {
        signals.push({
            type: "LARGE_COVERAGE",
            group: "graphics",
            weight: 30,
            reason: `large element (${Math.round(effectiveCoverage)}% effective)`
        });
    }

    // Thin spanning elements (lines, borders, crosses) - by aspect ratio
    const isThin = aspectRatio > 15 || aspectRatio < 0.067;
    const isSpanning = layer.coveragePercent > 20;
    if (isThin && isSpanning) {
        signals.push({
            type: "THIN_SPANNING",
            group: "graphics",
            weight: 80,
            reason: `thin element spanning canvas (ratio: ${aspectRatio.toFixed(1)})`
        });
    }

    // Medium thin elements (not extreme but still elongated)
    const isMediumThin = (aspectRatio > 5 || aspectRatio < 0.2) && !isThin;
    if (isMediumThin && layer.coveragePercent > 10) {
        signals.push({
            type: "ELONGATED_ELEMENT",
            group: "graphics",
            weight: 60,
            reason: `elongated element (ratio: ${aspectRatio.toFixed(1)})`
        });
    }

    // SUBJECT DETECTION - centered content with reasonable fill ratio
    const isCentered = layer.normCenterX > 0.25 && layer.normCenterX < 0.75;
    const isVerticallyCentered = layer.normCenterY > 0.15 && layer.normCenterY < 0.85;
    const isSubjectSize = effectiveCoverage > 8 && effectiveCoverage < 65;
    const isImageType = layer.kind === "pixel" || layer.kind === "smartObject";

    // Subjects typically have 30-70% opaque pixels (cutout with transparency around edges)
    if (isCentered && isVerticallyCentered && isSubjectSize && isImageType) {
        if (fillRatio > 0.25 && fillRatio < 0.85) {
            const weight = hasRealAlpha ? 85 : 70;
            signals.push({
                type: "CENTERED_CUTOUT",
                group: "subject",
                weight: weight,
                reason: `centered cutout (~${Math.round(fillRatio * 100)}% opaque, likely subject)`
            });
        } else if (fillRatio >= 0.85) {
            signals.push({
                type: "CENTERED_SOLID_IMAGE",
                group: "subject",
                weight: 65,
                reason: `centered solid image (~${Math.round(effectiveCoverage)}% coverage)`
            });
        }
    }

    // Corner elements (logos, badges)
    const isSmall = layer.coveragePercent < 10;
    const inCorner = (
        (layer.normLeft < 0.2 && layer.normTop < 0.2) ||
        (layer.normRight > 0.8 && layer.normTop < 0.2) ||
        (layer.normLeft < 0.2 && layer.normBottom > 0.8) ||
        (layer.normRight > 0.8 && layer.normBottom > 0.8)
    );

    if (isSmall && inCorner) {
        const corner =
            layer.normLeft < 0.2 && layer.normTop < 0.2 ? "top-left" :
            layer.normRight > 0.8 && layer.normTop < 0.2 ? "top-right" :
            layer.normLeft < 0.2 && layer.normBottom > 0.8 ? "bottom-left" : "bottom-right";

        // Corner elements are often logos BUT not always
        // Only weak signal - needs name confirmation
        signals.push({
            type: "CORNER_SMALL",
            group: "graphics",  // Changed from logo - don't assume
            weight: 20,  // Reduced significantly
            reason: `corner element (${corner})`
        });
    }

    // Very small elements
    if (layer.coveragePercent < 3 && layer.coveragePercent > 0) {
        signals.push({
            type: "TINY_ELEMENT",
            group: "graphics",
            weight: 30,
            reason: `tiny element (${layer.coveragePercent.toFixed(1)}%)`
        });
    }

    // Small elements
    if (layer.coveragePercent >= 3 && layer.coveragePercent < 10) {
        signals.push({
            type: "SMALL_ELEMENT",
            group: "graphics",
            weight: 40,
            reason: `small element (${Math.round(layer.coveragePercent)}%)`
        });
    }

    return signals;
}

function detectTextSignals(layer, docWidth, docHeight) {
    const signals = [];

    if (layer.kind !== "text") return signals;

    // Mark as text type for subtag
    layer.isTextLayer = true;

    // Estimate text size based on coverage and position
    const isLarge = layer.coveragePercent > 5;
    const isMedium = layer.coveragePercent > 1 && layer.coveragePercent <= 5;
    const isSmall = layer.coveragePercent > 0.3 && layer.coveragePercent <= 1;
    const isTiny = layer.coveragePercent <= 0.3;
    const isVeryTiny = layer.coveragePercent <= 0.15;

    const isTop = layer.normCenterY < 0.35;
    const isMiddle = layer.normCenterY >= 0.35 && layer.normCenterY <= 0.65;
    const isBottom = layer.normCenterY > 0.65;

    const isCentered = layer.normCenterX > 0.3 && layer.normCenterX < 0.7;

    // Large text at top center = headline
    if (isLarge && isTop && isCentered) {
        signals.push({
            type: "TEXT_LARGE_TOP",
            group: "headline",
            weight: 80,
            reason: "large centered text at top"
        });
    }

    // Large text anywhere else = still headline
    if (isLarge && !isTop) {
        signals.push({
            type: "TEXT_LARGE",
            group: "headline",
            weight: 70,
            reason: "large text element"
        });
    }

    // Medium text = readable text
    if (isMedium) {
        signals.push({
            type: "TEXT_MEDIUM",
            group: "text",
            weight: 65,
            reason: "medium text element"
        });
    }

    // Small text = could be text or graphic depending on context
    if (isSmall) {
        signals.push({
            type: "TEXT_SMALL",
            group: "text",
            weight: 45,
            reason: "small text"
        });
        // Also vote for graphics since small text is often decorative
        signals.push({
            type: "TEXT_SMALL_DECORATIVE",
            group: "graphics",
            weight: 35,
            reason: "small text (possibly decorative)"
        });
    }

    // Tiny text = more likely graphic/decorative
    if (isTiny && !isVeryTiny) {
        signals.push({
            type: "TEXT_TINY",
            group: "graphics",
            weight: 55,
            reason: "tiny text (decorative)"
        });
        signals.push({
            type: "TEXT_TINY_READABLE",
            group: "text",
            weight: 30,
            reason: "tiny text"
        });
    }

    // Very tiny text = definitely graphic/decorative element
    if (isVeryTiny) {
        signals.push({
            type: "TEXT_MICRO",
            group: "graphics",
            weight: 75,
            reason: "micro text (graphic element)"
        });
    }

    // Tiny text at bottom = caption/credit (still text)
    if (isTiny && isBottom) {
        signals.push({
            type: "TEXT_CAPTION",
            group: "text",
            weight: 50,
            reason: "caption/credit text"
        });
    }

    return signals;
}

function detectStackPositionSignals(layer, index, totalLayers) {
    const signals = [];

    const normalizedPosition = index / Math.max(totalLayers - 1, 1);

    // Stack position is weak evidence - many exceptions
    // Top of stack MAY be overlays, but could be anything
    if (normalizedPosition < 0.1 && index < 3) {
        signals.push({
            type: "TOP_OF_STACK",
            group: "texture",
            weight: 15,  // Very weak - just a hint
            reason: "top of stack"
        });
    }

    // Bottom of stack - slightly stronger for background
    if (normalizedPosition > 0.9 && layer.depth === 0) {
        signals.push({
            type: "BOTTOM_OF_STACK",
            group: "background",
            weight: 25,  // Reduced
            reason: "bottom of stack"
        });
    }

    return signals;
}

// =====================================================
// ALPHA-BASED SIGNAL DETECTION
// Uses ALL alpha variables as SUPPORTING evidence
// These signals should inform, not dominate
// =====================================================

function detectAlphaSignals(layer) {
    const signals = [];

    // Only process if we have real alpha data from Imaging API
    if (!layer.hasAlphaData) return signals;

    const opaqueRatio = layer.opaquePixelRatio;       // 0-1: how much of layer is opaque
    const avgAlpha = layer.averageAlpha;               // 0-1: average alpha value
    const coverage = layer.coveragePercent || 0;       // how much of canvas the bounds cover
    const transparentPx = layer.transparentPixels || 0;
    const opaquePx = layer.opaquePixels || 0;
    const semiPx = layer.semiTransparentPixels || 0;
    const totalPx = transparentPx + opaquePx + semiPx;

    // Calculate additional metrics
    const semiRatio = totalPx > 0 ? semiPx / totalPx : 0;
    const pureOpaqueRatio = totalPx > 0 ? opaquePx / totalPx : 0;

    // =========================================
    // TEXTURE vs GRAPHICS discrimination
    // Key insight: textures FILL their bounds, graphics are SPARSE
    // =========================================

    // HIGH FILL + LARGE COVERAGE = supports texture/background
    if (opaqueRatio > 0.85 && coverage > 70) {
        signals.push({
            type: "ALPHA_HIGH_FILL",
            group: "texture",
            weight: 35,  // Moderate - supporting evidence only
            reason: `high fill (${Math.round(opaqueRatio * 100)}% opaque)`
        });
    }

    // SPARSE CONTENT = supports graphics classification
    // This REDUCES texture likelihood, doesn't force graphics
    if (opaqueRatio < 0.5 && coverage > 30) {
        signals.push({
            type: "ALPHA_SPARSE",
            group: "graphics",
            weight: 40,  // Moderate positive for graphics
            reason: `sparse (${Math.round(opaqueRatio * 100)}% opaque)`
        });

        // Reduce texture likelihood (but don't dominate)
        signals.push({
            type: "ALPHA_NOT_TEXTURE",
            group: "texture",
            weight: -35,  // Moderate negative
            reason: `sparse content unlikely texture`
        });
    }

    // VERY SPARSE = stronger graphics signal
    if (opaqueRatio < 0.25 && coverage > 20) {
        signals.push({
            type: "ALPHA_VERY_SPARSE",
            group: "graphics",
            weight: 50,
            reason: `very sparse (${Math.round(opaqueRatio * 100)}%)`
        });
    }

    // =========================================
    // BACKGROUND DETECTION
    // Solid, full coverage = likely background
    // =========================================

    if (opaqueRatio > 0.95 && coverage > 90) {
        signals.push({
            type: "ALPHA_SOLID_FULL",
            group: "background",
            weight: 50,
            reason: `solid full coverage`
        });
    }

    // =========================================
    // SUBJECT DETECTION support
    // Medium coverage, distinct shape
    // =========================================

    if (pureOpaqueRatio > 0.7 && semiRatio < 0.2 && coverage > 15 && coverage < 70) {
        signals.push({
            type: "ALPHA_DISTINCT_SHAPE",
            group: "subject",
            weight: 30,
            reason: `distinct shape (${Math.round(coverage)}% coverage)`
        });
    }

    return signals;
}

function runSignalDetection(layers, byId) {
    const totalLayers = layers.length;

    // PHASE 3A: Per-layer signal detection
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const signals = [];

        // Original detectors
        signals.push(...detectNameSignals(layer));
        signals.push(...detectTypeSignals(layer));
        signals.push(...detectBlendSignals(layer));
        signals.push(...detectOpacitySignals(layer));
        signals.push(...detectGeometrySignals(layer, totalLayers));
        signals.push(...detectAlphaSignals(layer));
        signals.push(...detectTextSignals(layer, 100, 100));
        signals.push(...detectStackPositionSignals(layer, i, totalLayers));
        signals.push(...detectPortraitSignals(layer));

        // NEW HIVE SIGNALS - Training-based improvements
        signals.push(...detectIntentionalNameSignals(layer));
        signals.push(...detectFillSignals(layer));
        signals.push(...detectCornerLogoSignals(layer));
        signals.push(...detectTextureSequenceSignals(layer, layers, i));

        layer.signals = signals;
    }

    // PHASE 3B: Contextual signals that need cross-layer awareness
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];

        // Shape frames need to know about clipped content
        layer.signals.push(...detectShapeFrameSignals(layer, layers, byId));

        // Clipped layers need to know about their base
        layer.signals.push(...detectClippedSubjectSignals(layer, byId));
    }

    return layers;
}

// =====================================================
// PHASE 4: CONTEXTUAL ANALYSIS
// Analyze relationships and adjust signals
// =====================================================

function analyzeClippingContext(layers, byId) {
    for (const layer of layers) {
        if (layer.isClipped && layer.clippingChainBase) {
            const base = byId.get(layer.clippingChainBase);
            if (base) {
                // Mark as clipped (metadata, not a category)
                layer.isClippedTo = base.name;

                // If base is subject, boost subject-related signals
                const baseIsSubject = base.signals.some(s => s.group === "subject");
                if (baseIsSubject) {
                    layer.signals.push({
                        type: "CLIPPED_TO_SUBJECT",
                        group: "subject",
                        weight: 40,
                        reason: "clipped to subject"
                    });
                }

                // If base is background, this might be a background element too
                const baseIsBackground = base.signals.some(s => s.group === "background");
                if (baseIsBackground) {
                    layer.signals.push({
                        type: "CLIPPED_TO_BACKGROUND",
                        group: "background",
                        weight: 30,
                        reason: "clipped to background"
                    });
                }
            }
        }
    }
}

function analyzeGroupContents(layers, byId) {
    // Process groups from deepest to shallowest (bottom-up)
    const groups = layers.filter(l => l.isGroup).sort((a, b) => b.depth - a.depth);

    for (const group of groups) {
        // Find direct children
        const children = layers.filter(l => l.parentId === group.id);
        if (children.length === 0) continue;

        // Count child types
        const childGroups = {};
        let textCount = 0;
        let graphicsCount = 0;
        let subjectCount = 0;
        let textureCount = 0;
        let adjustmentCount = 0;

        for (const child of children) {
            // Get the winning group for this child so far
            const votes = {};
            for (const signal of child.signals) {
                votes[signal.group] = (votes[signal.group] || 0) + signal.weight;
            }

            let maxVote = 0;
            let winningGroup = "unknown";
            for (const [grp, vote] of Object.entries(votes)) {
                if (vote > maxVote) {
                    maxVote = vote;
                    winningGroup = grp;
                }
            }

            childGroups[winningGroup] = (childGroups[winningGroup] || 0) + 1;

            if (winningGroup === "text" || winningGroup === "headline" || winningGroup === "caption") textCount++;
            if (winningGroup === "graphics" || winningGroup === "logo") graphicsCount++;
            if (winningGroup === "subject" || winningGroup === "subject-detail") subjectCount++;
            if (winningGroup === "texture") textureCount++;
            if (winningGroup === "adjustment") adjustmentCount++;
        }

        const total = children.length;

        // Determine group type based on children composition
        if (subjectCount > 0) {
            group.signals.push({
                type: "GROUP_CONTAINS_SUBJECT",
                group: "subject-group",
                weight: 85,
                reason: `contains ${subjectCount} subject layer(s)`
            });
        }

        // Text groups - if mostly text layers (even small ones)
        if (textCount / total > 0.5) {
            group.signals.push({
                type: "GROUP_MOSTLY_TEXT",
                group: "text-group",
                weight: 85,
                reason: `${Math.round(textCount / total * 100)}% text layers`
            });
        }

        // Check if children are text layers directly (not just by classification)
        const textLayerCount = children.filter(c => c.kind === "text").length;
        if (textLayerCount / total > 0.5) {
            group.signals.push({
                type: "GROUP_TEXT_LAYERS",
                group: "text-group",
                weight: 80,
                reason: `contains ${textLayerCount} text layers`
            });
        }

        // Texture groups - check FIRST and with higher weight (texture beats graphics)
        if (textureCount > 0 && textureCount / total >= 0.4) {
            group.signals.push({
                type: "GROUP_MOSTLY_TEXTURE",
                group: "texture-group",
                weight: 90,
                reason: `${Math.round(textureCount / total * 100)}% texture content (${textureCount} layers)`
            });
        }

        // Graphics groups - only if NOT texture
        if (graphicsCount / total > 0.5 && textCount === 0 && textureCount === 0) {
            group.signals.push({
                type: "GROUP_MOSTLY_GRAPHICS",
                group: "graphics-group",
                weight: 70,
                reason: `${Math.round(graphicsCount / total * 100)}% graphics content`
            });
        }

        if (adjustmentCount / total > 0.7) {
            group.signals.push({
                type: "GROUP_MOSTLY_ADJUSTMENTS",
                group: "adjustment-group",
                weight: 80,
                reason: `${Math.round(adjustmentCount / total * 100)}% adjustments`
            });
        }

        // Mixed content group
        const types = Object.keys(childGroups).length;
        if (types >= 3) {
            group.signals.push({
                type: "GROUP_MIXED",
                group: "composition-group",
                weight: 50,
                reason: `mixed content (${types} different types)`
            });
        }
    }
}

function analyzeLayerNeighbors(layers, byId) {
    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        const prev = i > 0 ? layers[i - 1] : null;
        const next = i < layers.length - 1 ? layers[i + 1] : null;

        // Layer directly under a logo (same parent, adjacent) = logo background
        if (next && layer.parentId === next.parentId) {
            const nextHasLogo = next.signals.some(s => s.group === "logo");
            const currentIsFillOrGraphics = layer.signals.some(s =>
                s.group === "fill" || s.group === "graphics"
            );

            if (nextHasLogo && currentIsFillOrGraphics) {
                layer.signals.push({
                    type: "UNDER_LOGO",
                    group: "logo-bg",
                    weight: 75,
                    reason: `directly under logo '${next.name}'`
                });
            }
        }

        // Texture layers in clusters boost each other
        const isTexture = layer.signals.some(s => s.group === "texture");
        if (isTexture) {
            let nearbyTextures = 0;
            for (let j = Math.max(0, i - 4); j < Math.min(layers.length, i + 4); j++) {
                if (j !== i && layers[j].signals.some(s => s.group === "texture")) {
                    nearbyTextures++;
                }
            }
            if (nearbyTextures >= 2) {
                layer.signals.push({
                    type: "TEXTURE_CLUSTER",
                    group: "texture",
                    weight: 20,
                    reason: `part of texture cluster (${nearbyTextures} nearby)`
                });
            }
        }
    }
}

function runContextualAnalysis(layers, byId) {
    analyzeClippingContext(layers, byId);
    analyzeGroupContents(layers, byId);
    analyzeLayerNeighbors(layers, byId);
    // Spatial analysis disabled - was causing logo bias
    // analyzeSpatialRelationships(layers);
    // analyzeImaginaryGuides(layers);
    return layers;
}

// =====================================================
// SPATIAL RELATIONSHIP ANALYSIS
// Detects when text and graphics are positioned together (logos, brands)
// =====================================================

function analyzeSpatialRelationships(layers) {
    // Get non-group layers with bounds
    const layersWithBounds = layers.filter(l => !l.isGroup && l.bounds);

    // Find text layers and graphics layers
    const textLayers = layersWithBounds.filter(l => {
        const hasTextSignal = l.signals.some(s =>
            s.group === "text" || s.group === "headline" || s.group === "caption"
        );
        return l.kind === "text" || hasTextSignal;
    });

    const graphicsLayers = layersWithBounds.filter(l => {
        const hasGraphicsSignal = l.signals.some(s =>
            s.group === "graphics" || s.group === "logo"
        );
        return hasGraphicsSignal || l.kind === "shape";
    });

    // Check spatial proximity between text and graphics
    for (const textLayer of textLayers) {
        for (const graphicsLayer of graphicsLayers) {
            if (textLayer.id === graphicsLayer.id) continue;

            const proximity = calculateProximity(textLayer.bounds, graphicsLayer.bounds);

            // Layers overlap or are very close
            if (proximity.overlaps || proximity.distance < 50) {
                const proximityWeight = proximity.overlaps ? 75 : Math.max(40, 70 - proximity.distance);

                // Boost both layers as part of a logo/brand unit
                textLayer.signals.push({
                    type: "SPATIAL_TEXT_WITH_GRAPHICS",
                    group: "logo",
                    weight: proximityWeight,
                    reason: `text+graphics combo (${proximity.overlaps ? 'overlapping' : proximity.distance + 'px apart'})`
                });

                graphicsLayer.signals.push({
                    type: "SPATIAL_GRAPHICS_WITH_TEXT",
                    group: "logo",
                    weight: proximityWeight,
                    reason: `graphics+text combo (${proximity.overlaps ? 'overlapping' : proximity.distance + 'px apart'})`
                });

                // If they're in the same parent group, boost more
                if (textLayer.parentId === graphicsLayer.parentId && textLayer.parentId) {
                    textLayer.signals.push({
                        type: "SAME_GROUP_TEXT_GRAPHICS",
                        group: "logo",
                        weight: 30,
                        reason: `same group as graphics`
                    });
                    graphicsLayer.signals.push({
                        type: "SAME_GROUP_GRAPHICS_TEXT",
                        group: "logo",
                        weight: 30,
                        reason: `same group as text`
                    });
                }
            }

            // Check alignment (horizontally or vertically aligned = likely intentional grouping)
            if (proximity.distance < 100) {
                const alignment = checkAlignment(textLayer.bounds, graphicsLayer.bounds);
                if (alignment.aligned) {
                    textLayer.signals.push({
                        type: "SPATIAL_ALIGNED_TEXT",
                        group: "logo",
                        weight: 25,
                        reason: `${alignment.type} aligned with graphics`
                    });
                    graphicsLayer.signals.push({
                        type: "SPATIAL_ALIGNED_GRAPHICS",
                        group: "logo",
                        weight: 25,
                        reason: `${alignment.type} aligned with text`
                    });
                }
            }
        }
    }

    // Also check for small text near larger graphics (likely labels/captions for the graphic)
    for (const textLayer of textLayers) {
        if (!textLayer.bounds) continue;

        const textWidth = textLayer.bounds.right - textLayer.bounds.left;
        const textHeight = textLayer.bounds.bottom - textLayer.bounds.top;
        const isSmallText = textWidth < 200 || textHeight < 50;

        if (!isSmallText) continue;

        // Find larger graphics nearby
        for (const graphicsLayer of graphicsLayers) {
            if (!graphicsLayer.bounds) continue;

            const gfxWidth = graphicsLayer.bounds.right - graphicsLayer.bounds.left;
            const gfxHeight = graphicsLayer.bounds.bottom - graphicsLayer.bounds.top;
            const isLargerGraphics = gfxWidth > textWidth * 1.5 || gfxHeight > textHeight * 1.5;

            if (isLargerGraphics) {
                const proximity = calculateProximity(textLayer.bounds, graphicsLayer.bounds);

                if (proximity.distance < 80) {
                    // Small text near larger graphics = likely a label
                    textLayer.signals.push({
                        type: "SMALL_TEXT_NEAR_GRAPHICS",
                        group: "graphics",  // Classify small text as part of graphics
                        weight: 55,
                        reason: `small text near larger graphics (label)`
                    });
                }
            }
        }
    }
}

function calculateProximity(bounds1, bounds2) {
    // Check if bounds overlap
    const overlapsX = bounds1.left < bounds2.right && bounds1.right > bounds2.left;
    const overlapsY = bounds1.top < bounds2.bottom && bounds1.bottom > bounds2.top;
    const overlaps = overlapsX && overlapsY;

    if (overlaps) {
        // Calculate overlap area
        const overlapLeft = Math.max(bounds1.left, bounds2.left);
        const overlapRight = Math.min(bounds1.right, bounds2.right);
        const overlapTop = Math.max(bounds1.top, bounds2.top);
        const overlapBottom = Math.min(bounds1.bottom, bounds2.bottom);
        const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);

        return { overlaps: true, distance: 0, overlapArea };
    }

    // Calculate distance between bounds
    const dx = Math.max(0, Math.max(bounds1.left - bounds2.right, bounds2.left - bounds1.right));
    const dy = Math.max(0, Math.max(bounds1.top - bounds2.bottom, bounds2.top - bounds1.bottom));
    const distance = Math.sqrt(dx * dx + dy * dy);

    return { overlaps: false, distance, overlapArea: 0 };
}

function checkAlignment(bounds1, bounds2) {
    const tolerance = 20; // pixels

    // Center points
    const center1X = (bounds1.left + bounds1.right) / 2;
    const center1Y = (bounds1.top + bounds1.bottom) / 2;
    const center2X = (bounds2.left + bounds2.right) / 2;
    const center2Y = (bounds2.top + bounds2.bottom) / 2;

    // Check horizontal center alignment
    if (Math.abs(center1X - center2X) < tolerance) {
        return { aligned: true, type: "horizontally centered" };
    }

    // Check vertical center alignment
    if (Math.abs(center1Y - center2Y) < tolerance) {
        return { aligned: true, type: "vertically centered" };
    }

    // Check left alignment
    if (Math.abs(bounds1.left - bounds2.left) < tolerance) {
        return { aligned: true, type: "left" };
    }

    // Check right alignment
    if (Math.abs(bounds1.right - bounds2.right) < tolerance) {
        return { aligned: true, type: "right" };
    }

    // Check top alignment
    if (Math.abs(bounds1.top - bounds2.top) < tolerance) {
        return { aligned: true, type: "top" };
    }

    // Check bottom alignment
    if (Math.abs(bounds1.bottom - bounds2.bottom) < tolerance) {
        return { aligned: true, type: "bottom" };
    }

    return { aligned: false, type: null };
}

// =====================================================
// IMAGINARY GUIDE DETECTION
// Find layers that share alignment axes (like designer guides)
// =====================================================

function analyzeImaginaryGuides(layers) {
    const layersWithBounds = layers.filter(l => !l.isGroup && l.bounds);
    if (layersWithBounds.length < 2) return;

    const tolerance = 15; // pixels tolerance for guide alignment

    // Collect all alignment points (edges and centers)
    const horizontalGuides = {}; // Y positions
    const verticalGuides = {};   // X positions

    for (const layer of layersWithBounds) {
        const b = layer.bounds;
        const centerX = Math.round((b.left + b.right) / 2);
        const centerY = Math.round((b.top + b.bottom) / 2);

        // Snap to tolerance grid
        const snapX = (val) => Math.round(val / tolerance) * tolerance;
        const snapY = (val) => Math.round(val / tolerance) * tolerance;

        // Horizontal guides (Y positions)
        [b.top, b.bottom, centerY].forEach(y => {
            const key = snapY(y);
            if (!horizontalGuides[key]) horizontalGuides[key] = [];
            horizontalGuides[key].push(layer);
        });

        // Vertical guides (X positions)
        [b.left, b.right, centerX].forEach(x => {
            const key = snapX(x);
            if (!verticalGuides[key]) verticalGuides[key] = [];
            verticalGuides[key].push(layer);
        });
    }

    // Find significant guides (3+ layers aligned)
    const significantHGuides = Object.entries(horizontalGuides)
        .filter(([_, layers]) => layers.length >= 3);
    const significantVGuides = Object.entries(verticalGuides)
        .filter(([_, layers]) => layers.length >= 3);

    // Boost layers that share significant guides
    for (const [y, alignedLayers] of significantHGuides) {
        const uniqueLayers = [...new Set(alignedLayers)];
        if (uniqueLayers.length >= 3) {
            for (const layer of uniqueLayers) {
                layer.signals.push({
                    type: "IMAGINARY_H_GUIDE",
                    group: "composition",
                    weight: 15,
                    reason: `aligned on horizontal guide with ${uniqueLayers.length - 1} others`
                });

                // If text and graphics share a guide, boost logo classification
                const hasText = uniqueLayers.some(l => l.kind === "text" || l.signals.some(s => s.group === "text"));
                const hasGraphics = uniqueLayers.some(l => l.signals.some(s => s.group === "graphics" || s.group === "logo"));

                if (hasText && hasGraphics && (layer.kind === "text" || layer.signals.some(s => s.group === "graphics"))) {
                    layer.signals.push({
                        type: "GUIDE_TEXT_GRAPHICS_ALIGNED",
                        group: "logo",
                        weight: 35,
                        reason: `text+graphics share horizontal axis`
                    });
                }
            }
        }
    }

    for (const [x, alignedLayers] of significantVGuides) {
        const uniqueLayers = [...new Set(alignedLayers)];
        if (uniqueLayers.length >= 3) {
            for (const layer of uniqueLayers) {
                layer.signals.push({
                    type: "IMAGINARY_V_GUIDE",
                    group: "composition",
                    weight: 15,
                    reason: `aligned on vertical guide with ${uniqueLayers.length - 1} others`
                });

                // If text and graphics share a guide, boost logo classification
                const hasText = uniqueLayers.some(l => l.kind === "text" || l.signals.some(s => s.group === "text"));
                const hasGraphics = uniqueLayers.some(l => l.signals.some(s => s.group === "graphics" || s.group === "logo"));

                if (hasText && hasGraphics && (layer.kind === "text" || layer.signals.some(s => s.group === "graphics"))) {
                    layer.signals.push({
                        type: "GUIDE_TEXT_GRAPHICS_ALIGNED",
                        group: "logo",
                        weight: 35,
                        reason: `text+graphics share vertical axis`
                    });
                }
            }
        }
    }

    // Special case: layers that align on BOTH axes with another layer = strong relationship
    for (let i = 0; i < layersWithBounds.length; i++) {
        const layer1 = layersWithBounds[i];
        for (let j = i + 1; j < layersWithBounds.length; j++) {
            const layer2 = layersWithBounds[j];

            const alignment = checkAlignment(layer1.bounds, layer2.bounds);
            const proximity = calculateProximity(layer1.bounds, layer2.bounds);

            // Check for dual alignment (both horizontal and vertical relationship)
            const hAlign = checkHorizontalRelation(layer1.bounds, layer2.bounds, tolerance);
            const vAlign = checkVerticalRelation(layer1.bounds, layer2.bounds, tolerance);

            if (hAlign && vAlign && proximity.distance < 200) {
                // Dual alignment = strong compositional relationship
                layer1.signals.push({
                    type: "DUAL_AXIS_ALIGNMENT",
                    group: "composition",
                    weight: 25,
                    reason: `aligned on both axes with ${layer2.name}`
                });
                layer2.signals.push({
                    type: "DUAL_AXIS_ALIGNMENT",
                    group: "composition",
                    weight: 25,
                    reason: `aligned on both axes with ${layer1.name}`
                });
            }
        }
    }
}

function checkHorizontalRelation(bounds1, bounds2, tolerance) {
    // Check if any horizontal feature aligns
    const points1 = [bounds1.top, bounds1.bottom, (bounds1.top + bounds1.bottom) / 2];
    const points2 = [bounds2.top, bounds2.bottom, (bounds2.top + bounds2.bottom) / 2];

    for (const p1 of points1) {
        for (const p2 of points2) {
            if (Math.abs(p1 - p2) < tolerance) return true;
        }
    }
    return false;
}

function checkVerticalRelation(bounds1, bounds2, tolerance) {
    // Check if any vertical feature aligns
    const points1 = [bounds1.left, bounds1.right, (bounds1.left + bounds1.right) / 2];
    const points2 = [bounds2.left, bounds2.right, (bounds2.left + bounds2.right) / 2];

    for (const p1 of points1) {
        for (const p2 of points2) {
            if (Math.abs(p1 - p2) < tolerance) return true;
        }
    }
    return false;
}

// =====================================================
// PHASE 4B: CHAOS DETECTION & PROPOSED REORGANIZATION
// Analyze messy groups and suggest better structure
// =====================================================

function detectChaos(layers, byId) {
    const chaos = {
        messyGroups: [],       // Groups with mixed unrelated content
        orphanedTextures: [],  // Textures not in texture groups
        scatteredText: [],     // Small text scattered around
        clippingChains: [],    // Clipping mask chains
        proposedGroups: []     // Suggested new groupings
    };

    // Find all clipping chains
    const processedClipBases = new Set();
    for (const layer of layers) {
        if (layer.isClipped && layer.clippingChainBase && !processedClipBases.has(layer.clippingChainBase)) {
            const baseLayer = byId.get(layer.clippingChainBase);
            if (baseLayer) {
                const chain = {
                    base: baseLayer,
                    clippedLayers: layers.filter(l => l.clippingChainBase === layer.clippingChainBase && l.isClipped),
                    suggestedName: `${baseLayer.name} + clipped`
                };
                chaos.clippingChains.push(chain);
                processedClipBases.add(layer.clippingChainBase);
            }
        }
    }

    // Analyze each group for chaos
    const groups = layers.filter(l => l.isGroup);
    for (const group of groups) {
        const children = layers.filter(l => l.parentId === group.id);
        if (children.length < 2) continue;

        // Count types
        const types = {};
        const textLayers = [];
        const textureLayers = [];
        const graphicsLayers = [];
        const otherLayers = [];

        for (const child of children) {
            const type = child.finalGroup || "unknown";
            types[type] = (types[type] || 0) + 1;

            if (child.isTextLayer || child.kind === "text") textLayers.push(child);
            else if (type === "texture") textureLayers.push(child);
            else if (type === "graphics") graphicsLayers.push(child);
            else otherLayers.push(child);
        }

        const typeCount = Object.keys(types).length;
        const total = children.length;

        // Detect messy groups (3+ different types, no dominant type)
        const maxTypeRatio = Math.max(...Object.values(types)) / total;
        if (typeCount >= 3 && maxTypeRatio < 0.6) {
            chaos.messyGroups.push({
                group: group,
                types: types,
                children: children,
                suggestion: "Consider splitting into subgroups"
            });

            // Propose subgroups
            if (textLayers.length >= 2) {
                chaos.proposedGroups.push({
                    type: "text",
                    name: `${group.name} - Text Elements`,
                    layers: textLayers,
                    parent: group
                });
            }
            if (textureLayers.length >= 2) {
                chaos.proposedGroups.push({
                    type: "texture",
                    name: `${group.name} - Textures`,
                    layers: textureLayers,
                    parent: group
                });
            }
            if (graphicsLayers.length >= 2) {
                chaos.proposedGroups.push({
                    type: "graphics",
                    name: `${group.name} - Graphics`,
                    layers: graphicsLayers,
                    parent: group
                });
            }
        }

        // Find orphaned textures (textures not in a texture-focused group)
        if (textureLayers.length > 0 && textureLayers.length < total * 0.3) {
            for (const tex of textureLayers) {
                chaos.orphanedTextures.push({
                    layer: tex,
                    currentGroup: group,
                    suggestion: "Move to dedicated texture group"
                });
            }
        }

        // Find scattered small text
        const smallText = textLayers.filter(t => t.coveragePercent < 1);
        if (smallText.length >= 2 && smallText.length < total * 0.5) {
            chaos.scatteredText.push({
                layers: smallText,
                currentGroup: group,
                suggestion: "Group small text elements together"
            });
            chaos.proposedGroups.push({
                type: "text-graphics",
                name: `${group.name} - Text Decorations`,
                layers: smallText,
                parent: group
            });
        }
    }

    // Find top-level orphaned textures
    const topLevelTextures = layers.filter(l =>
        l.depth === 0 &&
        !l.isGroup &&
        (l.finalGroup === "texture" || l.signals?.some(s => s.group === "texture"))
    );
    if (topLevelTextures.length >= 2) {
        chaos.proposedGroups.push({
            type: "texture",
            name: "Overlay Textures",
            layers: topLevelTextures,
            parent: null
        });
    }

    return chaos;
}

function buildProposedStructure(layers, chaos) {
    // HIVE-MIND APPROACH: Build hierarchical structure with contextual awareness
    // 1. First pass: Group consecutive same-type layers
    // 2. Second pass: Create super-groups based on document context
    // 3. Third pass: Generate smart names based on content and position
    //
    // GUARDRAILS:
    // - Clipped layers ALWAYS stay with their base
    // - Respect meaningful existing groups (blend modes, masks, effects)
    // - Don't break intentional layer organization

    const proposed = {
        tree: [],
        superGroups: [],
        clippingChains: chaos.clippingChains,
        messyGroups: chaos.messyGroups
    };

    // =========================================
    // GUARDRAIL HELPERS
    // =========================================

    // Build layer→parent lookup for all layers
    const layerById = new Map();
    const layerParentId = new Map(); // layerId → parentId
    for (const layer of layers) {
        layerById.set(layer.id, layer);
        if (layer.parentId !== null && layer.parentId !== undefined) {
            layerParentId.set(layer.id, layer.parentId);
        }
    }

    // Check if a GROUP is meaningful (has intentional design decisions)
    function isGroupMeaningful(groupId) {
        const group = layerById.get(groupId);
        if (!group || !group.isGroup) return false;

        // Has non-normal blend mode = meaningful
        if (group.blendMode && group.blendMode !== "normal" && group.blendMode !== "passThrough") {
            return true;
        }
        // Has layer mask = meaningful
        if (group.hasMask) return true;
        // Has effects/styles = meaningful
        if (group.hasEffects) return true;
        // Has layers clipped TO it = meaningful
        if (chaos.clippingChains.some(c => c.base.id === groupId)) return true;

        return false;
    }

    // Get the meaningful parent group for a layer (if any)
    function getMeaningfulParent(layerId) {
        let currentParentId = layerParentId.get(layerId);
        while (currentParentId !== undefined && currentParentId !== null) {
            if (isGroupMeaningful(currentParentId)) {
                return currentParentId;
            }
            currentParentId = layerParentId.get(currentParentId);
        }
        return null;
    }

    // Mark clipping chain members
    const inClipChain = new Set();
    const clipChainByBase = new Map();
    const clippedToBase = new Map(); // clippedLayerId → baseId (for quick lookup)

    for (const chain of chaos.clippingChains) {
        inClipChain.add(chain.base.id);
        clipChainByBase.set(chain.base.id, chain);
        for (const cl of chain.clippedLayers) {
            inClipChain.add(cl.id);
            clippedToBase.set(cl.id, chain.base.id); // Track which base each clipped layer belongs to
        }
    }

    // Get ALL descendants of a group (recursive) - for finding nested layers
    function getAllGroupDescendants(groupId) {
        const descendants = [];
        const directChildren = layers.filter(l => l.parentId === groupId);

        for (const child of directChildren) {
            if (child.isGroup) {
                // Recurse into subgroups
                descendants.push(...getAllGroupDescendants(child.id));
            } else {
                descendants.push(child.id);
            }
        }
        return descendants;
    }

    // Get only non-group layers in original order
    const orderedLayers = layers.filter(l => !l.isGroup);

    // Track placed layers
    const placed = new Set();

    // =========================================
    // PRE-PASS: Map clipped layers to their base
    // RULE: Clipped layers MUST be grouped WITH their base - never separated
    // =========================================
    const clippedLayerToBase = new Map(); // clipped layer id → base layer id
    const baseToClippedLayers = new Map(); // base layer id → [clipped layer ids]
    const groupBasedClips = []; // Clipped layers whose base is a GROUP

    for (const chain of chaos.clippingChains) {
        baseToClippedLayers.set(chain.base.id, chain.clippedLayers.map(cl => cl.id));
        for (const cl of chain.clippedLayers) {
            clippedLayerToBase.set(cl.id, chain.base.id);
            // Track clipped layers whose base is a GROUP (won't be in orderedLayers)
            if (chain.base.isGroup) {
                groupBasedClips.push({ clipped: cl, baseGroup: chain.base });
            }
        }
    }

    // =========================================
    // PASS 1: Build initial groups (same-type consecutive layers)
    // Clipped layers follow their base - they're grouped together as ONE unit
    // =========================================
    let currentGroup = null;
    const initialGroups = [];

    for (let i = 0; i < orderedLayers.length; i++) {
        const layer = orderedLayers[i];

        if (placed.has(layer.id)) continue;

        // If this is a CLIPPED layer, skip it - it will be added when we process its base
        if (clippedLayerToBase.has(layer.id)) {
            continue;
        }

        const layerType = layer.finalGroup || "unknown";

        // GUARDRAIL: Use DIRECT parent - never merge across parent boundaries
        const directParent = layer.parentId || null;

        // Check if we can merge with current group
        if (currentGroup) {
            const canMerge = canMergeTypes(currentGroup.type, layerType);

            // GUARDRAIL: NEVER merge layers from different parent groups - parent boundary is sacred
            const lastChild = currentGroup.children[currentGroup.children.length - 1];
            const lastDirectParent = lastChild.parentId || null;
            const sameParent = (directParent === lastDirectParent);

            if (canMerge && sameParent) {
                currentGroup.children.push(layer);
                placed.add(layer.id);
                // If this layer is a BASE, add all its clipped layers too
                if (baseToClippedLayers.has(layer.id)) {
                    const clippedIds = baseToClippedLayers.get(layer.id);
                    for (const clId of clippedIds) {
                        const clLayer = layers.find(l => l.id === clId);
                        if (clLayer) {
                            currentGroup.children.push(clLayer);
                            placed.add(clId);
                        }
                    }
                }
                continue;
            } else {
                if (canMerge && !sameParent) {
                    console.log(`  → Not merging "${layer.name}" - different parent group`);
                }
                initialGroups.push(currentGroup);
                currentGroup = null;
            }
        }

        // Start new group
        const groupChildren = [layer];
        placed.add(layer.id);

        // If this layer is a BASE, add all its clipped layers too
        if (baseToClippedLayers.has(layer.id)) {
            const clippedIds = baseToClippedLayers.get(layer.id);
            for (const clId of clippedIds) {
                const clLayer = layers.find(l => l.id === clId);
                if (clLayer) {
                    groupChildren.push(clLayer);
                    placed.add(clId);
                }
            }
        }

        currentGroup = {
            isProposedGroup: true,
            type: layerType,
            children: groupChildren,
            position: i / orderedLayers.length,
            directParentId: directParent // Track the direct parent for this group
        };
    }

    if (currentGroup && currentGroup.children.length > 0) {
        initialGroups.push(currentGroup);
    }

    // FIRST: Handle clipped layers whose base is a GROUP
    // These need to form a proposed group containing: [base GROUP, all clipped layers]
    // MUST preserve original layer order (Rule 1)
    const processedGroupBases = new Set();
    const groupClipProposals = []; // Collect first, insert in correct order later

    for (const { clipped, baseGroup } of groupBasedClips) {
        if (processedGroupBases.has(baseGroup.id)) continue;
        processedGroupBases.add(baseGroup.id);

        // Get ALL layers clipped to this group
        const allClippedToThisGroup = groupBasedClips
            .filter(gc => gc.baseGroup.id === baseGroup.id)
            .map(gc => gc.clipped);

        // RULE 1: Sort children by their original position in the layers array
        const allChildren = [baseGroup, ...allClippedToThisGroup];
        allChildren.sort((a, b) => layers.indexOf(a) - layers.indexOf(b));

        // Determine type by priority
        let bestType = baseGroup.finalGroup || "graphics";
        let bestPriority = 0;
        const TYPE_PRIORITY_CLIP = {
            subject: 100, logo: 80, headline: 70, text: 60,
            graphics: 50, texture: 40, effect: 30, adjustment: 20,
            fill: 15, background: 10, unknown: 0
        };
        for (const child of allChildren) {
            const p = TYPE_PRIORITY_CLIP[child.finalGroup] || 0;
            if (p > bestPriority) {
                bestPriority = p;
                bestType = child.finalGroup;
            }
        }

        // Calculate position based on first child's position in layers array
        const firstChildIdx = layers.indexOf(allChildren[0]);

        groupClipProposals.push({
            isProposedGroup: true,
            isGroupClipChain: true,
            type: bestType,
            children: allChildren,
            position: firstChildIdx / layers.length,
            originalIndex: firstChildIdx, // For sorting
            reason: `Group "${baseGroup.name}" + clipped layers`
        });

        // Mark all as placed
        placed.add(baseGroup.id);
        allClippedToThisGroup.forEach(cl => placed.add(cl.id));
        console.log(`  → Created group for "${baseGroup.name}" + ${allClippedToThisGroup.length} clipped layers`);
    }

    // Insert group-clip proposals at correct positions (by original layer order)
    groupClipProposals.sort((a, b) => a.originalIndex - b.originalIndex);
    for (const proposal of groupClipProposals) {
        // Find correct insertion point based on position
        let insertIdx = 0;
        for (let j = 0; j < initialGroups.length; j++) {
            const grp = initialGroups[j];
            if (grp.children && grp.children[0]) {
                const grpFirstIdx = layers.indexOf(grp.children[0]);
                if (grpFirstIdx < proposal.originalIndex) {
                    insertIdx = j + 1;
                }
            }
        }
        initialGroups.splice(insertIdx, 0, proposal);
    }

    // Add any other missing layers
    for (const layer of orderedLayers) {
        if (!placed.has(layer.id) && !inClipChain.has(layer.id)) {
            initialGroups.push({
                isProposedGroup: true,
                isSingleLayer: true,
                type: layer.finalGroup || "unknown",
                children: [layer],
                position: 0.5
            });
            placed.add(layer.id);
        }
    }

    // =========================================
    // PASS 1.5: Fix group types based on PRIORITY
    // =========================================
    const TYPE_PRIORITY = {
        subject: 100, logo: 80, headline: 70, text: 60,
        graphics: 50, texture: 40, effect: 30, adjustment: 20,
        fill: 15, background: 10, unknown: 0
    };

    for (const group of initialGroups) {
        if (!group.children || group.children.length < 2) continue;
        if (group.isClippingChain) continue;

        let highestPriority = 0;
        let bestType = group.type;

        for (const child of group.children) {
            const childType = child.finalGroup || child.type || "unknown";
            const priority = TYPE_PRIORITY[childType] || 0;
            if (priority > highestPriority) {
                highestPriority = priority;
                bestType = childType;
            }
        }

        if (bestType !== group.type) {
            console.log(`  Group type upgraded: ${group.type} -> ${bestType} (contains ${bestType} layer)`);
            group.type = bestType;
        }
    }

    // =========================================
    // PASS 2: Build super-groups (contextual big groups)
    // =========================================
    const superGroups = buildSuperGroups(initialGroups, layers);

    // =========================================
    // PASS 3: Generate smart names
    // =========================================
    for (const superGroup of superGroups) {
        superGroup.name = generateSuperGroupName(superGroup, layers);

        for (const group of superGroup.children) {
            if (group.isProposedGroup) {
                group.isSingleLayer = group.children.length === 1;
                group.name = generateGroupName(group, superGroup);
                group.reason = group.isSingleLayer ?
                    (group.children[0].reason || group.type) :
                    `${group.children.length} layers`;
            }
        }
    }

    // Flatten for backwards compatibility
    proposed.superGroups = superGroups;
    proposed.tree = flattenSuperGroups(superGroups);

    // Mark single layers
    for (const node of proposed.tree) {
        if (node.isProposedGroup && !node.name) {
            node.isSingleLayer = node.children.length === 1;
            node.name = node.isSingleLayer ?
                node.children[0].name :
                generateGroupName(node, null);
        }
    }

    // =========================================
    // VALIDATION & GUARDRAIL: Ensure all layers accounted for
    // Clipped layers must be with their base, never individual
    // =========================================
    let totalChildren = 0;
    const proposedIds = new Set();
    for (const node of proposed.tree) {
        if (node.children) {
            for (const child of node.children) {
                if (child.id) proposedIds.add(child.id);
                totalChildren++;
            }
        }
    }

    const missing = orderedLayers.filter(l => !proposedIds.has(l.id));
    if (missing.length > 0) {
        console.warn(`  ⚠ Missing ${missing.length} layers, recovering...`);

        for (const ml of missing) {
            // GUARDRAIL: Clipped layers go with their base, NEVER individual
            if (ml.isClipped) {
                const baseId = clippedToBase.get(ml.id);
                if (baseId) {
                    const baseLayer = layerById.get(baseId);
                    let addedToBase = false;

                    // Case 1: Base is a regular layer - find it in proposed structure
                    for (const node of proposed.tree) {
                        if (node.children && node.children.some(c => c.id === baseId)) {
                            node.children.push(ml);
                            proposedIds.add(ml.id);
                            addedToBase = true;
                            console.log(`    → Added clipped "${ml.name}" to its base layer group`);
                            break;
                        }
                    }

                    // Case 2: Base is a GROUP - find layers from that group in proposed structure
                    // Use recursive search to find ALL descendants (handles deeply nested groups)
                    if (!addedToBase && baseLayer && baseLayer.isGroup) {
                        // Get ALL descendants of the group base (not just direct children)
                        const groupDescendantIds = getAllGroupDescendants(baseId);

                        for (const node of proposed.tree) {
                            if (node.children && node.children.some(c => groupDescendantIds.includes(c.id))) {
                                node.children.push(ml);
                                proposedIds.add(ml.id);
                                addedToBase = true;
                                console.log(`    → Added clipped "${ml.name}" to group containing its base's descendants`);
                                break;
                            }
                        }
                    }

                    if (!addedToBase) {
                        // Last resort: create a new group for this clipped layer with context
                        console.warn(`    ⚠ Clipped "${ml.name}" - adding with its base context`);
                        proposed.tree.push({
                            isProposedGroup: true,
                            isSingleLayer: true,
                            type: ml.finalGroup || "unknown",
                            name: ml.name + " (clipped)",
                            children: [ml],
                            isOrphanedClip: true
                        });
                        proposedIds.add(ml.id);
                    }
                } else {
                    console.warn(`    ⚠ Clipped layer "${ml.name}" has no tracked base`);
                }
            } else {
                // Non-clipped layer - can add as individual
                proposed.tree.push({
                    isProposedGroup: true,
                    isSingleLayer: true,
                    type: ml.finalGroup || "unknown",
                    name: ml.name,
                    children: [ml]
                });
                proposedIds.add(ml.id);
                console.log(`    → Added individual "${ml.name}" (${ml.finalGroup})`);
            }
        }
    }

    // Remove empty proposed groups
    proposed.tree = proposed.tree.filter(node => !node.children || node.children.length > 0);

    // Recalculate isSingleLayer after recovery (clipped layers may have been added)
    for (const node of proposed.tree) {
        if (node.isProposedGroup && node.children) {
            node.isSingleLayer = node.children.length === 1;
        }
    }

    // BIAS: Last group should be background (bottom of layer stack = background)
    if (proposed.tree.length > 0) {
        const lastGroup = proposed.tree[proposed.tree.length - 1];
        const lastType = lastGroup.primaryType || lastGroup.finalGroup;

        // If last group isn't already background, check if it SHOULD be
        if (lastType !== "background") {
            // Check if last group contains full-coverage layers or has bg-like properties
            const hasFullCoverage = lastGroup.children?.some(c =>
                (c.coveragePercent || 0) > 85 || c.finalGroup === "background" || c.finalGroup === "fill"
            );
            const isTextureOrFill = ["texture", "fill", "graphics"].includes(lastType);

            if (hasFullCoverage || isTextureOrFill) {
                console.log(`  BIAS: Promoting last group "${lastGroup.name}" (${lastType}) to BACKGROUND`);
                lastGroup.primaryType = "background";
                lastGroup.finalGroup = "background";
                lastGroup.name = "BACKGROUND";
                // Update children classification too
                if (lastGroup.children) {
                    for (const child of lastGroup.children) {
                        if (child.finalGroup === "texture" || child.finalGroup === "fill" || child.finalGroup === "graphics") {
                            child.originalGroup = child.finalGroup;
                            child.finalGroup = "background";
                        }
                    }
                }
            }
        }
    }

    // FINAL STEP: Collapse similar groups into mega-groups
    proposed.tree = collapseSimilarGroups(proposed.tree);

    // NOTE: Same-named group merging moved to post-commit batchPlay step (mergeConsecutiveSameNamedGroups)
    // This ensures it operates on the actual document after all other changes

    // HIVE-MIND STEP: Organize loose same-type layers into subfolders within parent groups
    proposed.tree = organizeLooseLayersIntoSubfolders(proposed.tree, layers, clippedLayerToBase);

    // Final count
    let finalCount = 0;
    for (const node of proposed.tree) {
        if (node.children) finalCount += node.children.length;
        // Count nested mega-group children too
        if (node.isMegaGroup && node.children) {
            for (const child of node.children) {
                if (child.children) finalCount += child.children.length;
            }
        }
    }
    console.log(`  Proposed structure: ${proposed.tree.length} groups, ${finalCount} layers (of ${orderedLayers.length} total)`);

    return proposed;
}

// =========================================
// SUPER-GROUP BUILDING (Hive-Mind Contextual Grouping)
// =========================================

function buildSuperGroups(groups, allLayers) {
    // Analyze document context
    const hasSubject = groups.some(g => g.type === "subject");
    const hasBackground = groups.some(g => g.type === "background");
    const textCount = groups.filter(g => g.type === "text" || g.type === "headline").length;
    const graphicsCount = groups.filter(g => g.type === "graphics" || g.type === "logo").length;

    // Define super-group categories and what belongs in them
    const superGroupDefs = [
        {
            id: "foreground_effects",
            types: ["adjustment", "effect"],
            name: "EFFECTS",
            priority: 1,
            positionHint: "top" // Usually at top of layer stack
        },
        {
            id: "subject_area",
            types: ["subject"],
            relatedTypes: ["adjustment", "effect", "graphics"], // Can include related layers
            name: "SUBJECT",
            priority: 2,
            positionHint: "middle"
        },
        {
            id: "text_area",
            types: ["text", "headline", "caption"],
            name: "TEXT",
            priority: 3,
            positionHint: "any"
        },
        {
            id: "graphics_area",
            types: ["graphics", "logo"],
            name: "GRAPHICS",
            priority: 4,
            positionHint: "any"
        },
        {
            id: "texture_area",
            types: ["texture"],
            name: "TEXTURES",
            priority: 5,
            positionHint: "any"
        },
        {
            id: "background_area",
            types: ["background", "fill"],
            relatedTypes: ["texture", "adjustment"],
            name: "BACKGROUND",
            priority: 6,
            positionHint: "bottom"
        }
    ];

    // Build super-groups by scanning groups in order
    const superGroups = [];
    const assigned = new Set();

    // Strategy: Walk through groups and create super-groups for runs of related types
    let currentSuper = null;

    // Priority for type selection (subject wins)
    const TYPE_PRIORITY = {
        subject: 100, logo: 80, headline: 70, text: 60,
        graphics: 50, texture: 40, effect: 30, adjustment: 20,
        fill: 15, background: 10, unknown: 0
    };

    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const groupType = group.type;

        // Find which super-group category this belongs to
        let matchedDef = superGroupDefs.find(def => def.types.includes(groupType));

        if (!matchedDef) {
            matchedDef = { id: "other", types: [groupType], name: "OTHER", priority: 10 };
        }

        // GUARDRAIL: Get the parent of the first child layer in this group
        const groupParent = group.children && group.children[0] ? (group.children[0].parentId || null) : null;
        const currentSuperParent = currentSuper && currentSuper.children[0] && currentSuper.children[0].children && currentSuper.children[0].children[0]
            ? (currentSuper.children[0].children[0].parentId || null)
            : null;
        const sameParentBoundary = (groupParent === currentSuperParent);

        // Check if we should continue current super-group or start new one
        // NEVER merge across parent boundaries
        const shouldContinue = currentSuper && sameParentBoundary && (
            currentSuper.defId === matchedDef.id ||
            (currentSuper.def.relatedTypes && currentSuper.def.relatedTypes.includes(groupType)) ||
            (matchedDef.relatedTypes && matchedDef.relatedTypes.includes(currentSuper.primaryType))
        );

        if (shouldContinue) {
            currentSuper.children.push(group);
            assigned.add(i);

            // Update primaryType if this group has higher priority (subject wins!)
            const currentPriority = TYPE_PRIORITY[currentSuper.primaryType] || 0;
            const newPriority = TYPE_PRIORITY[groupType] || 0;
            if (newPriority > currentPriority) {
                currentSuper.primaryType = groupType;
                // Also update defId if we're switching to subject
                if (groupType === "subject") {
                    currentSuper.defId = "subject_area";
                    currentSuper.def = superGroupDefs.find(d => d.id === "subject_area");
                }
            }
        } else {
            // Close current and start new
            if (currentSuper && currentSuper.children.length > 0) {
                superGroups.push(currentSuper);
            }

            currentSuper = {
                isSuperGroup: true,
                defId: matchedDef.id,
                def: matchedDef,
                primaryType: groupType,
                children: [group],
                position: group.position || 0.5
            };
            assigned.add(i);
        }
    }

    // Don't forget last super-group
    if (currentSuper && currentSuper.children.length > 0) {
        superGroups.push(currentSuper);
    }

    // Merge small super-groups of same type that are nearby
    return mergeSimilarSuperGroups(superGroups);
}

function mergeSimilarSuperGroups(superGroups) {
    // If we have multiple super-groups of same type, consider merging if they make sense
    // CRITICAL: Never merge across parent boundaries
    const merged = [];

    // Helper to get the parent of a super-group's first child's first layer
    function getSuperGroupParent(sg) {
        if (sg.children && sg.children[0] && sg.children[0].children && sg.children[0].children[0]) {
            return sg.children[0].children[0].parentId || null;
        }
        return null;
    }

    for (const sg of superGroups) {
        const lastMerged = merged[merged.length - 1];
        const sgParent = getSuperGroupParent(sg);
        const lastParent = lastMerged ? getSuperGroupParent(lastMerged) : null;

        // Check if we should merge with previous - ONLY if same parent
        const sameParent = (sgParent === lastParent);
        const shouldMerge = lastMerged &&
            sameParent &&
            lastMerged.defId === sg.defId &&
            sg.children.length <= 2 &&
            lastMerged.children.length <= 3;

        if (shouldMerge) {
            lastMerged.children.push(...sg.children);
        } else {
            merged.push(sg);
        }
    }

    return merged;
}

// FINAL COLLAPSE: Merge similar groups in the tree into mega-groups
// ONLY merge groups that share the same direct parent - NEVER across parent boundaries
function collapseSimilarGroups(tree) {
    if (tree.length <= 3) return tree; // Don't collapse if already small

    // Get the direct parent ID of a node's first child layer
    function getNodeParent(node) {
        if (node.children && node.children[0]) {
            return node.children[0].parentId || null;
        }
        return null;
    }

    // Group nodes by their primary type AND parent
    const byTypeAndParent = {};
    for (const node of tree) {
        const type = node.primaryType || node.finalGroup || "other";
        const parent = getNodeParent(node);
        const key = `${type}::${parent}`;
        if (!byTypeAndParent[key]) byTypeAndParent[key] = [];
        byTypeAndParent[key].push(node);
    }

    const collapsed = [];
    const handled = new Set();

    // Types that should be collapsed if multiple exist
    const collapsibleTypes = ["texture", "graphics", "effect", "adjustment", "fill"];

    for (const [key, nodes] of Object.entries(byTypeAndParent)) {
        const [type, parent] = key.split("::");

        // Only collapse if it's a collapsible type AND there are 2+ nodes with SAME parent
        if (collapsibleTypes.includes(type) && nodes.length >= 2) {
            // Create mega-group for this type (within same parent only)
            const megaGroup = {
                isMegaGroup: true,
                isProposedGroup: true,
                name: getMegaGroupName(type),
                primaryType: type,
                finalGroup: type,
                children: nodes,
                directParentId: parent === "null" ? null : parent,
                position: nodes.reduce((sum, n) => sum + (n.position || 0.5), 0) / nodes.length
            };
            collapsed.push(megaGroup);
            nodes.forEach(n => handled.add(n));
            console.log(`  MEGA-GROUP: Collapsed ${nodes.length} ${type} groups (same parent) into "${megaGroup.name}"`);
        }
    }

    // Add remaining nodes that weren't collapsed
    for (const node of tree) {
        if (!handled.has(node)) {
            collapsed.push(node);
        }
    }

    // Sort by position (maintain layer order)
    collapsed.sort((a, b) => (b.position || 0.5) - (a.position || 0.5));

    return collapsed;
}

function getMegaGroupName(type) {
    const names = {
        texture: "TEXTURES & OVERLAYS",
        graphics: "GRAPHIC ELEMENTS",
        effect: "EFFECTS & FILTERS",
        adjustment: "COLOR ADJUSTMENTS",
        fill: "FILLS & LIGHTING",
        subject: "SUBJECTS",
        text: "TEXT LAYERS",
        background: "BACKGROUNDS"
    };
    return names[type] || type.toUpperCase();
}

// =========================================
// HIVE-MIND: MERGE CONSECUTIVE SAME-NAMED GROUPS ONLY
// =========================================
// RULE 1 PROTECTION: Only merges groups that are DIRECTLY NEXT TO EACH OTHER
// - If groups aren't consecutive in the tree, they stay separate
// - This preserves layer order by only combining adjacent sequences
function mergeSameNamedSiblingGroups(tree, allLayers) {
    console.log("  HIVE-MIND: Checking for consecutive same-named groups...");

    if (!tree || tree.length < 2) return tree;

    const result = [];
    let i = 0;

    while (i < tree.length) {
        const currentNode = tree[i];
        const currentName = (currentNode.name || "").toUpperCase().trim();

        // Skip special structures
        if (!currentName || currentNode.isMegaGroup || currentNode.isProposedSubfolder) {
            result.push(currentNode);
            i++;
            continue;
        }

        // Look for CONSECUTIVE nodes with same name
        const consecutiveNodes = [currentNode];
        let j = i + 1;

        while (j < tree.length) {
            const nextNode = tree[j];
            const nextName = (nextNode.name || "").toUpperCase().trim();

            if (nextName === currentName && !nextNode.isMegaGroup && !nextNode.isProposedSubfolder) {
                consecutiveNodes.push(nextNode);
                j++;
            } else {
                break; // Not consecutive - stop
            }
        }

        if (consecutiveNodes.length >= 2) {
            console.log(`    Merging ${consecutiveNodes.length} consecutive "${currentName}" groups`);

            const allChildren = [];
            let primaryType = null;

            for (const node of consecutiveNodes) {
                if (node.children) {
                    allChildren.push(...node.children);
                }
                if (!primaryType) {
                    primaryType = node.type || node.primaryType || node.finalGroup;
                }
            }

            const mergedGroup = {
                isProposedGroup: true,
                isMergedGroup: true,
                name: consecutiveNodes[0].name,
                type: primaryType,
                primaryType: primaryType,
                finalGroup: primaryType,
                children: allChildren,
                position: consecutiveNodes[0].position || 0.5,
                mergedFrom: consecutiveNodes.length
            };

            result.push(mergedGroup);
            console.log(`      → Merged ${allChildren.length} children`);
            i = j;
        } else {
            result.push(currentNode);
            i++;
        }
    }

    return result;
}

// =========================================
// HIVE-MIND: WITHIN-PARENT SUBFOLDER ORGANIZATION
// =========================================
// This function looks INSIDE existing parent groups and organizes
// loose same-type non-clipped layers into subfolders.
// Example: Within "SUBJECT" group, loose graphics layers get grouped into "GRAPHIC ELEMENTS" subfolder
// RULES:
// - Only affects non-clipped layers (clipped layers stay with their base)
// - Only creates subfolders if 2+ same-type layers exist within the same parent
// - Preserves layer order (Rule 1)
// - Respects parent boundaries (never moves layers out of their parent)
function organizeLooseLayersIntoSubfolders(tree, allLayers, clippedLayerToBase) {
    console.log("  HIVE-MIND: Organizing loose layers into subfolders within parent groups...");

    // Build lookup for which layers are clipped (they can't be reorganized)
    const isClippedLayer = new Set();
    if (clippedLayerToBase) {
        for (const [clippedId] of clippedLayerToBase) {
            isClippedLayer.add(clippedId);
        }
    }

    // Process each node in the tree
    for (const node of tree) {
        if (!node.children || node.children.length < 2) continue;

        // Get the parent context of this node's children
        const firstChild = node.children[0];
        const parentId = firstChild.parentId || null;

        // Find loose (non-clipped) children grouped by their classification type
        const looseByType = new Map();
        const clippedOrSpecial = []; // Layers that can't be reorganized

        for (const child of node.children) {
            // Skip if this layer is clipped to something
            if (isClippedLayer.has(child.id)) {
                clippedOrSpecial.push(child);
                continue;
            }

            // Skip if this layer HAS clipped content (it's a clipping base)
            if (child.hasClippedLayers || child.hasClippedContent) {
                clippedOrSpecial.push(child);
                continue;
            }

            // Skip groups - they're already organized
            if (child.isGroup) {
                clippedOrSpecial.push(child);
                continue;
            }

            // Group loose layers by their finalGroup type
            const type = child.finalGroup || "unknown";
            if (!looseByType.has(type)) {
                looseByType.set(type, []);
            }
            looseByType.get(type).push(child);
        }

        const organizableTypes = ["graphics", "texture", "effect", "adjustment", "fill"];
        const typesToOrganize = [];

        for (const [type, layers] of looseByType) {
            if (organizableTypes.includes(type) && layers.length >= 2) {
                typesToOrganize.push({ type, layers });
            }
        }

        // If no types need organization, skip this node
        if (typesToOrganize.length === 0) continue;

        // Create subfolders for each type that needs organization
        const newChildren = [];
        const organizedLayerIds = new Set();

        for (const { type, layers } of typesToOrganize) {
            // Sort layers by their original order in the document
            layers.sort((a, b) => {
                const idxA = allLayers.findIndex(l => l.id === a.id);
                const idxB = allLayers.findIndex(l => l.id === b.id);
                return idxA - idxB;
            });

            // Create a subfolder for these layers
            const subfolder = {
                isProposedSubfolder: true,
                isProposedGroup: true,
                type: type,
                primaryType: type,
                finalGroup: type,
                name: getMegaGroupName(type),
                children: layers,
                parentContext: parentId,
                reason: `${layers.length} loose ${type} layers organized`
            };

            newChildren.push(subfolder);
            layers.forEach(l => organizedLayerIds.add(l.id));

            console.log(`    → Created subfolder "${subfolder.name}" with ${layers.length} layers inside "${node.name || 'unnamed'}"`);
        }

        // Add layers that weren't organized (clipped, special, or types without enough layers)
        for (const child of node.children) {
            if (!organizedLayerIds.has(child.id)) {
                newChildren.push(child);
            }
        }

        // Sort newChildren to maintain original layer order
        // Subfolders are positioned based on their first child's position
        newChildren.sort((a, b) => {
            const getFirstLayerIndex = (item) => {
                if (item.isProposedSubfolder && item.children && item.children[0]) {
                    return allLayers.findIndex(l => l.id === item.children[0].id);
                }
                return allLayers.findIndex(l => l.id === item.id);
            };
            return getFirstLayerIndex(a) - getFirstLayerIndex(b);
        });

        // Replace node's children with the reorganized list
        node.children = newChildren;
        node.hasSubfolders = true;
    }

    return tree;
}

function flattenSuperGroups(superGroups) {
    // Flatten super-groups into a linear tree for commit
    // CRITICAL: Never merge children from different parent groups
    const tree = [];

    // Priority for determining group type (subject wins)
    const TYPE_PRIORITY = {
        subject: 100, logo: 80, headline: 70, text: 60,
        graphics: 50, texture: 40, effect: 30, adjustment: 20,
        fill: 15, background: 10, unknown: 0
    };

    // Helper to get the parent of a group's first child
    function getGroupParent(group) {
        if (group.children && group.children[0]) {
            return group.children[0].parentId || null;
        }
        return null;
    }

    for (const sg of superGroups) {
        if (sg.children.length === 1 && sg.children[0].isSingleLayer) {
            // Single layer - use super-group name or type-based name, not layer name
            const singleLayer = sg.children[0];
            if (sg.name && sg.name.trim() !== "") {
                singleLayer.name = sg.name;
            } else {
                // Generate name from type
                const typeNames = {
                    logo: "LOGO", subject: "SUBJECT", background: "BACKGROUND",
                    text: "TEXT", headline: "HEADLINE", graphics: "GRAPHICS",
                    texture: "TEXTURE", adjustment: "ADJUSTMENTS", effect: "EFFECTS"
                };
                singleLayer.name = typeNames[singleLayer.type] || singleLayer.type.toUpperCase();
            }
            tree.push(singleLayer);
        } else if (sg.children.length === 1) {
            // Single group inside super-group - use the super-group name
            const group = sg.children[0];
            group.superGroupName = sg.name;
            // Use super-group name as primary name (e.g., "LOGOS & GRAPHICS")
            if (sg.name && sg.name.trim() !== "") {
                group.name = sg.name;
            }
            tree.push(group);
        } else {
            // Multiple groups - ONLY merge if they share the same parent
            // Group the children by their parent first
            const childrenByParent = new Map();
            for (const group of sg.children) {
                const parentId = getGroupParent(group) || 'root';
                if (!childrenByParent.has(parentId)) {
                    childrenByParent.set(parentId, []);
                }
                childrenByParent.get(parentId).push(group);
            }

            // Create separate tree entries for each parent group
            for (const [parentId, groups] of childrenByParent) {
                const allChildren = groups.flatMap(g => g.children);
                let bestType = sg.primaryType;
                let highestPriority = TYPE_PRIORITY[bestType] || 0;

                for (const child of allChildren) {
                    const childType = child.finalGroup || child.type || "unknown";
                    const priority = TYPE_PRIORITY[childType] || 0;
                    if (priority > highestPriority) {
                        highestPriority = priority;
                        bestType = childType;
                    }
                }

                if (groups.length === 1 && groups[0].isSingleLayer) {
                    // Single layer in this parent context
                    groups[0].name = sg.name || groups[0].name;
                    tree.push(groups[0]);
                } else {
                    tree.push({
                        isSuperGroup: true,
                        isProposedGroup: true,
                        name: sg.name,
                        type: bestType,
                        children: allChildren,
                        subGroups: groups,
                        directParentId: parentId === 'root' ? null : parentId,
                        reason: `${groups.length} sub-groups (same parent)`
                    });
                }
            }
        }
    }

    return tree;
}

// =========================================
// SMART NAMING FUNCTIONS
// =========================================

function generateClipChainName(chain) {
    const baseName = chain.base.name;
    const baseType = chain.base.finalGroup;
    const clippedTypes = chain.clippedLayers.map(l => l.finalGroup);

    // Analyze what's clipped
    const hasAdjustments = clippedTypes.includes("adjustment");
    const hasTextures = clippedTypes.includes("texture");
    const hasEffects = clippedTypes.some(t => ["effect", "graphics"].includes(t));

    // Generate contextual name
    if (baseType === "subject") {
        if (hasAdjustments && hasTextures) return "Subject + Effects & Texture";
        if (hasAdjustments) return "Subject + Color Adjustments";
        if (hasTextures) return "Subject + Texture Overlay";
        return "Subject + Masks";
    }

    if (baseType === "background") {
        if (hasTextures) return "Background + Texture";
        if (hasAdjustments) return "Background + Adjustments";
        return "Background + Overlays";
    }

    if (baseType === "text" || baseType === "headline") {
        return `${cleanLayerName(baseName)} + Effects`;
    }

    // Default: use cleaned base name
    return `${cleanLayerName(baseName)} [Clipped]`;
}

function generateSuperGroupName(superGroup, allLayers) {
    const def = superGroup.def;
    const children = superGroup.children;
    const childTypes = children.map(c => c.type);

    // Analyze position in document
    const position = superGroup.position;
    const isTop = position > 0.7;
    const isBottom = position < 0.3;

    // Count by type for context
    const typeCount = {};
    for (const type of childTypes) {
        typeCount[type] = (typeCount[type] || 0) + 1;
    }

    // Generate name based on content
    switch (def.id) {
        case "foreground_effects":
            return "OVERLAY EFFECTS";

        case "subject_area":
            if (children.some(c => c.isClippingChain)) {
                return "SUBJECT COMPOSITE";
            }
            return "SUBJECT";

        case "text_area":
            if (childTypes.includes("headline")) {
                return "HEADLINES & TEXT";
            }
            if (children.length > 3) {
                return "TEXT ELEMENTS";
            }
            return "TEXT";

        case "graphics_area":
            if (childTypes.includes("logo")) {
                return "LOGOS & GRAPHICS";
            }
            return "GRAPHIC ELEMENTS";

        case "texture_area":
            if (isTop) return "OVERLAY TEXTURES";
            if (isBottom) return "BASE TEXTURES";
            return "TEXTURES";

        case "background_area":
            if (children.some(c => c.type === "fill")) {
                return "BACKGROUND & FILLS";
            }
            return "BACKGROUND";

        default:
            return "ELEMENTS";
    }
}

function generateGroupName(group, superGroup) {
    const children = group.children;
    const type = group.type;
    const isSingle = children.length === 1;

    if (isSingle) {
        // Single layer - use cleaned layer name
        return cleanLayerName(children[0].name);
    }

    // Multiple layers - analyze content for smart name
    const names = children.map(c => c.name.toLowerCase());
    const position = group.position || 0.5;
    const childTypes = children.map(c => c.finalGroup || c.type);

    // PRIORITY: If group contains a subject, name should reflect that
    const hasSubject = childTypes.includes("subject");
    const subjectLayer = hasSubject ? children.find(c => (c.finalGroup || c.type) === "subject") : null;

    if (hasSubject && subjectLayer) {
        // Count what else is in the group
        const hasAdjustments = childTypes.includes("adjustment");
        const hasTextures = childTypes.includes("texture");
        const hasEffects = childTypes.includes("effect");
        const hasGraphics = childTypes.includes("graphics");

        // Use subject's name as base
        const subjectName = cleanLayerName(subjectLayer.name);

        if (hasAdjustments && hasTextures) {
            return `${subjectName} + Effects`;
        }
        if (hasAdjustments) {
            return `${subjectName} + Adjustments`;
        }
        if (hasTextures) {
            return `${subjectName} + Texture`;
        }
        if (hasEffects || hasGraphics) {
            return `${subjectName} + Elements`;
        }
        return `${subjectName} Composite`;
    }

    // Look for common patterns in names
    const commonWords = findCommonWords(names);

    // Check for contextual hints from holistic analysis
    const hasAlignedText = children.some(c => c.textAlignment);
    const hasBannerElements = children.some(c => c.isEdgeBanner);
    const hasCornerElements = children.some(c => c.cornerPosition);
    const hasNearbyPairs = children.some(c => c.nearbyText || c.nearbyGraphic);

    // Type-specific naming with contextual awareness
    switch (type) {
        case "adjustment":
            if (names.some(n => n.includes("color") || n.includes("hue"))) {
                return "Color Adjustments";
            }
            if (names.some(n => n.includes("level") || n.includes("curve"))) {
                return "Tonal Adjustments";
            }
            return "Adjustments";

        case "texture":
            if (names.some(n => n.includes("noise") || n.includes("grain"))) {
                return "Grain & Noise";
            }
            if (names.some(n => n.includes("overlay"))) {
                return "Texture Overlays";
            }
            if (commonWords.length > 0) {
                return `${capitalizeFirst(commonWords[0])} Textures`;
            }
            return "Textures";

        case "text":
        case "headline":
            // Check for aligned text patterns
            if (hasAlignedText) {
                const alignedChildren = children.filter(c => c.textAlignment);
                if (alignedChildren.some(c => c.textAlignment === "horizontal")) {
                    // Horizontally aligned text - likely header row or footer
                    if (hasBannerElements) {
                        const bannerPos = children.find(c => c.bannerPosition)?.bannerPosition;
                        if (bannerPos === "top") return "Header Text";
                        if (bannerPos === "bottom") return "Footer Text";
                    }
                    return "Text Row";
                }
                if (alignedChildren.some(c => c.textAlignment === "vertical")) {
                    return "Text Column";
                }
            }
            if (names.some(n => n.includes("title") || n.includes("headline"))) {
                return "Headlines";
            }
            if (names.some(n => n.includes("name"))) {
                return "Player Names";
            }
            if (names.some(n => n.includes("stat") || n.includes("number"))) {
                return "Stats & Numbers";
            }
            if (commonWords.length > 0) {
                return `${capitalizeFirst(commonWords[0])} Text`;
            }
            return "Text Elements";

        case "graphics":
            // Check for corner elements (likely icons/badges)
            if (hasCornerElements) {
                return "Corner Elements";
            }
            // Check if paired with text (logo+text combo)
            if (hasNearbyPairs) {
                return "Logo & Text";
            }
            if (names.some(n => n.includes("line") || n.includes("stroke"))) {
                return "Lines & Strokes";
            }
            if (names.some(n => n.includes("shape"))) {
                return "Shapes";
            }
            if (names.some(n => n.includes("icon"))) {
                return "Icons";
            }
            return "Graphics";

        case "logo":
            if (hasCornerElements) {
                return "Corner Logos";
            }
            if (names.some(n => n.includes("team"))) {
                return "Team Logos";
            }
            if (names.some(n => n.includes("sponsor"))) {
                return "Sponsor Logos";
            }
            return "Logos";

        case "subject":
            if (children.length > 1) {
                return "Subject Layers";
            }
            return "Subject";

        case "background":
            if (position < 0.2) {
                return "Base Background";
            }
            return "Background";

        case "fill":
            if (names.some(n => n.includes("gradient"))) {
                return "Gradients";
            }
            return "Solid Fills";

        default:
            if (commonWords.length > 0) {
                return capitalizeFirst(commonWords[0]);
            }
            return "Elements";
    }
}

function cleanLayerName(name) {
    // Remove common prefixes/suffixes and clean up
    let cleaned = name
        .replace(/^(copy|layer|group)\s*/i, "")
        .replace(/\s*(copy|\d+)$/i, "")
        .replace(/_/g, " ")
        .trim();

    // Capitalize first letter
    if (cleaned.length > 0) {
        cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }

    return cleaned || name;
}

function findCommonWords(names) {
    // Find words that appear in multiple layer names
    const wordCounts = {};
    const stopWords = new Set(["layer", "copy", "the", "and", "or", "a", "an", "of", "to", "1", "2", "3"]);

    for (const name of names) {
        const words = name.split(/[\s_-]+/).filter(w => w.length > 2 && !stopWords.has(w));
        const seen = new Set();
        for (const word of words) {
            if (!seen.has(word)) {
                wordCounts[word] = (wordCounts[word] || 0) + 1;
                seen.add(word);
            }
        }
    }

    // Return words that appear in at least 2 names
    return Object.entries(wordCounts)
        .filter(([word, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([word]) => word);
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function canMergeTypes(type1, type2) {
    // Define which types can be merged into the same group
    const mergeable = {
        text: ["text", "headline", "caption"],
        headline: ["text", "headline", "caption"],
        caption: ["text", "headline", "caption"],
        graphics: ["graphics", "logo"],
        logo: ["graphics", "logo"],
        texture: ["texture"],
        adjustment: ["adjustment", "effect"],
        effect: ["adjustment", "effect"],
        background: ["background"],
        fill: ["fill"],
        subject: ["subject"]
    };

    const allowed = mergeable[type1] || [type1];
    return allowed.includes(type2);
}

function buildSpatialClusters(tree) {
    // Identify clusters of same-type groups that are adjacent
    const clusters = [];
    let currentCluster = null;

    for (const node of tree) {
        if (node.isClippingChain) {
            // Clipping chains break clusters
            if (currentCluster && currentCluster.items.length > 1) {
                clusters.push(currentCluster);
            }
            currentCluster = null;
            continue;
        }

        const nodeType = node.type;

        if (currentCluster && currentCluster.type === nodeType) {
            // Same type, add to cluster
            currentCluster.items.push(node);
            currentCluster.totalLayers += node.children.length;
        } else {
            // Different type, close current cluster and start new
            if (currentCluster && currentCluster.items.length > 1) {
                clusters.push(currentCluster);
            }
            currentCluster = {
                type: nodeType,
                items: [node],
                totalLayers: node.children.length
            };
        }
    }

    // Don't forget last cluster
    if (currentCluster && currentCluster.items.length > 1) {
        clusters.push(currentCluster);
    }

    return clusters;
}

// =====================================================
// UNLOCK BACKGROUND LAYER
// =====================================================

async function unlockBackgroundLayer(doc) {
    // Photoshop's locked "Background" layer prevents operations on it
    // Check if it exists and convert it to a normal layer
    const layers = doc.layers;
    let bgLayer = null;

    for (const layer of layers) {
        if (layer.isBackgroundLayer) {
            bgLayer = layer;
            break;
        }
    }

    if (!bgLayer) return false;

    console.log(`  Found locked Background layer: "${bgLayer.name}" - unlocking...`);

    try {
        await action.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "layer", _property: "background" }],
            to: { _obj: "layer" },
            _options: { dialogOptions: "dontDisplay" }
        }], {});

        console.log("  Background layer unlocked");
        return true;
    } catch (e) {
        console.warn(`  Could not unlock background layer: ${e.message}`);
        return false;
    }
}

// =====================================================
// DELETE HIDDEN LAYERS
// =====================================================

async function deleteHiddenLayers() {
    const doc = app.activeDocument;
    if (!doc) {
        return { success: false, message: "No active document" };
    }

    console.log("\n========== DELETING HIDDEN LAYERS ==========\n");

    // Collect all hidden layers (recursive)
    const hiddenLayers = [];

    function findHiddenLayers(layers) {
        for (const layer of layers) {
            if (!layer.visible) {
                hiddenLayers.push({ id: layer.id, name: layer.name });
            }
            // Recurse into groups even if hidden (to count nested hidden layers)
            if (layer.layers && layer.layers.length > 0) {
                findHiddenLayers(layer.layers);
            }
        }
    }

    findHiddenLayers(doc.layers);

    if (hiddenLayers.length === 0) {
        console.log("  No hidden layers found");
        return { success: true, message: "No hidden layers found", deletedCount: 0 };
    }

    console.log(`  Found ${hiddenLayers.length} hidden layers`);

    let deleted = 0;
    let failed = 0;

    // Delete in reverse order (deepest first to avoid parent reference issues)
    for (let i = hiddenLayers.length - 1; i >= 0; i--) {
        const layer = hiddenLayers[i];
        try {
            await action.batchPlay([{
                _obj: "delete",
                _target: [{ _ref: "layer", _id: layer.id }],
                _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });

            console.log(`    ✓ Deleted "${layer.name}"`);
            deleted++;
        } catch (e) {
            console.warn(`    ⚠ Could not delete "${layer.name}": ${e.message}`);
            failed++;
        }
    }

    const msg = `Deleted ${deleted} hidden layers${failed > 0 ? `, ${failed} failed` : ''}`;
    console.log(`\n========== ${msg} ==========\n`);

    return { success: failed === 0, message: msg, deletedCount: deleted, failedCount: failed };
}

// =====================================================
// HIVE-MIND: EXTRACT SUBFOLDERS FOR NESTED COMMIT
// =====================================================
// This function extracts subfolders from tree nodes so they can be committed
// after their parent groups are created. Returns:
// - flattenedTree: the tree with subfolders replaced by their direct layers
// - subfolderCommits: list of subfolder commits with their parent context
function extractSubfoldersForCommit(tree) {
    const flattenedTree = [];
    const subfolderCommits = []; // { parentNodeIndex, subfolder, layerIds }

    for (let i = 0; i < tree.length; i++) {
        const node = tree[i];

        if (!node.children || node.children.length === 0) {
            flattenedTree.push(node);
            continue;
        }

        // Check if this node has any subfolder children
        const hasSubfolders = node.children.some(c => c.isProposedSubfolder);

        if (!hasSubfolders) {
            // No subfolders - keep as is
            flattenedTree.push(node);
            continue;
        }

        // This node has subfolders - extract them
        const directLayers = [];
        const subfolders = [];

        for (const child of node.children) {
            if (child.isProposedSubfolder) {
                subfolders.push(child);
            } else {
                directLayers.push(child);
            }
        }

        // Create a copy of the node with only direct layers
        // (subfolders will be created after the parent group)
        const nodeWithoutSubfolders = {
            ...node,
            children: [...directLayers],
            _subfolderExtracted: true,
            _originalChildCount: node.children.length
        };

        // Also add the subfolder layers to the parent so they get included in the parent group
        for (const sf of subfolders) {
            if (sf.children) {
                nodeWithoutSubfolders.children.push(...sf.children);
            }
        }

        flattenedTree.push(nodeWithoutSubfolders);

        // Track subfolders for later commit
        for (const sf of subfolders) {
            if (sf.children && sf.children.length > 0) {
                subfolderCommits.push({
                    parentNodeIndex: flattenedTree.length - 1,
                    parentNodeName: node.name,
                    subfolder: sf,
                    layerIds: sf.children.map(c => c.id).filter(id => id !== undefined && id !== null)
                });
            }
        }

        console.log(`  SUBFOLDER EXTRACTION: "${node.name}" has ${subfolders.length} subfolder(s) with ${subfolders.reduce((sum, sf) => sum + (sf.children?.length || 0), 0)} layers`);
    }

    return { flattenedTree, subfolderCommits };
}

// =====================================================
// COMMIT PROPOSED STRUCTURE TO DOCUMENT
// =====================================================

async function commitProposedStructure(proposed) {
    if (!proposed || !proposed.tree) {
        console.error("No proposed structure");
        return { success: false, message: "No proposed structure" };
    }

    let doc = app.activeDocument;
    if (!doc) {
        return { success: false, message: "No active document" };
    }

    console.log("\n========== COMMITTING PROPOSED STRUCTURE ==========\n");

    // =====================================================
    // BUILD PARENT MAP: layerId → parentId (null if at root)
    // Also track which layers are groups for descendant counting
    // =====================================================
    const parentMap = new Map();
    const groupIds = new Set();
    let totalLayerCount = 0;

    function buildParentMap(layers, parentId = null) {
        for (const layer of layers) {
            parentMap.set(layer.id, parentId);
            totalLayerCount++;

            if (layer.layers && layer.layers.length > 0) {
                groupIds.add(layer.id);
                buildParentMap(layer.layers, layer.id);
            }
        }
    }
    buildParentMap(doc.layers);

    // =====================================================
    // MEGAFOLDER DETECTION
    // A megafolder contains 80%+ of all layers - treat its contents as root
    // Count ALL descendants (not just direct children)
    // =====================================================
    const megafolderIds = new Set();
    const MEGAFOLDER_THRESHOLD = 0.8;

    // Count descendants for each group
    function countDescendants(groupId) {
        let count = 0;
        for (const [layerId, parentId] of parentMap) {
            // Check if this layer is a descendant of groupId
            let currentParent = parentId;
            while (currentParent !== null && currentParent !== undefined) {
                if (currentParent === groupId) {
                    count++;
                    break;
                }
                currentParent = parentMap.get(currentParent);
            }
        }
        return count;
    }

    // Check top-level groups for megafolder status
    for (const groupId of groupIds) {
        const groupParent = parentMap.get(groupId);
        // Only check root-level groups
        if (groupParent === null || groupParent === undefined) {
            const descendantCount = countDescendants(groupId);
            const ratio = descendantCount / totalLayerCount;
            if (ratio >= MEGAFOLDER_THRESHOLD) {
                megafolderIds.add(groupId);
                console.log(`MEGAFOLDER DETECTED: ID ${groupId} contains ${descendantCount}/${totalLayerCount} layers (${(ratio * 100).toFixed(0)}%)`);
            }
        }
    }

    // =====================================================
    // HELPER: Get the immediate parent group for any layer ID
    // - Layer at root → return its own ID
    // - Layer inside a megafolder → return its own ID (treat megafolder as root)
    // - Layer inside a group → return the immediate parent group ID
    // =====================================================
    function getParentGroupId(layerId) {
        const parentId = parentMap.get(layerId);

        // If no parent (at root), return the layer itself
        if (parentId === null || parentId === undefined) {
            return layerId;
        }

        // If parent is a megafolder, treat this layer as if it's at root
        if (megafolderIds.has(parentId)) {
            return layerId;
        }

        // Return the immediate parent group
        return parentId;
    }

    // =====================================================
    // HIVE-MIND: EXTRACT SUBFOLDERS FOR NESTED COMMIT
    // Process the tree to separate subfolders for later creation
    // =====================================================
    const { flattenedTree, subfolderCommits } = extractSubfoldersForCommit(proposed.tree);
    console.log(`  Extracted ${subfolderCommits.length} subfolder(s) for nested commit`);

    // Use the flattened tree for main processing (subfolders will be created in step 1.5)
    const treeToProcess = flattenedTree;

    // =====================================================
    // FIRST PASS: Build map of layerId → proposedGroupIndex
    // This helps detect "contested" parent groups (layers split across proposed groups)
    // =====================================================
    const layerToProposedGroup = new Map(); // layerId → proposedGroupIndex
    const parentToProposedGroups = new Map(); // parentId → Set of proposedGroupIndices

    for (let i = 0; i < treeToProcess.length; i++) {
        const node = treeToProcess[i];
        if (node.children) {
            for (const child of node.children) {
                if (child.id !== undefined && child.id !== null) {
                    layerToProposedGroup.set(child.id, i);

                    // Track which proposed groups want layers from each parent
                    const parentId = parentMap.get(child.id);
                    if (parentId !== null && parentId !== undefined && !megafolderIds.has(parentId)) {
                        if (!parentToProposedGroups.has(parentId)) {
                            parentToProposedGroups.set(parentId, new Set());
                        }
                        parentToProposedGroups.get(parentId).add(i);
                    }
                }
            }
        }
    }

    // Identify contested parents (layers going to different proposed groups)
    const contestedParents = new Set();
    for (const [parentId, proposedGroups] of parentToProposedGroups) {
        if (proposedGroups.size > 1) {
            contestedParents.add(parentId);
            console.log(`CONTESTED GROUP: ID ${parentId} has layers going to ${proposedGroups.size} different proposed groups`);
        }
    }

    // =====================================================
    // BUILD GROUPS TO CREATE
    // =====================================================
    const groupsToMake = [];

    console.log("\n--- DEBUG: PROPOSED vs COMMIT ---\n");

    for (const node of treeToProcess) {
        const groupType = node.type || "unknown";
        const debugName = node.name || node.superGroupName || groupType;

        // Debug: show proposed structure
        console.log(`PROPOSED: "${debugName}" (${groupType})`);
        if (node.children) {
            for (const child of node.children) {
                const parentId = parentMap.get(child.id);
                console.log(`  - Layer "${child.name}" (ID: ${child.id}) → Parent: ${parentId}`);
            }
        }

        // Collect IDs - use immediate parent for nested LAYERS, but use direct ID for GROUPS
        // EXCEPTION: If parent is "contested" (has layers going to different proposed groups),
        // use individual layer IDs to avoid grabbing layers meant for other groups
        const idsToSelect = new Set();

        if (node.children) {
            for (const child of node.children) {
                if (child.id !== undefined && child.id !== null) {
                    // If child is already a group, use its ID directly
                    if (child.isGroup || child.kind === "group") {
                        idsToSelect.add(child.id);
                        console.log(`    → "${child.name}" is a GROUP, using ID: ${child.id}`);
                    } else {
                        const parentId = parentMap.get(child.id);

                        // Check if parent is contested (has layers going to different proposed groups)
                        if (parentId !== null && contestedParents.has(parentId)) {
                            // Parent is contested - use individual layer ID
                            idsToSelect.add(child.id);
                            console.log(`    → "${child.name}" in CONTESTED group ${parentId}, using individual ID: ${child.id}`);
                        } else {
                            // Parent is not contested - safe to use parent logic
                            const selectId = getParentGroupId(child.id);
                            if (selectId !== child.id) {
                                console.log(`    → "${child.name}" inside group ${parentId}, using parent ID: ${selectId}`);
                            } else if (parentId !== null && megafolderIds.has(parentId)) {
                                console.log(`    → "${child.name}" inside MEGAFOLDER ${parentId}, treating as root, using ID: ${child.id}`);
                            } else {
                                console.log(`    → "${child.name}" at root level, using ID: ${child.id}`);
                            }
                            idsToSelect.add(selectId);
                        }
                    }
                }
            }
        }

        const idsArray = [...idsToSelect];

        // Debug: show what we'll actually select
        console.log(`COMMIT: Will select IDs: [${idsArray.join(", ")}]`);
        console.log("");

        // Generate group name
        let groupName = node.name;
        if (!groupName || groupName.trim() === "") {
            groupName = node.superGroupName;
        }
        if (!groupName || groupName.trim() === "") {
            groupName = generateGroupNameFromType(groupType);
        }
        if (!groupName || groupName.trim() === "") {
            groupName = groupType.charAt(0).toUpperCase() + groupType.slice(1);
        }

        console.log(`→ "${groupName}" (${groupType}): ${idsArray.length} item(s)`);

        if (idsArray.length >= 1) {
            groupsToMake.push({
                name: groupName,
                type: groupType,
                ids: idsArray
            });
        }
    }

    console.log(`\nTotal groups to create: ${groupsToMake.length}\n`);

    if (groupsToMake.length === 0) {
        return { success: true, message: "Nothing to do", successCount: 0, errorCount: 0 };
    }

    // =====================================================
    // STEP 1: CREATE PROPOSED GROUPS - process in REVERSE order (bottom first)
    // =====================================================
    console.log("\n--- STEP 1: CREATING PROPOSED GROUPS ---\n");

    let created = 0;
    let failed = 0;
    const createdGroupIds = new Set(); // Track IDs of groups we create

    for (let i = groupsToMake.length - 1; i >= 0; i--) {
        const group = groupsToMake[i];
        console.log(`\n--- [${groupsToMake.length - i}/${groupsToMake.length}] "${group.name}" (${group.type}) ---`);

        if (group.ids.length === 0) {
            continue;
        }

        try {
            const ids = group.ids;

            // Select first item
            await action.batchPlay([{
                _obj: "select",
                _target: [{ _ref: "layer", _id: ids[0] }],
                makeVisible: false
            }], { synchronousExecution: true });

            // Add remaining to selection
            for (let j = 1; j < ids.length; j++) {
                await action.batchPlay([{
                    _obj: "select",
                    _target: [{ _ref: "layer", _id: ids[j] }],
                    selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" },
                    makeVisible: false
                }], { synchronousExecution: true });
            }

            // Create group
            await action.batchPlay([{
                _obj: "make",
                _target: [{ _ref: "layerSection" }],
                from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });

            await new Promise(r => setTimeout(r, 50));

            // Rename
            console.log(`  Renaming to: "${group.name}"`);
            await action.batchPlay([{
                _obj: "set",
                _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                to: { _obj: "layer", name: group.name },
                _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });

            // Color code
            const typeColors = {
                subject: "red", background: "blue", texture: "orange",
                text: "yellowColor", headline: "yellowColor", caption: "yellowColor",
                graphics: "violet", logo: "magenta", adjustment: "gray",
                effect: "seafoam", fill: "indigo", unknown: "gray"
            };

            await action.batchPlay([{
                _obj: "set",
                _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                to: { _obj: "layer", color: { _enum: "color", _value: typeColors[group.type] || "gray" } },
                _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });

            // Track the ID of the newly created group
            const newGroupId = app.activeDocument.activeLayers[0]?.id;
            if (newGroupId) {
                createdGroupIds.add(newGroupId);
            }

            console.log(`  ✓ "${group.name}" (ID: ${newGroupId})`);
            created++;

        } catch (e) {
            console.error(`  ✗ ERROR: ${e.message}`);
            failed++;
        }
    }

    // =====================================================
    // STEP 1.5: CREATE SUBFOLDERS (Nested groups within parent groups)
    // HIVE-MIND: Organize loose same-type layers into subfolders
    // =====================================================
    if (subfolderCommits && subfolderCommits.length > 0) {
        console.log("\n--- STEP 1.5: CREATING SUBFOLDERS ---\n");
        console.log(`  Found ${subfolderCommits.length} subfolder(s) to create`);

        // Wait for PS to settle after creating main groups
        await new Promise(r => setTimeout(r, 100));

        for (const sfCommit of subfolderCommits) {
            const { parentNodeName, subfolder, layerIds } = sfCommit;

            if (!layerIds || layerIds.length === 0) {
                console.log(`  Skipping empty subfolder "${subfolder.name}"`);
                continue;
            }

            console.log(`\n  Creating subfolder "${subfolder.name}" (${subfolder.type}) inside "${parentNodeName}"`);
            console.log(`    Layer IDs: [${layerIds.join(", ")}]`);

            try {
                // Select first layer
                await action.batchPlay([{
                    _obj: "select",
                    _target: [{ _ref: "layer", _id: layerIds[0] }],
                    makeVisible: false
                }], { synchronousExecution: true });

                // Add remaining layers to selection
                for (let j = 1; j < layerIds.length; j++) {
                    await action.batchPlay([{
                        _obj: "select",
                        _target: [{ _ref: "layer", _id: layerIds[j] }],
                        selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" },
                        makeVisible: false
                    }], { synchronousExecution: true });
                }

                // Create group from selection
                await action.batchPlay([{
                    _obj: "make",
                    _target: [{ _ref: "layerSection" }],
                    from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                    _options: { dialogOptions: "dontDisplay" }
                }], { synchronousExecution: true });

                await new Promise(r => setTimeout(r, 50));

                // Rename the subfolder
                await action.batchPlay([{
                    _obj: "set",
                    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                    to: { _obj: "layer", name: subfolder.name },
                    _options: { dialogOptions: "dontDisplay" }
                }], { synchronousExecution: true });

                // Color code based on type
                const typeColors = {
                    subject: "red", background: "blue", texture: "orange",
                    text: "yellowColor", headline: "yellowColor", caption: "yellowColor",
                    graphics: "violet", logo: "magenta", adjustment: "gray",
                    effect: "seafoam", fill: "indigo", unknown: "gray"
                };

                await action.batchPlay([{
                    _obj: "set",
                    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                    to: { _obj: "layer", color: { _enum: "color", _value: typeColors[subfolder.type] || "gray" } },
                    _options: { dialogOptions: "dontDisplay" }
                }], { synchronousExecution: true });

                const newSubfolderId = app.activeDocument.activeLayers[0]?.id;
                if (newSubfolderId) {
                    createdGroupIds.add(newSubfolderId);
                }

                console.log(`    ✓ Subfolder "${subfolder.name}" created (ID: ${newSubfolderId})`);
                created++;

            } catch (e) {
                console.error(`    ✗ Subfolder ERROR: ${e.message}`);
                failed++;
            }
        }
    }

    // =====================================================
    // STEP 2: CLEANUP - PRESERVE existing groups, only ungroup truly empty ones
    // RULE: Never destroy existing document structure
    // Only ungroup groups that are EMPTY (no children) after our operations
    // =====================================================
    console.log("\n--- STEP 2: CLEANUP - PRESERVING EXISTING GROUPS ---\n");

    console.log(`  Tracking ${createdGroupIds.size} proposed group IDs: [${[...createdGroupIds].join(", ")}]`);

    let ungrouped = 0;

    // Wait for PS to update
    await new Promise(r => setTimeout(r, 100));

    // Re-read document
    doc = app.activeDocument;

    // Only ungroup EMPTY groups (groups with 0 children)
    // This preserves the existing document structure
    const emptyGroupsToUngroup = [];

    function findEmptyGroups(layers) {
        for (const layer of layers) {
            if (layer.kind === "group" || (layer.layers && layer.layers.length >= 0)) {
                // Check if empty
                if (!layer.layers || layer.layers.length === 0) {
                    // Empty group - can be ungrouped
                    emptyGroupsToUngroup.push({ id: layer.id, name: layer.name });
                } else {
                    // Has children - recurse to find empty nested groups
                    findEmptyGroups(layer.layers);
                }
            }
        }
    }

    findEmptyGroups(doc.layers);

    if (emptyGroupsToUngroup.length === 0) {
        console.log(`  No empty groups found - document structure preserved`);
    } else {
        console.log(`  Found ${emptyGroupsToUngroup.length} empty groups to clean up`);

        for (const emptyGroup of emptyGroupsToUngroup) {
            try {
                console.log(`    Removing empty group: "${emptyGroup.name}" (ID: ${emptyGroup.id})`);

                // Select the group
                await action.batchPlay([{
                    _obj: "select",
                    _target: [{ _ref: "layer", _id: emptyGroup.id }],
                    makeVisible: false,
                    _options: { dialogOptions: "dontDisplay" }
                }], { synchronousExecution: true });

                // Delete it (since it's empty, just delete instead of ungroup)
                await action.batchPlay([{
                    _obj: "delete",
                    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                    _options: { dialogOptions: "dontDisplay" }
                }], { synchronousExecution: true });

                ungrouped++;
                console.log(`      ✓ Removed empty "${emptyGroup.name}"`);

            } catch (e) {
                console.warn(`      ⚠ Could not remove "${emptyGroup.name}": ${e.message}`);
            }
        }
    }

    // Log what we're keeping
    console.log(`\n  Preserved existing groups:`);
    for (const layer of doc.layers) {
        if (layer.kind === "group" || (layer.layers && layer.layers.length > 0)) {
            if (createdGroupIds.has(layer.id)) {
                console.log(`    ✓ "${layer.name}" (PROPOSED - ID: ${layer.id})`);
            } else {
                console.log(`    ✓ "${layer.name}" (EXISTING - ID: ${layer.id})`);
            }
        }
    }

    // =====================================================
    // STEP 3: COLLAPSE ALL GROUPS
    // =====================================================
    console.log("\n--- STEP 3: COLLAPSING ALL GROUPS ---\n");

    try {
        await action.batchPlay([{
            _obj: "collapseAllGroupsEvent",
            _options: { dialogOptions: "dontDisplay" }
        }], { synchronousExecution: true });

        // Deselect all
        await action.batchPlay([{
            _obj: "selectNoLayers",
            _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            _options: { dialogOptions: "dontDisplay" }
        }], { synchronousExecution: true });

        console.log("  ✓ All groups collapsed");
    } catch (e) {
        console.warn(`  ⚠ Could not collapse groups: ${e.message}`);
    }

    const msg = `Created ${created} proposed groups, ungrouped ${ungrouped} noise groups, ${failed} failed`;
    console.log(`\n========== COMMIT DONE: ${msg} ==========\n`);
    return { success: failed === 0, message: msg, successCount: created, errorCount: failed, ungroupedCount: ungrouped };
}

// =====================================================
// POST-COMMIT: MERGE CONSECUTIVE SAME-NAMED TOP-LEVEL GROUPS
// =====================================================
// This runs AFTER commit using batchPlay to operate on the actual document
// Checks ROOT level groups only (not nested), finds consecutive same-named groups,
// and groups them together
async function mergeConsecutiveSameNamedGroups() {
    console.log("\n========== POST-COMMIT: RENAMING & MERGING GROUPS ==========\n");

    // Wait for Photoshop to fully update after commit
    await new Promise(r => setTimeout(r, 150));

    // Re-fetch document to get updated layer names
    let doc = app.activeDocument;
    if (!doc) {
        console.log("  No active document");
        return { success: false, merged: 0 };
    }

    // =====================================================
    // PHASE 1: RENAME MISMATCHED GROUPS BY DOMINANT CONTENT
    // =====================================================
    // 1. Groups with generic names (Group 1, Group 11) get renamed based on content
    // 2. Groups with semantic names (TEXT, SUBJECT) get validated - if content doesn't match, rename them
    console.log("  Phase 1: Validating and renaming groups by dominant content...\n");

    // Helper: Extract type from a group name
    // IMPORTANT: Order matters! "TEXTURES" contains "TEXT" so check TEXTURE first
    function getTypeFromName(name) {
        const upperName = (name || "").toUpperCase();
        if (upperName.includes("GRAPHIC")) return "graphics";
        if (upperName.includes("TEXTURE")) return "texture";  // Must be before TEXT (TEXTURES contains TEXT)
        if (upperName.includes("OVERLAY") || upperName.includes("EFFECT")) return "effect";
        if (upperName.includes("ADJUSTMENT")) return "adjustment";
        if (upperName.includes("TEXT") || upperName.includes("HEADLINE") || upperName.includes("CAPTION")) return "text";
        if (upperName.includes("SUBJECT")) return "subject";
        if (upperName.includes("BACKGROUND")) return "background";
        if (upperName.includes("LOGO")) return "logo";
        if (upperName.includes("FILL")) return "fill";
        return null;
    }

    // Helper: Map type to proper group name
    const typeToName = {
        graphics: "GRAPHIC ELEMENTS",
        text: "TEXT",
        subject: "SUBJECT",
        background: "BACKGROUND",
        texture: "BASE TEXTURES",
        effect: "OVERLAY EFFECTS",
        adjustment: "OVERLAY EFFECTS",
        logo: "LOGOS",
        fill: "FILLS"
    };

    async function renameGroupsByContent(layers) {
        for (const layer of layers) {
            const isGroup = layer.kind === "group" || (layer.layers && layer.layers.length > 0);
            if (!isGroup) continue;

            // Check if this is a generic group name (Group X, Group X copy, etc.)
            const isGenericName = /^Group\s*\d+/i.test(layer.name);

            // Check if this is a semantic name (TEXT, SUBJECT, etc.)
            const currentType = getTypeFromName(layer.name);
            const hasSemanticName = currentType !== null;

            // Analyze contents to determine dominant type
            const typeCounts = {};
            let totalItems = 0;

            function countChildTypes(children) {
                for (const child of children) {
                    const childIsGroup = child.kind === "group" || (child.layers && child.layers.length > 0);

                    if (childIsGroup) {
                        // Extract type from group name
                        const childType = getTypeFromName(child.name);

                        if (childType) {
                            typeCounts[childType] = (typeCounts[childType] || 0) + 1;
                            totalItems++;
                        } else {
                            // Nested generic group - recurse into it
                            countChildTypes(child.layers || []);
                        }
                    }
                }
            }

            countChildTypes(layer.layers || []);

            // Find dominant type - SUBJECT always wins if present
            let dominantType = null;
            let maxCount = 0;

            // Subject priority: if ANY subject content exists, it's a subject group
            if (typeCounts.subject && typeCounts.subject > 0) {
                dominantType = "subject";
                maxCount = typeCounts.subject;
            } else {
                // Otherwise find the most common type
                for (const [type, count] of Object.entries(typeCounts)) {
                    if (count > maxCount) {
                        maxCount = count;
                        dominantType = type;
                    }
                }
            }

            // Decide if we need to rename
            let shouldRename = false;
            let reason = "";

            // NEVER rename a SUBJECT group - subject is sacred
            if (currentType === "subject") {
                shouldRename = false;
                // Skip - subject groups should never be renamed
            } else if (isGenericName && dominantType) {
                // Generic name (Group X) - always rename based on content
                shouldRename = true;
                reason = "generic name";
            } else if (hasSemanticName && dominantType && dominantType !== currentType) {
                // Semantic name but content doesn't match - rename to match content
                // Normalize effect/adjustment comparison
                const normalizedCurrent = (currentType === "adjustment") ? "effect" : currentType;
                const normalizedDominant = (dominantType === "adjustment") ? "effect" : dominantType;

                if (normalizedCurrent !== normalizedDominant) {
                    shouldRename = true;
                    reason = `mismatch (named ${currentType}, contains ${dominantType})`;
                }
            }

            if (shouldRename && totalItems > 0) {
                const newName = typeToName[dominantType] || "ELEMENTS";
                const groupColor = getGroupColorFromName(newName);

                console.log(`    "${layer.name}" (ID: ${layer.id}) → "${newName}"`);
                console.log(`      Reason: ${reason}`);
                console.log(`      Content: ${JSON.stringify(typeCounts)}, dominant: ${dominantType}`);

                try {
                    // Rename
                    await action.batchPlay([{
                        _obj: "set",
                        _target: [{ _ref: "layer", _id: layer.id }],
                        to: { _obj: "layer", name: newName },
                        _options: { dialogOptions: "dontDisplay" }
                    }], { synchronousExecution: true });

                    // Color
                    await action.batchPlay([{
                        _obj: "set",
                        _target: [{ _ref: "layer", _id: layer.id }],
                        to: { _obj: "layer", color: { _enum: "color", _value: groupColor } },
                        _options: { dialogOptions: "dontDisplay" }
                    }], { synchronousExecution: true });

                    console.log(`      ✓ Renamed and colored (${groupColor})`);
                } catch (e) {
                    console.warn(`      ⚠ Failed: ${e.message}`);
                }
            }

            // Recurse into children
            if (layer.layers && layer.layers.length > 0) {
                await renameGroupsByContent(layer.layers);
            }
        }
    }

    await renameGroupsByContent(doc.layers);

    // Re-fetch document after renames
    await new Promise(r => setTimeout(r, 50));
    doc = app.activeDocument;

    // =====================================================
    // PHASE 2: MERGE CONSECUTIVE SAME-NAMED GROUPS
    // =====================================================
    console.log("\n  Phase 2: Merging consecutive same-named groups...\n");

    // Get top-level layers only (not nested)
    const topLevelLayers = [];
    for (const layer of doc.layers) {
        const isGroup = layer.kind === "group" || (layer.layers && layer.layers.length >= 0);
        topLevelLayers.push({
            id: layer.id,
            name: layer.name,
            kind: layer.kind,
            isGroup: isGroup
        });
    }

    console.log(`  Found ${topLevelLayers.length} top-level layers (ALL layers, not just groups):`);
    // Debug: show ALL top-level layers to see what might interrupt sequences
    for (let idx = 0; idx < topLevelLayers.length; idx++) {
        const layer = topLevelLayers[idx];
        const marker = layer.isGroup ? "[GROUP]" : "[layer]";
        console.log(`    ${idx}: ${marker} "${layer.name}" (ID: ${layer.id})`);
    }

    // Find consecutive groups with same name
    // Note: doc.layers is TOP to BOTTOM order in Photoshop
    const mergeRuns = [];
    let i = 0;

    console.log(`\n  Scanning for consecutive same-named groups...`);

    while (i < topLevelLayers.length) {
        const current = topLevelLayers[i];

        // Only look at groups
        if (!current.isGroup) {
            console.log(`    [${i}] "${current.name}" - skipping (not a group)`);
            i++;
            continue;
        }

        const currentName = (current.name || "").toUpperCase().trim();
        if (!currentName) {
            console.log(`    [${i}] empty name - skipping`);
            i++;
            continue;
        }

        console.log(`    [${i}] "${current.name}" - checking for sequence...`);

        // Look for consecutive groups with same name
        const run = [current];
        let j = i + 1;

        while (j < topLevelLayers.length) {
            const next = topLevelLayers[j];
            const nextName = (next.name || "").toUpperCase().trim();

            console.log(`      [${j}] "${next.name}" isGroup=${next.isGroup} match=${next.isGroup && nextName === currentName}`);

            if (next.isGroup && nextName === currentName) {
                run.push(next);
                j++;
            } else {
                break; // Not consecutive - something different in between
            }
        }

        if (run.length >= 2) {
            mergeRuns.push({
                name: current.name,
                groups: run
            });
            console.log(`    ✓ Found sequence of ${run.length} "${current.name}" groups (IDs: ${run.map(g => g.id).join(', ')})`);
        } else {
            console.log(`    - Only 1, no sequence`);
        }

        i = j > i ? j : i + 1;
    }

    if (mergeRuns.length === 0) {
        console.log("\n  No consecutive same-named groups found to merge");
        return { success: true, merged: 0 };
    }

    console.log(`\n  === MERGE SUMMARY: ${mergeRuns.length} runs to merge ===`);
    for (const run of mergeRuns) {
        console.log(`    - "${run.name}": ${run.groups.length} groups`);
    }

    // Merge each run using batchPlay
    let merged = 0;

    for (const run of mergeRuns) {
        console.log(`\n  Grouping ${run.groups.length} "${run.name}" groups...`);
        console.log(`    Group IDs to select: ${run.groups.map(g => g.id).join(', ')}`);

        try {
            // Select first group
            await action.batchPlay([{
                _obj: "select",
                _target: [{ _ref: "layer", _id: run.groups[0].id }],
                makeVisible: false
            }], { synchronousExecution: true });
            console.log(`    Selected first: ID ${run.groups[0].id}`);

            // Add remaining groups to selection
            for (let k = 1; k < run.groups.length; k++) {
                await action.batchPlay([{
                    _obj: "select",
                    _target: [{ _ref: "layer", _id: run.groups[k].id }],
                    selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" },
                    makeVisible: false
                }], { synchronousExecution: true });
                console.log(`    Added to selection: ID ${run.groups[k].id}`);
            }

            // Create group from selection
            console.log(`    Creating wrapper group...`);
            await action.batchPlay([{
                _obj: "make",
                _target: [{ _ref: "layerSection" }],
                from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });

            // Wait for Photoshop to create and select the new group
            await new Promise(r => setTimeout(r, 100));

            // Get the currently selected layer (should be our new group)
            const selectedResult = await action.batchPlay([{
                _obj: "get",
                _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });

            const newGroupId = selectedResult && selectedResult[0] ? selectedResult[0].layerID : null;
            console.log(`    New wrapper group ID: ${newGroupId}`);

            // Rename the new wrapper group using its ID for reliability
            const renameTarget = newGroupId
                ? [{ _ref: "layer", _id: newGroupId }]
                : [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }];

            await action.batchPlay([{
                _obj: "set",
                _target: renameTarget,
                to: { _obj: "layer", name: run.name },
                _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });
            console.log(`    Renamed to: "${run.name}"`);

            // Color code based on group name
            const groupColor = getGroupColorFromName(run.name);
            await action.batchPlay([{
                _obj: "set",
                _target: renameTarget,
                to: { _obj: "layer", color: { _enum: "color", _value: groupColor } },
                _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });

            console.log(`    ✓ Grouped into "${run.name}" (color: ${groupColor})`);
            merged++;

        } catch (e) {
            console.error(`    ✗ Failed to group: ${e.message}`);
            console.error(`    Stack: ${e.stack}`);
        }
    }

    console.log(`\n========== MERGED ${merged} GROUP RUNS ==========\n`);
    return { success: true, merged };
}

// Helper: Get group color based on name keywords
function getGroupColorFromName(name) {
    const nameLower = (name || "").toLowerCase();

    // Match name to type and use colorSettings
    if (nameLower.includes("effect") || nameLower.includes("overlay")) {
        return getPSColor("effect");
    }
    if (nameLower.includes("texture")) {
        return getPSColor("texture");
    }
    if (nameLower.includes("subject")) {
        return getPSColor("subject");
    }
    if (nameLower.includes("background")) {
        return getPSColor("background");
    }
    if (nameLower.includes("headline")) {
        return getPSColor("headline");
    }
    if (nameLower.includes("text") || nameLower.includes("caption")) {
        return getPSColor("text");
    }
    if (nameLower.includes("graphic")) {
        return getPSColor("graphics");
    }
    if (nameLower.includes("logo")) {
        return getPSColor("logo");
    }
    if (nameLower.includes("fill")) {
        return getPSColor("fill");
    }

    // Default
    return "gray";
}

// Helper: Get all layers as flat array (including nested)
function getAllLayersFlat(layers, result = []) {
    for (const layer of layers) {
        result.push(layer);
        if (layer.layers && layer.layers.length > 0) {
            getAllLayersFlat(layer.layers, result);
        }
    }
    return result;
}

// Helper: Generate group name from type
function generateGroupNameFromType(type) {
    const names = {
        adjustment: "Adjustments",
        texture: "Textures",
        headline: "Headlines",
        text: "Text",
        subject: "Subject",
        graphics: "Graphics",
        logo: "Logos",
        background: "Background",
        fill: "Fills",
        composition: "Composition",
        effect: "Effects",
        caption: "Captions",
        unknown: "Elements"
    };
    return names[type] || "Group";
}

// Find layer by ID (recursive)
function findLayerById(layers, targetId) {
    for (const layer of layers) {
        if (layer.id === targetId) return layer;
        if (layer.layers && layer.layers.length > 0) {
            const found = findLayerById(layer.layers, targetId);
            if (found) return found;
        }
    }
    return null;
}

// Find layer by name recursively (handles nested groups)
function findLayerRecursive(layers, targetName) {
    for (const layer of layers) {
        if (layer.name === targetName) {
            return layer;
        }
        if (layer.layers && layer.layers.length > 0) {
            const found = findLayerRecursive(layer.layers, targetName);
            if (found) return found;
        }
    }
    return null;
}

// Helper to extract layer IDs from any node type
function extractLayerIds(node) {
    const ids = [];

    if (node.children) {
        for (const child of node.children) {
            if (child.id !== undefined && child.id !== null) {
                ids.push(child.id);
            } else if (child.children) {
                // Nested structure - recurse
                ids.push(...extractLayerIds(child));
            }
        }
    }

    return ids.filter(id => id !== undefined && id !== null);
}

// Helper to get display name for types
function getTypeDisplayName(type) {
    const names = {
        adjustment: "Adjustments",
        texture: "Textures",
        headline: "Headlines",
        text: "Text",
        subject: "Subject",
        graphics: "Graphics",
        logo: "Logos",
        background: "Background",
        fill: "Fills",
        composition: "Composition",
        effect: "Effects",
        caption: "Captions",
        unknown: "Elements"
    };
    return names[type] || "Group";
}

// Collect all layer IDs from a node (handles nested children)
function collectLayerIdsFromNode(node) {
    const ids = [];

    if (node.children) {
        for (const child of node.children) {
            if (child.id !== undefined && child.id !== null) {
                ids.push(child.id);
            } else if (child.children) {
                // Recurse into nested children
                ids.push(...collectLayerIdsFromNode(child));
            }
        }
    }

    return ids;
}

// Simple reliable group creation
async function createGroupFromLayerIds(doc, layerIds, groupName) {
    if (!layerIds || layerIds.length < 2) {
        console.log(`  Skipping - need at least 2 layers`);
        return false;
    }

    console.log(`  Layer IDs: ${layerIds.join(", ")}`);

    // Find layers by ID
    const layers = [];
    for (const id of layerIds) {
        const layer = findLayerByIdInDoc(doc, id);
        if (layer) {
            layers.push(layer);
            console.log(`    Found: "${layer.name}" (ID: ${id})`);
        } else {
            console.log(`    NOT FOUND: ID ${id}`);
        }
    }

    if (layers.length < 2) {
        console.log(`  Only found ${layers.length} layers, need 2+`);
        return false;
    }

    try {
        // Select layers using DOM API
        doc.activeLayers = layers;
        console.log(`  Selected ${layers.length} layers`);

        // Create group using batchPlay
        await action.batchPlay([{
            _obj: "make",
            _target: [{ _ref: "layerSection" }],
            from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
            name: groupName
        }], { synchronousExecution: true });

        console.log(`  Group "${groupName}" created!`);
        return true;

    } catch (e) {
        console.error(`  batchPlay error: ${e.message}`);

        // Fallback: try selecting one by one
        try {
            console.log(`  Trying fallback selection...`);

            // Select first
            await action.batchPlay([{
                _obj: "select",
                _target: [{ _ref: "layer", _id: layerIds[0] }],
                makeVisible: false
            }], { synchronousExecution: true });

            // Add rest
            for (let i = 1; i < layerIds.length; i++) {
                await action.batchPlay([{
                    _obj: "select",
                    _target: [{ _ref: "layer", _id: layerIds[i] }],
                    selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" },
                    makeVisible: false
                }], { synchronousExecution: true });
            }

            // Create group
            await action.batchPlay([{
                _obj: "make",
                _target: [{ _ref: "layerSection" }],
                from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                name: groupName
            }], { synchronousExecution: true });

            console.log(`  Group "${groupName}" created (fallback)!`);
            return true;

        } catch (e2) {
            console.error(`  Fallback also failed: ${e2.message}`);
            return false;
        }
    }
}

// Find layer by ID in document (recursive search)
function findLayerByIdInDoc(doc, targetId) {
    function search(layers) {
        for (const layer of layers) {
            if (layer.id === targetId) return layer;
            if (layer.layers && layer.layers.length > 0) {
                const found = search(layer.layers);
                if (found) return found;
            }
        }
        return null;
    }
    return search(doc.layers);
}

// Find layer by name in document (recursive search, returns first match)
function findLayerByNameInDoc(doc, targetName) {
    function search(layers) {
        for (const layer of layers) {
            if (layer.name === targetName) return layer;
            if (layer.layers && layer.layers.length > 0) {
                const found = search(layer.layers);
                if (found) return found;
            }
        }
        return null;
    }
    return search(doc.layers);
}

// Legacy function - keeping for compatibility
async function createGroupFromLayers(layerIds, groupName) {
    if (!layerIds || layerIds.length === 0) return false;

    // Filter out any invalid IDs
    const validIds = layerIds.filter(id => id !== undefined && id !== null);
    if (validIds.length === 0) return false;
    if (validIds.length < 2) {
        console.log(`  Skipping "${groupName}" - only ${validIds.length} layer`);
        return false;
    }

    console.log(`  Grouping ${validIds.length} layers into "${groupName}"...`);

    const doc = app.activeDocument;

    // Find layers by ID using DOM
    const layersToGroup = [];
    for (const id of validIds) {
        const layer = findLayerByIdDeep(doc, id);
        if (layer) {
            layersToGroup.push(layer);
        } else {
            console.log(`    Warning: Layer ID ${id} not found`);
        }
    }

    if (layersToGroup.length < 2) {
        console.log(`    Not enough valid layers found (${layersToGroup.length})`);
        return false;
    }

    console.log(`    Found ${layersToGroup.length} layers`);

    // METHOD 1: Use DOM createLayerGroup if available
    try {
        // Select the layers
        doc.activeLayers = layersToGroup;

        // Create group from selection using standard PS command
        const result = await action.batchPlay([
            {
                _obj: "make",
                _target: [{ _ref: "layerSection" }],
                from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                name: groupName
            }
        ], { synchronousExecution: true });

        console.log(`    OK: "${groupName}"`);
        return true;

    } catch (e) {
        console.log(`    Method 1 failed: ${e.message}`);
    }

    // METHOD 2: Try selecting via batchPlay first
    try {
        console.log(`    Trying method 2...`);

        // Clear selection first
        await action.batchPlay([
            { _obj: "selectNoLayers", _target: [{ _ref: "document", _enum: "ordinal", _value: "first" }] }
        ], { synchronousExecution: true }).catch(() => {});

        // Select first layer
        await action.batchPlay([
            {
                _obj: "select",
                _target: [{ _ref: "layer", _id: validIds[0] }],
                makeVisible: false
            }
        ], { synchronousExecution: true });

        // Add others to selection
        for (let i = 1; i < validIds.length; i++) {
            await action.batchPlay([
                {
                    _obj: "select",
                    _target: [{ _ref: "layer", _id: validIds[i] }],
                    selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" },
                    makeVisible: false
                }
            ], { synchronousExecution: true });
        }

        // Create group
        await action.batchPlay([
            {
                _obj: "make",
                _target: [{ _ref: "layerSection" }],
                from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                name: groupName
            }
        ], { synchronousExecution: true });

        console.log(`    OK (method 2): "${groupName}"`);
        return true;

    } catch (e2) {
        console.log(`    Method 2 failed: ${e2.message}`);
    }

    // METHOD 3: Use layer index-based selection
    try {
        console.log(`    Trying method 3 (by name)...`);

        // Select layers by name
        for (let i = 0; i < layersToGroup.length; i++) {
            const layer = layersToGroup[i];
            const modifier = i === 0 ? {} : {
                selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" }
            };

            await action.batchPlay([
                {
                    _obj: "select",
                    _target: [{ _ref: "layer", _name: layer.name }],
                    makeVisible: false,
                    ...modifier
                }
            ], { synchronousExecution: true });
        }

        // Group with Ctrl+G equivalent
        await action.batchPlay([
            {
                _obj: "make",
                _target: [{ _ref: "layerSection" }],
                from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                name: groupName
            }
        ], { synchronousExecution: true });

        console.log(`    OK (method 3): "${groupName}"`);
        return true;

    } catch (e3) {
        console.error(`    All methods failed for "${groupName}": ${e3.message}`);
        return false;
    }
}

// Deep search for layer by ID (searches all nested groups)
function findLayerByIdDeep(doc, targetId) {
    function searchLayers(layers) {
        for (const layer of layers) {
            if (layer.id === targetId) {
                return layer;
            }
            // Search in groups
            if (layer.layers && layer.layers.length > 0) {
                const found = searchLayers(layer.layers);
                if (found) return found;
            }
        }
        return null;
    }
    return searchLayers(doc.layers);
}

// =====================================================
// PHASE 5: VOTING & RESOLUTION
// Tally votes and determine final classification
// =====================================================

function resolveVotes(layers) {
    for (const layer of layers) {
        const votes = {};
        const reasons = {};

        // Tally all signals (including negative weights)
        for (const signal of layer.signals) {
            votes[signal.group] = (votes[signal.group] || 0) + signal.weight;
            if (!reasons[signal.group]) reasons[signal.group] = [];
            if (signal.weight > 0) {  // Only add positive reasons to display
                reasons[signal.group].push(signal.reason);
            }
        }

        // Find winner (only consider positive vote totals)
        let maxVote = 0;
        let winner = "unknown";
        let secondPlace = 0;
        let secondWinner = null;

        for (const [group, vote] of Object.entries(votes)) {
            // Skip negative totals (signal was contradicted)
            if (vote <= 0) continue;

            if (vote > maxVote) {
                secondPlace = maxVote;
                secondWinner = winner;
                maxVote = vote;
                winner = group;
            } else if (vote > secondPlace) {
                secondPlace = vote;
                secondWinner = group;
            }
        }

        // Calculate confidence based on margin between top 2
        // Hive-mind: close race = low confidence, clear winner = higher confidence
        // NEVER 100%, cap at 95%
        let confidence;
        if (maxVote <= 0) {
            confidence = 0;
        } else if (secondPlace <= 0) {
            // Only one positive group - high confidence but capped
            confidence = Math.min(90, Math.round(50 + maxVote / 5));
        } else {
            // Calculate margin between first and second place
            const margin = maxVote - secondPlace;
            const totalPositive = maxVote + secondPlace;
            const marginRatio = margin / totalPositive;

            // marginRatio of 0 = tied = 50% confidence
            // marginRatio of 1 = clear winner = high confidence
            confidence = Math.round(50 + marginRatio * 45);
        }

        // Cap at 95% - true hive-mind always has some uncertainty
        confidence = Math.min(confidence, 95);
        // Minimum 10% if we have any positive signals
        if (maxVote > 0) confidence = Math.max(confidence, 10);

        layer.votes = votes;
        layer.finalGroup = winner;
        layer.confidence = confidence;
        layer.reason = reasons[winner] ? reasons[winner].slice(0, 3).join("; ") : "no signals";

        // Store debug info
        layer.allReasons = reasons;
        layer.voteSummary = { first: winner, firstVotes: maxVote, second: secondWinner, secondVotes: secondPlace };
    }

    return layers;
}

// =====================================================
// PHASE 5B: SUBJECT FALLBACK & CONTEXT ANALYSIS
// If no subject found, determine most likely candidate
// =====================================================

function analyzeSubjectContext(layers) {
    const context = {
        hasSubject: false,
        subjectLayers: [],
        likelySubject: null,
        documentType: "unknown" // "portrait", "graphics-only", "text-heavy", etc.
    };

    // Find layers marked as subject
    const subjectLayers = layers.filter(l => l.finalGroup === "subject" && !l.isGroup);
    context.subjectLayers = subjectLayers;
    context.hasSubject = subjectLayers.length > 0;

    // Count layer types
    const typeCounts = {};
    for (const layer of layers) {
        if (!layer.isGroup) {
            typeCounts[layer.finalGroup] = (typeCounts[layer.finalGroup] || 0) + 1;
        }
    }

    // Determine document type
    const total = layers.filter(l => !l.isGroup).length;
    const textCount = (typeCounts.text || 0) + (typeCounts.headline || 0);
    const graphicsCount = typeCounts.graphics || 0;
    const textureCount = typeCounts.texture || 0;

    if (textCount / total > 0.5) {
        context.documentType = "text-heavy";
    } else if (graphicsCount / total > 0.5) {
        context.documentType = "graphics-focused";
    } else if (textureCount / total > 0.4) {
        context.documentType = "texture-heavy";
    } else if (context.hasSubject) {
        context.documentType = "portrait/subject";
    } else {
        context.documentType = "mixed";
    }

    // If no subject found, find the most likely candidate
    if (!context.hasSubject) {
        let bestCandidate = null;
        let bestScore = 0;

        for (const layer of layers) {
            if (layer.isGroup) continue;
            if (layer.finalGroup === "adjustment" || layer.finalGroup === "texture" ||
                layer.finalGroup === "fill" || layer.finalGroup === "background") continue;

            let score = 0;

            // Score based on size (15-60% coverage is ideal for subject)
            const coverage = layer.coveragePercent * (layer.estimatedFillRatio || 1);
            if (coverage > 10 && coverage < 70) {
                score += 30;
                if (coverage > 20 && coverage < 50) score += 20; // Sweet spot
            }

            // Score based on position (centered is better)
            if (layer.normCenterX > 0.3 && layer.normCenterX < 0.7) score += 15;
            if (layer.normCenterY > 0.2 && layer.normCenterY < 0.8) score += 15;

            // Score based on type
            if (layer.kind === "smartObject") score += 20;
            if (layer.kind === "pixel") score += 15;

            // Score based on aspect ratio (portrait-like for people)
            if (layer.aspectRatio > 0.5 && layer.aspectRatio < 1.5) score += 10;

            // Penalize if already classified as something specific
            if (layer.finalGroup === "logo" || layer.finalGroup === "text") score -= 30;

            // Bonus for certain names
            const nameLower = layer.nameLower || layer.name.toLowerCase();
            if (nameLower.includes("photo") || nameLower.includes("image") ||
                nameLower.includes("render") || nameLower.includes("cut")) {
                score += 25;
            }

            if (score > bestScore) {
                bestScore = score;
                bestCandidate = layer;
            }
        }

        if (bestCandidate && bestScore > 40) {
            context.likelySubject = bestCandidate;
            // Add a signal to this layer
            bestCandidate.signals.push({
                type: "LIKELY_SUBJECT_FALLBACK",
                group: "subject",
                weight: 50,
                reason: `likely subject (score: ${bestScore}, no clear subject found)`
            });
            bestCandidate.isLikelySubject = true;
        }
    }

    return context;
}

// =====================================================
// PHASE 6: POST-PROCESSING
// Clean up and finalize results
// =====================================================

function postProcess(layers) {
    // Apply any final adjustments
    for (const layer of layers) {
        // Groups: ensure they have a content-based classification
        if (layer.isGroup) {
            // Remove "-group" suffix for cleaner display, the subtag will show it's a group
            if (layer.finalGroup.endsWith("-group")) {
                layer.finalGroup = layer.finalGroup.replace("-group", "");
            }
            // If still "group" or "unknown", default to composition
            if (layer.finalGroup === "group" || layer.finalGroup === "unknown") {
                layer.finalGroup = "composition";
                layer.reason = "mixed content group";
                layer.confidence = 40;
            }
        }

        // Unknown layers default to graphics
        if (layer.finalGroup === "unknown" && !layer.isGroup) {
            layer.finalGroup = "graphics";
            layer.reason = "unclassified element";
            layer.confidence = 30;
        }
    }

    return layers;
}

// =====================================================
// UI RENDERING HELPERS
// =====================================================

function renderSuperGroup(superGroup) {
    let html = '';
    const childCount = superGroup.children.reduce((sum, c) =>
        sum + (c.children ? c.children.length : 1), 0);

    // Super-group header with distinct styling
    html += '<div class="super-group">';
    html += '<div class="super-group-header">';
    html += `<span class="super-group-icon">◆</span>`;
    html += `<span class="super-group-name">${superGroup.name || 'GROUP'}</span>`;
    html += `<span class="super-group-count">${childCount} layers</span>`;
    html += '</div>';

    // Render children (sub-groups)
    html += '<div class="super-group-content">';
    for (const child of superGroup.children) {
        html += renderProposedNode(child, 1);
    }
    html += '</div>';
    html += '</div>';

    return html;
}

function renderProposedNode(node, depth) {
    let html = '';
    const indent = '&nbsp;&nbsp;'.repeat(depth);

    if (node.isClippingChain) {
        // Render clipping chain
        html += '<div class="proposed-tree-group clip-chain-group">';
        html += '<div class="log-group-header">';
        html += `<span class="group-icon">⛓</span>`;
        html += `<span class="group-name">${node.name}</span>`;
        html += `<span class="log-group group-${node.type}">${node.type}</span>`;
        html += `<span class="log-subtag">clip-chain</span>`;
        html += `<span class="log-reason">${node.reason || ''}</span>`;
        html += '</div>';

        // Base layer
        html += '<div class="log-line clip-base-line">';
        html += `<span class="log-indent">${indent}&nbsp;&nbsp;</span>`;
        html += `<span class="clip-base-marker">●</span>`;
        html += `<span class="log-name">${node.base.name}</span>`;
        html += `<span class="log-type">${node.base.kind}</span>`;
        html += `<span class="log-group group-${node.base.finalGroup}">${node.base.finalGroup}</span>`;
        html += `<span class="log-subtag">base</span>`;
        html += '</div>';

        // Clipped layers
        for (const clipped of node.clipped) {
            html += '<div class="log-line clip-child-line">';
            html += `<span class="log-indent">${indent}&nbsp;&nbsp;&nbsp;&nbsp;</span>`;
            html += `<span class="clip-arrow-marker">↳</span>`;
            html += `<span class="log-name">${clipped.name}</span>`;
            html += `<span class="log-type">${clipped.kind}</span>`;
            html += `<span class="log-group group-${clipped.finalGroup}">${clipped.finalGroup}</span>`;
            html += `<span class="log-subtag">clipped</span>`;
            html += '</div>';
        }
        html += '</div>';

    } else if (node.isProposedGroup || node.isSuperGroup) {
        // Check if this is a single-layer "group" (just show the layer)
        if (node.isSingleLayer && node.children && node.children.length === 1) {
            const layer = node.children[0];
            html += renderLayerLine(layer, depth);
        } else {
            // Render as a group with children
            html += '<div class="proposed-tree-group">';
            html += '<div class="log-group-header">';
            html += `<span class="group-icon">▼</span>`;
            html += `<span class="group-name">${node.name}</span>`;
            html += `<span class="log-group group-${node.type}">${node.type}</span>`;
            html += `<span class="log-subtag">group</span>`;
            html += `<span class="proposed-count">${node.children ? node.children.length : 0}</span>`;
            html += `<span class="log-reason">${node.reason || ''}</span>`;
            html += '</div>';

            // Children
            if (node.children) {
                for (const child of node.children) {
                    // Check if child is a sub-group or a layer
                    if (child.isProposedGroup || child.isClippingChain) {
                        html += renderProposedNode(child, depth + 1);
                    } else {
                        html += renderLayerLine(child, depth + 1);
                    }
                }
            }
            html += '</div>';
        }
    } else {
        // Single layer
        html += renderLayerLine(node, depth);
    }

    return html;
}

function renderLayerLine(layer, depth) {
    const indent = '&nbsp;&nbsp;'.repeat(depth + 1);
    let html = '';

    let subtags = "";
    if (layer.isTextLayer && layer.finalGroup !== "text" && layer.finalGroup !== "headline") {
        subtags += `<span class="log-subtag">text</span>`;
    }
    if (layer.isClipped) {
        subtags += `<span class="log-subtag">clipped</span>`;
    }

    let alphaInfo = "";
    if (layer.hasAlphaData && layer.opaquePixelRatio < 0.95) {
        alphaInfo = `<span class="log-alpha">${Math.round(layer.opaquePixelRatio * 100)}%</span>`;
    }

    html += '<div class="log-line">';
    html += `<span class="log-indent">${indent}</span>`;
    html += `<span class="log-name">${layer.name}</span>`;
    html += `<span class="log-type">${layer.kind || ''}</span>`;
    html += alphaInfo;
    html += `<span class="log-group group-${layer.finalGroup || 'unknown'}">${layer.finalGroup || 'unknown'}</span>`;
    html += subtags;
    html += '</div>';

    return html;
}

// =====================================================
// MAIN ANALYSIS PIPELINE
// =====================================================

async function runAnalysis() {
    const logEl = document.getElementById("log");

    try {
        const doc = app.activeDocument;
        if (!doc) {
            if (logEl) logEl.innerHTML = '<div class="empty">No document open</div>';
            return;
        }

        console.log("\n========================================");
        console.log("PS Helper - Advanced Layer Analysis v2");
        console.log("========================================\n");

        // Pre-step: Unlock Background layer if present
        console.log("Pre-check: Background layer...");
        await unlockBackgroundLayer(doc);

        // Pre-step: Auto-delete hidden layers if toggle is on
        const autoDeleteToggle = document.getElementById("autoDeleteHiddenToggle");
        if (autoDeleteToggle && autoDeleteToggle.checked) {
            console.log("Pre-step: Auto-deleting hidden layers...");
            const deleteResult = await deleteHiddenLayers();
            console.log(`  ${deleteResult.message}`);
        }

        // Phase 1: Collect all layer data
        console.log("Phase 1: Collecting layer data...");
        let layers = await collectAllLayers(doc);
        console.log(`  Found ${layers.length} layers`);

        // Phase 2: Build relationships
        console.log("Phase 2: Building relationships...");
        const { byId } = buildRelationships(layers);

        // Phase 3: Rule-based classification (NEW v3 engine)
        console.log("Phase 3: Classifying layers...");
        for (const layer of layers) {
            if (layer.isGroup) {
                // Groups will be classified based on children later
                layer.finalGroup = "group";
                layer.confidence = 50;
                layer.reason = "group container";
                layer.signals = [];
                continue;
            }

            // Add stack position for classification
            layer.stackPosition = layer.index / Math.max(layers.length - 1, 1);

            // Run rule-based classification
            const classification = classifyLayer(layer);
            layer.finalGroup = classification.category;
            layer.confidence = classification.confidence;
            layer.reason = classification.reasons.join("; ");
            layer.classificationRule = classification.rule;
            layer.signals = []; // For backwards compatibility

            console.log(`  ${layer.name}: ${classification.category} (${classification.confidence}%) [${classification.rule}]`);
        }

        // Phase 4: HOLISTIC CONTEXT ANALYSIS
        // Look at ALL layers together and adjust based on patterns
        console.log("Phase 4: Holistic context analysis...");
        applyHolisticContext(layers);

        // Phase 5: Group classification (based on children)
        console.log("Phase 5: Classifying groups...");
        classifyGroups(layers, byId);

        // Phase 6: Subject fallback (renumbered)
        console.log("Phase 5: Subject analysis...");
        const subjectContext = analyzeSubjectContext(layers);
        console.log(`  Document type: ${subjectContext.documentType}`);
        console.log(`  Has subject: ${subjectContext.hasSubject}`);
        if (subjectContext.likelySubject && !subjectContext.hasSubject) {
            console.log(`  Applying subject fallback: ${subjectContext.likelySubject.name}`);
            subjectContext.likelySubject.finalGroup = "subject";
            subjectContext.likelySubject.confidence = Math.min(subjectContext.likelySubject.confidence + 20, 80);
            subjectContext.likelySubject.reason += "; likely subject fallback";
        }

        // Phase 6: Post-processing
        console.log("Phase 6: Post-processing...");
        layers = postProcess(layers);

        // Phase 7: Chaos detection & proposed structure
        console.log("Phase 7: Detecting chaos & building proposals...");
        const chaos = detectChaos(layers, byId);
        const proposed = buildProposedStructure(layers, chaos);

        // Store for commit button
        lastProposedStructure = proposed;

        console.log(`  Found ${chaos.messyGroups.length} messy groups`);
        console.log(`  Found ${chaos.clippingChains.length} clipping chains`);

        // Debug: show what's in proposed tree
        console.log(`\n  Proposed tree (${proposed.tree.length} nodes):`);
        for (const node of proposed.tree) {
            const childCount = node.children ? node.children.length : 0;
            const single = node.isSingleLayer ? " [SINGLE]" : "";
            console.log(`    - "${node.name}" (${node.type}) ${childCount} children${single}`);
        }

        // Calculate stats
        const stats = {};
        for (const layer of layers) {
            stats[layer.finalGroup] = (stats[layer.finalGroup] || 0) + 1;
        }

        // Console output
        console.log("\n=== ANALYSIS RESULTS ===");
        console.log(`Document: ${doc.name} (${doc.width}x${doc.height})`);
        console.log(`Total layers: ${layers.length}`);
        console.log("------------------------\n");

        for (const layer of layers) {
            const indent = "  ".repeat(layer.depth);
            const voteInfo = Object.entries(layer.votes)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([g, v]) => `${g}:${v}`)
                .join(" ");

            // Build alpha info string from real pixel data
            let alphaInfo = "";
            if (layer.hasAlphaData && layer.opaquePixelRatio < 0.95) {
                alphaInfo = ` [${Math.round(layer.opaquePixelRatio * 100)}% opaque]`;
            }

            // Build subtags
            let subtags = [];
            if (layer.isGroup) subtags.push("group");
            if (layer.isClipped || layer.isClippedTo) subtags.push("clipped");
            if (layer.isTextLayer && layer.finalGroup !== "text" && layer.finalGroup !== "headline") subtags.push("text");

            const subtagStr = subtags.length > 0 ? ` (${subtags.join(", ")})` : "";

            console.log(`${indent}[${layer.finalGroup.toUpperCase()}]${subtagStr} ${layer.name}${alphaInfo}`);
            console.log(`${indent}  → ${layer.reason}`);
            console.log(`${indent}  → votes: ${voteInfo} (${layer.confidence}% confidence)`);
        }

        console.log("\n------------------------");
        console.log("STATS:");
        for (const [group, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${group}: ${count}`);
        }

        // Log chaos detection results
        console.log("\n=== CHAOS DETECTION ===");

        if (chaos.clippingChains.length > 0) {
            console.log("\nClipping Chains:");
            for (const chain of chaos.clippingChains) {
                console.log(`  ${chain.base.name} (base)`);
                for (const clipped of chain.clippedLayers) {
                    console.log(`    ↳ ${clipped.name}`);
                }
            }
        }

        if (chaos.messyGroups.length > 0) {
            console.log("\nMessy Groups:");
            for (const mg of chaos.messyGroups) {
                const typeSummary = Object.entries(mg.types).map(([t, c]) => `${t}:${c}`).join(", ");
                console.log(`  ${mg.group.name} → ${typeSummary}`);
                console.log(`    Suggestion: ${mg.suggestion}`);
            }
        }

        if (chaos.proposedGroups.length > 0) {
            console.log("\nProposed New Groups:");
            for (const pg of chaos.proposedGroups) {
                console.log(`  [${pg.type.toUpperCase()}] ${pg.name} (${pg.layers.length} layers)`);
                for (const layer of pg.layers.slice(0, 3)) {
                    console.log(`    → ${layer.name}`);
                }
                if (pg.layers.length > 3) {
                    console.log(`    ... and ${pg.layers.length - 3} more`);
                }
            }
        }

        console.log("========================\n");

        // Build parent name map for hierarchy display
        const parentNames = new Map();
        for (const layer of layers) {
            if (layer.isGroup) {
                parentNames.set(layer.id, layer.name);
            }
        }

        // =====================================================
        // BUILD HTML - ORIGINAL VIEW
        // =====================================================
        let html = "";

        // Document context banner
        html += '<div class="doc-context">';
        html += `<span class="doc-type">${subjectContext.documentType}</span>`;
        html += `<span class="doc-info">${layers.length} layers</span>`;
        if (subjectContext.hasSubject) {
            html += `<span class="doc-has-subject">Has Subject</span>`;
        } else if (subjectContext.likelySubject) {
            html += `<span class="doc-likely-subject">Likely: ${subjectContext.likelySubject.name}</span>`;
        } else {
            html += `<span class="doc-no-subject">No Subject</span>`;
        }
        html += '</div>';

        html += '<div class="section-header">CURRENT STRUCTURE</div>';
        html += '<div class="view-panel">';

        // Track open groups to close their divs
        let openGroupDepths = [];

        for (let idx = 0; idx < layers.length; idx++) {
            const layer = layers[idx];
            const nextLayer = layers[idx + 1];

            // Close any groups that are done (next layer is at same or lower depth)
            while (openGroupDepths.length > 0 && openGroupDepths[openGroupDepths.length - 1] >= layer.depth) {
                html += '</div>'; // close current-group
                openGroupDepths.pop();
            }

            if (layer.isGroup) {
                // Start group container
                html += `<div class="current-group" style="margin-left: ${layer.depth * 8}px;">`;
                openGroupDepths.push(layer.depth);

                // Render group header
                html += `<div class="log-group-header">`;
                html += `<span class="group-icon">▼</span>`;
                html += `<span class="group-name">${layer.name}</span>`;
                html += `<span class="log-group group-${layer.finalGroup}">${layer.finalGroup}</span>`;
                html += `<span class="log-subtag">group</span>`;
                html += `<span class="log-confidence">${layer.confidence}%</span>`;
                html += `<span class="log-reason">${layer.reason}</span>`;
                html += '</div>';

            } else {
                // Render regular layer
                const indentPx = layer.depth * 8;

                // Alpha/fill info
                let alphaInfo = "";
                if (layer.hasAlphaData && layer.opaquePixelRatio < 0.95) {
                    alphaInfo = `<span class="log-alpha">${Math.round(layer.opaquePixelRatio * 100)}%</span>`;
                }

                // Build subtags
                let subtags = "";
                if (layer.isClipped || layer.isClippedTo) {
                    subtags += `<span class="log-subtag">clipped</span>`;
                }
                if (layer.isTextLayer && layer.finalGroup !== "text" && layer.finalGroup !== "headline") {
                    subtags += `<span class="log-subtag">text</span>`;
                }

                html += `<div class="log-line" style="padding-left: ${indentPx + 10}px;">`;
                html += `<span class="log-name">${layer.name}</span>`;
                html += `<span class="log-type">${layer.kind}</span>`;
                html += alphaInfo;
                html += `<span class="log-group group-${layer.finalGroup}">${layer.finalGroup}</span>`;
                html += subtags;
                html += `<span class="log-confidence">${layer.confidence}%</span>`;
                html += `<span class="log-reason">${layer.reason}</span>`;
                html += '</div>';
            }
        }

        // Close any remaining open groups
        while (openGroupDepths.length > 0) {
            html += '</div>';
            openGroupDepths.pop();
        }

        // Stats
        html += '<div class="stats">';
        html += `<div class="stat-line"><span>Total layers:</span><span class="stat-count">${layers.length}</span></div>`;
        for (const [group, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
            html += `<div class="stat-line"><span>${group}:</span><span class="stat-count">${count}</span></div>`;
        }
        html += '</div>';
        html += '</div>'; // end view-panel

        // =====================================================
        // BUILD HTML - PROPOSED STRUCTURE VIEW (Reorganized Tree)
        // =====================================================
        html += '<div class="section-header proposed-header">PROPOSED STRUCTURE</div>';
        html += '<div class="view-panel proposed-panel">';

        // Render super-groups if available
        if (proposed.superGroups && proposed.superGroups.length > 0) {
            for (const superGroup of proposed.superGroups) {
                html += renderSuperGroup(superGroup);
            }
        } else {
            // Fallback: render the flat tree
            for (const node of proposed.tree) {
                html += renderProposedNode(node, 0);
            }
        }

        // Show messy groups warnings at the bottom
        if (chaos.messyGroups.length > 0) {
            html += '<div class="chaos-warning-section">';
            html += '<div class="proposed-title chaos-title">⚠ Messy Groups in Original</div>';
            for (const mg of chaos.messyGroups) {
                html += '<div class="messy-group">';
                html += `<div class="messy-group-name">${mg.group.name}</div>`;
                html += `<div class="messy-types">`;
                for (const [type, count] of Object.entries(mg.types)) {
                    html += `<span class="log-group group-${type}">${type}:${count}</span>`;
                }
                html += '</div>';
                html += '</div>';
            }
            html += '</div>';
        }

        // Stats for proposed
        html += '<div class="stats">';
        html += `<div class="stat-line"><span>Proposed groups:</span><span class="stat-count">${proposed.tree.length}</span></div>`;
        html += `<div class="stat-line"><span>Clipping chains:</span><span class="stat-count">${chaos.clippingChains.length}</span></div>`;
        html += '</div>';

        html += '</div>'; // end proposed-panel

        if (logEl) logEl.innerHTML = html;

    } catch (e) {
        console.error("Analysis error:", e);
        if (logEl) logEl.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    }
}
// =====================================================
// INIT
// =====================================================

document.addEventListener("DOMContentLoaded", async () => {
    // Load color settings (shared by both UIs)
    await loadColorSettings();

    // ===== RELEASE UI BUTTONS =====
    const organizeBtn = document.getElementById("organizeBtn");
    if (organizeBtn) {
        // Release UI: color grid
        updateColorUI();
        setupColorHandlers();

        // Reset colors button
        const resetBtn = document.getElementById("resetBtn");
        if (resetBtn) {
            resetBtn.onclick = async () => {
                colorSettings = Object.assign({}, DEFAULT_COLORS);
                await saveColorSettings();
                updateColorUI();
            };
        }

        // Delete Hidden button (release) - eye icon
        const releaseDeleteBtn = document.getElementById("releaseDeleteHiddenBtn");
        if (releaseDeleteBtn) {
            releaseDeleteBtn.onclick = async () => {
                try {
                    await core.executeAsModal(async () => {
                        const result = await deleteHiddenLayers();
                        setStatus(result.message, result.deletedCount > 0 ? "success" : "");
                    }, { commandName: "Delete Hidden Layers" });
                } catch (e) {
                    setStatus("Error: " + e.message, "error");
                }
            };
        }

        // Undo organize button
        const undoBtn = document.getElementById("undoOrganizeBtn");
        let hasOrganizeSnapshot = false;

        if (undoBtn) {
            undoBtn.onclick = async () => {
                if (!hasOrganizeSnapshot) return;
                try {
                    await core.executeAsModal(async () => {
                        await action.batchPlay([{
                            _obj: "select",
                            _target: [{ _ref: "snapshotClass", _name: "Pre-Organize" }]
                        }], { synchronousExecution: true });
                        hasOrganizeSnapshot = false;
                        undoBtn.classList.add("disabled");
                    }, { commandName: "Undo Organize" });
                } catch (e) {
                    console.error("Undo error: " + e.message);
                }
            };
        }

        // Main organize button
        organizeBtn.onclick = async () => {
            const originalText = organizeBtn.textContent;
            organizeBtn.textContent = "Organizing...";
            organizeBtn.disabled = true;
            setStatus("Analyzing layers...", "working");

            try {
                await core.executeAsModal(async () => {
                    // Take a history snapshot before organizing
                    await action.batchPlay([{
                        _obj: "make",
                        _target: [{ _ref: "snapshotClass" }],
                        from: { _ref: "historyState", _property: "currentHistoryState" },
                        name: "Pre-Organize",
                        using: { _enum: "historyState", _value: "fullDocument" }
                    }], { synchronousExecution: true });

                    setStatus("Analyzing layers...", "working");
                    const result = await runAnalysis();

                    if (!result && !lastProposedStructure) {
                        setStatus("No document open", "error");
                        return;
                    }

                    if (lastProposedStructure) {
                        setStatus("Organizing structure...", "working");
                        const commitResult = await commitProposedStructure(lastProposedStructure);

                        setStatus("Merging groups...", "working");
                        await mergeConsecutiveSameNamedGroups();

                        await runAnalysis();
                        setStatus("Done! Layers organized.", "success");

                        // Enable undo button
                        hasOrganizeSnapshot = true;
                        if (undoBtn) undoBtn.classList.remove("disabled");
                    } else {
                        setStatus("No changes needed", "success");
                    }
                }, { commandName: "Organize Layers" });
            } catch (e) {
                console.error("Organize error: " + e.message);
            } finally {
                organizeBtn.textContent = "Organize Layers";
                organizeBtn.disabled = false;
            }
        };
    }

});
