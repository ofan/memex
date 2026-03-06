/**
 * Session Indexer
 * Parses OpenClaw session JSONL files and indexes conversation turns as memories.
 *
 * Design decisions:
 * - Scores importance via reranker (fast, already deployed, no extra model needed)
 * - Falls back to heuristic scoring when reranker unavailable
 * - Stores each turn with session:ID scope for per-session retrieval isolation
 * - Also stores in the target scope (default: global) for cross-session search
 * - Bulk-stores for performance (~340x faster than individual inserts)
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { MemoryStore, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";
import { isNoise } from "./noise-filter.js";
import { createSessionScope } from "./scopes.js";

// ============================================================================
// Types
// ============================================================================

export interface SessionTurn {
  sessionId: string;
  timestamp: string;
  role: "user" | "assistant";
  text: string;
}

export interface IndexedTurn extends SessionTurn {
  importance: number;
  category: string;
}

export interface SessionIndexerConfig {
  /** Path to sessions directory (default: ~/.openclaw/agents/main/sessions/) */
  sessionsDir: string;
  /** Target scope for cross-session search (default: "global") */
  targetScope: string;
  /** Minimum importance score to index (default: 0.1) */
  minImportance: number;
  /** Maximum text length per turn (longer turns are truncated) */
  maxTextLength: number;
  /** Reranker endpoint for importance scoring */
  rerankEndpoint?: string;
  /** Reranker model name */
  rerankModel?: string;
  /** Dry run — don't actually store, just report what would be indexed */
  dryRun: boolean;
  /** Batch size for embedding (default: 20) */
  embeddingBatchSize: number;
}

export interface IndexResult {
  totalSessions: number;
  skippedSessions: number;
  totalTurns: number;
  indexedTurns: number;
  skippedNoise: number;
  skippedImportance: number;
  errors: string[];
}

const DEFAULT_CONFIG: SessionIndexerConfig = {
  sessionsDir: join(process.env.HOME || "/home/ubuntu", ".openclaw", "agents", "main", "sessions"),
  targetScope: "global",
  minImportance: 0.1,
  maxTextLength: 2000,
  rerankEndpoint: "http://100.122.104.26:8090/rerank",
  rerankModel: "bge-reranker-v2-m3-Q8_0",
  dryRun: false,
  embeddingBatchSize: 20,
};

// ============================================================================
// JSONL Parser
// ============================================================================

// Patterns that indicate automated/bot sessions (not human conversations)
const AUTOMATED_PATTERNS = [
  /^\[cron:/,
  /^Task: Gmail/i,
  /^Task: Email/i,
  /^System: \[/,
  /HEARTBEAT/,
  /^Read HEARTBEAT\.md/,
  /SECURITY NOTICE: The following content is from an EXTERNAL/,
  /<<<EXTERNAL_UNTRUSTED_CONTENT/,
];

function isAutomatedMessage(text: string): boolean {
  return AUTOMATED_PATTERNS.some(p => p.test(text.trim()));
}

function extractTextFromContent(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c?.text === "string")
    .map((c: any) => c.text)
    .join("\n")
    .trim();
}

export function parseSessionFile(path: string): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const sessionId = basename(path).replace(/\.jsonl$/, "");

  let data: string;
  try {
    data = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const lines = data.split("\n").filter(Boolean);
  let hasAutomatedContent = false;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const text = extractTextFromContent(msg.content);
    if (!text) continue;

    if (msg.role === "user" && isAutomatedMessage(text)) {
      hasAutomatedContent = true;
    }

    turns.push({
      sessionId,
      timestamp: entry.timestamp || "",
      role: msg.role,
      text,
    });
  }

  // Skip entire session if it contains automated content
  if (hasAutomatedContent) return [];
  return turns;
}

// ============================================================================
// Importance Scoring
// ============================================================================

// Keyword triggers (from index.ts shouldCapture)
const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /\b(we )?decided\b|we'?ll use|we will use|switch(ed)? to|migrate(d)? to|going forward|from now on/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need|care)/i,
  /always|never|important/i,
];

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Heuristic importance score: 0.0-1.0 based on keyword triggers */
function heuristicImportance(text: string): number {
  const matchCount = MEMORY_TRIGGERS.filter(r => r.test(text)).length;
  if (matchCount === 0) return 0.3; // baseline — might still be useful context
  if (matchCount === 1) return 0.6;
  if (matchCount === 2) return 0.8;
  return 0.9;
}

function detectCategory(text: string): MemoryEntry["category"] {
  const lower = text.toLowerCase();
  if (/prefer|like|love|hate|want/i.test(lower)) return "preference";
  if (/decided|will use|switch(ed)? to|going forward|from now on/i.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called/i.test(lower)) return "entity";
  if (/\b(is|are|has|have)\b/i.test(lower)) return "fact";
  return "other";
}

/** Score importance via reranker. Returns array of 0-1 scores. */
async function rerankImportance(
  texts: string[],
  endpoint: string,
  model: string,
): Promise<number[]> {
  const REFERENCE_QUERY = "Important knowledge, preference, decision, fact, or technical detail worth remembering long-term";
  const scores = new Array(texts.length).fill(0.3); // fallback

  const batchSize = 20;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          query: REFERENCE_QUERY,
          documents: batch,
          top_n: batch.length,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) continue;
      const data = await resp.json() as any;
      const results = data.results || data.data || [];

      for (const item of results) {
        const idx = item.index;
        const rawScore = item.relevance_score ?? item.score ?? 0;
        if (typeof idx === "number" && idx >= 0 && idx < batch.length) {
          // Sigmoid-normalize raw logits, then scale to useful range
          // Raw logits from bge-reranker are typically -15 to +5
          // Sigmoid maps these to ~0 to ~0.99
          scores[i + idx] = sigmoid(rawScore);
        }
      }
    } catch {
      // Fallback to heuristic for this batch
      for (let j = 0; j < batch.length; j++) {
        scores[i + j] = heuristicImportance(batch[j]);
      }
    }

    if (i + batchSize < texts.length) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  return scores;
}

