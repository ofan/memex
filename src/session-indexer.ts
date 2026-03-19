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
import type { MemoryStore, MemoryEntry } from "./memory.js";
import type { Embedder } from "./embedder.js";
import { isNoise, isStructuralNoise, extractHumanText } from "./noise-filter.js";
import { scoreImportance, heuristicImportance } from "./importance.js";

// ============================================================================
// Types
// ============================================================================

export interface SessionTurn {
  sessionId: string;
  timestamp: string;
  role: "user" | "assistant";
  text: string;
}

export interface ParseOptions {
  /** Instead of dropping entire session, skip only automated turns */
  skipAutomatedTurns?: boolean;
}

export interface IndexedTurn extends SessionTurn {
  importance: number;
  category: string;
}

export interface LLMExtractionConfig {
  /** OpenAI-compatible chat completions endpoint */
  endpoint: string;
  /** Model name (e.g. "Qwen3.5-4B-Q8_0") */
  model: string;
  /** API key (optional for local models) */
  apiKey?: string;
  /** Max tokens per window for bin-packing (auto-detected or default 190000) */
  maxWindowTokens?: number;
  /** Max tokens for LLM response (default: 2048) */
  maxTokens?: number;
  /** Timeout per request in ms (auto-detected or default 120000) */
  timeout?: number;
  /** Send cache_prompt: true for llama.cpp prompt caching (auto-detected) */
  cachePrompt?: boolean;
  /** Max parallel requests (default: 3) */
  concurrency?: number;
}

// ============================================================================
// Backend Capability Detection
// ============================================================================

export interface BackendCapabilities {
  /** Backend type detected from /v1/models owned_by field */
  backend: "llamacpp" | "omlx" | "google" | "openai" | "unknown";
  /** Whether the backend supports cache_prompt */
  cachePrompt: boolean;
  /** Max input context window in tokens (null = unknown, use default) */
  contextWindow: number | null;
  /** Recommended timeout in ms */
  timeout: number;
  /** Max parallel requests (default: 3) */
  concurrency?: number;
  /** Max output tokens (default: model-dependent) */
  maxOutputTokens?: number;
}

/** Known context windows for cloud models (tokens) */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-2.5-flash": 1048576,
  "gemini-2.5-pro": 1048576,
  "gemini-2.0-flash": 1048576,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4-turbo": 128000,
  "gpt-3.5-turbo": 16385,
};

/**
 * Probe the backend to detect capabilities.
 * Queries /v1/models to determine backend type and context window.
 * For llama.cpp, also tries /props for runtime n_ctx.
 */
