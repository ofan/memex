/**
 * Tests for Session Indexer
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { parseSessionFile, listSessions, extractKnowledge, binPackSessions, estimateTokens, probeBackend, applyBackendCapabilities, type SessionTurn, type LLMExtractionConfig, type ParseOptions, type BackendCapabilities } from "../src/session-indexer.js";
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

function writeDeletedSessionFile(dir: string, sessionId: string, lines: string[], timestamp = "1709000000"): string {
  const path = join(dir, `${sessionId}.jsonl.deleted.${timestamp}`);
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
// parseSessionFile with skipAutomatedTurns Tests
// ============================================================================

describe("parseSessionFile with skipAutomatedTurns", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it("should drop entire session by default when automated content found", () => {
    const path = writeSessionFile(tempDir, "mixed-auto", [
      makeSessionHeader("mixed-auto"),
      makeMessage("user", "System: [notification] New alert received"),
      makeMessage("assistant", "Processing notification..."),
      makeMessage("user", "I prefer dark mode for all my editors and terminals"),
      makeMessage("assistant", "Noted, I'll use dark mode settings going forward."),
    ]);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 0, "Should drop entire session with automated content by default");
  });

  it("should skip only automated turns when skipAutomatedTurns is true", () => {
    const path = writeSessionFile(tempDir, "mixed-auto-skip", [
      makeSessionHeader("mixed-auto-skip"),
      makeMessage("user", "System: [notification] New alert received"),
      makeMessage("assistant", "Processing notification..."),
      makeMessage("user", "I prefer dark mode for all my editors and terminals"),
      makeMessage("assistant", "Noted, I'll use dark mode settings going forward."),
    ]);

    const turns = parseSessionFile(path, { skipAutomatedTurns: true });
    assert.equal(turns.length, 3, "Should keep non-automated turns (skip only the automated user turn)");
    assert.equal(turns[0].role, "assistant");
    assert.equal(turns[0].text, "Processing notification...");
    assert.equal(turns[1].role, "user");
    assert.equal(turns[1].text, "I prefer dark mode for all my editors and terminals");
    assert.equal(turns[2].role, "assistant");
    assert.equal(turns[2].text, "Noted, I'll use dark mode settings going forward.");
  });

  it("should return empty when ALL turns are automated with skipAutomatedTurns", () => {
    const path = writeSessionFile(tempDir, "all-auto", [
      makeSessionHeader("all-auto"),
      makeMessage("user", "[cron:abc123 workspace-sync] Sync workspace to git."),
      makeMessage("user", "System: [notification] Alert triggered"),
      makeMessage("user", "Read HEARTBEAT.md if it exists"),
    ]);

    const turns = parseSessionFile(path, { skipAutomatedTurns: true });
    assert.equal(turns.length, 0, "Should return empty when all turns are automated");
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

// ============================================================================
// LLM Extraction Tests
// ============================================================================

/** Create a mock OpenAI-compatible chat completions server */
function createMockLLMServer(handler: (body: any) => { content: string; status?: number }): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let parsed: any;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        const result = handler(parsed);
        res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: result.content } }],
        }));
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function makeTurns(texts: Array<{ role: "user" | "assistant"; text: string }>): SessionTurn[] {
  return texts.map((t, i) => ({
    sessionId: "test-session",
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
    role: t.role,
    text: t.text,
  }));
}

