# Research Notes — Unified Memory System

**Updated:** 2026-03-03

---

## Embedding Models Compared

| Model | MTEB | Dims | VRAM | Latency | Cost | Multilingual | Notes |
|-------|------|------|------|---------|------|-------------|-------|
| Gemini-embedding-001 (API) | 68.3 | 3072 | — | ~250ms | free tier | 100+ langs | Current production |
| Qwen3-Embedding-0.6B (local) | 64.3 | 1024 | ~1.2GB | ~45ms | $0 | 100+ langs | Running on Mac Mini ✅ |
| stella_en_1.5B_v5 (local) | 71.19 | 1536 | ~3GB | TBD | $0 | English-focused | Best quality under 2B |
| BGE-M3 (local) | 63.0 | 768 | ~0.9GB | TBD | $0 | multilingual | 8K context, good ONNX |
| nomic-embed-text-v1.5 (local) | 59.4 | 768 | ~65MB Q4 | ~63ms | $0 | decent | QMD used this |
| text-embedding-3-small (OpenAI) | — | 1536 | — | ~300ms | $0.02/M | multilingual | |

**Decision:** Qwen3-Embedding-0.6B for now. Best quality-per-VRAM. For our corpus size (~30-hundreds of memories), the MTEB gap vs Gemini (64.3 vs 68.3) is unlikely to produce different end results. stella_en_1.5B is an option if we want to beat Gemini quality locally.

## Reranker Models Compared

| Model | BEIR nDCG@10 | Params | VRAM | Latency | Cost | Notes |
|-------|-------------|--------|------|---------|------|-------|
| Jina-reranker-v3 (API) | 61.9 | 0.6B | — | ~200ms | free 1M/mo | Best quality |
| bge-reranker-v2-m3 (local) | 56.5 | 568M | ~1.5GB | ~61ms | $0 | Running on Mac Mini ✅ |
| gte-reranker-modernbert-base (local) | ~56 | 149M | ~300MB | TBD | $0 | Smallest, near-API quality |
| Jina-reranker-v2 (local) | — | 278M | — | TBD | $0 | Open-source, multilingual |

**Decision:** bge-reranker-v2-m3. Already deployed and verified. ~10% below Jina v3 API quality but 3x faster and free.

## Serving Options Compared

| Server | Chat | Embeddings | Reranking | Multi-model | Install | Performance |
|--------|------|-----------|-----------|-------------|---------|-------------|
| llama.cpp router mode | ✅ native | ✅ native | ✅ native | ✅ one port, model routing | brew or source | Good, Metal GPU |
| mlx-openai-server | ✅ | ✅ | ❌ needs fork | ✅ YAML config | pip | 21-87% faster than llama.cpp on M4 |
| Ollama | ✅ | ✅ | ❌ no endpoint | ✅ one port | brew | Same as llama.cpp |
| LocalAI | ✅ | ✅ | ✅ Python backend | ✅ one port | Docker/native | Same as llama.cpp + Python overhead |

**Decision:** llama.cpp router mode. Only option with all 3 endpoints native, one port, no dependencies. Deployed and verified on Mac Mini ✅. mlx-openai-server is the future upgrade path if we need more speed (would need to add reranker support).

### llama.cpp Router Mode Details
- Added Dec 2025, multi-model on one port
- `llama-server --models-dir ~/models -ngl 99 --port 8090`
- Auto-discovers GGUF files, loads on-demand, LRU eviction
- Each model runs in its own subprocess (crash isolation)
- Requires `models.ini` preset file for embedding/reranking flags
- Current setup on Mac Mini: 2 models, port 8090

### mlx-openai-server Potential
- 244 stars, actively maintained (as of Mar 2026)
- FastAPI Python server, multi-model via YAML config
- Supports: lm, multimodal, embeddings, whisper, image-gen
- Missing: reranker model type (would need ~100 lines to add)
- Same ecosystem as mlx-audio (already on Mac Mini for TTS)
- Better long-term bet for Apple Silicon if Apple keeps pushing MLX

## Unified Model (All-in-One)

Explored using a single model for chat + embedding + reranking:

| Model | Chat | Embed | Rerank | Params | Notes |
|-------|------|-------|--------|--------|-------|
| GritLM-7B | ✅ | ✅ | ✅ | 7B | Jack of all trades, master of none. ~5GB Q4. |
| NV-Embed-v2 | ❌ | ✅ | ✅ | 7B | No chat generation |

**Decision:** Option B — dedicated specialist models. Better quality per-task, less VRAM total (~2.7GB vs ~5GB), headroom for future chat model.

## Benchmarks (Live, 2026-03-03)

### From VM via Tailscale to Mac Mini

| Endpoint | Latency (warm) | Notes |
|----------|---------------|-------|
| Local embedding (Qwen3-0.6B) | ~45ms | 1024 dims |
| Local reranker (bge-v2-m3) | ~61ms | Correct ranking verified |
| Gemini API embedding | ~250ms | 3072 dims |

### LanceDB Pro (VM)

| Operation | Latency |
|-----------|---------|
| Vector search | 27ms |
| BM25/FTS | 8ms |
| Hybrid (parallel) | 9ms |
| Single write | 28ms |
| Batch write (10) | 1.2ms/entry |

### Projected Full Pipeline (local)

| Step | Latency |
|------|---------|
| Embed query (local) | ~45ms |
| Hybrid search (LanceDB) | ~9ms |
| Rerank (local) | ~61ms |
| **Total recall** | **~115ms** |

vs current (Gemini, no reranker): ~350ms

## Key Insights

1. **Embedding is the bottleneck.** LanceDB search is <30ms. Switching to local drops embed from 250ms to 45ms.
2. **Quality gap doesn't matter at our scale.** With <100 memories, MTEB 64.3 vs 68.3 returns identical top-5 results.
3. **Reranking is new capability.** Currently disabled. Local reranker at 61ms is essentially free to add.
4. **Mac Mini M4 has tons of headroom.** Using ~2.7GB of 12.7GB VRAM. Room for chat model + TTS (already running).
5. **Model swapping is config-only.** Plugin uses OpenAI-compat API — change baseURL + model name to switch.

## LanceDB Gotcha: External Writes

When bulk-inserting into LanceDB from a separate process, the plugin's in-memory table handle doesn't see the new rows. Always write through the plugin's own `memory_store` tool, or restart to refresh the handle. The unified plugin's document indexer must use the same `MemoryStore` instance.
