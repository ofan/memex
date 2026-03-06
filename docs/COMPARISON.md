# Feature Comparison: Memory Systems

## Summary

This document compares memory-unified against five prominent AI memory systems: mem0, Zep, MemGPT/Letta, LangChain ConversationMemory, and LlamaIndex Memory. Each system takes a different architectural approach to the core problem of giving LLM-based agents persistent, retrievable memory across conversations and sessions.

The landscape divides into two camps: **hosted platforms** (mem0, Zep, Letta Cloud) that offer managed infrastructure with graph-enhanced retrieval, and **library-based solutions** (LangChain, LlamaIndex, memory-unified) that embed directly into application code. memory-unified occupies a unique position as a self-hosted plugin with production-grade hybrid retrieval (vector + BM25 + cross-encoder reranking) and unified document search, running entirely on local infrastructure at zero ongoing cost.

## Feature Matrix

| Dimension | memory-unified | mem0 | Zep | MemGPT / Letta | LangChain Memory | LlamaIndex Memory |
|---|---|---|---|---|---|---|
| **Retrieval** | Hybrid: vector (LanceDB) + BM25 with RRF fusion, cross-encoder reranking | Hybrid: vector + graph traversal, semantic + relational search | Hybrid: semantic embeddings + BM25 + graph traversal | Tool-based: agent decides when to search archival/recall memory | Simple: buffer, window, summary, or vector store lookup | Composable: buffer, summary, vector block, fact extraction |
| **Reranking** | Cross-encoder (bge-reranker-v2-m3) in retrieval pipeline | LLM-based relevance scoring; configurable reranking | Implicit via graph community ranking | None (LLM judges relevance in-context) | None | None built-in (can add via node postprocessors) |
| **Fusion Strategy** | RRF (Reciprocal Rank Fusion) of vector + BM25, then rerank | Multi-store fusion: vector + KV + graph results merged | Triple fusion: embedding similarity + keyword + graph proximity | N/A (single retrieval per tool call) | N/A (single source per memory type) | N/A (primary + secondary memory injection) |
| **Storage Backend** | LanceDB (embedded, Arrow-based) + SQLite (QMD docs) | Pluggable: Qdrant (default), Chroma, Pinecone, Weaviate, pgvector + Neo4j (graph) + Redis (KV) | Neo4j (knowledge graph) + vector embeddings on graph nodes | PostgreSQL or SQLite (archival) + in-context (core memory) | In-memory, Redis, SQLite, or any vector store (Pinecone, Chroma, Weaviate, etc.) | In-memory, Redis, or any vector store via VectorStoreIndex |
| **Persistence** | Local files (LanceDB dir + SQLite), survives restarts | Cloud-managed or self-hosted Qdrant + Neo4j + Redis | Cloud-managed or self-hosted Neo4j | Server-based PostgreSQL or local SQLite | Depends on backend; in-memory by default (lost on restart) | Depends on backend; in-memory by default |
| **Scalability** | Single-node (embedded DB), sufficient for individual/small-team use | Horizontal via managed vector DB + graph DB clusters | Horizontal via Neo4j clustering | Server-based, scales with PostgreSQL | Depends entirely on chosen vector store backend | Depends entirely on chosen vector store backend |
| **Auto-Capture** | Yes, with noise filtering and adaptive retrieval (skip greetings/commands) | Yes, LLM extracts and deduplicates memories from conversations | Yes, automatic episode ingestion and entity extraction | Partial: agent decides what to store via self-directed tool calls | No (manual `save_context` calls required) | No (manual memory management) |
| **Forget / Update** | Explicit forget and update tools; time-decay scoring on retrieval | Explicit delete; contradiction resolution replaces outdated memories | Temporal validity intervals on graph edges; old facts superseded | Agent can overwrite core memory blocks and delete archival entries | No built-in forget (manual deletion from store) | No built-in forget |
| **Importance Scoring** | 7-stage pipeline: hybrid search, rerank, recency boost, importance, time decay, length norm, MMR | Multi-factor: relevance, importance, recency weighting | Community-level summarization + temporal weighting | None (LLM evaluates importance in-context) | None | None |
| **Summarization** | Not currently implemented | LLM-generated memory summaries on extraction | Community-level graph summarization | Agent can summarize and compress core memory blocks | ConversationSummaryMemory and ConversationSummaryBufferMemory | ChatSummaryMemoryBuffer with configurable LLM |
| **Multi-Agent Scoping** | Multi-scope isolation: agent, user, session, global scopes | user_id + agent_id + app_id namespacing | User-level and group-level graph isolation | Per-agent memory spaces with separate core/archival stores | Manual: separate memory instances per agent | Manual: separate memory instances per agent |
| **Document Search** | QMD-based workspace markdown indexing, smart chunking, unified recall with conversation memory | Not a primary feature (memory is conversation-focused) | Supports structured data ingestion into knowledge graph | Archival memory can store documents, searched via embedding | Separate from memory (use retrievers/indexes) | Separate from memory (use VectorStoreIndex) |
| **Unified Recall** | Yes: fan-out to conversation + document stores, normalize scores, merge with source attribution | Unified across vector + graph + KV stores (single `search()` call) | Unified across graph tiers (episode + entity + community) | No: separate tool calls for recall vs. archival search | No: each memory type queried independently | Composable: primary + secondary sources injected separately |
| **Published Recall/nDCG** | Not yet benchmarked on standard datasets | 66.9% accuracy on LOCOMO; 26% uplift over OpenAI memory | 18.5% accuracy improvement over baselines on DMR benchmark | Baseline comparison target in Zep/mem0 papers | No published benchmarks | No published benchmarks |
| **Latency** | ~250ms full hybrid+rerank, ~300-400ms unified recall | ~200ms median search (cloud); p95 ~150ms | 90% latency reduction vs. full-context (claimed) | Depends on LLM inference speed (multiple tool calls per turn) | <1ms (buffer), variable (vector store dependent) | <1ms (buffer), variable (vector store dependent) |
| **Token Efficiency** | Retrieves top-k results only; no full-history processing | ~1.8K tokens/conversation vs. 26K for full-context | Graph summaries reduce token usage vs. raw history | Context window is the bottleneck; virtual paging mitigates | Buffer: O(n) tokens; Window/Summary: bounded | Buffer: O(n) tokens; Summary: bounded |
| **Cost** | $0 (self-hosted, local llama.cpp inference) | Free tier: 10K memories; Pro: $249/mo; Enterprise: custom | Free tier: 1K credits/mo; Flex: pay-per-credit; Enterprise: custom | Open-source self-hosted (free); Letta Cloud: pricing TBD | Free (open-source library) | Free (open-source library) |
| **Deployment** | OpenClaw plugin, self-hosted | Cloud SaaS or self-hosted (Docker/K8s) | Cloud SaaS or self-hosted (VPC deployment) | Self-hosted server or Letta Cloud | Library (pip install) | Library (pip install) |
| **Integration** | OpenClaw plugin SDK (kind: "memory") | Python/JS SDK, REST API, integrations with LangChain, LlamaIndex, CrewAI, etc. | Python/JS SDK, REST API | Python SDK, REST API, OpenAI-compatible endpoints | Native Python library, part of LangChain ecosystem | Native Python/TS library, part of LlamaIndex ecosystem |
| **License** | MIT | Apache 2.0 (OSS), proprietary (cloud) | Apache 2.0 (Graphiti OSS), proprietary (cloud) | Apache 2.0 | MIT | MIT |