describe("extractKnowledge", () => {
  let server: Server;
  let port: number;

  afterEach(() => {
    if (server) server.close();
  });

  it("extracts curated summaries from conversation windows", async () => {
    ({ server, port } = await createMockLLMServer(() => {
      return { content: "Model preference: Use Opus for main agent, Sonnet for sub-agents." };
    }));

    const turns = makeTurns([
      { role: "user", text: "switch back to opus and sonnet for agents plz" },
      { role: "assistant", text: "Done — updated the model config to use Opus for main and Sonnet for sub-agents." },
      { role: "user", text: "perfect" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
    };

    const result = await extractKnowledge(turns, config);
    assert.equal(result.errors, 0);
    assert.equal(result.memories.length, 1);
    assert.ok(result.memories[0].includes("Opus"));
  });

  it("returns NONE for junk windows", async () => {
    ({ server, port } = await createMockLLMServer(() => ({
      content: "NONE",
    })));

    const turns = makeTurns([
      { role: "user", text: "ok sounds good" },
      { role: "assistant", text: "Great, let me know if you need anything else." },
      { role: "user", text: "thanks" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
    };

    const result = await extractKnowledge(turns, config);
    assert.equal(result.errors, 0);
    assert.equal(result.memories.length, 0);
  });

  it("handles multiple memories per window", async () => {
    ({ server, port } = await createMockLLMServer(() => ({
      content: "Decision: Use PostgreSQL for the main database due to JSONB support.\nPreference: User prefers dark mode for all editor themes.",
    })));

    const turns = makeTurns([
      { role: "user", text: "Let's go with postgres for the db, it has great JSONB support" },
      { role: "assistant", text: "Good choice. I'll configure PostgreSQL. Also, what about the editor theme?" },
      { role: "user", text: "dark mode always, for everything" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
    };

    const result = await extractKnowledge(turns, config);
    assert.equal(result.errors, 0);
    assert.equal(result.memories.length, 2);
    assert.ok(result.memories[0].includes("PostgreSQL"));
    assert.ok(result.memories[1].includes("dark mode"));
  });

  it("handles server errors gracefully", async () => {
    ({ server, port } = await createMockLLMServer(() => ({
      content: "",
      status: 500,
    })));

    const turns = makeTurns([
      { role: "user", text: "Let's use TypeScript for the new project with strict mode enabled" },
      { role: "assistant", text: "Sounds good, I'll set up tsconfig with strict: true" },
      { role: "user", text: "Also enable noUncheckedIndexedAccess if possible" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
    };

    const result = await extractKnowledge(turns, config);
    assert.ok(result.errors > 0);
    assert.equal(result.memories.length, 0);
  });

  it("handles timeout gracefully", async () => {
    ({ server, port } = await createMockLLMServer(() => {
      // This handler will never actually respond because we'll timeout first
      return { content: "should not reach", status: 200 };
    }));
    // Override the server to delay response
    server.close();
    server = createServer((req, res) => {
      // Don't respond — let the timeout fire
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
      }, 5000);
    });
    await new Promise<void>((resolve) => server.listen(port, resolve));

    const turns = makeTurns([
      { role: "user", text: "Some important fact about the project architecture and design decisions" },
      { role: "assistant", text: "Noted, I'll keep that in mind for future reference" },
      { role: "user", text: "Great, also remember the deployment config uses kubernetes" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
      timeout: 100, // 100ms timeout
    };

    const result = await extractKnowledge(turns, config);
    assert.ok(result.errors > 0, "Should have timeout errors");
    assert.equal(result.memories.length, 0);
  });

  it("should send one request per window", async () => {
    const requestBodies: any[] = [];
    ({ server, port } = await createMockLLMServer((body) => {
      requestBodies.push(body);
      return { content: "NONE" };
    }));

    // Two sessions — with high maxWindowTokens they should fit in one window
    const turns: SessionTurn[] = [
      { sessionId: "session-A", timestamp: "2025-01-01T00:00:00Z", role: "user", text: "Turn A1: Setting up the project with TypeScript" },
      { sessionId: "session-A", timestamp: "2025-01-01T00:01:00Z", role: "assistant", text: "Turn A2: I'll initialize the TypeScript configuration" },
      { sessionId: "session-B", timestamp: "2025-01-02T00:00:00Z", role: "user", text: "Turn B1: Add eslint with recommended rules" },
      { sessionId: "session-B", timestamp: "2025-01-02T00:01:00Z", role: "assistant", text: "Turn B2: ESLint configured with recommended preset" },
    ];

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
      maxWindowTokens: 190000, // large enough for all turns
    };

    await extractKnowledge(turns, config);
    assert.equal(requestBodies.length, 1, "All turns should fit in one window → one request");

    // Verify all turns are present in the single request
    const content = requestBodies[0].messages[1].content;
    assert.ok(content.includes("Turn A1"), "Window should contain session A turns");
    assert.ok(content.includes("Turn B1"), "Window should contain session B turns");
  });

  it("splits into multiple windows when maxWindowTokens is small", async () => {
    const requestBodies: any[] = [];
    ({ server, port } = await createMockLLMServer((body) => {
      requestBodies.push(body);
      return { content: "NONE" };
    }));

    // Two sessions with enough text that they exceed the 1000-token floor when combined.
    // With chars/2.7 estimation, each 700-char turn ≈ 262 tokens, so each session ≈ 528 tokens.
    // Two sessions ≈ 1056 tokens > 1000-token floor, forcing a split.
    const turns: SessionTurn[] = [
      { sessionId: "session-A", timestamp: "2025-01-01T00:00:00Z", role: "user", text: "A".repeat(700) },
      { sessionId: "session-A", timestamp: "2025-01-01T00:01:00Z", role: "assistant", text: "B".repeat(700) },
      { sessionId: "session-B", timestamp: "2025-01-02T00:00:00Z", role: "user", text: "C".repeat(700) },
      { sessionId: "session-B", timestamp: "2025-01-02T00:01:00Z", role: "assistant", text: "D".repeat(700) },
    ];

    // maxWindowTokens is small, but the floor clamp in extractKnowledge ensures
    // the effective window is at least 1000 tokens. Each session ≈ 528 tokens,
    // so two sessions exceed the limit and must be split.
    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
      maxWindowTokens: 110,
    };

    await extractKnowledge(turns, config);
    assert.equal(requestBodies.length, 2, "Should split into 2 windows when token limit is small");
  });

  it("should include cache_prompt when cachePrompt is true", async () => {
    let capturedBody: any = null;
    ({ server, port } = await createMockLLMServer((body) => {
      capturedBody = body;
      return { content: "NONE" };
    }));

    const turns = makeTurns([
      { role: "user", text: "Test message for verifying cache prompt inclusion in request" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
      cachePrompt: true,
    };

    await extractKnowledge(turns, config);
    assert.ok(capturedBody, "Should have sent a request");
    assert.equal(capturedBody.cache_prompt, true, "Should include cache_prompt: true when opt-in");
  });

  it("omits cache_prompt by default", async () => {
    let capturedBody: any = null;
    ({ server, port } = await createMockLLMServer((body) => {
      capturedBody = body;
      return { content: "NONE" };
    }));

    const turns = makeTurns([
      { role: "user", text: "Test message for verifying cache prompt exclusion from request" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
    };

    await extractKnowledge(turns, config);
    assert.ok(capturedBody, "Should have sent a request");
    assert.equal(capturedBody.cache_prompt, undefined, "Should not include cache_prompt by default");
  });

  it("filters short lines from LLM output", async () => {
    ({ server, port } = await createMockLLMServer(() => ({
      content: "Decision: Use bun for the test runner and package manager.\nOk\n\nYes",
    })));

    const turns = makeTurns([
      { role: "user", text: "Let's use bun instead of npm, it's much faster for our needs" },
      { role: "assistant", text: "Switching to bun as the test runner and package manager" },
      { role: "user", text: "Perfect, also update the CI scripts" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
    };

    const result = await extractKnowledge(turns, config);
    assert.equal(result.memories.length, 1, "Should filter out short lines like 'Ok' and 'Yes'");
    assert.ok(result.memories[0].includes("bun"));
  });

  it("sends correct request format", async () => {
    let capturedBody: any = null;
    let capturedHeaders: any = null;
    server = createServer((req, res) => {
      capturedHeaders = req.headers;
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "NONE" } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as any).port;

    const turns = makeTurns([
      { role: "user", text: "Test message for verifying request format" },
      { role: "assistant", text: "Response to test message about request format" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "my-model",
      apiKey: "test-key-123",
      maxTokens: 256,
    };

    await extractKnowledge(turns, config);

    assert.ok(capturedBody, "Should have sent a request");
    assert.equal(capturedBody.model, "my-model");
    assert.equal(capturedBody.temperature, 0.0);
    assert.equal(capturedBody.max_tokens, 256);
    assert.equal(capturedBody.messages.length, 2);
    assert.equal(capturedBody.messages[0].role, "system");
    assert.ok(capturedBody.messages[1].content.includes("[user]"));
    assert.equal(capturedHeaders?.authorization, "Bearer test-key-123");
  });

  it("omits Authorization header when no apiKey", async () => {
    let capturedHeaders: any = null;
    server = createServer((req, res) => {
      capturedHeaders = req.headers;
      let body = "";
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "NONE" } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as any).port;

    const turns = makeTurns([
      { role: "user", text: "Test message without api key authorization header" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "local-model",
    };

    await extractKnowledge(turns, config);
    assert.equal(capturedHeaders?.authorization, undefined, "Should not send Authorization header");
  });

  it("sends full turn text without truncation (bin-packed windows)", async () => {
    let capturedBody: any = null;
    ({ server, port } = await createMockLLMServer((body) => {
      capturedBody = body;
      return { content: "NONE" };
    }));

    const longText = "A".repeat(1000);
    const turns = makeTurns([
      { role: "user", text: longText },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
    };

    await extractKnowledge(turns, config);
    const userContent = capturedBody.messages[1].content;
    // Full text should be sent (no truncation in bin-packed mode)
    assert.ok(userContent.includes("A".repeat(1000)), "Should contain full text without truncation");
  });

  it("handles empty turns array", async () => {
    ({ server, port } = await createMockLLMServer(() => ({
      content: "Should not be called",
    })));

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
    };

    const result = await extractKnowledge([], config);
    assert.equal(result.errors, 0);
    assert.equal(result.memories.length, 0);
  });

  it("handles empty response content", async () => {
    ({ server, port } = await createMockLLMServer(() => ({
      content: "",
    })));

    const turns = makeTurns([
      { role: "user", text: "Some question about the project setup and configuration" },
      { role: "assistant", text: "Here is the answer to the project configuration question" },
    ]);

    const config: LLMExtractionConfig = {
      endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "test-model",
    };

    const result = await extractKnowledge(turns, config);
    assert.equal(result.errors, 0);
    assert.equal(result.memories.length, 0);
  });
});

// ============================================================================
// Cosine Similarity Tests
// ============================================================================

import { cosineSimilarity } from "../src/session-indexer.js";
import { scoreImportance, heuristicImportance } from "../src/importance.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 0.001);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 0.001);
  });

  it("returns high similarity for near-identical vectors", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1.01, 2.01, 3.01, 4.01, 5.01];
    assert.ok(cosineSimilarity(a, b) > 0.99);
  });

  it("handles zero vectors", () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  });
});

// ============================================================================
// End-to-End indexSessions with LLM Extraction Tests
// ============================================================================

import { indexSessions } from "../src/session-indexer.js";

describe("indexSessions with LLM extraction", () => {
  let tempDir: string;
  let llmServer: Server;
  let llmPort: number;

  afterEach(() => {
    if (llmServer) llmServer.close();
  });

  /** Minimal mock store that tracks bulkStore calls */
  function createMockStore(vectorSearchResults?: any[]) {
    const stored: any[] = [];
    return {
      stored,
      bulkStore: async (entries: any[]) => { stored.push(...entries); },
      vectorSearch: async () => vectorSearchResults || [],
      hasFtsSupport: false,
      dbPath: "/tmp/mock-db",
    } as any;
  }

  /** Minimal mock embedder that returns deterministic vectors */
  function createMockEmbedder() {
    let callCount = 0;
    return {
      embedBatchPassage: async (texts: string[]) => {
        return texts.map((t, i) => {
          callCount++;
          // Generate a simple deterministic vector from text hash
          const hash = [...t].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
          return Array.from({ length: 4 }, (_, d) => Math.sin(hash + d + callCount * 0.001));
        });
      },
      embedPassage: async (text: string) => {
        const hash = [...text].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
        return Array.from({ length: 4 }, (_, d) => Math.sin(hash + d));
      },
    } as any;
  }

  it("end-to-end: pipeline produces memories from LLM extraction", async () => {
    tempDir = createTempDir();

    // Create a session file with meaningful content
    writeSessionFile(tempDir, "e2e-session", [
      makeSessionHeader("e2e-session"),
      makeMessage("user", "We should use PostgreSQL for the main database because of its JSONB support and mature ecosystem"),
      makeMessage("assistant", "Good choice. PostgreSQL's JSONB is excellent for semi-structured data. I'll configure the connection pool with pg-pool."),
      makeMessage("user", "Also set the max pool size to 20 connections for production deployments"),
    ]);

    // Mock LLM that extracts one memory
    llmServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "Decision: Use PostgreSQL with pg-pool, max 20 connections for production." } }],
        }));
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, resolve));
    llmPort = (llmServer.address() as any).port;

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0, // Accept all for testing
      dryRun: false,
      llmExtraction: {
        endpoint: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
        model: "test-model",
      },
    });

    assert.ok(result.llmExtracted > 0, "Should have extracted memories");
    assert.equal(result.llmErrors, 0);
    assert.ok(result.indexedTurns > 0, "Should have indexed memories");
    assert.ok(store.stored.length > 0, "Should have stored memories in the store");
    assert.ok(store.stored[0].text.includes("PostgreSQL"), "Stored memory should contain extracted content");
  });

  it("end-to-end: pipeline unchanged when llmExtraction is undefined", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "no-llm-session", [
      makeSessionHeader("no-llm-session"),
      makeMessage("user", "The deployment configuration uses Kubernetes with Helm charts for all production services"),
      makeMessage("assistant", "I'll set up the Helm chart templates for the Kubernetes deployment configuration"),
    ]);

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: false,
      // No llmExtraction — pipeline should work as before
    });

    assert.equal(result.llmExtracted, 0);
    assert.equal(result.llmErrors, 0);
    assert.equal(result.llmDeduplicated, 0);
    assert.ok(result.indexedTurns > 0, "Should still index turns without LLM extraction");
    // Raw turns stored, not extracted summaries
    assert.ok(store.stored.some((e: any) => e.text.includes("Kubernetes")));
  });

  it("dedup removes near-identical extracted memories", async () => {
    tempDir = createTempDir();

    // Create two separate sessions so bin-packing puts them in different windows.
    // Each session must exceed ~500 tokens so both together exceed the 1000-token floor.
    // With chars/2.7, we need ~1350 chars per session (~675 chars per turn).
    const padA = " Additional context about the bun migration.".repeat(15);
    const padB = " More details about using bun for test runner.".repeat(15);
    writeSessionFile(tempDir, "dedup-session-a", [
      makeSessionHeader("dedup-session-a"),
      makeMessage("user", "We decided to use bun as the package manager for all projects." + padA),
      makeMessage("assistant", "Switching to bun for package management across all projects." + padA),
    ]);
    writeSessionFile(tempDir, "dedup-session-b", [
      makeSessionHeader("dedup-session-b"),
      makeMessage("user", "Yes, bun for everything including the test runner." + padB),
      makeMessage("assistant", "Confirmed: bun for package management and test running." + padB),
    ]);

    // LLM returns identical text for both windows (simulates duplicate extraction)
    llmServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "Tool preference: Use bun as package manager and test runner for all projects." } }],
        }));
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, resolve));
    llmPort = (llmServer.address() as any).port;

    // Mock embedder that returns identical vectors for identical text (triggering dedup)
    const mockEmbedder = {
      embedBatchPassage: async (texts: string[]) => {
        return texts.map(t => {
          const hash = [...t].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
          return Array.from({ length: 4 }, (_, d) => Math.sin(hash + d));
        });
      },
    } as any;

    const store = createMockStore();

    const result = await indexSessions(store, mockEmbedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: false,
      llmExtraction: {
        endpoint: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
        model: "test-model",
        maxWindowTokens: 50, // Tiny window to force each session into its own window
      },
    });

    // Two windows produce the same memory text → identical embeddings → dedup fires
    assert.ok(result.llmExtracted >= 2, `Should extract from multiple windows, got ${result.llmExtracted}`);
    assert.ok(result.llmDeduplicated > 0, `Should deduplicate identical memories, got ${result.llmDeduplicated}`);
    assert.equal(store.stored.length, 1, "Should store only 1 unique memory after dedup");
  });

  it("store-level dedup skips memories already in the store", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "store-dedup-session", [
      makeSessionHeader("store-dedup-session"),
      makeMessage("user", "We always use PostgreSQL for all database needs in production environments"),
      makeMessage("assistant", "Noted, PostgreSQL is the standard database for all production deployments"),
    ]);

    // Mock store where vectorSearch always returns a high-similarity hit
    const store = createMockStore([{ score: 0.97, entry: { id: "existing-1", text: "existing" } }]);
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: false,
    });

    assert.ok(result.skippedStoreDuplicates > 0, "Should skip store duplicates");
    assert.equal(store.stored.length, 0, "Should not store anything — all duplicates");
    assert.equal(result.indexedTurns, 0);
  });

  it("store-level dedup allows novel memories through", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "novel-session", [
      makeSessionHeader("novel-session"),
      makeMessage("user", "The new API endpoint should use rate limiting with a 100 requests per minute threshold"),
      makeMessage("assistant", "I will configure rate limiting at 100 req/min for the new API endpoint"),
    ]);

    // Mock store where vectorSearch returns low similarity (no duplicates)
    const store = createMockStore([{ score: 0.3, entry: { id: "unrelated", text: "unrelated" } }]);
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: false,
    });

    assert.equal(result.skippedStoreDuplicates, 0, "Should not skip — no duplicates");
    assert.ok(store.stored.length > 0, "Should store novel memories");
    assert.ok(result.indexedTurns > 0);
  });
});