export async function probeBackend(
  baseURL: string,
  model: string,
  apiKey?: string,
): Promise<BackendCapabilities> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
  };

  const defaults: BackendCapabilities = {
    backend: "unknown",
    cachePrompt: false,
    contextWindow: null,
    timeout: 120000,
  };

  // 1. Query /v1/models to detect backend type
  try {
    const modelsURL = `${baseURL}/models`;
    const modelsResp = await fetch(modelsURL, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (modelsResp.ok) {
      const data = await modelsResp.json() as any;
      const models = data?.data || [];

      // Find our model in the list
      const modelInfo = models.find((m: any) =>
        m.id === model || m.id === `models/${model}` || m.id?.endsWith(`/${model}`)
      );

      const ownedBy = modelInfo?.owned_by || models[0]?.owned_by || "";

      if (ownedBy === "omlx") {
        defaults.backend = "omlx";
        defaults.cachePrompt = false;
        defaults.timeout = 120000; // 2min per request — local MLX inference needs time for prefill
        // omlx doesn't expose context window in /v1/models — use a safe default.
        // 16K keeps windows small enough for fast prefill on a 4B model.
        defaults.contextWindow = 16384;
      } else if (ownedBy === "llamacpp" || ownedBy === "llama-swap") {
        defaults.backend = "llamacpp";
        defaults.cachePrompt = true;
        defaults.timeout = 120000; // 2min per request — includes model swap + prefill + generation
        defaults.concurrency = 1; // llama-swap runs one model at a time, no parallel benefit

        // Try to get n_ctx from model meta or /props; fallback to 16K
        if (modelInfo?.meta?.n_ctx_train) {
          defaults.contextWindow = modelInfo.meta.n_ctx_train;
        } else {
          defaults.contextWindow = 16384;
        }
      } else if (ownedBy === "google") {
        defaults.backend = "google";
        defaults.timeout = 300000; // 5min — large context extraction can take 2-3min
        defaults.maxOutputTokens = 65536; // Gemini 2.5 supports up to 65K output
        // Gemini supports huge context — look up known limits
        const cleanModel = model.replace(/^models\//, "");
        defaults.contextWindow = KNOWN_CONTEXT_WINDOWS[cleanModel] || null;
      } else if (ownedBy === "openai" || ownedBy === "system" || ownedBy === "openai-internal") {
        defaults.backend = "openai";
        defaults.timeout = 120000;
        defaults.contextWindow = KNOWN_CONTEXT_WINDOWS[model] || null;
      }
    }
  } catch {
    // Probe failed — use defaults
  }

  // 2. For llama.cpp, try /props for runtime context size (more accurate than training ctx)
  if (defaults.backend === "llamacpp") {
    try {
      // llama-swap proxies to the underlying llama.cpp server
      // /props returns { default_generation_settings: { n_ctx: ... } }
      const propsURL = baseURL.replace(/\/v1$/, "/props");
      const propsResp = await fetch(propsURL, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (propsResp.ok) {
        const props = await propsResp.json() as any;
        const nCtx = props?.default_generation_settings?.n_ctx;
        if (typeof nCtx === "number" && nCtx > 0) {
          defaults.contextWindow = nCtx;
        }
      }
    } catch {
      // /props not available — keep model meta or null
    }
  }

  return defaults;
}

/** Apply detected capabilities to an extraction config, without overriding explicit values. */
export function applyBackendCapabilities(
  config: LLMExtractionConfig,
  caps: BackendCapabilities,
): LLMExtractionConfig {
  return {
    ...config,
    cachePrompt: config.cachePrompt ?? caps.cachePrompt,
    timeout: config.timeout ?? caps.timeout,
    concurrency: config.concurrency ?? caps.concurrency,
    maxTokens: config.maxTokens ?? caps.maxOutputTokens,
    maxWindowTokens: config.maxWindowTokens ?? (
      caps.contextWindow
        // Cap at 200K per window even if context is larger — smaller windows get more focused extraction
        ? Math.min(Math.floor(caps.contextWindow * 0.95), 200000)
        : undefined
    ),
  };
}

export interface SessionIndexerConfig {
  /** Path to sessions directory (default: ~/.openclaw/agents/main/sessions/) */
  sessionsDir: string;
  /** Legacy — no longer used. Memories are stored with per-session scopes. */
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
  /** Session IDs already imported — these sessions will be skipped */
  alreadyImported?: Set<string>;
  /** Optional LLM extraction — extracts curated knowledge from turn windows */
  llmExtraction?: LLMExtractionConfig;
  /** Include .jsonl.deleted.TIMESTAMP files (rotated sessions) in import */
  includeDeleted?: boolean;
}

export interface IndexResult {
  totalSessions: number;
  skippedSessions: number;
  skippedAlreadyImported: number;
  totalTurns: number;
  indexedTurns: number;
  skippedNoise: number;
  skippedImportance: number;
  /** Turns processed by LLM extraction */
  llmExtracted: number;
  /** LLM extraction errors */
  llmErrors: number;
  /** Memories deduplicated by embedding similarity (within batch) */
  llmDeduplicated: number;
  /** Memories skipped because they already exist in the store */
  skippedStoreDuplicates: number;
  errors: string[];
}

const DEFAULT_CONFIG: SessionIndexerConfig = {
  sessionsDir: join(process.env.HOME || "/home/ubuntu", ".openclaw", "agents", "main", "sessions"),
  targetScope: "global",
  minImportance: 0.1,
  maxTextLength: 2000,
  rerankEndpoint: undefined,
  rerankModel: "bge-reranker-v2-m3-Q8_0",
  dryRun: false,
  embeddingBatchSize: 20,
  includeDeleted: false,
};

/** Minimum character length for a session turn to be worth indexing */
const MIN_TURN_LENGTH = 40;

/**
 * Imperative command patterns — user instructions with no knowledge content.
 * These are actions ("do it", "run the tests") not facts/preferences/decisions.
 */
const IMPERATIVE_PATTERNS = [
  /^(do|run|fix|check|try|stop|start|kill|deploy|build|test|ship|push|merge|revert|restart|clean|update|add|remove|delete)\b.{0,40}$/i,
  /^(yes|no|yep|nah|nope|ok|okay|sure|fine|go ahead|go for it|sounds good|let's do it|approved?|lgtm)\b.{0,20}$/i,
  /^(agreed|exactly|correct|right|perfect|nice|cool|great|awesome|love it|that works)\b.{0,30}$/i,
];

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

export function parseSessionFile(path: string, options?: ParseOptions): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const sessionId = basename(path).replace(/\.jsonl(\.deleted\.\d+)?$/, "");

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
      if (options?.skipAutomatedTurns) {
        // Skip only this turn, not the entire session
        continue;
      }
      hasAutomatedContent = true;
    }

    turns.push({
      sessionId,
      timestamp: entry.timestamp || "",
      role: msg.role,
      text,
    });
  }

  // Skip entire session if it contains automated content (default behavior)
  if (hasAutomatedContent) return [];
  return turns;
}

