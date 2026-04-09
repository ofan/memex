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

### Next Research Iterations
- A-Mem: adaptive memory management (automatic lifecycle)
- Memory compression at scale (100K+ entries)
- Procedural memory / skill learning (Letta's new feature)
- The "forgetting" problem — when should memories be deleted vs decayed?

Sources:
- [Atlan: Best AI Agent Memory Frameworks 2026](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- [Vectorize.io: Mem0 vs Letta](https://vectorize.io/articles/mem0-vs-letta)
- [Letta Docs: Memory Management](https://docs.letta.com/advanced/memory-management/)
- [Letta Docs: Research Background](https://docs.letta.com/concepts/letta/)
- [DEV Community: 5 Memory Systems Compared](https://dev.to/varun_pratapbhardwaj_b13/5-ai-agent-memory-systems-compared-mem0-zep-letta-supermemory-superlocalmemory-2026-benchmark-59p3)

---

