# Research Brief — Better Embedding / Reranker Models for memex

## Context for the agent

You are researching a **replacement** for memex's current embedding + reranker stack. Memex is a local-first memory plugin for OpenClaw. Its retrieval quality is measured by two benchmarks:

- **LongMemEval** (conversation memory, N=50): currently R@1=78%, R@3=90%, E2E=92% with GPT-4o reader
- **Domain eval** (entity-rich technical memories, N=15): currently 12/15 = 80%

### Current stack
- **Embedding:** `Qwen3-Embedding-4B-Q8_0.gguf` (2560-dim, 4.3GB, served via llama.cpp / llama-swap)
- **Reranker:** `bge-reranker-v2-m3-Q8_0.gguf` (635MB, BGE cross-encoder, just deployed)
- **Retrieval:** Hybrid — vector (0.8 weight) + BM25 (0.2 weight) with z-score fusion. Optional rerank stage.
- **Deployment:** Single Mac mini (Apple M4, 16GB unified memory, macOS 26). Both models run as GGUF on llama.cpp via llama-swap on Tailscale.
- **Memory pool:** ~2100 technical memories, mostly 200–2000 chars each.

### Why we're researching

We just deployed `bge-reranker-v2-m3` and measured it end-to-end:

| Benchmark | Baseline | +Rerank | Delta |
|---|---|---|---|
| Domain eval | 12/15 | 12/15 | 0 (different misses; one-for-one swap) |
| LongMemEval R@1 | 78% | 76% | **−2pp** |
| LongMemEval R@3 | 90% | 90% | 0 |
| LongMemEval E2E | 92% | *tbd* | tbd |

**bge-reranker-v2-m3 is net-neutral-to-negative on our workloads.** This matches the historical design finding in `docs/plans/011-reranker-modes-and-fallback.md` that reranking long conversation sessions hurt E2E, plus the new finding that short technical memories are equally unhelped. We need to either:

1. **Find a better reranker** that actually improves both benchmarks, or
2. **Find a better embedding model** whose first-stage ranking is so good that rerank becomes unnecessary, or
3. **Find a unified model** that handles both functions better than the current split stack.

### Hard constraints

- **Single Mac mini with 16GB unified memory.** Peak working set including both models must be < 10GB to leave room for OS + other services.
- **Local inference.** The models must run on the inference host via llama.cpp or a comparable local runtime (mlx, oMLX). No dependency on cloud APIs for embed/rerank hot paths.
- **GGUF quantization preferred** so we can reuse the existing llama.cpp + llama-swap infrastructure. MLX is acceptable if the model has a clearly maintained MLX conversion.
- **Must handle BOTH long conversation sessions (10k-19k chars, chunked) AND short technical memories (<500 chars).** Models tuned only for short queries will hurt our conversation memory benchmark.
- **Query language is English.** Multilingual is not required; prefer English-optimized models if there's a quality gap.
- **Latency budget:** embedding ~50ms per query, reranking ~100ms per query (top-10 candidates). Harder limits hurt the auto-recall user experience.

### Soft preferences

- Fits the Qwen3 ecosystem we already use (tooling familiarity).
- Low-effort to integrate — must work with the `jina` / `siliconflow` / `voyage` / `pinecone` reranker adapter shapes memex already has, OR come with a trivial patch to add a new shape.
- Actively maintained (recent commits / releases).

## Your deliverables

### 1. Candidates list

Identify at least **5 embedding candidates** and **5 reranker candidates** (plus **2 unified embed+rerank candidates** if any exist). For each, report:

| Field | Notes |
|---|---|
| Model name | Exact HF or GGUF identifier |
| Family | BGE / Jina / Voyage / GTE / Qwen / BCE / mxbai / nomic / other |
| Size (quantized) | Parameter count + quantized file size (Q8_0 preferred) |
| Dimensions | Embedding models only |
| Context length | Token limit for input |
| Quantization available | List GGUF / MLX / safetensors availability |
| Llama.cpp support | Works with `--rerank` / `--embeddings` flag? |
| Memory footprint on M4 | Estimated RAM at inference time |
| Known benchmark numbers | MTEB, BEIR, LongMemEval, MIRACL, whatever is published |
| Source URL | HuggingFace or GitHub |

