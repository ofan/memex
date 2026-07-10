import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTransientRetry } from "../src/transient-retry.js";

/** Helper: make an error with a status code. */
function httpError(status: number, message: string = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe("withTransientRetry", () => {
  it("returns the result when the first attempt succeeds", async () => {
    let calls = 0;
    const result = await withTransientRetry(async () => {
      calls++;
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries on 502 and succeeds on later attempt", async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 3) throw httpError(502);
        return "ok";
      },
      { baseBackoffMs: 1 },  // fast test
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("retries on 503 and 504", async () => {
    for (const status of [503, 504]) {
      let calls = 0;
      const result = await withTransientRetry(
        async () => {
          calls++;
          if (calls < 2) throw httpError(status);
          return "ok";
        },
        { baseBackoffMs: 1 },
      );
      assert.equal(result, "ok", `should recover from ${status}`);
      assert.equal(calls, 2);
    }
  });

  it("does NOT retry on 4xx (non-transient)", async () => {
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw httpError(401);
        },
        { baseBackoffMs: 1 },
      ),
      /HTTP 401/,
    );
    assert.equal(calls, 1, "should not retry on 401");
  });

  it("retries on 500 (llama.cpp Compute error)", async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) throw httpError(500);
        return "ok";
      },
      { baseBackoffMs: 1 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 2, "500 should be retried (llama.cpp transient compute error)");
  });

  it("retries on AbortError (timeout)", async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return "ok";
      },
      { baseBackoffMs: 1 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("retries on TimeoutError", async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) {
          const err = new Error("timeout");
          err.name = "TimeoutError";
          throw err;
        }
        return "ok";
      },
      { baseBackoffMs: 1 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("throws after maxAttempts exhausted on persistent transient failures", async () => {
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw httpError(502);
        },
        { baseBackoffMs: 1, maxAttempts: 3 },
      ),
      /HTTP 502/,
    );
    assert.equal(calls, 3);
  });

  it("custom extraTransientStatuses extends the retry set", async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) throw httpError(429);
        return "ok";
      },
      { baseBackoffMs: 1, extraTransientStatuses: [429] },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("onRetry callback fires once per retry", async () => {
    const attempts: number[] = [];
    await withTransientRetry(
      async () => {
        if (attempts.length < 2) throw httpError(502);
        return "ok";
      },
      {
        baseBackoffMs: 1,
        onRetry: (attempt) => { attempts.push(attempt); },
      },
    );
    assert.deepEqual(attempts, [1, 2], "onRetry fires after each failed attempt");
  });

  it("preserves thrown error shape (not wrapped)", async () => {
    const original = httpError(401);
    try {
      await withTransientRetry(async () => { throw original; }, { baseBackoffMs: 1 });
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err, original, "thrown reference should be the same");
    }
  });

  it("default max attempts = 4 (3 retries)", async () => {
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw httpError(502);
        },
        { baseBackoffMs: 1 },  // no maxAttempts override → default
      ),
    );
    assert.equal(calls, 4);
  });
});
