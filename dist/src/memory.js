/**
 * SQLite-backed Memory Store
 *
 * Uses SQLite + sqlite-vec + FTS5 for conversation memory storage.
 * Shares the same database schema as QMD document search (SQLite consolidation).
 */
import { randomUUID, createHash } from "node:crypto";
import { existsSync, accessSync, constants, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDatabase, loadSqliteVec } from "./db.js";
import { buildFTS5Query } from "./search.js";
import { chunkDocument } from "./chunker.js";
import { extractEntities } from "./entities.js";
import { ensureGraphSchema, createLinks, deleteLinks } from "./graph.js";
// ============================================================================
// Legacy LanceDB loader (for migration only)
// ============================================================================
/**
 * Dynamically load LanceDB. Used only by migration scripts (src/migrate.ts, src/cli.ts).
 * Returns null if @lancedb/lancedb is not installed.
 */
export async function loadLanceDB() {
    try {
        return await import("@lancedb/lancedb");
    }
    catch {
        return null;
    }
}
// ============================================================================
// Utility Functions
// ============================================================================
function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
// ============================================================================
// Storage Path Validation
// ============================================================================
/**
 * Validate and prepare the storage directory before database connection.
 * Resolves symlinks, creates missing directories, and checks write permissions.
 * Returns the resolved absolute path on success, or throws a descriptive error.
 */