// ============================================================================
// Reranker-based importance scoring
// ============================================================================

/** Create a mock reranker server that returns scores for documents */
function createMockRerankServer(handler: (body: any) => { results: Array<{ index: number; relevance_score: number }>; status?: number }): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let parsed: any;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        const result = handler(parsed);
        res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: result.results }));
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe("scoreImportance with reranker", () => {
  let server: Server;
  let port: number;

  afterEach(() => {
    if (server) server.close();
  });

  it("uses reranker scores when endpoint is available", async () => {
    let capturedBody: any;
    const mockResults = [
      { index: 0, relevance_score: 3.5 },  // sigmoid(3.5) ≈ 0.97
      { index: 1, relevance_score: -5.0 },  // sigmoid(-5) ≈ 0.007
      { index: 2, relevance_score: 0.0 },   // sigmoid(0) = 0.5
    ];
    ({ server, port } = await createMockRerankServer((body) => {
      capturedBody = body;
      return { results: mockResults };
    }));

    const texts = [
      "User prefers dark mode for all editors and terminals",
      "ok sounds good",
      "The project uses TypeScript with strict mode enabled",
    ];

    const scores = await scoreImportance(texts, `http://127.0.0.1:${port}/rerank`, "test-reranker");

    assert.equal(scores.length, 3);
    // High relevance → high sigmoid score
    assert.ok(scores[0] > 0.9, `Expected high score for important text, got ${scores[0]}`);
    // Low relevance → low sigmoid score
    assert.ok(scores[1] < 0.1, `Expected low score for noise, got ${scores[1]}`);
    // Zero logit → 0.5
    assert.ok(Math.abs(scores[2] - 0.5) < 0.01, `Expected ~0.5 for zero logit, got ${scores[2]}`);

    // Verify request format
    assert.ok(capturedBody.query, "Should send a query (importance reference)");
    assert.equal(capturedBody.documents.length, 3);
    assert.equal(capturedBody.model, "test-reranker");
  });

  it("falls back to default score when reranker returns non-ok status", async () => {
    ({ server, port } = await createMockRerankServer(() => ({
      results: [],
      status: 500,
    })));

    const texts = [
      "I prefer using vim keybindings in all editors",
      "ok",
    ];

    const scores = await scoreImportance(texts, `http://127.0.0.1:${port}/rerank`, "test-reranker");

    assert.equal(scores.length, 2);
    // Non-ok response triggers `continue`, leaving the 0.3 default fill
    assert.equal(scores[0], 0.3);
    assert.equal(scores[1], 0.3);
  });

  it("falls back to heuristic when endpoint is unreachable (catch path)", async () => {
    const texts = ["We decided to use PostgreSQL for all database needs"];
    const scores = await scoreImportance(texts, "http://127.0.0.1:1/rerank", "test-reranker");

    assert.equal(scores.length, 1);
    // Network error triggers catch → heuristicImportance fallback
    assert.equal(scores[0], heuristicImportance(texts[0]));
  });

  it("handles batching for large input", async () => {
    let requestCount = 0;
    ({ server, port } = await createMockRerankServer((body) => {
      requestCount++;
      const results = body.documents.map((_: any, i: number) => ({
        index: i,
        relevance_score: 1.0,
      }));
      return { results };
    }));

    // 25 texts → 2 batches (batch size is 20)
    const texts = Array.from({ length: 25 }, (_, i) => `Important fact number ${i} about the project architecture`);
    const scores = await scoreImportance(texts, `http://127.0.0.1:${port}/rerank`, "test-reranker");

    assert.equal(scores.length, 25);
    assert.equal(requestCount, 2, "Should send 2 batches for 25 texts");
    // All scores should be sigmoid(1.0) ≈ 0.73
    for (const score of scores) {
      assert.ok(score > 0.7 && score < 0.8, `Expected sigmoid(1.0) ≈ 0.73, got ${score}`);
    }
  });
});

