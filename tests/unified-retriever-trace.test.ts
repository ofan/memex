/**
 * Per-query debug trace for UnifiedRetriever (plan: feat/recall-debug-trace).
 * Verifies captureTrace records the unified pipeline stages (memory-fusion,
 * merge, diversity) with the caller-supplied debugId, and is null when off.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";
import { UnifiedRetriever } from "../src/unified-retriever.js";
import type { Embedder } from "../src/embedder.js";

const DIM = 16;
function embed(text: string): number[] {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  const v = Array.from({ length: DIM }, (_, i) => Math.sin((h + i) * 0.1));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / (n || 1));
}
const embedder = {
  dimensions: DIM,
  embedQuery: async (t: string) => embed(t),
  embedDocument: async (t: string) => embed(t),
  embedPassage: async (t: string) => embed(t),
  embedBatchQuery: async (ts: string[]) => ts.map(embed),
  embedBatchPassage: async (ts: string[]) => ts.map(embed),
} as any as Embedder;

async function seed(store: MemoryStore, texts: string[]) {
  for (const text of texts) {
    await store.store({
      text, vector: await embedder.embedDocument(text),
      category: "fact", importance: 0.7, scope: "global",
    } as any);
  }
}

describe("UnifiedRetriever debug trace", () => {
  it("is null when captureTrace is off", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ur-trace-off-"));
    const store = new MemoryStore({ dbPath: join(tmp, "m.sqlite"), vectorDim: DIM });
    await seed(store, ["deploy process uses flux and kustomize", "theme color is blue"]);
    const r = new UnifiedRetriever(store, null, embedder);
    await r.retrieve("what is the deploy process");
    assert.equal(r.lastTrace, null);
    store.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("records memory-fusion + merge + diversity stages with the caller debugId", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ur-trace-on-"));
    const store = new MemoryStore({ dbPath: join(tmp, "m.sqlite"), vectorDim: DIM });
    await seed(store, ["deploy process uses flux and kustomize", "theme color is blue", "unrelated zzz garbage"]);
    const r = new UnifiedRetriever(store, null, embedder, { captureTrace: true });
    const results = await r.retrieve("what is the deploy process", { debugId: "abcd1234" });

    const trace = r.lastTrace;
    assert.ok(trace, "lastTrace populated when captureTrace is on");
    assert.equal(trace!.pipeline, "unified");
    assert.equal(trace!.debugId, "abcd1234", "caller-supplied debugId embedded in trace");
    const names = trace!.stages.map(s => s.name);
    assert.ok(names.includes("memory-fusion"), `memory-fusion stage present; got ${names.join(",")}`);
    assert.ok(names.includes("merge"), `merge stage present; got ${names.join(",")}`);
    assert.ok(names.includes("diversity"), `diversity stage present; got ${names.join(",")}`);
    assert.deepEqual(trace!.finalIds, results.map(x => x.id));

    store.close();
    await rm(tmp, { recursive: true, force: true });
  });
});