export function validateStoragePath(dbPath) {
    let resolvedPath = dbPath;
    // Resolve symlinks (including dangling symlinks)
    try {
        const stats = lstatSync(dbPath);
        if (stats.isSymbolicLink()) {
            try {
                resolvedPath = realpathSync(dbPath);
            }
            catch (err) {
                throw new Error(`dbPath "${dbPath}" is a symlink whose target does not exist.\n` +
                    `  Fix: Create the target directory, or update the symlink to point to a valid path.\n` +
                    `  Details: ${err.code || ""} ${err.message}`);
            }
        }
    }
    catch (err) {
        // Missing path is OK (it will be created below)
        if (err?.code === "ENOENT") {
            // no-op
        }
        else if (typeof err?.message === "string" && err.message.includes("symlink whose target does not exist")) {
            throw err;
        }
        else {
            // Other lstat failures — continue with original path
        }
    }
    // Create directory if it doesn't exist (for parent of db file)
    const parentDir = dirname(resolvedPath);
    if (!existsSync(parentDir)) {
        try {
            mkdirSync(parentDir, { recursive: true });
        }
        catch (err) {
            throw new Error(`Failed to create parent directory "${parentDir}".\n` +
                `  Fix: Ensure the parent directory exists and is writable,\n` +
                `       or create it manually: mkdir -p "${parentDir}"\n` +
                `  Details: ${err.code || ""} ${err.message}`);
        }
    }
    // Also create the path itself if it's a directory reference
    if (!existsSync(resolvedPath)) {
        try {
            mkdirSync(resolvedPath, { recursive: true });
        }
        catch {
            // It's OK if it fails — it might be intended as a file path
        }
    }
    // Check write permissions on the parent directory
    try {
        const checkDir = existsSync(resolvedPath) ? resolvedPath : parentDir;
        accessSync(checkDir, constants.W_OK);
    }
    catch (err) {
        throw new Error(`dbPath directory "${resolvedPath}" is not writable.\n` +
            `  Fix: Check permissions with: ls -la "${dirname(resolvedPath)}"\n` +
            `       Or grant write access: chmod u+w "${resolvedPath}"\n` +
            `  Details: ${err.code || ""} ${err.message}`);
    }
    return resolvedPath;
}
// ============================================================================
// Memory Store
// ============================================================================
export class MemoryStore {
    db;
    config;
    _sqliteVecAvailable = false;
    static CHUNK_THRESHOLD = 1500;
    static CHUNK_CONFIG = {
        maxChunkSize: 1500,
        overlapSize: 200,
        minChunkSize: 200,
        semanticSplit: true,
        maxLinesPerChunk: 40,
    };
    constructor(config) {
        if (config.db) {
            // Shared database instance (unified mode)
            this.config = config;
            this.db = config.db;
        }
        else {
            // Standalone mode — open our own database
            let dbPath = config.dbPath;
            try {
                const stat = lstatSync(dbPath);
                if (stat.isDirectory()) {
                    dbPath = join(dbPath, "memex.sqlite");
                }
            }
            catch {
                // Path doesn't exist yet — that's fine, openDatabase will create it
            }
            this.config = { ...config, dbPath };
            this.db = openDatabase(dbPath);
        }
        // Enable WAL mode and foreign keys
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA foreign_keys = ON");
        // Load sqlite-vec extension
        try {
            loadSqliteVec(this.db);
            this._sqliteVecAvailable = true;
        }
        catch {
            this._sqliteVecAvailable = false;
        }
        // Create memories table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        scope TEXT NOT NULL DEFAULT 'global',
        importance REAL NOT NULL DEFAULT 0.5,
        timestamp INTEGER NOT NULL,
        metadata TEXT
      )
    `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`);
        // Dreaming schema: text_hash for dedup, recall tracking for deep sweep
        this.migrateAddColumn("memories", "text_hash", "TEXT");
        this.migrateAddColumn("memories", "recall_count", "INTEGER DEFAULT 0");
        this.migrateAddColumn("memories", "last_recalled_at", "INTEGER");
        // Backfill text_hash for existing entries (idempotent — only touches NULLs)
        const nullHashes = this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE text_hash IS NULL").get();
        if (nullHashes.c > 0) {
            const rows = this.db.prepare("SELECT id, text FROM memories WHERE text_hash IS NULL").all();
            const update = this.db.prepare("UPDATE memories SET text_hash = ? WHERE id = ?");
            for (const row of rows) {
                const hash = createHash("sha256").update(row.text.trim()).digest("hex");
                update.run(hash, row.id);
            }
        }
        try {
            this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_text_hash ON memories(text_hash)`);
        }
        catch { /* index may already exist or duplicates prevent creation */ }
        // Entity backfill for entries missing entities in metadata
        this.backfillEntities();
        // Entity graph (memory links)
        ensureGraphSchema(this.db);
        this.backfillLinks();
        // FTS5 for BM25 search
        this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, tokenize='porter unicode61'
      )
    `);
        // FTS triggers for auto-sync
        this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
      END
    `);
        this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.rowid;
      END
    `);
        this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF text ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.rowid;
        INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
      END
    `);
        // Metadata key-value store (embedding model tracking, etc.)
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
        // Memory vectors mapping table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        embedded_at TEXT NOT NULL
      )
    `);
        // Create sqlite-vec virtual table
        if (this._sqliteVecAvailable) {
            this.ensureVecTable();
        }
    }
    /** Add a column if it doesn't exist (idempotent migration). */
    migrateAddColumn(table, column, type) {
        const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.some(c => c.name === column)) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
    }
    ensureVecTable() {
        if (!this._sqliteVecAvailable)
            return;
        const tableInfo = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
        if (tableInfo) {
            const match = tableInfo.sql.match(/float\[(\d+)\]/);
            const hasHashSeq = tableInfo.sql.includes('hash_seq');
            const hasCosine = tableInfo.sql.includes('distance_metric=cosine');
            const existingDims = match?.[1] ? parseInt(match[1], 10) : null;
            if (existingDims === this.config.vectorDim && hasHashSeq && hasCosine)
                return;
            // Table exists but wrong schema - need to rebuild
            this.db.exec("DROP TABLE IF EXISTS vectors_vec");
        }
        this.db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${this.config.vectorDim}] distance_metric=cosine)`);
    }
    get dbPath() {
        return this.config.dbPath;
    }
    get hasFtsSupport() {
        return true; // FTS5 is always available with SQLite
    }
    get hasVectorSupport() {
        return this._sqliteVecAvailable;
    }
    get totalMemories() {
        const row = this.db.prepare(`SELECT COUNT(*) as c FROM memories`).get();
        return row.c;
    }
    async store(entry) {
        const text = entry.text?.trim();
        // Guard: reject single-turn conversation fragments (raw dialogue dumps).
        // Multi-turn windows from auto-capture contain multiple [user]/[assistant] lines — allow those.
        if (!text)
            return null;
        const isConversationFragment = /^\[(user|assistant)\]/i.test(text)
            && (text.match(/^\[/gm) || []).length <= 2; // single-turn: at most 2 role tags
        if (isConversationFragment)
            return null;
        // Guard: reject exact text duplicates
        const textHash = createHash("sha256").update(text).digest("hex");
        const existing = this.db.prepare("SELECT id FROM memories WHERE text_hash = ?").get(textHash);
        if (existing)
            return null;
        // Extract entities and merge into metadata
        const entities = extractEntities(text);
        let meta = {};
        try {
            meta = JSON.parse(entry.metadata || "{}");
        }
        catch { }
        meta.entities = entities;
        const fullEntry = {
            ...entry,
            text,
            id: randomUUID(),
            timestamp: Date.now(),
            metadata: JSON.stringify(meta),
        };
        this.insertMemory(fullEntry, textHash);
        // Create entity graph links
        if (entities.length >= 2) {
            try {
                createLinks(this.db, fullEntry.id, entities);
            }
            catch { /* best effort */ }
        }
        return fullEntry;
    }
    async bulkStore(entries) {
        // Filter: reject conversation fragments and dedup by text hash
        const seenHashes = new Set();
        const filtered = [];
        for (const entry of entries) {
            const text = entry.text?.trim();
            if (!text)
                continue;
            const isFragment = /^\[(user|assistant)\]/i.test(text)
                && (text.match(/^\[/gm) || []).length <= 2;
            if (isFragment)
                continue;
            const textHash = createHash("sha256").update(text).digest("hex");
            if (seenHashes.has(textHash))
                continue;
            // Check DB for existing hash
            const existing = this.db.prepare("SELECT id FROM memories WHERE text_hash = ?").get(textHash);
            if (existing)
                continue;
            seenHashes.add(textHash);
            filtered.push({ entry: { ...entry, text }, textHash });
        }
        if (filtered.length === 0)
            return [];
        const fullEntries = filtered.map(({ entry }) => ({
            ...entry,
            id: randomUUID(),
            timestamp: Date.now(),
            metadata: entry.metadata || "{}",
        }));
        const hashes = filtered.map(f => f.textHash);
        const insertMem = this.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const insertVec = this._sqliteVecAvailable
            ? this.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`)
            : null;
        const insertMapping = this.db.prepare(`
      INSERT INTO memory_vectors (memory_id, embedded_at) VALUES (?, ?)
    `);
        const tx = this.db.transaction(() => {
            const now = new Date().toISOString();
            for (let i = 0; i < fullEntries.length; i++) {
                const entry = fullEntries[i];
                insertMem.run(entry.id, entry.text, entry.category, entry.scope, entry.importance, entry.timestamp, entry.metadata, hashes[i]);
                if (insertVec) {
                    insertVec.run(`mem_${entry.id}`, new Float32Array(entry.vector));
                }
                insertMapping.run(entry.id, now);
            }
        });
        tx();
        return fullEntries;
    }
    /**
     * Import a pre-built entry while preserving its id/timestamp.
     * Used for re-embedding / migration / A/B testing across embedding models.
     */
    async importEntry(entry) {
        if (!entry.id || typeof entry.id !== "string") {
            throw new Error("importEntry requires a stable id");
        }
        const vector = entry.vector || [];
        if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
            throw new Error(`Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : 'non-array'}`);
        }
        const full = {
            ...entry,
            scope: entry.scope || "global",
            importance: Number.isFinite(entry.importance) ? entry.importance : 0.7,
            timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
            metadata: entry.metadata || "{}",
        };
        this.insertMemory(full);
        return full;
    }
    async hasId(id) {
        const row = this.db.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(id);
        return row != null;
    }
    async vectorSearch(vector, limit = 5, minScore = 0.3, scopeFilter) {
        if (!this._sqliteVecAvailable)
            return [];
        const safeLimit = clampInt(limit, 1, 20);
        const fetchLimit = Math.min(safeLimit * 10, 200);
        // Step 1: Get vector matches from sqlite-vec (no JOINs — they hang)
        const vecResults = this.db.prepare(`
      SELECT hash_seq, distance
      FROM vectors_vec
      WHERE embedding MATCH ? AND k = ?
    `).all(new Float32Array(vector), fetchLimit);
        if (vecResults.length === 0)
            return [];
        // Filter to memory vectors only (prefix mem_)
        const memResults = vecResults.filter(r => r.hash_seq.startsWith('mem_'));
        if (memResults.length === 0)
            return [];
        // Step 2: Max-sim aggregation — group by memory ID, take best (lowest distance) per memory
        const bestPerMemory = new Map(); // memoryId -> best distance
        for (const r of memResults) {
            // Parse memory ID: "mem_{uuid}" or "mem_{uuid}_c{N}"
            const withoutPrefix = r.hash_seq.slice(4); // strip "mem_"
            const chunkSep = withoutPrefix.indexOf("_c");
            const memId = chunkSep >= 0 ? withoutPrefix.slice(0, chunkSep) : withoutPrefix;
            const existing = bestPerMemory.get(memId);
            if (existing === undefined || r.distance < existing) {
                bestPerMemory.set(memId, r.distance);
            }
        }
        // Step 3: Look up memory entries
        const ids = [...bestPerMemory.keys()];
        const placeholders = ids.map(() => '?').join(',');
        let sql = `SELECT id, text, category, scope, importance, timestamp, metadata FROM memories WHERE id IN (${placeholders})`;
        const params = [...ids];
        if (scopeFilter && scopeFilter.length > 0) {
            const scopePlaceholders = scopeFilter.map(() => '?').join(',');
            sql += ` AND scope IN (${scopePlaceholders})`;
            params.push(...scopeFilter);
        }
        const rows = this.db.prepare(sql).all(...params);
        const mapped = [];
        for (const row of rows) {
            const distance = bestPerMemory.get(row.id) ?? 0;
            const score = 1 / (1 + distance);
            if (score < minScore)
                continue;
            mapped.push({
                entry: {
                    id: row.id,
                    text: row.text,
                    vector: [], // Don't return full vector for search results
                    category: row.category,
                    scope: row.scope,
                    importance: row.importance,
                    timestamp: row.timestamp,
                    metadata: row.metadata || "{}",
                },
                score,
            });
        }
        // Sort by score descending
        mapped.sort((a, b) => b.score - a.score);
        return mapped.slice(0, safeLimit);
    }
    async bm25Search(query, limit = 5, scopeFilter) {
        const safeLimit = clampInt(limit, 1, 20);
        const ftsQuery = buildFTS5Query(query);
        if (!ftsQuery)
            return [];
        try {
            // Query FTS table and join with memories
            let sql = `
        SELECT m.id, m.text, m.category, m.scope, m.importance, m.timestamp, m.metadata,
               bm25(memories_fts) as bm25_score
        FROM memories_fts f
        JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ?
      `;
            const params = [ftsQuery];
            if (scopeFilter && scopeFilter.length > 0) {
                const scopePlaceholders = scopeFilter.map(() => '?').join(',');
                sql += ` AND m.scope IN (${scopePlaceholders})`;
                params.push(...scopeFilter);
            }
            sql += ` LIMIT ?`;
            params.push(safeLimit);
            const rows = this.db.prepare(sql).all(...params);
            const mapped = [];
            for (const row of rows) {
                // BM25 returns negative scores (lower = better match).
                // Normalize: score = |bm25| / (1 + |bm25|) → [0, 1)
                const rawBm25 = Math.abs(row.bm25_score ?? 0);
                const score = rawBm25 / (1 + rawBm25);
                mapped.push({
                    entry: {
                        id: row.id,
                        text: row.text,
                        vector: [],
                        category: row.category,
                        scope: row.scope,
                        importance: row.importance,
                        timestamp: row.timestamp,
                        metadata: row.metadata || "{}",
                    },
                    score,
                });
            }
            return mapped;
        }
        catch (err) {
            console.warn("BM25 search failed, falling back to empty results:", err);
            return [];
        }
    }
    async update(id, updates, scopeFilter) {
        // Support both full UUID and short prefix (8+ hex chars)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const prefixRegex = /^[0-9a-f]{8,}$/i;
        const isFullId = uuidRegex.test(id);
        const isPrefix = !isFullId && prefixRegex.test(id);
        if (!isFullId && !isPrefix) {
            throw new Error(`Invalid memory ID format: ${id}`);
        }
        let row;
        if (isFullId) {
            row = this.db.prepare(`SELECT id, text, category, scope, importance, timestamp, metadata FROM memories WHERE id = ?`).get(id);
        }
        else {
            // Prefix match
            const candidates = this.db.prepare(`SELECT id, text, category, scope, importance, timestamp, metadata FROM memories WHERE id LIKE ?`).all(`${id}%`);
            if (candidates.length > 1) {
                throw new Error(`Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`);
            }
            row = candidates[0];
        }
        if (!row)
            return null;
        const rowScope = row.scope ?? "global";
        // Check scope permissions
        if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
            throw new Error(`Memory ${id} is outside accessible scopes`);
        }
        // Build updated entry
        const updatedText = updates.text ?? row.text;
        const updatedCategory = updates.category ?? row.category;
        const updatedImportance = updates.importance ?? row.importance;
        const updatedMetadata = updates.metadata ?? (row.metadata || "{}");
        this.db.prepare(`
      UPDATE memories
      SET text = ?, category = ?, importance = ?, metadata = ?
      WHERE id = ?
    `).run(updatedText, updatedCategory, updatedImportance, updatedMetadata, row.id);
        // Re-insert vector if changed — also clean up any chunk vectors
        if (updates.vector && this._sqliteVecAvailable) {
            this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`mem_${row.id}`);
            this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq LIKE ?`).run(`mem_${row.id}_c%`);
            this.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`mem_${row.id}`, new Float32Array(updates.vector));
        }
        // Retrieve the vector if it exists
        let resultVector = [];
        if (updates.vector) {
            resultVector = updates.vector;
        }
        const updated = {
            id: row.id,
            text: updatedText,
            vector: resultVector,
            category: updatedCategory,
            scope: rowScope,
            importance: updatedImportance,
            timestamp: row.timestamp,
            metadata: updatedMetadata,
        };
        return updated;
    }
    /** Persist recall events to DB. Called after auto-recall injects memories. */
    recordRecalls(ids) {
        if (ids.length === 0)
            return;
        const now = Date.now();
        const stmt = this.db.prepare(`UPDATE memories SET recall_count = COALESCE(recall_count, 0) + 1, last_recalled_at = ? WHERE id = ?`);
        for (const id of ids) {
            stmt.run(now, id);
        }
    }
    async delete(id, scopeFilter) {
        // Support both full UUID and short prefix (8+ hex chars)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const prefixRegex = /^[0-9a-f]{8,}$/i;
        const isFullId = uuidRegex.test(id);
        const isPrefix = !isFullId && prefixRegex.test(id);
        if (!isFullId && !isPrefix) {
            throw new Error(`Invalid memory ID format: ${id}`);
        }
        let resolvedId;
        let rowScope;
        if (isFullId) {
            const row = this.db.prepare(`SELECT id, scope FROM memories WHERE id = ?`).get(id);
            if (!row)
                return false;
            resolvedId = row.id;
            rowScope = row.scope ?? "global";
        }
        else {
            // Prefix match
            const candidates = this.db.prepare(`SELECT id, scope FROM memories WHERE id LIKE ?`).all(`${id}%`);
            if (candidates.length > 1) {
                throw new Error(`Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`);
            }
            if (candidates.length === 0)
                return false;
            resolvedId = candidates[0].id;
            rowScope = candidates[0].scope ?? "global";
        }
        // Check scope permissions
        if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
            throw new Error(`Memory ${resolvedId} is outside accessible scopes`);
        }
        // Delete from memories (CASCADE handles memory_vectors)
        this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(resolvedId);
        // Delete from vectors_vec (virtual table, no CASCADE) — primary + chunk vectors
        if (this._sqliteVecAvailable) {
            this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`mem_${resolvedId}`);
            this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq LIKE ?`).run(`mem_${resolvedId}_c%`);
        }
        // Delete entity graph links
        try {
            deleteLinks(this.db, resolvedId);
        }
        catch { /* best effort */ }
        return true;
    }
    async bulkDelete(scopeFilter, beforeTimestamp) {
        const conditions = [];
        const params = [];
        if (scopeFilter.length > 0) {
            const scopePlaceholders = scopeFilter.map(() => '?').join(',');
            conditions.push(`scope IN (${scopePlaceholders})`);
            params.push(...scopeFilter);
        }
        if (beforeTimestamp) {
            conditions.push(`timestamp < ?`);
            params.push(beforeTimestamp);
        }
        if (conditions.length === 0) {
            throw new Error("Bulk delete requires at least scope or timestamp filter for safety");
        }
        const whereClause = conditions.join(" AND ");
        // Get IDs to delete (for vector cleanup)
        const rows = this.db.prepare(`SELECT id FROM memories WHERE ${whereClause}`).all(...params);
        if (rows.length === 0)
            return 0;
        // Delete memories (CASCADE handles memory_vectors)
        this.db.prepare(`DELETE FROM memories WHERE ${whereClause}`).run(...params);
        // Delete corresponding vectors (primary + chunks)
        if (this._sqliteVecAvailable) {
            for (const row of rows) {
                this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`mem_${row.id}`);
                this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq LIKE ?`).run(`mem_${row.id}_c%`);
            }
        }
        return rows.length;
    }
    async list(scopeFilter, category, limit = 20, offset = 0) {
        const conditions = [];
        const params = [];
        if (scopeFilter && scopeFilter.length > 0) {
            const scopePlaceholders = scopeFilter.map(() => '?').join(',');
            conditions.push(`scope IN (${scopePlaceholders})`);
            params.push(...scopeFilter);
        }
        if (category) {
            conditions.push(`category = ?`);
            params.push(category);
        }
        let sql = `SELECT id, text, category, scope, importance, timestamp, metadata FROM memories`;
        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(" AND ")}`;
        }
        sql += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);
        const rows = this.db.prepare(sql).all(...params);
        return rows.map((row) => ({
            id: row.id,
            text: row.text,
            vector: [], // Don't include vectors in list results for performance
            category: row.category,
            scope: row.scope ?? "global",
            importance: row.importance,
            timestamp: row.timestamp,
            metadata: row.metadata || "{}",
        }));
    }
    async stats(scopeFilter) {
        const conditions = [];
        const params = [];
        if (scopeFilter && scopeFilter.length > 0) {
            const scopePlaceholders = scopeFilter.map(() => '?').join(',');
            conditions.push(`scope IN (${scopePlaceholders})`);
            params.push(...scopeFilter);
        }
        let sql = `SELECT scope, category, metadata FROM memories`;
        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(" AND ")}`;
        }
        const rows = this.db.prepare(sql).all(...params);
        const scopeCounts = {};
        const categoryCounts = {};
        const sourceCounts = {};
        for (const row of rows) {
            const scope = row.scope ?? "global";
            const category = row.category;
            scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
            categoryCounts[category] = (categoryCounts[category] || 0) + 1;
            // Source breakdown from metadata
            try {
                const meta = JSON.parse(row.metadata || "{}");
                const source = meta.source || "unknown";
                sourceCounts[source] = (sourceCounts[source] || 0) + 1;
            }
            catch {
                sourceCounts["unknown"] = (sourceCounts["unknown"] || 0) + 1;
            }
        }
        return {
            totalCount: rows.length,
            scopeCounts,
            categoryCounts,
            sourceCounts,
        };
    }
    /** Force-rebuild the FTS index (needed after bulk inserts that bypass triggers). */
    async rebuildFtsIndex() {
        // Rebuild the FTS content from the memories table
        this.db.exec(`DELETE FROM memories_fts`);
        this.db.exec(`
      INSERT INTO memories_fts(rowid, text)
      SELECT rowid, text FROM memories
    `);
    }
    // ========================================================================
    // Embedding model tracking & re-embed state machine
    //
    // Two keys in store_meta:
    //   embedding_model  — model of last COMPLETED embedding run
    //   embedding_target — model of an IN-PROGRESS re-embed (cleared on completion)
    //
    // See docs/RESILIENCY.md for full failure mode analysis.
    // ========================================================================
    getMeta(key) {
        const row = this.db.prepare(`SELECT value FROM store_meta WHERE key = ?`).get(key);
        return row?.value ?? null;
    }
    setMeta(key, value) {
        this.db.prepare(`INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)`).run(key, value);
    }
    deleteMeta(key) {
        this.db.prepare(`DELETE FROM store_meta WHERE key = ?`).run(key);
    }
    getStoredEmbeddingModel() {
        return this.getMeta("embedding_model");
    }
    setStoredEmbeddingModel(model) {
        this.setMeta("embedding_model", model);
    }
    /**
     * Determine re-embed status based on the two-phase state machine.
     * Returns:
     *   "consistent"   — all vectors match current model, nothing to do
     *   "model_changed" — model changed, re-embed needed
     *   "interrupted"   — previous re-embed was interrupted, must re-embed
     *   "first_run"     — no model recorded yet, record current and continue
     */
    getEmbeddingStatus(currentModel) {
        const model = this.getMeta("embedding_model");
        const target = this.getMeta("embedding_target");
        if (target) {
            // A re-embed was in progress
            return "interrupted";
        }
        if (!model) {
            return "first_run";
        }
        if (model !== currentModel) {
            return "model_changed";
        }
        return "consistent";
    }
    /**
     * Check if re-embed is needed (convenience wrapper).
     */
    needsReEmbed(currentModel) {
        const status = this.getEmbeddingStatus(currentModel);
        return status === "model_changed" || status === "interrupted";
    }
    /**
     * Re-embed all memories using the two-phase state machine.
     *
     * Flow:
     * 1. SET embedding_target = newModel (marks intent)
     * 2. For each batch: BEGIN, delete old vectors, insert new, COMMIT
     * 3. SET embedding_model = newModel (marks completion)
     * 4. DELETE embedding_target (clean up)
     *
     * If interrupted at any point, next startup detects via embedding_target
     * and re-runs the entire process.
     */
    async reEmbedMemories(newModel, embedFn, batchSize = 20, onProgress) {
        const memories = this.db.prepare(`SELECT id, text FROM memories`).all();
        if (memories.length === 0) {
            this.setStoredEmbeddingModel(newModel);
            this.deleteMeta("embedding_target");
            return 0;
        }
        // Phase 1: mark intent
        this.setMeta("embedding_target", newModel);
        // Phase 2: chunk-aware re-embed
        let done = 0;
        for (let i = 0; i < memories.length; i += batchSize) {
            const batch = memories.slice(i, i + batchSize);
            for (const mem of batch) {
                const chunks = this.chunkForEmbedding(mem.text);
                const chunkEmbeddings = await embedFn(chunks);
                // Delete old vectors (primary + chunks)
                this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`mem_${mem.id}`);
                this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq LIKE ?`).run(`mem_${mem.id}_c%`);
                this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(mem.id);
                // Insert new vectors
                const now = new Date().toISOString();
                for (let c = 0; c < chunkEmbeddings.length; c++) {
                    if (!chunkEmbeddings[c] || chunkEmbeddings[c].length === 0)
                        continue;
                    const vecKey = c === 0 ? `mem_${mem.id}` : `mem_${mem.id}_c${c}`;
                    this.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(vecKey, new Float32Array(chunkEmbeddings[c]));
                }
                this.db.prepare(`INSERT OR REPLACE INTO memory_vectors (memory_id, embedded_at) VALUES (?, ?)`).run(mem.id, now);
            }
            done += batch.length;
            onProgress?.(done, memories.length);
        }
        // Phase 3: mark completion
        this.setStoredEmbeddingModel(newModel);
        // Phase 4: clean up
        this.deleteMeta("embedding_target");
        return done;
    }
    async close() {
        this.db.close();
    }
    // ========================================================================
    // Chunked embedding
    // ========================================================================
    /** Split text into chunks for embedding. Returns 1 chunk for short text. */
    chunkForEmbedding(text) {
        if (text.length <= MemoryStore.CHUNK_THRESHOLD) {
            return [text];
        }
        const result = chunkDocument(text, MemoryStore.CHUNK_CONFIG);
        return result.chunks;
    }
    /** Store a memory with pre-computed chunk vectors (for long text). */
    async storeWithChunks(entry) {
        const fullEntry = {
            ...entry,
            id: randomUUID(),
            timestamp: Date.now(),
            vector: entry.chunkVectors[0] || [],
            metadata: entry.metadata || "{}",
        };
        // Insert memory row
        this.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fullEntry.id, fullEntry.text, fullEntry.category, fullEntry.scope, fullEntry.importance, fullEntry.timestamp, fullEntry.metadata);
        // Insert chunk vectors
        if (this._sqliteVecAvailable) {
            for (let i = 0; i < entry.chunkVectors.length; i++) {
                const vecKey = i === 0 ? `mem_${fullEntry.id}` : `mem_${fullEntry.id}_c${i}`;
                this.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`)
                    .run(vecKey, new Float32Array(entry.chunkVectors[i]));
            }
        }
        // Insert mapping
        this.db.prepare(`INSERT INTO memory_vectors (memory_id, embedded_at) VALUES (?, ?)`).run(fullEntry.id, new Date().toISOString());
        return fullEntry;
    }
    /** Count vector rows for a memory (includes chunk vectors). For testing. */
    getVectorCount(memoryId) {
        if (!this._sqliteVecAvailable)
            return 0;
        const primary = this.db.prepare(`SELECT COUNT(*) as cnt FROM vectors_vec WHERE hash_seq = ?`).get(`mem_${memoryId}`);
        const chunks = this.db.prepare(`SELECT COUNT(*) as cnt FROM vectors_vec WHERE hash_seq LIKE ?`).get(`mem_${memoryId}_c%`);
        return primary.cnt + chunks.cnt;
    }
    /** Backfill entities for entries that don't have them in metadata. */
    backfillEntities() {
        try {
            const rows = this.db.prepare("SELECT id, text, metadata FROM memories WHERE metadata NOT LIKE '%\"entities\"%'").all();
            if (rows.length === 0)
                return;
            const update = this.db.prepare("UPDATE memories SET metadata = ? WHERE id = ?");
            for (const row of rows) {
                let meta = {};
                try {
                    meta = JSON.parse(row.metadata || "{}");
                }
                catch { }
                meta.entities = extractEntities(row.text);
                update.run(JSON.stringify(meta), row.id);
            }
        }
        catch { /* best effort */ }
    }
    /** Backfill graph links for existing memories (only if no links exist yet). */
    backfillLinks() {
        try {
            const linkCount = this.db.prepare("SELECT COUNT(*) as c FROM memory_links").get().c;
            if (linkCount > 0)
                return; // already have links
            const rows = this.db.prepare("SELECT id, metadata FROM memories WHERE metadata LIKE '%\"entities\"%'").all();
            for (const row of rows) {
                let entities = [];
                try {
                    entities = JSON.parse(row.metadata).entities || [];
                }
                catch {
                    continue;
                }
                if (entities.length >= 2) {
                    createLinks(this.db, row.id, entities);
                }
            }
        }
        catch { /* best effort */ }
    }
    // ========================================================================
    // Private helpers
    // ========================================================================
    insertMemory(entry, textHash) {
        const hash = textHash || createHash("sha256").update(entry.text.trim()).digest("hex");
        this.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.id, entry.text, entry.category, entry.scope, entry.importance, entry.timestamp, entry.metadata, hash);
        // Insert vector
        if (this._sqliteVecAvailable && entry.vector.length > 0) {
            this.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`mem_${entry.id}`, new Float32Array(entry.vector));
        }
        // Insert mapping
        this.db.prepare(`INSERT INTO memory_vectors (memory_id, embedded_at) VALUES (?, ?)`).run(entry.id, new Date().toISOString());
    }
}
//# sourceMappingURL=memory.js.map