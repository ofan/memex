/**
 * Tests for src/noise-filter.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNoise, isStructuralNoise, isTruncated, filterNoise, extractHumanText, filterAssistantText } from "../src/noise-filter.js";

describe("isNoise", () => {
  it("filters very short text", () => {
    assert.equal(isNoise(""), true);
    assert.equal(isNoise("hi"), true);
    assert.equal(isNoise("ok"), true);
    assert.equal(isNoise("abc"), true);
  });

  it("filters denial patterns", () => {
    assert.equal(isNoise("I don't have any information about that"), true);
    assert.equal(isNoise("I'm not sure about the details"), true);
    assert.equal(isNoise("I don't recall seeing that"), true);
    assert.equal(isNoise("No relevant memories found"), true);
  });

  it("filters meta-question patterns", () => {
    assert.equal(isNoise("Do you remember my name?"), true);
    assert.equal(isNoise("Can you recall what I said?"), true);
    assert.equal(isNoise("Did I tell you about my project?"), true);
  });

  it("filters session boilerplate", () => {
    assert.equal(isNoise("Hello, how are you?"), true);
    assert.equal(isNoise("Hi there"), true);
    assert.equal(isNoise("Good morning"), true);
    assert.equal(isNoise("fresh session"), true);
  });

  it("passes meaningful content", () => {
    assert.equal(isNoise("User prefers dark mode in all applications"), false);
    assert.equal(isNoise("The API endpoint is at /v1/users"), false);
    assert.equal(isNoise("We decided to use PostgreSQL for the database"), false);
  });

  it("filters platform metadata (Discord envelopes)", () => {
    assert.equal(isNoise("Conversation info (untrusted metadata): channel #general"), true);
    assert.equal(isNoise("[Thread starter by user123] Some topic"), true);
    assert.equal(isNoise("[2024-01-01] [System Message] User joined"), true);
  });

  it("filters short filler responses", () => {
    assert.equal(isNoise("got it"), true);
    assert.equal(isNoise("Done!"), true);
    assert.equal(isNoise("ok"), true);
    assert.equal(isNoise("sure."), true);
    assert.equal(isNoise("perfect"), true);
  });

  it("respects options to disable specific filters", () => {
    assert.equal(isNoise("I don't have any data", { filterDenials: false }), false);
    assert.equal(isNoise("Do you remember my email?", { filterMetaQuestions: false }), false);
    assert.equal(isNoise("Hello world!", { filterBoilerplate: false }), false);
    assert.equal(isNoise("Conversation info (untrusted metadata): test", { filterPlatformMetadata: false }), false);
    assert.equal(isNoise("got it", { filterFiller: false }), false);
  });
});

describe("isStructuralNoise", () => {
  it("filters very short text", () => {
    assert.equal(isStructuralNoise("hi"), true);
    assert.equal(isStructuralNoise("ok done"), true);
  });

  it("filters very long text", () => {
    assert.equal(isStructuralNoise("a".repeat(2001)), true);
  });

  it("respects CJK minimum length", () => {
    assert.equal(isStructuralNoise("你好"), true);  // 2 chars, too short
    assert.equal(isStructuralNoise("我喜歡深色模式"), false);  // 7 CJK chars, passes
  });

  it("filters injected memory context", () => {
    assert.equal(isStructuralNoise("Some text with <relevant-memories> injected"), true);
  });

  it("filters XML system tags", () => {
    assert.equal(isStructuralNoise("<system-reminder>do not do that</system-reminder>"), true);
  });

  it("filters Discord metadata envelopes", () => {
    assert.equal(isStructuralNoise("Conversation info (untrusted metadata): {\"channel\": \"general\"}"), true);
  });

  it("filters thread starter preambles", () => {
    assert.equal(isStructuralNoise("[Thread starter by user123] A topic about stuff"), true);
  });

  it("filters JSON code blocks", () => {
    assert.equal(isStructuralNoise("Here is metadata:\n```json\n{\"key\": \"value\"}\n```"), true);
  });

  it("filters memory management commands", () => {
    assert.equal(isStructuralNoise("delete all memory entries please"), true);
    assert.equal(isStructuralNoise("forget that memory about my password"), true);
  });

  it("passes meaningful content", () => {
    assert.equal(isStructuralNoise("User prefers dark mode in all applications"), false);
    assert.equal(isStructuralNoise("The API endpoint is at /v1/users for the main service"), false);
    assert.equal(isStructuralNoise("We decided to use PostgreSQL for the database going forward"), false);
  });

  it("filters tool output markers", () => {
    assert.equal(isStructuralNoise("[tool_result] file written successfully"), true);
    assert.equal(isStructuralNoise("<tool_result>output here</tool_result>"), true);
    assert.equal(isStructuralNoise("<function_result>42</function_result>"), true);
    assert.equal(isStructuralNoise("Tool output: 200 OK"), true);
  });

  it("filters code-heavy content (>50% lines in fenced blocks)", () => {
    const codeHeavy = [
      "Here is the code:",
      "```",
      "const x = 1;",
      "const y = 2;",
      "const z = x + y;",
      "console.log(z);",
      "return z;",
      "```",
    ].join("\n");
    assert.equal(isStructuralNoise(codeHeavy), true);
  });

  it("does NOT filter text that merely mentions code", () => {
    assert.equal(isStructuralNoise("User prefers Python over JavaScript for scripting tasks"), false);
    assert.equal(isStructuralNoise("Use `npm install` to set up the project dependencies"), false);
  });

  it("does NOT filter text with a small inline code fence", () => {
    const small = "To run the project:\n```\nnpm start\n```\nThen open the browser.";
    assert.equal(isStructuralNoise(small), false);
  });

  it("filters JS/Node stack traces", () => {
    const trace = [
      "Error: Cannot read properties of undefined",
      "    at Object.<anonymous> (/app/src/index.js:10:5)",
      "    at Module._compile (node:internal/modules/cjs/loader:1364:14)",
      "    at Module._extensions..js (node:internal/modules/cjs/loader:1422:10)",
      "    at new Promise (<anonymous>)",
    ].join("\n");
    assert.equal(isStructuralNoise(trace), true);
  });

  it("filters Python tracebacks", () => {
    const trace = [
      "Traceback (most recent call last):",
      "  File \"app.py\", line 42, in main",
      "    result = process(data)",
      "  File \"processor.py\", line 17, in process",
      "    raise ValueError('bad input')",
      "ValueError: bad input",
    ].join("\n");
    assert.equal(isStructuralNoise(trace), true);
  });

  it("filters Java stack traces", () => {
    const trace = [
      "Exception in thread \"main\" java.lang.NullPointerException",
      "	at java.base/java.util.Objects.requireNonNull(Objects.java:221)",
    ].join("\n");
    assert.equal(isStructuralNoise(trace), true);
  });

  it("filters base64 blobs", () => {
    const blob = "SGVsbG8gV29ybGQhIFRoaXMgaXMgYSBsb25nIGJhc2U2NCBlbmNvZGVkIHN0cmluZyB0aGF0IGlzIG92ZXIgMTAwIGNoYXJhY3RlcnMu";
    assert.equal(isStructuralNoise(blob), true);
  });

  it("does NOT filter normal sentences with numbers or dates", () => {
    assert.equal(isStructuralNoise("The deployment happened on 2024-03-15 and completed successfully"), false);
    assert.equal(isStructuralNoise("Server response time is around 120ms on average"), false);
  });

  it("filters CSV data with many fields across multiple lines", () => {
    const csv = [
      "id,name,email,role,created_at,status,region",
      "1,Alice,alice@example.com,admin,2024-01-01,active,us-east",
      "2,Bob,bob@example.com,user,2024-01-02,active,eu-west",
      "3,Carol,carol@example.com,user,2024-01-03,inactive,us-west",
    ].join("\n");
    assert.equal(isStructuralNoise(csv), true);
  });

  it("filters TSV data with many fields across multiple lines", () => {
    const tsv = [
      "id\tname\temail\trole\tcreated\tstatus\tregion",
      "1\tAlice\talice@example.com\tadmin\t2024-01-01\tactive\tus-east",
      "2\tBob\tbob@example.com\tuser\t2024-01-02\tactive\teu-west",
      "3\tCarol\tcarol@example.com\tuser\t2024-01-03\tinactive\tus-west",
    ].join("\n");
    assert.equal(isStructuralNoise(tsv), true);
  });

  it("does NOT filter a sentence that happens to contain commas", () => {
    assert.equal(isStructuralNoise("We use TypeScript, Node.js, SQLite, and OpenAI for the stack"), false);
  });

  it("filters log output with multiple timestamped lines", () => {
    const logs = [
      "2024-01-01T00:00:01 Starting server",
      "2024-01-01T00:00:02 Listening on port 3000",
      "2024-01-01T00:00:05 Request received",
      "2024-01-01T00:00:06 Response sent",
    ].join("\n");
    assert.equal(isStructuralNoise(logs), true);
  });

  it("filters log output with log-level prefixes", () => {
    const logs = [
      "[INFO] Starting application",
      "[INFO] Database connected",
      "[WARN] Memory usage high",
      "[ERROR] Failed to process request: timeout",
    ].join("\n");
    assert.equal(isStructuralNoise(logs), true);
  });

  it("does NOT filter a factual memory that contains a date", () => {
    assert.equal(isStructuralNoise("User started the project on 2024-03-01 and finished it in April"), false);
  });
});

describe("isTruncated", () => {
  it("detects text ending mid-word", () => {
    assert.equal(isTruncated("This is a sentence that ends abruptly without any punctuation and keeps going on without being terminat"), true);
  });

  it("detects text ending with a dash", () => {
    assert.equal(isTruncated("The system uses a configuration that is —"), true);
    assert.equal(isTruncated("We decided to switch to the new approach –"), true);
  });

  it("detects exact truncation boundary lengths", () => {
    const text500 = "a".repeat(499) + "b"; // exactly 500 chars, no terminal punctuation
    assert.equal(isTruncated(text500), true);
  });

  it("passes text at boundary length with terminal punctuation", () => {
    const text500 = "a".repeat(499) + "."; // exactly 500 chars with period
    assert.equal(isTruncated(text500), false);
  });

  it("detects unmatched opening brackets", () => {
    const text = "The configuration includes the following settings (see the docs for more details [section 1] and also check the (nested config that was never closed";
    assert.equal(isTruncated(text), true);
  });

  it("passes properly terminated sentences", () => {
    assert.equal(isTruncated("This is a complete sentence."), false);
    assert.equal(isTruncated("Is this a question?"), false);
    assert.equal(isTruncated("What an exclamation!"), false);
    assert.equal(isTruncated("End with semicolon;"), false);
  });

  it("passes short text (below threshold)", () => {
    assert.equal(isTruncated("short"), false);
    assert.equal(isTruncated("hi there"), false);
  });

  it("passes text ending with closing bracket", () => {
    assert.equal(isTruncated("The config uses these settings (dark mode, auto-save)"), false);
  });
});

describe("isStructuralNoise (truncation integration)", () => {
  it("filters truncated text via isStructuralNoise", () => {
    assert.equal(isStructuralNoise("This is a long enough sentence that ends without any punctuation at all and keeps going on and on without ending"), true);
  });
});

describe("extractHumanText", () => {
  it("extracts human text from Discord envelope", () => {
    const envelope = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{ "conversation_label": "Guild #general" }',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{ "label": "user1", "name": "user1" }',
      "```",
      "",
      "we don't want to burn tokens on embedding every message",
    ].join("\n");

    assert.equal(
      extractHumanText(envelope),
      "we don't want to burn tokens on embedding every message"
    );
  });

  it("returns null for thread starter", () => {
    assert.equal(
      extractHumanText("[Thread starter by user123] A topic about stuff"),
      null
    );
  });

  it("returns null for relevant-memories injection", () => {
    assert.equal(
      extractHumanText("Some text with <relevant-memories> injected"),
      null
    );
  });

  it("returns null for system messages", () => {
    assert.equal(extractHumanText("System: exec result from tool"), null);
  });

  it("returns null for pre-compaction flush", () => {
    assert.equal(
      extractHumanText("Pre-compaction memory flush: saving 12 entries"),
      null
    );
  });

  it("returns null for cron triggers", () => {
    assert.equal(extractHumanText("[cron:heartbeat] ping"), null);
  });

  it("returns text as-is when no envelope detected", () => {
    assert.equal(
      extractHumanText("I prefer dark mode in all applications"),
      "I prefer dark mode in all applications"
    );
  });

  it("returns null for empty human text after envelope", () => {
    const envelope = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{ "conversation_label": "Guild #general" }',
      "```",
      "",
    ].join("\n");

    assert.equal(extractHumanText(envelope), null);
  });

  it("extracts from queued messages batch", () => {
    const queued = [
      "[Queued messages while agent was busy]",
      "Conversation info (untrusted metadata):",
      "```json",
      '{ "conversation_label": "Guild #general" }',
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      '{ "label": "user1" }',
      "```",
      "",
      "check the deploy status please",
    ].join("\n");

    assert.equal(extractHumanText(queued), "check the deploy status please");
  });

  it("returns null for XML system tags", () => {
    assert.equal(
      extractHumanText("<system-reminder>do not do that</system-reminder>"),
      null
    );
  });

  it("returns null for empty input", () => {
    assert.equal(extractHumanText(""), null);
    assert.equal(extractHumanText("   "), null);
  });
});

describe("filterNoise", () => {
  it("filters array of items", () => {
    const items = [
      { id: 1, text: "User likes TypeScript" },
      { id: 2, text: "hi" },
      { id: 3, text: "I don't recall that" },
      { id: 4, text: "Project uses Node.js 25" },
    ];

    const filtered = filterNoise(items, (item) => item.text);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].id, 1);
    assert.equal(filtered[1].id, 4);
  });

  it("returns empty array for all noise", () => {
    const items = [{ text: "hi" }, { text: "ok" }];
    const filtered = filterNoise(items, (item) => item.text);
    assert.equal(filtered.length, 0);
  });
});

describe("filterAssistantText", () => {
  it("strips fenced code blocks", () => {
    const input = "I installed the package.\n```bash\nnpm install foo\n```\nIt should work now.";
    assert.equal(filterAssistantText(input), "I installed the package.\n\nIt should work now.");
  });

  it("strips multi-line code blocks preserving surrounding text", () => {
    const input = "Here's the fix:\n```typescript\nfunction foo() {\n  return 42;\n}\n```\nThis resolves the issue.";
    assert.equal(filterAssistantText(input), "Here's the fix:\n\nThis resolves the issue.");
  });

  it("strips tool output markers", () => {
    const input = "Let me check.\n<tool_result>\n{\"status\": \"ok\", \"data\": [1,2,3]}\n</tool_result>\nThe status is ok.";
    assert.equal(filterAssistantText(input), "Let me check.\n\nThe status is ok.");
  });

  it("strips [tool_result] blocks", () => {
    const input = "Running the test.\n[tool_result]\nPASSED 42 tests\n[/tool_result]\nAll tests pass.";
    assert.equal(filterAssistantText(input), "Running the test.\n\nAll tests pass.");
  });

  it("strips base64 blobs inline", () => {
    const input = "The image data is " + "A".repeat(120) + " and that's the icon.";
    assert.equal(filterAssistantText(input), "The image data is  and that's the icon.");
  });

  it("strips lines that look like stack traces", () => {
    const input = "I found the bug.\n  at Object.<anonymous> (/home/user/app.js:42:15)\n  at Module._compile (node:internal/modules/cjs/loader:1275:14)\nThe fix is simple.";
    assert.equal(filterAssistantText(input), "I found the bug.\n\nThe fix is simple.");
  });

  it("preserves short inline code", () => {
    const input = "Use `npm install` to set up the project.";
    assert.equal(filterAssistantText(input), "Use `npm install` to set up the project.");
  });

  it("preserves normal assistant prose", () => {
    const input = "Your favorite restaurant is Sushi Zen on 5th Avenue. You mentioned going there every Friday.";
    assert.equal(filterAssistantText(input), input);
  });

  it("returns null for all-noise content", () => {
    const input = "```python\ndef foo():\n  pass\n```";
    assert.equal(filterAssistantText(input), null);
  });

  it("collapses multiple blank lines after stripping", () => {
    const input = "First point.\n```\ncode\n```\n\n\n\nSecond point.";
    assert.equal(filterAssistantText(input), "First point.\n\nSecond point.");
  });
});
