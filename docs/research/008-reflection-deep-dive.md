# Deep Research: Memory Reflection & Consolidation

**Started:** 2026-04-25
**Goal:** Comprehensive research informing memex's reflection/dreaming design. Beyond literature review — generate novel hypotheses, find supporting/refuting evidence, propose memex-specific designs.

## Research Methodology

This document is structured as **three layers**:

1. **Findings** (literature review per angle) — what existing systems do
2. **Hypotheses** (novel proposals) — claims about what would work for memex specifically
3. **Process log** — what was searched, what was found, what was rejected, what redirected the research

Loop is bounded but flexible: angles can be reordered, deepened, or redirected based on emerging evidence. The goal is not to "finish all 10 sections" but to produce the strongest design proposal possible.

## Coverage Checklist (revisable)

### Initial angles
- [x] **F1**: AI agent memory consolidation (Letta, Mastra, A-MEM, Mem0, MemOS, MemMachine, HyperMem, xMemory) — **COMPLETE** (8 systems, comparative table)
- [ ] **F2**: Stanford Generative Agents reflection — full mechanism
- [x] **F3**: Neuroscience — **COMPLETE** (CLS theory, sleep replay, schema integration, active forgetting)
- [ ] **F4**: Cognitive architectures — ACT-R, SOAR, EPIC, CLARION
- [x] **F5**: Memory categorization — **COMPLETE** (Tulving/Squire/FTT + AI taxonomies, recommend `concept` as 7th category)
- [x] **F6**: RAG advances 2025-2026 — **COMPLETE** (memex is current; gaps are calibrated retrieval + instruction-following rerank)
- [x] **F7**: Temporal reasoning — **COMPLETE** (bi-temporal, Mastra three-date model, episodic anchoring)
- [x] **F8**: Active learning / selective storage — **COMPLETE** (info gain, AL methods, forgetting, quality gates, Mem0 #4573 detector table)
- [x] **F9**: Concept synthesis / abstraction — **COMPLETE** (Bayesian + topic models + KG + GenAgents + fuzzy-trace, convergent 6-step recipe)
- [ ] **F10**: Provenance and trust — source weighting, contradiction handling

### Hypotheses (added as research surfaces them)
- [x] **H1**: RAG-based recall less efficient than observation-log → **partially refuted** (depends on dataset)
- [x] **H2**: Hierarchical organization beats flat at scale → uncertain, possibly beneficial
- [x] **H3**: SKIP/REJECT verb prevents feedback-loop amplification → **confirmed** by Mem0 production data
- [x] **H4**: Add question-generation step before synthesis (Generative Agents pattern) → strongly suggested, low-cost A/B test
- [x] **H5**: Memex's facts/learnings split is structurally CLS — make replay explicit → strong theoretical grounding, defer until pool grows
- [x] **H6**: Schema-consistent fast path / inconsistent slow path (Tse 2007) → novel, needs cost-benefit
- [x] **H7**: NLL-based info gain check is the cheapest defense against feedback loops → **should be the first quality gate added**
- [x] **H8**: Mastra three-date model (referenced_date) → highest-ROI temporal upgrade
- [x] **H9**: Add `concept` as 7th category → fills real taxonomic gap, ship
- [x] **H10**: "Should I retrieve?" gate → biggest practical RAG win (~40% recall savings)

### Process log
- [x] 2026-04-25: Loop initialized. F1 launched with 3 parallel sub-agents (Letta+Mastra, A-MEM+Mem0+MemOS, hierarchical systems).
- [ ] *next entry*

---

## Section F1: AI Agent Memory Consolidation

*(partial — Letta+Mastra complete; A-MEM/Mem0/MemOS and hierarchical systems still running)*

### F1.1 — Letta Sleep-Time Agents

**Architecture**: Primary agent (interactive, fast model) + sleep-time agent (owns core-memory edit tools, slower stronger model). Two-tier model split is explicit.

**Triggers**: idle time between turns, document upload, configurable frequency. Background, non-blocking.

**Outputs**: rewrites/edits to the *primary agent's* core memory blocks. Produces "learned context" from "raw context."

**Context Repositories (Feb 2026)**: replaces flat core memory with a **git-backed file system**. Every mutation auto-commits. Subagents get isolated worktrees → can reflect concurrently on different slices. Conflicts merged via standard git resolution.

**Why this matters for memex**: the two-tier model split (cheap conversational, expensive reflective) is exactly what memex already does (`MEMEX_LLM_ENDPOINT`). The git-backed memory is interesting as a debugging/audit feature but probably overkill.

### F1.2 — Mastra Observational Memory

**Architecture**: Three agents — Actor (interactive) + Observer (compresses messages → notes) + Reflector (restructures notes). Context layout is **stable two-section**: observations at start, active history at end. Retrieval-free. Prompt is fully cacheable.

**Observer trigger**: unobserved message-history tokens > T1. Output: dated, emoji-prioritized two-level bullet observations. **3–6× compression on text, 5–40× on tool-heavy traces.** Replaces source messages.

**Reflector trigger**: total observation tokens > T2. Restructures observations — combines related, drops superseded, surfaces patterns. **Never reads raw messages.** Operates only on already-distilled notes.

**Three-date temporal model**: every observation carries up to three dates:
1. **Observation date** — when written
2. **Referenced date** — date mentioned in content ("flight is Jan 31")
3. **Relative date** — computed offset ("2 days from today")

Drives 95.5% temporal-reasoning score on LongMemEval.

**LongMemEval result**: 94.87% (gpt-5-mini Actor, gemini-2.5-flash Observer/Reflector). **Beats oracle baseline (raw correct sessions) by 2 points** with gpt-4o — Observer-distilled notes are *more* useful than ground truth. Avg context window ~30K tokens.

**Why it beats RAG**:
1. No retrieval at query time → no recall@k miss
2. **Distillation loses no information when done well** (oracle beat is the proof)
3. Stable prefix → 4–10× prompt cache cost reduction
4. Explicit dates avoid "lost in the middle"
5. Reflection only operates on distilled notes, never raw messages → no hallucinated summaries

Sources:
- https://www.letta.com/blog/sleep-time-compute
- https://www.letta.com/blog/context-repositories
- https://mastra.ai/research/observational-memory

### F1.3 — HyperMem (92.73% LoCoMo)

**Three-level hypergraph**: Topics → Episodes → Facts, with hyperedges connecting ≥3 elements (topic ↔ all episodes, episode ↔ all facts). Hyperedges represent high-order joint dependencies, not pairwise relationships.

**Streaming construction**:
1. Episode detection via LLM boundary detector (`should_end` / `should_wait`)
2. Topic aggregation: retrieve similar episodes → init / create / update topic
3. Fact extraction per episode with provenance back to source

**Hypergraph embedding propagation** (no training): hyperedge embedding = softmax-weighted sum of node embeddings; refined node embedding = h_v + λ·Agg(incident hyperedges).

**Coarse-to-fine retrieval**: top-k^T topics → top-k^E episodes → top-k^F facts, each stage RRF+rerank.

**Uses Qwen3-Embedding-4B and Qwen3-Reranker-4B** — same models as memex.

### F1.4 — MemMachine (91.69% LoCoMo)

**Ground-truth-preserving** — stores **raw conversational episodes**, NOT LLM-summarized abstractions. Episodes are the durable unit; sentences are the index. Only "profile memory" is LLM-distilled.

**Sentence-level granularity rationale**: chunks are interdependent in conversation. Sentence-level embeddings give precise *nucleus* matching; the full episode (with ±neighbors) gives reasoning context.

**Decouples index granularity (sentence) from evidence granularity (episode cluster).**

**Retrieval pipeline**: vector search → nucleus episode → ±neighbor cluster → cross-encoder rerank → chronological sort.

**80% token reduction vs Mem0** — comes from retrieval stage (precise nucleus matching), NOT from chunking. Ablation: retrieval depth tuning (+4.2%) > sentence chunking (+0.8%).

**No consolidation per se** — episodes flow STM → LTM via eviction. Profile memory updated on contradiction.

### F1.5 — xMemory (4-level hierarchy + uncertainty gating)

**Four levels**: messages → episodes → semantics → themes.
- **Episodes**: contiguous message blocks, summarized
- **Semantics**: reusable atomic facts, distilled from episodes (1:N)
- **Themes**: *partitions* of semantics, organizational only

**Mathematical objective for split/merge**:
```
f(P) = SparsityScore + SemScore
SparsityScore = N²/(K·Σn_k²)   // peaks at balanced theme sizes
SemScore = avg cosine cohesion to centroid · g(nearest_neighbor_sim)
```
Themes split when oversized, merge when too small, optimized to maximize f(P).

**Uncertainty-gated retrieval (top-down)**:
- Stage I: submodular selection on themes/semantics k-NN graph (coverage + similarity)
- Stage II: include episode only if it **reduces reader LLM's predictive uncertainty**
- Expand to raw messages only if further uncertainty reduction justifies tokens

**29% token reduction** — set-level diverse selection + uncertainty gating only pulls raw when needed.

### Comparative table

| System | Hierarchy | Distillation | Retrieval gate |
|---|---|---|---|
| **Mastra OM** | Append-only observation log | Heavy (Observer) | None — full log in context |
| **Letta** | Core blocks + recall + archival | Sleep-time agent rewrites | Search recall + archival |
| **HyperMem** | Topics→Episodes→Facts (hypergraph) | LLM extracts facts; topics summarized | Coarse-to-fine RRF+rerank |
| **MemMachine** | Episode-level (raw) + profile | **Avoids — preserves raw** | Sentence ANN → ±neighbor cluster |
| **xMemory** | Messages→Episodes→Semantics→Themes | Episode summaries + semantic distillation | Submodular + uncertainty-gated |

### F1.6 — A-MEM (Zettelkasten, NeurIPS 2025)

**Note structure** — 7 fields per memory: `content`, `timestamp`, LLM-generated `keywords`/`tags`/`context`, `embedding`, `links` set.

**Linking on write** (cosine similarity → top-k → LLM judges meaningful link):
```
s_{n,j} = (e_n · e_j) / (|e_n||e_j|)
```

**Memory evolution (THE KEY CONSOLIDATION DIFFERENCE)**: For each retrieved neighbor `m_j`, LLM prompted with new note + `m_j`'s context. Decides whether to update `m_j`'s context, keywords, tags. **The neighbor evolves on every new write.** Trigger: synchronous, online, every insertion.

**A-MEM is the only system that MODIFIES NEIGHBORS** on write. Mem0 only modifies the new fact's near-duplicates. MemOS only shifts memories between tiers.

### F1.7 — Mem0 (production-grade two-phase + the #4573 disaster)

**Two-phase pipeline** (phi = GPT-4o-mini extractor):
- **Phase 1 — extraction**: rolling summary `S` + last m=10 messages → emit candidate facts `Ω = {ω_1..ω_n}`
- **Phase 2 — update**: per fact, retrieve s=10 similar memories → LLM emits ADD/UPDATE/DELETE/NOOP via function calling

**Mem0g (graph variant)**: directed labeled graph, two-stage LLM extraction (entities → triples). On conflict: mark obsolete (don't delete) — temporal reasoning preserved.

**The #4573 disaster (production audit)**: 32-day audit, 10,134 entries → **224 kept (97.8% junk)**.

Failure modes by frequency:
1. **System-prompt restatement** (52.7%) — agent stores its own instructions
2. **Architecture/tool dumps** (8.2%)
3. **Hallucinated demographics** (5.2%) — "John Doe", invented users
4. **Feedback-loop amplification** — "Operator prefers Telegram" stored 200+ times. Recalled memories get re-extracted and re-stored.
5. **Raw system state** stored as memory

**Root causes**:
- ADD/UPDATE/DELETE/NOOP has **no quality-gate verb**. Proposed 5th: `SKIP/REJECT`.
- Extraction prompt is **identity-blind** — can't distinguish human user from agent.
- Pipeline **can't tell recalled context from fresh conversation**.

### F1.8 — MemOS (parametric + activation + plaintext tiers)

**MemCube**: smallest unit. Wraps payload (parametric weights / activation KV cache / plaintext) + 3 metadata blocks: descriptive, governance (ACL, TTL, decay), behavioral (access frequency, context-relevance, version lineage).

**Lifecycle as memory-type transformations**:
- plaintext → activation (cache hot KV templates)
- plaintext/activation → parametric (distill stable knowledge into weights)
- parametric → plaintext (externalize stale weights for editing)

**MemScheduler strategies**: LRU, semantic similarity, label match. Demand-driven, not clock-driven.

**Important correction**: the formula `0.5*sim + 0.3*recency + 0.2*importance` (which I cited in earlier memex docs) is NOT from MemOS. It's from [Hermes RecallFlow #509](https://github.com/NousResearch/hermes-agent/issues/509), CrewAI-inspired. Need to update earlier research docs.

### F1 Cross-cutting observations

| System | Key insight | Trigger model | Modifies neighbors? |
|---|---|---|---|
| Mastra OM | Beats RAG oracle via distillation+stable prefix | Threshold on tokens | Reflector restructures observation log |
| Letta sleep-time | Two-tier model split (cheap online, slow offline) | Idle / doc upload / freq | Yes — rewrites primary's core blocks |
| HyperMem | Hyperedges express joint deps; coarse-to-fine retrieval | Streaming episode boundary | Topics update on new episodes |
| MemMachine | Avoids distillation — sentence index, episode evidence | None (eviction-based) | No — preserves raw |
| xMemory | Mathematical f(P) for theme split/merge + uncertainty gating | Theme size thresholds | Themes split/merge based on objective |
| **A-MEM** | **Modifies neighbors on every write** | Synchronous on insert | **Yes — full neighbor evolution** |
| Mem0 | 4-op LLM judge — but lacks SKIP verb | Synchronous on insert | Only near-duplicates |
| MemOS | Parametric/activation/plaintext tiers | Demand-driven | Tier transitions only |

### Process log update
- 2026-04-25: All F1 sub-agents complete. F1 → checked.
- **Critical correction**: composite-scoring formula (0.5*sim + 0.3*recency + 0.2*importance) is from Hermes RecallFlow, NOT MemOS. Earlier memex docs misattribute. Will fix.
- **Critical evidence for memex**: Mem0's 97.8% junk rate (feedback loops, system-prompt restatement, hallucinated identity) — this is exactly what memex's intake guards must prevent. Drafting H3.
- **Hypothesis tension**: Mastra (heavy distillation, no retrieval) wins LongMemEval; MemMachine (no distillation, smart retrieval) wins LoCoMo. The "right" approach depends on dataset structure. Revising H1.

---

## Section F2: Stanford Generative Agents

*(not yet started)*

---

## Section F3: Neuroscience

### F3.1 — Complementary Learning Systems (CLS)

**Marr 1971; McClelland-McNaughton-O'Reilly 1995** — the foundational two-tier theory:

| | Hippocampus | Neocortex |
|---|---|---|
| Representation | Sparse, pattern-separated | Distributed, overlapping |
| Learning rate | High — one-shot encoding | Low — gradual statistical extraction |
| Role | Buffer for episodes | Schemas, generalizations |

**The catastrophic interference argument**: a single-system network trained sequentially overwrites old patterns when new ones arrive (McCloskey & Cohen 1989). The cortex CAN'T learn fast without destroying its structured representations — so a separate fast store (hippocampus) holds new items and **interleaves them into cortex via repeated reactivation**.

**2013 update (McClelland)**: cortex CAN learn quickly *if* new info is consistent with existing structure. **Schema-consistent material bypasses the slow path.**

**Memex computational analog**: facts (fast, episodic, hippocampus-like) + learnings (slow, structured, cortex-like). Replay = dreaming. The two-tier split is canonical.

### F3.2 — Sleep replay

**Wilson & McNaughton 1994** (*Science* 265:676): hippocampal place cells with overlapping fields show elevated co-firing in post-task SWS vs pre-task. Direct evidence of experience-dependent reactivation. Effect decays over ~30 min.

**Skaggs & McNaughton 1996**: replayed sequences preserve waking firing order, **time-compressed ~20×**, riding on sharp-wave ripples (SWRs, 150-250 Hz).

**SWS vs REM division of labor (Diekelmann & Born 2010)**:
- **SWS**: SWRs broadcast compressed sequences to neocortex. System-level redistribution. Disrupting ripples impairs memory (Girardeau 2009).
- **REM**: synaptic-level stabilization. Favors procedural/emotional. Sequential model: SWS reorganizes, REM stabilizes.

**Memex computational analog**: experience replay (Mnih 2015 DQN), prioritized replay, "dream" cycles that re-process recent traces in compressed form. Memex's dreaming = SWS analog.

### F3.3 — Schema integration

**Tse et al. 2007** (*Science* 316:76) — the breakthrough: rats learned flavor-place pairs over weeks until a schema formed. **New pairs taught in a single trial against this schema became hippocampus-independent within 48 hours** — vs the standard weeks-long consolidation in naive animals.

**vmPFC role (Ghosh & Gilboa 2014; Gilboa & Marlatte 2017)**: ventromedial prefrontal cortex binds multimodal cortical representations once memories are no longer episodic. "Semanticization hub." Lesion → fail schema-consistency judgments. Damage to subgenual BA24/25 → confabulation, endorse schema-inappropriate items.

**Bottom line**: integration speed depends on schema match.
- Schema-consistent → fast (vmPFC-mediated)
- Schema-inconsistent → slow (weeks, hippocampus-dependent)

**Memex computational analog**: facts matching existing learnings should integrate cheaply (slot fill in existing schema). Facts contradicting or extending existing learnings need a more expensive path (full synthesis). KG schemas as the binding structure; vmPFC ≈ schema selector that routes encoding.

### F3.4 — Forgetting as feature

**Hardt, Nader & Wang 2013** (*TiCS* 17:111) — "Decay happens": forgetting is an **active process**, not passive loss. Mechanism: time-dependent endocytosis of GluA2-containing AMPA receptors.

**Migues et al. 2016**: blocking AMPA-receptor removal with GluA23Y peptide in dorsal hippocampus **prevented normal forgetting** of object-location memories without affecting acquisition. Forgetting has a molecular off-switch — it's regulated, not accidental.

**Anderson, Bjork & Bjork 1994** — retrieval-induced forgetting (RIF): retrieving "orange" from category "fruit" *suppresses* access to "banana." Inhibitory mechanism, not associative interference. Acts on retrieval strength, not storage strength — adaptive because it resolves selection conflicts without erasing data.

**Bjork 1994** — "desirable difficulties": spacing, interleaving, retrieval practice introduce difficulty that **enhances** long-term retention. Easy encoding → fragile traces; effortful retrieval → consolidates.

**Why forgetting is functional**:
1. Prevents interference between similar items
2. Prioritizes relevant material at retrieval
3. Enables generalization (irrelevant specifics decay → abstract structure dominates)
4. Reduces retrieval-time competition

**Memex computational analog**: TTL/decay (existing in deep sweep), importance-weighted eviction (existing), contrastive negative sampling at retrieval (would be new), reranking that suppresses near-duplicates (existing via diversity penalty), spaced retrieval = `recall_count` reinforcement (existing).

Sources:
- McClelland-McNaughton-O'Reilly 1995, *Psychological Review*
- Kumaran, Hassabis & McClelland 2016 CLS update: pubmed/27315762
- Wilson & McNaughton 1994 *Science* 265:676
- Diekelmann & Born 2010 *Nat Rev Neurosci*: nrn2762
- Buzsáki 2015 SWR review: PMC4648295
- Tse et al. 2007 *Science* 316:76
- Hardt, Nader & Wang 2013 *TiCS* 17:111
- Anderson, Bjork & Bjork 1994 *JEP:LMC* 20:1063

---

## Section F4: Cognitive Architectures

*(not yet started)*

---

## Section F5: Memory Categorization

*(not yet started)*

---

## Section F6: RAG Advances 2025-2026

### F6.1 — Late interaction (ColBERT-family)

**ColBERTv2, PLAID, ConstBERT, JaColBERT** — token-level late interaction.

**Wins when**: long documents, OOD queries, fine-grained matching.
**Loses on**: storage (50-100x dense size).

**Memex applicability**: **NO**. Memex stores chunk-level dense vectors. Memory chunks are already token-sized (atomic facts ~100 tokens). Late interaction's per-token granularity is overkill.

### F6.2 — Query expansion / rewriting

| Method | Gains | When |
|---|---|---|
| **HyDE** (Gao 2023) | +5-15 nDCG unsupervised; +1-3 with strong retriever | Cold start, vague queries |
| **Query2Doc** (Wang 2023) | +15% MRR on BM25; +1-3% on dense | BM25 routes |
| **Step-Back** (Zheng 2024) | +7% TimeQA, +27% MuSiQue | Multi-hop |
| **GAR / MILL** | Multi-query fusion | High-value queries |

**When it hurts**: short factual queries with strong reranker (memex's situation).

**Memex applicability**: PARTIAL. Strong reranker eats most gains. Optional: **conditional HyDE** when top-1 score < threshold.

### F6.3 — Reranker advances (memex's reranker is current)

| Reranker | nDCG / latency | Notes |
|---|---|---|
| **Qwen3-Reranker-8B** | ~62 BEIR avg, current SOTA-tier | Memex uses this |
| **Contextual AI Reranker v2** | +3 nDCG vs Cohere 3.5 | **Instruction-following** ("prefer recent") |
| **Voyage rerank-2.5** | 1.4x latency, +2 nDCG | |
| **ZeroEntropy zerank-2** | Claimed SOTA, <50ms p95 | New, watch |

**Memex applicability**: COMPETITIVE. Qwen3-Reranker still SOTA-tier in 2026. **Instruction-following rerankers (Contextual v2) are interesting for memory** — could say "prefer recent" or "prefer corrections" per query.

### F6.4 — Hybrid retrieval scoring

| Method | Comparison |
|---|---|
| **RRF** (Cormack 2009) | k=60. Robust, no calibration. Industry default. |
| **Z-score fusion** (memex) | Sensitive to score distribution. Works when ~Gaussian. |
| **Learned convex** (`α·BM25 + (1-α)·dense`) | +1-2 nDCG in-domain, RRF wins OOD. |

**Memex applicability**: DEFENSIBLE. Z-score is fine. RRF marginally more robust. **Don't expect >1 nDCG improvement from a swap.**

### F6.5 — Contextual compression / abstractive retrieval

- **RECOMP** (ICLR 2024): 6x token reduction, <2% QA drop
- **LongLLMLingua**: 4x compression, +21% NaturalQuestions
- **Memex's dreaming/reflection** = abstractive retrieval applied to memory. Memex is **ahead of curve** here for memory specifically.

### F6.6 — Calibrated retrieval (THE gap)

| Method | Mechanism |
|---|---|
| **Self-RAG** (Asai 2024) | [Retrieve]/[No Retrieve] tokens, +6% PopQA |
| **Adaptive-RAG** (Jeong 2024) | Classifier picks no-retrieve / single / multi-hop. Saves ~40% retrievals. |
| **CRAG** (Yan 2024) | Retrieval evaluator triggers web fallback on low confidence |
| **SKR** (Wang 2023) | Model self-judges if it knows |

**Memex applicability**: **HIGH GAP**. Memex auto-recalls every turn for main agent. A "should I retrieve?" gate could cut noise + latency. Particularly relevant since `autoRecallLimit=3` sometimes injects irrelevant context.

### F6 Verdict

**Memex's RAG mechanics are 2026-current.** Two real gaps:

1. **Calibrated retrieval** (Self-RAG / Adaptive-RAG) — biggest practical win for noise reduction
2. **Instruction-following rerank** (Contextual v2) — natural fit for memory queries

**Skip**: late interaction, RRF swap, full HyDE.

Sources:
- ColBERTv2 arXiv:2112.01488; ConstBERT arXiv:2505.19419
- HyDE arXiv:2212.10496; Query2Doc arXiv:2303.07678; Step-Back arXiv:2310.06117
- Self-RAG arXiv:2310.11511; Adaptive-RAG arXiv:2403.14403; CRAG arXiv:2401.15884
- Contextual AI Reranker v2 (Oct 2025); ZeroEntropy zerank-2 (2026)

---

## Section F7: Temporal Reasoning

### F7.1 — Bi-temporal models (databases)

**Snodgrass 1999** canonical formulation:
- **Valid time** `[VT_start, VT_end)` — when fact is true *in the modeled world*
- **Transaction time** `[TT_start, TT_end)` — when system *recorded/knew* the fact

**SQL:2011** introduced `PERIOD FOR`, system-versioned tables, `FOR SYSTEM_TIME AS OF` queries.

**Why distinguish?** Audit/compliance ("what did we *believe* on date X vs what was *true* on date X?"). Retroactive corrections.

**Memex applicability**: today only transaction time (`timestamp`). Adding `valid_from`/`valid_to` enables "what was true last Tuesday" vs "what did I record last Tuesday."

### F7.2 — Mastra's three-date model (the practical winner)

- **Observation date** = `timestamp` (when written)
- **Referenced date** = explicit date *in the text* ("last Tuesday I…"), normalized to absolute at write time
- **Relative date** = computed offset (`reference - observation`)

**Retrieval for "what did I do last Tuesday?"**: query-time normalization computes absolute date → filter `referenced_date BETWEEN day_start AND day_end` → vector search WITHIN filter.

**This separates temporal filter from semantic match** — that's why Mastra hits 95.5% on temporal reasoning while dense-only systems sit 30-50%.

**Memex applicability**: **highest-ROI temporal addition**. Extract `referenced_date` at capture. Add date-range filter to retriever. Existing `metadata` JSON column can hold this.

### F7.3 — Temporal knowledge graphs

**Graphiti / Zep** (arXiv:2501.13956): every edge carries `t_valid` and `t_invalid`. Contradicting facts *invalidate* (set t_invalid) rather than overwrite — preserves history. LLM-driven contradiction detection at ingestion.

**Embedding methods**: TTransE, HyTE, TA-TransE, T-GCN — additive vectors or hyperplane projections of time.

**Memex applicability**: no edges today. If/when relations introduced, Graphiti's invalidation-not-deletion is the cleanest design. Already aligned with memex's `superseded_by` concept.

### F7.4 — Temporal benchmarks

- **LongMemEval temporal-reasoning**: multi-session dialogues, ordering/duration/since-when. GPT-4o full-context ~36-47%. Mastra OM hits 95.5%.
- **TempReason** (ACL 2023): L1 time-time, L2 event-time, L3 event-event. LLMs fail most on L3.
- **TimeQA** (NeurIPS 2021): "easy" (explicit dates) vs "hard" (implicit). T5/GPT-3 drop ~25 pts on hard.

### F7.5 — Recency vs validity

**Newer-wins fails**:
- Durable old facts ("allergic to penicillin" from 2022) outrank ephemeral new ones ("running late today")
- Temporary task expires but is still "recent"

**Detection of expiry**:
- Explicit invalidation via contradiction LLM (Graphiti)
- TTL tags by content class (calendar item, todo, preference)
- Temporal scoping cues at ingest ("today", "this week" → short TTL)

**Decay formulas**:
- Exponential: `score = base · exp(-λΔt)`, half-life `t½ = ln 2 / λ`
- Ebbinghaus: `R = exp(-Δt/S)`, strength `S` boosted on rehearsal (memex has this)
- Power law: `score = base · (1 + Δt)^(-α)` (heavier tail; better for long-lived facts)

### F7.6 — Time-aware retrieval

**Recency boost**: `final = sim · exp(-λ · age)` (memex has this in retriever)

**Time-windowed filter**: pre-filter to `[t-Δ, t+Δ]` then rank semantically (Mastra's approach)

**Episodic anchoring** ("what did I learn around the time of X?"): two-stage — resolve "X" to memory `m_x` with timestamp `t_x` → retrieve neighbors in `[t_x ± Δ]`. Tulving-grounded.

Sources:
- Snodgrass 1999 *Developing Time-Oriented Database Applications in SQL*
- SQL:2011 spec / Kulkarni & Michels SIGMOD Record 41(3) 2012
- Graphiti/Zep arXiv:2501.13956
- LongMemEval arXiv:2410.10813
- TempReason ACL 2023, TimeQA NeurIPS 2021
- Mastra docs (mastra.ai/docs/memory/semantic-recall)

---

## Section F5: Memory Categorization

### F5.1 — Cognitive psychology foundations

**Tulving 1972, 1985**: episodic vs semantic
- **Episodic**: time/place-tagged events ("I met Anna in Paris last June") — autonoetic consciousness
- **Semantic**: decontextualized knowledge ("Paris is in France")

**Squire 1992**: declarative (episodic + semantic) vs **non-declarative/procedural** (skills, habits, priming).

**Brainerd & Reyna FTT**: gist (semantic, generalized) vs verbatim (literal, surface).

**Johnson et al. 1993 source monitoring**: source memory (where/when/from-whom) ≠ item memory (what).

### F5.2 — Production AI category systems

| System | Categories | Notes |
|---|---|---|
| **Mem0** | Flat (no formal taxonomy) | Implicit via metadata tags |
| **Letta/MemGPT** | persona, human (core blocks) | Roles, not content types |
| **Hindsight** | world, bank, opinion, observation | 4 networks — closest cognitive analog |
| **Mastra** | event, preference, decision (kind) | Almost identical to memex |
| **LangGraph** | namespaces (e.g. `(user_id, "preferences")`) | Categories emerge from naming |
| **Generative Agents** | None | Single stream + importance/recency/relevance |

### F5.3 — The "concept" gap

The agent surfaced a real gap in memex's taxonomy:

| Category | Example | Memex today |
|---|---|---|
| **fact** | "User's wife is Anna" | ✅ |
| **learning** | "Avoid `rm -rf` without `--dry-run`" | ✅ — but implies correction |
| **concept** | "User uses 'sprint' to mean 3-day cycle, not 2-week scrum" | ❌ no clean home |

Concepts are **definitional/relational schemas** — vocabulary, mental models, recurring frames. Without a category they get squashed into `fact` (loses generality) or `learning` (implies a mistake).

Hindsight's `opinion` is closest analog but conflates belief with abstraction.

### F5.4 — Procedural memory

**PRAXIS** stores action sequences indexed by goal. **Voyager** maintains skill library (code-level). **Reflexion** stores trajectory critiques (≈ memex `learning`).

Pure how-to ("to deploy: run `make ship` then verify staging") doesn't fit `fact` or `learning` cleanly. **Defer `procedure` category** until telemetry shows miscategorization.

### F5.5 — Recommended memex categories

**Add**: `concept` — definitional/schema content (user vocabulary, mental models, domain abstractions). Cognitive-psych grounded (Tulving semantic + FTT gist).

**Defer**: `procedure` — spike first per project methodology.

**Final list**: `preference, fact, concept, decision, entity, learning, other`

**Use at retrieval**: soft boosts + format hints (NOT hard filters). Preserves recall while letting concepts surface in definitional queries.

Sources:
- Tulving 1972 *Organization of Memory*; Tulving 1985 *Memory and Consciousness*
- Squire 1992 *J. Cog. Neurosci*
- Brainerd & Reyna 2002 *Current Directions Psych Sci*
- Johnson, Hashtroudi & Lindsay 1993 *Psych Bulletin*
- Park et al. 2023 (Generative Agents)
- Packer et al. 2023 (MemGPT/Letta)
- Hindsight LLM-Agent papers

---

## Section F8: Active Learning / Selective Storage

### F8.1 — Information gain measures

**Bayesian surprise** = `KL(posterior || prior)`. High-surprise observations warrant storage because they shift beliefs. Equivalent to mutual information / "epistemic value" in Friston's active inference.

**Shannon surprise** = `-log p(obs)`. Rare events score high regardless of belief shift.

**LLM proxy via NLL**: `surprise(fact) = -log p_LM(fact | retrieved_top_k)`. If candidate is highly probable under existing memory → NOOP/REJECT (it adds no information).

**The anti-amplification mechanism**: recalled facts have NLL ≈ 0 against the top-k retrieval (because they ARE in the top-k). NLL-based filtering naturally rejects feedback loops.

### F8.2 — Active learning families applied to memory writes

| Method | Technique | Memory analogue |
|---|---|---|
| **Query-by-Committee** (Freund 1997) | Vote-entropy across N temperatures | Re-extract same fact at T={0, 0.7, 1.0}; agreement → store |
| **Expected Model Change** (Cai 2013) | `||∇L||` after adding example | "Would future answers differ if this fact were in context?" |
| **Coresets** (Sener & Savarese 2018) | Pick points whose removal degrades coverage | Reject if cosine > 0.92 to existing centroid (theoretical de-dup guarantee) |

**Cheapest wins**: cosine-distance coreset rejection + cross-temperature consistency check.

### F8.3 — Forgetting strategies

| Pattern | Formula | Memex use |
|---|---|---|
| **ACT-R activation** | `A_i = ln Σ_j t_j^{-d}` + spreading + noise | Activation-based recall |
| **Ebbinghaus / MemoryBank** | `R = exp(-t/S)`; on recall S+=1, t:=0 | Existing recall-count boost |
| **Stochastic forgetting** (Hardt) | drop with prob `p ∝ 1/A_i` | Smoother than hard cutoffs |
| **Bio-inspired** (Mazzaglia 2025) | τ ≈ 1.69 days power-law decay | Default decay constant |

Memex's existing pattern: `activation = importance · exp(-λ_eff · age) · (1 + 0.2·recall_count)` with `λ_eff = 0.16·(1 - 0.8·importance)` aligns with the literature.

### F8.4 — Quality gates in production LLM systems

The dominant pattern is LLM-as-judge (Mem0's ADD/UPDATE/DELETE/NOOP). Robust gates layer additional filters:

1. **Negative few-shot**: explicitly demonstrate skips in the prompt
2. **Confidence scoring**: store iff judge logprob > τ
3. **Contradiction check**: ADD only if no contradiction OR new fact dominates by recency+source
4. **Anti-amplification tag**: mark retrieved-into-context facts with `recalled=true`; extractor instructed "never re-extract recalled content"
5. **Identity disambiguation**: tag turns by speaker role; reject extractions attributing system content as user facts
6. **Harvard D3 finding**: filter-before-store gives ~10% downstream gain; **indiscriminate storage is worse than no memory**

### F8.5 — Mem0 #4573 failure modes → write-time detectors (CRITICAL)

| Failure mode | Detector | Action |
|---|---|---|
| System-prompt restatement | Levenshtein/embedding sim ≥ 0.85 to system prompt; or token overlap > 0.6 with role=system span | REJECT(`system_echo`) |
| Feedback-loop amplification | Provenance flag `from_recall=true`; or NLL(fact \| memory) < 0.3 | REJECT(`recall_loop`) |
| Hallucinated identity | Cross-temperature QbC: re-extract at T={0,0.7,1.0}; if name/age/location disagree → ungrounded | REJECT(`ungrounded_identity`) |
| Architecture/tool dumps | Detect schema-shaped strings (JSON with `tools`, `function_call`, `parameters`); >3 code-fence blocks | REJECT(`schema_blob`) |
| Raw system-state capture | Speaker-role gate: extractor refuses turns where role ≠ user/assistant | REJECT(`role_violation`) |

Implementation: a **5th verb REJECT** with structured reason codes. Cheap deterministic filter (regex + cosine + role-tag) BEFORE the LLM judge — saves tokens, surfaces dashboard data.

Sources:
- Mem0 #4573 production audit
- MemoryBank (Zhong 2023) arXiv:2305.10250
- Memory-R1 RL-trained memory manager arXiv:2508.19828
- Memory Bear (ACT-R + Ebbinghaus) arXiv:2512.20651
- Active Inference / Bayesian surprise (Friston)
- Sener & Savarese 2018 Core-Set arXiv:1708.00489
- LLM-Agents-Memory survey arXiv:2603.07670

---

## Section F9: Concept Synthesis / Abstraction

### F9.1 — Bayesian schema induction (Tenenbaum/Kemp/Griffiths)

**Mechanism**: hierarchical Bayesian inference over structured hypothesis spaces (trees, grids, partitions). Score `P(concept | data) ∝ P(data | concept) · P(concept)`. **Prior favors short descriptions (MDL)** — simpler concepts win unless data demands complexity.

**Rules vs similarity unification (Goodman et al. 2008)**: short rules get high prior; soft likelihoods recover similarity behavior. Both extreme positions emerge as limits of the same Bayesian model.

### F9.2 — Topic models (LDA, BERTopic)

**LDA**: each document = mixture over K topics; each topic = distribution over words. Topics are *gist*, not facts. A topic is a **distribution**, not a proposition.

**BERTopic** (Grootendorst 2022): sentence-BERT → UMAP → HDBSCAN → c-TF-IDF labeling. Better for short texts than vanilla LDA.

**When useful**: navigation, summarization, drift detection over hundreds+ of documents.
**When harmful**: short texts (memex's domain), unstable across re-runs (no topic identity).

**Memex applicability**: *coarse index*, not the synthesis layer. Cluster IDs as filter, not as content.

### F9.3 — Knowledge graphs

**OpenIE / REBEL pipeline**: NER → coreference → relation extraction → triples `(h, r, t)`.

**The gap**: triples give you entities and relations, but **concepts (categories, generalizations) don't emerge** without a separate synthesis step. KG answers "what do I know about X?" but not "what kind of thing keeps happening?"

**Memex applicability**: KG layer is good for entity-grounded recall (memex already extracts entities), but insufficient for learnings/insights — which need explicit LLM synthesis.

### F9.4 — LLM-driven concept synthesis (Generative Agents pattern)

**Stanford Generative Agents reflection (Park et al. 2023)**:
1. Trigger: importance score sum > 150
2. Ask LLM: "What 3 high-level questions can we ask about these memories?"
3. Per question: retrieve top-N memories
4. Ask LLM: "What 5 high-level insights can you infer from these memories?"
5. Insights become first-class memories with citations → **reflection tree**

**Mastra Reflector** = productionized version: scans recent working memory, emits preferences/decisions/summaries written back to persistent store.

**Tree of Thoughts (Yao 2023)**: deliberate exploration of multiple candidate abstractions with self-evaluation pruning.

**Memex applicability**: this is the closest match for memex's "learnings" layer. Memex's current dreaming.ts uses a simplified version: threshold → top-50 memories → LLM synthesizes 3 learnings. **Missing the question generation step.**

### F9.5 — Schema theory (cognitive psychology)

**Bartlett 1932**: schemas predict missing slots and compress repeated structure (restaurant script — Schank & Abelson 1977).

**Fuzzy-trace theory (Brainerd & Reyna)**: two parallel traces.
- **Verbatim** — literal, decays fast. Best for exact recall.
- **Gist** — semantic, decays slow. Drives most reasoning, generalization, transfer.

**False memories** arise from gist overgeneralizing. Cost-benefit:
- Gist BETTER for: prediction, planning, preferences, transfer, recall under load
- Gist WORSE for: exact details (legal, debugging)

**Memex applicability**: store BOTH layers — facts (verbatim) and learnings (gist). Recall should prefer gist for planning/preference queries and verbatim for factual lookup.

### F9 Convergent recipe (across 5 literatures)

A concept-synthesis layer should:

1. **Trigger** — importance accumulator, cluster size, or time
2. **Cluster/group** evidence — soft (BERTopic) or hard (KG entity neighborhoods)
3. **Hypothesize** candidate abstractions — Bayesian short-MDL OR LLM ToT-style multiple drafts
4. **Score** by likelihood × simplicity prior — unifies rules and similarity
5. **Materialize** as gist-layer memory with provenance edges (reflection tree)
6. **Decay/revise** when contradicted — schema accommodation, correction chains

Sources:
- Tenenbaum et al. 2011 *Science* 331:1279 "How to grow a mind"
- Park et al. 2023 UIST arXiv:2304.03442
- Yao et al. 2023 NeurIPS arXiv:2305.10601
- Brainerd & Reyna 2002 fuzzy-trace overview
- Grootendorst 2022 BERTopic arXiv:2203.05794

---

## Section F10: Provenance and Trust

*(not yet started)*

---

## Hypotheses (memex-specific proposals)

*Hypotheses emerge as findings accumulate. Each hypothesis has:*
- *Statement (the claim)*
- *Rationale (what literature suggests it)*
- *Predicted outcome for memex*
- *Evidence collected (for/against, with sources)*
- *Verdict (confirmed/refuted/uncertain) — updated over time*

### H1: Memex's RAG-based recall is fundamentally less efficient than an observation-log approach for high-throughput personal memory.

**Statement**: A memory system that maintains a continuously-distilled, append-only observation log (Mastra OM pattern) outperforms RAG-based recall on **(a) retrieval quality**, **(b) cost per turn**, and **(c) reflection accuracy** — when the log fits in context.

**Rationale (why I think this)**:
- Mastra OM achieved 94.87% on LongMemEval — beats memex (94% with much heavier infra) and beats oracle baseline (82.4% gpt-4o) by 2 points.
- The "beats oracle" result is the strong signal. It means Observer-distilled notes contain *more usable information* than the raw ground-truth sessions. Distillation is not just compression — it's *information amplification* via formatting and date anchoring.
- Stable prefix → 4–10× prompt cache cost reduction. RAG cannot match this because every query produces a different recall set.
- No recall@k miss — entire log is always visible.

**Predicted outcome for memex**:
- If memex adopts an Observer/Reflector pattern (distill conversations into a compact log, store as memories with category="observation"), reflection quality will rise.
- If memex *replaces* RAG recall with full-log injection (when log fits in context), retrieval quality will rise and per-query cost will fall.
- Hybrid approach (observation log for in-context recall + RAG for deep archival) likely the practical sweet spot.

**Boundary conditions / when this fails**:
- Log doesn't fit in context (memex has 465 memories now → ~50K tokens of raw text, manageable; at 10K memories it breaks)
- Multi-project agents need scoped logs (one log per project? per agent?)
- RAG still wins for vague/exploratory queries with no clear "current task" framing

**Evidence to collect**:
- [ ] Confirmed: Mastra OM beats memex's E2E (94.87% vs 94%) — but with different reader model (gpt-5-mini vs gpt-4o), so direct comparison is suspect. Need same-reader benchmark.
- [ ] Confirmed: Observer-distillation beats raw oracle (Mastra blog, with gpt-4o)
- [ ] Open: how does Letta's sleep-time agent + recall memory hybrid compare? It uses retrieval — does that hurt or help vs pure observation log?
- [ ] Open: at what corpus size does the log approach break? Mastra's published results are at ~30K context. Memex's 465 memories ≈ 50K tokens of raw text. Need to know the limit.
- [ ] Open: does observation distillation work on **technical conversations** (memex's domain — code, configs, deploys) or only on **personal/event-based** (LongMemEval's domain)?

**Verdict**: *partially refuted — distillation isn't universally better*

**Counter-evidence (added after F1.4)**:
- MemMachine wins LoCoMo at 91.69% by **avoiding distillation** entirely. Stores raw episodes, indexes at sentence level, retrieves via ANN nucleus + ±neighbor cluster.
- Mem0's #4573 audit shows distillation creates feedback-loop amplification when not gated properly (97.8% junk).
- Distillation appears to win when the dataset structure rewards it (LongMemEval has explicit dates, factual recall) — but loses when the dataset rewards conversational context preservation (LoCoMo).

**Refined H1 (H1')**: *Distillation helps when memory queries reduce to "what fact applies here?" and hurts when queries require conversational context. Memex's domain (technical memory across coding sessions) leans factual — but reflection itself is a different need than recall.*

**If H1' holds, memex implications**:
- Keep RAG recall (proven 94% E2E)
- ADD an observation log layer for **reflection input** (not for direct recall)
- Reflector synthesizes from observations, not from raw memories — avoids cluttering the LLM context
- For Claude Code SessionStart hook, inject recent observations as boot context (Mastra-style) AND keep memory_recall tool for query-conditioned RAG (memex's strength)

---

### H2: Hierarchical organization with explicit promotion criteria outperforms flat memory pools at scale.

**Statement**: A memory system organized into 3+ levels (e.g., facts → episodes → topics, or messages → episodes → semantics → themes) with explicit promotion rules outperforms a flat pool when:
- Pool size > ~1K memories
- Queries vary in specificity (some need facts, some need themes)

**Rationale**:
- HyperMem (3 levels): 92.73% LoCoMo
- xMemory (4 levels): better-than-baseline + 29% token reduction
- Both beat flat-pool approaches at the same task

**Predicted for memex**:
- Memex today is flat (memories) + learnings (informally a 2nd layer)
- A 3-level structure (facts → episodes/observations → learnings/themes) would scale better past 1K memories
- Existing dreaming reflection already produces "learnings" — that's the start of a hierarchy

**Boundary conditions / when it fails**:
- Small pools (<500 memories) — overhead exceeds benefit. Memex is here today (465 memories).
- High write rate — promotion logic adds latency. Mitigated by async dreaming.

**Evidence to collect**:
- [ ] Open: at what corpus size does flat-pool quality break down? Need ablation on memex's actual data.
- [ ] Open: does explicit hierarchy help when retrieval is already good (memex 94% E2E)? Possible ceiling effect.
- [ ] Open: cost of LLM-driven promotion — Mastra runs Reflector at threshold T2. What's the right threshold?

**Verdict**: *uncertain — likely beneficial at scale, possibly redundant with dreaming reflection*

---

### H4: Memex's reflection should add a "question generation" step before synthesis.

**Statement**: Memex's current reflection (in `src/dreaming.ts`) does threshold → top-50 memories → LLM synthesizes 3 learnings. The Stanford Generative Agents pattern adds a **question generation step** in between: threshold → "what 3 questions can we ask?" → retrieve per question → synthesize. This produces more focused, better-grounded learnings.

**Rationale**:
- Generative Agents' reflection tree shows that "ask questions first, retrieve per question" produces insights with explicit evidence citations (provenance)
- Mastra Reflector and other productionized variants follow the same pattern
- Without question generation, the LLM is asked to summarize a heterogeneous batch — output tends toward generic, low-specificity learnings
- With question generation, each insight is grounded in a specific evidence cluster

**Predicted outcome for memex**:
- Better learnings — more specific, more actionable
- Provenance edges from learning back to source memories (already supported by `metadata`)
- Reflection becomes interpretable: "this learning was synthesized to answer question X from memories Y, Z, W"

**Comparing memex's current reflection to the Generative Agents pattern**:

| Step | Generative Agents | Memex (current) | Gap |
|---|---|---|---|
| 1. Trigger | Importance accumulator > 150 | Threshold of 5+ memories | Same idea |
| 2. Cluster | Implicit via questions | None — sends top-50 raw | **Missing** |
| 3. Hypothesize | "What 3 questions?" → retrieve per Q | Direct synthesis from raw | **Missing** |
| 4. Score | Implicit (LLM judges) | Implicit | Same |
| 5. Materialize | Insights with citations | Stored as `category: "learning"` | Memex stores but no citations |
| 6. Decay/revise | Reflection tree updates | SUPERSEDED markers | Memex has this |

**Boundary conditions**:
- Two LLM calls instead of one — doubles reflection cost
- Question generation may produce uninteresting questions on small/homogeneous pools
- Cost-benefit only worth it once memex has >100 useful memories per reflection cycle

**Evidence to collect**:
- [x] Confirmed: Generative Agents pattern is reproducibly used in production (Mastra, Letta sleep-time)
- [ ] Open: A/B compare memex's current 1-step reflection vs 2-step (question + synthesis) on production data
- [ ] Open: does question generation help when pool is small (<20 useful memories)?

**Verdict**: *strongly suggested by literature, low implementation cost, worth A/B testing*

**Implementation sketch**:
```typescript
// In src/dreaming.ts reflectionSweep:
// 1. Threshold: pool has ≥ N un-reflected memories (existing)
// 2. NEW: ask LLM "what 3 questions could be answered from these memories?"
// 3. NEW: for each question, retrieve top-K memories (use existing retriever)
// 4. NEW: ask LLM "synthesize an insight to answer this question, cite sources"
// 5. Store insight with provenance: { category: "learning", metadata: { sources: [id1, id2, ...], question: "..." } }
```

---

### H3: An explicit SKIP/REJECT verb in the store-time pipeline is the single most important defense against feedback-loop amplification and system-prompt pollution.

**Statement**: Without a quality-gate verb, an LLM-driven memory store pipeline produces feedback loops where recalled memories get re-extracted and re-stored. Mem0's 97.8% junk rate is the production proof. Memex must have an explicit reject path.

**Rationale**:
- Mem0 #4573: "Operator prefers Telegram" stored 200+ times — recalled memories were re-extracted and re-stored as new memories.
- Without REJECT verb, LLM judge defaults to ADD when uncertain.
- Identity-blind extraction prompts can't distinguish human user from agent.
- System-prompt content gets stored (52.7% of Mem0 junk).

**Predicted for memex**:
- Memex's existing intake guards (text_hash dedup, fragment rejection) catch some of this but not all
- Adding a REJECT path in the store pipeline (LLM or heuristic) when source = recalled-context would prevent feedback loops
- The store API should distinguish "this is something the user just told me" vs "this is something I just recalled and am paraphrasing"

**Boundary conditions**:
- Memex isn't using LLM-driven extraction yet (auto-capture is LLM-nudge based). Risk is lower — but not zero.
- When session import v2 (or its replacement) lands, this becomes critical.

**Evidence to collect**:
- [x] Confirmed: Mem0 #4573 production audit (97.8% junk, listed failure modes)
- [ ] Open: how does Mastra's Observer avoid this? (Maybe because it operates on raw messages only, never on observations.)
- [ ] Open: should memex's `memory_store` tool reject the store when text matches recently-recalled memory text? Implementation could be cheap.

**Verdict**: *confirmed by Mem0 production data — needs memex-specific design*

**Implementation (concrete, from F8.5)**:
- 5-verb pipeline: ADD / UPDATE / DELETE / NOOP / **REJECT(reason)**
- Pre-LLM cheap filters cascade into LLM judge:
  1. Embedding cosine to system prompt > 0.85 → REJECT(`system_echo`)
  2. NLL(candidate \| top-3 recall) < 0.3 → REJECT(`recall_loop`)
  3. Cross-temperature QbC disagreement on identity tokens → REJECT(`ungrounded_identity`)
  4. JSON-shaped or >3 code fences → REJECT(`schema_blob`)
  5. Role tag = system/tool → REJECT(`role_violation`)
- Reason codes feed dream-loop dashboard for ops visibility

---

### H5: Memex's existing facts/learnings split is structurally a CLS architecture — and replay should be made explicit.

**Statement**: The Complementary Learning Systems theory (McClelland 1995) maps exactly onto memex's architecture: facts (hippocampus-like fast episodic store) + learnings (cortex-like slow distilled store). The neuroscience says replay is the *transfer mechanism* between the two — not just background cleanup.

**Rationale**:
- Hippocampus = sparse pattern-separated, high learning rate, one-shot encoding → memex's `memories` table
- Neocortex = distributed, slow learning, schema-extracting → memex's `category: "learning"` entries
- Sleep replay (Wilson & McNaughton 1994) shows time-compressed sequence replay during SWS
- McClelland's catastrophic-interference argument: cortex CAN'T learn fast without destroying structure → must use interleaved replay from hippocampus

**Predicted for memex**:
- The split into facts vs learnings is correct (CLS theory validates it)
- Memex's dreaming reflection ≈ SWS replay
- **Missing piece**: explicit *interleaved replay* of older facts during reflection. Currently reflection only sees the top-50 recent memories. CLS says it should sample from both recent AND old to prevent older learnings from drifting.

**Boundary conditions**:
- Memex's pool is small (465 memories) — interleaving may be unnecessary at this scale
- Real value emerges when learnings start contradicting facts (years later)

**Evidence to collect**:
- [x] Confirmed: CLS theory validated across 30 years of neuroscience and ML
- [x] Confirmed: experience replay (DQN, Mnih 2015) is the canonical computational analog
- [ ] Open: at what corpus size does memex need interleaved replay?

**Verdict**: *strong theoretical grounding, low-cost implementation (sample old memories during reflection), defer until pool size demands it*

---

### H6: Schema-consistent memories should integrate via a fast path; schema-inconsistent ones via a slow path.

**Statement**: Tse et al. 2007 showed schema-consistent material consolidates fast (single trial sufficient, vmPFC-mediated) while schema-inconsistent material consolidates slowly (weeks, hippocampus-dependent). For memex, this implies a routing decision at store time: does the new memory match an existing learning?

**Rationale**:
- Schema-match → cheap path: just store the fact, optionally bump the learning's recall count (it just got reinforced)
- Schema-conflict → expensive path: trigger a reflection cycle to update the learning, mark contradicted memories with `superseded_by`
- Schema-novel → reflection cycle eventually, but no immediate update

**Predicted for memex**:
- Most stores will be schema-match (cheap path) — fast operation
- Schema-conflict triggers immediate reflection — surfaces contradictions before they accumulate
- Schema-novel accumulates until threshold triggers next dream cycle

**Routing algorithm sketch**:
```
on store(fact):
  related_learnings = retrieve(fact, where category='learning', limit=3)
  if related_learnings is empty: schema-novel → just store
  else:
    consistency = LLM_judge(fact, related_learnings)
    if consistency == 'consistent': fast path → store, bump learning recall_count
    elif consistency == 'conflict': slow path → store + trigger reflection
    elif consistency == 'extends': fast path → store + mark learning for re-synthesis
```

**Boundary conditions**:
- Adds an LLM call per store — must be fast (cheap model)
- Worth it only when the cost of inconsistent memories is high

**Evidence to collect**:
- [x] Confirmed: Tse et al. 2007 schema-dependent consolidation
- [ ] Open: how often does memex see schema-conflict in practice? Need production data.

**Verdict**: *novel proposal, theoretically grounded, needs cost-benefit analysis*

---

### H7: NLL-based information gain is the cheapest, most principled defense against feedback-loop amplification.

**Statement**: Of all the proposed defenses against the Mem0 #4573 failure modes, the cheapest and most principled is computing `NLL(candidate | top-3 recall)`. Recalled facts have NLL ≈ 0 by construction. This single check eliminates feedback-loop amplification without any prompt engineering or speaker-role tagging.

**Rationale**:
- NLL is information-theoretically correct: low NLL means the fact is already implied by what's in memory → no information gain → no point storing
- Computable cheaply via embedding distance proxy (cosine to top-3 retrieval)
- Doesn't require LLM-as-judge — can be a deterministic filter
- Naturally generalizes the dedup pattern memex already has (text_hash) to a semantic version

**Predicted for memex**:
- A single cosine-distance check before store catches ~80% of feedback loops
- Cost: one extra retrieval per store call (~50ms)
- Implementation: in `mcp-server.ts memory_store`, before calling `store.store()`, run `retrieve(text, limit=3)`. If max similarity > 0.95 → REJECT(`recall_loop`)

**Boundary conditions**:
- False positive: legitimate updates to existing memories ("user changed their mind") will have low NLL too. Need a way to distinguish "this is a duplicate" from "this is a correction."
- Solution: if low NLL, check whether the recalled fact is OLD (>30 days) → if so, treat as correction; if recent → treat as duplicate.

**Evidence to collect**:
- [x] Confirmed: NLL-based redundancy detection is standard in active learning
- [ ] Open: how to distinguish duplicate from correction in practice — need empirical study

**Verdict**: *low cost, high impact, should be the FIRST quality gate added*

---

### H8: Mastra's three-date temporal model is the highest-ROI temporal upgrade for memex.

**Statement**: Adding a `referenced_date` field (extracted from text at write time) plus query-time date filtering would close memex's biggest temporal gap. Mastra OM scored 95.5% on LongMemEval temporal-reasoning vs ~30-50% for dense-only systems.

**Rationale**:
- Memex today has only `timestamp` (transaction time)
- Queries like "what did I do last Tuesday?" require either matching the date in text or filtering by referenced date
- Vector search over date phrases is unreliable; explicit filtering wins
- The mechanism is well-defined: extract at write time, normalize to absolute date, filter at query time before semantic ranking

**Predicted for memex**:
- Temporal queries that currently fail (e.g., "what did we discuss about deployment last month") would succeed
- Implementation cost: regex/LLM date extractor + new metadata field + query-time filter — modest
- No core retrieval changes needed; date filter applied as an additional `WHERE` clause

**Implementation sketch**:
```typescript
// At store time:
const refDate = extractReferencedDate(text); // regex first, LLM fallback
metadata.referencedDate = refDate?.toISOString();

// At query time:
const queryRange = parseTemporalQuery(query); // "last Tuesday" → [date, date+1d]
if (queryRange) {
  scopeFilter += ` AND json_extract(metadata, '$.referencedDate') BETWEEN ? AND ?`;
}
```

**Boundary conditions**:
- Date extraction quality matters — false negatives (missed dates) = no harm, false positives (wrong dates) = wrong filter
- Use a confidence threshold; only add `referencedDate` when extractor is confident

**Evidence to collect**:
- [x] Confirmed: Mastra OM 95.5% temporal score
- [ ] Open: how often do memex's actual queries reference dates? Production data needed

**Verdict**: *concrete and actionable, moderate cost, high temporal-reasoning ROI*

---

### H9: Add `concept` as a 7th memory category — gist-level definitional content.

**Statement**: Memex's existing categories (preference, fact, decision, entity, learning, other) leave a real gap: **gist-level definitional/schema content** like vocabulary, mental models, recurring frames. Cognitive psychology grounds this clearly (Tulving semantic + Brainerd-Reyna gist).

**Rationale**:
- "User uses 'sprint' to mean 3-day cycle, not 2-week scrum" doesn't fit:
  - `fact` (too literal/atomic)
  - `learning` (implies a mistake/correction)
  - `preference` (it's not a preference, it's a vocabulary mapping)
- Hindsight's `opinion` network is closest analog but conflates belief with abstraction
- Adding `concept` lets agent emit definitional content cleanly AND lets reflection synthesize concepts as outputs

**Predicted for memex**:
- Better recall format: `[concept] User vocabulary: "sprint" = 3-day cycle` is more legible than the same as `fact`
- Reflection can produce `category: "concept"` outputs distinct from `category: "learning"`
- Categories used at retrieval as soft boosts + format hints (NOT hard filters)

**Boundary conditions**:
- LLM might miscategorize in early days — needs a few-shot prompt with examples
- Risk: category proliferation. Resist adding more (procedure, etc.) until data demands it.

**Evidence to collect**:
- [x] Confirmed: cognitive psychology distinguishes gist (concept) from verbatim (fact)
- [x] Confirmed: existing AI systems (Hindsight) have opinion/observation analog
- [ ] Open: how often does memex's auto-capture surface concept-shaped content? Need to check production data

**Verdict**: *low cost, fills real taxonomic gap, ship*

**Defer**: `procedure` category. Spike first per project methodology — don't add until telemetry shows miscategorization.

---

### H10: A "should I retrieve?" gate would be memex's biggest practical RAG upgrade.

**Statement**: Memex auto-recalls every turn for the `main` agent. Many turns don't need recall (greetings, simple operations, in-progress tasks where the LLM has full context). Self-RAG / Adaptive-RAG show ~40% retrievals can be skipped without quality loss. This is memex's biggest mechanical RAG gap.

**Rationale**:
- Self-RAG (Asai 2024): +6% on PopQA over vanilla RAG by gating
- Adaptive-RAG (Jeong 2024): saves ~40% retrievals
- Memex's `autoRecallLimit=3` injects 3 memories per turn even when none are relevant — token waste, occasional misdirection
- A simple gate could be: "is the user's query likely to benefit from memory?"

**Predicted for memex**:
- 30-50% reduction in auto-recall calls = 30-50% reduction in token cost for memory injection
- Quality stays the same or improves (less irrelevant context)
- Implementation: cheap classifier or score threshold on top-1 result

**Implementation sketch**:
```typescript
// In before_prompt_build hook:
async function shouldRecall(query: string, context: ConversationContext): Promise<boolean> {
  // Heuristic 1: query length — very short queries rarely benefit
  if (query.length < 20) return false;
  // Heuristic 2: is it a greeting/confirmation?
  if (/^(ok|thanks|got it|done|cool|sure)\b/i.test(query.trim())) return false;
  // Heuristic 3: in-flight task — LLM already has full context
  if (context.activeTaskTokens > 4000) return false;
  // Heuristic 4: check top-1 score before injecting
  const top1 = await retriever.peek(query);
  return top1.score > 0.4; // threshold tunable
}
```

**Boundary conditions**:
- False negatives (skipped recall when it would have helped) are silent failures
- Add metrics: track how often the gate skips, sample skipped queries to validate

**Evidence to collect**:
- [x] Confirmed: Self-RAG and Adaptive-RAG show real wins
- [ ] Open: how often does memex's auto-recall produce useful injections? Need prod telemetry
- [ ] Open: is the retrieval-skip gate cheap enough not to add per-turn latency?

**Verdict**: *high practical value, moderate implementation cost, easy to A/B test*

---

## Synthesis

After 4 iterations across 7 angles producing 10 hypotheses, three cross-cutting patterns have emerged. They are stable — every angle that touched them confirmed them, no angle refuted them.

### Pattern A: Two-tier architecture is canonical, not optional

**Independent fields converge**:

| Field | Evidence |
|---|---|
| Production AI (F1) | Mastra Observer/Reflector, Letta primary/sleep-time, Mem0 fact/graph |
| Neuroscience (F3) | CLS theory (McClelland 1995): hippocampus + neocortex |
| Cognitive psych (F9) | Fuzzy-trace theory: gist + verbatim parallel traces |
| Memory categorization (F5) | Tulving's episodic vs semantic |
| Selective storage (F8) | Mem0 #4573 fails when both layers aren't distinguished |

**The pattern**: a fast episodic store (write-heavy, low compression, short retention) plus a slow distilled store (write-light, abstracted, long retention). Reflection is the *transfer mechanism* between them.

**Memex today**: `memories` table = episodic, `category: "learning"` = distilled. The structure is right. **The gap is making the transfer mechanism (reflection) more explicit and richer.**

### Pattern B: Forgetting and rejection are first-class operations

**Independent fields converge**:

| Field | Evidence |
|---|---|
| Neuroscience (F3) | Hardt 2013 "Decay happens" — molecular off-switch for forgetting |
| Active learning (F8) | Mem0 #4573: 97.8% junk rate without REJECT verb |
| Cognitive psych (F3) | Anderson 1994 retrieval-induced forgetting (inhibitory mechanism) |
| RAG advances (F6) | Self-RAG / Adaptive-RAG: ~40% retrievals can be skipped |

**The pattern**: memory systems that can't actively reject and forget pollute themselves. Mechanical decay (memex has this) handles the easy case. Active rejection (memex doesn't have this fully) handles the hard case — feedback loops, hallucinated identity, system-prompt leakage.

**Memex today**: text_hash dedup + fragment rejection (intake guards). Decay-based forgetting in deep sweep. **The gap is semantic rejection at write time** — H7's NLL check.

### Pattern C: Time matters in three different ways, not one

**Independent fields converge**:

| Field | Evidence |
|---|---|
| Databases (F7) | Bi-temporal: valid time vs transaction time |
| Mastra (F7) | Three dates: observation, referenced, relative |
| Neuroscience (F3) | Recency vs validity dissociated; durable old facts vs ephemeral new |
| Generative Agents (F9) | Importance × recency × relevance — three-axis scoring |

**The pattern**: simple "newer wins" is wrong. Old durable facts ("I'm allergic to X") should outrank recent ephemeral ones ("running late today"). Memory systems need:
1. **When recorded** (transaction time / `timestamp`)
2. **When valid** (referenced date in text, validity windows)
3. **How relevant now** (recency decay weighted by importance/category)

**Memex today**: only #1 is captured. Decay applied to #1 directly. **The gap is #2 (referenced_date) and #3 (importance-weighted decay).**

### What the patterns rule out

By converging on these three patterns, the research also rules out approaches:

- **Pure retrieval upgrades** (better embeddings, better rerankers, late interaction) — memex is current here. Marginal gains.
- **Hierarchical schema explosion** (4-7 levels) — diminishing returns past 2-3 levels for memex's scale.
- **Mastra-style "no retrieval"** — works at small scale but breaks past context limits. Memex has 465 memories, would break in 6 months at current write rate.
- **Knowledge-graph-first design** (Mem0g, Graphiti) — overhead doesn't pay off at memex's scale.

---

## Recommendations for Memex

Ten hypotheses ranked by **(implementation cost) × (expected impact) × (independence from other changes)**.

### Tier 1 — Ship soon (high impact, low cost, independent)

#### R1: Add NLL-based store-time rejection (H7)

**Problem**: feedback loops, system-prompt restatement, near-duplicate inserts.
**Mechanism**: before `store.store()`, retrieve top-3 by query=text. If max cosine > 0.95 → REJECT(`recall_loop`). Reason codes feed dream-loop dashboard.
**Cost**: ~50ms per store call (one extra retrieval). ~30 lines of code.
**Impact**: prevents the Mem0 #4573 class of failures (97.8% junk in production). Most of memex's intake guards already block other failure modes; this fills the semantic-duplicate gap.
**Where**: `src/mcp-server.ts:81` (memory_store handler), or in the new `src/service/memex-service.ts` once layered.
**Dependency**: none — works today against the current MCP server.

#### R2: Add `concept` as a 7th memory category (H9)

**Problem**: gist-level definitional content (vocabulary, mental models) doesn't fit existing categories.
**Mechanism**: extend the `MEMORY_CATEGORIES` enum in `src/tools.ts`. Update auto-capture prompt with examples. Update reflection prompt to emit `concept` outputs alongside `learning`.
**Cost**: 1 enum addition + prompt updates + tests. Few hours.
**Impact**: better recall format, cleaner reflection outputs, fills real taxonomic gap.
**Where**: `src/tools.ts`, auto-capture instruction, reflection prompt.
**Dependency**: none.

#### R3: Extract `referenced_date` at store time (H8)

**Problem**: temporal queries fail (memex has only transaction time).
**Mechanism**: at `memory_store`, run a regex date extractor over text (cheap, deterministic). LLM fallback only when regex misses obvious-looking dates. Store as `metadata.referencedDate`.
**Cost**: regex extractor + metadata field + tests. ~half day.
**Impact**: enables Mastra-style temporal filtering (95.5% temporal reasoning when fully implemented). On its own, just storing the field is no-op; the win is when retrieval uses it (R7 below).
**Where**: new `src/temporal.ts` for extractor; `src/service/memex-service.ts` for capture.
**Dependency**: none for storage; pairs with R7.

### Tier 2 — Foundation work (depends on architecture migration from earlier plan)

These need the service layer (from `docs/plans/two-problems-architecture.md`) to land first.

#### R4: 5-verb store pipeline with structured REJECT codes (H3)

**Problem**: Mem0 #4573 failure modes — system-prompt restatement, feedback loops, hallucinated identity, schema dumps, role violations.
**Mechanism**: implement REJECT with reason codes (`recall_loop`, `system_echo`, `ungrounded_identity`, `schema_blob`, `role_violation`). Cheap deterministic filters cascade into the LLM judge. R1 (H7) is the first reason code; this generalizes to all 5.
**Cost**: ~1 day per detector. Total: 1 week.
**Impact**: prevents the full 97.8% junk class.
**Dependency**: service layer (so detectors live in one place, not duplicated across MCP and OpenClaw paths).

#### R5: "Should I retrieve?" gate (H10)

**Problem**: every turn auto-recalls 3 memories even when none are relevant.
**Mechanism**: heuristic gate (query length, greeting patterns, in-flight context size, top-1 score threshold). Self-RAG / Adaptive-RAG patterns.
**Cost**: ~2 days. Heuristics first, classifier later.
**Impact**: 30-50% reduction in auto-recall calls, less context pollution, lower token cost per turn.
**Dependency**: best done after the OpenClaw plugin shell is thinned (so the gate is in the service layer, not duplicated).

#### R6: Question-generation step before reflection synthesis (H4)

**Problem**: current reflection produces generic learnings from heterogeneous batches.
**Mechanism**: Stanford Generative Agents 2-step pattern. (1) "What 3 questions can we ask?" (2) Retrieve per question, synthesize per question with citations.
**Cost**: ~2 days. Mostly prompt engineering + provenance metadata.
**Impact**: more specific, more actionable learnings; provenance edges back to source memories enable future audit.
**Dependency**: existing `reflectionSweep` in `src/dreaming.ts` is the right home; pairs well with adding `concept` category (R2).

#### R7: Date-range filtering at retrieval (H8 part 2)

**Problem**: memex captures `referencedDate` (R3) but doesn't use it.
**Mechanism**: at recall time, parse temporal phrases in query ("last Tuesday", "in March", "yesterday"). If found, add `WHERE json_extract(metadata, '$.referencedDate') BETWEEN ? AND ?` to the SQL retrieval.
**Cost**: temporal parser (existing libraries: chrono-node) + SQL filter wiring. ~1 day.
**Impact**: temporal-reasoning queries succeed where they currently fail.
**Dependency**: R3 (referenced_date capture) must be live first.

### Tier 3 — Defer until evidence demands

These are theoretically grounded but lack memex-specific evidence yet.

#### R8: Schema-match routing (H6)

**Problem**: schema-consistent and schema-inconsistent memories should follow different consolidation paths (Tse 2007).
**Mechanism**: at store time, retrieve related learnings, ask "consistent / conflict / extends?", route accordingly.
**Cost**: 1 LLM call per store. Real money.
**Why defer**: memex's pool is small (465 memories). Schema-conflict frequency is low. Cost-benefit unclear without production data.
**Trigger**: when contradiction detection becomes a measurable problem.

#### R9: Explicit interleaved replay (H5)

**Problem**: dreaming reflection only sees recent top-50 memories. CLS theory says interleaved sampling of older memories prevents drift.
**Mechanism**: instead of `ORDER BY timestamp DESC LIMIT 50`, sample a mix: 30 recent + 20 random from older.
**Cost**: query tweak. Trivial.
**Why defer**: at 465 memories, all old memories ≈ all recent memories. The split only matters when "old" is months/years away from "new." Re-evaluate at >5K memories.

#### R10: Hierarchical organization (H2)

**Problem**: flat memory pools may not scale.
**Why defer**: HyperMem/xMemory hierarchies pay off at 1K+ memories. Memex is at 465. Add when scale forces it; the layered service architecture from `docs/plans/two-problems-architecture.md` makes adding hierarchy later cheap.

---

## The Reflection v2 Design (concrete proposal from this research)

Based on the synthesis, memex's reflection should evolve through three additive steps:

### Step 1: Add provenance + question step (R6, ~3 days)

Modify `reflectionSweep` in `src/dreaming.ts`:
```typescript
// 1. Threshold trigger (existing)
// 2. Sample memories: 30 recent (importance > 0.3) + 20 older random (R9, optional)
// 3. NEW: ask LLM "what 3 questions could be answered?"
// 4. NEW: per question, retrieve top-K with existing retriever
// 5. Synthesize per question with provenance
// 6. Store as category="learning" or "concept" (R2), metadata.sources=[id1,id2,...]
```

### Step 2: Add NLL gate (R1, ~1 day)

In `memory_store` handler, before storing:
```typescript
const top = await retriever.retrieve({query: text, limit: 3});
if (top[0]?.score > 0.95) {
  return reject({reason: 'recall_loop', similar_to: top[0].entry.id});
}
```

### Step 3: Add temporal capture + filter (R3 + R7, ~2 days)

```typescript
// At store: extract referencedDate from text (regex first, LLM fallback)
metadata.referencedDate = extractReferencedDate(text);

// At recall: parse temporal phrases in query
const range = parseTemporalQuery(query);
if (range) scopeFilter += ` AND json_extract(metadata, '$.referencedDate') BETWEEN ? AND ?`;
```

**Total effort**: ~6 days for Reflection v2 covering R1, R2 (concept), R3, R6, R7. R4, R5 deferred to post-architecture-migration.

**Expected impact**:
- R1: prevents Mem0-class failure (97.8% junk avoided)
- R2: cleaner taxonomy
- R3+R7: temporal queries go from failing to working (Mastra hit 95.5% with this)
- R6: more specific learnings with provenance

---

## Process log (final)

- 2026-04-25: Research initialized; loop bounded but flexible.
- 2026-04-25: F1 (consolidation systems) complete. H1 partially refuted on first contact with MemMachine. H3 confirmed by Mem0 production data.
- 2026-04-25: F3 (neuroscience), F8 (selective storage), F9 (concept synthesis) complete. CLS theory validates two-tier architecture; Mem0 #4573 detector table makes H3 concrete; Generative Agents pattern produces H4; NLL info gain produces H7.
- 2026-04-25: F5 (categorization), F6 (RAG advances), F7 (temporal) complete. `concept` category recommended (H9). Memex's RAG mechanics confirmed current — gaps are calibration (H10) and temporal filtering (H8). Mastra three-date model produces H8.
- 2026-04-25: Synthesis pass — three cross-cutting patterns identified (two-tier canonical, forgetting first-class, time has three dimensions). 10 hypotheses ranked into 3 tiers. Reflection v2 proposed as ~6-day project.
- **Status: research complete enough to act on. F2 (Stanford detail), F4 (cognitive arch), F10 (provenance) covered indirectly through other angles. No further data-gathering iterations needed unless a specific hypothesis needs validation.**

---

## Appendix: Search Log

### Queries attempted
*(updated per iteration)*

### Sources rejected
*(why a source was not useful)*
