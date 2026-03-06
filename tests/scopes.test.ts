/**
 * Tests for src/scopes.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryScopeManager,
  createScopeManager,
  createAgentScope,
  createCustomScope,
  createProjectScope,
  createUserScope,
  parseScopeId,
  isScopeAccessible,
  filterScopesForAgent,
} from "../src/scopes.js";

describe("MemoryScopeManager", () => {
  describe("constructor", () => {
    it("creates with defaults", () => {
      const manager = createScopeManager();
      assert.deepEqual(manager.getAllScopes(), ["global"]);
    });

    it("creates with custom scopes", () => {
      const manager = createScopeManager({
        definitions: {
          "project:myapp": { description: "My App" },
        },
      });
      const scopes = manager.getAllScopes();
      assert.ok(scopes.includes("global"));
      assert.ok(scopes.includes("project:myapp"));
    });

    it("throws if default scope not in definitions", () => {
      assert.throws(() => {
        createScopeManager({ default: "nonexistent", definitions: {} });
      });
    });
  });

  describe("getAccessibleScopes", () => {
    it("returns all scopes when no agentId", () => {
      const manager = createScopeManager({
        definitions: {
          "project:a": { description: "A" },
          "custom:b": { description: "B" },
        },
      });
      const scopes = manager.getAccessibleScopes();
      assert.ok(scopes.includes("global"));
      assert.ok(scopes.includes("project:a"));
      assert.ok(scopes.includes("custom:b"));
    });

    it("returns explicit agent access when configured", () => {
      const manager = createScopeManager({
        definitions: {
          "project:a": { description: "A" },
          "project:b": { description: "B" },
        },
        agentAccess: {
          "agent-x": ["global", "project:a"],
        },
      });
      const scopes = manager.getAccessibleScopes("agent-x");
      assert.deepEqual(scopes, ["global", "project:a"]);
    });

    it("returns default scopes (global + agent:*) when no explicit access", () => {
      const manager = createScopeManager();
      const scopes = manager.getAccessibleScopes("some-agent");
      assert.ok(scopes.includes("global"));
      // agent:some-agent is a built-in pattern, should be included
      assert.ok(scopes.includes("agent:some-agent"));
    });
  });

  describe("getDefaultScope", () => {
    it("returns global when no agentId", () => {
      const manager = createScopeManager();
      assert.equal(manager.getDefaultScope(), "global");
    });

    it("returns agent scope when agent has access to it", () => {
      const manager = createScopeManager();
      assert.equal(manager.getDefaultScope("mybot"), "agent:mybot");
    });
  });

  describe("isAccessible", () => {
    it("allows any valid scope without agentId", () => {
      const manager = createScopeManager();
      assert.equal(manager.isAccessible("global"), true);
      assert.equal(manager.isAccessible("agent:test"), true);
    });

    it("restricts to agent's accessible scopes", () => {
      const manager = createScopeManager({
        definitions: {
          "project:a": { description: "A" },
          "project:b": { description: "B" },
        },
        agentAccess: {
          "agent-x": ["global", "project:a"],
        },
      });
      assert.equal(manager.isAccessible("project:a", "agent-x"), true);
      assert.equal(manager.isAccessible("project:b", "agent-x"), false);
    });
  });

  describe("validateScope", () => {
    it("validates defined scopes", () => {
      const manager = createScopeManager();
      assert.equal(manager.validateScope("global"), true);
    });

    it("validates built-in patterns", () => {
      const manager = createScopeManager();
      assert.equal(manager.validateScope("agent:mybot"), true);
      assert.equal(manager.validateScope("custom:test"), true);
      assert.equal(manager.validateScope("project:app"), true);
      assert.equal(manager.validateScope("user:john"), true);
    });

    it("rejects invalid scopes", () => {
      const manager = createScopeManager();
      assert.equal(manager.validateScope(""), false);
      assert.equal(manager.validateScope("   "), false);
    });
  });

  describe("management methods", () => {
    it("adds scope definitions", () => {
      const manager = createScopeManager();
      manager.addScopeDefinition("custom:new", { description: "New scope" });
      assert.ok(manager.getAllScopes().includes("custom:new"));
    });

    it("removes scope definitions", () => {
      const manager = createScopeManager({
        definitions: { "custom:temp": { description: "Temp" } },
      });
      assert.equal(manager.removeScopeDefinition("custom:temp"), true);
      assert.ok(!manager.getAllScopes().includes("custom:temp"));
    });

    it("prevents removing global scope", () => {
      const manager = createScopeManager();
      assert.throws(() => manager.removeScopeDefinition("global"));
    });

    it("sets and removes agent access", () => {
      const manager = createScopeManager();
      manager.setAgentAccess("bot", ["global"]);
      assert.deepEqual(manager.getAccessibleScopes("bot"), ["global"]);
      manager.removeAgentAccess("bot");
    });
  });

  describe("stats", () => {
    it("returns correct statistics", () => {
      const manager = createScopeManager({
        definitions: {
          "agent:a": { description: "Agent A" },
          "custom:b": { description: "Custom B" },
          "project:c": { description: "Project C" },
        },
        agentAccess: {
          "agent-1": ["global", "agent:a"],
        },
      });

      const stats = manager.getStats();
      assert.equal(stats.totalScopes, 4); // global + 3
      assert.equal(stats.agentsWithCustomAccess, 1);
      assert.equal(stats.scopesByType.global, 1);
      assert.equal(stats.scopesByType.agent, 1);
      assert.equal(stats.scopesByType.custom, 1);
      assert.equal(stats.scopesByType.project, 1);
    });
  });
});

describe("utility functions", () => {
  it("creates scope patterns", () => {
    assert.equal(createAgentScope("bot"), "agent:bot");
    assert.equal(createCustomScope("test"), "custom:test");
    assert.equal(createProjectScope("app"), "project:app");
    assert.equal(createUserScope("john"), "user:john");
  });

  it("parses scope IDs", () => {
    assert.deepEqual(parseScopeId("global"), { type: "global", id: "" });
    assert.deepEqual(parseScopeId("agent:bot"), { type: "agent", id: "bot" });
    assert.deepEqual(parseScopeId("custom:test"), { type: "custom", id: "test" });
    assert.equal(parseScopeId("invalid"), null);
  });

  it("checks scope accessibility", () => {
    assert.equal(isScopeAccessible("global", ["global", "agent:bot"]), true);
    assert.equal(isScopeAccessible("custom:x", ["global"]), false);
  });
});

describe("filterScopesForAgent", () => {
  it("returns all scopes when no scopeManager or agentId", () => {
    const scopes = ["global", "project:a", "custom:b"];
    assert.deepEqual(filterScopesForAgent(scopes), scopes);
    assert.deepEqual(filterScopesForAgent(scopes, "agent-x"), scopes);
    assert.deepEqual(filterScopesForAgent(scopes, undefined, undefined), scopes);
  });

  it("filters to accessible scopes for agent", () => {
    const manager = createScopeManager({
      definitions: {
        "project:a": { description: "A" },
        "project:b": { description: "B" },
      },
      agentAccess: {
        "agent-x": ["global", "project:a"],
      },
    });

    const result = filterScopesForAgent(
      ["global", "project:a", "project:b"],
      "agent-x",
      manager,
    );
    assert.deepEqual(result, ["global", "project:a"]);
  });

  it("returns empty array when agent has no access", () => {
    const manager = createScopeManager({
      definitions: {
        "project:a": { description: "A" },
      },
      agentAccess: {
        "agent-x": ["global"],
      },
    });

    const result = filterScopesForAgent(["project:a"], "agent-x", manager);
    assert.deepEqual(result, []);
  });
});
