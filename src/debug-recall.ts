/**
 * Debug capture for the final injected recall payload (issue #23).
 *
 * When `MEMEX_DEBUG_RECALL=1` (or a path) is set, every auto-recall turn
 * writes a JSON snapshot of the recall results AND the actual text that
 * was prepended to the prompt. Lets you answer "what low-quality items
 * actually made it into the context this turn?" — the question that's
 * otherwise impossible to answer from logs alone.
 *
 * Disabled by default. Zero overhead when off — the env-var check is the
 * first thing that runs and bails immediately if not set.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { RetrievalTrace } from "./retrieval-trace.js";

export interface DebugRecallPayload {
  /** Stable 8-char hex id for this recall — also in the filename, so a query
   *  can be loaded by id (scripts/show-trace.ts). */
  debugId?: string;
  /** ISO timestamp the snapshot was captured at. */
  ts: string;
  agentId: string;
  sessionId: string | null;
  query: string;
  /** Which retrieval path produced these results. */
  source: "unified-recall" | "memory-only" | "mcp-recall";
  /** Total result count (== results.length). */
  resultCount: number;
  /** The exact text that was prepended to the prompt (auto-recall paths). */
  injectedContext: string;
  /** Per-item details — text is truncated to 500 chars to keep payloads small. */
  results: Array<{
    id: string;
    score: number;
    source?: "conversation" | "document" | "vector" | "lexical" | "both" | "reranked";
    text: string;
    metadata?: unknown;
  }>;
  /** Full per-stage ranking trace (only when captureTrace was on). Absent on
   *  the legacy auto-recall path unless capture is enabled there. */
  trace?: RetrievalTrace;
}

/**
 * Resolve the debug output directory from the env. Returns `null` when
 * debug capture is off. Otherwise returns the directory path. When the
 * env var is `1` / `true` / `on`, defaults to `${tmpdir()}/memex-debug-recall/`.
 * When set to any other string, treats it as a literal directory path.
 */
export function resolveDebugDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.MEMEX_DEBUG_RECALL;
  if (!v) return null;
  if (v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "on") {
    return join(tmpdir(), "memex-debug-recall");
  }
  if (v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "off") {
    return null;
  }
  return v;
}

/**
 * Write a debug payload to disk. Failures are swallowed — debug capture
 * must never break a real recall turn. Returns the file path written
 * (for tests + telemetry), or `null` when capture was off or write failed.
 */
export async function writeDebugRecall(
  payload: DebugRecallPayload,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const dir = resolveDebugDir(env);
  if (!dir) return null;

  // Addressable by debugId when present (preferred); fall back to ts+agentId
  // for legacy callers that don't supply one.
  const stem = payload.debugId
    ? payload.debugId
    : `${payload.ts.replace(/[:.]/g, "-")}-${payload.agentId}`;
  const filename = `${stem}.json`;
  const path = join(dir, filename);

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
    return path;
  } catch {
    return null;
  }
}

/**
 * Helper: build a debug payload from the unified-recall path's outputs.
 * Truncates result text to 500 chars per item.
 */
export function buildPayloadFromUnifiedRecall(args: {
  agentId: string;
  sessionId: string | null;
  query: string;
  injectedContext: string;
  debugId?: string;
  trace?: RetrievalTrace;
  results: Array<{
    id: string;
    score: number;
    source: "conversation" | "document";
    text: string;
    metadata: unknown;
  }>;
}): DebugRecallPayload {
  return {
    ts: new Date().toISOString(),
    ...(args.debugId ? { debugId: args.debugId } : {}),
    agentId: args.agentId,
    sessionId: args.sessionId,
    query: args.query,
    source: "unified-recall",
    resultCount: args.results.length,
    injectedContext: args.injectedContext,
    results: args.results.map((r) => ({
      id: r.id,
      score: r.score,
      source: r.source,
      text: r.text.slice(0, 500),
      metadata: r.metadata,
    })),
    ...(args.trace ? { trace: args.trace } : {}),
  };
}

/**
 * Helper: build a debug payload from the memory-only fallback path.
 */
export function buildPayloadFromMemoryOnly(args: {
  agentId: string;
  sessionId: string | null;
  query: string;
  injectedContext: string;
  debugId?: string;
  trace?: RetrievalTrace;
  results: Array<{
    entry: { id: string; text: string; category?: string; scope?: string };
    score: number;
  }>;
}): DebugRecallPayload {
  return {
    ts: new Date().toISOString(),
    ...(args.debugId ? { debugId: args.debugId } : {}),
    agentId: args.agentId,
    sessionId: args.sessionId,
    query: args.query,
    source: "memory-only",
    resultCount: args.results.length,
    injectedContext: args.injectedContext,
    results: args.results.map((r) => ({
      id: r.entry.id,
      score: r.score,
      text: r.entry.text.slice(0, 500),
      metadata: { category: r.entry.category, scope: r.entry.scope },
    })),
    ...(args.trace ? { trace: args.trace } : {}),
  };
}

/**
 * Helper: build a debug payload from the MCP memory_recall path (the daemon's
 * explicit recall). The MCP path doesn't inject context into a prompt — it
 * returns results to the client — so `injectedContext` is the empty string.
 */
export function buildPayloadFromMcpRecall(args: {
  debugId: string;
  agentId: string;
  sessionId: string | null;
  query: string;
  trace?: RetrievalTrace;
  results: Array<{
    id: string;
    score: number;
    source?: "vector" | "lexical" | "both" | "reranked";
    text: string;
    category?: string;
    scope?: string;
  }>;
}): DebugRecallPayload {
  return {
    ts: new Date().toISOString(),
    debugId: args.debugId,
    agentId: args.agentId,
    sessionId: args.sessionId,
    query: args.query,
    source: "mcp-recall",
    resultCount: args.results.length,
    injectedContext: "",
    results: args.results.map((r) => ({
      id: r.id,
      score: r.score,
      ...(r.source ? { source: r.source } : {}),
      text: r.text.slice(0, 500),
      metadata: { category: r.category, scope: r.scope },
    })),
    ...(args.trace ? { trace: args.trace } : {}),
  };
}
