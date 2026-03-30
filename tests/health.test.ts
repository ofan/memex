import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateHealthStatus,
  buildAuditPrompt,
  extractAuditConclusion,
  filterMemexLogLines,
  getLatestOpenClawLogPath,
  type MemexHealthCheck,
} from "../src/health.js";

describe("aggregateHealthStatus", () => {
  it("returns fail when any check fails", () => {
    const checks: MemexHealthCheck[] = [
      { name: "db", status: "ok" },
      { name: "retrieval", status: "fail", detail: "timeout" },
      { name: "embedding", status: "warn" },
    ];

    assert.equal(aggregateHealthStatus(checks), "fail");
  });

  it("returns warn when no check fails but at least one warns", () => {
    const checks: MemexHealthCheck[] = [
      { name: "db", status: "ok" },
      { name: "embedding", status: "warn", detail: "re-embed required" },
    ];

    assert.equal(aggregateHealthStatus(checks), "warn");
  });

  it("returns ok when every check is ok", () => {
    const checks: MemexHealthCheck[] = [
      { name: "db", status: "ok" },
      { name: "retrieval", status: "ok" },
    ];

    assert.equal(aggregateHealthStatus(checks), "ok");
  });
});

describe("filterMemexLogLines", () => {
  it("keeps recent memex-related lines only", () => {
    const lines = [
      "2026-03-29T20:43:31Z [gateway] memex@0.5.11: plugin registered",
      "2026-03-29T20:43:31Z [gateway] listening on ws://127.0.0.1:18789",
      "2026-03-29T20:43:32Z [gateway] memex: initialized successfully (embedding: OK, retrieval: OK, mode: hybrid, FTS: enabled)",
      "2026-03-29T20:43:33Z [gateway] memex: document health check failed: timeout",
    ].join("\n");

    assert.deepEqual(filterMemexLogLines(lines, 10), [
      "2026-03-29T20:43:31Z [gateway] memex@0.5.11: plugin registered",
      "2026-03-29T20:43:32Z [gateway] memex: initialized successfully (embedding: OK, retrieval: OK, mode: hybrid, FTS: enabled)",
      "2026-03-29T20:43:33Z [gateway] memex: document health check failed: timeout",
    ]);
  });

  it("returns only the newest matching lines up to the limit", () => {
    const lines = [
      "1 memex: first",
      "2 memex: second",
      "3 memex: third",
    ].join("\n");

    assert.deepEqual(filterMemexLogLines(lines, 2), [
      "2 memex: second",
      "3 memex: third",
    ]);
  });
});

describe("buildAuditPrompt", () => {
  it("includes snapshot and evidence sections", () => {
    const prompt = buildAuditPrompt(
      {
        status: "warn",
        plugin: { id: "memex", version: "0.5.11" },
        checks: [
          { name: "db", status: "ok" },
          { name: "embedding", status: "warn", detail: "re-embed required" },
        ],
      },
      ["memex: initialized successfully", "memex: interrupted re-embed detected"]
    );

    assert.match(prompt, /Health Snapshot/);
    assert.match(prompt, /Log Evidence/);
    assert.match(prompt, /re-embed required/);
    assert.match(prompt, /interrupted re-embed detected/);
  });
});

describe("extractAuditConclusion", () => {
  it("extracts assistant text from simple text messages", () => {
    const text = extractAuditConclusion([
      { role: "user", content: "audit this" },
      { role: "assistant", content: "No critical issues found." },
    ]);

    assert.equal(text, "No critical issues found.");
  });

  it("extracts assistant text from content-part arrays", () => {
    const text = extractAuditConclusion([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Critical: DB check failed." },
          { type: "text", text: "Suggested action: run quick_check." },
        ],
      },
    ]);

    assert.match(text, /Critical: DB check failed\./);
    assert.match(text, /Suggested action: run quick_check\./);
  });
});

describe("getLatestOpenClawLogPath", () => {
  it("returns null when no log files match", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "memex-health-"));
    const result = await getLatestOpenClawLogPath(dir);
    assert.equal(result, null);
  });

  it("returns the newest openclaw log file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memex-health-"));
    const older = join(dir, "openclaw-2026-03-28.log");
    const newer = join(dir, "openclaw-2026-03-29.log");

    await writeFile(older, "old");
    await new Promise(resolve => setTimeout(resolve, 10));
    await writeFile(newer, "new");

    const result = await getLatestOpenClawLogPath(dir);
    assert.equal(result, newer);
  });
});