## System Analysis

### mem0

mem0 is the most feature-complete standalone memory platform. Its architecture distributes data across three complementary stores -- vector databases (Qdrant by default) for semantic search, Neo4j for relationship graphs, and Redis for fast key-value lookups. The LLM-driven extraction pipeline automatically distills conversations into discrete memory facts, resolving contradictions and deduplicating entries. On the LOCOMO benchmark, mem0 achieves 66.9% accuracy with a 26% uplift over OpenAI's built-in memory, and its graph-enhanced variant (mem0g) pushes this to 68.4%. The platform reduces token consumption by ~90% compared to full-context approaches. Cloud pricing ranges from free (10K memories) to $249/month for Pro, with self-hosted deployment available via Docker/Kubernetes.

The main tradeoffs are complexity (three database backends to manage when self-hosting) and the LLM dependency for memory extraction -- every `add()` call requires an LLM inference to extract and deduplicate facts, which adds latency and cost. The pluggable vector store architecture means you can swap backends, but the graph memory feature requires Neo4j specifically.

### Zep

Zep's distinguishing feature is its temporal knowledge graph architecture, powered by Graphiti. Memory is organized into three hierarchical tiers: raw episodes (lossless message storage), semantic entities and relations (extracted facts with embeddings), and communities (clustered entity groups with summaries). The bi-temporal model tracks both when events occurred and when they were ingested, with explicit validity intervals on graph edges -- this is uniquely powerful for tracking how facts change over time. Zep reports 18.5% accuracy improvements over baselines on the Deep Memory Retrieval benchmark while reducing response latency by 90%. Hybrid retrieval combines semantic embeddings, BM25 keyword search, and graph traversal.

