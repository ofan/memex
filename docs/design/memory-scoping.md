# Memory Scoping and Provenance Design (Problem 2)

**Status:** Design. Not yet implemented.
**Scope:** Problem 2 from `docs/plans/two-problems-architecture.md` -- the data-model change that makes a shared memory pool usable without cross-context leak.
**Sibling decisions:** `docs/design/v0.8-architecture-decisions.md` (T2.1 per-device docs, T2.2 Mac mini daemon, T2.3 fail-closed, T2.4 Camp C corrections).

---

## Problem statement

A shared memory pool sees inputs from many contexts: different devices, different projects, different agents, different platforms. Without context-awareness, memories from one project leak into another. Today, 407 of 413 production memories are `scope='global'` with no provenance metadata -- a concrete gap.

Three sub-problems:

1. **At store time:** classify each memory's scope (where it is relevant)
2. **At recall time:** use the asker's context to filter or rank memories
3. **At judgment time:** surface provenance so the agent can decide what to use

The OS analogy (validated with the user): process isolation + shared memory pages. Default-isolated, explicit promotion to shared. Judgment is key -- do not try to make the retrieval system perfectly correct; return memories with provenance and let the agent judge.

---

## Target architecture constraint

T2.2 has committed to the Mac mini central daemon as the deployment architecture. In the target state, all real clients connect via HTTP. This inverts a naive assumption: server-side scope inference from `process.cwd()` works beautifully in stdio mode but is inapplicable over HTTP. The daemon runs in its own working directory and has no access to the client filesystem.

**The resolution is a unified story:** scope derivation uses one algorithm (walk cwd to git root, hash it). The difference is only **who executes it**:

| Transport | Who derives scope | Mechanism |
|---|---|---|
| **stdio** (local subprocess) | Server (optimization) | Walk `process.cwd()` to git root on the server process |
| **HTTP** (remote daemon) | Client (requirement) | Client wrapper derives scope and passes it as an explicit tool parameter or HTTP header |

One algorithm, two executors. The server always accepts explicit scope parameters and only falls back to server-side inference when the transport (stdio) makes it possible and the client did not supply its own scope.

---

## Scope dimensions

Four orthogonal dimensions form the scope vocabulary. Two are transport-independent (the scope derivation algorithm works the same everywhere; only the executor changes). Two require explicit client cooperation because the server cannot derive the necessary information from transport-level signals alone.

### Project (transport-independent -- one algorithm, two executors)

Project is the primary isolation boundary. The scope derivation algorithm:

1. If the executor (server in stdio, client wrapper in HTTP) can read a project-root signal, use it directly. In stdio mode, the environment variable `CLAUDE_PROJECT_DIR` is set on the server subprocess and provides a fast-path. The canonical method in both modes is walking up from the current working directory to the nearest `.git` directory and taking its parent as the project root.
2. If no `.git` is found, use the current working directory itself as the fallback project root.
3. Hash the normalized absolute path: `sha256(root)[0:16]` to produce the `project:<hash>` scope value.

**Verification note:** The claim that specific MCP clients (Codex, OpenCode, Pi) set their server subprocess `cwd` to the workspace directory is plausible but unverified against current client versions. These claims are marked with `[TO VERIFY]` and do not block initial implementation; for the HTTP path (the target architecture), client-side derivation avoids relying on unverified per-client cwd behavior. See Open Questions for verification plan.

**Project scope value:** `project:<sha256(git-root-path)[0:16]>` -- a 16-hex-char opaque identifier. Opaque because the path is not a stable identity: the same repository cloned to two different directories yields different project hashes. This is a deliberate v1 tradeoff. The mitigation for same-repo-different-clone is `metadata.git_remote` (normalized, see Metadata section) for future dedup. The alternative -- hashing the `git_remote` origin URL instead of the local path -- would give stable per-repo identity but requires `git remote` to be configured at store time, which is unavailable in non-git directories. The path-hash approach works in all directories; `git_remote` metadata enables future merge.

### Device (provenance only, transport-dependent)

Device identity is a provenance field, **not a scope column value and not an access-control dimension**. It exists solely for debugging and future cross-device merge.

**Derivation is transport-dependent:**