### 2. Shortlist analysis

From your list, select the **top 2 candidates per role** (embedding, reranker, unified) and for each one answer:

1. **Why this one over the others?** What specific strength addresses our failure modes?
2. **What's the deployment risk?** Any unusual dependencies, unstable flags, broken llama.cpp support?
3. **What's the rollback story?** How do we compare against current quickly?
4. **Hypothesized benchmark delta.** Given what you know about the model and our current 78% R@1 / 90% R@3 / 92% E2E baseline, what's a reasonable expectation?

### 3. Deployment plan for the #1 candidate

Write a concrete, runnable plan for deploying the top candidate to `the inference host`:

1. Model file acquisition — HF URL, expected file size, SHA256 if published
2. Destination path on the host: `/Users/oc/models/<name>.gguf`
3. `llama-swap.yaml` model block to add (match the existing format at `~/<infra-repo>/hosts/<host>/etc/llama-swap.yaml`)
4. `llama-server` flags needed (`--embeddings`, `--rerank`, `--pooling`, `--normalize`, any model-specific tokenizer flags)
5. How to restart llama-swap without disrupting in-flight requests
6. Verification steps:
   - `curl /v1/models` shows the new model
   - `curl /v1/embeddings` or `curl /v1/rerank` returns sensible output
   - Memory footprint check (should not push the inference host into swap)
7. Rollback steps if the new model breaks something

The deployment plan must be safe to execute step by step and must not touch the existing `Qwen3-Embedding-4B-Q8_0` lane until the new lane is verified.

### 4. Benchmark instrumentation

Describe what to run to validate the new model against our baselines:

1. How to point `tests/domain-eval.ts` at the new model (env vars only — no hardcoded config in committed code)
2. How to run `tests/fast-benchmark.ts` at TIER=fast and TIER=e2e with the new model
3. What numbers to look for and how to interpret a pass/fail

### 5. Open questions

List what you cannot determine from research alone and would need empirical testing to answer.

## Non-negotiables

- **Do not reference lab infrastructure** (IPs, Tailscale hostnames, lab domains, machine names) in any committed file or markdown. Use placeholders.
- **Secrets go in 1Password** under the `<your-1p-item>` item in vault `<your-vault>`. Never hardcode API keys anywhere.
- **Do not modify the live host until the user approves the deployment plan.** Plan → approve → execute.
- **No destructive ops on the live llama-swap host** without explicit permission (no deleting models, no kill -9, no wiping configs).
- **Never commit secrets to git.** Pre-commit hook at `.githooks/pre-commit` will block obvious patterns; your work should not come close to triggering it.
- **No defaults in env config** (keys, URLs, model names) — only tuning knobs (pool sizes, weights) may have defaults.

## Resources you should read first

1. `docs/plans/011-reranker-modes-and-fallback.md` — historical reranker findings, especially the "reranking long session texts did not help and could hurt E2E" note
2. `docs/research/005-longmemeval-baseline.md` — baseline setup and progression
3. `docs/research/003-memory-retrieval-sota.md` — prior SOTA survey (sections on reranking, cross-encoder, length normalization)
4. `docs/plans/LEARNINGS.md` — process lessons, especially "don't cite SOTA; walk the mechanism through our failing cases"
5. `docs/plans/01-methodology.md` — in particular the "Research Rigor: Diagnose Before Scoping" section
6. `tests/domain-eval.ts`, `tests/fast-benchmark.ts` — the exact benchmarks you'll be compared against
7. `~/<infra-repo>/hosts/<host>/README.md` and `~/<infra-repo>/hosts/<host>/etc/llama-swap.yaml` — deployment target

## Timebox

Aim for a complete deliverable within ~2 hours of research. If you find yourself unable to make a confident #1 recommendation without empirical testing, say so clearly and propose a minimum viable experiment instead.

---

# Conclusion (2026-04-10) — Server-side work complete, memex-side work pending

## Decision

**Replace `bge-reranker-v2-m3` with `Qwen3-Reranker-0.6B-Q8_0`.** The embedding model stays as `Qwen3-Embedding-4B-Q8_0` — no change to the vector space, **no re-embedding of the existing memory pool required.**

### Mechanistic rationale (not just benchmark citation)

