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
    SELECT id, text, importance, timestamp, recall_count, metadata
    FROM memories
  `).all() as {
    id: string;
    text: string;
    importance: number;
    timestamp: number;
    recall_count: number | null;
    metadata: string | null;
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

    // Aggressive decay for session imports: low-importance + never-recalled.
    // Session imports at 0.3 that never proved useful decay faster than agent-stored memories.
    // Two stages: >14d → 0.1, >30d → evict (0.05 triggers existing eviction rule).
    const isSessionImport = entry.metadata?.includes('"source":"session-import"') ?? false;
    if (isSessionImport && recalls === 0 && entry.importance <= 0.3) {
      if (ageDays > 30) {
        newImportance = 0.05;
      } else if (ageDays > 14) {
        newImportance = Math.min(newImportance, 0.1);
      }
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

  // Eviction: delete entries that decayed below usefulness
  const evicted = db.prepare("DELETE FROM memories WHERE importance <= 0.05").run();
  const evictedCount = (evicted as any).changes || 0;

  log(logPath, "dream:deep", { rescored, decayed, evicted: evictedCount });

  return { rescored, decayed };
}

// ============================================================================
// Reflection — LLM-driven knowledge synthesis
// ============================================================================

/** Config for the LLM used by reflection. */
export interface ReflectionLLMConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  timeout?: number;
}

const REFLECTION_SYSTEM_PROMPT = `You are a memory consolidation system. You receive a batch of stored memories (facts, decisions, preferences) and must:

1. Identify the 3 most important themes or patterns across these memories.
2. For each theme, synthesize a concise learning (1-2 sentences) that captures the key insight.
3. If you find contradictions (e.g., "switched to X" then later "switched to Y"), note only the LATEST state.

Output format — exactly one learning per line, no numbering, no bullets:
<learning>
<learning>
<learning>

If there are contradictions, add lines in this format:
SUPERSEDED:<older_memory_id>|<newer_memory_id>|<reason>

If no useful learnings can be synthesized, output: NONE`;

/**
 * Reflection phase: LLM-driven synthesis of learnings from recent memories.
 * Stanford Generative Agents pattern: send memories → generate questions → synthesize.
 *
 * Requires an LLM endpoint. Skips gracefully if not configured.
 */
export async function reflectionSweep(
  store: MemoryStore,
  llmConfig: ReflectionLLMConfig,
  logPath?: string,
): Promise<{ learnings: number; contradictions: number; errors: string[] }> {
  const db = store.db;
  const errors: string[] = [];
  let learnings = 0;
  let contradictions = 0;

  // Gather recent high-value memories for synthesis (importance > 0.3, limit 100)
  const memories = db.prepare(`
    SELECT id, text, category, importance, timestamp
    FROM memories
    WHERE importance > 0.3
    ORDER BY timestamp DESC
    LIMIT 100
  `).all() as Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    timestamp: number;
  }>;

  if (memories.length < 5) {
    log(logPath, "dream:reflect", { skipped: true, reason: "too_few_memories", count: memories.length });
    return { learnings: 0, contradictions: 0, errors: [] };
  }

  // Build the memory block for the LLM
  const memoryBlock = memories
    .map(m => `[${m.id}] [${m.category}] ${m.text}`)
    .join("\n");

  try {
    const resp = await fetch(llmConfig.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(llmConfig.apiKey ? { "Authorization": `Bearer ${llmConfig.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [
          { role: "system", content: REFLECTION_SYSTEM_PROMPT },
          { role: "user", content: memoryBlock },
        ],
        temperature: 0.3,
        max_tokens: llmConfig.maxTokens ?? 2048,
      }),
      signal: AbortSignal.timeout(llmConfig.timeout ?? 120_000),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      errors.push(`LLM HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
      log(logPath, "dream:reflect", { error: `HTTP ${resp.status}` });
      return { learnings: 0, contradictions: 0, errors };
    }

    const data = await resp.json() as any;
    const content = (data.choices?.[0]?.message?.content?.trim() || "") as string;

    if (content === "NONE" || !content) {
      log(logPath, "dream:reflect", { learnings: 0, contradictions: 0 });
      return { learnings: 0, contradictions: 0, errors: [] };
    }

    const lines = content.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    for (const line of lines) {
      // Handle contradiction markers
      if (line.startsWith("SUPERSEDED:")) {
        const parts = line.slice("SUPERSEDED:".length).split("|");
        if (parts.length >= 2) {
          const [olderId, _newerId, reason] = parts;
          // Demote the older memory
          const older = db.prepare("SELECT id, importance FROM memories WHERE id = ?").get(olderId.trim()) as any;
          if (older && older.importance > 0.1) {
            db.prepare("UPDATE memories SET importance = 0.1 WHERE id = ?").run(older.id);
            contradictions++;
          }
        }
        continue;
      }

      // Store learning as a new memory
      if (line.length >= 20) {
        const hash = createHash("sha256").update(line).digest("hex");
        // Check if already exists (idempotent)
        const existing = db.prepare("SELECT id FROM memories WHERE text_hash = ?").get(hash) as any;
        if (!existing) {
          const id = crypto.randomUUID();
          db.prepare(`
            INSERT INTO memories (id, text, category, scope, importance, timestamp, text_hash)
            VALUES (?, ?, 'learning', 'global', 0.85, ?, ?)
          `).run(id, line, Date.now(), hash);
          learnings++;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`reflection: ${msg}`);
  }

  log(logPath, "dream:reflect", { learnings, contradictions, errors: errors.length });
  return { learnings, contradictions, errors };
}

// ============================================================================
// Dream Cycle Orchestrator
// ============================================================================

/** Config for the LLM used by reflection. */
export interface DreamConfig {
  enabled: boolean;
  phases: {
    light: boolean;
    deep: boolean;
    reflection: boolean;
  };
  logPath?: string;
  /** LLM config for reflection phase. Reflection skips if not provided. */
  reflectionLLM?: ReflectionLLMConfig;
}

export interface DreamCycleResult {
  light?: { deduped: number; noiseRemoved: number; fragmentsRemoved: number };
  deep?: { rescored: number; decayed: number };
  reflection?: { learnings: number; contradictions: number; errors: string[] };
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

  // Phase 3: Reflection (LLM-driven knowledge synthesis)
  if (config.phases.reflection && config.reflectionLLM) {
    try {
      result.reflection = await reflectionSweep(store, config.reflectionLLM, logPath);
      sw.lap("reflect");
      track?.("dream", { phase: "reflection", ...result.reflection, ...sw.timings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`reflection: ${msg}`);
      log(logPath, "dream:error", { phase: "reflection", error: msg });
      sw.lap("reflect");
    }
  }

  result.duration_ms = sw.total;

  // Summary log line
  const summary = [
    result.light ? `light(deduped=${result.light.deduped}, noise=${result.light.noiseRemoved}, fragments=${result.light.fragmentsRemoved})` : null,
    result.deep ? `deep(rescored=${result.deep.rescored}, decayed=${result.deep.decayed})` : null,
    result.reflection ? `reflect(learnings=${result.reflection.learnings}, contradictions=${result.reflection.contradictions})` : null,
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
