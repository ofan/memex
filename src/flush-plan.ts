type CompactionMemoryFlushConfig = {
  enabled?: boolean;
  softThresholdTokens?: number;
  forceFlushTranscriptBytes?: number | string;
  prompt?: string;
  systemPrompt?: string;
};

type OpenClawLikeConfig = {
  agents?: {
    defaults?: {
      userTimezone?: string;
      compaction?: {
        reserveTokensFloor?: number;
        memoryFlush?: CompactionMemoryFlushConfig;
      };
    };
  };
};

type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};

const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;
const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MEMORY_FLUSH_RESERVE_TOKENS_FLOOR = 20000;
const TARGET_HINT = "Store durable memories with the memory_store tool.";
const APPEND_ONLY_HINT = "If you must use file tools instead, append only to memory/YYYY-MM-DD.md and never overwrite existing content.";
const READ_ONLY_HINT = "Treat bootstrap and reference files such as MEMORY.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush.";
const NO_REPLY_HINT = "If there is nothing worth storing or no user-visible reply is needed, reply with NO_REPLY.";

const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Capture durable user preferences, decisions, conventions, and long-lived facts before context is compacted.",
  TARGET_HINT,
  APPEND_ONLY_HINT,
  READ_ONLY_HINT,
  NO_REPLY_HINT,
].join(" ");

const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; persist only durable memories now.",
  TARGET_HINT,
  APPEND_ONLY_HINT,
  READ_ONLY_HINT,
  NO_REPLY_HINT,
].join(" ");

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : fallback;
}

function parseByteSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized >= 0 ? normalized : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/.exec(trimmed);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const unit = match[2] || "b";
  const multiplier =
    unit === "gb" ? 1024 * 1024 * 1024 :
    unit === "mb" ? 1024 * 1024 :
    unit === "kb" ? 1024 :
    1;

  return Math.floor(amount * multiplier);
}

function resolveTimezone(cfg?: OpenClawLikeConfig): string {
  return cfg?.agents?.defaults?.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatDateStamp(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : new Date(nowMs).toISOString().slice(0, 10);
}

function formatCurrentTimeLine(nowMs: number, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return `Current time: ${formatter.format(new Date(nowMs))}`;
}

function ensureHint(text: string, hint: string): string {
  return text.includes(hint) ? text : `${text}\n\n${hint}`.trim();
}

function ensureSafetyHints(text: string): string {
  let next = text.trim();
  next = ensureHint(next, TARGET_HINT);
  next = ensureHint(next, APPEND_ONLY_HINT);
  next = ensureHint(next, READ_ONLY_HINT);
  next = ensureHint(next, NO_REPLY_HINT);
  return next;
}

function appendCurrentTimeLine(text: string, timeLine: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return timeLine;
  if (trimmed.includes("Current time:")) return trimmed;
  return `${trimmed}\n${timeLine}`;
}

export function buildMemoryFlushPlan(params: {
  cfg?: OpenClawLikeConfig;
  nowMs?: number;
} = {}): MemoryFlushPlan | null {
  const cfg = params.cfg;
  const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush;
  if (defaults?.enabled === false) return null;

  const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const timezone = resolveTimezone(cfg);
  const dateStamp = formatDateStamp(nowMs, timezone);
  const timeLine = formatCurrentTimeLine(nowMs, timezone);

  const softThresholdTokens = normalizeNonNegativeInt(
    defaults?.softThresholdTokens,
    DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  );
  const forceFlushTranscriptBytes =
    parseByteSize(defaults?.forceFlushTranscriptBytes) ?? DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;
  const reserveTokensFloor = normalizeNonNegativeInt(
    cfg?.agents?.defaults?.compaction?.reserveTokensFloor,
    DEFAULT_MEMORY_FLUSH_RESERVE_TOKENS_FLOOR,
  );

  const promptTemplate = ensureSafetyHints(defaults?.prompt?.trim() || DEFAULT_MEMORY_FLUSH_PROMPT);
  const systemPromptTemplate = ensureSafetyHints(defaults?.systemPrompt?.trim() || DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT);

  return {
    softThresholdTokens,
    forceFlushTranscriptBytes,
    reserveTokensFloor,
    prompt: appendCurrentTimeLine(promptTemplate.replaceAll("YYYY-MM-DD", dateStamp), timeLine),
    systemPrompt: systemPromptTemplate.replaceAll("YYYY-MM-DD", dateStamp),
    relativePath: `memory/${dateStamp}.md`,
  };
}
