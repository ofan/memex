/**
 * Migration Utilities
 * Migrates data from old memory-lancedb plugin to memex
 */
import { homedir } from "node:os";
import { join } from "node:path";
import fs from "node:fs/promises";
import { loadLanceDB } from "./memory.js";
// ============================================================================
// Default Paths
// ============================================================================
function getDefaultLegacyPaths() {
    const home = homedir();
    return [
        join(home, ".openclaw", "memory", "lancedb"),
        join(home, ".claude", "memory", "lancedb"),
        // Add more legacy paths as needed
    ];
}
// ============================================================================
// Migration Functions
// ============================================================================
export class MemoryMigrator {
    targetStore;
    constructor(targetStore) {
        this.targetStore = targetStore;
    }
    async migrate(options = {}) {
        const result = {
            success: false,
            migratedCount: 0,
            skippedCount: 0,
            errors: [],
            summary: "",
        };
        try {
            // Find source database
            const sourceDbPath = await this.findSourceDatabase(options.sourceDbPath);
            if (!sourceDbPath) {
                result.errors.push("No legacy database found to migrate from");
                result.summary = "Migration failed: No source database found";
                return result;
            }
            console.warn(`Migrating from: ${sourceDbPath}`);
            // Load legacy data
            const legacyEntries = await this.loadLegacyData(sourceDbPath);
            if (legacyEntries.length === 0) {
                result.summary = "Migration completed: No data to migrate";
                result.success = true;
                return result;
            }
            console.warn(`Found ${legacyEntries.length} entries to migrate`);
            // Migrate entries
            if (!options.dryRun) {
                const migrationStats = await this.migrateEntries(legacyEntries, options);
                result.migratedCount = migrationStats.migrated;
                result.skippedCount = migrationStats.skipped;
                result.errors.push(...migrationStats.errors);
            }
            else {
                result.summary = `Dry run: Would migrate ${legacyEntries.length} entries`;
                result.success = true;
                return result;
            }
            result.success = result.errors.length === 0;
            result.summary = `Migration ${result.success ? 'completed' : 'completed with errors'}: ` +
                `${result.migratedCount} migrated, ${result.skippedCount} skipped`;
        }
        catch (error) {
            result.errors.push(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
            result.summary = "Migration failed due to unexpected error";
        }
        return result;
    }
    async findSourceDatabase(explicitPath) {
        if (explicitPath) {
            try {
                await fs.access(explicitPath);
                return explicitPath;
            }
            catch {
                return null;
            }
        }
        // Check default legacy paths
        for (const path of getDefaultLegacyPaths()) {
            try {
                await fs.access(path);
                const files = await fs.readdir(path);
                // Check for LanceDB files
                if (files.some(f => f.endsWith('.lance') || f === 'memories.lance')) {
                    return path;
                }
            }
            catch {
                continue;
            }
        }
        return null;
    }
    async loadLegacyData(sourceDbPath, limit) {
        const lancedb = await loadLanceDB();
        const db = await lancedb.connect(sourceDbPath);
        try {
            const table = await db.openTable("memories");
            let query = table.query();
            if (limit)
                query = query.limit(limit);
            const entries = await query.toArray();
            return entries.map((row) => ({
                id: row.id,
                text: row.text,
                vector: row.vector,
                importance: Number(row.importance),
                category: row.category || "other",
                createdAt: Number(row.createdAt),
                scope: row.scope,
            }));
        }
        catch (error) {
            console.warn(`Failed to load legacy data: ${error}`);
            return [];
        }
    }
    async migrateEntries(legacyEntries, options) {
        let migrated = 0;
        let skipped = 0;
        const errors = [];
        const defaultScope = options.defaultScope || "global";
        for (const legacy of legacyEntries) {
            try {
                // Check if entry already exists (if skipExisting is enabled)
                if (options.skipExisting) {
                    const existing = await this.targetStore.vectorSearch(legacy.vector, 1, 0.9, [legacy.scope || defaultScope]);
                    if (existing.length > 0 && existing[0].score > 0.95) {
                        skipped++;
                        continue;
                    }
                }
                // Convert legacy entry to new format
                const newEntry = {
                    text: legacy.text,
                    vector: legacy.vector,
                    category: legacy.category,
                    scope: legacy.scope || defaultScope, // Use legacy scope or default
                    importance: legacy.importance,
                    metadata: JSON.stringify({
                        migratedFrom: "memory-lancedb",
                        originalId: legacy.id,
                        originalCreatedAt: legacy.createdAt,
                    }),
                };
                await this.targetStore.store(newEntry);
                migrated++;
                if (migrated % 100 === 0) {
                    console.warn(`Migrated ${migrated}/${legacyEntries.length} entries...`);
                }
            }
            catch (error) {
                errors.push(`Failed to migrate entry ${legacy.id}: ${error}`);
                skipped++;
            }
        }
        return { migrated, skipped, errors };
    }
    // Check if migration is needed
    async checkMigrationNeeded(sourceDbPath) {
        const sourcePath = await this.findSourceDatabase(sourceDbPath);
        if (!sourcePath) {
            return {
                needed: false,
                sourceFound: false,
            };
        }
        try {
            const entries = await this.loadLegacyData(sourcePath, 1);
            return {
                needed: entries.length > 0,
                sourceFound: true,
                sourceDbPath: sourcePath,
                entryCount: entries.length > 0 ? undefined : 0, // Avoid full scan; count unknown
            };
        }
        catch (error) {
            return {
                needed: false,
                sourceFound: true,
                sourceDbPath: sourcePath,
            };
        }
    }
    // Verify migration results
    async verifyMigration(sourceDbPath) {
        const issues = [];
        try {
            const sourcePath = await this.findSourceDatabase(sourceDbPath);
            if (!sourcePath) {
                return {
                    valid: false,
                    sourceCount: 0,
                    targetCount: 0,
                    issues: ["Source database not found"],
                };
            }
            const sourceEntries = await this.loadLegacyData(sourcePath);
            const targetStats = await this.targetStore.stats();
            const sourceCount = sourceEntries.length;
            const targetCount = targetStats.totalCount;
            // Basic validation - target should have at least as many entries as source
            if (targetCount < sourceCount) {
                issues.push(`Target has fewer entries (${targetCount}) than source (${sourceCount})`);
            }
            return {
                valid: issues.length === 0,
                sourceCount,
                targetCount,
                issues,
            };
        }
        catch (error) {
            return {
                valid: false,
                sourceCount: 0,
                targetCount: 0,
                issues: [`Verification failed: ${error}`],
            };
        }
    }
}
// ============================================================================
// Factory Function
// ============================================================================
export function createMigrator(targetStore) {
    return new MemoryMigrator(targetStore);
}
// ============================================================================
// Standalone Migration Function
// ============================================================================
export async function migrateFromLegacy(targetStore, options = {}) {
    const migrator = createMigrator(targetStore);
    return migrator.migrate(options);
}
// ============================================================================
// CLI Helper Functions
// ============================================================================
export async function checkForLegacyData() {
    const paths = [];
    let totalEntries = 0;
    for (const path of getDefaultLegacyPaths()) {
        try {
            const lancedb = await loadLanceDB();
            const db = await lancedb.connect(path);
            const table = await db.openTable("memories");
            const entries = await table.query().select(["id"]).toArray();
            if (entries.length > 0) {
                paths.push(path);
                totalEntries += entries.length;
            }
        }
        catch {
            // Path doesn't exist or isn't a valid LanceDB
            continue;
        }
    }
    return {
        found: paths.length > 0,
        paths,
        totalEntries,
    };
}
//# sourceMappingURL=migrate.js.map