// ============================================================================
// Incremental import — alreadyImported filtering
// ============================================================================

describe("indexSessions incremental import", () => {
  let tempDir: string;

  /** Minimal mock store */
  function createMockStore() {
    const stored: any[] = [];
    return {
      stored,
      bulkStore: async (entries: any[]) => { stored.push(...entries); },
      vectorSearch: async () => [],
    } as any;
  }

  /** Minimal mock embedder */
  function createMockEmbedder() {
    return {
      embedBatchPassage: async (texts: string[]) =>
        texts.map(() => [0.1, 0.2, 0.3, 0.4]),
    } as any;
  }

  it("skips sessions in alreadyImported set", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "session-old", [
      makeSessionHeader("session-old"),
      makeMessage("user", "We decided to use PostgreSQL for the database backend in production"),
      makeMessage("assistant", "Good choice, PostgreSQL has excellent JSONB support for our use case"),
    ]);
    writeSessionFile(tempDir, "session-new", [
      makeSessionHeader("session-new"),
      makeMessage("user", "The API rate limit should be set to 200 requests per minute for external clients"),
      makeMessage("assistant", "I will configure the rate limiter to 200 req/min for external API access"),
    ]);

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      alreadyImported: new Set(["session-old"]),
    });

    assert.equal(result.skippedAlreadyImported, 1, "Should skip 1 already-imported session");
    assert.equal(result.totalSessions, 2);
    // Only session-new turns should be stored
    assert.ok(store.stored.length > 0, "Should store turns from new session");
    assert.ok(store.stored.every((e: any) => !e.text.includes("PostgreSQL")),
      "Should not contain turns from skipped session");
  });

  it("processes all sessions when alreadyImported is empty (fresh)", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "session-1", [
      makeSessionHeader("session-1"),
      makeMessage("user", "Always use bun as the package manager for JavaScript projects going forward"),
      makeMessage("assistant", "Noted, switching to bun for package management across all JS projects"),
    ]);
    writeSessionFile(tempDir, "session-2", [
      makeSessionHeader("session-2"),
      makeMessage("user", "The inference server runs on port 8090 via Tailscale for all deployments"),
      makeMessage("assistant", "Confirmed, port 8090 is the standard for inference server access"),
    ]);

    const store = createMockStore();
    const embedder = createMockEmbedder();

    // Empty alreadyImported = fresh import (all sessions processed)
    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      alreadyImported: new Set(),
    });

    assert.equal(result.skippedAlreadyImported, 0, "Should not skip any sessions");
    assert.equal(result.totalSessions, 2);
    assert.ok(store.stored.length >= 2, "Should store turns from both sessions");
  });

  it("second import skips previously imported session", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "session-a", [
      makeSessionHeader("session-a"),
      makeMessage("user", "We prefer using dark mode for all terminal and editor configurations"),
      makeMessage("assistant", "Dark mode enabled across all tools and editor themes"),
    ]);
    writeSessionFile(tempDir, "session-b", [
      makeSessionHeader("session-b"),
      makeMessage("user", "The deployment pipeline uses Kubernetes with Helm charts for orchestration"),
      makeMessage("assistant", "Kubernetes with Helm is configured for all production deployments"),
    ]);

    const store = createMockStore();
    const embedder = createMockEmbedder();

    // First import: both sessions
    const result1 = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      alreadyImported: new Set(),
    });
    assert.equal(result1.skippedAlreadyImported, 0);
    const firstCount = store.stored.length;

    // Second import: session-a already imported
    const result2 = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      alreadyImported: new Set(["session-a"]),
    });

    assert.equal(result2.skippedAlreadyImported, 1, "Should skip session-a");
    // Should only have added session-b's turns
    const newEntries = store.stored.length - firstCount;
    assert.ok(newEntries > 0, "Should add new entries from session-b");
    assert.ok(newEntries < firstCount, "Should add fewer entries than first full import");
  });
});

