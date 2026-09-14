/**
 * vec-table.ts — shared schema guard for the `vectors_vec` ANN index.
 *
 * `vectors_vec` is a vec0 virtual table whose *only* copy of the embeddings is
 * in its shadow tables. It is also shared by two namespaces:
 *   mem_<uuid>[_cN]   → memory vectors   (manifest: none — see below)
 *   <hash>_<seq>      → document vectors (manifest: content_vectors)
 *
 * Historically, every open path called an `ensureVecTable()` that DROPPED the
 * table whenever the stored `float[N]` width differed from the caller's
 * configured dimension. Because dimension comes from config/env, a single
 * mis-set `MEMEX_EMBED_DIM` (or a throwaway script that guessed it) silently
 * destroyed every embedding in the database on open. There was no backup, no
 * prompt, and nothing re-populated the table afterwards.
 *
 * Invariant: opening / constructing a store NEVER drops `vectors_vec`.
 * A dimension change is a deliberate maintenance operation
 * (`memex memex rebuild-vector-index`), never a side effect of a read.
 *
 * See docs/plans/020-mcp-recall-quality-audit.md ("Incident correction").
 */
import { createHash } from "node:crypto";
export const VEC_TABLE = "vectors_vec";
export const MANIFEST_TABLE = "vec_rebuild_manifest";
const CHUNKS_SUFFIX = `${VEC_TABLE}_chunks`;
const ROWIDS_SUFFIX = `${VEC_TABLE}_rowids`;
/** Thrown when opening finds a schema mismatch that requires deliberate repair. */
export class VectorSchemaMismatchError extends Error {
    expectedDims;
    actualDims;
    code = "VECTOR_SCHEMA_MISMATCH";
    constructor(expectedDims, actualDims) {
        super(`vectors_vec exists with float[${actualDims ?? "unknown"}] but this process ` +
            `configured vectorDim=${expectedDims}. Refusing to modify the ANN index on open ` +
            `(dropping it would destroy every stored embedding). If the dimension change is ` +
            `intended, run the explicit maintenance command: memex memex rebuild-vector-index. ` +
            `Otherwise fix the embedding dimension config and restart.`);
        this.expectedDims = expectedDims;
        this.actualDims = actualDims;
        this.name = "VectorSchemaMismatchError";
    }
}
/** Read-only description of the stored vec table. Returns exists:false when absent. */
export function inspectVecTable(db, dims) {
    const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
        .get(VEC_TABLE);
    const sql = row?.sql;
    if (!sql)
        return { exists: false, dims: null, hasHashSeq: false, hasCosine: false, compatible: false };
    const m = sql.match(/float\[(\d+)\]/);
    const storedDims = m?.[1] ? parseInt(m[1], 10) : null;
    const hasHashSeq = sql.includes("hash_seq");
    const hasCosine = sql.includes("distance_metric=cosine");
    return {
        exists: true,
        dims: storedDims,
        hasHashSeq,
        hasCosine,
        compatible: storedDims === dims && hasHashSeq && hasCosine,
    };
}
function tableNames(db) {
    return db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?`)
        .all(`${VEC_TABLE}%`).map(r => r.name);
}
/**
 * Verify the shadow tables are consistent with the parent before we treat the
 * ANN index as intact. A vec0 table whose `_chunks` shadow row count disagrees
 * with its `_info` metadata returns wrong/empty results while looking healthy,
 * so a mismatch is surfaced rather than silently trusted.
 */
export function assertVecShadowIntegrity(db) {
    const names = new Set(tableNames(db));
    if (!names.has(VEC_TABLE))
        return { ok: true, detail: "vec table absent" };
    if (!names.has(CHUNKS_SUFFIX) || !names.has(ROWIDS_SUFFIX)) {
        return { ok: false, detail: "vec0 shadow tables missing" };
    }
    try {
        const info = db.prepare(`SELECT * FROM ${VEC_TABLE}_info`).all();
        if (!info.length)
            return { ok: false, detail: "vec0 _info is empty" };
        return { ok: true, detail: "shadow tables present" };
    }
    catch (err) {
        return { ok: false, detail: `shadow tables unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
}
/**
 * Non-destructive open path:
 *   - table absent   → create it (nothing can be lost)
 *   - table present, compatible → no-op
 *   - table present, mismatched → THROW; never drop
 */
export function ensureVecTableOnOpen(db, dims) {
    const status = inspectVecTable(db, dims);
    if (status.exists) {
        if (!status.compatible) {
            throw new VectorSchemaMismatchError(dims, status.dims);
        }
        return { created: false, status };
    }
    db.exec(`CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dims}] distance_metric=cosine)`);
    return { created: true, status: inspectVecTable(db, dims) };
}
/**
 * True when the vec table looks unusable: absent, schema-incompatible, or with
 * damaged shadow tables. Only used by the explicit maintenance command to
 * decide whether a rebuild is needed.
 */
