# Agent Memory SOTA Research — April 2026

Research loop findings for improving memex. Budget: stop at 70% of 7d limit.

---

## Iteration 1: Landscape Scan + Letta Deep Dive

### Top Systems (April 2026)

| System | Architecture | Best At | LongMemEval | Memex Relevance |
|---|---|---|---|---|
| **Letta/MemGPT** | LLM-as-OS, 3-tier self-editing | Long-running autonomous agents | ~75% | **High** — sleep-time agents, skill learning |
| **Mem0** | Hybrid vector+graph+KV, managed API | Drop-in memory for any framework | 49% | Medium — graph layer interesting |
| **Zep/Graphiti** | Temporal knowledge graph | Enterprise temporal reasoning | ~85% | Medium — bitemporal tracking |
| **Hindsight/TEMPR** | 4-way parallel, entity-aware | Benchmark leader | 91.4% | **High** — closest competitor |
| **LangMem** | Episodic+semantic+procedural on LangGraph | LangChain ecosystem | N/A | Low — framework-locked |
| **Cognee** | Knowledge graph from raw docs | Document understanding | N/A | Low — different problem |

### Key Insight: Letta's Sleep-Time Agents

Letta (2026) now separates memory management from conversation into async "sleep-time agents." This is exactly memex's dreaming concept — but Letta arrived there from a different direction (MemGPT's OS metaphor → context management overhead → decouple into async).

**What Letta does that memex doesn't:**
1. **Self-editing core memory** — agent explicitly updates a small in-context block (persona + human). Memex has no editable context block.
2. **Skill learning** — agents learn procedures from experience, not just facts. Memex only stores facts/preferences/decisions.
3. **Context repositories** — git-based versioning of memory state. Memex has no version history.

**What memex does that Letta doesn't:**
1. **Document search** — memex searches workspace docs alongside memories. Letta is conversation-only.
2. **Single SQLite file** — zero infrastructure. Letta requires a server.
3. **Hybrid BM25+vector+reranker** — Letta uses pure vector search.
4. **90% E2E on LongMemEval** — Letta at ~75%.

### Reflection: What Should Memex Adopt?

**High ROI:**
- **Editable context block** — a small (2K char) "what I know about this user" block that the agent updates each session. Cheaper than full recall (no embedding search), always in context. Complementary to memex's recall.
- **Sleep-time agents for reflection** — already in our plan (step 8). Validates the approach.

**Medium ROI:**
- **Procedural memory** — "how to do X" alongside "what is X". New category alongside fact/preference/decision/learning.
- **Memory versioning** — track changes to memories over time. Useful for correction chains.

**Low ROI for now:**
- **Knowledge graph** (Mem0/Zep) — adds complexity for marginal recall improvement at memex's scale (~2K entries). Graph shines at 100K+ entries.
- **Self-editing core memory** — requires deep integration with the agent's system prompt. Not portable across hosts.

---

## Iteration 2: Hindsight/TEMPR — How They Hit 91.4%

### Architecture

Hindsight (Vectorize.io + Virginia Tech + Washington Post, Dec 2025) separates memory into **4 networks**:

| Network | What it stores | Memex equivalent |
|---|---|---|
| **World** | Objective facts | `category: "fact"` |
| **Bank** | Agent's own experiences (first person) | Not tracked — memex doesn't distinguish agent experience |
| **Opinion** | Subjective beliefs with confidence scores | `category: "learning"` (our dreaming design) |
| **Observation** | Entity summaries synthesized from facts | Not tracked — no entity extraction |

### TEMPR Retrieval (why it's better than memex)