// ============================================================================
// Dry run — stores nothing
// ============================================================================

describe("indexSessions dry run", () => {
  it("reports indexable turns but stores nothing", async () => {
    const tempDir = createTempDir();

    writeSessionFile(tempDir, "dry-run-session", [
      makeSessionHeader("dry-run-session"),
      makeMessage("user", "We always use TypeScript strict mode with noUncheckedIndexedAccess enabled"),
      makeMessage("assistant", "TypeScript strict mode with noUncheckedIndexedAccess is now the standard config"),
      makeMessage("user", "Also remember that our preferred test runner is node:test, not jest or vitest"),
      makeMessage("assistant", "Noted, node:test is the standard test runner for all projects"),
    ]);

    const stored: any[] = [];
    const store = {
      stored,
      bulkStore: async (entries: any[]) => { stored.push(...entries); },
      vectorSearch: async () => [],
    } as any;

    const embedder = {
      embedBatchPassage: async (texts: string[]) =>
        texts.map(() => [0.1, 0.2, 0.3, 0.4]),
    } as any;

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: true,
    });

    assert.ok(result.indexedTurns > 0, `Should report indexable turns, got ${result.indexedTurns}`);
    assert.equal(stored.length, 0, "Should NOT store anything in dry run mode");
    assert.deepEqual(result.errors, []);
  });

  it("dry run still filters noise and low-importance turns", async () => {
    const tempDir = createTempDir();

    writeSessionFile(tempDir, "dry-filter-session", [
      makeSessionHeader("dry-filter-session"),
      makeMessage("user", "ok"),  // too short, will be filtered
      makeMessage("assistant", "The architecture uses a 7-stage scoring pipeline for memory retrieval"),
      makeMessage("user", "yes"),  // too short
    ]);

    const store = {
      bulkStore: async () => {},
      vectorSearch: async () => [],
    } as any;

    const embedder = {
      embedBatchPassage: async (texts: string[]) =>
        texts.map(() => [0.1, 0.2, 0.3, 0.4]),
    } as any;

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: true,
    });

    assert.ok(result.skippedNoise > 0, "Should still filter noise in dry run");
    assert.ok(result.totalTurns > result.indexedTurns, "Some turns should be filtered");
  });
});

// ============================================================================
// Include Deleted Session Files
// ============================================================================

describe("parseSessionFile with deleted files", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it("parses .jsonl.deleted.TIMESTAMP files and extracts correct session ID", () => {
    const path = writeDeletedSessionFile(tempDir, "old-session", [
      makeSessionHeader("old-session"),
      makeMessage("user", "We decided to use Redis for the caching layer in production"),
      makeMessage("assistant", "Redis is configured as the production cache backend"),
    ], "1709000000");

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].sessionId, "old-session");
    assert.equal(turns[0].role, "user");
    assert.equal(turns[1].sessionId, "old-session");
  });

  it("handles session IDs with hyphens and numbers in deleted files", () => {
    const path = writeDeletedSessionFile(tempDir, "abc-123-def-456", [
      makeSessionHeader("abc-123-def-456"),
      makeMessage("user", "Testing session ID extraction from deleted file names"),
    ], "1709123456");

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].sessionId, "abc-123-def-456");
  });
});

