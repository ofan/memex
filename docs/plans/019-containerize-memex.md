# Containerize Memex Daemon (019)

**Created:** 2026-06-28
**Goal:** Package the memex HTTP MCP daemon as a container image for standardized deployment.

## Why

The current deployment is manual + fragile:
- **OpenClaw plugin**: `rm -rf ~/.openclaw/plugins/memex && cp -r . ~/.openclaw/plugins/memex && openclaw gateway restart` — a raw file copy with no version pinning.
- **Daemon**: `memex.service` (systemd user unit) + `memex.env` + `op run` — host-specific, manual env management.
- **T2.2 migration** (decided): move the daemon to the always-on host via a launchd unit + secret transfer. This is costly + host-specific.

Containerizing replaces all of this with: **one image → deploy anywhere** (docker run, docker-compose, k8s). The env config (`memex.env`) maps directly to container env vars. Migration (T2.2) becomes "deploy the image on the target host" — no launchd unit, no manual secret transfer.

Note: co-locating the daemon with the embed server doesn't eliminate the llm-proxy round-trip (reflection still hits `llm-proxy-k8s`). The win is **deployment simplicity + reproducibility**, not latency.

## Scope

- **Dockerfile**: multi-stage build (compile `dist/` via `tsc` in a builder stage → copy to a slim runtime image with `node` + `better-sqlite3` native binding + `sqlite-vec` extension). Alternatively, jiti-at-runtime (simpler Dockerfile, slower startup) — prefer pre-built `dist/` for a smaller image.
- **Config**: env-driven (already the case — `MEMEX_EMBED_*`, `MEMEX_LLM_*`, `MEMEX_AUTH_TOKEN`, `MEMEX_DB_PATH`, `MEMEX_HTTP_HOST`, `MEMEX_HTTP_PORT`). Container env = the current `memex.env`.
- **DB persistence**: SQLite volume mount (the memory pool). Single-writer (the daemon is the sole writer).
- **Tailscale access**: the daemon needs Tailscale to reach the embed server (`<embed-host>:<port>`) + llm-proxy (`<llm-proxy-host>:<port>`) + serve HTTP on the tailnet. Options: Tailscale sidecar container, host networking, or run on a Tailscale-enabled host.
- **Secrets**: the embed key (`op://homelab/llama-swap-mini1/api-key`) + auth token (`op://homelab/memex-daemon/memex-daemon-token`) — inject via env (Docker secrets, k8s secrets, or `op run` wrapper).

## Key decisions (to make)

1. **Build strategy**: pre-built `dist/` (multi-stage, smaller image) vs jiti-at-runtime (simpler, larger).
2. **Tailscale**: sidecar vs host networking vs Tailscale-enabled host.
3. **Orchestration**: `docker run` / `docker-compose` / k8s deployment (the user has k8s infra — `llm-proxy-k8s`).
4. **DB strategy**: volume mount (current single-DB) vs network-attached storage (for future multi-instance).

## Out of scope

- The OpenClaw plugin (separate deployment path — it's a plugin, not the daemon).
- The embed/rerank server (stays on the always-on host).
- The llm-proxy (already on k8s).
