# syntax=docker/dockerfile:1
#
# Memex MCP daemon — HTTP server + SQLite memory pool, multi-stage build.
#
# Node is pinned to the 25 series (NOT 26): Node 26's ABI breaks better-sqlite3's
# prebuilt native binding until upstream ships prebuilds. The dev/test env pins
# 25.9 (mise.toml); 25.x shares one ABI so `node:25-slim` is safe here. When the
# upstream blocker clears, bump to `node:26-slim`.
#   ref: docs/plans/019-containerize-memex.md
#        ~/.claude/.../reference-node-26-better-sqlite3-blocker.md
#
# Build:  docker build -t memex-daemon:0.7 .
# Run:    see docker-compose.yml + docs/deploy/container.md

# ── Stage 1: compile dist/ ───────────────────────────────────────────────────
# Only runs tsc, so --ignore-scripts skips the native-binding postinstall (no
# build toolchain needed here) and keeps this stage fast.
FROM node:25-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.build.json ./
COPY index.ts ./
COPY src/ ./src/
RUN npm ci --ignore-scripts && npm run build

# ── Stage 2: production dependencies ─────────────────────────────────────────
# python3/make/g++ are a safety net so the postinstall (ensure-native-binding.cjs)
# can rebuild better-sqlite3 from source if a prebuilt for this exact ABI is
# missing. They stay in this stage — only node_modules is copied onward.
FROM node:25-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm ci --omit=dev

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:25-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MEMEX_DB_PATH=/data/memex.sqlite \
    MEMEX_HTTP_HOST=0.0.0.0 \
    MEMEX_HTTP_PORT=8000
# Non-root user first, then COPY --chown sets ownership in a single pass (a
# post-hoc `chown -R` over node_modules took ~5min in practice).
RUN useradd --system --home-dir /app memex && mkdir -p /data && chown memex:memex /data
COPY --chown=memex:memex --from=deps /app/node_modules ./node_modules
COPY --chown=memex:memex --from=builder /app/dist ./dist
COPY --chown=memex:memex package.json ./
USER memex
VOLUME ["/data"]
EXPOSE 8000

# Liveness probe against the daemon's /health route (src/mcp-server.ts:573).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MEMEX_HTTP_PORT||8000)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/src/mcp-server.js"]
