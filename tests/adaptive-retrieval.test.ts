/**
 * Tests for src/adaptive-retrieval.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipRetrieval } from "../src/adaptive-retrieval.js";

describe("shouldSkipRetrieval", () => {
  describe("skip patterns", () => {
    it("skips greetings", () => {
      assert.equal(shouldSkipRetrieval("hello"), true);
      assert.equal(shouldSkipRetrieval("Hi there"), true);
      assert.equal(shouldSkipRetrieval("good morning"), true);
      assert.equal(shouldSkipRetrieval("hey"), true);
    });

    it("skips slash commands", () => {
      assert.equal(shouldSkipRetrieval("/help"), true);
      assert.equal(shouldSkipRetrieval("/commit"), true);
    });

    it("skips shell commands", () => {
      assert.equal(shouldSkipRetrieval("npm install express"), true);
      assert.equal(shouldSkipRetrieval("git status"), true);
      assert.equal(shouldSkipRetrieval("docker compose up"), true);
    });

    it("skips simple affirmations", () => {
      assert.equal(shouldSkipRetrieval("yes"), true);
      assert.equal(shouldSkipRetrieval("ok"), true);
      assert.equal(shouldSkipRetrieval("thanks"), true);
      assert.equal(shouldSkipRetrieval("got it"), true);
    });

    it("skips continuation prompts", () => {
      assert.equal(shouldSkipRetrieval("go ahead"), true);
      assert.equal(shouldSkipRetrieval("continue"), true);
      assert.equal(shouldSkipRetrieval("proceed"), true);
    });

    it("skips HEARTBEAT", () => {
      assert.equal(shouldSkipRetrieval("HEARTBEAT"), true);
      assert.equal(shouldSkipRetrieval("[System HEARTBEAT]"), true);
    });

    it("skips very short text", () => {
      assert.equal(shouldSkipRetrieval("abc"), true);
      assert.equal(shouldSkipRetrieval("hi"), true);
    });
  });

  describe("force retrieve patterns", () => {
    it("retrieves memory-related queries", () => {
      assert.equal(shouldSkipRetrieval("Do you remember my API key?"), false);
      assert.equal(shouldSkipRetrieval("What did we discuss last time?"), false);
      assert.equal(shouldSkipRetrieval("recall my preferences"), false);
    });

    it("retrieves temporal queries", () => {
      assert.equal(shouldSkipRetrieval("What did I say before?"), false);
      assert.equal(shouldSkipRetrieval("We discussed previously the approach"), false);
    });

    it("retrieves personal info queries", () => {
      assert.equal(shouldSkipRetrieval("my name is John"), false);
      assert.equal(shouldSkipRetrieval("my email address is test@example.com"), false);
    });

    it("retrieves CJK memory queries", () => {
      assert.equal(shouldSkipRetrieval("你记得吗"), false);
      assert.equal(shouldSkipRetrieval("上次说的"), false);
    });
  });

  describe("normal queries", () => {
    it("retrieves meaningful questions", () => {
      assert.equal(shouldSkipRetrieval("How do I configure the database?"), false);
      assert.equal(shouldSkipRetrieval("What is the best approach for caching?"), false);
    });

    it("retrieves longer instructions", () => {
      assert.equal(shouldSkipRetrieval("Add a new endpoint for user authentication"), false);
      assert.equal(shouldSkipRetrieval("Refactor the payment processing module"), false);
    });
  });

  describe("minLength parameter", () => {
    it("respects custom minLength", () => {
      // "test?" matches skip pattern /^(ping|pong|test|debug)\s*[.!?]?$/i so it's skipped
      assert.equal(shouldSkipRetrieval("test?"), true);
      // A non-greeting, non-skip string shorter than minLength should be skipped
      assert.equal(shouldSkipRetrieval("some text", 20), true);
      // Same string with lower minLength passes
      assert.equal(shouldSkipRetrieval("some text", 5), false);
      // Question mark in a short string bypasses minLength check
      assert.equal(shouldSkipRetrieval("scope?", 20), false);
    });
  });

  describe("cron prefix stripping", () => {
    it("strips cron wrapper before applying rules", () => {
      assert.equal(shouldSkipRetrieval("[cron:abc123 daily-job] npm test"), true);
    });
  });
});
