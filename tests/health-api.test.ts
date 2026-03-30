import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../index.ts";

type GatewayHandler = (opts: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
  client: null;
  req: { method: string };
  isWebchatConnect: () => boolean;
  context: Record<string, unknown>;
}) => Promise<void> | void;

async function registerPlugin() {
  const root = await mkdtemp(join(tmpdir(), "memex-plugin-health-"));
  const gatewayMethods = new Map<string, GatewayHandler>();
  let memoryPromptBuilder: ((params: { availableTools: Set<string> }) => string[]) | null = null;
  let memoryFlushPlanResolver: ((params: { cfg?: Record<string, unknown>; nowMs?: number }) => Record<string, unknown> | null) | null = null;
  let memoryRuntime: {
    getMemorySearchManager: (params: Record<string, unknown>) => Promise<{ manager: Record<string, unknown> | null }>;
    resolveMemoryBackendConfig: (params: Record<string, unknown>) => { backend: string };
  } | null = null;

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
        apiKey: "test-key",
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
          return { messages: [{ role: "assistant", content: "No critical memex issues found." }] };
        },
        async deleteSession() {},
      },
      channel: {},
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    resolvePath(input: string) {
      return input;
    },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod(method: string, handler: GatewayHandler) {
      gatewayMethods.set(method, handler);
    },
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerSpeechProvider() {},
    registerMediaUnderstandingProvider() {},
    registerImageGenerationProvider() {},
    registerWebSearchProvider() {},
    registerInteractiveHandler() {},
    onConversationBindingResolved() {},
    registerCommand() {},
    registerContextEngine() {},
    registerMemoryPromptSection(builder: (params: { availableTools: Set<string> }) => string[]) {
      memoryPromptBuilder = builder;
    },
    registerMemoryFlushPlan(
      resolver: (params: { cfg?: Record<string, unknown>; nowMs?: number }) => Record<string, unknown> | null,
    ) {
      memoryFlushPlanResolver = resolver;
    },
    registerMemoryRuntime(runtime: typeof memoryRuntime) {
      memoryRuntime = runtime;
    },
    on() {},
  };

  await plugin.register(api as any);
  return { gatewayMethods, memoryPromptBuilder, memoryFlushPlanResolver, memoryRuntime };
}

async function callGatewayMethod(
  handler: GatewayHandler,
  params: Record<string, unknown>,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const maybePromise = handler({
      params,
      respond(ok, payload, error) {
        if (!ok) reject(error ?? new Error("gateway method failed"));
        else resolve(payload);
      },
      client: null,
      req: { method: "test" },
      isWebchatConnect: () => false,
      context: {},
    });
    Promise.resolve(maybePromise).catch(reject);
  });
}

describe("memex gateway health methods", () => {
  it("registers memex.health and memex.audit_logs", async () => {
    const { gatewayMethods } = await registerPlugin();

    assert.ok(gatewayMethods.has("memex.health"));
    assert.ok(gatewayMethods.has("memex.audit_logs"));
  });

  it("registers a memory prompt section builder", async () => {
    const { memoryPromptBuilder } = await registerPlugin();

    assert.ok(memoryPromptBuilder);
    const section = memoryPromptBuilder!({ availableTools: new Set(["memory_store"]) });
    assert.ok(Array.isArray(section));
    assert.ok(section.length > 0);
  });

  it("registers a memory flush plan for OpenClaw compaction", async () => {
    const { memoryFlushPlanResolver } = await registerPlugin();

    assert.ok(memoryFlushPlanResolver);
    const plan = memoryFlushPlanResolver!({
      cfg: { agents: { defaults: { compaction: { reserveTokensFloor: 12345 } } } },
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0),
    });

    assert.ok(plan);
    assert.equal(plan!.relativePath, "memory/2026-03-29.md");
    assert.equal(plan!.reserveTokensFloor, 12345);
    assert.match(String(plan!.prompt), /memory_store/);
    assert.match(String(plan!.prompt), /NO_REPLY/);
    assert.match(String(plan!.systemPrompt), /memory_store/);
  });

  it("registers a memory runtime for OpenClaw status integration", async () => {
    const { memoryRuntime } = await registerPlugin();

    assert.ok(memoryRuntime);
    assert.equal(memoryRuntime!.resolveMemoryBackendConfig({}).backend, "builtin");

    const { manager } = await memoryRuntime!.getMemorySearchManager({});
    assert.ok(manager);
    assert.equal(typeof manager!.status, "function");
    assert.equal(typeof manager!.probeEmbeddingAvailability, "function");
    assert.equal(typeof manager!.probeVectorAvailability, "function");

    const status = manager!.status() as Record<string, unknown>;
    assert.equal(status.provider, "memex");
    assert.equal(typeof status.files, "number");
    assert.equal(typeof status.chunks, "number");
  });

  it("returns a structured health snapshot", async () => {
    const { gatewayMethods } = await registerPlugin();
    const result = await callGatewayMethod(gatewayMethods.get("memex.health")!, {});

    assert.equal(typeof result, "object");
    assert.equal((result as any).plugin.id, "memex");
    assert.ok(Array.isArray((result as any).checks));
    assert.match(String((result as any).status), /^(ok|warn|fail)$/);
  });

  it("returns an audit summary from the OpenClaw subagent runtime", async () => {
    const { gatewayMethods } = await registerPlugin();
    const result = await callGatewayMethod(gatewayMethods.get("memex.audit_logs")!, {});

    assert.equal((result as any).audit.status, "ok");
    assert.match(String((result as any).audit.conclusion), /No critical memex issues found\./);
    assert.equal(typeof (result as any).health, "object");
  });
});
