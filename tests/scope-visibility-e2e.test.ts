/**
 * Scope-visibility E2E (#7): readable project name + client dimension.
 *
 * Validates that deriveScopes emits a human-readable project_name (alongside the
 * stable project:<hash> filter key) and that explicit.client creates a client:
 * scope tag — answering "which project / which client" without losing the stable
 * hash-based isolation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveScopes } from "../src/scope-derive.js";

describe("E2E: scope-visibility — readable project name + client dimension", () => {
  it("deriveScopes emits a readable project_name from the git remote (this repo)", () => {
    const deriv = deriveScopes({ cwd: process.cwd() }); // the memex repo checkout
    assert.ok(deriv.metadata.project_name, "project_name should be set for a git repo");
    assert.equal(typeof deriv.metadata.project_name, "string");
    // The stable filter key is unchanged — project:<hash> still emitted.
    assert.ok(deriv.tags.some(t => t.startsWith("project:")), "project:<hash> tag still present");
  });

  it("explicit.client emits a client: scope tag + records metadata.client", () => {
    const deriv = deriveScopes({ cwd: process.cwd(), explicit: { client: "claude-code" } });
    assert.ok(deriv.tags.includes("client:claude-code"), "client:claude-code tag should be emitted");
    assert.equal(deriv.metadata.client, "claude-code");
  });

  it("without explicit.client, client stays provenance-only (no client: tag)", () => {
    const deriv = deriveScopes({ cwd: process.cwd() });
    assert.ok(!deriv.tags.some(t => t.startsWith("client:")), "no client: tag without explicit client");
  });
});