The primary limitation is the Neo4j dependency, which adds infrastructure complexity and cost. The credit-based pricing model (episodes cost 1+ credits depending on size) can be unpredictable for high-volume workloads. The open-source Graphiti library is available separately, but the full Zep platform is a managed service.

### MemGPT / Letta

MemGPT introduced the paradigm of treating the LLM's context window like an operating system manages RAM -- the agent itself decides what to page in and out of its limited context. Core memory (always in context) serves as working memory, while archival memory (vector-indexed PostgreSQL) acts as long-term storage. The agent uses tool calls to read, write, and search its own memory, creating a self-improving system where the agent learns what information is worth retaining. Letta V1 (2025-2026) has modernized the architecture, adding a Conversations API for shared memory across parallel user sessions and Context Repositories with git-based versioning.

The fundamental tradeoff is latency and token cost: every memory operation requires an LLM tool call, and complex retrieval may require multiple turns of agent reasoning. There is no built-in hybrid search or reranking -- retrieval quality depends entirely on the LLM's ability to formulate good queries. The self-managed approach is elegant for autonomous agents but less predictable than algorithmic retrieval pipelines.

### LangChain ConversationMemory

LangChain offers the most variety of simple memory primitives: ConversationBufferMemory (full history), ConversationBufferWindowMemory (last k messages), ConversationSummaryMemory (LLM-generated summaries), ConversationSummaryBufferMemory (hybrid), and VectorStoreRetrieverMemory (semantic search over history). These are composable building blocks rather than a complete memory system. The modern implementation has moved to LangGraph for stateful multi-step workflows, though the memory abstractions remain similar.

The strengths are simplicity and flexibility -- you can plug in any vector store, any LLM for summarization, and compose memory types. The weaknesses are significant: no auto-capture, no importance scoring, no forget/update semantics, no hybrid search, no reranking, and no multi-agent isolation out of the box. These are primitives, not a production memory system. You build the system yourself from these components.

### LlamaIndex Memory

LlamaIndex provides a composable memory system with short-term (FIFO chat buffer) and long-term (vector-backed) components. Memory blocks are the key abstraction: StaticBlock for fixed context, FactExtractionBlock for LLM-extracted facts, and VectorMemoryBlock for semantic retrieval over past messages. SimpleComposableMemory combines a primary chat buffer with secondary memory sources, injecting retrieved long-term memories into the system prompt.

Like LangChain, LlamaIndex memory is a toolkit rather than a turnkey system. It offers slightly more sophistication with its block-based composition and fact extraction, but still lacks hybrid search, reranking, importance scoring, auto-capture with noise filtering, and multi-agent scoping. Its strength is tight integration with LlamaIndex's powerful RAG infrastructure (indexes, query engines, node postprocessors), which means document search and memory can share the same retrieval pipeline.

## Where memory-unified Stands

### Strengths

- **Hybrid retrieval with reranking**: The combination of vector search + BM25 + RRF fusion + cross-encoder reranking is more sophisticated than any competitor except Zep. mem0 uses graph traversal instead of BM25; LangChain and LlamaIndex have no built-in hybrid search.
- **7-stage scoring pipeline**: No other system combines hybrid search, reranking, recency boost, importance scoring, time decay, length normalization, and MMR diversity in a single pipeline. This provides fine-grained control over result quality.
- **Unified recall across conversation + documents**: Fan-out search across both conversation memory and workspace documents with score normalization and source attribution. mem0 and Zep unify across their internal stores but do not index workspace documents. LangChain and LlamaIndex keep memory and document retrieval separate.
- **Auto-capture with noise filtering**: Adaptive retrieval skips greetings and commands; noise filtering prevents low-value content from being stored. Only mem0 and Zep offer comparable automatic memory management.
- **Zero ongoing cost**: Fully self-hosted with local llama.cpp inference. No API calls, no cloud fees, no per-query billing. Competitors charge $19-$249+/month for cloud tiers.
- **Low latency on local hardware**: ~250ms full pipeline, ~300-400ms unified recall on a Mac Mini. Competitive with mem0's ~200ms cloud latency, faster than MemGPT's multi-tool-call approach.
- **Minimal resource footprint**: 230MB RSS, 33MB heap. Runs on modest hardware without GPU requirements for inference.
- **Multi-scope agent isolation**: Built-in scoping (agent, user, session, global) without external configuration. Only mem0 offers comparable namespacing.