// ============================================================================
// Category Detection
// ============================================================================

const VALID_CATEGORIES = new Set(["preference", "fact", "decision", "entity"]);

/**
 * Parse category from LLM-extracted memory text with [category] prefix.
 * Falls back to heuristic detection if no prefix found.
 * Returns { category, text } with prefix stripped.
 */
function parseCategoryPrefix(text: string): { category: MemoryEntry["category"]; text: string } {
  const match = text.match(/^\[(\w+)\]\s*/);
  if (match && VALID_CATEGORIES.has(match[1].toLowerCase())) {
    return {
      category: match[1].toLowerCase() as MemoryEntry["category"],
      text: text.slice(match[0].length),
    };
  }
  // Fallback heuristic
  return { category: detectCategoryHeuristic(text), text };
}

function detectCategoryHeuristic(text: string): MemoryEntry["category"] {
  const lower = text.toLowerCase();
  if (/prefer|like|love|hate|want|ban|never|always/i.test(lower)) return "preference";
  if (/decided|will use|switch(ed)? to|going forward|from now on|on hold|paused/i.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called/i.test(lower)) return "entity";
  if (/\b(is|are|has|have|port|endpoint|expire|version|config)\b/i.test(lower)) return "fact";
  return "other";
}

// ============================================================================
// Cosine Similarity (for embedding dedup)
// ============================================================================

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================================
// Token Estimation & Session Bin-Packing
// ============================================================================

/** Estimate token count from text (chars / 4 is a reasonable approximation) */
export function estimateTokens(text: string): number {
  // Conservative estimate: ~2.7 chars/token for mixed code+prose content.
  // Previous /4 ratio underestimated by ~47%, causing context overflows.
  return Math.ceil(text.length / 2.7);
}

/** Estimate total tokens for a list of turns (includes role prefixes) */
function estimateSessionTokens(turns: SessionTurn[]): number {
  return turns.reduce((sum, t) => sum + estimateTokens(`[${t.role}] ${t.text}\n`), 0);
}

/**
 * Bin-pack complete sessions into windows of approximately maxTokens size.
 * A session is NEVER split across windows. If a single session exceeds
 * maxTokens, it gets its own window.
 *
 * Sessions are packed in order (not optimally — greedy first-fit).
 */
