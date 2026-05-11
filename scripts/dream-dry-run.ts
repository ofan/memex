/**
 * Dreaming dry-run — simulate all 3 phases against production DB.
 * Prints every operation that WOULD happen without modifying the DB.
 *
 * Usage: MEMEX_LLM_API_KEY=... node --import jiti/register scripts/dream-dry-run.ts
 */
import { MemoryStore } from "../src/memory.js";
import { isNoise } from "../src/noise-filter.js";

const DB_PATH = process.env.MEMEX_DB_PATH || `${process.env.HOME}/.openclaw/memory/memex/memex.sqlite`;
const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: 2560 });
const db = store.db;
const now = Date.now();

const EPHEMERAL_PATTERNS = [
  /\bwas (committed|pushed|deleted|deployed|created|updated|removed|merged|rotated)\b/i,
  /\bwas set to\b/i,
  /\bwas renamed\b/i,
];

console.log("=".repeat(70));
console.log("MEMEX DREAMING — DRY RUN");
console.log(`Database: ${DB_PATH}`);
console.log(`Total memories: ${store.totalMemories}`);
console.log("=".repeat(70));

// ── Phase 1: Light Sweep ──────────────────────────────────────────────────

console.log("\n--- PHASE 1: LIGHT SWEEP (no LLM) ---\n");

// 1a. Exact text dedup
const dupes = db.prepare(`
  SELECT text, COUNT(*) as cnt, MAX(timestamp) as max_ts
  FROM memories GROUP BY text HAVING cnt > 1
`).all() as { text: string; cnt: number; max_ts: number }[];

let lightDeduped = 0;
for (const d of dupes) {
  const victims = db.prepare(
    "SELECT id, substr(text,1,80) as preview FROM memories WHERE text = ? AND timestamp < ?"
  ).all(d.text, d.max_ts) as { id: string; preview: string }[];
  for (const v of victims) {
    console.log(`  [DELETE dedup] ${v.id} — "${v.preview}..."`);
    lightDeduped++;
  }
}

// 1b. Fragment purge
const fragments = db.prepare(
  "SELECT id, substr(text,1,80) as preview FROM memories WHERE text LIKE '[assistant]%' OR text LIKE '[user]%'"
).all() as { id: string; preview: string; text?: string }[];

