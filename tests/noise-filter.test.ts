/**
 * Tests for src/noise-filter.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNoise, filterNoise } from "../src/noise-filter.js";

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

  it("respects options to disable specific filters", () => {
    assert.equal(isNoise("I don't have any data", { filterDenials: false }), false);
    assert.equal(isNoise("Do you remember my email?", { filterMetaQuestions: false }), false);
    assert.equal(isNoise("Hello world!", { filterBoilerplate: false }), false);
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