### Weaknesses / Gaps

- **No knowledge graph**: mem0 and Zep both leverage graph databases for relational reasoning. memory-unified has no graph layer, which limits multi-hop reasoning and relationship discovery across memories.
- **No LLM-driven memory extraction**: mem0 and Zep use LLMs to distill conversations into discrete facts and resolve contradictions. memory-unified stores raw content with metadata, relying on retrieval-time scoring rather than storage-time intelligence.
- **No summarization**: LangChain, LlamaIndex, and MemGPT all offer conversation summarization to manage growing context. memory-unified has no summarization capability, which could become a limitation for very long-running sessions.
- **No temporal reasoning**: Zep's bi-temporal model tracks when facts were true and when they were ingested. memory-unified has time decay but no explicit temporal validity tracking.
- **No contradiction resolution**: mem0 automatically detects and resolves contradictory memories. memory-unified requires manual updates via the update tool.
- **Single-node only**: Embedded LanceDB and SQLite limit horizontal scalability. mem0 and Zep scale via managed cloud infrastructure.
- **No published benchmark numbers**: mem0 has LOCOMO results; Zep has DMR benchmark results. memory-unified has no standardized benchmark evaluation, making it hard to compare retrieval quality objectively.
- **OpenClaw-only integration**: Tightly coupled to the OpenClaw plugin SDK. mem0 and Zep offer REST APIs and multi-framework SDKs (LangChain, LlamaIndex, CrewAI integrations).
- **No Python SDK**: TypeScript-only implementation. mem0, Zep, LangChain, and LlamaIndex all have Python as their primary language.

## Recommendations

Based on the identified gaps, the following priorities would most improve memory-unified's competitive position:

1. **Benchmark on standard datasets** (high priority, low effort): Run LOCOMO or DMR benchmarks to produce comparable recall/accuracy numbers. Without published metrics, the sophisticated retrieval pipeline cannot be objectively validated against mem0 or Zep.

2. **Add conversation summarization** (high priority, medium effort): Implement a summarization mechanism (periodic or threshold-based) to compress old conversation history. This is table stakes -- four of five competitors offer it, and it directly reduces token consumption for long sessions.

3. **Implement contradiction detection** (medium priority, medium effort): When storing new memories, check for semantic conflicts with existing entries and flag or auto-resolve them. This would close a significant gap with mem0's automatic deduplication and update logic.

4. **Consider temporal validity tracking** (medium priority, medium effort): Add optional valid_from/valid_to metadata to memories, enabling queries like "what was true at time T." This would approach Zep's temporal model without requiring a full graph database.

5. **Expose a REST API** (medium priority, medium effort): Decoupling from the OpenClaw plugin SDK would enable use from any language or framework. A thin HTTP wrapper around the existing retrieval pipeline would dramatically expand the potential user base.

6. **Evaluate graph memory** (low priority, high effort): A lightweight graph layer (e.g., entity-relation triples stored in SQLite) could enable basic multi-hop reasoning without the infrastructure overhead of Neo4j. This is the most architecturally significant gap but also the most expensive to address.

---

*Last updated: 2026-03-05*

*Sources: [mem0 documentation](https://docs.mem0.ai), [mem0 research paper (arXiv:2504.19413)](https://arxiv.org/abs/2504.19413), [Zep temporal knowledge graph paper (arXiv:2501.13956)](https://arxiv.org/abs/2501.13956), [Zep documentation](https://www.getzep.com/), [Letta documentation](https://docs.letta.com), [LangChain memory documentation](https://docs.langchain.com/oss/python/concepts/memory), [LlamaIndex memory documentation](https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/)*
