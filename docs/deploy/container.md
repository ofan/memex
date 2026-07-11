# Containerized Memex Daemon (019)

Package the memex HTTP MCP daemon as a container image: one image → deploy
anywhere (`docker run`, Compose, k8s). The env config that the host-side
`memex.env`/systemd unit used maps directly to container env vars. This
supersedes the manual dist-copy (plugin) + systemd unit (daemon) + secret
transfer workflow described in `docs/plans/019-containerize-memex.md`.

## What's in the image

- **Runtime:** `node:25-slim`. Previously pinned to 25 because Node 26 broke
  `better-sqlite3`'s prebuilt native binding. `better-sqlite3` has been bumped
  to 12.x (Node-26-compatible), clearing that blocker. Bump to `node:26-slim`
  when convenient.
- **Artifact:** pre-compiled `dist/` (multi-stage `tsc` build) — smaller image,
  fast startup. The daemon entrypoint is `node dist/src/mcp-server.js`.
- **Native deps:** `better-sqlite3` + `sqlite-vec`, rebuilt for the runtime ABI
  by the postinstall (`scripts/ensure-native-binding.cjs`) in a dedicated deps
  stage that carries `python3/make/g++` as a source-rebuild safety net.
- **Non-root** (`uid 1001`), `cap_drop: ALL`, DB on a `/data` volume.

## Build

```bash
docker build -t memex-daemon:0.7.3 .
```

## Configure

Copy `memex.env.example` → `memex.env` and fill in the tailnet endpoints +
secrets (`memex.env` is gitignored and dockerignored — it never enters the image
or the repo). All values are env-driven:

| Var | Purpose |
|-----|---------|
| `MEMEX_EMBED_ENDPOINT` / `_API_KEY` / `_MODEL` / `_DIM` | Embedding server (OpenAI-compatible). Omit → BM25-only. |
| `MEMEX_RERANK_ENDPOINT` / `_API_KEY` / `_MODEL` | Cross-encoder reranker (Qwen3-Reranker-0.6B). Omit → no reranking. |
| `MEMEX_LLM_ENDPOINT` / `_MODEL` / `_API_KEY` | Reflection LLM + LLM reranker (shared endpoint). Omit → reflection skipped, no LLM reranker. |
| `MEMEX_RERANK_LLM_MODEL` | LLM-based reranker model (opt-in). Requires `MEMEX_LLM_ENDPOINT`. |
| `MEMEX_AUTH_TOKEN` | Bearer token clients must send. **Set in production.** |
| `MEMEX_HTTP_HOST` / `_PORT` | Bind. Inside a container use `0.0.0.0`. |
| `MEMEX_DB_PATH` | SQLite path. Defaults to `/data/memex.sqlite`. |
| `MEMEX_CLIENT_NAME` | Client identity for scope visibility (e.g. `claude-code`). |

## Run

### Compose (recommended; host networking)

```bash
docker compose up -d
docker compose logs -f memex
```

The daemon serves at `<host>:8000` on the tailnet. Health: `GET /health`.

### Plain `docker run` (host networking)

```bash
docker run -d --name memex-daemon --network host \
  --env-file memex.env \
  -v memex-data:/data \
  --restart unless-stopped \
  memex-daemon:0.7.3
```

## DB persistence

The memory pool lives at `/data/memex.sqlite` on the `memex-data` named volume.
The daemon is the **sole writer** — run exactly one instance per DB. To migrate
an existing pool in, bind-mount the file instead of the named volume:

```bash
-v /path/to/existing/memex.sqlite:/data/memex.sqlite
```

## Tailscale access

The daemon must reach the embed server + llm-proxy over Tailscale and serve HTTP
on the tailnet. Three options (the daemon works with any one):

1. **Host networking (default in `docker-compose.yml`).** The container shares
   the host's tailnet interface. Simplest; Linux only. The daemon's
   `MEMEX_HTTP_PORT` binds directly on the host and is reachable at
   `<host-tailnet-name>:8000`.
2. **Tailscale sidecar.** Add a `tailscale` service to Compose (the official
   `tailscale/tailscale` image) on a shared network; the memex service joins the
   same network and routes through it. Use this on macOS or when you can't use
   host networking.
3. **Tailscale-enabled host.** If the host is already on the tailnet, option 1
   reduces to this — no extra config.

Host networking does not eliminate the llm-proxy round-trip (reflection still
leaves the host). The win is deployment simplicity + reproducibility, not
latency.

## Secrets

`memex.env` holds endpoints + keys. Inject it at runtime only — it is never
baked into the image. For 1Password-managed values, wrap the run in
`op run --env-file=memex.env -- …` (resolve-on-launch), or mount the file from a
secret store. Keep base URLs/endpoints in plain config; only true secrets (API
keys, the auth token) belong in the secret store (per `feedback_1password_secrets_only`).

## Kubernetes

The image runs identically under k8s: a `Deployment` with `MEMEX_*` env (from a
`Secret`/`ConfigMap`), a `PersistentVolumeClaim` at `/data`, and a `Service` +
`probe` on `/health`. Use a Tailscale-sidecar pod (or the Tailscale Kubernetes
operator) for tailnet access.
