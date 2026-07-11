/**
 * Graceful shutdown regression tests for the MCP server.
 *
 * Reproduces the orphaned-subprocess leak: a stdio MCP server kept its Node
 * event loop alive via the dreaming setInterval, so when the MCP client process
 * died the server was orphaned (reparented to PID 1) and kept running dreaming
 * cycles against the shared DB forever. With no SIGTERM handler and the timer
 * pinning the loop, nothing ever stopped it.
 *
 * Fix (src/mcp-server.ts): the server now shuts down on SIGTERM, SIGINT, and —
 * for stdio only — client disconnect (stdin EOF).
 *
 * These spawn the real subprocess because the defect lives at the process
 * lifecycle boundary (signals / stdio), which can't be expressed in-process.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "src", "mcp-server.ts");
// Generous: cold jiti compile + SQLite migrations on a fresh tmp DB can take
// several seconds under CI parallelism. The readiness signal is emitted only
// after full init, so allow plenty of headroom. The openclaw 2026.6.x dep tree
// adds import weight, pushing cold-start past 15s under full-suite parallel
// load (~6.5s in isolation). 30s keeps CI deterministic.
const STARTUP_TIMEOUT_MS = 30000;
const SHUTDOWN_TIMEOUT_MS = 3000;

interface Spawned {
  child: ReturnType<typeof spawn>;
  getStderr: () => string;
}

/** Spawn the server in stdio mode with dreaming ON (the default) so the setInterval is registered. */
async function spawnServer(dbPath: string): Promise<Spawned> {
  const child = spawn("node", ["--import", "jiti/register", SERVER, "--db", dbPath], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    // Ensure dreaming is enabled regardless of ambient env: the leak requires the
    // setInterval to be live. Empty string is falsy against the "1" check in main().
    env: { ...process.env, MEMEX_NO_DREAM: "" },
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

  // Wait for the "memex-mcp: ready" line — emitted only AFTER the transport is
  // connected and all signal handlers are armed, so we never observe a
  // half-initialized server. If readiness fails, kill the child so it is never
  // orphaned (the caller's `finally` runs after this await and would otherwise
  // be skipped on rejection, leaking the subprocess + its dreaming timers).
  try {
    await new Promise<void>((resolve, reject) => {
      const startup = setTimeout(
        () => reject(new Error(`server did not signal readiness within ${STARTUP_TIMEOUT_MS}ms\n--- stderr ---\n${stderr}`)),
        STARTUP_TIMEOUT_MS,
      );
      const onData = () => {
        if (stderr.includes("memex-mcp: ready")) {
          clearTimeout(startup);
          child.stderr.off("data", onData);
          resolve();
        }
      };
      child.stderr.on("data", onData);
    });
  } catch (err) {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    throw err;
  }

  return { child, getStderr: () => stderr };
}

function waitForExit(child: ReturnType<typeof spawn>, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    child.once("exit", (code) => { clearTimeout(t); resolve(code); });
  });
}

describe("MCP server graceful shutdown", () => {
  it("exits when the stdio client disconnects (stdin EOF) instead of orphaning", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "memex-shutdown-"));
    const { child, getStderr } = await spawnServer(join(tmp, "memex.sqlite"));
    try {
      if (!child.stdin) throw new Error("spawned child has no stdin pipe");
      child.stdin.end(); // simulate the MCP client process dying
      const code = await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
      assert.notEqual(
        code, null,
        `server did not exit within ${SHUTDOWN_TIMEOUT_MS}ms after stdin EOF (leak).\n--- stderr ---\n${getStderr()}`,
      );
      assert.equal(code, 0, `expected clean exit 0, got ${code}.\n--- stderr ---\n${getStderr()}`);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("exits cleanly (code 0) on SIGTERM, not the default force-kill 143", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "memex-sigterm-"));
    const { child, getStderr } = await spawnServer(join(tmp, "memex.sqlite"));
    try {
      child.kill("SIGTERM");
      const code = await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
      assert.equal(
        code, 0,
        `SIGTERM should trigger graceful exit 0, got ${code} (null = killed by signal = no handler ran).\n--- stderr ---\n${getStderr()}`,
      );
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