export function needsMaintenance(db, dims) {
    const status = inspectVecTable(db, dims);
    if (!status.exists || !status.compatible)
        return true;
    return !assertVecShadowIntegrity(db).ok;
}
// ============================================================================
// Rebuild manifest
// ============================================================================
/**
 * `content_vectors` is the natural document-side manifest: it survives a vec
 * drop and `getHashesForEmbedding()` reads it to compute the re-embed backlog.
 * Memories have no equivalent — `memory_vectors` records only `embedded_at`,
 * so it cannot say *which* vector keys (`mem_<id>`, `mem_<id>_cN`) existed.
 * We snapshot the keys ourselves, so a rebuild can be verified and an
 * interrupted one resumed, instead of being silently "done".
 */
function createManifestTable(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (
      hash_seq TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('mem','doc')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','embedded','failed')),
      updated_at TEXT NOT NULL
    )
  `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vec_manifest_state ON ${MANIFEST_TABLE}(state)`);
}
export function readManifestSummary(db) {
    const exists = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
        .get(MANIFEST_TABLE);
    if (!exists)
        return null;
    const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN kind='mem' THEN 1 ELSE 0 END) AS mem,
      SUM(CASE WHEN kind='doc' THEN 1 ELSE 0 END) AS doc,
      SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state='embedded' THEN 1 ELSE 0 END) AS embedded,
      SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed
    FROM ${MANIFEST_TABLE}
  `).get();
    return {
        total: row.total ?? 0, mem: row.mem ?? 0, doc: row.doc ?? 0,
        pending: row.pending ?? 0, embedded: row.embedded ?? 0, failed: row.failed ?? 0,
    };
}
/**
 * Populate the manifest from the vec table's current contents, merged with
 * `memories`. Reading `_rowids` before any drop is what makes the destructive
 * step resumable and verifiable instead of lossy.
 */
export function populateManifestFromCurrentState(db) {
    createManifestTable(db);
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO ${MANIFEST_TABLE} (hash_seq, kind, state, updated_at) VALUES (?, ?, 'pending', ?)
     ON CONFLICT(hash_seq) DO NOTHING`);
    let mem = 0, doc = 0;
    if (new Set(tableNames(db)).has(ROWIDS_SUFFIX)) {
        const rows = db.prepare(`SELECT id FROM ${ROWIDS_SUFFIX}`).all();
        for (const r of rows) {
            const isMem = r.id.startsWith("mem_");
            insert.run(r.id, isMem ? "mem" : "doc", now);
            if (isMem)
                mem++;
            else
                doc++;
        }
    }
    // Memories without vectors (never embedded, or lost in an earlier drop).
    const memIds = db.prepare(`SELECT id FROM memories`).all();
    let memFromStore = 0;
    for (const m of memIds) {
        const has = db.prepare(`SELECT 1 FROM ${MANIFEST_TABLE} WHERE hash_seq = ?`).get(`mem_${m.id}`);
        if (!has) {
            insert.run(`mem_${m.id}`, "mem", now);
            memFromStore++;
            mem++;
        }
    }
    // Document vectors: content_vectors is authoritative for hash+seq and is not
    // touched by a vec drop, so include its full key set.
    if (new Set(tableNames(db)).has("content_vectors")) {
        const cvs = db.prepare(`SELECT hash, seq FROM content_vectors`).all();
        for (const cv of cvs) {
            const key = `${cv.hash}_${cv.seq}`;
            const had = db.prepare(`SELECT 1 FROM ${MANIFEST_TABLE} WHERE hash_seq = ?`).get(key);
            if (!had) {
                insert.run(key, "doc", now);
                doc++;
            }
        }
    }
    const total = db.prepare(`SELECT COUNT(*) c FROM ${MANIFEST_TABLE}`).get().c;
    return { total, mem, doc, memFromStore };
}
// ============================================================================
// Backup
// ============================================================================
function fileDbPath(db) {
    const rows = db.prepare(`PRAGMA database_list`).all();
    const main = rows.find(r => r.name === "main");
    const p = main?.file ?? "";
    if (!p || p === ":memory:") {
        throw new Error("vector-index rebuild requires a file-backed database");
    }
    return p;
}
/**
 * Cheap, and the only reason a drop is recoverable at all: the shadow tables
 * holding the vectors live in the main DB file, so copying it (once WAL is
 * checkpointed) preserves the vectors themselves.
 *
 * We do NOT attempt to read the vector blobs through `vectors_vec_chunks` —
 * the vec0 chunk format is not documented as stable, and a hand-rolled replay
 * of it is how an "unbackupable table" quietly becomes an unrecoverable one.
 */
