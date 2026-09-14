# Agent-transcript Memex evaluation — 2026-09-13

## Decision summary

**Memex is genuinely useful on the few tasks where it lands, but it is not yet a dependable
memory layer for the local coding-agent fleet.** Evidence across 1,883 transcript files from
Codex, Claude Code, and DeepSeek Harness showed:

- 183 explicit Memex tool calls in only 32 sessions (~1.8% of unique sessions).
- 95 Codex `memory_recall` calls were attempted; only 6 retrieved successfully. 88 of the 115
  total recall calls across all agents failed as `unsupported call`, overwhelmingly from Codex.
- After excluding the 88 known broken-routing calls, 24 of the remaining 27 attempted recalls
  succeeded (88.9%), so the storage/retrieval backend was usually functional once reached.
- In a manually reviewed sample of 23 successful recall responses:
  - 11 (48%) had a directly useful top result
  - 7 (30%) were only partially useful
  - 5 (22%) had an irrelevant top result
- 51 successful `memory_store` calls produced only 7 memories that were later recalled.
  Overall, 300 of 382 memories (79%) had never been recalled.
- Only two sessions explicitly cited returned memories with `[mem:...]`, despite the server
  instructing agents to do so. This undercounts silent use, but indicates weak memory
  provenance/adoption.
- Two live validation probes on 2026-09-13 reproduced the central quality problem: a specific
  task query returned excellent results, while a nonsense query returned five unrelated public
  documents with scores around 0.417 instead of abstaining.

The current value is therefore **narrow and context-specific**: operational facts and explicit
constraints can save re-discovery time, while broad/default recall often supplies plausible but
wrong context.

## Evaluation design

### Scope

Sources inspected on the local `dev` host and the accessible DeepSeek Harness session volume:

| Source | Transcript files | Approx. unique sessions | Evidence of Memex use |
|---|---:|---:|---|
| Codex Desktop / CLI | 389 | 390 | 119 calls, including 95 recall attempts |
| Claude Code | 1,464 | 1,390 | 60 calls, including 20 recall attempts |
| DeepSeek Harness | 30 | 30 | 4 calls (stats/store); no recall attempts |
| **Total** | **1,883** | **1,810** | **183 calls / 32 sessions** |

OpenClaw was excluded from usage attribution as requested. The live Memex daemon was not
excluded, however: its configured document path still exposes the OpenClaw workspace as a
public collection, so OpenClaw content influenced non-OpenClaw agent searches.

One reachable remote Codex host (``<remote-codex-host>``) was also checked and contained no Memex tool
calls. Other remote fleet machines were not included because their transcript stores were not
reachable from this host; this report is therefore complete for the accessible local and
Kubernetes-backed session stores, not a proof about every device.

### Metrics

1. **Reach**
   - sessions with calls / total sessions
   - calls per session
   - projects and tool mix
2. **Delivery reliability**
   - HTTP/tool-call success
   - timeouts, routing failures, oversized-output truncation
   - p50/p95 latency by source and tool
3. **Retrieval utility**
   - manual top-1 judgment: useful / partial / irrelevant
   - result count, score distribution, and debug traces where available
   - explicit `[mem:...]` citation in subsequent assistant messages
4. **Memory lifecycle value**
   - successful stores
   - distinct stores later recalled
   - recall count, time-to-first-reuse, and never-recalled ratio
5. **System boundaries**
   - reranker wiring
   - collection visibility and cross-workspace leakage
   - abstention/minimum-score behavior

### Rubric

- **Useful:** top result answers the actual task or materially constrains it.
- **Partial:** same project/domain but not the requested fact; may still prompt useful search.
- **Irrelevant:** different task/domain and likely to waste context or mislead.

## Executed data processing

Normalized events were extracted from each transcript format:

- Codex: `session_meta`, `function_call`, `function_call_output`
- Claude: assistant `tool_use` and user `tool_result`
- DeepSeek Harness: compressed `tool/call` and `tool/result`

Events were joined to debug-recall payloads by `debugId`, where the Memex output contained one.
Claude outputs deferred to local tool-result files due size limits were recovered separately.

Artifacts for this run:

- normalized events: [events.jsonl](/home/ubuntu/.codex/visualizations/2026-09-13/01a09c8b-4301-7ee3-b710-b46429659845/memex-transcript-eval/events.jsonl)
- aggregate summary: [summary.json](/home/ubuntu/.codex/visualizations/2026-09-13/01a09c8b-4301-7ee3-b710-b46429659845/memex-transcript-eval/summary.json)
- debug-trace metrics: [debug-traces.json](/home/ubuntu/.codex/visualizations/2026-09-13/01a09c8b-4301-7ee3-b710-b46429659845/memex-transcript-eval/debug-traces.json)
- extraction scripts: same directory