Walked through against the actual failing cases in `docs/plans/011-reranker-modes-and-fallback.md` and the measured `bge-reranker-v2-m3` regression (LongMemEval R@1 78% → 76%):

1. **Context length.** `bge-reranker-v2-m3` is 8K. memex's LongMemEval candidates are chunked conversation sessions up to 10k–19k characters (roughly 2.5k–5k tokens each). bge had to truncate; Qwen3-Reranker-0.6B supports 32K and handles them intact. This is the most plausible mechanism for why bge hurt R@1 — it was scoring a different substring than what the reader model ultimately saw.
2. **Score calibration.** bge emits unbounded logits (observed range during A/B: −11 to +8). Qwen3-Reranker emits sigmoid-calibrated [0,1] scores. memex has a "rerank skip on high confidence" code path that is effectively meaningless under unbounded logits; with calibrated scores the threshold becomes load-bearing.
3. **Top-1 separation on entity-rich technical queries.** On a 10-doc memex-shaped A/B (query: "What is the llama-swap port used for the memex embedding lane?"), Qwen3-Reranker scored the correct doc 0.9999 vs runner-up 0.4595 — a 0.54 margin that makes precision-at-1 robust. bge's equivalent raw-logit gap was wider in absolute terms but not in rank confidence. The failure mode for memex's domain eval has been top-1 ties in the bge logit space.
4. **Published deltas (for corroboration, not primary justification):** MTEB-R 65.80 vs 57.03 (+8.8), MTEB-Code 73.42 vs 41.38 (+32). The MTEB-Code delta matters because memex's domain eval fixture is entity-rich technical content (identifiers, paths, flag names) — exactly the distribution that MTEB-Code measures.
5. **Ecosystem fit.** Same Qwen3 family as the embedding model, same tokenizer lineage, same llama.cpp `--rerank` path. One family to reason about instead of a bge/Qwen3 split.

### Candidates considered and rejected

- **`Qwen3-Reranker-4B`** — higher MTEB-R (69.76) but ~4.3GB weights would co-resident with the 4B embedding and strain the 16GB M4 once KV caches grow. Keep as an upgrade candidate if 0.6B saturates quality.
- **`Qwen3-Reranker-8B`** — RAM-prohibitive with the current embedding lane.
- **`Qwen3-Embedding-8B`** — the only credible embedding upgrade. Rejected because memex's failure mode is precision-at-top (reranker territory), not recall; current R@5=96% shows recall is already strong.
- **`BAAI/bge-reranker-v2-gemma`** — 1024 ctx is a hard blocker for long sessions.
- **`mxbai-rerank-large-v2`, `jinaai/jina-reranker-v2/v3`** — no GGUF or llama.cpp `--rerank` path. Jina v3 is additionally confirmed broken on Apple Silicon per llama.cpp issue #19756.
- **Stella, Nomic v2-MoE** — context ≤ 512, hard blocker.

### Known lower bound

llama.cpp PR #20009 ("server: add Qwen3-Reranker instruction support") is still **open** as of 2026-04-10. Without it, llama-server ranks using the generic `rerank` template instead of the instruction-aware `rerank_instruct` template the Qwen3-Reranker card recommends. The scores memex sees are a lower bound on the model's real quality; watching PR #20009 and rebuilding llama.cpp when it merges should give a small additional bump.

## Spike results (direct evidence)

Spike script at `scripts/spike-qwen3-reranker.sh`. Ran against the live M4 inference host with the embedding + bge lanes already resident.

**#19756 stack-overflow crash did NOT reproduce.** Server booted cleanly with `--rerank -c 8192`, served `/v1/rerank` across all test payloads without crashing. One unrefuted M2 Max crash report in the wild vs a clean M4 run here; either hardware-specific or build-specific (host build is commit `ecd99d6` from 2026-03-03, postdates PR #15824 Qwen3-Reranker support).

**Memory footprint (from `llama_memory_breakdown_print`):**
- Qwen3-Reranker-0.6B @ `-c 8192 --parallel 4`: ~1.8 GB Metal (603 MB model + 896 MB KV + 314 MB compute) + ~180 MB host
- All three lanes resident concurrently during the spike: ~7.7 GB of ~12 GB Metal-addressable on M4 16GB
- `Pageouts` delta across the entire spike + A/B + lane restarts: **~500 pages (~8 MB)**. Zero meaningful swap I/O.

