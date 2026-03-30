import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractRecallQuery } from "../src/recall-query.js";

describe("extractRecallQuery", () => {
  it("prefers the latest user message over the full prompt", () => {
    const query = extractRecallQuery({
      prompt: "SYSTEM\nlots of context\nUSER: short question",
      messages: [
        { role: "system", content: "static" },
        { role: "assistant", content: "previous answer" },
        { role: "user", content: "short question" },
      ],
    });

    assert.equal(query, "short question");
  });

  it("joins text parts from the latest user content array", () => {
    const query = extractRecallQuery({
      prompt: "fallback prompt",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first part" },
            { type: "text", text: "second part" },
          ],
        },
      ],
    });

    assert.equal(query, "first part\nsecond part");
  });

  it("falls back to prompt when no user message is available", () => {
    const query = extractRecallQuery({
      prompt: "fallback prompt",
      messages: [
        { role: "system", content: "static" },
      ],
    });

    assert.equal(query, "fallback prompt");
  });
});
