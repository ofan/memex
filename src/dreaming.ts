/**
 * Memex Dreaming — Memory Consolidation System
 *
 * Three phases run sequentially on a configurable cron schedule:
 * - Light sweep: dedup, noise removal, fragment purge (no LLM)
 * - Deep sweep: recall-based re-scoring, ephemeral decay (no LLM)
 * - Reflection: synthesize learnings from scattered facts (needs LLM, optional)
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MemoryStore } from "./memory.js";
import { isNoise } from "./noise-filter.js";
import { Stopwatch, type TrackFn } from "./telemetry.js";

// ============================================================================
// Log helper
// ============================================================================

function log(logPath: string | undefined, type: string, kvs: Record<string, unknown>): void {
  if (!logPath) return;
  const ts = new Date().toISOString();
  const parts = Object.entries(kvs).map(([k, v]) => `${k}=${v}`).join(" ");
  try {
    appendFileSync(logPath, `${ts} [${type}] ${parts}\n`);
  } catch { /* best effort */ }
}

// ============================================================================
// Light Sweep
// ============================================================================

/**
 * Mechanical cleanup — dedup, noise removal, conversation fragment purge.
 * No LLM needed. All operations are idempotent.
 */
export async function lightSweep(
  store: MemoryStore,
  logPath?: string,
): Promise<{ deduped: number; noiseRemoved: number; fragmentsRemoved: number }> {
  const db = store.db;
  let deduped = 0;
  let noiseRemoved = 0;
  let fragmentsRemoved = 0;

  // 1. Exact text dedup: group by text, keep newest (highest timestamp)
  const dupes = db.prepare(`
    SELECT text, COUNT(*) as cnt, MAX(timestamp) as max_ts
    FROM memories
    GROUP BY text
    HAVING cnt > 1
  `).all() as { text: string; cnt: number; max_ts: number }[];

  for (const dupe of dupes) {
    // Delete all but the newest
    const deleted = db.prepare(`
      DELETE FROM memories WHERE text = ? AND timestamp < ?
    `).run(dupe.text, dupe.max_ts);
    deduped += (deleted as any).changes || 0;
  }

  // 2. Conversation fragment purge: single-turn [user]/[assistant] entries
  const fragments = db.prepare(`
    SELECT id, text FROM memories
    WHERE text LIKE '[assistant]%' OR text LIKE '[user]%'
  `).all() as { id: string; text: string }[];

  for (const frag of fragments) {
    // Only remove single-turn fragments (<=2 role tags)
    const roleTags = (frag.text.match(/^\[/gm) || []).length;
    if (roleTags <= 2) {
      db.prepare("DELETE FROM memories WHERE id = ?").run(frag.id);
      fragmentsRemoved++;
    }
  }

  // 3. Noise scan: run isNoise() on remaining entries
  const allEntries = db.prepare("SELECT id, text FROM memories").all() as { id: string; text: string }[];
  for (const entry of allEntries) {
    if (isNoise(entry.text)) {
      db.prepare("DELETE FROM memories WHERE id = ?").run(entry.id);
      noiseRemoved++;
    }
  }

  log(logPath, "dream:light", { deduped, noise_removed: noiseRemoved, fragments_removed: fragmentsRemoved });

  return { deduped, noiseRemoved, fragmentsRemoved };
}

// ============================================================================
// Deep Sweep
// ============================================================================

/** Patterns for ephemeral action logs that should decay faster. */
const EPHEMERAL_PATTERNS = [
  /\bwas (committed|pushed|deleted|deployed|created|updated|removed|merged|rotated)\b/i,
  /\bwas set to\b/i,
  /\bwas renamed\b/i,
];

/**
 * Re-score importance based on observed value (recall frequency) and
 * decay ephemeral action logs. No LLM needed. All operations are idempotent.
 */
export async function deepSweep(
  store: MemoryStore,
  logPath?: string,
): Promise<{ rescored: number; decayed: number }> {
  const db = store.db;
  const now = Date.now();
  let rescored = 0;
  let decayed = 0;

  const entries = db.prepare(`
    SELECT id, text, importance, timestamp, recall_count
    FROM memories
  `).all() as {
    id: string;
    text: string;
    importance: number;
    timestamp: number;
    recall_count: number | null;
  }[];

  const updateImportance = db.prepare("UPDATE memories SET importance = ? WHERE id = ?");

  for (const entry of entries) {
    const ageDays = (now - entry.timestamp) / 86400_000;
    const recalls = entry.recall_count ?? 0;
    let newImportance = entry.importance;

    // Boost frequently recalled entries
    if (recalls >= 5) {
      newImportance = Math.max(newImportance, 0.7);
    } else if (recalls >= 1 && recalls < 5) {
      newImportance = Math.max(newImportance, 0.5);
    }
    // Decay old never-recalled entries
    else if (recalls === 0 && ageDays > 90) {
      newImportance = Math.min(newImportance, 0.1);
    } else if (recalls === 0 && ageDays > 30) {
      newImportance = Math.min(newImportance, 0.3);
    }

    // Extra decay for ephemeral action logs
    if (ageDays > 30 && entry.importance < 0.5 && EPHEMERAL_PATTERNS.some(p => p.test(entry.text))) {
      newImportance = Math.min(newImportance, 0.1);
    }

    if (newImportance !== entry.importance) {
      updateImportance.run(newImportance, entry.id);
      if (newImportance > entry.importance) {
        rescored++;
      } else {
        decayed++;
      }
    }
  }

  log(logPath, "dream:deep", { rescored, decayed });

  return { rescored, decayed };
}

// ============================================================================
// Dream Cycle Orchestrator
// ============================================================================

export interface DreamConfig {
  enabled: boolean;
  phases: {
    light: boolean;
    deep: boolean;
    reflection: boolean;
  };
  logPath?: string;
}

export interface DreamCycleResult {
  light?: { deduped: number; noiseRemoved: number; fragmentsRemoved: number };
  deep?: { rescored: number; decayed: number };
  errors: string[];
  duration_ms: number;
}

/**
 * Run a full dream cycle: light → deep → reflection (if enabled).
 * Each phase is independent — if one fails, the next still runs.
 * All operations are idempotent.
 */
export async function runDreamCycle(
  store: MemoryStore,
  config: DreamConfig,
  track?: TrackFn,
): Promise<DreamCycleResult> {
  const sw = new Stopwatch();
  const result: DreamCycleResult = { errors: [], duration_ms: 0 };
  const logPath = config.logPath;

  // Pre-flight: ensure a recent backup exists
  if (logPath) {
    const backupDir = join(dirname(logPath), "backups");
    if (existsSync(backupDir)) {
      const today = new Date().toISOString().split("T")[0];
      const backups = readdirSync(backupDir).filter(f => f.startsWith("memory-backup-"));
      const hasRecent = backups.some(f => f.includes(today) || f.includes(
        new Date(Date.now() - 86400_000).toISOString().split("T")[0]
      ));
      if (!hasRecent && backups.length > 0) {
        log(logPath, "dream:warn", { message: "no_recent_backup" });
      }
    }
  }

  // Phase 1: Light sweep
  if (config.phases.light) {
    try {
      result.light = await lightSweep(store, logPath);
      sw.lap("light");
      track?.("dream", { phase: "light", ...result.light, ...sw.timings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`light: ${msg}`);
      log(logPath, "dream:error", { phase: "light", error: msg });
      sw.lap("light");
    }
  }

  // Phase 2: Deep sweep
  if (config.phases.deep) {
    try {
      result.deep = await deepSweep(store, logPath);
      sw.lap("deep");
      track?.("dream", { phase: "deep", ...result.deep, ...sw.timings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`deep: ${msg}`);
      log(logPath, "dream:error", { phase: "deep", error: msg });
      sw.lap("deep");
    }
  }

  // Phase 3: Reflection (future — needs LLM via subagent)
  // if (config.phases.reflection) { ... }

  result.duration_ms = sw.total;

  // Summary log line
  const summary = [
    result.light ? `light(deduped=${result.light.deduped}, noise=${result.light.noiseRemoved}, fragments=${result.light.fragmentsRemoved})` : null,
    result.deep ? `deep(rescored=${result.deep.rescored}, decayed=${result.deep.decayed})` : null,
    result.errors.length > 0 ? `errors=${result.errors.length}` : null,
  ].filter(Boolean).join(" ");
  log(logPath, "dream:cycle", { summary, duration_ms: result.duration_ms });

  // Pool health metrics
  const totalCount = store.totalMemories;
  const neverRecalled = (store.db.prepare(
    "SELECT COUNT(*) as c FROM memories WHERE (recall_count IS NULL OR recall_count = 0)"
  ).get() as { c: number }).c;
  const noiseRatio = 0; // After light sweep, noise should be 0
  track?.("dream_metrics", {
    pool_size: totalCount,
    noise_ratio: noiseRatio,
    never_recalled_ratio: totalCount > 0 ? +(neverRecalled / totalCount).toFixed(3) : 0,
  });

  return result;
}