## Results

### Usage and outcomes

| Tool | Calls | Successful/underlying results | Notes |
|---|---:|---:|---|
| `memory_recall` | 115 | 24 | 88 calls failed routing before reaching the backend |
| `memory_store` | 54 | 51 | Claude 38, Codex 12, Harness 1 |
| `memory_stats` | 6 | 3 | 3 failures/errors |
| `document_upsert` | 6 | 4 | two timeouts in a Codex session |
| `document_collections` | 1 | 1 | Codex |
| `document_forget` | 1 | 1 | Codex |

Project call distribution:

- `llm-proxy`: 85 calls
- ``<infra-workspace>``: 76 calls
- `ansible`: 7 calls
- other/home workspace: 13 calls
- `memex`: 0 calls across 100 Claude session files for that workspace

The absence of Memex calls in its own repository is not necessarily wrong, but it suggests
agents are not consistently recognizing when prior Memex context should be checked.

### Latency

| Source / tool | Successful calls | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Claude recall | 18 | 0.557 s | 3.500 s | 6.928 s |
| Codex recall | 6 | 2.488 s | 8.318 s | 8.541 s |
| Claude store | 38 | 2.844 s | 5.340 s | 13.792 s |
| Codex store | 12 | 1.350 s | 31.124 s | 31.207 s |
| Codex document upsert | 4 | 0.661 s | 26.778 s | 31.350 s |
| Harness stats | 2 | 0.040 s | 0.041 s | 0.041 s |

Store and document-write latency is high enough that an agent can reasonably avoid using
Memex if the task is interactive. Retrieval latency is acceptable once routing works.

### Quality review of 23 successful recall samples

The relevant cases clustered around explicit operational context:

Examples with a useful top result:

- Spark Pair B deployment and dynamic-shared-memory queries returned the current runbook and
  pinned runtime state.
- Codex local/Windows/Dev plugin and MCP setup queries returned the exact recently stored setup
  memory and matching document.
- DS4 second-lane deployment query returned the deployment fact directly.
- mac-fleet and qwen-deployment queries returned the LLM/voice fleet reference.

Examples with poor top results:

- A malformed/empty proxy-response query surfaced an unrelated homelab dashboard design.
- A herdr-workspace query surfaced a Grafana dashboard document.
- A Chrome side-panel 400/query normalization search surfaced an OpenClaw cache-debugging task.
- Several broad infrastructure queries returned fleet inventory documents rather than the
  specific incident/config.

Manual distribution: **11 useful / 7 partial / 5 irrelevant**.

### Memory lifecycle reuse

Before the final validation probes:

- successful transcript-attributed stores: **51**
- later recalled: **7 (13.7%)**
- total recorded recall events across those 51: **19**
- median time to first reuse for the recalled subset: **~6.2 days**
- overall memories with zero recalls: **300/382 (78.6%)**

A small number of durable operational preferences and incident memories did get substantial
reuse, but the large majority were write-only. This is consistent with low recall reliability and
lack of default scoping: valuable memory exists, but it is not reliably rediscovered.

### Provenance

Explicit memory citations were found in only **2 unique successful-recall sessions**. The server
returns citations in the tool result and instructs agents to preserve them, but the observed
compliance rate is too low for a clean A/B attribution. This is a missing evaluation signal,
not proof that recalls were unused.

## Root causes behind the low quality

### 1. The unified path silently disables the configured reranker

`src/mcp-server.ts` correctly reads `MEMEX_RERANK_ENDPOINT`,
`MEMEX_RERANK_API_KEY`, and `MEMEX_RERANK_MODEL` (lines 88–92), but when document paths are
configured it constructs:

```ts
retriever = new UnifiedRetriever(store, documentSearchFn, embedder, { captureTrace });
```

at `src/mcp-server.ts:123`, without a `reranker` option. The current live trace confirms:

```json
"config": { "reranker": null }
```

The legacy memory retriever receives reranker configuration, but the actual production path is
the unified document/memory retriever. This is the clearest quality regression: reranking code
is present but not wired for the configured deployment.

### 2. Cross-workspace documents are shared by default

The daemon configures:

- `openclaw`
- ``<infra-workspace>``

as public document collections. The database contains 2,422 documents in the OpenClaw collection.
A generic coding-agent query can therefore be answered by OpenClaw task history even when that
context is unrelated. The current design shares the memory DB across clients but does not yet
derive a safe per-agent default collection boundary from client identity/cwd.

### 3. Score floors do not implement useful abstention

