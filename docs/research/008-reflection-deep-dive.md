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
- [ ] **F3**: Neuroscience — hippocampal consolidation, sleep replay, complementary learning systems
- [ ] **F4**: Cognitive architectures — ACT-R, SOAR, EPIC, CLARION
- [ ] **F5**: Memory categorization — declarative/procedural, episodic/semantic, schemas
- [ ] **F6**: RAG advances 2025-2026 — query expansion, late interaction, hybrid
- [ ] **F7**: Temporal reasoning — bi-temporal models, recency vs validity
- [ ] **F8**: Active learning / selective storage — what to remember
- [ ] **F9**: Concept synthesis / abstraction — how higher-order concepts emerge
- [ ] **F10**: Provenance and trust — source weighting, contradiction handling

### Hypotheses (added as research surfaces them)
- [x] **H1**: RAG-based recall less efficient than observation-log → **partially refuted** (depends on dataset)
- [x] **H2**: Hierarchical organization beats flat at scale → uncertain, possibly beneficial
- [x] **H3**: SKIP/REJECT verb prevents feedback-loop amplification → **confirmed** by Mem0 production data

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

*(not yet started)*

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

*(not yet started)*

---

## Section F9: Concept Synthesis / Abstraction

*(not yet started)*

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

**Implications**:
- Add a REJECT path to memex's store pipeline, especially when LLM-driven extraction lands
- Detect: text similar to recently-recalled memories → reject as feedback loop
- Detect: text matches system prompt fragments → reject as identity confusion
- Detect: text contains hallucinated identity tokens (the "John Doe" pattern) → reject

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