- **stdio mode:** Server derives `device:<sha256(hostname + HOME)[0:12]>` from its own host environment. This is correct because the server process and the client are on the same machine.
- **HTTP mode:** The daemon's hostname and HOME reflect the Mac mini, not the client. The client MUST supply its own device fingerprint. The daemon accepts `X-Memex-Device` header or an explicit `device_id` tool parameter; it MUST NOT self-compute device provenance for HTTP clients. If the client supplies no device ID, the provenance field is absent from metadata for that memory -- it is never filled with the daemon's identity.

**Device scope value in metadata only:** The device fingerprint is stored as `metadata.device_id`. It is **never** a valid value in the `memories.scope` column. The scope vocabulary table below does NOT include a `device:` row. Memories MUST NOT be written with `device:<hash>` as their scope value; the store path MUST reject or remap such values (see Validation).

### Agent (explicit only)

Agent-scoped memories are isolated to a specific agent persona (e.g., `agent:coder` vs `agent:architect`). Agent identity cannot be derived from stdio transport alone -- the MCP protocol does not expose agent persona information. The client MUST pass the agent name explicitly.

**Agent scope value:** `agent:<name>` -- flat namespace. The OpenClaw plugin can derive this from the agent config it already has and pass it as an explicit tool parameter. Other clients need explicit configuration.

**Interaction with per-platform docs:** The claim that Pi profiles imply agent-scoped memories is unverified. Pi's `.omp/mcp.json` inherits cwd from the launching shell; whether profile names are available to MCP server subprocesses as derivable signals has not been tested. Agent scoping via explicit parameter works for any platform regardless. The Pi section in per-surface notes is accordingly marked `[TO VERIFY]`.

### Session (explicit only)

Session-scoped memories are ephemeral -- relevant only within one conversation. The client MUST generate and pass the session ID.

**Session scope value:** `session:<client-ns>:<id>` -- namespaced by client to prevent collision in the multi-client daemon. Two clients independently generating `session:1` would otherwise collide. The client namespace is the first 8 hex chars of `sha256(client_identifier)`, where the client identifier is the `clientInfo.name` from MCP Initialize (or a configured client name for HTTP clients). On store, the server prefixes bare session IDs with the client namespace. Example: if client hash is `a1b2c3d4` and the agent passes `session:chat_42`, the stored value is `session:a1b2c3d4:chat_42`.

**Duplicate prevention:** The daemon detects duplicate session IDs within the same namespace and rejects the store (returns an error to the caller). Cross-namespace duplicates are harmless because recall filters include the client's own namespace prefix.

---

## Scope vocabulary (SQL column values)

The `memories.scope` column uses a flat namespace with prefix-matched categories. No migration needed -- the column already exists and recall already filters by it. The change is in what values go in and what filters apply at read time.

**Validation gate at store time:** The existing `validateScopeFormat` regex in `src/scopes.ts:255` is `^[a-zA-Z0-9._:-]+$` which permits colons. This is sufficient for the prefix:value pattern. All scope values written to the column MUST pass this validation. Additionally, scope values beginning with `device:` MUST be rejected -- device provenance is metadata-only.

A memory has exactly one scope value. The recall filter is a flat union of matching values: `scope IN ('global', 'project:<current>', 'agent:<current>', 'session:<current>')`. A memory scoped as `project:A` will never be filtered by agent identity -- that is intentional. The four dimensions are not a multi-dimensional cross-product; they are independent categories within a single flat namespace.

| Value pattern | Meaning | Who sets it | Recall default |
|---|---|---|---|
| `global` | Relevant everywhere | Server default (no project detected) or agent explicitly | Always included |
| `project:<hash>` | Scoped to one project tree | Executor (server in stdio, client wrapper in HTTP) | Included when the asker is in that project |
| `agent:<name>` | Scoped to one agent persona | Client explicit (tool param) | Included when that agent asks |
| `session:<client-ns>:<id>` | Scoped to one conversation | Client explicit (tool param), namespaced by server | Included when that session asks |

Device is NOT a scope column value. Device identity lives in `metadata.device_id` only.

