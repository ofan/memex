/**
 * Tests for sliding window auto-capture
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCaptureWindows } from "../src/capture-windows.js";
import { MemoryStore } from "../src/memory.js";

const DIM = 4;
function seedVec(seed: number): number[] {
  const v = Array.from({ length: DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

describe("buildCaptureWindows", () => {
  it("builds a single window from short conversation", () => {
    const messages = [
      { role: "user", text: "My favorite color is blue." },
      { role: "assistant", text: "Got it, I'll remember that." },
    ];
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 3000 });
    assert.equal(windows.length, 1);
    assert.ok(windows[0].includes("blue"));
    assert.ok(windows[0].includes("remember"));
  });

  it("builds multiple windows for long conversations", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Message ${i} with some content about topic ${i}. `.repeat(10),
    }));
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 1500 });
    assert.ok(windows.length >= 2, `Expected >=2 windows, got ${windows.length}`);
  });

  it("filters assistant code blocks", () => {
    const messages = [
      { role: "user", text: "How do I sort an array?" },
      { role: "assistant", text: "Use Array.sort().\n```javascript\narr.sort((a, b) => a - b);\n```\nThis sorts ascending." },
    ];
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 3000 });
    assert.equal(windows.length, 1);
    assert.ok(!windows[0].includes("```"), "Should not contain code fences");
    assert.ok(windows[0].includes("Array.sort()"));
    assert.ok(windows[0].includes("ascending"));
  });

  it("skips all-noise assistant messages", () => {
    const messages = [
      { role: "user", text: "My birthday is March 15th." },
      { role: "assistant", text: "```python\ndef foo():\n  pass\n```" },
      { role: "user", text: "I live in Portland." },
    ];
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 3000 });
    assert.equal(windows.length, 1);
    assert.ok(windows[0].includes("birthday"));
    assert.ok(windows[0].includes("Portland"));
    assert.ok(!windows[0].includes("python"));
  });

  it("includes role labels in window text", () => {
    const messages = [
      { role: "user", text: "I prefer dark mode." },
      { role: "assistant", text: "Noted, you prefer dark mode." },
    ];
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 3000 });
    assert.ok(windows[0].includes("[user]"));
    assert.ok(windows[0].includes("[assistant]"));
  });
});

describe("end-to-end: sliding window + storage + retrieval", () => {
  it("stores windowed conversation and retrieves via vector search", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "e2e-capture-"));
    try {
      const store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });

      const messages = [
        { role: "user", text: "I just set up my home office with a standing desk from Uplift." },
        { role: "assistant", text: "Nice choice! Uplift makes great standing desks. How's the build quality?" },
        { role: "user", text: "It's solid. I paired it with an Aeron chair for when I want to sit." },
        { role: "assistant", text: "The Herman Miller Aeron is a classic ergonomic chair. Great combo." },
      ];

      const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 1800 });
      assert.ok(windows.length >= 1);
      assert.ok(windows[0].includes("Uplift"));
      assert.ok(windows[0].includes("Aeron"));

      const vec = seedVec(42);
      const entry = await store.store({
        text: windows[0],
        vector: vec,
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      const results = await store.vectorSearch(vec, 5, 0.0);
      assert.ok(results.length > 0, "Should retrieve the stored window");
      assert.equal(results[0].entry.id, entry.id);
      assert.ok(results[0].entry.text.includes("Uplift"));
      assert.ok(results[0].score > 0.9);

      await store.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