let lightFragments = 0;
for (const f of fragments) {
  const full = db.prepare("SELECT text FROM memories WHERE id = ?").get(f.id) as { text: string };
  const roleTags = (full.text.match(/^\[/gm) || []).length;
  if (roleTags <= 2) {
    console.log(`  [DELETE fragment] ${f.id} — "${f.preview}..."`);
    lightFragments++;
  }
}

// 1c. Noise scan
const allEntries = db.prepare("SELECT id, text FROM memories").all() as { id: string; text: string }[];
let lightNoise = 0;
for (const e of allEntries) {
  if (isNoise(e.text)) {
    console.log(`  [DELETE noise] ${e.id} — "${e.text.slice(0, 80)}"`);
    lightNoise++;
  }
}

console.log(`\n  Light summary: dedup=${lightDeduped}, fragments=${lightFragments}, noise=${lightNoise}`);

// ── Phase 2: Deep Sweep ──────────────────────────────────────────────────

console.log("\n--- PHASE 2: DEEP SWEEP (no LLM) ---\n");

const entries = db.prepare(`
  SELECT id, text, importance, timestamp, recall_count, metadata
  FROM memories
`).all() as Array<{
  id: string; text: string; importance: number;
  timestamp: number; recall_count: number | null; metadata: string | null;
}>;

let deepBoosted = 0, deepDecayed = 0, deepEvicted = 0;
const importanceBuckets = { boost: [] as string[], decay: [] as string[], evict: [] as string[] };

for (const entry of entries) {
  const ageDays = (now - entry.timestamp) / 86400_000;
  const recalls = entry.recall_count ?? 0;
  let newImportance = entry.importance;
  let reason = "";

  // Boost
  if (recalls >= 5) {
    newImportance = Math.max(newImportance, 0.7);
    reason = `recalled ${recalls}x → ≥0.7`;
  } else if (recalls >= 1 && recalls < 5) {
    newImportance = Math.max(newImportance, 0.5);
    reason = `recalled ${recalls}x → ≥0.5`;
  }
  // Decay
  else if (recalls === 0 && ageDays > 90) {
    newImportance = Math.min(newImportance, 0.1);
    reason = `never recalled, ${Math.round(ageDays)}d old → ≤0.1`;
  } else if (recalls === 0 && ageDays > 30) {
    newImportance = Math.min(newImportance, 0.3);
    reason = `never recalled, ${Math.round(ageDays)}d old → ≤0.3`;
  }

  // Session import decay
  const isSession = entry.metadata?.includes('"source":"session-import"') ?? false;
  if (isSession && recalls === 0 && entry.importance <= 0.3) {
    if (ageDays > 30) {
      newImportance = 0.05;
      reason = `session import, ${Math.round(ageDays)}d, never recalled → EVICT`;
    } else if (ageDays > 14) {
      newImportance = Math.min(newImportance, 0.1);
      reason = `session import, ${Math.round(ageDays)}d, never recalled → 0.1`;
    }
  }

  // Ephemeral
  if (ageDays > 30 && entry.importance < 0.5 && EPHEMERAL_PATTERNS.some(p => p.test(entry.text))) {
    newImportance = Math.min(newImportance, 0.1);
    reason = `ephemeral pattern, ${Math.round(ageDays)}d → ≤0.1`;
  }

  if (newImportance !== entry.importance) {
    const preview = entry.text.slice(0, 70);
    if (newImportance <= 0.05) {
      console.log(`  [EVICT] ${entry.importance}→${newImportance} | ${reason} | "${preview}..."`);
      deepEvicted++;
    } else if (newImportance > entry.importance) {
      console.log(`  [BOOST] ${entry.importance}→${newImportance} | ${reason} | "${preview}..."`);
      deepBoosted++;
    } else {
      deepDecayed++;
      // Only print first 5 decay examples to avoid flooding
      if (deepDecayed <= 5) {
        console.log(`  [DECAY] ${entry.importance}→${newImportance} | ${reason} | "${preview}..."`);
      }
    }
  }
}
if (deepDecayed > 5) console.log(`  ... and ${deepDecayed - 5} more decayed entries`);

console.log(`\n  Deep summary: boosted=${deepBoosted}, decayed=${deepDecayed}, evicted=${deepEvicted}`);

// ── Phase 3: Reflection ──────────────────────────────────────────────────

console.log("\n--- PHASE 3: REFLECTION (needs LLM) ---\n");

const llmEndpoint = process.env.MEMEX_LLM_ENDPOINT;
const llmModel = process.env.MEMEX_LLM_MODEL;
const llmApiKey = process.env.MEMEX_LLM_API_KEY;

if (!llmEndpoint || !llmModel) {
  console.log("  SKIPPED — set MEMEX_LLM_ENDPOINT + MEMEX_LLM_MODEL to enable");
} else {
  const memories = db.prepare(`
    SELECT id, text, category, importance, timestamp
    FROM memories WHERE importance > 0.3
    ORDER BY timestamp DESC LIMIT 50
  `).all() as Array<{ id: string; text: string; category: string; importance: number; timestamp: number }>;

  console.log(`  Qualifying memories: ${memories.length}`);

  if (memories.length < 5) {
    console.log("  SKIPPED — fewer than 5 qualifying memories");
  } else {
    const memoryBlock = memories.map(m => `[${m.id}] [${m.category}] ${m.text}`).join("\n");
    console.log(`  Prompt size: ${memoryBlock.length} chars (~${Math.round(memoryBlock.length / 3.5)} tokens)`);
    console.log("  Calling LLM...");

    const baseURL = llmEndpoint.endsWith("/v1") ? llmEndpoint : `${llmEndpoint}/v1`;
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(llmApiKey ? { "Authorization": `Bearer ${llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: llmModel,
        messages: [
          { role: "system", content: `You are a memory consolidation system. You receive a batch of stored memories (facts, decisions, preferences) and must:

1. Identify the 3 most important themes or patterns across these memories.
2. For each theme, synthesize a concise learning (1-2 sentences) that captures the key insight.
3. If you find contradictions (e.g., "switched to X" then later "switched to Y"), note only the LATEST state.

Output format — exactly one learning per line, no numbering, no bullets:
<learning>
<learning>
<learning>

If there are contradictions, add lines in this format:
SUPERSEDED:<older_memory_id>|<newer_memory_id>|<reason>

If no useful learnings can be synthesized, output: NONE` },
          { role: "user", content: memoryBlock },
        ],
        temperature: 0.3,
        max_tokens: 8192,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!resp.ok) {
      console.log(`  ERROR: HTTP ${resp.status}`);
    } else {
      const data = await resp.json() as any;
      const content = (data.choices?.[0]?.message?.content?.trim() || "") as string;
      const usage = data.usage;

      console.log(`  LLM response: ${content.length} chars`);
      if (usage) {
        console.log(`  Tokens: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens}`);
      }

      if (!content || content === "NONE") {
        console.log("  Result: NONE (no learnings)");
      } else {
        const lines = content.split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 0);
        let rLearnings = 0, rContradictions = 0;

        for (const line of lines) {
          if (line.startsWith("SUPERSEDED:")) {
            const parts = line.slice("SUPERSEDED:".length).split("|");
            if (parts.length >= 2) {
              const olderId = parts[0].trim();
              const reason = parts[2] || "superseded";
              const older = db.prepare("SELECT substr(text,1,80) as preview, importance FROM memories WHERE id = ?").get(olderId) as any;
              if (older) {
                console.log(`  [WOULD DEMOTE] ${olderId} (imp ${older.importance}→0.1) — "${older.preview}..." | reason: ${reason}`);
              } else {
                console.log(`  [SUPERSEDED] ${olderId} — not found in DB`);
              }
              rContradictions++;
            }
          } else if (line.length >= 20) {
            console.log(`  [WOULD STORE learning] "${line.slice(0, 100)}${line.length > 100 ? '...' : ''}"`);
            rLearnings++;
          }
        }

        console.log(`\n  Reflection summary: learnings=${rLearnings}, contradictions=${rContradictions}`);
      }
    }
  }
}

// ── Overall Stats ──────────────────────────────────────────────────────

console.log("\n" + "=".repeat(70));
console.log("OVERALL STATS");
console.log("=".repeat(70));

const byCategory = db.prepare(
  "SELECT category, COUNT(*) as c FROM memories GROUP BY category ORDER BY c DESC"
).all() as { category: string; c: number }[];

const byImportance = db.prepare(
  "SELECT ROUND(importance, 1) as imp, COUNT(*) as c FROM memories GROUP BY imp ORDER BY imp DESC"
).all() as { imp: number; c: number }[];

const recalled = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE recall_count > 0").get() as any).c;
const neverRecalled = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE recall_count IS NULL OR recall_count = 0").get() as any).c;
const sessionImports = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE metadata LIKE '%session-import%'").get() as any).c;

console.log(`\nPool: ${store.totalMemories} memories`);
console.log(`  Recalled: ${recalled} | Never recalled: ${neverRecalled}`);
console.log(`  Session imports: ${sessionImports}`);
console.log(`\nBy category:`);
for (const r of byCategory) console.log(`  ${r.category}: ${r.c}`);
console.log(`\nBy importance:`);
for (const r of byImportance) console.log(`  ${r.imp}: ${r.c}`);

console.log(`\nDry-run impact:`);
console.log(`  Light: would remove ${lightDeduped + lightFragments + lightNoise} entries`);
console.log(`  Deep: would boost ${deepBoosted}, decay ${deepDecayed}, evict ${deepEvicted}`);
console.log(`  Post-cleanup pool: ~${store.totalMemories - lightDeduped - lightFragments - lightNoise - deepEvicted}`);

store.close();