`minScore` defaults to 0.15. The current negative probe returned five results whose final scores
were ~0.417 despite having no shared substantive query terms. Source-diversity handling also
reserves a top conversation and top document before applying the score filter. The declared
confidence fields (`confidenceThreshold`, `confidenceGap`) control whether reranking occurs;
they are not a final confidence gate.

Consequently, Memex usually answers when it should abstain.

### 4. Large default results are operationally awkward

Seven Claude recall calls returned 88k–149k characters and were deferred to local files by the
client. The retrieval technically worked, but the agent must spend extra tool calls to consume it.
No relevance-first response truncation or structured summary is produced by the default unified
tool response.

## Live validation executed on 2026-09-13

### Positive task probe

Query: `Qwen Pair B 2,224 dynamic shared memory deterministic topk d707976 1M`

Result: correct current Pair-B runbook, the TP=2 runbook, historical model comparison, and the
specific pinned-state memory. The query took ~9.9 s cold (embedding/write path not reused), and
the scoped repeat took ~0.3 s. This demonstrates the system can work well when the corpus is
task-aligned and results are fresh.

### Negative probe

Query: `zzxqf blorp quantum fluxbank nobody-asked-this-2026`

Result: five unrelated public documents, scores around 0.417–0.423, including a Paperclip
workspace model and an old OpenClaw session log. It should have returned zero or one low-confidence
warning. This confirms the default threshold/diversity behavior.

## Verdict

**Current Memex utility: low-to-moderate.**

- Good at exact recent operational lookup and preserving durable user constraints.
- Poor at reliable agent-facing delivery because of a routing failure, missing unified reranker,
  weak abstention, and cross-domain document leakage.
- Write-heavy relative to measured reuse: 51 session-attributed stores produced only 7 observed
  later recalls.
- It is not safe to conclude “Memex helps broadly” from the available evidence; the strongest
  proof is a narrow set of successful targeted recalls and a handful of reused constraint/fact
  memories.

## Follow-up completed the same day (v0.7.4)

The first remediation item was implemented on branch `codex/mcp-unified-reranker`:

- `createMemexMcpServer` now uses `resolveCrossRerankerFromEnv()` and passes the
  cross-encoder configuration into `UnifiedRetriever`.
- An actually-applied rerank now uses the final relevance floor; protected source
  slots cannot bypass it.
- A failed or skipped rerank retains the former calibrated-score behavior.
- Added provider/score-mode/blend/confidence-gate environment overrides and a
  server-level regression test that exercises the production unified path.
- Full suite: **962/962 passing**.

The next measured validation step is to restart the daemon (with explicit
operator approval) and re-run the 23-case transcript sample plus negative controls
against live traces.

## Recommended next iteration

1. **Fix unified reranker wiring**
   - Pass `reranker: { endpoint, apiKey, model, provider }` into `UnifiedRetriever`.
   - Add a test that proves `MEMEX_RERANK_*` reaches the unified path.
   - Re-run the 23-task transcript sample and compare top-1 useful rate.

2. **Make default collections agent-safe**
   - Require a client/project-derived public default rather than making OpenClaw content global.
   - Support a stable per-cwd/collection mapping and make the tool result show the effective
     collection boundary.

3. **Add true abstention**
   - Enforce a relevance floor after reranking.
   - Do not reserve top source results when all results are below the floor.
   - Return zero rather than five plausible wrong memories by default.

4. **Return an agent-shaped response**
   - Compact per-result title + excerpt + provenance.
   - Include debug ID, source collection, age, recall count, and rerank status.
   - Cap inline output and offer explicit expansion.

5. **Instrument attribution**
   - Require a client ID, session ID, cwd, and project name in every tool call.
   - Emit an agent-attributed debug payload, not only `agentId=mcp`.
   - Track whether the model actually cited the returned anchor in the next assistant message.

## Evaluation gate for a future release

- 100 realistic prompts, stratified by `llm-proxy`, ``<infra-workspace>``, and unrelated negative tasks.
- Report top-1 strict useful, top-3 useful, false-answer rate, correct-abstention rate, and p95.
- Accept only when:
  - successful delivery ≥ 95%
  - top-1 useful ≥ 80%
  - correct negative abstention ≥ 90%
  - cross-collection leakage = 0 on task-specific queries
  - stored-memory 14-day reuse ≥ 35% for the golden set
- Compare default vs scoped vs reranked behavior on the same corpus.

## Limitations

- Transcript extraction proves explicit tool calls; it cannot fully prove cognitive usefulness
  when an agent reads a result silently or fails to cite it.
- The shared debug trace directory is not cleanly attributable to coding agents versus OpenClaw,
  so the main quality claim uses local successful transcript samples rather than aggregate debug
  counts.
- Remote machines without transcript access on this host were not included; only the local and
  accessible DeepSeek Harness stores were audited.
