/**
 * Plan Task 3 (+ visibility amendment): UnifiedRetriever collections forwarding
 * + memory-always-runs (B2) + B4 precedence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";
import { UnifiedRetriever } from "../src/unified-retriever.js";

const embed = (t: string) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return Array.from({ length: 16 }, (_, i) => Math.sin((h + i) * 0.1)); };
const embedder = { dimensions: 16, embedQuery: async (t: string) => embed(t), embedPassage: async (t: string) => embed(t) } as any;

describe("UnifiedRetriever collections (B2/B4)", () => {
  it("omitting collections => documentSearchFn called with undefined (visibility resolution is the fn's job)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ur-gate-"));
    const store = new MemoryStore({ dbPath: join(dir, "m.sqlite"), vectorDim: 16 });
    let received: any;
    const docSearch = async (_q: string, _v: number[], _l: number, _c?: string, colls?: string[]) => { received = colls; return []; };
    const r = new UnifiedRetriever(store, docSearch as any, embedder);
    await (r.retrieve as any)("search for documents about config");
    assert.equal(received, undefined, "collections forwarded as undefined when omitted");
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  it("named collections => forwarded verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ur-named-"));
    const store = new MemoryStore({ dbPath: join(dir, "m.sqlite"), vectorDim: 16 });
    let received: any;
    const docSearch = async (_q: string, _v: number[], _l: number, _c?: string, colls?: string[]) => { received = colls; return []; };
    const r = new UnifiedRetriever(store, docSearch as any, embedder);
    await (r.retrieve as any)("search for documents about config", { collections: ["a", "b"] });
    assert.deepEqual(received, ["a", "b"]);
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  it("memory always runs for DOC_PATTERNS queries even with empty doc store (B2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ur-b2-"));
    const store = new MemoryStore({ dbPath: join(dir, "m.sqlite"), vectorDim: 16 });
    await store.store({ text: "the readme documents the deploy step", vector: await embedder.embedPassage("the readme documents the deploy step"), category: "fact", importance: 0.7, scope: "global" } as any);
    const r = new UnifiedRetriever(store, (async () => []) as any, embedder);
    const res = await (r.retrieve as any)("what does the readme say", { collections: ["x"] });
    assert.ok(res.some((x: any) => x.source === "conversation"), "memory returned despite DOC_PATTERNS (B2)");
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  it("B4: when both collection and collections set, collections wins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ur-b4-"));
    const store = new MemoryStore({ dbPath: join(dir, "m.sqlite"), vectorDim: 16 });
    let received: any;
    const docSearch = async (_q: string, _v: number[], _l: number, _c?: string, colls?: string[]) => { received = colls; return []; };
    const r = new UnifiedRetriever(store, docSearch as any, embedder);
    await (r.retrieve as any)("search for documents about config", { collection: "single", collections: ["a", "b"] });
    assert.deepEqual(received, ["a", "b"], "collections takes precedence over collection (B4)");
    store.close(); await rm(dir, { recursive: true, force: true });
  });
});
