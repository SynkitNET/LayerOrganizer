# THE HIVE-MIND
## A Living Classification System for Photoshop Layers

---

## Philosophy

The Hive-Mind is not a decision tree. It is not a series of if-else statements. It is a **collective intelligence** - a system where every signal, every pattern, every piece of context contributes a vote toward understanding what a layer truly is.

Traditional classification asks: "What rule does this match?"
The Hive-Mind asks: "What do all the signals collectively believe this is?"

Like a swarm of bees, no single bee decides where the hive goes. The collective behavior emerges from thousands of small signals, each contributing their piece of truth. The answer emerges from the whole.

---

## Core Principles

### 1. Signals, Not Rules
Every observation about a layer becomes a **signal**. A signal is not a decision - it's a vote with a weight.

```
Signal: "Layer is in corner"
  → Votes: logo +20, graphics +5
  → Does NOT decide: "This IS a logo"
```

### 2. Accumulation, Not Elimination
Traditional systems eliminate possibilities. The Hive accumulates evidence.

```
Traditional: Is it text? No → Is it shape? No → Is it...
Hive-Mind:   text: 0, shape: 15, logo: 45, subject: 80, graphics: 30
             Winner: subject (80 points)
```

### 3. Context is King
A layer alone means little. A layer in context reveals truth.

```
Layer 23 alone: "sparse pixel layer" → graphics?
Layer 23 with 4 similar neighbors: "part of lighting sequence" → texture
```

### 4. Confidence Through Consensus
High confidence comes not from one strong signal, but from many signals agreeing.

```
Low confidence:  One signal says "logo" (+60)
High confidence: Five signals all point to "logo" (+15, +20, +10, +25, +15 = 85)
```

---

## Signal Categories

### Tier 1: Definitive Signals (Weight: 85-95)
These are truths that cannot be overridden. The layer type itself speaks.

| Signal | Classification | Weight |
|--------|---------------|--------|
| Layer kind is `hueSaturation` | adjustment | 95 |
| Layer kind is `solidColor` | fill | 90 |
| Layer kind is `text` | text | 90 |

*These signals end the conversation for that layer.*

### Tier 2: Strong Evidence (Weight: 50-80)
Clear indicators that strongly suggest classification.

| Signal | Votes For | Weight |
|--------|-----------|--------|
| Name contains "logo" | logo | 75 |
| Name contains "background" | background | 70 |
| Clipped to shape frame | subject | 65 |
| Full coverage + bottom of stack | background | 60 |
| Name looks like human name | subject | 55 |

### Tier 3: Supporting Evidence (Weight: 30-50)
Patterns that support but don't confirm.

| Signal | Votes For | Weight |
|--------|-----------|--------|
| Smart object + centered | subject | 40 |
| Small + corner position | logo | 35 |
| Sparse + blend mode | texture | 45 |
| Full coverage + blend mode | texture | 40 |

### Tier 4: Contextual Hints (Weight: 15-30)
Weak individual signals that become strong in combination.

| Signal | Votes For | Weight |
|--------|-----------|--------|
| Generic name (Layer X) | - | context |
| Part of similar sequence | (sequence vote) | 25 |
| Near text layer | graphics | 15 |
| Similar to sibling layers | (sibling vote) | 20 |

### Tier 5: Micro-Signals (Weight: 5-15)
Tiny nudges that break ties.

| Signal | Votes For | Weight |
|--------|-----------|--------|
| Has intentional name | subject/logo | 10 |
| Specific blend mode | texture | 5 |
| Position in stack | various | 5 |

---

## The Voting System

Every layer goes through the signal gauntlet. Each signal that applies casts its vote.

```javascript
scores = {
  logo: 0,
  subject: 0,
  background: 0,
  texture: 0,
  graphics: 0,
  text: 0,
  fill: 0,
  adjustment: 0
}

// Signals vote
if (inCorner && isSmall) scores.logo += 35;
if (looksLikeHumanName) scores.subject += 55;
if (hasBlendMode && isFullCoverage) scores.texture += 40;
if (isSparse && hasBlendMode) scores.texture += 45;
if (isSparse && !hasBlendMode) scores.graphics += 50;

// Winner takes all
winner = max(scores)
confidence = calculateConfidence(scores)
```

### Confidence Calculation
Confidence reflects how decisive the victory was.

```
margin = winner_score - second_place_score
base_confidence = 45 + (winner_score / 2)
confidence = min(95, base_confidence + margin / 4)
```

A landslide victory = high confidence.
A narrow victory = low confidence (uncertain).

---

## Context Detection Systems

### 1. Sequence Detection
The Hive looks for patterns in neighboring layers.

```
Layers: [Layer 16, Layer 17, Layer 18, Layer 19, Layer 23]

Analysis:
- All have generic names (Layer X pattern)
- All are sparse
- All have blend modes
- All have similar coverage

Conclusion: These form a SEQUENCE
Action: They vote together, majority wins
Result: All become "texture" (unified)
```

**Similarity Score:**
| Pattern | Score |
|---------|-------|
| Both generic names | +3 |
| Both have blend modes | +2 |
| Same blend mode | +2 |
| Both sparse | +2 |
| Similar coverage (±30%) | +1 |
| Same color type | +1 |

*Score ≥ 3 = part of sequence*

### 2. Clipping Chain Analysis
Clipped layers reveal relationships.

```
Rectangle 1 (base)
  ↳ DRYAD (1) (clipped)

Analysis:
- DRYAD looks like human name → subject signal
- Rectangle is a frame shape
- Subject clipped to frame = portrait composition

Action: Both become "subject" (frame + content = one unit)
```