TEMPR runs **4 parallel searches** and fuses them:
1. Semantic vector similarity (like memex)
2. BM25 keyword matching (like memex)
3. **Graph traversal through shared entities** (memex doesn't have this)
4. **Temporal filtering for time-constrained queries** (memex has time decay but not temporal filtering)

Then: RRF fusion + neural reranker. Memex does z-score fusion + optional reranker.

**The key difference**: graph traversal. When you ask "what did I say about Ryan's deployment rules?", Hindsight can follow entity links: Ryan → deployment → mbp-1 → model rules. Memex relies purely on vector similarity + BM25 keywords.

### CARA: Configurable Agent Disposition

Hindsight includes CARA — configurable personality parameters (skepticism, literalism, empathy) that affect how the agent reasons about memories. This is beyond memex's scope but interesting for the reflection phase.

### What Memex Should Adopt

**1. Entity extraction + linking (HIGH ROI)**
When storing a memory, extract named entities (people, systems, models, projects) and store them as metadata. At retrieval, add entity-overlap as a 3rd signal alongside vector + BM25. This is the biggest gap between memex (90%) and Hindsight (91.4%).

Implementation: lightweight NER on store() — extract proper nouns, store as `metadata.entities: ["ryan", "mbp-1", "qwen3.5"]`. At retrieval, boost results sharing entities with the query. No graph DB needed — just entity tags.

**2. Opinion/belief tracking with confidence (MEDIUM ROI)**
Already in our dreaming plan as `category: "learning"` with `metadata.confidence`. Hindsight validates this design — they separate opinions from facts structurally.

**3. Temporal query detection (LOW ROI for now)**
"What did I say last week about X?" — detect temporal constraints in queries and filter by timestamp range before vector search. Simple regex/heuristic on the query.

**4. Bank (experience) network (FUTURE)**
Track what the agent DID, not just what it KNOWS. "I deployed Gemma 4 and it crashed" vs "Gemma 4 is unstable." The experience carries context the fact doesn't. New category: `category: "experience"`.

### Memex vs Hindsight Comparison

| Aspect | Memex | Hindsight |
|---|---|---|
| E2E Accuracy | 90% | 91.4% |
| Storage | Single SQLite | Multi-store (not specified) |
| Infrastructure | Zero (local file) | Server required |
| Search signals | 2 (vector + BM25) | 4 (+ graph + temporal) |
| Memory types | 5 (fact/pref/decision/entity/other) | 4 networks (world/bank/opinion/observation) |
| Consolidation | Dreaming (light/deep/reflection) | Built-in reflection |
| Document search | Yes | No |
| Open source | Yes (MIT) | Yes (MIT) |

**Gap to close: 1.4 percentage points.** Entity linking is likely the single biggest lever.

Sources:
- [Hindsight paper (arXiv:2512.12818)](https://arxiv.org/html/2512.12818v1)
- [VentureBeat: Hindsight 91% accuracy](https://venturebeat.com/data/with-91-accuracy-open-source-hindsight-agentic-memory-provides-20-20-vision)
- [GitHub: vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)

---

## Iteration 3: Entity Extraction Without LLM — Closing the 1.4% Gap

### The Problem

Hindsight's 4th search signal is graph traversal through entities. Memex has only 2 signals (vector + BM25). Adding entity overlap as a 3rd signal could close the gap without needing a graph database.

### Options for JS/TS Entity Extraction (no LLM, local)

| Library | Approach | Speed | Accuracy | Size | Best For |
|---|---|---|---|---|---|
| **compromise** | Rule-based | Very fast | Basic | 250KB | Simplest path — people, places, orgs |
| **wink-nlp** | Rules + model | 650K tok/s | Good | 10KB+890KB | Dates, emails, hashtags, money |
| **Transformers.js + BERT NER** | ML model via ONNX | Moderate | Excellent | 50-400MB | Best accuracy, still local |
| **GLiNER** | Zero-shot transformer via ONNX | Moderate | Excellent | ~400MB | Custom entity types at inference |

### Recommendation for Memex

**Phase 1: compromise (zero-cost, ship fast)**
- `npm install compromise` (250KB, no native deps)
- On `store()`: extract `doc.people()`, `doc.places()`, `doc.organizations()`, `doc.nouns()`
- Store as `metadata.entities: ["ryan", "mbp-1", "gemma-4"]`
- At retrieval: extract entities from query, boost results sharing entities
- Cost: ~0.1ms per store call, ~0.1ms per query

**Phase 2: wink-nlp (better dates/numbers)**
- Adds DATE, TIME, MONEY, EMAIL detection
- Important for temporal queries ("what happened last week with X")

**Phase 3: Transformers.js + GLiNER (ML quality)**
- Only if Phase 1 doesn't close the gap
- Runs BERT NER locally via ONNX — no API calls
- 400MB model download, ~50ms per extraction

### How Entity Boosting Works at Retrieval

```
Query: "What's Ryan's rule for mbp-1 deployment?"
Entities extracted: ["ryan", "mbp-1"]

Search:
1. Vector similarity → top 20 candidates
2. BM25 keyword → top 20 candidates
3. Entity overlap → boost candidates containing "ryan" OR "mbp-1"

Fusion: z-score normalize all 3 signals, weighted blend
```

No graph database needed. Just metadata tags on memories + query-time entity extraction. The entity signal breaks ties between vector-similar results.

### Estimated Impact

Hindsight's 4 signals → 91.4%. Memex's 2 signals → 90%. Adding entity overlap as signal 3 should close most of the gap. The 4th signal (temporal filtering) adds less for memex's use case (personal agent, not enterprise temporal reasoning).

**ROI: HIGH.** 250KB dependency, ~2 hours implementation, potential +1% accuracy on LongMemEval.

Sources:
- [compromise (GitHub)](https://github.com/spencermountain/compromise)
- [wink-nlp](https://winkjs.org/wink-nlp/)
- [GLiNER (NAACL 2024)](https://github.com/urchade/GLiNER)
- [Transformers.js v4](https://huggingface.co/docs/transformers.js/index)

---

## Summary: Actionable Ideas for Memex

### High Priority (ship in next release)
1. **Entity extraction via compromise** on store() + entity boost at retrieval
2. **`/dream` command** ✅ Done — replace timer-based dreaming

### Medium Priority (next month)
3. **Experience category** (`category: "experience"`) — what the agent DID, not just what it KNOWS
4. **Temporal query detection** — regex on query, filter by timestamp range
5. **Reflection via dedicated LLM** — call embedding server's /chat/completions endpoint

### Future / Research
6. **Editable context block** (Letta-style) — small always-in-context summary
7. **Skill/procedural memory** — "how to deploy to mbp-1" not just "mbp-1 exists"
8. **Memory versioning** — git-style history of memory changes
9. **Graph traversal** (if entity tags aren't enough) — lightweight entity graph in SQLite
10. **Cross-platform memory** — HTTP API for Claude Code / MCP hosts

---

## Iteration 4: A-Mem — Zettelkasten-Inspired Agentic Memory

**Paper:** [A-MEM: Agentic Memory for LLM Agents (NeurIPS 2025)](https://arxiv.org/abs/2502.12110)

### Core Idea

A-Mem uses the **Zettelkasten method** — each memory is a "note" with structured attributes (context, keywords, tags, links to related notes). When a new memory arrives, it can **trigger updates to existing memories**, creating an evolving knowledge network.

Key difference from memex: memories aren't static after storage. They evolve as new information arrives.

### What Memex Should Adopt

**1. Memory evolution on store (MEDIUM ROI)**
When storing a new memory, check for related existing memories (already done via vector similarity dedup). But instead of just rejecting duplicates — UPDATE the existing memory with new context. Example: "Gemma 4 deployed on mbp-1" + later "Gemma 4 crashed after 5 messages" → merge into "Gemma 4 deployed on mbp-1 but proved unstable in multi-turn (crashed after 5 messages)."

This is what the dreaming reflection phase would do — but A-Mem does it at store-time, immediately. Trade-off: requires LLM call at store time (expensive) vs dreaming does it in batch (cheaper).

**2. Structured note attributes (LOW ROI)**
A-Mem stores keywords + tags + context per memory. Memex already has category + scope + importance. Adding explicit keywords is essentially what entity extraction (Iteration 3) would provide.

**3. Link-based retrieval (MEDIUM ROI)**
A-Mem links related memories bidirectionally. At retrieval, follow links to find connected knowledge. This is a lightweight alternative to a full graph DB — just store `metadata.related: ["id1", "id2"]` and follow one hop.

### Also Found: AgeMem (2026) — RL-Trained Memory Policy

[AgeMem](https://arxiv.org/html/2601.01885v1) trains the agent via reinforcement learning to decide WHEN to store/retrieve/update/discard. Instead of heuristics (importance > 0.3 → store), the agent learns the optimal policy. Interesting research direction but impractical for memex (requires RL training infrastructure).

### Key Quote from March 2026 Survey

> "The gap between 'has memory' and 'does not have memory' is often larger than the gap between different LLM backbones. Investing in memory architecture can yield returns that rival or exceed model scaling."

**ROI: MEDIUM.** Memory evolution at store-time is powerful but needs careful design. Link-based retrieval is a cheap add-on to entity extraction.

---

---

## Iteration 5: Forgetting — When Should Memories Die?

**Key papers:** ACT-R-inspired forgetting (ACM HAI 2025), Novel Forgetting Techniques (arXiv April 2026), MemoryBank forgetting curve

### Three Forgetting Strategies

| Strategy | How | When | Memex Status |
|---|---|---|---|
| **Temporal decay** | Exponential: `activation *= e^(-λt)` | Every retrieval | ✅ Have it (applyTimeDecay in retriever) |
| **Usage-based eviction** | Never recalled after N days → evict | Dreaming deep sweep | ✅ Have it (recall_count based decay) |
| **Staleness detection** | High-relevance memory becomes wrong | Open problem | ❌ Don't have it |

### The Hard Problem: Staleness

From Mem0's 2026 production learnings: a memory about "user works at Company X" is highly retrieved until the user changes jobs. Then it becomes **confidently wrong** — worse than no memory at all. Detecting this requires either:
- User correction (manual — current memex approach via `memory_forget`)
- Contradiction detection (new memory contradicts old → flag for review)
- Confidence decay on factual claims (facts older than N months get lower confidence)

### What Memex Should Adopt

**Contradiction detection at store time (HIGH ROI)**
When storing a new memory, check if it contradicts existing high-importance entries about the same entities. Example: "Ryan now uses Gemma 4" contradicts "Ryan uses Qwen3.5 on mbp-1". Flag the old one for review or auto-demote.

This pairs with entity extraction (Iteration 3): extract entities from both old and new, find overlapping entities, check if claims conflict.

**Implementation:** At `store()`, after entity extraction, query existing memories with matching entities. If cosine similarity is high (same topic) but text is contradictory (detected via simple heuristics — date changes, "switched to", "no longer"), demote the old entry's importance.

**ROI: HIGH.** Prevents confidently-wrong recalls. Cheap if entity extraction is already in place.

---

---

## Iteration 6: Procedural Memory / Skill Learning

**Key papers:** MACLA (AAMAS 2026), PRAXIS (Dec 2025), Mem^p (Aug 2025)

### What Is Procedural Memory?

Semantic memory = "what is X" (facts). Procedural memory = "how to do X" (skills). Current memex only stores semantic memory. Procedural memory stores reusable action sequences that improve task success rate AND efficiency (fewer steps).

### MACLA: The Most Relevant Approach

Compresses 2,851 task trajectories into 187 reusable procedures (15:1 compression). Frozen LLM + external procedural memory. No retraining needed. Reaches 90.3% on ALFWorld unseen tasks.

**Key insight for memex:** Separate learning from reasoning. The LLM stays frozen, all improvement happens in the external memory system. This is exactly memex's architecture — the plugin improves recall quality without changing the LLM.

### What Memex Should Adopt

**New category: `category: "procedure"` (MEDIUM ROI, FUTURE)**

Store "how to" knowledge:
- "To deploy a model to mbp-1: 1) check current model with llama-swap status, 2) unload current, 3) upload GGUF, 4) update config, 5) verify with test prompt"
- "To create a new GitHub repo: use `gh repo create --private` (user preference)"

These are different from facts because they're actionable sequences. The agent can retrieve a procedure and follow it.

**Implementation:** No code change needed — just a new category value. The LLM stores procedures via `memory_store` with `category: "procedure"`. Retrieval works the same (vector + BM25). The prompt instruction (auto-capture) would need to mention "store procedures and workflows, not just facts."

**Skill compression via dreaming (FUTURE)**

During reflection, the LLM could analyze multiple related experiences and compress them into a single procedure. Example: 3 separate memories about deploying different models → 1 procedure "how to deploy a model."

**ROI: MEDIUM for category, HIGH for skill compression via dreaming.**

---

---

## Iteration 7: Memory Compression at Scale

**Key sources:** Memory survey (arXiv:2603.07670), KVzip, SUPO, MemoryArena

### The Scaling Problem

Memex has 2,103 entries. At 10K+ entries, vector search slows. At 100K+, it's unusable without compression. Current dreaming (light+deep) removes noise but doesn't compress — it just deletes or demotes.

### Compression Strategies (ranked by practicality)

**1. Hierarchical summarization (HIGH ROI)**
Group memories by topic/entity, summarize each group into a single entry. MACLA achieves 15:1 compression (2,851 → 187). This is what our reflection phase is designed to do — but we haven't built it yet.

**2. Importance-based eviction (ALREADY HAVE)**
Deep sweep decays old unused entries. At some threshold (importance ≤ 0.05), actually delete. Currently we decay but never delete.

**3. Rolling summaries (MEDIUM ROI)**
Periodically compress the oldest N entries into a summary. Like git squash for memories. Loses granularity but keeps the signal.

### What Memex Should Do

**Add an eviction threshold to deep sweep (LOW EFFORT)**
Entries with `importance ≤ 0.05` after deep sweep → delete. Currently they persist forever at 0.1. This is safe — they're already invisible to retrieval (importance weighting suppresses them).

**Hierarchical summarization via reflection (FUTURE — step 8)**
Already in the plan. The research validates it — MACLA shows 15:1 is achievable.

### Key Finding: MemoryArena

Models scoring near-perfectly on recall benchmarks "plummet to 40-60% in MemoryArena." This exposes a gap between passive recall and active decision-relevant memory use. Implication for memex: LongMemEval (recall quality) might not predict real-world value. Need task-based evaluation too.

**ROI: LOW for new work (deep sweep eviction is a one-liner), HIGH for future reflection.**

---

---

## Iteration 8: Cross-Platform Memory via MCP

### MCP as the Universal Interface

MCP (Model Context Protocol) is the de facto standard for connecting LLMs to tools. Every major platform supports it: Claude Code, OpenAI, Google, Zed, Cursor. If memex exposes an MCP server, it works everywhere.

### What Memex as MCP Server Looks Like

```
Tools:
  memory_recall   — search memories (vector + BM25 + entity)
  memory_store    — store a new memory
  memory_forget   — delete a memory
  memory_dream    — run consolidation cycle
  memory_stats    — pool health metrics

Resources:
  memex://memories/{id}     — individual memory
  memex://stats             — pool statistics
  memex://dream-log         — recent dream cycle results
```

Memex already registers these as OpenClaw plugin tools. Wrapping them as an MCP server is straightforward — the tool schemas are the same.

### Implementation Path

**Option A: MCP server binary (MEDIUM effort)**
Standalone Node process serving MCP over stdio or HTTP. Any MCP host connects. SQLite DB is shared via file path.

**Option B: MCP via OpenClaw (LOW effort)**
OpenClaw already supports MCP (`api.registerMcpServer` or `.mcp.json`). Memex tools are already registered. Just need to expose them on the MCP transport.

**Option C: HTTP API (MEDIUM effort)**
REST endpoints over the existing `registerHttpRoute`. Not MCP-native but universally accessible.

### Recommendation

**Start with Option B** — OpenClaw already has MCP plumbing. Then extract to **Option A** for standalone use (Claude Code, Cursor, etc.).

**ROI: HIGH for adoption, MEDIUM effort.** This is the key to "memory across all agent tools."

### Key Insight

> "MCP is doing for AI integration what REST did for web services."

Memex as an MCP server turns it from "an OpenClaw plugin" into "a universal memory layer." Any MCP-capable agent gets persistent memory by adding one line to `.mcp.json`.

Sources:
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Roadmap 2026 (The New Stack)](https://thenewstack.io/model-context-protocol-roadmap-2026/)
- [Memory in AI: MCP & A2A (Orca Security)](https://orca.security/resources/blog/bringing-memory-to-ai-mcp-a2a-agent-context-protocols/)

---

---

## Iteration 9: Temporal Reasoning in Queries

**Key sources:** Temporal IR/QA survey (arXiv:2505.20243), TimeR4 (EMNLP 2024), MRAG, Hindsight temporal filtering

### The Problem for Memex

User asks: "What did I decide about deployments last week?" Memex does vector + BM25 search on "decide deployments last week" — the temporal phrase "last week" is noise to both signals. It matches on "decide" and "deployments" but ignores the time constraint.

### How to Fix It (3 levels)

**Level 1: Temporal expression detection + timestamp filtering (LOW effort, HIGH ROI)**
- At query time, detect temporal phrases: "last week", "yesterday", "in March", "2 days ago"
- Convert to absolute date range
- Add `WHERE timestamp BETWEEN ? AND ?` before vector search
- Implementation: regex patterns for common expressions, `Date` arithmetic
- Already have timestamps on every memory

**Level 2: Recency-weighted scoring (ALREADY HAVE)**
- `applyTimeDecay()` in retriever already penalizes old entries
- But this is a global decay, not query-specific ("last week" means "boost entries FROM last week, not just recent ones")

**Level 3: Temporal rewriting (FUTURE)**
- TimeR4 approach: rewrite "what happened last week with X" → "what happened between April 1-7 with X"
- Requires an LLM rewrite step before retrieval
- Too expensive for auto-recall, maybe for tool calls

### Recommendation

**Level 1 is the sweet spot.** Regex-based temporal detection at query time, convert to date range, filter before vector search. Handles 80% of temporal queries with zero LLM cost.

Implementation sketch:
```typescript
const TEMPORAL_PATTERNS = [
  { re: /\byesterday\b/i, fn: () => [daysAgo(1), daysAgo(0)] },
  { re: /\blast week\b/i, fn: () => [daysAgo(7), daysAgo(0)] },
  { re: /\blast month\b/i, fn: () => [daysAgo(30), daysAgo(0)] },
  { re: /\bin (january|february|...)\b/i, fn: (m) => monthRange(m) },
];
```

**ROI: HIGH. One of the easiest wins for recall quality on temporal queries.**

Sources:
- [Temporal IR/QA Survey (arXiv:2505.20243)](https://arxiv.org/html/2505.20243v2)
- [TimeR4 (EMNLP 2024)](https://aclanthology.org/2024.emnlp-main.394.pdf)
- [MRAG: Modular Retrieval for Time-Sensitive QA](https://aclanthology.org/2025.findings-emnlp.167.pdf)

---

---

## Iteration 10: Memory Evaluation Benchmarks

**Key benchmarks:** LOCOMO, MemoryArena, MemoryBench, AMA-Bench

### Current Memex Evaluation

Memex uses **LongMemEval** (ICLR 2025) — 50 multi-session conversation recall questions. Score: 90% E2E. This measures one thing: can you retrieve the right memory and extract an answer?

### What LongMemEval Misses

**MemoryArena (2026) finding:** "Agents with near-saturated performance on existing long-context memory benchmarks like LoCoMo perform poorly in the agentic setting." Translation: good recall ≠ good task performance.

**MemoryBench (2025) finding:** Prior benchmarks "focus on retrieval of pre-fetched semantic and episodic memory but do not support evaluation of procedural memory built from test-time user feedback."

### What Memex Should Measure

| Benchmark | What it measures | Should memex adopt? |
|---|---|---|
| **LongMemEval** | Recall accuracy | ✅ Already have |
| **LOCOMO** | Multi-hop + temporal reasoning | YES — add multi-hop questions |
| **MemoryArena** | Does memory improve task outcomes? | FUTURE — needs task environment |
| **MemoryBench** | Continual learning from feedback | FUTURE — needs feedback simulation |

### Practical Next Step

**Add temporal + multi-hop questions to our eval set (MEDIUM ROI)**
Current LongMemEval test set has 50 questions, all single-hop recall. Add:
- 10 temporal questions ("What did I change last week?")
- 10 multi-hop questions ("Which model replaced the one that crashed?")
- Measure before/after entity extraction and temporal filtering

This would be a more honest evaluation than pure recall accuracy.

**ROI: MEDIUM.** Doesn't improve the product directly, but tells us where to invest.

---

### Research Backlog
- Graph memory in SQLite
- xMemory semantic hierarchy
- Memory for multi-agent systems
- MemOS — memory as operating system
- Cognitive architecture patterns (ACT-R)

Sources:
- [Atlan: Best AI Agent Memory Frameworks 2026](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- [Vectorize.io: Mem0 vs Letta](https://vectorize.io/articles/mem0-vs-letta)
- [Letta Docs: Memory Management](https://docs.letta.com/advanced/memory-management/)
- [Letta Docs: Research Background](https://docs.letta.com/concepts/letta/)
- [DEV Community: 5 Memory Systems Compared](https://dev.to/varun_pratapbhardwaj_b13/5-ai-agent-memory-systems-compared-mem0-zep-letta-supermemory-superlocalmemory-2026-benchmark-59p3)

---