export function binPackSessions(
  sessions: SessionTurn[][],
  maxTokens: number,
): SessionTurn[][] {
  const windows: SessionTurn[][] = [];
  let currentWindow: SessionTurn[] = [];
  let currentTokens = 0;

  for (const session of sessions) {
    const sessionTokens = estimateSessionTokens(session);

    // If this single session exceeds maxTokens, split it into chunks
    if (sessionTokens > maxTokens) {
      // Flush current window first
      if (currentWindow.length > 0) {
        windows.push(currentWindow);
        currentWindow = [];
        currentTokens = 0;
      }
      // Split oversized session by turns
      let chunk: SessionTurn[] = [];
      let chunkTokens = 0;
      for (const turn of session) {
        const turnTokens = estimateTokens(`[${turn.role}] ${turn.text}\n`);
        if (chunk.length > 0 && chunkTokens + turnTokens > maxTokens) {
          windows.push(chunk);
          chunk = [];
          chunkTokens = 0;
        }
        chunk.push(turn);
        chunkTokens += turnTokens;
      }
      if (chunk.length > 0) {
        windows.push(chunk);
      }
      continue;
    }

    if (currentWindow.length > 0 && currentTokens + sessionTokens > maxTokens) {
      windows.push(currentWindow);
      currentWindow = [];
      currentTokens = 0;
    }

    currentWindow.push(...session);
    currentTokens += sessionTokens;
  }

  if (currentWindow.length > 0) {
    windows.push(currentWindow);
  }

  return windows;
}

// ============================================================================
// LLM Knowledge Extraction
// ============================================================================

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Given a conversation transcript, extract ALL knowledge worth remembering long-term. Be thorough — extract every distinct fact, preference, and decision.

## What to extract

**preference** — User rules, bans, likes, dislikes, communication style, workflow preferences
  Examples: "User bans certain phrases from agent vocabulary"
  Examples: "User prefers all new repos to be private by default"

**decision** — Architecture choices, technology selections, tradeoffs made, things put on hold
  Examples: "Decision: VPN deployment on hold due to network conflict"

**fact** — Configurations, endpoints, IDs, dates, names, versions, resource limits, credentials metadata
  Examples: "Notifications channel ID: 123456789"
  Examples: "API token expires approximately May 14, 2026"
  Examples: "Backup repository at s3://bucket/path/ on object storage"

**entity** — People, services, devices, accounts with identifying details
  Examples: "Server runs inference service on port 8090 at 10.0.0.1"

## What NOT to extract
- Greetings, acknowledgments, small talk
- Imperative commands ("do it", "run the tests")
- Meta-discussion about memory or context itself
- Transient debugging state or temporary workarounds
- Code snippets or file contents (extract the DECISION, not the code)

## Output format

One memory per line. Prefix each with its category in brackets:

[preference] User bans certain phrases from agent vocabulary.
[decision] VPN deployment paused — network conflict with existing setup unresolved.
[fact] Notifications channel ID: 123456789.
[entity] Server at 10.0.0.1:8090 runs inference service with 3 models.