### 3. Group Membership
Layers in the same group influence each other.

```
Group "Players":
  - NRG_Ethan
  - NRG_Atomic
  - NRG_Daniel

Analysis:
- All have team prefix (NRG_)
- All in same group
- Group name suggests subjects

Action: Boost subject score for all members
```

### 4. Spatial Relationships
Position reveals purpose.

```
Layer at (95%, 5%) → corner → logo territory
Layer at (50%, 50%) → centered → subject territory
Layer at (50%, 95%) → bottom center → caption territory
```

### 5. Stack Position Context
Where you are in the stack matters.

```
Bottom of stack + full coverage → background
Top of stack + blend mode → effect/texture
Middle of stack + clipped → supporting element
```

---

## The Classification Flow

```
┌─────────────────────────────────────────────────────────┐
│                    LAYER INPUT                          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              PHASE 1: DEFINITIVE RULES                  │
│  Is it adjustment? Fill? Text? (Type-based certainty)   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              PHASE 2: SIGNAL GATHERING                  │
│  Collect ALL signals: name, position, alpha, color,     │
│  blend mode, coverage, sparseness, clipping...          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              PHASE 3: VOTING                            │
│  Each signal casts weighted votes for categories        │
│  Scores accumulate across all signals                   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              PHASE 4: HOLISTIC CONTEXT                  │
│  Sequence detection, clipping analysis, spatial         │
│  relationships, group membership, stack position        │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              PHASE 5: CONSENSUS                         │
│  Context can override individual classifications        │
│  Sequences vote together, majority wins                 │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              PHASE 6: FINAL CLASSIFICATION              │
│  Winner = highest score                                 │
│  Confidence = margin of victory                         │
└─────────────────────────────────────────────────────────┘
```

---

## Adding New Signals

The Hive grows by adding signals. Never remove - only add.

### Anatomy of a Signal

```javascript
// In gatherEvidence():
const hasNewPattern = /somepattern/i.test(name);

// Return it:
return {
  ...existingEvidence,
  hasNewPattern: hasNewPattern
};

// In applyInferredRules():
if (e.hasNewPattern) {
  scores.targetCategory += WEIGHT;
  reasons.targetCategory.push("description of signal");
}
```

### Signal Design Principles

1. **Observe the pattern** - What makes you know this is X?
2. **Find the data** - What property reveals this pattern?
3. **Choose the weight** - How confident is this signal alone?
4. **Consider negatives** - Should this reduce other scores?
5. **Test edge cases** - Does this break other classifications?

### Example: Adding a "Player Name" Signal

```javascript
// Observation: Esports player layers often have team prefixes
// Pattern: NRG_name, 100T_name, FaZe_name

// In gatherEvidence():
const hasTeamPrefix = /^(nrg|100t|faze|tsm|c9)_/i.test(name);

// In applyInferredRules():
if (e.hasTeamPrefix) {
  scores.subject += 55;  // Strong signal
  reasons.subject.push("team/org prefix (player)");
  scores.logo -= 30;     // Definitely NOT a logo
}
```

---

## The Magic Formula

Magic happens when:

1. **Many weak signals align** - No single signal is definitive, but 10 signals all pointing the same direction creates certainty.

2. **Context resolves ambiguity** - A sparse layer alone is unclear. A sparse layer in a sequence of 5 similar layers is obviously texture.

3. **Relationships reveal truth** - A rectangle alone means nothing. A rectangle with a person clipped to it is a subject frame.

4. **The collective is smarter than the parts** - Individual signals make mistakes. The voting system corrects them through consensus.

---

## Anti-Patterns (What NOT to Do)

### Don't: Create rigid decision trees
```javascript
// BAD
if (isCorner && isSmall) return "logo";
```

### Do: Let signals vote
```javascript
// GOOD
if (isCorner) scores.logo += 20;
if (isSmall) scores.logo += 15;
// Let other signals also vote
```

### Don't: Override with single signals
```javascript
// BAD
if (hasBlendMode) layer.finalGroup = "texture";
```

### Do: Boost scores, let consensus decide
```javascript
// GOOD
if (hasBlendMode) scores.texture += 35;
// The final classification comes from total scores
```

### Don't: Ignore context
```javascript
// BAD
classify(layer); // In isolation
```

### Do: Consider neighbors
```javascript
// GOOD
const sequence = findSimilarNeighbors(layer);
if (sequence.length >= 3) alignToMajority(sequence);
```

---

## The Goal

When the Hive-Mind works correctly, users should feel:

> "How does it KNOW that's a subject?"
> "It correctly identified all 5 lighting layers!"
> "It even knew the rectangle was a frame, not a shape!"

This is the magic. Not rigid rules, but emergent understanding.

The Hive doesn't follow rules. The Hive **recognizes patterns**.

---

## Future Expansions

### Visual Analysis Signals
- Edge detection (hard edges vs soft gradients)
- Color palette analysis (photo vs graphic)
- Texture pattern recognition

### Machine Learning Integration
- Train on corrections.json
- Learn user preferences
- Adaptive weights based on document type

### Cross-Document Learning
- Remember patterns across sessions
- Build user-specific signal profiles
- Industry-specific presets (esports, fashion, product)

---

## Summary

The Hive-Mind is:
- **Additive** - Signals accumulate, never eliminate
- **Democratic** - Every signal votes, no dictators
- **Contextual** - Neighbors influence classification
- **Confident through consensus** - Many agreeing signals = high confidence
- **Magical through emergence** - Complex behavior from simple rules

The Hive grows. The Hive learns. The Hive knows.

---

*"You are adding the icing, adding more toppings always; never eating away of the current hive."*
