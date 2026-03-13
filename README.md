# Intelligent Layer Classification System
*This plugin was created using Claude Code - I encourage you, the user, to train it yourself and modify the signal system to fit your needs. Refer to the "Hive-Mind" MD file for more context. 
---
## How to Install

To install this plugin into your PS, you can do it three ways:
0- Double click .ccx file
1- Use the Adobe UXP software, and select the manifest file; from there load into Photoshop
2- Place the plugin folder inside the UXP folder - Refer to: https://www.youtube.com/watch?v=BY9-3mhR3Vc


## Overview

Layer Organizer is a Photoshop UXP plugin that automatically classifies and organizes layers using a weighted voting system called **The Hive-Mind**. The system accumulates evidence from multiple signals—layer properties, naming patterns, pixel analysis, spatial relationships—and determines classification through consensus rather than rigid decision trees.

The system answers a fundamental challenge in design automation: **How do you teach a machine to "see" what a human sees when they glance at a layer stack?**

---

## The Problem

Professional Photoshop documents are chaos. A typical esports graphic might have:
- 50+ layers with generic names like "Layer 23", "Rectangle 1 copy"
- Textures, effects, and adjustments scattered throughout
- Player photos clipped to frames
- Logos in corners
- Backgrounds buried at the bottom

A human can glance at this and instantly understand the structure. A computer sees only rectangles with pixel data.

**Traditional approaches fail because:**
- Single-rule systems can't handle the nuance ("Rectangle 1" could be a logo frame, a subject frame, or just a shape)
- Edge cases break rigid logic
- Context matters enormously (a layer alone means little; a layer in context reveals truth)

---

## The Philosophy: The Hive-Mind

The Hive-Mind is not a decision tree. It's a **collective intelligence**—a system where every signal, every pattern, every piece of context contributes a vote toward understanding what a layer truly is.

> "No single signal is definitive. But together? Confident classification."

Like a swarm of bees, no single bee decides where the hive goes. The collective behavior emerges from thousands of small signals, each contributing their piece of truth.

Traditional classification asks: "What rule does this match?"
The Hive-Mind asks: "What do all the signals collectively believe this is?"

---

## Classification Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│  PHASE 1: DATA COLLECTION                                    │
│  Extract all layer properties: bounds, blend mode, opacity,  │
│  clipping state, masks, kind                                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 2: PIXEL ANALYSIS (Imaging API)                       │
│  Full-resolution alpha analysis:                             │
│  - solidContentRatio (alpha > 200)                          │
│  - softContentRatio (alpha 20-150)                          │
│  - boundsFilledRatio (actual content vs bounding box)       │
│  - colorVariance, dominantColorCount                        │
│  - hasGradientAlpha (wide alpha transitions)                │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 3: DEFINITIVE RULES                                   │
│  Layer type determines classification (no override):         │
│  - adjustment layers → adjustment (95% confidence)          │
│  - solidColor/gradientFill/patternFill → fill (90%)         │
│  - text layers → text (90%)                                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 4: EXPLICIT NAME RULES                                │
│  Name contains category keyword:                             │
│  - "logo", "watermark" → logo                               │
│  - "background", "bg" → background                          │
│  - "subject", "player" → subject                            │
│  - "texture", "grain" → texture                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 5: INFERRED RULES (Weighted Voting)                   │
│  Each signal casts weighted votes:                           │
│                                                              │
│  scores = { logo: 0, subject: 0, background: 0,             │
│             texture: 0, graphics: 0, effect: 0, fill: 0 }   │
│                                                              │
│  if (inCorner && isSmall) scores.logo += 35                 │
│  if (looksLikeHumanName) scores.subject += 55               │
│  if (isClipped) scores.background -= 100                    │
│  if (hasBlendMode && fullCoverage) scores.texture += 60     │
│                                                              │
│  Winner = highest score (if >= 20)                          │
│  Confidence = base + score/2 + margin/4                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 6: HOLISTIC CONTEXT ANALYSIS                          │
│  - Guardrails: Enforce type constraints                     │
│  - Sequence detection: Similar layers vote together         │
│  - True background detection: Find solid base               │
│  - Clipping chain analysis: Frame + subject = both subject  │
│  - Sibling consensus: Adjacent soft elements align          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  FINAL OUTPUT                                                │
│  { category, confidence, rule, reasons[] }                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Layer Categories

