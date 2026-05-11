import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeRerankerEndpoint } from "./runner.js";

describe("probeRerankerEndpoint", () => {
  it("returns ok=true on valid jina-shaped response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.1 },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const result = await probeRerankerEndpoint("http://fake/v1/rerank", "key", "model");
      assert.deepEqual(result, { ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts voyage-shaped response (data[] instead of results[])", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [
        { index: 0, relevance_score: 0.9 },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const result = await probeRerankerEndpoint("http://fake/v1/rerank", "key", "model");
      assert.deepEqual(result, { ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns ok=false with HTTP status on 4xx/5xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    try {
      const result = await probeRerankerEndpoint("http://fake/v1/rerank", "badkey", "model");
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /HTTP 401/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns ok=false on 502 upstream error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });
    try {
      const result = await probeRerankerEndpoint("http://fake/v1/rerank", "key", "model");
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /HTTP 502/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns ok=false on malformed response shape (missing results/data)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      something: "unexpected",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const result = await probeRerankerEndpoint("http://fake/v1/rerank", "key", "model");
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /missing expected/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns ok=false on empty results[] array", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      results: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const result = await probeRerankerEndpoint("http://fake/v1/rerank", "key", "model");
      assert.equal(result.ok, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns ok=false with timeout reason on AbortError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      // Simulate a hang that will be aborted
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          const err: any = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, 50);
      }) as any;
    };
    try {
      const result = await probeRerankerEndpoint("http://fake/v1/rerank", "key", "model", 30);
      assert.equal(result.ok, false);
      // Accept either "timeout" or "aborted" — both indicate the expected failure
      if (!result.ok) assert.match(result.reason, /timeout|aborted/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns ok=false on network error (fetch throws)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    try {
      const result = await probeRerankerEndpoint("http://fake/v1/rerank", "key", "model");
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /ECONNREFUSED/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends the expected jina-shaped probe request body", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: any = null;
    globalThis.fetch = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }), { status: 200 });
    };
    try {
      await probeRerankerEndpoint("http://fake/v1/rerank", "some-key", "my-model");
      assert.equal(capturedBody.model, "my-model");
      assert.equal(capturedBody.query, "probe");
      assert.ok(Array.isArray(capturedBody.documents));
      assert.equal(capturedBody.documents.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