Be specific — include names, IDs, dates, versions, port numbers. Vague memories are useless.
If nothing is worth remembering, respond with exactly: NONE`;

export async function extractKnowledge(
  turns: SessionTurn[],
  config: LLMExtractionConfig,
): Promise<{ memories: string[]; errors: number }> {
  // Reserve tokens for system prompt + response in the window budget
  const systemPromptTokens = estimateTokens(EXTRACTION_SYSTEM_PROMPT) + (config.maxTokens ?? 2048);
  const rawMaxWindow = config.maxWindowTokens ?? 190000;
  const maxWindowTokens = Math.max(1000, rawMaxWindow - systemPromptTokens);
  const allMemories: string[] = [];
  let errors = 0;

  // Group turns by sessionId, preserving order
  const sessionMap = new Map<string, SessionTurn[]>();
  for (const turn of turns) {
    const existing = sessionMap.get(turn.sessionId);
    if (existing) {
      existing.push(turn);
    } else {
      sessionMap.set(turn.sessionId, [turn]);
    }
  }
  const sessions = Array.from(sessionMap.values());

  // Bin-pack sessions into windows
  const windows = binPackSessions(sessions, maxWindowTokens);
  console.warn(`session-indexer: packed ${sessions.length} sessions into ${windows.length} windows`);

  const concurrency = config.concurrency ?? 3;
  const maxRetries = 2;
  const timeout = config.timeout ?? 120000;

  async function processWindow(wi: number): Promise<string[]> {
    const window = windows[wi];
    const windowText = window.map(t => `[${t.role}] ${t.text}`).join("\n");
    const tokenEst = estimateTokens(windowText);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const label = `window ${wi + 1}/${windows.length}`;
      if (attempt === 0) {
        console.warn(`  ${label}: ${window.length} turns, ~${tokenEst} tokens`);
      } else {
        console.warn(`  ${label}: retry ${attempt}/${maxRetries}`);
      }

      try {
        const resp = await fetch(config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
              { role: "user", content: windowText },
            ],
            temperature: 0.0,
            ...(config.maxTokens ? { max_tokens: config.maxTokens } : { max_tokens: 65536 }),
            ...(config.cachePrompt === true ? { cache_prompt: true } : {}),
          }),
          signal: AbortSignal.timeout(timeout),
        });

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "");
          console.warn(`  ${label}: HTTP ${resp.status} ${errBody.slice(0, 200)}`);
          if (attempt < maxRetries) continue;
          errors++;
          return [];
        }

        const data = await resp.json() as any;
        const content = data.choices?.[0]?.message?.content?.trim() || "";

        if (content === "NONE" || !content) {
          console.warn(`  ${label}: done (nothing to extract)`);
          return [];
        }

        const memories = content.split("\n")
          .map((l: string) => l.trim())
          .filter((l: string) => l.length >= 20 && l !== "NONE");

        console.warn(`  ${label}: done (${memories.length} memories extracted)`);
        return memories;
      } catch (err: any) {
        const errMsg = err?.name === "TimeoutError" ? "timeout" : String(err).slice(0, 100);
        console.warn(`  ${label}: ${errMsg}`);
        if (attempt < maxRetries) continue;
        errors++;
        return [];
      }
    }
    return [];
  }

  // Process windows in parallel with concurrency limit
  for (let i = 0; i < windows.length; i += concurrency) {
    const batch = Array.from({ length: Math.min(concurrency, windows.length - i) }, (_, j) => i + j);
    const results = await Promise.all(batch.map(wi => processWindow(wi)));
    for (const memories of results) {
      allMemories.push(...memories);
    }
  }

  return { memories: allMemories, errors };
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
    skippedAlreadyImported: 0,
    totalTurns: 0,
    indexedTurns: 0,
    skippedNoise: 0,
    skippedImportance: 0,
    llmExtracted: 0,
    llmErrors: 0,
    llmDeduplicated: 0,
    skippedStoreDuplicates: 0,
    errors: [],
  };

  if (!existsSync(cfg.sessionsDir)) {
    result.errors.push(`Sessions directory not found: ${cfg.sessionsDir}`);
    return result;
  }

  // Build sessionId → sessionKey reverse map from sessions.json registry
  const registryPath = join(cfg.sessionsDir, "sessions.json");
  const sessionKeyMap = new Map<string, string>();
  if (existsSync(registryPath)) {
    try {
      const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      for (const [key, entry] of Object.entries(registry)) {
        const sid = (entry as any)?.sessionId;
        if (sid) sessionKeyMap.set(sid, key);
      }
      console.warn(`session-indexer: loaded ${sessionKeyMap.size} session keys from registry`);
    } catch { /* ignore malformed registry */ }
  }

  // 1. Parse all session files
  const files = readdirSync(cfg.sessionsDir)
    .filter(f => {
      if (f === "sessions.json") return false;
      if (cfg.includeDeleted) {
        return f.includes(".jsonl");
      }
      return f.endsWith(".jsonl") && !f.includes(".deleted");
    })
    .map(f => join(cfg.sessionsDir, f));

  result.totalSessions = files.length;
  console.warn(`session-indexer: found ${files.length} session files`);

  const allTurns: SessionTurn[] = [];
  let parsed = 0;
  for (const file of files) {
    // Skip sessions already imported
    const fileSessionId = basename(file).replace(/\.jsonl(\.deleted\.\d+)?$/, "");
    if (cfg.alreadyImported?.has(fileSessionId)) {
      result.skippedAlreadyImported++;
      parsed++;
      continue;
    }

    const turns = parseSessionFile(file, cfg.llmExtraction ? { skipAutomatedTurns: true } : undefined);
    parsed++;
    if (turns.length === 0) {
      result.skippedSessions++;
      continue;
    }
    allTurns.push(...turns);
    if (parsed % 10 === 0) {
      console.warn(`  parsed ${parsed}/${files.length} sessions (${allTurns.length} turns so far)`);
    }
  }

  result.totalTurns = allTurns.length;
  console.warn(`session-indexer: ${allTurns.length} turns from ${files.length - result.skippedSessions} sessions`);

  // 2. Strip envelopes from all turns (Discord metadata wrappers, system tags, etc.)
  //    Keep all turns for LLM extraction context; only noise-filter for heuristic path.
  const envelopeStripped: SessionTurn[] = [];
  for (const turn of allTurns) {
    const extracted = extractHumanText(turn.text);
    if (!extracted) continue;
    envelopeStripped.push({ ...turn, text: extracted });
  }

  // 2.5. LLM extraction path — feed full transcript, let the LLM decide what matters
  let filtered: SessionTurn[];
  if (cfg.llmExtraction) {
    console.warn(`session-indexer: extracting knowledge via LLM from ${envelopeStripped.length} turns (${cfg.llmExtraction.model})...`);
    const { memories, errors: llmErrors } = await extractKnowledge(envelopeStripped, cfg.llmExtraction);
    result.llmExtracted = memories.length;
    result.llmErrors = llmErrors;
    result.skippedNoise = allTurns.length - envelopeStripped.length;

    if (memories.length > 0) {
      filtered = memories.map(text => ({
        sessionId: "llm-extracted",
        timestamp: new Date().toISOString(),
        role: "assistant" as const,
        text,
      }));
    } else {
      filtered = [];
    }
    console.warn(`session-indexer: LLM extracted ${memories.length} memories (${llmErrors} errors)`);
  } else {
    // Heuristic path — apply noise filtering
    filtered = [];
    for (const turn of envelopeStripped) {
      if (isStructuralNoise(turn.text)) {
        result.skippedNoise++;
        continue;
      }
      if (isNoise(turn.text)) {
        result.skippedNoise++;
        continue;
      }
      if (turn.text.length < MIN_TURN_LENGTH) {
        result.skippedNoise++;
        continue;
      }
      if (IMPERATIVE_PATTERNS.some(p => p.test(turn.text))) {
        result.skippedNoise++;
        continue;
      }
      filtered.push(turn);
    }
  }

  // 3. Truncate long turns (skip if LLM extraction already produced concise summaries)
  const truncated = cfg.llmExtraction
    ? filtered
    : filtered.map(turn => ({
        ...turn,
        text: turn.text.slice(0, cfg.maxTextLength),
      }));

  // 4. Score importance
  console.warn(`session-indexer: scoring ${truncated.length} turns...`);
  let importanceScores: number[];
  if (cfg.rerankEndpoint && cfg.rerankModel) {
    try {
      importanceScores = await scoreImportance(
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
    const parsed = parseCategoryPrefix(truncated[i].text);
    truncated[i].text = parsed.text; // strip prefix from stored text
    toIndex.push({
      turn: truncated[i],
      importance: importanceScores[i],
      category: parsed.category,
    });
  }

  console.warn(`session-indexer: ${toIndex.length} turns passed importance filter (min=${cfg.minImportance})`);

  if (cfg.dryRun) {
    console.warn("session-indexer: dry run — not storing");
    if (toIndex.length > 0) {
      console.warn("\n--- Extracted memories (preview) ---");
      for (const entry of toIndex.slice(0, 30)) {
        console.warn(`  [${(entry.importance ?? 0).toFixed(2)}] ${entry.turn.text.slice(0, 200)}`);
      }
      if (toIndex.length > 30) console.warn(`  ... and ${toIndex.length - 30} more`);
      console.warn("--- end preview ---\n");
    }
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
    console.warn(`  embedded ${Math.min(i + cfg.embeddingBatchSize, toIndex.length)}/${toIndex.length}`);
  }

  // 6.5. Dedup by embedding similarity (only for LLM-extracted memories)
  let dedupedIndex = toIndex;
  let dedupedVectors = vectors;
  if (cfg.llmExtraction && toIndex.length > 1) {
    const keep: boolean[] = new Array(toIndex.length).fill(true);
    for (let i = 0; i < toIndex.length; i++) {
      if (!keep[i]) continue;
      for (let j = i + 1; j < toIndex.length; j++) {
        if (!keep[j]) continue;
        if (cosineSimilarity(vectors[i], vectors[j]) > 0.95) {
          keep[j] = false;
          result.llmDeduplicated++;
        }
      }
    }
    dedupedIndex = toIndex.filter((_, i) => keep[i]);
    dedupedVectors = vectors.filter((_, i) => keep[i]);
    if (result.llmDeduplicated > 0) {
      console.warn(`session-indexer: deduplicated ${result.llmDeduplicated} near-identical memories`);
    }
  }

  // 6.6. Dedup against existing store (skip memories already stored)
  if (dedupedIndex.length > 0) {
    const storeKeep: boolean[] = new Array(dedupedIndex.length).fill(true);
    for (let i = 0; i < dedupedIndex.length; i++) {
      try {
        const existing = await store.vectorSearch(dedupedVectors[i], 1, 0.1);
        if (existing.length > 0 && existing[0].score > 0.95) {
          storeKeep[i] = false;
          result.skippedStoreDuplicates++;
        }
      } catch {
        // Store search failed — keep the entry (fail open)
      }
    }
    if (result.skippedStoreDuplicates > 0) {
      dedupedIndex = dedupedIndex.filter((_, i) => storeKeep[i]);
      dedupedVectors = dedupedVectors.filter((_, i) => storeKeep[i]);
      console.warn(`session-indexer: skipped ${result.skippedStoreDuplicates} store duplicates`);
    }
  }

  // 7. Bulk store
  console.warn(`session-indexer: storing ${dedupedIndex.length} memories...`);
  const entries: Omit<MemoryEntry, "id" | "timestamp">[] = dedupedIndex.map((item, i) => {
    const sessionKey = sessionKeyMap.get(item.turn.sessionId) || item.turn.sessionId;
    const agentIdMatch = sessionKey.match(/^agent:([^:]+)/);
    const agentId = agentIdMatch ? agentIdMatch[1] : undefined;

    return {
      text: item.turn.text,
      vector: dedupedVectors[i],
      category: item.category,
      scope: "global",
      importance: item.importance,
      metadata: JSON.stringify({
        source: "session-import",
        sessionId: item.turn.sessionId,
        sessionKey,
        ...(agentId ? { agentId } : {}),
        role: item.turn.role,
        originalTimestamp: item.turn.timestamp,
      }),
    };
  });

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

export function listSessions(sessionsDir: string, opts?: { includeDeleted?: boolean }): SessionInfo[] {
  if (!existsSync(sessionsDir)) return [];

  return readdirSync(sessionsDir)
    .filter(f => {
      if (f === "sessions.json") return false;
      if (opts?.includeDeleted) {
        return f.includes(".jsonl");
      }
      return f.endsWith(".jsonl") && !f.includes(".deleted");
    })
    .map(f => {
      const path = join(sessionsDir, f);
      const turns = parseSessionFile(path);
      return {
        id: basename(f).replace(/\.jsonl(\.deleted\.\d+)?$/, ""),
        path,
        turnCount: turns.length,
        isAutomated: turns.length === 0,
      };
    });
}