| Category | Description |
|----------|-------------|
| **background** | Solid base layer at bottom of stack. Full coverage, full alpha, normal blend, not clipped. |
| **subject** | Main focal elements (people, products). Human names, team prefixes, camera filenames, centered position, clipped to frame. |
| **texture** | Overlay layers (grain, noise, lighting). Blend modes, full coverage, reduced opacity. |
| **graphics** | Shapes, borders, decorative elements. Generic shape names, thin elements, borders. |
| **logo** | Brand marks, watermarks. Small size, corner position, intentional naming. |
| **text** | Text layers. Definitive by layer kind. |
| **fill** | Solid colors, gradients. Clipped layers, single color content. |
| **effect** | Glows, flares, soft light effects. Soft alpha content (>40% soft pixels), small coverage. |
| **adjustment** | Color/tonal adjustments. Definitive by layer kind (curves, levels, hueSaturation, etc.). |

---

## Signal Evidence System

### Evidence Gathered Per Layer

```javascript
{
  // Layer type
  isTextLayer, isAdjustment, isFill, isShape, isSmartObject, isPixel,

  // Name patterns
  nameContainsLogo, nameContainsBackground, nameContainsSubject,
  nameContainsTexture, nameContainsEffect, nameContainsLighting,
  hasIntentionalName, looksLikeHumanName, hasDateInName,
  hasTeamPrefix, hasCameraFileName, isGenericShapeName,
  looksLikeTextContent,

  // Coverage & geometry
  coverage, boundsFilledRatio,
  isFullCoverage (>90% + >70% bounds fill),
  isLargeCoverage (>50%), isSmallElement (<15%), isTinyElement (<5%),
  isThinElement (boundsFilledRatio < 0.3),

  // Alpha metrics (from pixel analysis)
  solidContentRatio, softContentRatio, opaqueRatio,
  isSolidElement (>60% solid), isSoftElement (>40% soft),
  hasGradientAlpha (wide alpha transitions),
  isSparse (<50% solid), isVerySparse (<25%),

  // Color metrics
  isSingleColor, isLowColorVariance, colorVariance, dominantColorCount,

  // Position
  isTopOfStack, isBottomOfStack,
  isInCorner, isInTrueCorner, isCentered,
  isVerticalBorder, isHorizontalBorder,
  spansFullHeight, spansFullWidth,

  // Blend mode
  hasOverlayBlend, hasMultiplyBlend, hasScreenBlend, hasNonNormalBlend,

  // Opacity
  hasLowOpacity (<50%), hasVeryLowOpacity (<25%),

  // Relationships
  isClipped, hasClippedContent, hasClippedAdjustment,
  hasMask, hasMaskRestriction (reveals <50%)
}
```

---

## Scoring Rules (Key Examples)

### Background
```
+50: full coverage + full alpha + normal blend + high opacity + not sparse + not clipped
+30: bottom of stack (bonus)
-100: is clipped (NEVER background)
-40: has texture blend or reduced opacity
-50: mask reveals only small area
-30: frame shape (coverage without full alpha)
```

### Subject
```
+65: camera filename (DSCF####, IMG_####)
+55: team/org prefix (NRG_, 100T_, FaZe_)
+55: masked photo cutout (multi-color smart object with mask)
+40: large centered element (not full coverage)
+30: name looks like human name
+25: date pattern in name
```

### Texture
```
+60: full coverage + blend mode (overlay/multiply/screen)
+55: full coverage + reduced opacity (<90%)
+55: soft overlay (large coverage + soft element)
+45: high fill + blend mode
+40: name suggests lighting
```

### Logo
```
+35: small corner element + not sparse
+25: smart object in corner
+20: true corner position (non-text)
-100: team prefix (players, not logos)
-60: vertical/horizontal border
-50: generic shape name ("Rectangle 1")
```

### Graphics
```
+55: shape layer
+50: vertical/horizontal border/stripe
+45: frame shape (coverage without full alpha)
+45: name looks like text content (rasterized text)
+40: generic shape name
+50: thin element (low bounds fill ratio)
```

### Effect
```
+55: soft element + small/medium coverage
+45: faded edges + low opacity (glow pattern)
+40: mask reveals only small area
+35: screen blend + soft content
+35: gradient light element (localized)
```

---

## Context Detection Systems

### 1. Sequence Detection
Adjacent layers with similar properties are detected and vote together.

**Similarity scoring:**
- Both generic names (Layer X): +3
- Both have blend modes: +2
- Same blend mode: +2
- Both sparse: +2
- Similar coverage (±20%): +1
- Both soft elements: +2

If similarity >= 4 AND both have generic names AND 3+ layers: sequence forms.
Majority classification wins, all members align.

### 2. Clipping Chain Analysis
```
Rectangle 1 (hasClippedLayers: true)
  └─ DRYAD (1) (isClipped: true, looksLikeHumanName: true)
```
- Base layer with clipped content analyzed as unit
- If clipped layer is subject (human name, photo-like colors): base becomes subject-frame
- Both receive subject classification and stay grouped

