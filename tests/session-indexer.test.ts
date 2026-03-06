/**
 * Tests for Session Indexer
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSessionFile, listSessions } from "../src/session-indexer.js";
import { createSessionScope, createScopeManager } from "../src/scopes.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createTempDir(): string {
  const dir = join(tmpdir(), `session-indexer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSessionLine(type: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...data });
}

function makeMessage(role: "user" | "assistant", text: string, id?: string): string {
  return makeSessionLine("message", {
    id: id || Math.random().toString(36).slice(2),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: [{ type: "text", text }],
    },
  });
}

function makeSessionHeader(sessionId: string): string {
  return makeSessionLine("session", {
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: "/tmp/test",
  });
}

function writeSessionFile(dir: string, sessionId: string, lines: string[]): string {
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// ============================================================================
// parseSessionFile Tests
// ============================================================================

describe("parseSessionFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it("parses user and assistant messages", () => {
    const path = writeSessionFile(tempDir, "test-session-1", [
      makeSessionHeader("test-session-1"),
      makeMessage("user", "What color theme do you prefer for the editor?"),
      makeMessage("assistant", "I suggest using a dark theme for reduced eye strain."),
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, "user");
    assert.equal(turns[0].text, "What color theme do you prefer for the editor?");
    assert.equal(turns[0].sessionId, "test-session-1");
    assert.equal(turns[1].role, "assistant");
  });

  it("skips automated sessions (cron)", () => {
    const path = writeSessionFile(tempDir, "cron-session", [
      makeSessionHeader("cron-session"),
      makeMessage("user", "[cron:abc123 workspace-sync] Sync workspace to git."),
      makeMessage("assistant", "Synced successfully."),
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 0, "Should skip entire session with automated content");
  });

  it("skips automated sessions (webhook/email)", () => {
    const path = writeSessionFile(tempDir, "webhook-session", [
      makeSessionHeader("webhook-session"),
      makeMessage("user", "Task: Gmail | Job ID: abc123\n\nSECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source"),
      makeMessage("assistant", "Processing email..."),
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 0);
  });

  it("skips heartbeat sessions", () => {
    const path = writeSessionFile(tempDir, "heartbeat-session", [
      makeSessionHeader("heartbeat-session"),
      makeMessage("user", "Read HEARTBEAT.md if it exists"),
      makeMessage("assistant", "HEARTBEAT_OK"),
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 0);
  });

  it("handles non-message entries gracefully", () => {
    const path = writeSessionFile(tempDir, "mixed-session", [
      makeSessionHeader("mixed-session"),
      makeSessionLine("model_change", { provider: "anthropic", modelId: "claude-opus-4-6" }),
      makeSessionLine("thinking_level_change", { thinkingLevel: "low" }),
      makeMessage("user", "Hello, let's discuss the project architecture"),
      makeMessage("assistant", "Sure, let me review the current structure."),
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 2, "Should only include message entries");
  });

  it("handles empty and malformed files", () => {
    const emptyPath = join(tempDir, "empty.jsonl");
    writeFileSync(emptyPath, "");
    assert.deepEqual(parseSessionFile(emptyPath), []);

    const malformedPath = join(tempDir, "malformed.jsonl");
    writeFileSync(malformedPath, "not json\n{bad json\n");
    assert.deepEqual(parseSessionFile(malformedPath), []);
  });

  it("handles missing files", () => {
    assert.deepEqual(parseSessionFile("/nonexistent/path.jsonl"), []);
  });

  it("extracts text from multi-part content", () => {
    const path = writeSessionFile(tempDir, "multipart", [
      makeSessionHeader("multipart"),
      JSON.stringify({
        type: "message",
        id: "abc",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First part. " },
            { type: "text", text: "Second part." },
          ],
        },
      }),
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "First part. \nSecond part.");
  });
});

// ============================================================================
// listSessions Tests
// ============================================================================

describe("listSessions", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it("lists session files with turn counts", () => {
    writeSessionFile(tempDir, "session-a", [
      makeSessionHeader("session-a"),
      makeMessage("user", "Hello there"),
      makeMessage("assistant", "Hi!"),
    ]);
    writeSessionFile(tempDir, "session-b", [
      makeSessionHeader("session-b"),
      makeMessage("user", "[cron:abc] sync"),
    ]);

    const sessions = listSessions(tempDir);
    assert.equal(sessions.length, 2);

    const humanSession = sessions.find(s => s.id === "session-a");
    assert.ok(humanSession);
    assert.equal(humanSession.turnCount, 2);
    assert.equal(humanSession.isAutomated, false);

    const autoSession = sessions.find(s => s.id === "session-b");
    assert.ok(autoSession);
    assert.equal(autoSession.turnCount, 0);
    assert.equal(autoSession.isAutomated, true);
  });

  it("returns empty for nonexistent directory", () => {
    assert.deepEqual(listSessions("/nonexistent/dir"), []);
  });

  it("skips deleted session files", () => {
    writeSessionFile(tempDir, "active", [
      makeSessionHeader("active"),
      makeMessage("user", "Active session"),
    ]);
    // Create a .deleted file
    writeFileSync(join(tempDir, "deleted.jsonl.deleted.2026-01-01"), "{}");

    const sessions = listSessions(tempDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "active");
  });
});

// ============================================================================
// Session Scope Tests
// ============================================================================

describe("session scope", () => {
  it("creates valid session scope strings", () => {
    const scope = createSessionScope("abc-123-def");
    assert.equal(scope, "session:abc-123-def");
  });

  it("session scope is recognized as built-in", () => {
    const manager = createScopeManager();
    assert.equal(manager.validateScope("session:test-id"), true);
  });

  it("session scope appears in stats", () => {
    const manager = createScopeManager({
      definitions: {
        "session:test-1": { description: "Test session" },
        "session:test-2": { description: "Test session 2" },
      },
    });
    const stats = manager.getStats();
    assert.equal(stats.scopesByType.session, 2);
  });
});
