# Mathematical Foundations for Ranking and Scoring in Heterogeneous Retrieval Systems

**Date:** 2026-03-15
**Context:** memex unified recall pipeline — merging short memory facts + long documents

---

## Table of Contents

1. [BM25: Probabilistic Derivation and Short-Document Bias](#1-bm25-probabilistic-derivation-and-short-document-bias)
2. [Score Calibration Across Heterogeneous Sources](#2-score-calibration-across-heterogeneous-sources)
3. [Cross-Encoder Reranking Theory](#3-cross-encoder-reranking-theory)
4. [Temporal Relevance Models](#4-temporal-relevance-models)
5. [Multi-Objective Ranking](#5-multi-objective-ranking)
6. [Theoretical Guarantees and Bounds](#6-theoretical-guarantees-and-bounds)
7. [Failure Modes in Current Pipeline](#7-failure-modes-in-current-pipeline)
8. [Proposed Unified Scoring Formula](#8-proposed-unified-scoring-formula)
9. [Computational Complexity Analysis](#9-computational-complexity-analysis)

---

## 1. BM25: Probabilistic Derivation and Short-Document Bias

### 1.1 Robertson-Sparck Jones Probabilistic Model

BM25 derives from the **Binary Independence Model** (BIM) of Robertson and Sparck Jones (1976).
The fundamental insight: model relevance as a probability. Given a query Q with terms
q_1, ..., q_n, the relevance score of document D is the log-odds:

```
RSV(D, Q) = log P(D | R=1) / P(D | R=0)
```

where R=1 denotes relevance. Under the term independence assumption, this decomposes:

```
RSV(D, Q) = SUM_i  log  [ p_i (1 - s_i) ]  /  [ s_i (1 - p_i) ]
```

where p_i = P(term i present | R=1) and s_i = P(term i present | R=0).

Without relevance feedback, the Robertson-Sparck Jones weight simplifies to the IDF
approximation:

```
IDF(q_i) = log  [ (N - df_i + 0.5) / (df_i + 0.5) ]
```

where N = total documents, df_i = document frequency of term i.

**Reference:** Robertson, S.E. & Sparck Jones, K. (1976). "Relevance weighting of search terms." *JASIST*, 27(3), 129-146. DOI: [10.1002/asi.4630270302](https://doi.org/10.1002/asi.4630270302)

### 1.2 Full BM25 Formula

Okapi BM25 extends the probabilistic model with **term frequency saturation** and
**document length normalization**:

```
BM25(D, Q) = SUM_{i=1}^{n}  IDF(q_i) * [ tf(q_i, D) * (k_1 + 1) ]
                                        / [ tf(q_i, D) + k_1 * (1 - b + b * |D|/avgdl) ]
```

where:
- `tf(q_i, D)` = raw term frequency of q_i in D
- `|D|` = document length (in tokens)
- `avgdl` = average document length across corpus
- `k_1` = saturation parameter (typically 1.2-2.0; controls how quickly TF saturates)
- `b` = length normalization parameter (0 to 1; typically 0.75)

**Key properties:**
- As tf -> infinity, the TF component approaches (k_1 + 1), providing saturation
- When b = 0, no length normalization is applied
- When b = 1, full length normalization: score is proportional to term density (tf/|D|)

**Reference:** Robertson, S.E. & Zaragoza, H. (2009). "The Probabilistic Relevance Framework: BM25 and Beyond." *Foundations and Trends in Information Retrieval*, 3(4), 333-389. DOI: [10.1561/1500000019](https://doi.org/10.1561/1500000019)

### 1.3 Why BM25 Fails for Short Documents (Memory Entries)

For memex's conversation memories (typically 20-200 characters), BM25 has a
**systematic short-document bias**.

**The problem:** When |D| << avgdl, the length normalization factor becomes:

```
L = 1 - b + b * |D| / avgdl
```

For a 50-char memory entry with avgdl = 500:

```
L = 1 - 0.75 + 0.75 * (50/500) = 0.25 + 0.075 = 0.325
```

The TF denominator shrinks to `tf + k_1 * 0.325`, which inflates the TF component.
This means a single keyword match in a short memory gets an unfairly high score
relative to a multi-match in a long document.

**In the heterogeneous case (memories + documents):**
- Memory entries (50 chars) get L ~ 0.325 => inflated scores
- Document chunks (500 chars) get L ~ 1.0 => normal scores
- Full documents (2000 chars) get L ~ 3.25 => deflated scores

This is precisely wrong: a keyword match in a short "API key is X" memory
should not outscore a paragraph-length explanation of how to use that API.

### 1.4 BM25+ and BM25L Corrections

**BM25+ (Lv & Zhai, 2011):** Adds a lower-bound constant delta to prevent long-document
penalty from driving TF contribution below a minimum:

```
BM25+(D, Q) = SUM_{i}  IDF(q_i) * [ tf(q_i,D) * (k_1+1)
              / (tf(q_i,D) + k_1 * (1-b+b*|D|/avgdl))  +  delta ]
```

where delta is typically set to 1.0. The additive constant ensures that matching terms
in long documents always contribute at least delta * IDF(q_i) to the score, preventing
the "vanishing TF" problem.

**Reference:** Lv, Y. & Zhai, C. (2011). "Lower-bounding term frequency normalization."
*Proceedings of CIKM'11*, pp. 7-16. DOI: [10.1145/2063576.2063584](https://doi.org/10.1145/2063576.2063584)

**BM25L (Lv & Zhai, 2011):** Takes a different approach — modifying the TF component
before length normalization by adding a constant c to the normalized TF:

```
tf' = tf / (1 - b + b * |D|/avgdl)
ctf = tf' + c                        (c = typically 0.5-1.0)
BM25L = SUM_{i}  IDF(q_i) * [ ctf * (k_1+1) / (ctf + k_1) ]
```

**Reference:** Lv, Y. & Zhai, C. (2011). "When documents are very long, BM25 fails!"
*Proceedings of SIGIR'11*, pp. 1103-1104. DOI: [10.1145/2009916.2010070](https://doi.org/10.1145/2009916.2010070)

### 1.5 Implications for memex

The current pipeline uses SQLite FTS5's built-in BM25, which implements standard BM25
without the +/L corrections. For the heterogeneous corpus:

1. **Memory entries** (short): BM25 over-scores due to low L factor
2. **Document chunks** (~500 chars): BM25 scores are roughly calibrated
3. **Full documents** (long): BM25 under-scores even when highly relevant

The pipeline partially compensates via length normalization in `retriever.ts`
(line 650-671), but this is applied post-fusion and uses character length rather than
token-level correction. A proper fix would apply BM25+ at the scoring level or use
separate avgdl statistics per source.

---

## 2. Score Calibration Across Heterogeneous Sources

### 2.1 Why Raw Scores Are Incomparable

The unified recall pipeline merges results from two fundamentally different scoring
systems:

| Source | Score Type | Range | Distribution |
|--------|-----------|-------|-------------|
| Conversation memory | Cosine similarity (post-RRF, reranked) | [0, 1] | Beta-like, concentrated near 0.5-0.9 |
| Document search (QMD) | Hybrid FTS+vec (custom scoring) | [0, 1] | Bimodal: cluster near 0 and near 0.7 |

Raw scores from these systems are **not on the same scale** even when both are nominally
in [0, 1]. A score of 0.7 from the conversation memory pipeline (which has passed
through 7 scoring stages) represents a very different confidence level than 0.7 from
the QMD hybrid search.

### 2.2 Formal Score Combination Methods

#### CombSUM (Fox & Shaw, 1994)

Simple sum of normalized scores across systems:

```
CombSUM(d) = SUM_{s=1}^{S}  norm_s(score_s(d))
```

where norm_s normalizes scores from system s to [0, 1].

**Failure mode:** Assumes equal reliability across systems. A noisy system with broadly
distributed scores can dominate a precise system with tightly clustered scores.

#### CombMNZ (Fox & Shaw, 1994)

Multiplies CombSUM by the number of systems that retrieved the document:

```
CombMNZ(d) = CombSUM(d) * |{s : d in results_s}|
```

**Intuition:** Documents found by multiple systems are more likely relevant. This acts as
a soft intersection operator.

**Problem for memex:** A memory entry will never appear in document results and vice
versa, so the multiplier is always 1 — CombMNZ degenerates to CombSUM for disjoint
source types.

#### CombANZ (Fox & Shaw, 1994)

Divides by the number of systems that returned the document:

```
CombANZ(d) = CombSUM(d) / |{s : d in results_s}|
```

**Also useless for memex** for the same reason: the denominator is always 1.

**Reference:** Fox, E.A. & Shaw, J.A. (1994). "Combination of multiple searches."
*Proceedings of TREC-2*, NIST Special Publication 500-215.

### 2.3 Reciprocal Rank Fusion (RRF)

RRF (Cormack, Clarke & Buettcher, 2009) operates on **rank positions** rather than
scores, avoiding the calibration problem entirely:

```
RRF(d) = SUM_{s=1}^{S}  1 / (k + rank_s(d))
```

where k = 60 (empirically determined constant).

**Mathematical properties:**
- Score-agnostic: only uses ordinal position, immune to score scale differences
- Harmonic weighting: top ranks contribute disproportionately
  - Rank 1: 1/61 = 0.0164
  - Rank 10: 1/70 = 0.0143
  - Rank 50: 1/110 = 0.0091
- Diminishing returns: moving from rank 1->2 costs 0.0003; from 50->51 costs 0.00008

**Why k = 60?** The original paper does not provide a formal derivation. The constant was
determined empirically. Its effect: it dampens the difference between adjacent top ranks
(rank 1 vs 2 is a 1.6% difference, not a 50% difference as with k=0). This prevents a
single system's top result from dominating the fusion.

**When RRF loses to score-based fusion:** Bruch et al. (2022) showed definitively that
when even a small number of labeled examples are available, convex combination
(alpha * score_1 + (1-alpha) * score_2) with tuned alpha significantly outperforms RRF.
RRF discards score magnitude information — the gap between ranks 1 and 2 could be
0.001 or 0.3, and RRF treats them identically.

**Reference:** Cormack, G.V., Clarke, C.L.A. & Buettcher, S. (2009). "Reciprocal rank
fusion outperforms Condorcet and individual rank learning methods." *Proceedings of
SIGIR'09*, pp. 758-759. DOI: [10.1145/1571941.1572114](https://doi.org/10.1145/1571941.1572114)

**Reference:** Bruch, S. et al. (2022). "An Analysis of Fusion Functions for Hybrid
Retrieval." *ACM Transactions on Information Systems*, 42(1). DOI: [10.1145/3596512](https://doi.org/10.1145/3596512)

### 2.4 Platt Scaling

Maps uncalibrated scores to probabilities via a learned sigmoid:

```
P(relevant | score) = 1 / (1 + exp(A * score + B))
```

where A and B are fit by maximum likelihood on a held-out set.

**Requirements:** Needs labeled data (relevant/not-relevant judgments) per system.
With ~100+ labeled pairs, Platt scaling produces well-calibrated probabilities.

**Relevance to memex:** The importance scorer already uses sigmoid normalization
(src/importance.ts line 12) to map BGE-reranker logits. This is effectively Platt
scaling with A = -1, B = 0 (the identity sigmoid). A proper Platt calibration would
learn A and B from user feedback data.

### 2.5 Isotonic Regression

Non-parametric alternative to Platt scaling. Fits a monotonically non-decreasing
step function to map scores to calibrated probabilities:

```
f*(score) = argmin_{f monotone}  SUM_i  (f(score_i) - y_i)^2
```

Solved exactly by the Pool Adjacent Violators (PAV) algorithm in O(n) time.

**Advantages over Platt:** No distributional assumption (Platt assumes sigmoid shape).
Handles multi-modal score distributions correctly.

**Disadvantage:** Requires more calibration data (~1000+ samples for stable estimates,
per Niculescu-Mizil & Caruana, 2005).

**Reference:** Niculescu-Mizil, A. & Caruana, R. (2005). "Predicting good probabilities
with supervised learning." *Proceedings of ICML'05*, pp. 625-632.

### 2.6 What memex Currently Does (and Why)

The current pipeline (`unified-recall.ts` line 307-333) uses **weighted raw scores**:

```
score_final = rawScore * sourceWeight
```

with `conversationWeight = 0.5` and `documentWeight = 0.5`.

The code comments note (line 307-309) that min-max normalization was tried and
abandoned because it destroyed scores for tightly clustered results. This is correct —
see Section 7.1 for the mathematical proof of why.

---

## 3. Cross-Encoder Reranking Theory

### 3.1 Why Cross-Encoders Outperform Bi-Encoders

**Bi-encoder (embedding model):**
```
score(q, d) = cos(E_q(q), E_d(d))
```
Each text is encoded independently. The interaction happens only at the final cosine
step — a single dot product in R^n. Information bottleneck: the entire semantics of
each text must be compressed into a fixed-size vector.

**Cross-encoder:**
```
score(q, d) = f_CE([CLS] q [SEP] d [SEP])
```
Query and document tokens attend to each other through all transformer layers.
Full cross-attention enables:
- Token-level matching (exact term matches, negation detection)
- Positional reasoning ("X is better than Y" vs "Y is better than X")
- Compositional semantics that bi-encoders cannot capture

**Empirical gap:** Cross-encoders outperform bi-encoders by ~4+ nDCG@10 points on
standard benchmarks (MS MARCO, BEIR).

**Computational complexity:**
- Bi-encoder: O(n * d) to encode, then O(d) per comparison. Pre-computation makes
  retrieval O(d) per query-document pair.
- Cross-encoder: O((|q| + |d|)^2 * L) per pair, where L = number of layers.
  No pre-computation possible — must process each pair from scratch.

For memex: embedding (bi-encoder) takes ~83ms for a batch of 5. Cross-encoder
reranking takes ~53ms for 5 documents (~10ms per pair). This is acceptable for
reranking 5-20 candidates but prohibitive for full corpus search.

### 3.2 Optimal Number of Candidates to Rerank

The cost-quality tradeoff follows a **diminishing returns curve**:

```
Quality(n) = Q_max * (1 - exp(-n / tau))
Cost(n) = c * n
```

where n = number of candidates, tau = "recall knee" parameter, c = per-candidate
reranking cost.

**Empirical guidance:**
- n < 10: Risk missing relevant documents (insufficient recall from first stage)
- n = 10-30: Sweet spot for most applications. ~8ms per pair on CPU.
- n = 30-50: Marginal quality gains, linear cost increase
- n > 50: Negligible quality improvement, significant latency

For memex's deployment (bge-reranker-v2-m3 on Mac Mini via llama.cpp):
- Current: reranks up to `limit * 2` candidates (typically 10-20)
- Cost: ~53ms for 5 docs, scales linearly => ~200ms for 20 docs
- This is within the acceptable latency budget (~300-400ms total pipeline)

### 3.3 Score Blending: Cross-Encoder + First-Stage Scores

The current pipeline (`retriever.ts` line 537-541) blends:

```
blended = 0.8 * crossEncoderScore + 0.2 * fusedScore
```

The unified recall pipeline (`unified-recall.ts` line 378-381) uses:

```
blended = 0.6 * crossEncoderScore + 0.4 * weightedScore
```

**Mathematical justification for high cross-encoder weight:**

The cross-encoder is strictly more expressive than the first-stage ranker. When the
cross-encoder gives a low score (near 0), the document is almost certainly irrelevant
regardless of the first-stage score. The blending weight should reflect this:

```
P(rel | CE_score, FS_score) ~ a * CE_score + (1-a) * FS_score
```

With a = 0.8, a first-stage score of 0.9 with CE = 0.1 yields 0.26 (correctly
demoted). With a = 0.5, the same pair yields 0.50 (incorrectly kept).

The lower cross-encoder weight (0.6) in unified recall is justified because the
cross-reranking operates across heterogeneous sources where the cross-encoder may
not have seen training data for memory-style short texts.

### 3.4 Confidence-Based Early Termination

When to skip reranking:

```
skip_rerank if  min(scores[0:k]) > confidence_threshold
```

The insight: if all top-k candidates already have high first-stage scores, reranking
is unlikely to change the ordering significantly. The probability of a rank swap
decreases with the score gap:

```
P(swap_{i,j}) ~ exp(-|score_i - score_j| / temperature)
```

Current implementation: `earlyTermination` in unified recall checks if all top-k
conversation results exceed `highConfidenceThreshold = 0.6`. This is a coarse
approximation — a proper implementation would check the score gap between the k-th
and (k+1)-th results.

**Research direction — cascading reranking:** Apply lightweight cross-encoders
(fewer layers) first, then full cross-encoders only for uncertain candidates.
E2Rank (Pinecone, 2025) demonstrates 2-3x speedup with <1% quality loss using
layer-wise early exit.

**Reference:** Soldaini, L. et al. (2025). "Efficient Re-ranking with Cross-encoders
via Early Exit." *Proceedings of SIGIR'25*. DOI: [10.1145/3726302.3729962](https://doi.org/10.1145/3726302.3729962)

---

## 4. Temporal Relevance Models

### 4.1 The Dual Nature of Relevance in Memory Systems

Memory entries have fundamentally different temporal profiles:

| Type | Example | Temporal Behavior |
|------|---------|------------------|
| Permanent fact | "User's timezone is CET" | Never decays |
| Slowly-decaying | "Project uses React 18" | May become stale over months |
| Fast-decaying | "Working on feature X today" | Irrelevant after days |
| Seasonal | "Holiday schedule" | Cyclic relevance |

A single decay function cannot handle all four types correctly.

### 4.2 Exponential Decay Model (Current Implementation)

The current time decay (`retriever.ts` line 683-700):

```
factor = 0.5 + 0.5 * exp(-ageDays / halfLife)
score_decayed = score * factor
```

with halfLife = 60 days.

**Properties:**
- At age = 0: factor = 1.0 (no penalty)
- At age = halfLife (60d): factor = 0.5 + 0.5 * e^(-1) = 0.684
- At age = 2 * halfLife (120d): factor = 0.5 + 0.5 * e^(-2) = 0.568
- Floor at 0.5 (very old entries keep >= 50% of score)

**The floor is critical:** Without it, permanent facts like "API key is X" would
eventually score near zero. The 0.5 floor is a pragmatic compromise but has no
theoretical grounding.

### 4.3 Additive Recency Boost (Current Implementation)

The recency boost (`retriever.ts` line 601-619):

```
boost = exp(-ageDays / recencyHalfLife) * recencyWeight
score_boosted = score + boost
```

with recencyHalfLife = 14 days, recencyWeight = 0.10.

**Properties:**
- At age = 0: boost = 0.10 (maximum additive bonus)
- At age = 14d: boost = 0.037
- At age = 30d: boost = 0.012

This is an **additive** boost, meaning it has larger relative impact on lower-scored
results. A result with score 0.3 gets a 33% relative boost; a result with score 0.9
gets an 11% relative boost. This is the desired behavior: recency should break ties
among similarly-relevant results, not override relevance.

### 4.4 Unified Temporal Framework

**Proposed: Two-component temporal model**

Decompose temporal relevance into orthogonal components:

```
T(age, type) = alpha(type) + (1 - alpha(type)) * exp(-age / halfLife(type))
```

where:
- `alpha(type)` = permanence factor (0 = fully decaying, 1 = fully permanent)
- `halfLife(type)` = decay rate for the non-permanent component

| Entry Type | alpha | halfLife | Behavior |
|-----------|-------|---------|----------|
| Fact / preference | 0.9 | 365d | Near-permanent |
| Technical decision | 0.6 | 90d | Slow decay |
| Current task | 0.1 | 7d | Fast decay |
| Default (unknown) | 0.5 | 60d | Current behavior |

The importance scorer already classifies entries into rough categories — this
classification could drive the alpha/halfLife parameters.

**Reference:** For the theoretical grounding of two-component models, see:
Li, J. et al. (2023). "Re3: Learning to Balance Relevance & Recency for Temporal
Information Retrieval." [arXiv:2509.01306](https://arxiv.org/abs/2509.01306) — proposes
a query-aware gating mechanism that dynamically balances semantic and temporal
signals per query.

### 4.5 Query-Aware Temporal Gating

The Re3 framework introduces a gating function:

```
gate(q) = sigmoid(W_g * encode(q) + b_g)

score_final = gate(q) * score_semantic + (1 - gate(q)) * score_temporal
```

This is superior to a fixed temporal weight because:
- "What is my API key?" -> gate ~ 0 (purely semantic, recency irrelevant)
- "What was I working on?" -> gate ~ 1 (strongly temporal)
- "What's the current deployment config?" -> gate ~ 0.5 (both matter)

**Cost for memex:** Would require a lightweight classifier (~0.1ms inference) or
heuristic pattern matching (already partially implemented in `adaptive-retrieval.ts`).

---

## 5. Multi-Objective Ranking

### 5.1 The Signal Combination Problem

memex combines at least 6 signals in its 7-stage pipeline:

1. **Vector similarity** (cosine): semantic relevance
2. **BM25 score**: lexical relevance
3. **Cross-encoder score**: deep relevance
4. **Recency boost**: temporal relevance
5. **Importance weight**: entry significance
6. **Length normalization**: bias correction
7. **Time decay**: staleness penalty

Each signal has different scale, distribution, and reliability. The question:
how to combine them into a single ranking score?

### 5.2 Linear Scalarization (Current Approach)

The current pipeline applies signals **sequentially as multiplicative/additive
modifiers**:

```
s_0 = fuse(vector_rank, bm25_rank)           [RRF-like fusion]
s_1 = blend(s_0, crossEncoder, 0.8)           [reranking]
s_2 = s_1 + recencyBoost                      [additive]
s_3 = s_2 * importanceFactor                  [multiplicative]
s_4 = s_3 * lengthNormFactor                  [multiplicative]
s_5 = s_4 * timeDecayFactor                   [multiplicative]
s_6 = filter(s_5, adaptiveMinScore)            [hard cutoff]
```

This is a form of **linear scalarization** where the multi-objective problem
is reduced to a single objective via weighted combination.

**Problem: Order dependence.** Because some modifiers are multiplicative and
some additive, the order of application matters. Applying recency boost (additive)
before importance weight (multiplicative) gives different results than the reverse.

**Current order analysis:**
- Recency boost is additive (+0.10 max), applied first
- Then importance multiplies by [0.7, 1.0], amplifying the boost
- Then length norm multiplies by [0.5, 1.0]
- Then time decay multiplies by [0.5, 1.0]

Net effect: a fresh, important, short entry gets maximum amplification. This is
generally correct behavior, but the interaction between additive and multiplicative
stages creates non-obvious effects.

### 5.3 LambdaMART and Learning-to-Rank

**LambdaMART** (Burges, 2010) is the industrial standard for multi-signal ranking:

```
F(x) = SUM_{m=1}^{M}  alpha_m * h_m(x)    [gradient-boosted tree ensemble]
```

where x = feature vector [vectorSim, bm25, crossEncoder, recency, importance, length],
and h_m are regression trees.

The "lambda" gradient is NDCG-aware:

```
lambda_{ij} = |Delta_NDCG(i, j)| * sigma(s_j - s_i)
```

where Delta_NDCG is the change in NDCG from swapping documents i and j.

**Why this is superior:** LambdaMART learns non-linear feature interactions
(e.g., "importance matters more when recency is high") and directly optimizes
the ranking metric. The current sequential pipeline cannot capture such interactions.

**Why memex cannot use it:** Requires labeled training data (query, document,
relevance-grade tuples). memex has no labeled data and the corpus is per-user.
Would need to collect implicit feedback (clicked/used results) over time.

**Reference:** Burges, C.J.C. (2010). "From RankNet to LambdaRank to LambdaMART:
An overview." MSR-TR-2010-82. [Microsoft Research](https://www.microsoft.com/en-us/research/publication/from-ranknet-to-lambdarank-to-lambdamart-an-overview/)

### 5.4 Multi-Objective with Constraints (Amazon, 2020)

Momma et al. (2020) formulate multi-objective ranking as constrained optimization:

```
minimize   -NDCG_relevance(F)
subject to  NDCG_freshness(F) >= threshold_freshness
            NDCG_diversity(F)  >= threshold_diversity
```

Solved via Lagrangian relaxation within the LambdaMART framework.

This is appealing for memex: ensure relevance is primary while guaranteeing
minimum freshness and source diversity. However, it still requires labeled data.

**Reference:** Momma, M. et al. (2020). "Multi-objective Relevance Ranking."
[Amazon Science](https://assets.amazon.science/8d/50/3040568d44848a04794c3c6e89a2/multi-objective-relevance-ranking.pdf)

### 5.5 Pareto-Optimal Ranking

A result set is **Pareto-optimal** if no result can be improved on one objective
without degrading another. For two objectives (relevance R, recency T):

```
d_i Pareto-dominates d_j  iff  R(d_i) >= R(d_j) AND T(d_i) >= T(d_j)
                          with at least one strict inequality
```

The Pareto frontier gives the set of non-dominated results. Selecting from this
frontier guarantees no result is strictly worse than another on all objectives.

**Practical issue:** The Pareto frontier can be very large (O(n) in the worst case),
so it does not directly produce a ranking. Need to select from the frontier using
a scalarization or other method.

---

## 6. Theoretical Guarantees and Bounds

### 6.1 RRF and Kendall Tau Distance

RRF does **not** have formal theoretical guarantees. The original Cormack et al. paper
is entirely empirical. However, rank aggregation theory provides context:

**Kemeny optimal aggregation** minimizes the sum of Kendall tau distances to all
input rankings:

```
sigma* = argmin_sigma  SUM_{s=1}^{S}  K(sigma, sigma_s)
```

where K(sigma, sigma_s) = number of pairwise disagreements.

This is NP-hard (Dwork et al., 2001), but has a polynomial-time 2-approximation
for top-k lists.

**RRF as a heuristic:** RRF does not minimize Kendall tau distance. It is a
**positional scoring rule** (like Borda count) that assigns a score based on rank
position. Borda count is known to be a 5-approximation to Kemeny (Coppersmith et al.,
2010), and RRF can be analyzed similarly as a variant with harmonic weights.

**Reference:** Dwork, C. et al. (2001). "Rank aggregation methods for the web."
*Proceedings of WWW'01*. DOI: [10.1145/371920.372165](https://doi.org/10.1145/371920.372165)

### 6.2 Calibration Guarantees

**Platt scaling** guarantees:

Under the assumption that the true posterior P(R=1|score) is a sigmoid function of
the score (i.e., scores are Gaussian-distributed within each class with equal
variance), Platt scaling produces perfectly calibrated probabilities.

In practice, this assumption rarely holds exactly. The **expected calibration error**
(ECE) provides a finite-sample bound:

```
ECE = SUM_{b=1}^{B}  (n_b / n) * |acc(b) - conf(b)|
```

where B = number of bins, acc(b) = actual accuracy in bin b, conf(b) = mean predicted
probability in bin b.

For memex's use case, without relevance labels we cannot compute ECE or verify
calibration. The sigmoid normalization in importance.ts provides rough calibration
but is unverified.

### 6.3 Fairness in Multi-Source Merging

Recent work on fair rank aggregation (IJCAI 2025) achieves (2 + epsilon)-approximation
for Kemeny aggregation under proportional fairness constraints.

For memex, "fairness" translates to **source representation guarantees**: ensuring
both conversation memories and documents have minimum representation in the final
result set. The current implementation achieves this with the protected top-result
mechanism (`unified-recall.ts` line 214-218), which guarantees at least the top
result from each source survives filtering. This is a weaker guarantee than
proportional representation but is simple and effective.

**Reference:** "Improved Rank Aggregation under Fairness Constraint."
*Proceedings of IJCAI'25*. [arXiv:2505.10006](https://arxiv.org/abs/2505.10006)

---

## 7. Failure Modes in Current Pipeline

### 7.1 Min-Max Normalization on Clustered Scores (Proven Failure)

The code comment at `unified-recall.ts:307-309` notes that min-max normalization was
abandoned. Here is the mathematical proof of why it fails:

**Min-max normalization:**
```
norm(s) = (s - s_min) / (s_max - s_min)
```

**Failure case:** Suppose conversation results have scores [0.92, 0.83, 0.79].

```
s_min = 0.79, s_max = 0.92, range = 0.13

norm(0.92) = (0.92 - 0.79) / 0.13 = 1.000
norm(0.83) = (0.83 - 0.79) / 0.13 = 0.308
norm(0.79) = (0.79 - 0.79) / 0.13 = 0.000
```

The second-best result drops to 0.31 and the third-best to 0.0, despite all three
being strong results with an original spread of only 0.13. This is catastrophic
for merging: any document result with a normalized score above 0.31 would outrank
the second-best memory.

**Root cause:** Min-max normalization has **zero translation invariance**. It maps
the worst result in any set to exactly 0.0, regardless of whether that result is
actually bad. It confuses "worst in this set" with "irrelevant."

**When min-max works:** Only when the score range is large and the minimum score
genuinely represents irrelevance (approximately 0).

### 7.2 Additive Recency Boost on Pre-Normalized Scores

The recency boost adds up to 0.10 to scores that are already in [0, 1]. For
high-scoring results (0.8+), this is a small relative change (12%). For
borderline results near the hardMinScore threshold (0.40), it is a 25% relative
change — enough to push irrelevant-but-new results above the threshold.

**Concrete failure:** A noise entry stored 1 minute ago with vector score 0.35
gets boosted to 0.45, surviving the hardMinScore filter. An important but 30-day-old
entry with vector score 0.45 gets time-decayed to 0.38, then fails the filter.

This is partially mitigated by the adaptive min score mechanism
(`retriever.ts:708-715`) which uses a relative floor (30% of best score) rather
than a fixed floor.

### 7.3 Multiplicative Cascade Compression

The sequential multiplicative stages (importance * lengthNorm * timeDecay) compound:

```
worst case: 0.7 * 0.5 * 0.5 = 0.175 (82.5% reduction)
```

A moderately relevant result (score 0.6) with low importance (0.7x), long length
(0.5x), and age (0.5x) ends up at:

```
0.6 * 0.7 * 0.5 * 0.5 = 0.105
```

This is below any reasonable threshold and will be filtered, even though the result
may contain the exact answer. The multiplicative cascade is too aggressive.

### 7.4 Score Scale Mismatch After Source Weighting

The unified recall applies equal weights (0.5, 0.5) to both sources:

```
conversation: rawScore * 0.5
document: rawScore * 0.5
```

But conversation scores have already been through 7 scoring stages (generally
lowering them from initial values), while document scores come from a simpler
2-stage pipeline. The effective ranges after weighting:

- Conversation: typically 0.20 - 0.45 (was 0.40 - 0.90 pre-weight)
- Documents: typically 0.15 - 0.45 (was 0.30 - 0.90 pre-weight)

The weighting by 0.5 compresses both into a narrow band, making discrimination
difficult.

---

## 8. Proposed Unified Scoring Formula

### 8.1 Design Principles

Based on the analysis above:

1. **Score-based fusion with calibration**, not RRF — we have score information
   and discarding it (as RRF does) is provably suboptimal when scores are available
   (Bruch et al., 2022)
2. **Logistic calibration** per source to map to comparable probability space
3. **Multiplicative combination** for independent signals (importance, temporal)
4. **Additive combination** for correlated signals (vector + BM25)
5. **Floor guarantees** to prevent cascade compression from eliminating results

### 8.2 The Formula

**Stage 1: Per-source calibrated relevance**

```
R_conv(d, q) = sigmoid(a_c * rawScore_conv(d, q) + b_c)
R_doc(d, q)  = sigmoid(a_d * rawScore_doc(d, q) + b_d)
```

where (a_c, b_c) and (a_d, b_d) are calibration parameters. Without labeled data,
use identity calibration: a = 1, b = 0 (equivalent to current approach). With
feedback data, fit via Platt scaling.

**Stage 2: Cross-source reranking (optional)**

```
R_reranked(d, q) = w_CE * CE(q, d) + (1 - w_CE) * R_source(d, q)
```

where w_CE = 0.7 (cross-encoder weight). Skip when confidence is high.

**Stage 3: Temporal adjustment**

```
T(d) = alpha(d) + (1 - alpha(d)) * exp(-age(d) / halfLife(d))
```

where alpha, halfLife are per-entry-type parameters (see Section 4.4).

**Stage 4: Importance and quality modifiers**

```
I(d) = baseWeight + (1 - baseWeight) * importance(d)
L(d) = 1 / (1 + gamma * log2(max(|d|/anchor, 1)))
```

**Stage 5: Final score with floor guarantee**

```
S(d, q) = max( R(d, q) * T(d) * I(d) * L(d),  floor * R(d, q) )
```

where floor = 0.25. This ensures that a highly relevant result (high R) cannot be
reduced below 25% of its relevance score by temporal/importance/length adjustments.

**Stage 6: Source diversity guarantee**

After scoring, ensure at least one result from each source appears in the top-k.
If the top result from source X would be filtered by minScore, include it anyway
if its calibrated relevance R(d, q) exceeds a source-specific threshold.

### 8.3 Comparison with Current Pipeline

| Aspect | Current | Proposed |
|--------|---------|----------|
| Calibration | None (raw scores) | Logistic per source |
| Fusion | Weighted raw scores | Calibrated probability fusion |
| Temporal | Fixed half-life, fixed floor | Per-type alpha/halfLife |
| Cascade | Unbounded compression | Floor guarantee (25% of R) |
| Diversity | Protected top-1 per source | Protected top-1 + proportional |

### 8.4 Why Not Full Learning-to-Rank?

LambdaMART or similar would be strictly superior but requires:
1. Labeled relevance data per user (privacy-sensitive, cold-start problem)
2. Sufficient training data (~1000+ labeled queries per user)
3. Model retraining infrastructure
4. Different model per user (or domain adaptation)

The proposed formula is a **well-calibrated heuristic** that can be upgraded to
LambdaMART if feedback data becomes available. The calibration parameters
(a_c, b_c, a_d, b_d) provide a natural extension point.

---

## 9. Computational Complexity Analysis

### 9.1 Per-Component Costs

| Component | Time Complexity | memex Latency | API Calls |
|-----------|----------------|-----------------|-----------|
| Query embedding | O(|q| * d) | ~83ms uncached, <0.03ms cached | 1 HTTP |
| Vector search (LanceDB) | O(N * d) with SIMD | ~33ms | 0 (local) |
| BM25 search (FTS5) | O(df * log N) | ~14ms | 0 (local) |
| RRF fusion | O(n log n) | <0.1ms | 0 |
| Cross-encoder rerank | O(n * (|q|+|d|)^2 * L) | ~53ms for n=5 | 1 HTTP |
| Recency boost | O(n) | <0.01ms | 0 |
| Importance weight | O(n) | <0.01ms | 0 |
| Length norm | O(n) | <0.01ms | 0 |
| Time decay | O(n) | <0.01ms | 0 |
| MMR diversity | O(n^2 * d) | <0.1ms for n=20 | 0 |
| **Total (memory only)** | | **~250ms** | **2 HTTP** |
| QMD document search | O(N_doc * d) | ~100-150ms | 1 HTTP |
| Cross-source rerank | O(n * (|q|+|d|)^2 * L) | ~53ms | 1 HTTP |
| **Total (unified)** | | **~300-400ms** | **3-4 HTTP** |

### 9.2 API Call Budget

Each unified recall query costs:
1. **Embedding** (1 call): Query embedding, shared across both sources
2. **Memory reranking** (1 call): Rerank top conversation candidates
3. **Document embedding** (0 calls): Reuses query embedding from step 1
4. **Cross-source reranking** (0-1 calls): Optional, only when crossRerank=true

**Total: 2-3 API calls per query** at ~$0 cost (self-hosted llama.cpp models).

For hosted rerankers (Jina, Voyage):
- Jina: ~$0.018 per 1000 reranking pairs
- Voyage: ~$0.05 per 1000 reranking pairs
- At 5 docs per rerank: ~$0.0001 per query

### 9.3 Latency Optimization Opportunities

1. **Early termination** (already implemented): Skip document search when
   conversation results are strong. Saves ~150ms.
2. **Cached cross-encoder scores**: Cache (query_hash, doc_id) -> score pairs.
   Rerank scores are deterministic for the same inputs.
3. **Adaptive rerank depth**: Rerank 5 candidates instead of 20 when top-1
   score >> top-2 score (large gap = high confidence in ordering).
4. **Parallel reranking**: Send memory and document rerank requests in parallel
   instead of sequential cross-source rerank.

---

## Summary of Key Findings

1. **BM25 has systematic bias** for the memex corpus: over-scores short memories,
   under-scores long documents. BM25+ would fix this at the scoring level, but
   requires patching FTS5 or post-hoc correction.

2. **Min-max normalization is provably wrong** for tightly clustered scores.
   The current approach (weighted raw scores) is better but still lacks calibration.

3. **RRF is suboptimal** when score information is available. Convex combination
   with tuned weights outperforms RRF (Bruch et al., 2022). The current pipeline
   uses a hybrid approach (score-based fusion with BM25 as a boolean boost) which
   is reasonable but ad-hoc.

4. **Cross-encoder reranking at n=5-20** is well within the cost-quality sweet spot
   for the current deployment. The 80/20 blend weight is justified by the
   expressiveness gap between cross-encoders and bi-encoders.

5. **Temporal modeling needs per-type parameters.** A single half-life (60 days) and
   a fixed floor (0.5) cannot correctly handle both permanent facts and ephemeral
   context. The proposed two-component model (alpha + decaying) addresses this.

6. **Multiplicative cascade compression** can reduce relevant results to below
   threshold. A floor guarantee (proposed: 25% of relevance score) prevents this.

7. **No formal theoretical guarantees** exist for the current pipeline or for RRF.
   Rank aggregation theory gives approximation bounds for Kemeny-optimal aggregation,
   but these are worst-case bounds and not practically useful. Empirical evaluation
   on user-specific queries remains the most reliable quality signal.

---

## References

- Robertson, S.E. & Sparck Jones, K. (1976). "Relevance weighting of search terms." DOI: [10.1002/asi.4630270302](https://doi.org/10.1002/asi.4630270302)
- Robertson, S.E. & Zaragoza, H. (2009). "The Probabilistic Relevance Framework: BM25 and Beyond." DOI: [10.1561/1500000019](https://doi.org/10.1561/1500000019) [(PDF)](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf)
- Lv, Y. & Zhai, C. (2011). "Lower-bounding term frequency normalization." DOI: [10.1145/2063576.2063584](https://doi.org/10.1145/2063576.2063584)
- Lv, Y. & Zhai, C. (2011). "When documents are very long, BM25 fails!" DOI: [10.1145/2009916.2010070](https://doi.org/10.1145/2009916.2010070)
- Fox, E.A. & Shaw, J.A. (1994). "Combination of multiple searches." NIST SP 500-215.
- Cormack, G.V., Clarke, C.L.A. & Buettcher, S. (2009). "Reciprocal rank fusion outperforms Condorcet and individual rank learning methods." DOI: [10.1145/1571941.1572114](https://doi.org/10.1145/1571941.1572114) [(PDF)](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)
- Bruch, S. et al. (2022). "An Analysis of Fusion Functions for Hybrid Retrieval." DOI: [10.1145/3596512](https://doi.org/10.1145/3596512) [(arXiv)](https://arxiv.org/abs/2210.11934)
- Niculescu-Mizil, A. & Caruana, R. (2005). "Predicting good probabilities with supervised learning." [(PDF)](https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf)
- Burges, C.J.C. (2010). "From RankNet to LambdaRank to LambdaMART: An overview." MSR-TR-2010-82.
- Momma, M. et al. (2020). "Multi-objective Relevance Ranking." [(PDF)](https://assets.amazon.science/8d/50/3040568d44848a04794c3c6e89a2/multi-objective-relevance-ranking.pdf)
- Svore, K.M. et al. (2011). "Learning to Rank with Multiple Objective Functions." [(PDF)](https://www.cs.toronto.edu/~mvolkovs/www2011_lambdarank.pdf)
- Li, J. et al. (2023). "Re3: Learning to Balance Relevance & Recency for Temporal IR." [arXiv:2509.01306](https://arxiv.org/abs/2509.01306)
- Carbonell, J. & Goldstein, J. (1998). "The Use of MMR, Diversity-Based Reranking." [(PDF)](https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf)
- Dwork, C. et al. (2001). "Rank aggregation methods for the web." DOI: [10.1145/371920.372165](https://doi.org/10.1145/371920.372165)
- Soldaini, L. et al. (2025). "Efficient Re-ranking with Cross-encoders via Early Exit." DOI: [10.1145/3726302.3729962](https://doi.org/10.1145/3726302.3729962)
- "Improved Rank Aggregation under Fairness Constraint." IJCAI 2025. [arXiv:2505.10006](https://arxiv.org/abs/2505.10006)
- Kamishima, T. et al. (2017). "A Half-Life Decaying Model for Recommender Systems." [(PDF)](https://ceur-ws.org/Vol-2038/paper1.pdf)
- Trotman, A. et al. (2014). "Which BM25 Do You Mean? A Large-Scale Reproducibility Study of Scoring Variants." DOI: [10.1007/978-3-030-45442-5_4](https://pmc.ncbi.nlm.nih.gov/articles/PMC7148026/)
- MLPlatt (2025). "Simple Calibration Framework for Ranking Models." [arXiv:2601.08345](https://arxiv.org/abs/2601.08345)