**Recall SQL is additive, not exclusive:** a query includes `scope IN ('global', 'project:<current>', 'agent:<current>', 'session:<current>')`. A memory never needs to "belong" to the current context; global plus any matching scoped memories are all surfaced. No cross-project leak because `project:<other>` is excluded.

**Note for implementers:** The recall filter uses exact-match IN clauses on the flat scope column. Pattern matching with `LIKE 'project:%'` is NOT the intended query path and would require a separate index. The initial implementation does not depend on LIKE queries; future migration to a structured scope representation (separate columns or a scope table) is possible but out of scope for v1.

---

## Scope derivation algorithm (unified)

The core algorithm is the same everywhere. Only the executor differs.

**Algorithm** (pseudocode):

**Steps:** (1) if the `CLAUDE_PROJECT_DIR` env var is set, use it as the project root (fast path); (2) otherwise walk up from the working directory to the nearest parent containing a `.git` directory and use that parent; (3) if no `.git` is found, fall back to the working directory itself; (4) normalize the path (resolve symlinks, strip trailing slashes); (5) the scope value is the literal prefix `project:` followed by the first 16 hex characters of the SHA-256 of that normalized root path.

**In stdio mode:** The server calls `deriveProjectScope(process.cwd(), process.env)` at store time and at recall time. `CLAUDE_PROJECT_DIR` is used as a fast-path when present; the git-root walk is the canonical method and the fallback when the env var is absent or the server runs under a client that does not set it. The CLAUDE_PROJECT_DIR reliance is documented here as a Claude Code-specific optimization, not a universal contract. Other clients may or may not set it; the git walk handles all cases.

**In HTTP mode:** The client wrapper calls the same `deriveProjectScope()` function before making tool calls. It passes the resulting `scope` as an explicit parameter on `memory_store` and `memory_recall`. The daemon accepts but does not self-derive project scope when the transport is HTTP.

**Debug label (non-git directories):** When no `.git` root is found, the project hash is derived from the cwd path itself. For debuggability, the metadata includes the cwd's basename as a human-readable label alongside the opaque hash (see Metadata section). This helps identify memories in the memory browser without exposing the full path.

---

## Capture mechanism (dual-path)

### Primary path: client-side scope derivation (works everywhere)

In the T2.2 target architecture (HTTP daemon), the client wrapper is responsible for scope derivation. The client:

1. Runs `deriveProjectScope()` using the workspace directory it already knows.
2. Passes the resulting `scope` as an explicit parameter on every `memory_store` and `memory_recall` call.
3. Passes `device_id` (for HTTP clients, this is self-computed; for stdio clients it is optional since the server can self-derive).
4. Passes `agent_id` and `session_id` when available from the platform's agent/session model.

This path requires a thin client wrapper per platform. For OpenClaw, the plugin already has access to `workspaceDir`, `agentId`, and `sessionId` in the `before_prompt_build` hook. For Claude Code HTTP mode, the wrapper takes the form of a `headersHelper` script or a local proxy process (see Claude Code per-surface section). For other MCP clients, a small wrapper script that derives scope and wraps tool calls is sufficient.

### Secondary path: server-side inference (stdio optimization)

In stdio mode, the server process runs on the same machine as the client and inherits the client's working directory. The server can derive project scope from `process.cwd()` and device from its own host environment. This is an optimization that avoids the need for a client wrapper in the stdio case -- it is not required for correctness, because the client can always supply explicit scope if it wants to override the server default.

**Resolution order for store-time scope (server-side, stdio only):**

1. If the client passed an explicit `scope` parameter, use it.
2. Otherwise, if `CLAUDE_PROJECT_DIR` is set, use it directly as the project root (fast-path).
3. Otherwise, walk up from `process.cwd()` to find the nearest `.git` directory. The parent of `.git` is the project root.
4. If no `.git` found, use `process.cwd()` itself as the fallback project root.
5. Hash the normalized absolute path: `sha256(root)[0:16]` to produce the `project:<hash>` scope value.
6. If the hash step fails, default to `global`.

### Tool parameter surface

The `memory_store` MCP tool accepts these additional optional parameters:

