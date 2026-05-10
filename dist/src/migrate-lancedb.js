/**
 * LanceDB → SQLite Migration
 *
 * Reads entries from a legacy LanceDB `memories` table and imports them
 * into the new SQLite-backed MemoryStore.  The migration is idempotent:
 * entries that already exist (by id) are silently skipped.
 *
 * The `@lancedb/lancedb` package is loaded via dynamic import so it does
 * not need to be installed — if absent the migration is a no-op.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// ============================================================================
// Default legacy path
// ============================================================================
export function getDefaultLegacyLanceDBPath() {
    return join(homedir(), ".openclaw", "memory", "lancedb-pro");
}
// ============================================================================
// Migration
// ============================================================================
/**
 * Migrate entries from a legacy LanceDB directory into the SQLite MemoryStore.
 *
 * - Dynamically imports `@lancedb/lancedb`; returns early if not installed.
 * - Reads every row from the `memories` table.
 * - Uses `importEntry()` so ids and timestamps are preserved.
 * - Skips any id that already exists in the target store (idempotent).
 */
export async function migrateLanceDBToSQLite(legacyDbPath, sqliteStore) {
    const result = { migrated: 0, skipped: 0, errors: [] };
    // 1. Check if legacy directory exists
    if (!existsSync(legacyDbPath)) {
        return result; // nothing to migrate
    }
    // 2. Dynamically import @lancedb/lancedb
    let lancedb;
    try {
        lancedb = await import("@lancedb/lancedb");
    }
    catch {
        // Package not installed — skip migration silently
        result.errors.push("@lancedb/lancedb not installed, skipping migration");
        return result;
    }
    // 3. Open legacy database
    let db;
    try {
        db = await lancedb.connect(legacyDbPath);
    }
    catch (err) {
        result.errors.push(`Failed to open legacy LanceDB at ${legacyDbPath}: ${err}`);
        return result;
    }
    // 4. Open the memories table
    let table;
    try {
        table = await db.openTable("memories");
    }
    catch (err) {
        result.errors.push(`Failed to open memories table: ${err}`);
        return result;
    }
    // 5. Read all entries
    let rows;
    try {
        rows = await table.query().toArray();
    }
    catch (err) {
        result.errors.push(`Failed to read entries from LanceDB: ${err}`);
        return result;
    }
    if (rows.length === 0) {
        return result; // empty table
    }
    // 6. Import each entry, skipping duplicates
    for (const row of rows) {
        const id = row.id;
        if (!id) {
            result.errors.push("Skipping row with missing id");
            result.skipped++;
            continue;
        }
        try {
            // Check if already migrated
            const exists = await sqliteStore.hasId(id);
            if (exists) {
                result.skipped++;
                continue;
            }
            // Build MemoryEntry from LanceDB row
            const entry = {
                id,
                text: row.text || "",
                vector: Array.isArray(row.vector)
                    ? row.vector
                    : Array.from(row.vector),
                category: row.category || "other",
                scope: row.scope || "global",
                importance: Number.isFinite(Number(row.importance)) ? Number(row.importance) : 0.5,
                timestamp: Number.isFinite(Number(row.createdAt))
                    ? Number(row.createdAt)
                    : (Number.isFinite(Number(row.timestamp)) ? Number(row.timestamp) : Date.now()),
                metadata: typeof row.metadata === "string"
                    ? row.metadata
                    : JSON.stringify({
                        source: "lancedb-migration",
                        originalCreatedAt: row.createdAt,
                    }),
            };
            await sqliteStore.importEntry(entry);
            result.migrated++;
        }
        catch (err) {
            result.errors.push(`Failed to migrate entry ${id}: ${err}`);
        }
    }
    return result;
}
//# sourceMappingURL=migrate-lancedb.js.map