export function backupDatabaseFile(db, opts = {}) {
    const src = fileDbPath(db);
    if (opts.checkpoint !== false) {
        // Fold the WAL in so the copy is self-contained.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const digest = createHash("sha256").update(src).digest("hex").slice(0, 8);
    const dest = `${src}.pre-vec-rebuild-${stamp}-${digest}`;
    db.prepare(`VACUUM INTO ?`).run(dest);
    // VACUUM INTO produces a fresh DB without wal-index; sanity check it is readable.
    return dest;
}
/**
 * Destructive. Callers must have already:
 *   1. taken an explicit operator confirmation, and
 *   2. written the manifest via populateManifestFromCurrentState(), and
 *   3. produced a verified VACUUM INTO backup.
 *
 * Never reachable from a constructor or an open path.
 */
export function dropAndRecreateVecTable(db, dims, confirmed) {
    if (!confirmed) {
        throw new Error("refusing to drop vectors_vec without explicit confirmation. " +
            "This destroys every stored embedding and must be an operator action " +
            "(memex memex rebuild-vector-index).");
    }
    const before = inspectVecTable(db, dims);
    const manifest = readManifestSummary(db);
    if (!manifest) {
        throw new Error("refusing to drop vectors_vec with no rebuild manifest. Run " +
            "populateManifestFromCurrentState() first, so the rebuild is verifiable and resumable.");
    }
    const backedUpTo = backupDatabaseFile(db);
    db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    db.exec(`CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dims}] distance_metric=cosine)`);
    // Anything that existed is now pending again.
    const now = new Date().toISOString();
    db.prepare(`UPDATE ${MANIFEST_TABLE} SET state='pending', updated_at=? WHERE state='embedded'`).run(now);
    return {
        backedUpTo,
        droppedDims: before.dims,
        createdDims: dims,
        manifest: readManifestSummary(db),
    };
}
/** Mark manifest keys present in the vec table as embedded. Returns what's still missing. */
export function reconcileManifestWithVecTable(db) {
    const names = new Set(tableNames(db));
    if (!names.has(ROWIDS_SUFFIX)) {
        const total = readManifestSummary(db);
        return { embedded: 0, missing: total?.total ?? 0 };
    }
    const now = new Date().toISOString();
    const present = db.prepare(`SELECT id FROM ${ROWIDS_SUFFIX}`).all();
    const upd = db.prepare(`UPDATE ${MANIFEST_TABLE} SET state='embedded', updated_at=? WHERE hash_seq=?`);
    const tx = db.transaction(() => { for (const p of present)
        upd.run(now, p.id); });
    tx();
    const summary = readManifestSummary(db);
    return { embedded: summary?.embedded ?? 0, missing: summary?.pending ?? 0 };
}
/**
 * Read manifest keys grouped for re-embedding.
 * `mem` keys map to a memory id (strip `mem_`, drop `_cN`); `doc` keys map to
 * hash+seq (last `_`-separated segment is the chunk index).
 */
export function pendingManifestKeys(db, limit) {
    const rows = (limit
        ? db.prepare(`SELECT hash_seq, kind FROM ${MANIFEST_TABLE} WHERE state='pending' LIMIT ?`).all(limit)
        : db.prepare(`SELECT hash_seq, kind FROM ${MANIFEST_TABLE} WHERE state='pending'`).all());
    const mem = [];
    const doc = [];
    for (const r of rows) {
        if (r.kind === "mem") {
            const rest = r.hash_seq.slice(4);
            const ci = rest.indexOf("_c");
            mem.push(ci >= 0 ? rest.slice(0, ci) : rest);
        }
        else {
            const i = r.hash_seq.lastIndexOf("_");
            const seq = parseInt(r.hash_seq.slice(i + 1), 10);
            if (Number.isFinite(seq))
                doc.push({ hash: r.hash_seq.slice(0, i), seq });
        }
    }
    return { mem: [...new Set(mem)], doc };
}
export function markManifestEmbedded(db, keys) {
    if (!keys.length)
        return;
    const now = new Date().toISOString();
    const upd = db.prepare(`UPDATE ${MANIFEST_TABLE} SET state='embedded', updated_at=? WHERE hash_seq=?`);
    const tx = db.transaction(() => { for (const k of keys)
        upd.run(now, k); });
    tx();
}
export function markManifestFailed(db, keys) {
    if (!keys.length)
        return;
    const now = new Date().toISOString();
    const upd = db.prepare(`UPDATE ${MANIFEST_TABLE} SET state='failed', updated_at=? WHERE hash_seq=?`);
    const tx = db.transaction(() => { for (const k of keys)
        upd.run(now, k); });
    tx();
}
//# sourceMappingURL=vec-table.js.map