### 3. True Background Detection
Scans from bottom of stack to find the first layer that is:
- Full coverage (>85%)
- Full alpha (opaqueRatio >= 85%)
- Actually fills bounds (boundsFilledRatio >= 80%)
- Normal blend mode
- High opacity (>90%)
- NOT clipped
- NOT adjustment/fill/text layer

All full-coverage layers ABOVE true background with blend modes or reduced opacity → texture.

### 4. Guardrails (Enforced Constraints)
```
Adjustment layers → ALWAYS adjustment
Fill layers → ALWAYS fill (never background)
Text layers → ALWAYS text/headline/caption
Clipped layers → NEVER background (become fill)
Frame shapes (high coverage, low alpha) → NEVER background
Thin elements (low boundsFilledRatio) → NEVER background
```

### 5. Sibling Consensus
Adjacent soft elements (effect/texture confusion) within same parent:
- If 3+ consecutive soft elements have mixed effect/texture
- Apply majority vote
- Ties broken by stack position (top = effect, bottom = texture)

---

## Pixel Analysis Deep Dive

The system uses Photoshop's Imaging API at **full resolution** for accurate classification.

### Alpha Ranges
```
0-20:     Transparent (not counted as visible)
21-150:   Soft content (glows, soft brushes, effects)
151-200:  Semi-solid (anti-alias or soft edge)
201-250:  Near-opaque (anti-aliased edges of solid content)
251-255:  Fully opaque (solid content)
```

### Critical Metrics
| Metric | Formula | Classification Impact |
|--------|---------|----------------------|
| `solidContentRatio` | solidPixels / visiblePixels | >0.6 = solid element (logo, graphic, subject) |
| `softContentRatio` | softPixels / visiblePixels | >0.4 = soft element (glow, effect) |
| `boundsFilledRatio` | visiblePixels / totalPixels | <0.3 = thin element (line, cross) |
| `opaquePixelRatio` | opaquePixels / visiblePixels | <0.85 = has transparency holes (not background) |

### Why This Matters
A 2px cross spanning the document has:
- High coverage (bounds fill canvas)
- High opaqueRatio (the pixels that exist are solid)
- **Low boundsFilledRatio** (most of the bounding box is empty)

Without boundsFilledRatio, this would incorrectly classify as background. With it → graphics.

---

## Training System

### Correction Flow
1. User runs analysis on document
2. System classifies each layer with confidence and reasoning
3. User corrects mistakes via UI picker
4. Corrections saved with full context:

```json
{
  "layerName": "Layer 22",
  "layerKind": "pixel",
  "systemClassification": "background",
  "correctedClassification": "fill",
  "systemConfidence": 72,
  "systemReason": "full coverage + normal blend",
  "comment": "Clipped to group, gradient alpha indicates color overlay",
  "documentName": "project.psd",
  "createdAt": "2026-02-03T14:30:00Z"
}
```

### Training Insights Applied
- Clipping masks change meaning (background → fill)
- Frame + clipped subject = both are "subject" conceptually
- Gradient alpha + single color = fill
- Sequences of similar gradient elements = texture group
- Rasterized text has no text signal → classify as graphics
- Camera filenames (DSCF####, IMG_####) = subject photos
- Team prefixes (NRG_, 100T_) = players, not logos

---

## Results

| Document | Layers | Correct | Accuracy |
|----------|--------|---------|----------|
| Casting talent IGS.psd | 26 | 26 | 100% |

Classification breakdown:
- 1 background (name + position + coverage)
- 6 subjects (human names, clipped to frames)
- 6 subject-frames (Rectangle + hasClippedLayers)
- 8 textures (blend modes, overflow coverage)
- 2 logos (corner position, smart objects)
- 1 fill (exact canvas coverage, middle stack)
- 1 adjustment (layer kind)
- 1 graphics (rasterized text, no text signal available)

---

## Why It Works

1. **Many weak signals align** — No single signal is definitive, but 10 signals all pointing the same direction creates certainty.

2. **Context resolves ambiguity** — A sparse layer alone is unclear. A sparse layer in a sequence of 5 similar layers is obviously texture.

3. **Relationships reveal truth** — A rectangle alone means nothing. A rectangle with a person clipped to it is a subject frame.

4. **The collective is smarter than the parts** — Individual signals make mistakes. The voting system corrects them through consensus.

5. **Guardrails prevent impossible states** — Clipped layers can never be background. Adjustment layers can never be texture. The system enforces what it knows to be true.

---

## Summary

The Hive-Mind is:
- **Additive** — Signals accumulate, never eliminate
- **Democratic** — Every signal votes, no dictators
- **Contextual** — Neighbors influence classification
- **Confident through consensus** — Many agreeing signals = high confidence
- **Emergent** — Complex behavior from simple rules

The system doesn't follow rules. The system **recognizes patterns**.

---

*"You are adding the icing, adding more toppings always; never eating away of the current hive."*
