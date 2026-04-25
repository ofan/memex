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
- [ ] **F5**: Memory categorization — declarative/procedural, episodic/semantic, schemas
- [ ] **F6**: RAG advances 2025-2026 — query expansion, late interaction, hybrid
- [ ] **F7**: Temporal reasoning — bi-temporal models, recency vs validity
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

*(not yet started)*

---

## Section F7: Temporal Reasoning

*(not yet started)*

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

## Synthesis (final iteration)

*Cross-cutting patterns across findings. Written once 6+ findings sections are complete.*

---

## Recommendations for Memex

*Concrete design proposals based on confirmed hypotheses. Written last.*

---

## Appendix: Search Log

### Queries attempted
*(updated per iteration)*

### Sources rejected
*(why a source was not useful)*
