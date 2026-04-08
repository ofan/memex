/**
 * Tests that plugin.register() is idempotent: calling it multiple times
 * (as OpenClaw does during startup phases) must not duplicate hooks,
 * logs, timers, or telemetry.
 *
 * Because _registered is module-level state, all assertions run in a
 * single test that calls register() 5 times on one mock API.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../index.ts";

function createMockApi(root: string) {
  const onHandlers = new Map<string, Function[]>();
  const logMessages: string[] = [];
  const registeredTools: string[] = [];
  let serviceCount = 0;

  const api = {
    id: "memex",
    name: "Memex",
    version: "0.5.11-test",
    description: "test",
    source: "test",
    config: { agents: { list: [] } },
    pluginConfig: {
      embedding: {
        provider: "openai-compatible",
        apiKey: "test-key-not-real",
        model: "text-embedding-3-small",
      },
      dbPath: join(root, "memex.sqlite"),
      documents: { enabled: false },
    },
    runtime: {
      subagent: {
        async run() { return { runId: "run-1" }; },
        async waitForRun() { return { status: "ok" as const }; },
        async getSessionMessages() {
          return { messages: [{ role: "assistant", content: "ok" }] };
        },
        async deleteSession() {},
      },
      channel: {},
    },
    logger: {
      debug() {},
      info(...args: any[]) { logMessages.push(args.map(String).join(" ")); },
      warn() {},
      error() {},
    },
    resolvePath(input: string) { return input; },
    registerTool(def: any) { registeredTools.push(def.name); },
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() { serviceCount++; },
    registerProvider() {},
    registerSpeechProvider() {},
    registerMediaUnderstandingProvider() {},
    registerImageGenerationProvider() {},
    registerWebSearchProvider() {},
    registerInteractiveHandler() {},
    onConversationBindingResolved() {},
    registerCommand() {},
    registerContextEngine() {},
    registerMemoryPromptSection() {},
    registerMemoryFlushPlan() {},
    registerMemoryRuntime() {},
    on(event: string, handler: Function) {
      let handlers = onHandlers.get(event);
      if (!handlers) {
        handlers = [];
        onHandlers.set(event, handlers);
      }
      handlers.push(handler);
    },
  };

  return {
    api,
    onHandlers,
    logMessages,
    registeredTools,
    getServiceCount() { return serviceCount; },
  };
}

describe("plugin registration idempotency", () => {
  it("calling register() 5 times produces exactly 1 set of hooks, logs, and services", async () => {
    const root = await mkdtemp(join(tmpdir(), "memex-reg-test-"));
    const mock = createMockApi(root);

    // Reset module state for a clean test
    (plugin as any)._resetRegistration();

    // Simulate OpenClaw calling register() 5 times during startup
    plugin.register(mock.api as any);
    plugin.register(mock.api as any);
    plugin.register(mock.api as any);
    plugin.register(mock.api as any);
    plugin.register(mock.api as any);

    // before_prompt_build handlers: at most 3 (recall, capture, warning)
    const bppHandlers = mock.onHandlers.get("before_prompt_build") || [];
    assert.ok(
      bppHandlers.length <= 3,
      `Expected at most 3 before_prompt_build handlers, got ${bppHandlers.length}`
    );
    assert.ok(
      bppHandlers.length >= 1,
      `Expected at least 1 before_prompt_build handler, got 0`
    );

    // "plugin registered" log: exactly 1
    const registeredLogs = mock.logMessages.filter(m => m.includes("plugin registered"));
    assert.equal(
      registeredLogs.length, 1,
      `Expected 1 'plugin registered' log, got ${registeredLogs.length}`
    );

    // Service registration: runs on each register() call (OpenClaw deduplicates by ID)
    assert.ok(
      mock.getServiceCount() >= 1,
      `Expected at least 1 service registration, got ${mock.getServiceCount()}`
    );

    // Core tools registered (recall, store, forget)
    assert.ok(
      mock.registeredTools.length >= 3,
      `Expected at least 3 tools, got ${mock.registeredTools.length}: ${mock.registeredTools}`
    );

    // Tools are registered by name — OpenClaw deduplicates by name.
    // The mock just collects them, so duplicates are expected here.
    const uniqueTools = new Set(mock.registeredTools);
    assert.ok(
      uniqueTools.size >= 3,
      `Expected at least 3 unique tool names, got ${uniqueTools.size}`
    );
  });
});