// ============================================================================
// Session Indexer
// ============================================================================

export async function indexSessions(
  store: MemoryStore,
  embedder: Embedder,
  config: Partial<SessionIndexerConfig> = {},
): Promise<IndexResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const result: IndexResult = {
    totalSessions: 0,
    skippedSessions: 0,
    totalTurns: 0,
    indexedTurns: 0,
    skippedNoise: 0,
    skippedImportance: 0,
    errors: [],
  };

  if (!existsSync(cfg.sessionsDir)) {
    result.errors.push(`Sessions directory not found: ${cfg.sessionsDir}`);
    return result;
  }

  // 1. Parse all session files
  const files = readdirSync(cfg.sessionsDir)
    .filter(f => f.endsWith(".jsonl") && !f.includes(".deleted"))
    .map(f => join(cfg.sessionsDir, f));

  result.totalSessions = files.length;
  console.warn(`session-indexer: found ${files.length} session files`);

  const allTurns: SessionTurn[] = [];
  for (const file of files) {
    const turns = parseSessionFile(file);
    if (turns.length === 0) {
      result.skippedSessions++;
      continue;
    }
    allTurns.push(...turns);
  }

  result.totalTurns = allTurns.length;
  console.warn(`session-indexer: ${allTurns.length} turns from ${files.length - result.skippedSessions} sessions`);

  // 2. Filter noise
  const filtered = allTurns.filter(turn => {
    if (isNoise(turn.text)) {
      result.skippedNoise++;
      return false;
    }
    return true;
  });

  // 3. Truncate long turns
  const truncated = filtered.map(turn => ({
    ...turn,
    text: turn.text.slice(0, cfg.maxTextLength),
  }));

  // 4. Score importance
  console.warn(`session-indexer: scoring ${truncated.length} turns...`);
  let importanceScores: number[];
  if (cfg.rerankEndpoint && cfg.rerankModel) {
    try {
      importanceScores = await rerankImportance(
        truncated.map(t => t.text),
        cfg.rerankEndpoint,
        cfg.rerankModel,
      );
    } catch {
      console.warn("session-indexer: reranker failed, using heuristic");
      importanceScores = truncated.map(t => heuristicImportance(t.text));
    }
  } else {
    importanceScores = truncated.map(t => heuristicImportance(t.text));
  }

  // 5. Filter by minimum importance
  const toIndex: Array<{ turn: SessionTurn; importance: number; category: MemoryEntry["category"] }> = [];
  for (let i = 0; i < truncated.length; i++) {
    if (importanceScores[i] < cfg.minImportance) {
      result.skippedImportance++;
      continue;
    }
    toIndex.push({
      turn: truncated[i],
      importance: importanceScores[i],
      category: detectCategory(truncated[i].text),
    });
  }

  console.warn(`session-indexer: ${toIndex.length} turns passed importance filter (min=${cfg.minImportance})`);

  if (cfg.dryRun) {
    console.warn("session-indexer: dry run — not storing");
    result.indexedTurns = toIndex.length;
    return result;
  }

  // 6. Embed in batches
  console.warn(`session-indexer: embedding ${toIndex.length} turns...`);
  const vectors: number[][] = [];
  for (let i = 0; i < toIndex.length; i += cfg.embeddingBatchSize) {
    const batch = toIndex.slice(i, i + cfg.embeddingBatchSize);
    const batchVectors = await embedder.embedBatchPassage(batch.map(t => t.turn.text));
    vectors.push(...batchVectors);
    if ((i + cfg.embeddingBatchSize) % 100 === 0) {
      console.warn(`  embedded ${Math.min(i + cfg.embeddingBatchSize, toIndex.length)}/${toIndex.length}`);
    }
  }

  // 7. Bulk store
  console.warn(`session-indexer: storing ${toIndex.length} memories...`);
  const entries: Omit<MemoryEntry, "id" | "timestamp">[] = toIndex.map((item, i) => ({
    text: item.turn.text,
    vector: vectors[i],
    category: item.category,
    scope: cfg.targetScope,
    importance: item.importance,
    metadata: JSON.stringify({
      source: "session-indexer",
      sessionId: item.turn.sessionId,
      sessionScope: createSessionScope(item.turn.sessionId),
      role: item.turn.role,
      originalTimestamp: item.turn.timestamp,
    }),
  }));

  try {
    const batchSize = 100;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      await store.bulkStore(batch);
      result.indexedTurns += batch.length;
    }
    console.warn(`session-indexer: stored ${result.indexedTurns} memories`);
  } catch (err) {
    result.errors.push(`Bulk store failed: ${String(err)}`);
  }

  return result;
}

// ============================================================================
// Utility: List sessions
// ============================================================================

export interface SessionInfo {
  id: string;
  path: string;
  turnCount: number;
  isAutomated: boolean;
}

export function listSessions(sessionsDir: string): SessionInfo[] {
  if (!existsSync(sessionsDir)) return [];

  return readdirSync(sessionsDir)
    .filter(f => f.endsWith(".jsonl") && !f.includes(".deleted"))
    .map(f => {
      const path = join(sessionsDir, f);
      const turns = parseSessionFile(path);
      return {
        id: basename(f).replace(/\.jsonl$/, ""),
        path,
        turnCount: turns.length,
        isAutomated: turns.length === 0,
      };
    });
}