- `scope` (string, optional) -- Override the derived scope. The agent can promote a project fact to `global` by passing `scope: "global"`. The server-inferred scope is always the default when the parameter is absent; when present, the explicit value is authoritative.
- `agent_id` (string, optional) -- Set the agent identity for agent-scoped memories.
- `session_id` (string, optional) -- Set the session identity for session-scoped memories. The server prefixes this with the client namespace.
- `device_id` (string, optional) -- Supply the device fingerprint. In stdio mode this is optional (server self-derives). In HTTP mode this SHOULD be supplied; if absent, `metadata.device_id` is omitted from the stored memory.

The `memory_recall` MCP tool accepts this additional optional parameter:

- `scopes` (string array, optional) -- Explicit list of scope values to filter by. When provided, this replaces the additive default. A power user searching across all their projects can pass `scopes: ['global', 'project:A', 'project:B']`. When absent, the server computes the default filter from current context.

### Metadata populated at store time (always)

Provenance metadata is always populated server-side regardless of whether scope was explicit or inferred. Metadata is orthogonal to scope value.

| Field | Source | When | Stored as |
|---|---|---|---|
| `project_root` | Derived project root path | Always | `sha256(root)[0:16]` -- hash only, never the raw path |
| `device_id` | stdio: derived from hostname+HOME; HTTP: client-supplied | When available | `device:<sha256(hostname+HOME)[0:12]>` or client-supplied value |
| `cwd_hash` | `sha256(process.cwd())[0:16]` at store time | Always | Hash only, never the raw path |
| `cwd_label` | Basename of `process.cwd()` at store time | When no `.git` root found | Human-readable label for non-git directories |
| `git_branch` | `git rev-parse --abbrev-ref HEAD` (if in a git repo) | When available | String |
| `git_remote` | Normalized origin URL (if configured) | When available | Normalized form (see below) |
| `client` | `clientInfo.name` from MCP Initialize (stdio) or configured client name (HTTP) | When available | String |
| `captured_at` | ISO 8601 timestamp | Always | ISO 8601 string |

Fields that cannot be resolved are absent from the JSON object, never set to `null`. This keeps metadata sparse and truthful.

