/**
 * db.ts - Cross-runtime SQLite compatibility layer
 *
 * Provides a unified Database export that works under both Bun (bun:sqlite)
 * and Node.js (better-sqlite3). The APIs are nearly identical — the main
 * difference is the import path.
 */
import { createRequire } from "node:module";
export const isBun = typeof globalThis.Bun !== "undefined";
let _Database;
let _sqliteVecLoad;
let _initialized = false;
function ensureInit() {
    if (_initialized)
        return;
    _initialized = true;
    if (isBun) {
        // Bun path — dynamic import needed at call time (not used by gateway)
        throw new Error("Bun runtime requires async initialization — call initBunDb() first");
    }
    else {
        const require = createRequire(import.meta.url);
        _Database = require("better-sqlite3");
        const sqliteVec = require("sqlite-vec");
        _sqliteVecLoad = (db) => sqliteVec.load(db);
    }
}
/**
 * Open a SQLite database. Works with both bun:sqlite and better-sqlite3.
 */
export function openDatabase(path) {
    ensureInit();
    return new _Database(path);
}
/**
 * Load the sqlite-vec extension into a database.
 */
export function loadSqliteVec(db) {
    ensureInit();
    _sqliteVecLoad(db);
}
//# sourceMappingURL=db.js.map