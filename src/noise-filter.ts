/**
 * Noise Filter
 * Filters out low-quality memories (meta-questions, agent denials, session boilerplate)
 * Inspired by openclaw-plugin-continuity's noise filtering approach.
 */

// Agent-side denial patterns
const DENIAL_PATTERNS = [
  /i don'?t have (any )?(information|data|memory|record)/i,
  /i'?m not sure about/i,
  /i don'?t recall/i,
  /i don'?t remember/i,
  /it looks like i don'?t/i,
  /i wasn'?t able to find/i,
  /no (relevant )?memories found/i,
  /i don'?t have access to/i,
];

// User-side meta-question patterns (about memory itself, not content)
const META_QUESTION_PATTERNS = [
  /\bdo you (remember|recall|know about)\b/i,
  /\bcan you (remember|recall)\b/i,
  /\bdid i (tell|mention|say|share)\b/i,
  /\bhave i (told|mentioned|said)\b/i,
  /\bwhat did i (tell|say|mention)\b/i,
];

// Discord/platform metadata and system-injected content
const PLATFORM_METADATA_PATTERNS = [
  /^Conversation info \(untrusted metadata\)/,
  /^\[Thread starter/,
  /^\[.*\] \[System Message\]/,
  /^<[a-zA-Z][\w-]*>.*<\/[a-zA-Z][\w-]*>$/s,  // XML system tags
  /^\[Discord (Guild|DM)\b/,  // Discord envelope lines (e.g. [Discord Guild #channel ...])
  /^\[\[reply_to_current\]\]/i,  // Discord reply markers
];

// Short filler (assistant acknowledgments, status pings, bare filenames)
const FILLER_PATTERNS = [
  /^(got it|done|ok|sure|right|yep|nice|cool|perfect)[.!]?$/i,
  /^NO_REPLY$/,
  /^[\w.-]+\.(png|jpg|jpeg|gif|svg|webp|pdf|mp4|mp3|zip)$/i,  // bare filenames
  /^yo\b.*👋/i,  // casual greetings with emoji
  /^(siren|status)\s+(ok|up|down)\b/i,  // bot status pings
  /^没卡住/,  // Chinese "not stuck" filler
];

// Session boilerplate
const BOILERPLATE_PATTERNS = [
  /^(hi|hello|hey|good morning|good evening|greetings)\b.{0,30}$/i,
  /^fresh session/i,
  /^new session/i,
  /^HEARTBEAT/i,
  /^(I'm here|I'm ready|I'm listening|What do you need)/i,
  /^(Everything looks healthy|model responding|context at \d+%)/i,  // agent health status
];

export interface NoiseFilterOptions {
  /** Filter agent denial responses (default: true) */
  filterDenials?: boolean;
  /** Filter meta-questions about memory (default: true) */
  filterMetaQuestions?: boolean;
  /** Filter session boilerplate (default: true) */
  filterBoilerplate?: boolean;
  /** Filter platform metadata like Discord envelopes (default: true) */
  filterPlatformMetadata?: boolean;
  /** Filter short filler responses (default: true) */
  filterFiller?: boolean;
}

const DEFAULT_OPTIONS: Required<NoiseFilterOptions> = {
  filterDenials: true,
  filterMetaQuestions: true,
  filterBoilerplate: true,
  filterPlatformMetadata: true,
  filterFiller: true,
};

/**
 * Check if a memory text is noise that should be filtered out.
 * Returns true if the text is noise.
 */
export function isNoise(text: string, options: NoiseFilterOptions = {}): boolean {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const trimmed = text.trim();

  if (trimmed.length < 5) return true;

  if (opts.filterDenials && DENIAL_PATTERNS.some(p => p.test(trimmed))) return true;
  if (opts.filterMetaQuestions && META_QUESTION_PATTERNS.some(p => p.test(trimmed))) return true;
  if (opts.filterBoilerplate && BOILERPLATE_PATTERNS.some(p => p.test(trimmed))) return true;
  if (opts.filterPlatformMetadata && PLATFORM_METADATA_PATTERNS.some(p => p.test(trimmed))) return true;
  if (opts.filterFiller && FILLER_PATTERNS.some(p => p.test(trimmed))) return true;

  return false;
}

// Memory management / meta-ops: do not store as long-term memory
const CAPTURE_EXCLUDE_PATTERNS = [
  /\b(memory-pro|memory_store|memory_recall|memory_forget|memory_update)\b/i,
  /\bopenclaw\s+memory-pro\b/i,
  /\b(delete|remove|forget|purge|cleanup|clean up|clear)\b.*\b(memory|memories|entry|entries)\b/i,
  /\b(memory|memories)\b.*\b(delete|remove|forget|purge|cleanup|clean up|clear)\b/i,
  /\bhow do i\b.*\b(delete|remove|forget|purge|cleanup|clear)\b/i,
  /(删除|刪除|清理|清除).{0,12}(记忆|記憶|memory)/i,
];

/**
 * Detect text that was truncated mid-sentence (cut by length limit, incomplete paste, etc.).
 * Truncated text is low-quality for memory storage — it lacks complete meaning.
 */
export function isTruncated(text: string): boolean {
  const s = text.trim();
  if (s.length < 20) return false;
  // Ends mid-word (no sentence-terminal punctuation)
  if (s.includes(' ') && s.length > 80 && /[a-zA-Z]$/.test(s) && !/[.!?;:)\]"']$/.test(s)) return true;
  // Clipping artifacts: ends with dash
  if (/\s[-–—]$/.test(s)) return true;
  // Exact truncation boundary lengths without terminal punctuation
  if ([500, 1000, 1500, 2000, 4096].includes(s.length) && !/[.!?]$/.test(s)) return true;
  // Unmatched opening brackets (text cut mid-structure)
  const opens = (s.match(/[(\[{]/g) || []).length;
  const closes = (s.match(/[)\]}]/g) || []).length;
  if (opens > closes && s.length > 100) return true;
  return false;
}

/**
 * Fast structural pre-filter for auto-capture: returns true if the text is
 * structurally not memory-worthy. These are O(1) checks, not semantic judgment.
 */
export function isStructuralNoise(text: string): boolean {
  const s = text.trim();
  // Too short or too long
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(s);
  if (s.length < (hasCJK ? 4 : 10) || s.length > 2000) return true;
  // Injected memory context
  if (s.includes("<relevant-memories>")) return true;
  // XML system tags
  if (s.startsWith("<") && s.includes("</")) return true;
  // Discord metadata envelopes
  if (s.startsWith("Conversation info (untrusted metadata)")) return true;
  // Thread starter preambles
  if (s.startsWith("[Thread starter")) return true;
  // Discord Guild/DM envelope lines
  if (s.startsWith("[Discord ")) return true;
  // JSON code blocks (metadata dumps)
  if (s.includes("```json\n{")) return true;
  // Memory management commands
  if (CAPTURE_EXCLUDE_PATTERNS.some(r => r.test(s))) return true;
  // Truncated text (cut mid-sentence, unmatched brackets, etc.)
  if (isTruncated(s)) return true;

  // --- Code and structured-data filters ---

  // Tool output markers (lines starting with tool result wrappers)
  if (/^(\[tool_result\]|<tool_result>|<function_result>|Tool output:)/im.test(s)) return true;

  const lines = s.split("\n");

  // Code-heavy content: >50% of lines are inside fenced code blocks
  {
    let inFence = false;
    let codeLines = 0;
    for (const line of lines) {
      if (/^```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) codeLines++;
    }
    if (lines.length > 3 && codeLines / lines.length > 0.5) return true;
  }

  // Stack traces: multiple lines matching stack frame patterns
  {
    const stackFrameRe = /^\s+at [\w$./<>]+[\s(]|^\s+at (async )?[\w$./<>]+\s*\(/;
    const pythonTrace = /^Traceback \(most recent call last\):/m;
    const javaTrace = /^\s+at java\.\w/m;
    if (pythonTrace.test(s) || javaTrace.test(s)) return true;
    const stackMatches = lines.filter(l => stackFrameRe.test(l)).length;
    if (stackMatches >= 3) return true;
  }

  // Base64 blobs: long runs of base64 chars (>100 chars) with no spaces
  if (/(?<!\S)[A-Za-z0-9+/]{100,}={0,2}(?!\S)/.test(s)) return true;

  // CSV/TSV data: >3 lines each with >5 delimited fields
  {
    const csvLikeLines = lines.filter(l => {
      const commaFields = l.split(",").length;
      const tabFields = l.split("\t").length;
      return commaFields > 5 || tabFields > 5;
    });
    if (csvLikeLines.length > 3) return true;
  }

  // Log lines: >3 lines matching timestamp or log-level patterns
  {
    const logLineRe = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\[(INFO|ERROR|WARN|DEBUG|TRACE)\]/;
    const logMatches = lines.filter(l => logLineRe.test(l)).length;
    if (logMatches > 3) return true;
  }

  return false;
}

/**
 * Filter assistant message text for auto-capture.
 * Strips code blocks, tool output, stack traces, base64 blobs.
 * Returns cleaned text or null if nothing useful remains.
 */
export function filterAssistantText(text: string): string | null {
  let s = text;

  // Strip fenced code blocks (``` ... ```)
  s = s.replace(/^```[\s\S]*?^```/gm, "");

  // Strip XML-style tool output blocks (<tool_result>...</tool_result>, etc.)
  s = s.replace(/<(tool_result|function_result|tool_output)>[\s\S]*?<\/\1>/gi, "");

  // Strip bracket-style tool output ([tool_result]...[/tool_result])
  s = s.replace(/\[tool_result\][\s\S]*?\[\/tool_result\]/gi, "");

  // Strip stack trace lines (  at Object.<anonymous> ...)
  s = s.replace(/^[ \t]+at .+\(.+:\d+:\d+\).*$/gm, "");

  // Strip base64 blobs (100+ chars of base64 alphabet without spaces)
  s = s.replace(/[A-Za-z0-9+/]{100,}={0,2}/g, "");

  // Collapse multiple blank lines to one
  s = s.replace(/\n{3,}/g, "\n\n");

  // Trim
  s = s.trim();

  // If nothing useful remains, return null
  if (!s || s.length < 10) return null;

  return s;
}

/**
 * Scan memory entries and return IDs of noise entries.
 * Used by both startup health check and purge-noise CLI command.
 */
export function identifyNoiseEntries(
  entries: Array<{ id: string; text: string }>,
): Array<{ id: string; text: string; reason: "structural" | "semantic" }> {
  const noise: Array<{ id: string; text: string; reason: "structural" | "semantic" }> = [];
  for (const entry of entries) {
    if (isStructuralNoise(entry.text)) {
      noise.push({ id: entry.id, text: entry.text, reason: "structural" });
    } else if (isNoise(entry.text)) {
      noise.push({ id: entry.id, text: entry.text, reason: "semantic" });
    }
  }
  return noise;
}

// ============================================================================
// Envelope extraction — pull human text out of OpenClaw message wrappers
// ============================================================================

// Envelope types that never contain human text worth capturing
const NON_HUMAN_PREFIXES = [
  "[Thread starter",
  "<relevant-memories>",
  "System:",
  "Pre-compaction",
  "[cron:",
];

/**
 * Extract human text from OpenClaw message envelopes.
 * Returns the human text if present, null if the message should be filtered,
 * or the original text if no envelope is detected.
 */
export function extractHumanText(text: string): string | null {
  const s = text.trim();
  if (!s) return null;

  // Non-human envelope types → filter entirely
  for (const prefix of NON_HUMAN_PREFIXES) {
    if (s.startsWith(prefix)) return null;
  }

  // Injected memory context
  if (s.includes("<relevant-memories>")) return null;

  // Discord/OpenClaw metadata envelope:
  // Conversation info (untrusted metadata):
  // ```json
  // { ... }
  // ```
  //
  // Sender (untrusted metadata):
  // ```json
  // { ... }
  // ```
  //
  // <actual human text>
  if (s.startsWith("Conversation info (untrusted metadata)")) {
    // Find the last closing ``` block boundary followed by blank line
    // Pattern: }\n```\n\n (end of last JSON metadata block)
    const lastFence = s.lastIndexOf("```\n\n");
    if (lastFence === -1) {
      // Try variant with just ``` at the very end of metadata
      const altFence = s.lastIndexOf("```\n");
      if (altFence === -1) return null;
      const after = s.slice(altFence + 4).trim();
      return after.length > 0 ? after : null;
    }
    const after = s.slice(lastFence + 5).trim();
    return after.length > 0 ? after : null;
  }

  // Queued messages batch:
  // [Queued messages while agent was busy]
  // <individual messages, possibly with envelopes>
  if (s.startsWith("[Queued messages while agent was busy]")) {
    const body = s.slice("[Queued messages while agent was busy]".length).trim();
    if (!body) return null;
    // The body may itself contain envelope-wrapped messages — recurse
    const extracted = extractHumanText(body);
    return extracted;
  }

  // XML system tags (e.g., <system-reminder>...</system-reminder>)
  if (s.startsWith("<") && s.includes("</")) return null;

  // No envelope detected — return as-is
  return s;
}

/**
 * Filter an array of items, removing noise entries.
 */
export function filterNoise<T>(
  items: T[],
  getText: (item: T) => string,
  options?: NoiseFilterOptions
): T[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return items.filter(item => !isNoise(getText(item), opts));
}
