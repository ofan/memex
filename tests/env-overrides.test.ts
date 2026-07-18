/**
 * Env-overrides-config (env > config > default). Verifies each supported env
 * var overrides the matching config field when set, and leaves config alone
 * when absent. Uses an explicit env object — never touches process.env.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEnvOverrides, syncDebugEnvFromConfig } from "../src/env-overrides.js";

const base = () => ({
  embedding: { apiKey: "k" },
  autoRecall: true,
  autoRecallLimit: 3,
  reranker: { enabled: false, endpoint: "config-endpoint", model: "config-model" },
  retrieval: { hardMinScore: 0.15, vectorWeight: 0.7 },
});

describe("applyEnvOverrides (env > config)", () => {
  it("MEMEX_DEBUG_RECALL overrides config.debugRecall", () => {
    const cfg: any = { ...base(), debugRecall: false };
    applyEnvOverrides(cfg, { MEMEX_DEBUG_RECALL: "1" });
    assert.equal(cfg.debugRecall, "1");
  });

  it("MEMEX_AUTO_RECALL falsy disables, truthy enables", () => {
    const off: any = { ...base() };
    applyEnvOverrides(off, { MEMEX_AUTO_RECALL: "0" });
    assert.equal(off.autoRecall, false);
    const on: any = { ...base(), autoRecall: false };
    applyEnvOverrides(on, { MEMEX_AUTO_RECALL: "true" });
    assert.equal(on.autoRecall, true);
  });

  it("MEMEX_AUTO_RECALL_LIMIT overrides when positive int", () => {
    const cfg: any = { ...base(), autoRecallLimit: 3 };
    applyEnvOverrides(cfg, { MEMEX_AUTO_RECALL_LIMIT: "5" });
    assert.equal(cfg.autoRecallLimit, 5);
  });

  it("MEMEX_RERANK_* enables + merges over the config reranker block", () => {
    const cfg: any = { ...base() };
    applyEnvOverrides(cfg, { MEMEX_RERANK_ENDPOINT: "env-endpoint", MEMEX_RERANK_MODEL: "env-model" });
    assert.equal(cfg.reranker.enabled, true);
    assert.equal(cfg.reranker.endpoint, "env-endpoint");
    assert.equal(cfg.reranker.model, "env-model");
    // Unspecified fields fall through to config.
    assert.equal(cfg.reranker.apiKey, "unused");
  });

  it("MEMEX_HARD_MIN_SCORE_OVERRIDE sets retrieval.hardMinScore, preserves siblings", () => {
    const cfg: any = { ...base() };
    applyEnvOverrides(cfg, { MEMEX_HARD_MIN_SCORE_OVERRIDE: "0.4" });
    assert.equal(cfg.retrieval.hardMinScore, 0.4);
    assert.equal(cfg.retrieval.vectorWeight, 0.7, "sibling retrieval keys preserved");
  });

  it("leaves config untouched when no env vars are set", () => {
    const cfg: any = { ...base() };
    const before = JSON.parse(JSON.stringify(cfg));
    applyEnvOverrides(cfg, {});
    assert.deepEqual(cfg, before);
  });

  it("ignores invalid override values (bad int / out-of-range float)", () => {
    const cfg: any = { ...base() };
    applyEnvOverrides(cfg, { MEMEX_AUTO_RECALL_LIMIT: "not-a-number", MEMEX_HARD_MIN_SCORE_OVERRIDE: "9" });
    assert.equal(cfg.autoRecallLimit, 3, "garbage int leaves config value");
    assert.equal(cfg.retrieval.hardMinScore, 0.15, "out-of-range float leaves config value");
  });
});

describe("syncDebugEnvFromConfig", () => {
  it("mirrors config.debugRecall into env when env unset", () => {
    const env: any = {};
    syncDebugEnvFromConfig({ debugRecall: "/custom/dir" }, env);
    assert.equal(env.MEMEX_DEBUG_RECALL, "/custom/dir");
  });

  it("normalizes boolean config to 1/0", () => {
    const envT: any = {}; syncDebugEnvFromConfig({ debugRecall: true }, envT);
    assert.equal(envT.MEMEX_DEBUG_RECALL, "1");
    const envF: any = {}; syncDebugEnvFromConfig({ debugRecall: false }, envF);
    assert.equal(envF.MEMEX_DEBUG_RECALL, "0");
  });

  it("does not overwrite an explicit env value", () => {
    const env: any = { MEMEX_DEBUG_RECALL: "env-wins" };
    syncDebugEnvFromConfig({ debugRecall: "/config/dir" }, env);
    assert.equal(env.MEMEX_DEBUG_RECALL, "env-wins");
  });
});

describe("applyEnvOverrides — MEMEX_DOC_PATHS", () => {
  it("parses comma-separated path:name entries", () => {
    const cfg: any = {};
    applyEnvOverrides(cfg, { MEMEX_DOC_PATHS: "/srv/a:alpha,/opt/b:beta" });
    assert.deepEqual(cfg.documents?.paths, [
      { path: "/srv/a", name: "alpha" },
      { path: "/opt/b", name: "beta" },
    ]);
  });
  it("splits on the LAST colon (paths may contain colons; documented limitation)", () => {
    const cfg: any = {};
    applyEnvOverrides(cfg, { MEMEX_DOC_PATHS: "/foo:bar:baz" });
    assert.deepEqual(cfg.documents?.paths, [{ path: "/foo:bar", name: "baz" }]);
  });
  it("omitting leaves config untouched", () => {
    const cfg: any = { documents: { paths: [{ path: "/x", name: "x" }] } };
    applyEnvOverrides(cfg, {});
    assert.equal(cfg.documents.paths.length, 1, "existing config preserved");
  });
});
