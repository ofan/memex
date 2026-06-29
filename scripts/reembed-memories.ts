/**
 * scripts/reembed-memories.ts — backfill missing memory embeddings.
 *
 * A text-only restore (e.g. the untracked restore-memories.js) rebuilds the
 * `memories` table without inserting the matching `mem_<id>` rows into
 * `vectors_vec`. Those memories are then invisible to vector/hybrid recall
 * (vectorSearch filters hash_seq LIKE 'mem_%'), so recall degrades to BM25-only.
 *
 * This script finds memories lacking an embedding, embeds their text with the
 * SAME embedder config the MCP daemon uses (MEMEX_EMBED_* env), and inserts the
 * `mem_<id>` vectors. Idempotent: memories that already have a vector are skipped.
 *
 * Run it exactly like the daemon so `op run` resolves the embed API key:
 *   set -a; . ~/.config/systemd/user/memex.env; set +a
 *   op run -- node --import jiti/register scripts/reembed-memories.ts [opts]
 *
 * Options:
 *   --db PATH     DB path (default: MEMEX_DB_PATH or ~/.openclaw/memory/memex/memex.sqlite)
 *   --batch N     embeddings per request (default 16)
 *   --limit N     embed only the first N missing memories (sanity check)
 *   --dry-run     validate embedder + report counts, insert nothing
 */
import { openDatabase, loadSqliteVec, type Database } from "../src/db.js";
import { createEmbedder, type Embedder } from "../src/embedder.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** Parse a `mem_<uuid>[_cN]` vector key down to its memory uuid (mirrors vectorSearch). */
function vectorKeyToId(hashSeq: string): string | undefined {
  if (!hashSeq.startsWith("mem_")) return undefined;
  const rest = hashSeq.slice(4);
  const ci = rest.indexOf("_c");
  return ci >= 0 ? rest.slice(0, ci) : rest;
}

async function main(): Promise<void> {
  const home = process.env.HOME || "";
  const dbPath = arg("db") || process.env.MEMEX_DB_PATH || `${home}/.openclaw/memory/memex/memex.sqlite`;
  const batchN = Math.max(1, parseInt(arg("batch") || "16", 10));
  const limit = parseInt(arg("limit") || "0", 10) || undefined;
  const dryRun = has("dry-run");

  // Embedder config — mirrors mcp-server.ts main() so embeddings match the query path.
  const endpoint = process.env.MEMEX_EMBED_ENDPOINT;
  const apiKey = process.env.MEMEX_EMBED_API_KEY || "";
  const model = process.env.MEMEX_EMBED_MODEL || "default";
  const dim = parseInt(process.env.MEMEX_EMBED_DIM || "0", 10) || undefined;
  if (!endpoint) {
    console.error("reembed: MEMEX_EMBED_ENDPOINT not set (source memex.env and run via `op run`)");
    process.exit(1);
  }
  const baseURL = endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`;
  const embedder: Embedder = createEmbedder({
    provider: "openai-compatible",
    baseURL,
    apiKey,
    model,
    ...(dim ? { dimensions: dim } : {}),
  });

  const db: Database = openDatabase(dbPath);
  loadSqliteVec(db);

  // Which memories already have a mem_<id> vector?
  const allKeys = (db.prepare("SELECT hash_seq FROM vectors_vec").all() as { hash_seq: string }[])
    .map(r => r.hash_seq);
  const embedded = new Set<string>();
  for (const k of allKeys) {
    const id = vectorKeyToId(k);
    if (id) embedded.add(id);
  }
  const allMems = db.prepare("SELECT id, text FROM memories").all() as { id: string; text: string }[];
  let missing = allMems.filter(m => !embedded.has(m.id));
  console.error(`reembed: ${allMems.length} memories, ${embedded.size} already embedded, ${missing.length} missing`);

  if (limit && missing.length > limit) missing = missing.slice(0, limit);
  if (missing.length === 0) {
    console.error("reembed: nothing to do");
    db.close();
    return;
  }

  // Validate the embedder and dimension before touching anything.
  const probe = await embedder.test();
  console.error(`reembed: embedder ${probe.success ? "ok" : "FAIL"} (dim=${probe.dimensions}, model=${model})`);
  if (!probe.success) {
    console.error("reembed: embedder test failed:", probe.error);
    db.close();
    process.exit(1);
  }
  if (dim && probe.dimensions !== dim) {
    console.error(`reembed: dimension mismatch — env MEMEX_EMBED_DIM=${dim} but embedder returns ${probe.dimensions}`);
    db.close();
    process.exit(1);
  }

  if (dryRun) {
    console.error(`reembed: dry-run — would embed ${missing.length} memories, inserting nothing`);
    db.close();
    return;
  }

  // Embed + insert in batches. Each batch is a transaction; a failed batch leaves
  // all its rows missing, so a re-run retries them (idempotent).
  const insert = db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)");
  let done = 0;
  let failed = 0;
  for (let i = 0; i < missing.length; i += batchN) {
    const chunk = missing.slice(i, i + batchN);
    try {
      const vecs = await embedder.embedBatchPassage(chunk.map(m => m.text));
      const tx = db.transaction(() => {
        for (let j = 0; j < chunk.length; j++) {
          insert.run(`mem_${chunk[j].id}`, new Float32Array(vecs[j]));
        }
      });
      tx();
      done += chunk.length;
    } catch (err: unknown) {
      failed += chunk.length;
      console.error(`reembed: batch @${i} failed (${err instanceof Error ? err.message : err})`);
    }
    console.error(`reembed: progress ${Math.min(i + batchN, missing.length)}/${missing.length}`);
  }

  console.error(`reembed: done — embedded ${done}, failed ${failed}`);
  db.close();
}

main().catch((err) => {
  console.error("reembed: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