describe("indexSessions includeDeleted", () => {
  let tempDir: string;

  function createMockStore() {
    const stored: any[] = [];
    return {
      stored,
      bulkStore: async (entries: any[]) => { stored.push(...entries); },
      vectorSearch: async () => [],
    } as any;
  }

  function createMockEmbedder() {
    return {
      embedBatchPassage: async (texts: string[]) =>
        texts.map(() => [0.1, 0.2, 0.3, 0.4]),
    } as any;
  }

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it("skips .deleted files by default", async () => {
    writeSessionFile(tempDir, "active-session", [
      makeSessionHeader("active-session"),
      makeMessage("user", "The production database uses PostgreSQL with connection pooling enabled"),
      makeMessage("assistant", "PostgreSQL connection pooling is configured for production"),
    ]);
    writeDeletedSessionFile(tempDir, "rotated-session", [
      makeSessionHeader("rotated-session"),
      makeMessage("user", "We always deploy with blue-green strategy for zero-downtime releases"),
      makeMessage("assistant", "Blue-green deployment is the standard release strategy"),
    ], "1709000000");

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: true,
    });

    assert.equal(result.totalSessions, 1, "Should only find the active session file");
  });

  it("includes .deleted files when includeDeleted is true", async () => {
    writeSessionFile(tempDir, "active-session", [
      makeSessionHeader("active-session"),
      makeMessage("user", "The production database uses PostgreSQL with connection pooling enabled"),
      makeMessage("assistant", "PostgreSQL connection pooling is configured for production"),
    ]);
    writeDeletedSessionFile(tempDir, "rotated-session", [
      makeSessionHeader("rotated-session"),
      makeMessage("user", "We always deploy with blue-green strategy for zero-downtime releases"),
      makeMessage("assistant", "Blue-green deployment is the standard release strategy"),
    ], "1709000000");

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: true,
      includeDeleted: true,
    });

    assert.equal(result.totalSessions, 2, "Should find both active and deleted session files");
    assert.ok(result.totalTurns >= 4, "Should have turns from both sessions");
  });

  it("stores memories from deleted files with correct session ID", async () => {
    writeDeletedSessionFile(tempDir, "old-conv", [
      makeSessionHeader("old-conv"),
      makeMessage("user", "The monitoring stack uses Prometheus and Grafana for all infrastructure metrics"),
      makeMessage("assistant", "Prometheus and Grafana are configured for infrastructure monitoring"),
    ], "1709555555");

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      includeDeleted: true,
    });

    assert.ok(result.indexedTurns > 0, "Should index turns from deleted file");
    // Verify the stored entries have global scope and correct session ID in metadata
    assert.ok(store.stored.length > 0, "Should have stored memories");
    for (const entry of store.stored) {
      assert.equal(entry.scope, "global", "Scope should be global");
      const meta = JSON.parse(entry.metadata);
      assert.equal(meta.sessionId, "old-conv", `metadata.sessionId should be 'old-conv', got: ${meta.sessionId}`);
      assert.ok(!meta.sessionKey.includes(".deleted"), "sessionKey should not contain .deleted suffix");
    }
  });

  it("alreadyImported works correctly with deleted file session IDs", async () => {
    writeDeletedSessionFile(tempDir, "imported-session", [
      makeSessionHeader("imported-session"),
      makeMessage("user", "The CI pipeline runs all tests before deployment to staging environment"),
      makeMessage("assistant", "CI tests are mandatory before staging deployment"),
    ], "1709000000");
    writeDeletedSessionFile(tempDir, "new-session", [
      makeSessionHeader("new-session"),
      makeMessage("user", "All API endpoints require authentication via JWT tokens for security"),
      makeMessage("assistant", "JWT authentication is enforced on all API endpoints"),
    ], "1709111111");

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      includeDeleted: true,
      alreadyImported: new Set(["imported-session"]),
    });

    assert.equal(result.skippedAlreadyImported, 1, "Should skip the already-imported deleted session");
    assert.equal(result.totalSessions, 2, "Should count both files");
  });
});

describe("listSessions with includeDeleted", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it("excludes deleted files by default", () => {
    writeSessionFile(tempDir, "active", [
      makeSessionHeader("active"),
      makeMessage("user", "Active session content here"),
    ]);
    writeDeletedSessionFile(tempDir, "rotated", [
      makeSessionHeader("rotated"),
      makeMessage("user", "Rotated session content here"),
    ], "1709000000");

    const sessions = listSessions(tempDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "active");
  });

  it("includes deleted files when includeDeleted is true", () => {
    writeSessionFile(tempDir, "active", [
      makeSessionHeader("active"),
      makeMessage("user", "Active session content here"),
    ]);
    writeDeletedSessionFile(tempDir, "rotated", [
      makeSessionHeader("rotated"),
      makeMessage("user", "Rotated session content here"),
    ], "1709000000");

    const sessions = listSessions(tempDir, { includeDeleted: true });
    assert.equal(sessions.length, 2);
    const ids = sessions.map(s => s.id).sort();
    assert.deepEqual(ids, ["active", "rotated"]);
  });
});

// ============================================================================
// Bin-Packing Tests
// ============================================================================

describe("binPackSessions", () => {
  function makeTurn(sessionId: string, text: string): SessionTurn {
    return {
      sessionId,
      timestamp: new Date().toISOString(),
      role: "user",
      text,
    };
  }

  function makeSession(sessionId: string, turnCount: number, charsPerTurn: number): SessionTurn[] {
    const turns: SessionTurn[] = [];
    for (let i = 0; i < turnCount; i++) {
      turns.push(makeTurn(sessionId, "x".repeat(charsPerTurn)));
    }
    return turns;
  }

  it("should pack small sessions into one window", () => {
    // Two small sessions that easily fit in one window
    const session1 = makeSession("s1", 2, 100); // ~50 tokens per turn
    const session2 = makeSession("s2", 2, 100);
    const maxTokens = 10000;

    const windows = binPackSessions([session1, session2], maxTokens);

    assert.equal(windows.length, 1);
    assert.equal(windows[0].length, 4); // all 4 turns in one window
  });

  it("should split sessions across windows when they exceed limit", () => {
    // 10 sessions, each ~100 tokens, with a 250-token window
    // Each turn: "[user] " (7) + 400 chars + "\n" (1) = 408 chars => ~102 tokens
    const sessions: SessionTurn[][] = [];
    for (let i = 0; i < 10; i++) {
      sessions.push(makeSession(`s${i}`, 1, 400));
    }
    const maxTokens = 250;

    const windows = binPackSessions(sessions, maxTokens);

    // Should create multiple windows
    assert.ok(windows.length > 1, `Expected multiple windows, got ${windows.length}`);

    // Verify no session is split: each turn's sessionId should appear fully in one window
    const totalTurns = windows.reduce((sum, w) => sum + w.length, 0);
    assert.equal(totalTurns, 10, "All turns should be present");

    // Verify sessions are not split across windows — each session ID appears in exactly one window
    for (let i = 0; i < 10; i++) {
      const sid = `s${i}`;
      const windowsContaining = windows.filter(w => w.some(t => t.sessionId === sid));
      assert.equal(windowsContaining.length, 1, `Session ${sid} should appear in exactly one window`);
    }
  });

  it("should split a single session larger than the window limit", () => {
    // One session with many turns, window limit smaller than total
    const bigSession = makeSession("big", 5, 400); // 5 turns, each ~150 tokens at chars/2.7
    const maxTokens = 200;

    const windows = binPackSessions([bigSession], maxTokens);

    // Oversized sessions get split by turns into multiple windows
    assert.ok(windows.length > 1, `Expected multiple windows for oversized session, got ${windows.length}`);
    const totalTurns = windows.reduce((sum, w) => sum + w.length, 0);
    assert.equal(totalTurns, 5, "All turns should be present");
  });

  it("should handle empty sessions array", () => {
    const windows = binPackSessions([], 10000);
    assert.deepEqual(windows, []);
  });
});

describe("estimateTokens", () => {
  it("should estimate tokens as ceil(chars / 2.7)", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
    assert.equal(estimateTokens("abc"), 2); // ceil(3/2.7) = 2
    assert.equal(estimateTokens("x".repeat(100)), 38); // ceil(100/2.7) = 38
  });
});