**Security constraint:** `project_root` and `capture_cwd` are absolute filesystem paths that constitute PII (they reveal the user's directory structure and project names). These MUST be hashed before storage. The raw paths are never written to the database. The hashed `project_root` value still enables future dedup (two memories with the same `project_root` hash were captured from the same directory tree). The raw path is available in-memory during the store operation for git metadata extraction (branch, remote) but discarded after hashing.

**git_remote normalization:** Remote URLs are normalized before storage to avoid fragmentation of the dedup signal. Normalization rule: strip the `.git` suffix; normalize SSH form (`git@github.com:ofan/memex`) to HTTPS form (`https://github.com/ofan/memex`); lowercase the host component. Example: `git@github.com:ofan/memex.git`, `https://github.com/ofan/memex.git`, and `https://github.com/ofan/memex` all normalize to `https://github.com/ofan/memex`.

**Full metadata shape (conceptual):**

The metadata JSON object carries: `source` (one of memory_store, session-import, dreaming, correction); `entities`; `project_root` (the 16-char hash); `device_id` (the `device:` hash); `cwd_hash` plus a human-readable `cwd_label`; `git_branch`; `git_remote` (normalized URL); `client` (the MCP `clientInfo.name`); `agent_id`; `session_id`; and `captured_at` (ISO timestamp). Any field that does not apply is absent, never null.

Fields absent when the information is not available. No `null` values. No raw filesystem paths.

---

## Dreaming scope boundaries (critical)

All three dreaming phases MUST respect scope boundaries. The current implementation operates across all scopes indiscriminately; this design specifies the required scope-aware behavior. The design assumes dreaming runs on the daemon (which has full DB access) and can read the `scope` column for every memory.

### Light sweep -- scope-aware

**Dedup:** The dedup key is `(text, scope)`, not `text` alone. Two memories with identical text but different scopes (e.g., "I prefer dark mode" stored as `project:A` and independently as `project:B`) are NOT duplicates. Each scope maintains its own text dedup. The SQL becomes:

group memories by identical text and scope, flagging any group with more than one row.

And the DELETE targets rows within the same `(text, scope)` group.

**Noise removal:** `isNoise()` runs per-memory and does not need scope awareness -- each memory is independently classified. Scope is irrelevant to the noise signal.

**Fragment purge:** Conversation fragment detection (`[user]`/`[assistant]` markers) runs per-memory and does not need scope awareness.

**Post-condition:** After light sweep, no two memories with the same scope have identical text.

### Deep sweep -- scope-agnostic (but safe)

Recency-based rescoring and ephemeral decay are per-memory operations. They do not cross-compare memories and therefore cannot cause cross-scope data loss. No change needed.

### Reflection -- scope-inheriting

When the LLM reflection phase synthesizes a learning from a batch of recalled memories, the learning's scope is determined by the scope composition of the input batch:

- **Single-scope input:** If all memories in the batch share the same scope (e.g., all are `project:abcd`), the learning inherits that scope. The learning is NOT `global` -- it must not leak project-specific insights into unrelated contexts.
- **Mixed-scope input:** If the batch spans multiple scopes, the learning is `global`. This represents cross-project synthesis: a pattern observed across multiple projects that generalizes.
- **Scope alongside learning text:** The reflection prompt includes the scope of each source memory so the LLM can contextualize its synthesis. The system prompt instructs the LLM to note when a learning is project-specific vs general.

The current implementation hardcodes `scope: 'global'` for all reflection learnings (`src/dreaming.ts:318`). This MUST change to the scope-inheriting rule above.

---

## Recall policy

### Default filter (additive)

When the agent asks for memories (via `memory_search` or auto-recall), the server constructs a scope filter from the current context:

select memories whose scope is either `global` or the current `project:<hash>`.

If the client has also provided `agent_id` or `session_id`, those scopes are added to the IN clause. The filter is always additive -- it expands the recall pool, never restricts it below `global + project`. Global memories always surface because they are, by definition, relevant everywhere.

**In stdio mode:** The server derives the current project hash from `process.cwd()` (same algorithm as store time).

**In HTTP mode:** The server reads the current project scope from the `scopes` tool parameter (if provided), or from a configured per-client default scope (if configured), or defaults to `['global']` only.

### Explicit override

The `memory_recall` tool accepts an optional `scopes` parameter -- an explicit list of scope values to filter by. When provided, this replaces the additive default. A power user searching across all their projects can pass `scopes: ['global', 'project:A', 'project:B']`.

### Provenance in recall results

Every recalled memory includes its metadata fields in the response. The agent sees where the memory came from (scope, device, project hash, git branch, git remote, client, agent, session, capture time) and can judge relevance itself. The system does not try to be perfectly correct -- it surfaces candidate memories with provenance and lets the agent decide.

The provenance surface in recall results:

- `scope` -- the scope value (always present)
- `metadata.project_root` -- hash of the path where this was captured (always present)
- `metadata.device_id` -- which device captured it (when available)
- `metadata.git_branch` -- what branch was checked out (when available)
- `metadata.git_remote` -- normalized remote URL (when available)
- `metadata.agent_id` -- which agent persona captured it (when available)
- `metadata.client` -- which platform captured it (when available)
- `metadata.captured_at` -- when it was captured (always present)
- `metadata.cwd_label` -- human-readable basename for non-git directories (when available)

---

## Per-surface notes

### Claude Code

**Stdio mode (current):** `CLAUDE_PROJECT_DIR` is set on the server subprocess. The server reads it as a fast-path for project resolution. The git-root walk is the canonical fallback. No changes needed in `.mcp.json` for scope -- it works automatically.

**HTTP mode (T2.2 Mac mini daemon):** Claude Code MCP HTTP config supports a `headersHelper` script. The `headersHelper` script can read the workspace directory from Claude Code's process environment and derive the project hash. The script writes HTTP headers (`X-Memex-Project`, `X-Memex-Device`) that the daemon reads.

**Decision: `headersHelper` is the committed mechanism for Claude Code HTTP scope passing.** Before T2.2 implementation begins, the `headersHelper` capability must be validated: can it dynamically derive a project hash from the workspace directory at connection time? If validation shows `headersHelper` cannot provide the project hash dynamically, the fallback is a per-project `.mcp.json` with a static `X-Memex-Project` header configured in the `env` block. This fallback requires one `.mcp.json` per project, which is acceptable for the primary production client. The `headersHelper` validation is tracked as a pre-implementation task in `docs/plans/two-problems-architecture.md` Problem 2 progress.

In parallel, a local wrapper process approach is viable: a thin script spawned by Claude Code's MCP config that derives scope, then proxies tool calls to the HTTP daemon with scope parameters added. This is equivalent in function to `headersHelper`, just at a different layer.

### Codex `[TO VERIFY]`

The claim that Codex MCP servers inherit `cwd` from the `config.toml` workspace directory is unverified against current Codex versions. For the initial implementation, Codex HTTP clients should use explicit scope parameters or a configured default. Verification is tracked in Open Questions.

### OpenCode `[TO VERIFY]`

The claim that OpenCode's `opencode.json` sets `InstanceState.directory` as the MCP server's cwd is unverified. The claim that per-workspace `opencode.json` files result in per-project MCP server instances with different cwds is unverified. For the initial implementation, OpenCode HTTP clients should use explicit scope parameters.

### Pi `[TO VERIFY]`

The claim that Pi's `.omp/mcp.json` inherits cwd from the launching shell is unverified. The claim that Pi profiles have separate MCP server instances is unverified. The claim that agent-scoped memories can be derived from profile names is unverified -- and contradicts the design principle that agent identity requires explicit client cooperation. Agent scoping via explicit parameter works for any platform.

### OpenClaw (native)

OpenClaw is the native platform. The plugin (`index.ts`) already has access to `agentId`, `sessionId`, and `workspaceDir` in the `before_prompt_build` hook. The plugin passes derived `scope` (from `workspaceDir` via the unified algorithm), `agent_id`, `session_id`, and `device_id` as explicit tool parameters on `memory_store` and `memory_recall`. This makes the OpenClaw path the richest -- all four scope dimensions are populated automatically, regardless of whether the transport is stdio or HTTP.

---

## Data model (conceptual)

### Scope column (existing, unchanged schema)

The `memories.scope` column is `TEXT NOT NULL DEFAULT 'global'`. No migration. The change is purely in the values written and the filters applied at read time. Exact-match IN clauses cover all current use cases; LIKE pattern matching is not required.

### Metadata JSON (existing column, expanded keys)

The `memories.metadata` column is a JSON text column. Today it holds `source` and `entities`. The design adds the provenance keys described in the Metadata section above. No schema change -- JSON columns are schemaless by nature. Missing keys are absent, never `null`. No raw filesystem paths are stored.

### Initial backfill consideration

As of 2026-06-26, 407/413 production memories have `scope='global'` and no provenance metadata. These pre-existing memories are **not backfilled** with synthetic provenance -- a memory stored without context cannot have context retroactively inferred. They remain `global` and continue to surface everywhere, which is the correct behavior: they were stored as global, they stay global. New memories from this design onward carry full provenance.

---

## Risks and open questions

### Risk 1: cwd-hash is not logical project identity

**Problem:** Two clones of the same repository in different directories produce different `project:<hash>` values. Memories captured in `/home/user/projects/memex` and `/home/user/projects/memex-old` are in different scopes and do not surface together.

**Mitigation:** `metadata.git_remote` is always captured when available and normalized to a canonical form. Future dedup flow: for any pair of scopes with the same `git_remote` value, a sweep can compare text hashes across scopes and merge or link semantically similar memories. The `project_root` hash in metadata independently confirms that two memories came from different local clones of the same remote. This is deferred -- the v1 scope model accepts the hash-as-identity tradeoff. Users who want unified recall across clones can set the same explicit project scope or use `global`.

### Risk 2: Agent identity requires client-side integration

**Problem:** Agent-scoped memories only work when the client passes `agent_id`. Most MCP clients do not have a notion of agent identity. This means the agent dimension is unused for clients that do not integrate -- acceptable because `global + project` covers the dominant scenarios.

**Mitigation:** Agent scoping is opt-in and additive. If the client does not pass `agent_id`, agent-scoped memories are simply not filtered in/out -- the recall pool is `global + project` which is correct for agent-unaware clients.

### Risk 3: HTTP transport has no cwd (T2.2 interaction, resolved)

The T2.2 central daemon runs as a persistent process in its own working directory. It cannot walk the client's filesystem to find a git root. This is the natural property of a remote daemon -- not a flaw in the scope model.

**Resolution:** Client-side scope derivation is the primary path. The daemon accepts explicit scope parameters. The scope derivation algorithm is unified; only the executor changes. This is documented in the Target Architecture Constraint section. The `headersHelper` validation task is the only remaining uncertainty for the primary production client (Claude Code).

### Risk 4: Device fingerprint is a hash, not a human-readable name

**Problem:** `device:<sha256(hostname+HOME)[0:12]>` is not readable in the memory browser or recall results.

**Mitigation:** Device fingerprint is provenance-only, not a filter. A future mapping table (`device_labels`) could associate human-readable names. Deferred. The 12-char truncation of a SHA-256 hash provides approximately 48 bits of entropy, which is sufficient for device disambiguation in a single-user pool (collision probability negligible at the scale of tens of devices).

### Risk 5: Same-repo-different-clone hash divergence

**Problem:** This is a refinement of Risk 1. Even with the central daemon (T2.2) serving a single DB to all devices, the same repository cloned to two different local paths on two different devices produces two different `project:<hash>` values. Memories from the two clones live in disjoint pools despite representing the same logical project.

**Mitigation:** `metadata.git_remote` (normalized) is the merge key. A future dedup pass groups scopes by normalized `git_remote` and merges or cross-links memories with similar content. The `project_root` hash and `device_id` provenance fields distinguish memories that came from different clones, which is itself useful metadata for the merge heuristic. Cross-device sync of the memory pool itself is solved by the daemon architecture -- all devices write to the same DB. The residual issue is only the logical identity mismatch, which `git_remote` dedup resolves.

### Risk 6: `headersHelper` static-only limitation

**Problem:** The Claude Code `headersHelper` mechanism may not support dynamic derivation of project context -- it may only support static header values. This would force per-project `.mcp.json` files, which is functional but adds configuration overhead for users who work in many projects.

**Mitigation:** Validate `headersHelper` capability before T2.2 implementation begins. If it is static-only, three alternative paths exist: (a) per-project `.mcp.json` files (acceptable, one-time setup per project), (b) a local wrapper process that derives scope and proxies tool calls, (c) a Claude Code plugin or hook that injects project context into MCP tool calls. Path (c) is the most elegant but requires plugin infrastructure. This is tracked as a pre-implementation task.

### Open question 1: Feedback loop design

Should the agent's judgment of recalled memories feed back into the system? Possibilities: boost memories the agent used, demote memories the agent ignored, annotate memories with "useful for X" tags. The user flagged this as desirable but bounded -- "don't overdo it." This design defers the feedback loop to a separate design doc. The provenance metadata here provides the raw material for any future feedback mechanism.

### Open question 2: Correction semantics across scopes

When a dream cycle or LLM reflection produces a correction to a project-scoped memory, what scope does the correction carry? Camp C (T2.4) says corrections are append-only learnings. The design resolves this in the Reflection section above: learnings inherit the scope of their source memories when the input batch is single-scope, and are `global` when the batch spans multiple scopes. A correction to a `project:abcd` memory is `project:abcd`. Cross-project synthesis produces `global` learnings.

### Open question 3: Scope promotion UX

Should the agent be able to promote a project-scoped memory to global (e.g., "this debugging technique applies everywhere")? The `memory_store` tool accepts an explicit `scope` param -- the agent can store a new memory with `scope: 'global'` that references the original. There is no `memory_update` tool today. Promotion requires either a new tool or the convention of storing a new global memory that references the original. Deferred to the tool-surface design.

### Open question 4: Sensitive memories (shared vs private)

Should some memories never cross device boundaries? The user raised this question ("shared vs private"). The current design assumes all memories are equal -- device is provenance only, never a filter. If private memories are needed, a `visibility` field (`private` | `shared`) would be orthogonal to scope. Out of scope for this design.

### Open question 5: Per-platform cwd verification

The following claims in the per-surface notes are unverified and marked `[TO VERIFY]`: Codex `config.toml` cwd inheritance, OpenCode `opencode.json` workspace directory behavior, Pi profile-based agent derivation. These do not block initial implementation because the T2.2 HTTP path uses client-side scope derivation regardless. Verification plan: test each client by spawning an MCP server that logs `process.cwd()` and confirming it matches the expected workspace directory. Tracked in `docs/plans/two-problems-architecture.md` Problem 2 progress.

### Open question 6: Alternative project identity primitive

Should `project:<sha256(git_remote)>` be the default instead of `project:<sha256(local_path)>`? Hashing the remote URL gives stable per-repo identity at the cost of requiring `git remote` to be configured. The local-path hash works in all directories (including non-git ones) but produces different hashes for same-repo-different-clone. The current design chooses local-path hash as v1 default with `git_remote` metadata for future merge. This is a reversible decision -- the scope derivation algorithm can be changed to prefer `git_remote` hash when available, with local-path hash as fallback, in a future iteration without data migration (scope values are opaque strings).

---

## What this unblocks

Once implemented, the scope model unblocks:

- **Safe shared pool:** Memories from different projects do not leak into each other's recall results. Dreaming dedup respects scope boundaries and does not cause cross-scope data loss.
- **Provenance transparency:** Every recalled memory carries enough metadata for the agent to judge relevance -- scope, device hash, project hash, git branch, git remote, client, agent, capture time. No raw filesystem paths are exposed.
- **Future merge:** Normalized `git_remote` + `git_branch` metadata enables heuristics for cross-clone dedup and cross-device merge.
- **Transport independence:** The scope derivation algorithm is the same for stdio and HTTP. Only the executor changes. The design works in the T2.2 target architecture (Mac mini daemon) without redesign.
- **Rich client integration:** OpenClaw (native) gets all four scope dimensions automatically via explicit tool parameters. Other platforms get `project + device` via the client wrapper.

---

## Implementation order (noting blockers in current code)

The following are not implementation instructions -- they are documentation of gaps discovered during the source-level review that this design clarifies. They are listed here so the implementer knows what must change.

1. **`memory_store` tool schema** (`src/mcp-server.ts:63-71`): Add optional `scope`, `agent_id`, `session_id`, `device_id` parameters. Pass them through to `store.store()`.
2. **`memory_recall` tool schema** (`src/mcp-server.ts:111-117`): Add optional `scopes` parameter. Derive current-project scope from cwd (stdio) or use explicit parameter (HTTP). Pass through to `retriever.retrieve()` via the existing `scopeFilter` field in `RetrievalContext`.
3. **Store handler** (`src/mcp-server.ts:86`): Replace hardcoded `scope: "global"` with derived scope (or explicit parameter). Populate provenance metadata (hashed).
4. **Dreaming dedup** (`src/dreaming.ts:47-61`): Change `GROUP BY text` to `GROUP BY text, scope`.
5. **Dreaming reflection** (`src/dreaming.ts:318`): Change hardcoded `scope: 'global'` to scope-inheriting logic.
6. **Scope validation**: Reject `device:<hash>` values in the scope column at store time. Device identity is metadata-only.

---

## Pointers

- `docs/plans/two-problems-architecture.md` -- Problem 2 framing, open questions, progress tracking
- `docs/design/v0.8-architecture-decisions.md` -- T2.1 (per-device docs), T2.2 (Mac mini daemon), T2.3 (fail-closed), T2.4 (Camp C)
- `src/scopes.ts` -- current `ScopeManager` implementation (scope patterns, validation regex, accessible scopes)
- `src/memory.ts` -- schema, store/recall, metadata handling, scopeFilter support in SQL
- `src/mcp-server.ts` -- current MCP entry (hardcodes `scope: 'global'` at line 86; no scope params on tools)
- `src/dreaming.ts` -- dream cycle (dedup groups by text only at line 48; reflection hardcodes `scope: 'global'` at line 318)
- `src/retriever.ts` -- `RetrievalContext.scopeFilter` exists and SQL plumbing is in place; MCP server does not populate it
- `index.ts` -- OpenClaw plugin (has `agentId`, `sessionId`, `workspaceDir` for native scope derivation)