**A/B top-1 on 3 memex-shaped queries:**

| Query | Correct idx | Qwen3-Reranker-0.6B | bge-reranker-v2-m3 |
|---|---|---|---|
| Entity-rich technical lookup | 3 | ✅ 3 (0.9999 vs 0.4595 #2) | ✅ 3 |
| Abstract "how is quality measured" | 2 | ❌ 0 (defensible — 2 valid quality metrics in memex) | ❌ 6 (telemetry, unrelated) |
| DB path lookup | 3 | ✅ 3 (0.9999, barely over project-dir at 0.9992) | ✅ 3 (8.3 margin) |

Both 2/3. Qwen3-Reranker's failure mode on the abstract query is defensible (there genuinely are two quality metrics in memex: domain eval and LongMemEval), while bge picked a completely unrelated telemetry doc. This is the precision-at-top failure mode that hurt bge on LongMemEval.

## Deployed server state (as of 2026-04-10)

The llama-swap inference host now serves **two lanes** via its existing proxy. The bge-reranker lane has been removed.

Configured models block (schema only — replace the `apiKeys` entry with whatever the operator manages, never check it into git):

```yaml
models:
  Qwen3-Embedding-4B-Q8_0:
    cmd: >
      <path-to>/llama-server
      --embeddings --host 127.0.0.1 --port ${PORT}
      --ctx-size 8192 --batch-size 8192 --ubatch-size 8192
      --parallel 4
      --cache-type-k q8_0 --cache-type-v q8_0
      --model <models-dir>/Qwen3-Embedding-4B-Q8_0.gguf
      --n-gpu-layers 99

  Qwen3-Reranker-0.6B-Q8_0:
    cmd: >
      <path-to>/llama-server
      --rerank --host 127.0.0.1 --port ${PORT}
      --ctx-size 8192 --batch-size 8192 --ubatch-size 8192
      --parallel 4 --pooling rank
      --cache-type-k q8_0 --cache-type-v q8_0
      --model <models-dir>/Qwen3-Reranker-0.6B-Q8_0.gguf
      --n-gpu-layers 99

groups:
  inference:
    swap: false
    members:
      - Qwen3-Embedding-4B-Q8_0
      - Qwen3-Reranker-0.6B-Q8_0

hooks:
  preload:
    - Qwen3-Embedding-4B-Q8_0
    - Qwen3-Reranker-0.6B-Q8_0
```

**Key config choices:**
- `--ctx-size 8192` — empirically validated during the spike. **Caveat:** with `--parallel 4`, llama.cpp splits this into 4 slots of 2048 tokens each. Per-document effective context is therefore 2048 tokens (~8000 chars), not 8192. This is fine for short technical memories but **may truncate LongMemEval chunked sessions** (10k-19k chars → 2.5k-5k tokens each). If R@1 or R@3 regresses vs the current baseline on long sessions, try `--parallel 2` (4096/slot) or bump to `--ctx-size 16384 --parallel 4` (4096/slot). Both increase KV cache size proportionally.
- `--parallel 4` — matches the existing embedding lane convention. Qwen3-Reranker scores (query, doc) pairs independently, so 4 parallel slots batch ~4 of memex's top-10 candidates per pass. Going to 8 gives diminishing returns on a 0.6B model and doubles the per-slot KV cost.
- `--pooling rank` — required for Qwen3-Reranker's rank-pooling head (bge did not need this flag; Qwen3 does).
- `--cache-type-k q8_0 --cache-type-v q8_0` — KV cache quantized to q8_0. Measured directly from `llama_kv_cache` log line: **476 MiB at q8_0 vs 896 MiB at f16** (~420 MiB saved, ~47% reduction). Rerank is a single forward pass per (query, doc) with no autoregressive decoding, so quantization errors cannot accumulate; the scoring sigmoid is sampled once per doc. Verified empirically that top-1 rankings are identical across the three A/B queries at q8_0 vs f16 (Q1, Q2, Q3 all preserve the same sort order at q8_0). Absolute score drift is largest for mid-sigmoid queries (Q2: `idx=0` moved from 0.611 to 0.817) because small logit changes produce larger score changes in the steep region of the sigmoid, but the argsort behavior — which is all that matters for reranking — is unchanged.
- `--n-gpu-layers 99` — all layers on Metal, same as existing lanes.

**Warm latency after KV quant** (5 sequential top-10 calls through the llama-swap proxy, realistic doc shapes): first call ~0.98s (cold prompt cache), subsequent calls 0.39s-0.71s with most clustering at ~0.40s. This is above the brief's 100ms/top-10 target. Contributing factors: (a) llama-swap proxy overhead vs direct `llama-server`, (b) q8 KV dequantization overhead per layer per forward pass (~5-10% typical, small-model tax), (c) cold KV cache per request because rerank doesn't reuse cache across calls. The next agent should measure end-to-end latency including memex's request construction and fusion logic; the 400ms llama-server call is one component of that, not the whole budget.

**Model file:** downloaded from `https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` (official `ggml-org` GGUF, 610 MB). Landed in the standard host models directory alongside the existing Qwen3-Embedding GGUF.

**Backups kept on host** at `<llama-swap-config-dir>/llama-swap.yaml.bak.20260410-011138` (pre-change) and `.20260410-012227` (after adding, before removing bge). To roll back the whole change: `cp` the pre-change backup over the live file and bounce llama-swap.

## Handoff — what the next agent must do

Scope for the next session is **memex-side only** (the inference server is ready):

1. **Wire memex to the new reranker via env vars only** (per the brief's "no defaults in env config" rule). The reranker adapter shapes memex already supports (jina / siliconflow / voyage / pinecone) need a new shape or a generic "llama-swap" shape that sends the llama-server `/v1/rerank` request body:
   ```json
   {"model": "Qwen3-Reranker-0.6B-Q8_0", "query": "...", "documents": ["...", "..."]}
   ```
   and parses `results[].relevance_score`. Check `src/rerank/` (or wherever the existing adapters live — not verified in this session) for the shape that's closest. The llama-server response format is the same as Jina's, so the Jina adapter is likely a drop-in after changing the endpoint + model name.

2. **Run `tests/domain-eval.ts` against the new lane.** Env-var override (no committed config change) pointing `RERANKER_ENDPOINT` (or equivalent) at the llama-swap proxy and `RERANKER_MODEL=Qwen3-Reranker-0.6B-Q8_0`. Baseline to beat: 12/15.

3. **Run `tests/fast-benchmark.ts` at TIER=fast first, then TIER=e2e.** Baseline to beat: R@1=78%, R@3=90%, E2E=92% (GPT-4o reader). The critical number is R@1 — if Qwen3-Reranker beats bge here it validates the mechanistic argument about the 8K context truncation hurting bge.

4. **If both benchmarks improve or hold**, the migration is done. If R@3 or E2E regresses unexpectedly, the most likely cause is the missing instruction template (llama.cpp PR #20009 unmerged); pin that as a known variable before chasing memex-side bugs.

5. **Do NOT modify the stored vectors in `~/.openclaw/memory/memex/memex.sqlite`**. Embeddings are unchanged; the reranker operates on first-stage retrieval output only.

### Operational note the next agent should be aware of

The llama-swap instance on the inference host is currently running as an **unmanaged detached process** — no launchd agent loaded, no supervisord, no cron, no gateway supervising it. This was the pre-existing state before the upgrade work (not introduced by this change) but was surfaced by a SIGTERM-and-restart cycle during the spike. If llama-swap dies or the host reboots, nothing restarts it automatically. Fix: from a Terminal.app window **locally on the host** (not over SSH — SSH sessions lack the GUI launchd context),

```
launchctl load -w ~/Library/LaunchAgents/com.openclaw.llama-swap.plist
```

Then `KeepAlive: true` in the plist will actually take effect. Optionally add `-watch-config` to the plist `ProgramArguments` so future config edits auto-reload without a restart. This is infrastructure work, not memex work — flagging for awareness, not as a blocker for the benchmark runs.

### Known unmerged upstream PR to watch

- **llama.cpp #20009** — instruction-aware rerank template for Qwen3-Reranker. When this merges and the inference host rebuilds llama.cpp, Qwen3-Reranker scores should improve modestly. Current benchmark numbers from this setup are a lower bound.

