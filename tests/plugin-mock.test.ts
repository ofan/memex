/**
 * Tests for tests/helpers/plugin-mock.ts
 *
 * Tests the mock OpenClaw Plugin API used by the benchmark harness.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMockPluginApi } from "./helpers/plugin-mock.js";
import { buildRecallContext, MEMORY_INSTRUCTION } from "../src/memory-instructions.js";

// ============================================================================
// Tests
// ============================================================================

describe("createMockPluginApi", () => {
  describe("identity", () => {
    it("provides mock identity with pluginId, pluginName, and pluginVersion", () => {
      const api = createMockPluginApi();
      assert.ok(api.identity.pluginId);
      assert.ok(api.identity.pluginName);
      assert.ok(api.identity.pluginVersion);
      assert.equal(typeof api.identity.pluginId, "string");
      assert.equal(typeof api.identity.pluginName, "string");
      assert.equal(typeof api.identity.pluginVersion, "string");
    });
  });

  describe("registerTool / getRegisteredTool", () => {
    it("registers a tool and retrieves it by name", () => {
      const api = createMockPluginApi();
      const toolDef = {
        name: "test_tool",
        label: "Test Tool",
        description: "A tool for testing",
        parameters: { type: "object", properties: { q: { type: "string" } } },
        execute: async (_id: string, _params: any) => ({ result: "ok" }),
      };

      api.registerTool(toolDef);
      const retrieved = api.getRegisteredTool("test_tool");

      assert.ok(retrieved);
      assert.equal(retrieved!.name, "test_tool");
      assert.equal(retrieved!.label, "Test Tool");
      assert.equal(retrieved!.description, "A tool for testing");
      assert.deepEqual(retrieved!.parameters, toolDef.parameters);
    });

    it("returns undefined for an unregistered tool", () => {
      const api = createMockPluginApi();
      assert.equal(api.getRegisteredTool("nonexistent"), undefined);
    });

    it("registers multiple tools and retrieves each independently", () => {
      const api = createMockPluginApi();
      const makeTool = (name: string) => ({
        name,
        label: name,
        description: `Tool ${name}`,
        parameters: {},
        execute: async () => name,
      });

      api.registerTool(makeTool("alpha"));
      api.registerTool(makeTool("beta"));
      api.registerTool(makeTool("gamma"));

      assert.equal(api.getRegisteredTool("alpha")!.name, "alpha");
      assert.equal(api.getRegisteredTool("beta")!.name, "beta");
      assert.equal(api.getRegisteredTool("gamma")!.name, "gamma");
    });
  });

  describe("executeTool", () => {
    it("executes a registered tool with params and returns the result", async () => {
      const api = createMockPluginApi();
      api.registerTool({
        name: "echo",
        label: "Echo",
        description: "Echoes input",
        parameters: {},
        execute: async (_id: string, params: any) => ({ echo: params.message }),
      });

      const result = await api.executeTool("echo", { message: "hello" });
      assert.deepEqual(result, { echo: "hello" });
    });

    it("passes a generated toolCallId to the execute function", async () => {
      const api = createMockPluginApi();
      let capturedId = "";
      api.registerTool({
        name: "capture_id",
        label: "Capture ID",
        description: "Captures the tool call ID",
        parameters: {},
        execute: async (id: string, _params: any) => {
          capturedId = id;
          return {};
        },
      });

      await api.executeTool("capture_id", {});
      assert.ok(capturedId.length > 0, "toolCallId should be a non-empty string");
    });

    it("throws on executing an unregistered tool", async () => {
      const api = createMockPluginApi();
      await assert.rejects(
        () => api.executeTool("missing_tool", {}),
        (err: Error) => {
          assert.ok(err.message.includes("missing_tool"));
          return true;
        }
      );
    });
  });

  describe("onEvent / getEventHandlers", () => {
    it("records event handlers and retrieves them by event name", () => {
      const api = createMockPluginApi();
      const handler1 = () => {};
      const handler2 = () => {};

      api.onEvent("beforeRecall", handler1);
      api.onEvent("beforeRecall", handler2);

      const handlers = api.getEventHandlers("beforeRecall");
      assert.equal(handlers.length, 2);
      assert.equal(handlers[0], handler1);
      assert.equal(handlers[1], handler2);
    });

    it("returns an empty array for events with no handlers", () => {
      const api = createMockPluginApi();
      const handlers = api.getEventHandlers("nonexistent_event");
      assert.deepEqual(handlers, []);
    });

    it("keeps handlers for different events separate", () => {
      const api = createMockPluginApi();
      const h1 = () => "a";
      const h2 = () => "b";

      api.onEvent("start", h1);
      api.onEvent("stop", h2);

      assert.equal(api.getEventHandlers("start").length, 1);
      assert.equal(api.getEventHandlers("stop").length, 1);
      assert.equal(api.getEventHandlers("start")[0], h1);
      assert.equal(api.getEventHandlers("stop")[0], h2);
    });
  });
});

// ============================================================================
// buildRecallContext — memories only (no instructions)
// ============================================================================

describe("buildRecallContext", () => {
  const memories = "- [fact:global] User prefers dark mode (85%)";

  it("wraps memories in relevant-memories tags", () => {
    const ctx = buildRecallContext(memories);
    assert.ok(ctx.includes("<relevant-memories>"));
    assert.ok(ctx.includes("</relevant-memories>"));
    assert.ok(ctx.includes(memories));
  });

  it("does not include memory-instructions (moved to system prompt)", () => {
    const ctx = buildRecallContext(memories);
    assert.ok(!ctx.includes("<memory-instructions>"));
  });

  it("includes untrusted data warning", () => {
    const ctx = buildRecallContext(memories);
    assert.ok(ctx.includes("UNTRUSTED DATA"));
  });
});

// ============================================================================
// MEMORY_INSTRUCTION
// ============================================================================

describe("MEMORY_INSTRUCTION", () => {
  it("encourages storing and fixing memories", () => {
    assert.ok(MEMORY_INSTRUCTION.includes("store it"));
    assert.ok(MEMORY_INSTRUCTION.includes("outdated"));
  });

  it("does not name specific tools", () => {
    assert.ok(!MEMORY_INSTRUCTION.includes("memory_store"));
    assert.ok(!MEMORY_INSTRUCTION.includes("memory_forget"));
  });
});
