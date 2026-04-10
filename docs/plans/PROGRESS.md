# Progress

## Last Updated: 2026-04-10

## Active Projects
- **model-bakeoff** — scoped in brainstorm, design doc pending
  - Goal: quick go/no-go (< 5 min) for any candidate reranker or embedder
  - Motivation: the manual Qwen3-Reranker eval we just did (bake, swap, rerun, compare) should become a one-liner. Each future model upgrade currently costs an afternoon of manual coordination.
  - Build after: any urgent quality work; this is infrastructure, not a quality win
  - Design: `docs/design/model-bakeoff.md` (todo)

## Recently Completed
- **Reranker upgrade: bge-reranker-v2-m3 → Qwen3-Reranker-0.6B-Q8_0** (2026-04-10)
  - LongMemEval: R@1 78→82% (+2 queries), R@3 90% (0), **E2E 90→94% (+2 queries)** with GPT-4o reader
  - Domain eval: 12/15→11/15 (−1 query; Qwen3 picks defensible-but-wrong alternatives on abstract queries)
  - Net: strong win on the larger LongMemEval, small loss on domain eval, clear ship decision
  - bge regression confirmed: bge was −2 R@1 on LongMemEval vs baseline
  - Deployed: `~/homeinfra/hosts/the inference host/etc/llama-swap.yaml` + `~/.openclaw/openclaw.json` (`reranker.enabled: true`, model = `Qwen3-Reranker-0.6B-Q8_0`)
  - Live verified via `openclaw agent main` call — /v1/rerank is hit
  - Lower bound caveat: llama.cpp PR #20009 (instruction-aware rerank template) unmerged; scores should improve when merged
  - Follow-up: memex made 10 rerank calls for one agent turn — investigate whether this is per-source batching or redundant calls; may impact auto-recall latency
- Entity Extraction + Entity Graph: deployed, net-neutral on domain eval, validated the "research must trace mechanism through failing cases" process rule
- Entity boost tuning: disabled (weight=0), domain eval 73% → 80%
- Domain eval created: 15 entity-rich queries against live DB (80% baseline)
- Temporal Queries — merged (regex date detection, timestamp filtering)
- LongMemEval rebenchmarked with GPT-4o: R@1 78%, R@3 90%, E2E 90-92% (no rerank baseline)
- Dreaming v1 merged (light + deep sweep + /dream command)
- v0.5.12 released

## Key Insights This Session
- **Entity boost / graph were net-neutral** on domain eval (both arcs shipped with zero improvement). Root cause: research cited SOTA mechanisms without walking them through our actual failing cases. Added `Research Rigor: Diagnose Before Scoping` section to methodology.
- **Reranker is workload-dependent.** bge-reranker-v2-m3 hurt LongMemEval R@1 (historical finding confirmed). Qwen3-Reranker-0.6B wins LongMemEval (+2 R@1, +2 E2E) but loses domain eval (-1). Mechanistic reason: 32K context (vs bge's 8K) + sigmoid-calibrated scores.
- **Secrets hygiene retooling:** 1Password fields renamed from generic (`LLAMA_SWAP_API_KEY`) to purpose-specific (`MEMEX_LLAMA_SWAP_API_KEY`, `MEMEX_BENCHMARK_OPENAI_API_KEY`, `MEMEX_LLAMA_SWAP_BASE_URL`).

See `docs/plans/LEARNINGS.md` for full session retrospectives and `docs/research/embed-rerank-upgrade-brief.md` for the Qwen3-Reranker research trail.

## Decisions Made
- 2026-04-10: **Enable Qwen3-Reranker-0.6B-Q8_0** in memex runtime. Net LongMemEval win outweighs domain-eval noise.
- 2026-04-10: Rename 1P fields to purpose-specific (`MEMEX_*` prefix).
- 2026-04-10: Research rigor rule added to methodology (`01-methodology.md`): diagnose current failures before scoping a quality project; cite SOTA only after tracing mechanism through failing cases.
- 2026-04-10: Next quality project is `model-bakeoff` (methodology infrastructure), not a specific model upgrade.
- 2026-04-09: Entity boost weight=0 (disabled). BM25 is sufficient for keyword entities
- 2026-04-09: Entity graph adjacency deployed; net-neutral; infrastructure retained for future use
- 2026-04-09: Domain eval is primary metric (not LongMemEval)
- 2026-04-09: GPT-4o default for E2E benchmark
- 2026-04-09: OpenAI key in 1Password `dev-claude` item

## Next Session Should
1. Investigate the "10 rerank calls per agent turn" observation — is memex making redundant calls? latency impact?
2. Draft `docs/design/model-bakeoff.md` — MVP scope: `bakeoff reranker <url> <model>` one-liner
3. Optional: rebuild llama.cpp on the inference host when PR #20009 merges → rerun Qwen3-Reranker with instruction template → confirm further improvement
4. Commit `~/homeinfra/hosts/the inference host/etc/llama-swap.yaml` if not already pushed
