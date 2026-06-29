/**
 * Tests for the recall-debug capture (issue #23).
 *
 * Two surfaces verified:
 *   1. resolveDebugDir() — env-flag interpretation (off / "1" / "true" / explicit path)
 *   2. writeDebugRecall() — file written when on, no-op when off, payload shape correct
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDebugDir,
  writeDebugRecall,
  buildPayloadFromUnifiedRecall,
  buildPayloadFromMemoryOnly,
} from "../src/debug-recall.js";

describe("resolveDebugDir (issue #23)", () => {
  it("returns null when MEMEX_DEBUG_RECALL is unset", () => {
    assert.equal(resolveDebugDir({}), null);
  });

  it("returns null when set to '0' / 'false' / 'off'", () => {
    assert.equal(resolveDebugDir({ MEMEX_DEBUG_RECALL: "0" }), null);
    assert.equal(resolveDebugDir({ MEMEX_DEBUG_RECALL: "false" }), null);
    assert.equal(resolveDebugDir({ MEMEX_DEBUG_RECALL: "off" }), null);
  });

  it("returns default tmpdir path when set to truthy non-path values", () => {
    const dir = resolveDebugDir({ MEMEX_DEBUG_RECALL: "1" });
    assert.ok(dir && dir.startsWith(tmpdir()));
    assert.equal(resolveDebugDir({ MEMEX_DEBUG_RECALL: "true" }), dir);
    assert.equal(resolveDebugDir({ MEMEX_DEBUG_RECALL: "on" }), dir);
  });

  it("treats other strings as a literal directory path", () => {
    assert.equal(resolveDebugDir({ MEMEX_DEBUG_RECALL: "/tmp/custom-debug" }), "/tmp/custom-debug");
  });
});

describe("writeDebugRecall (issue #23)", () => {
  it("returns null and writes nothing when capture is off", async () => {
    const result = await writeDebugRecall(
      buildPayloadFromMemoryOnly({
        agentId: "main",
        sessionId: "s1",
        query: "q",
        injectedContext: "ctx",
        results: [],
      }),
      {} // no env var → off
    );
    assert.equal(result, null);
  });

  it("writes a JSON snapshot to the configured directory when on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memex-debug-test-"));
    try {
      const payload = buildPayloadFromUnifiedRecall({
        agentId: "main",
        sessionId: "session-123",
        query: "what's the deploy target?",
        injectedContext: "- [mem:abc12345 · fact · global] We deploy via blue-green.",
        results: [
          {
            id: "abc1234567890",
            score: 0.87,
            source: "conversation",
            text: "We deploy via blue-green to host-a then host-b.",
            metadata: { category: "fact", scope: "global" },
          },
          {
            id: "doc-id-99",
            score: 0.71,
            source: "document",
            text: "Deployment runbook: ...",
            metadata: { displayPath: "docs/deploy.md", title: "Deploy" },
          },
        ],
      });

      const path = await writeDebugRecall(payload, { MEMEX_DEBUG_RECALL: dir });
      assert.ok(path, "writer returned a path");
      assert.ok(existsSync(path!), "file was created");

      const written = JSON.parse(readFileSync(path!, "utf8"));
      assert.equal(written.agentId, "main");
      assert.equal(written.sessionId, "session-123");
      assert.equal(written.query, "what's the deploy target?");
      assert.equal(written.source, "unified-recall");
      assert.equal(written.resultCount, 2);
      assert.match(written.injectedContext, /\[mem:abc12345/);
      assert.equal(written.results.length, 2);
      assert.equal(written.results[0].source, "conversation");
      assert.equal(written.results[1].source, "document");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates per-item text to 500 chars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memex-debug-test-"));
    try {
      const longText = "x".repeat(2000);
      const payload = buildPayloadFromMemoryOnly({
        agentId: "main",
        sessionId: null,
        query: "q",
        injectedContext: "ctx",
        results: [
          { entry: { id: "id1", text: longText, category: "fact", scope: "global" }, score: 0.9 },
        ],
      });
      const path = await writeDebugRecall(payload, { MEMEX_DEBUG_RECALL: dir });
      const written = JSON.parse(readFileSync(path!, "utf8"));
      assert.equal(written.results[0].text.length, 500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null on write failure (e.g. unwritable path) without throwing", async () => {
    // /dev/null is a file, so /dev/null/sub triggers ENOTDIR fast — perfect for
    // exercising the swallow-and-return-null error path. (Avoids /proc paths
    // which hang Node's mkdir at the syscall level.)
    const result = await writeDebugRecall(
      buildPayloadFromMemoryOnly({
        agentId: "main",
        sessionId: null,
        query: "q",
        injectedContext: "ctx",
        results: [],
      }),
      { MEMEX_DEBUG_RECALL: "/dev/null/sub" }
    );
    assert.equal(result, null);
  });
});