describe("probeBackend", () => {
  let server: Server;
  let port: number;

  afterEach(() => {
    server?.close();
  });

  function createProbeServer(modelsResponse: any, propsResponse?: any): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        if (req.url === "/v1/models" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(modelsResponse));
        } else if (req.url === "/props" && req.method === "GET" && propsResponse) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(propsResponse));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address() as any;
        resolve({ server: s, port: addr.port });
      });
    });
  }

  it("detects llamacpp backend and enables cache_prompt", async () => {
    ({ server, port } = await createProbeServer({
      data: [{ id: "Qwen3.5-4B-Q8_0", owned_by: "llamacpp" }],
    }));
    const caps = await probeBackend(`http://127.0.0.1:${port}/v1`, "Qwen3.5-4B-Q8_0");
    assert.equal(caps.backend, "llamacpp");
    assert.equal(caps.cachePrompt, true);
    assert.equal(caps.timeout, 120000);
  });

  it("detects google backend and disables cache_prompt", async () => {
    ({ server, port } = await createProbeServer({
      data: [{ id: "models/gemini-2.5-flash", owned_by: "google" }],
    }));
    const caps = await probeBackend(`http://127.0.0.1:${port}/v1`, "gemini-2.5-flash");
    assert.equal(caps.backend, "google");
    assert.equal(caps.cachePrompt, false);
    assert.equal(caps.contextWindow, 1048576);
  });

  it("detects openai backend", async () => {
    ({ server, port } = await createProbeServer({
      data: [{ id: "gpt-4o", owned_by: "openai" }],
    }));
    const caps = await probeBackend(`http://127.0.0.1:${port}/v1`, "gpt-4o");
    assert.equal(caps.backend, "openai");
    assert.equal(caps.cachePrompt, false);
    assert.equal(caps.contextWindow, 128000);
  });

  it("reads n_ctx from llamacpp /props endpoint", async () => {
    ({ server, port } = await createProbeServer(
      { data: [{ id: "model", owned_by: "llamacpp" }] },
      { default_generation_settings: { n_ctx: 32768 } },
    ));
    const caps = await probeBackend(`http://127.0.0.1:${port}/v1`, "model");
    assert.equal(caps.contextWindow, 32768);
  });

  it("reads n_ctx_train from model meta", async () => {
    ({ server, port } = await createProbeServer({
      data: [{ id: "model", owned_by: "llamacpp", meta: { n_ctx_train: 65536 } }],
    }));
    const caps = await probeBackend(`http://127.0.0.1:${port}/v1`, "model");
    // /props not available, so uses n_ctx_train from model meta
    assert.equal(caps.contextWindow, 65536);
  });

  it("returns safe defaults when probe fails", async () => {
    const caps = await probeBackend("http://127.0.0.1:1", "no-such-model");
    assert.equal(caps.backend, "unknown");
    assert.equal(caps.cachePrompt, false);
    assert.equal(caps.contextWindow, null);
    assert.equal(caps.timeout, 120000);
  });
});

describe("applyBackendCapabilities", () => {
  it("applies detected values without overriding explicit config", () => {
    const config: LLMExtractionConfig = {
      endpoint: "http://localhost/v1/chat/completions",
      model: "test",
      cachePrompt: false, // explicit override
      timeout: 60000, // explicit override
    };
    const caps: BackendCapabilities = {
      backend: "llamacpp",
      cachePrompt: true,
      contextWindow: 32768,
      timeout: 300000,
    };
    const result = applyBackendCapabilities(config, caps);
    assert.equal(result.cachePrompt, false, "Should keep explicit cachePrompt");
    assert.equal(result.timeout, 60000, "Should keep explicit timeout");
    assert.equal(result.maxWindowTokens, Math.min(Math.floor(32768 * 0.95), 200000), "Should set maxWindowTokens from context");
  });

  it("uses detected values when config has no overrides", () => {
    const config: LLMExtractionConfig = {
      endpoint: "http://localhost/v1/chat/completions",
      model: "test",
    };
    const caps: BackendCapabilities = {
      backend: "google",
      cachePrompt: false,
      contextWindow: 1048576,
      timeout: 120000,
    };
    const result = applyBackendCapabilities(config, caps);
    assert.equal(result.cachePrompt, false);
    assert.equal(result.timeout, 120000);
    assert.equal(result.maxWindowTokens, Math.min(Math.floor(1048576 * 0.95), 200000));
  });

  it("leaves maxWindowTokens undefined when context unknown", () => {
    const config: LLMExtractionConfig = {
      endpoint: "http://localhost/v1/chat/completions",
      model: "test",
    };
    const caps: BackendCapabilities = {
      backend: "unknown",
      cachePrompt: false,
      contextWindow: null,
      timeout: 120000,
    };
    const result = applyBackendCapabilities(config, caps);
    assert.equal(result.maxWindowTokens, undefined);
  });
});

describe("indexSessions global scope and metadata provenance", () => {
  let tempDir: string;

  /** Minimal mock store that tracks bulkStore calls */
  function createMockStore(vectorSearchResults?: any[]) {
    const stored: any[] = [];
    return {
      stored,
      bulkStore: async (entries: any[]) => { stored.push(...entries); },
      vectorSearch: async () => vectorSearchResults || [],
      hasFtsSupport: false,
      dbPath: "/tmp/mock-db",
    } as any;
  }

  /** Minimal mock embedder that returns deterministic vectors */
  function createMockEmbedder() {
    let callCount = 0;
    return {
      embedBatchPassage: async (texts: string[]) => {
        return texts.map((t, i) => {
          callCount++;
          const hash = [...t].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
          return Array.from({ length: 4 }, (_, d) => Math.sin(hash + d + callCount * 0.001));
        });
      },
      embedPassage: async (text: string) => {
        const hash = [...text].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
        return Array.from({ length: 4 }, (_, d) => Math.sin(hash + d));
      },
    } as any;
  }

  it("should store memories with scope global", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "global-scope-session", [
      makeSessionHeader("global-scope-session"),
      makeMessage("user", "We use TypeScript strict mode for all backend services in the monorepo"),
      makeMessage("assistant", "Understood, TypeScript strict mode is enforced across all backend services"),
    ]);

    const store = createMockStore();
    const embedder = createMockEmbedder();

    await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: false,
    });

    assert.ok(store.stored.length > 0, "Should have stored memories");
    for (const entry of store.stored) {
      assert.equal(entry.scope, "global", `Expected scope "global" but got "${entry.scope}"`);
    }
  });

  it("should include sessionKey and agentId in metadata", async () => {
    tempDir = createTempDir();

    const sessionId = "test-agent-session";
    const sessionKey = "agent:main:discord:channel:123";

    // Write sessions.json registry
    const registry: Record<string, any> = {};
    registry[sessionKey] = { sessionId };
    writeFileSync(join(tempDir, "sessions.json"), JSON.stringify(registry));

    writeSessionFile(tempDir, sessionId, [
      makeSessionHeader(sessionId),
      makeMessage("user", "Deploy the Redis cache cluster with three replicas for high availability"),
      makeMessage("assistant", "Setting up Redis cluster with three replicas for HA configuration"),
    ]);

    const store = createMockStore();
    const embedder = createMockEmbedder();

    await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: false,
    });

    assert.ok(store.stored.length > 0, "Should have stored memories");
    for (const entry of store.stored) {
      const meta = JSON.parse(entry.metadata);
      assert.equal(meta.sessionKey, sessionKey, "metadata should include sessionKey");
      assert.equal(meta.agentId, "main", "metadata should include agentId extracted from sessionKey");
      assert.equal(meta.sessionId, sessionId, "metadata should include sessionId");
    }
  });

  it("should use session-import as source in metadata", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "source-test-session", [
      makeSessionHeader("source-test-session"),
      makeMessage("user", "The logging framework should use structured JSON output for all microservices"),
      makeMessage("assistant", "Configuring structured JSON logging across all microservices"),
    ]);

    const store = createMockStore();
    const embedder = createMockEmbedder();

    await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: false,
    });

    assert.ok(store.stored.length > 0, "Should have stored memories");
    for (const entry of store.stored) {
      const meta = JSON.parse(entry.metadata);
      assert.equal(meta.source, "session-import", `Expected source "session-import" but got "${meta.source}"`);
    }
  });

  it("should omit agentId when sessionKey has no agent prefix", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "no-agent-session", [
      makeSessionHeader("no-agent-session"),
      makeMessage("user", "Configure the build pipeline to use parallel compilation for faster builds"),
      makeMessage("assistant", "Enabling parallel compilation in the build pipeline configuration"),
    ]);

    const store = createMockStore();
    const embedder = createMockEmbedder();

    await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      dryRun: false,
    });

    assert.ok(store.stored.length > 0, "Should have stored memories");
    for (const entry of store.stored) {
      const meta = JSON.parse(entry.metadata);
      assert.equal(meta.agentId, undefined, "agentId should be omitted when sessionKey has no agent prefix");
      // sessionKey falls back to sessionId when no registry entry
      assert.equal(meta.sessionKey, "no-agent-session");
    }
  });
});

