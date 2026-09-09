/**
 * HTTP transport session lifecycle tests.
 *
 * Regression coverage for the 0.7.3 daemon leak: every Streamable HTTP
 * initialize created a transport + McpServer + SQLite handle that was never
 * reaped unless the client sent DELETE. Production symptom after 9d20h:
 * 186 sessions / 398 FDs / ~3.9GB RSS (a prior instance peaked at 26GB).
 *
 * These tests drive the real HTTP surface end-to-end: initialize handshake,
 * idle-TTL sweep, DELETE teardown, activity-refresh, and the hard session cap.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { createMemexMcpServer, startHttpServer, type MemexHttpServer } from "../src/mcp-server.js";

const VECTOR_DIM = 8;

function serverFactory(dbPath: string) {
  // Per-session factory: each call mirrors what the daemon does on initialize.
  return () => createMemexMcpServer({ dbPath, vectorDim: VECTOR_DIM, noDream: true });
}

const JSON_HEADERS = {
  "content-type": "application/json",
  "accept": "application/json, text/event-stream",
};

let rpcId = 0;

async function initSession(base: string): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "session-lifecycle-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(res.status, 200, `initialize failed: ${res.status}`);
  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize must return Mcp-Session-Id");
  // Complete the handshake so subsequent requests are accepted.
  const ready = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(ready.status, 202, `initialized notification failed: ${ready.status}`);
  return sessionId;
}

async function toolsList(base: string, sessionId: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }),
  });
}

async function health(base: string): Promise<{ sessions: number; sessionLimits: { idleTtlMs: number; maxSessions: number } }> {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  return res.json() as any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("HTTP MCP session lifecycle", () => {
  let tmpDir: string;
  let server: MemexHttpServer | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memex-http-sessions-"));
  });

  afterEach(async () => {
    if (server) {
      server.closeMcpSessions();
      server.close();
      server = undefined;
      await sleep(10); // let in-flight teardown logging settle
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function start(opts: { idleTtlMs?: number; sweepIntervalMs?: number; maxSessions?: number } = {}) {
    const dbPath = join(tmpDir, `memex-${crypto.randomUUID()}.sqlite`);
    server = await startHttpServer(serverFactory(dbPath), {
      port: 0,
      host: "127.0.0.1",
      authToken: "",
      ...opts,
    });
    const port = (server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  it("closes idle sessions via the TTL sweep", async () => {
    const base = await start({ idleTtlMs: 80, sweepIntervalMs: 20, maxSessions: 8 });
    await initSession(base);
    await initSession(base);
    await initSession(base);
    assert.equal((await health(base)).sessions, 3, "3 initialized sessions should be live");

    // TTL 80ms, sweep every 20ms — 400ms is a 5x margin.
    await sleep(400);
    const h = await health(base);
    assert.equal(h.sessions, 0, "all idle sessions must be swept");
    assert.equal(h.sessionLimits.idleTtlMs, 80);
    assert.equal(h.sessionLimits.maxSessions, 8);
    assert.equal(server!.mcpSessionCount(), 0);
  });

  it("DELETE closes and removes the session immediately", async () => {
    const base = await start({ idleTtlMs: 60_000, sweepIntervalMs: 60_000, maxSessions: 8 });
    const id = await initSession(base);
    assert.equal((await health(base)).sessions, 1);

    const res = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: { ...JSON_HEADERS, "mcp-session-id": id },
    });
    assert.ok([200, 202].includes(res.status), `DELETE returned ${res.status}`);
    assert.equal((await health(base)).sessions, 0, "DELETE must remove the session");
    assert.equal(server!.mcpSessionCount(), 0);

    const after = await toolsList(base, id);
    assert.equal(after.status, 400, "a removed session id must be rejected");
  });

  it("refreshes the idle clock on activity while abandoning idle peers", async () => {
    const base = await start({ idleTtlMs: 150, sweepIntervalMs: 30, maxSessions: 8 });
    const active = await initSession(base);
    const idle = await initSession(base);
    assert.equal((await health(base)).sessions, 2);

    // Keep `active` busy past the TTL; `idle` gets no traffic.
    const deadline = Date.now() + 450;
    while (Date.now() < deadline) {
      const res = await toolsList(base, active);
      assert.equal(res.status, 200);
      await res.text();
      await sleep(40);
    }

    assert.equal((await health(base)).sessions, 1, "only the active session survives");
    // The survivor must be the one we kept alive.
    const survivor = await toolsList(base, active);
    assert.equal(survivor.status, 200, "active session should still be routable");
    const dead = await toolsList(base, idle);
    assert.equal(dead.status, 400, "idle session should have been swept");
  });

  it("enforces the hard session cap with LRU eviction", async () => {
    const base = await start({ idleTtlMs: 60_000, sweepIntervalMs: 60_000, maxSessions: 2 });
    const s1 = await initSession(base);
    const s2 = await initSession(base);
    assert.equal((await health(base)).sessions, 2);

    const s3 = await initSession(base); // must evict s1 (least recently active)
    assert.equal((await health(base)).sessions, 2, "cap must hold at 2");

    assert.equal((await toolsList(base, s1)).status, 400, "oldest session must be evicted");
    assert.equal((await toolsList(base, s2)).status, 200, "recent session must survive");
    assert.equal((await toolsList(base, s3)).status, 200, "new session must be routable");
  });

  it("bounds JSON request bodies before parsing", async () => {
    const base = await start({ idleTtlMs: 60_000, sweepIntervalMs: 60_000, maxSessions: 8 });
    const oversized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: Buffer.alloc(8 * 1024 * 1024 + 1, "x"),
    });
    assert.equal(oversized.status, 413, "oversized bodies must be rejected before JSON parsing");
    assert.deepEqual(await oversized.json(), { error: "request body too large" });

    const malformed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not-json",
    });
    assert.equal(malformed.status, 400, "malformed JSON must be a client error");
    assert.deepEqual(await malformed.json(), { error: "invalid JSON body" });
  });

  it("closeMcpSessions tears down every live session", async () => {
    const base = await start({ idleTtlMs: 60_000, sweepIntervalMs: 60_000, maxSessions: 8 });
    await initSession(base);
    await initSession(base);
    assert.equal((await health(base)).sessions, 2);
    server!.closeMcpSessions();
    assert.equal(server!.mcpSessionCount(), 0);
  });
});