// ============================================================================
// Full Pipeline Integration Tests
// ============================================================================

describe("indexSessions full pipeline integration", () => {
  let tempDir: string;

  /** Minimal mock store that tracks bulkStore calls */
  function createMockStore(vectorSearchResults?: any[]) {
    const stored: any[] = [];
    return {
      stored,
      bulkStore: async (entries: any[]) => { stored.push(...entries); },
      vectorSearch: async () => vectorSearchResults || [],
      hasFtsSupport: false,
      dbPath: "/tmp/mock-db",
    } as any;
  }

  /** Minimal mock embedder that returns deterministic vectors */
  function createMockEmbedder() {
    let callCount = 0;
    return {
      embedBatchPassage: async (texts: string[]) => {
        return texts.map((t, i) => {
          callCount++;
          const hash = [...t].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
          return Array.from({ length: 4 }, (_, d) => Math.sin(hash + d + callCount * 0.001));
        });
      },
    } as any;
  }

  it("should import sessions with includeDeleted and global scope", async () => {
    tempDir = createTempDir();

    // Write sessions.json registry
    writeFileSync(join(tempDir, "sessions.json"), JSON.stringify({
      "agent:main:discord:general": { sessionId: "active-sess" },
      "agent:main:discord:dev": { sessionId: "deleted-sess" },
    }));

    // Write active session
    writeSessionFile(tempDir, "active-sess", [
      makeSessionHeader("active-sess"),
      makeMessage("user", "I prefer using Vim keybindings in every editor I use"),
      makeMessage("assistant", "Vim keybindings preference noted across all editors."),
    ]);

    // Write deleted/rotated session
    // NOTE: use writeFileSync directly for .deleted files
    writeFileSync(
      join(tempDir, "deleted-sess.jsonl.deleted.1709654321"),
      [
        makeSessionHeader("deleted-sess"),
        makeMessage("user", "Always use dark theme for terminal and code editors"),
        makeMessage("assistant", "Dark theme preference saved for all environments."),
      ].join("\n"),
    );

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      targetScope: "global",
      minImportance: 0.0,
      includeDeleted: true,
    });

    assert.equal(result.totalSessions, 2, "should find both sessions");
    assert.ok(store.stored.length >= 2, "should store memories from both sessions");

    // Verify global scope
    for (const entry of store.stored) {
      assert.equal(entry.scope, "global");
    }

    // Verify metadata provenance
    const metas = store.stored.map((e: any) => JSON.parse(e.metadata));
    assert.ok(metas.some((m: any) => m.sessionKey === "agent:main:discord:general"));
    assert.ok(metas.some((m: any) => m.sessionKey === "agent:main:discord:dev"));
    assert.ok(metas.every((m: any) => m.source === "session-import"));
  });

  it("should do incremental import skipping already-imported sessions", async () => {
    tempDir = createTempDir();

    writeSessionFile(tempDir, "sess-1", [
      makeSessionHeader("sess-1"),
      makeMessage("user", "I always use TypeScript strict mode in all projects"),
      makeMessage("assistant", "TypeScript strict mode preference saved."),
    ]);
    writeSessionFile(tempDir, "sess-2", [
      makeSessionHeader("sess-2"),
      makeMessage("user", "Deploy to production every Friday after code review"),
      makeMessage("assistant", "Friday deployment schedule noted."),
    ]);

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      targetScope: "global",
      minImportance: 0.0,
      alreadyImported: new Set(["sess-1"]),
    });

    assert.equal(result.skippedAlreadyImported, 1);
    // Only sess-2 turns should be stored
    const metas = store.stored.map((e: any) => JSON.parse(e.metadata));
    assert.ok(metas.every((m: any) => m.sessionId === "sess-2"));
  });

  it("should combine skipAutomatedTurns with includeDeleted", async () => {
    tempDir = createTempDir();

    // Write a deleted session with mixed content (automated + real)
    writeFileSync(
      join(tempDir, "mixed-deleted.jsonl.deleted.1709654321"),
      [
        makeSessionHeader("mixed-deleted"),
        makeMessage("user", "System: [notification] alert triggered"),
        makeMessage("user", "We should always use connection pooling for PostgreSQL databases"),
        makeMessage("assistant", "Noted — PostgreSQL connection pooling is now standard practice."),
      ].join("\n"),
    );

    const store = createMockStore();
    const embedder = createMockEmbedder();

    const result = await indexSessions(store, embedder, {
      sessionsDir: tempDir,
      minImportance: 0.0,
      includeDeleted: true,
      // Note: without LLM extraction, the automated filter drops the entire session
      // With LLM extraction, skipAutomatedTurns would keep the real turns
      llmExtraction: undefined,
    });

    // Without LLM extraction, session has automated content → entire session dropped
    assert.equal(result.skippedSessions, 1, "should skip session with automated content in heuristic mode");
  });
});
