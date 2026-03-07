/**
 * Importance Scoring Experiment
 *
 * Compares 3 methods for deciding what conversation turns are worth remembering:
 *   A. Heuristic (shouldCapture + isNoise from existing codebase)
 *   B. Reranker (bge-reranker-v2-m3 against reference query)
 *   C. Generation LLM (Qwen3-0.6B structured scoring prompt)
 *
 * Usage:
 *   node --import jiti/register tests/importance-experiment.ts [--extract-only] [--score-only] [--label]
 *
 * Flags:
 *   --extract-only  Only extract and cache samples, skip scoring
 *   --score-only    Score cached samples (skip extraction)
 *   --label         Output samples for human labeling (TSV format)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { isNoise } from "../src/noise-filter.js";

// Re-implement shouldCapture + detectCategory here to avoid importing index.ts
// (which has side effects and requires plugin-sdk). These are copied from index.ts.

const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\b(we )?decided\b|we'?ll use|we will use|switch(ed)? to|migrate(d)? to|going forward|from now on/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need|care)/i,
  /always|never|important/i,
  /記住|记住|記一下|记一下|別忘了|别忘了|備註|备注/,
  /偏好|喜好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/,
  /決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用/,
  /我的\S+是|叫我|稱呼|称呼/,
  /老是|講不聽|總是|总是|從不|从不|一直|每次都/,
  /重要|關鍵|关键|注意|千萬別|千万别/,
  /幫我|筆記|存檔|存起來|存一下|重點|原則|底線/,
];

const CAPTURE_EXCLUDE_PATTERNS = [
  /\b(memory-pro|memory_store|memory_recall|memory_forget|memory_update)\b/i,
  /\bopenclaw\s+memory-pro\b/i,
  /\b(delete|remove|forget|purge|cleanup|clean up|clear)\b.*\b(memory|memories|entry|entries)\b/i,
  /\b(memory|memories)\b.*\b(delete|remove|forget|purge|cleanup|clean up|clear)\b/i,
  /\bhow do i\b.*\b(delete|remove|forget|purge|cleanup|clear)\b/i,
  /(删除|刪除|清理|清除).{0,12}(记忆|記憶|memory)/i,
];

function shouldCapture(text: string): boolean {
  const s = text.trim();
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(s);
  const minLen = hasCJK ? 4 : 10;
  if (s.length < minLen || s.length > 500) return false;
  if (s.includes("<relevant-memories>")) return false;
  if (s.startsWith("<") && s.includes("</")) return false;
  if (s.includes("**") && s.includes("\n-")) return false;
  const emojiCount = (s.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  if (CAPTURE_EXCLUDE_PATTERNS.some((r) => r.test(s))) return false;
  return MEMORY_TRIGGERS.some((r) => r.test(s));
}

function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/prefer|radši|like|love|hate|want|偏好|喜歡|喜欢|討厭|讨厌/i.test(lower)) return "preference";
  if (/decided|will use|switch(ed)? to|migrate(d)? to|going forward|from now on|決定|决定/i.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|我的\S+是|叫我/i.test(lower)) return "entity";
  if (/\b(is|are|has|have)\b/i.test(lower)) return "fact";
  return "other";
}

// ============================================================================
// Types
// ============================================================================

interface Turn {
  sessionId: string;
  timestamp: string;
  role: "user" | "assistant";
  text: string;
  charLen: number;
}

interface ScoredSample extends Turn {
  index: number;
  // Method A: Heuristic
  heuristic: {
    shouldCapture: boolean;
    isNoise: boolean;
    category: string;
    score: number; // 1.0 if capture && !noise, 0.0 otherwise
  };
  // Method B: Reranker
  reranker?: {
    score: number;
  };
  // Method C: Generation LLM
  llm?: {
    score: number;
    raw: string;
  };
  // Human label (filled in later)
  humanLabel?: "yes" | "no" | "maybe";
}

// ============================================================================
// Step 1: Parse Sessions & Extract Turns
// ============================================================================

const SESSIONS_DIR = join(process.env.HOME || "/home/ubuntu", ".openclaw", "agents", "main", "sessions");
const CACHE_DIR = join(import.meta.dirname || __dirname, ".cache");
const SAMPLES_PATH = join(CACHE_DIR, "importance-samples.json");
const SCORES_PATH = join(CACHE_DIR, "importance-scores.json");
const LABELS_PATH = join(CACHE_DIR, "importance-labels.tsv");

// Patterns that indicate automated/bot sessions
const AUTOMATED_PATTERNS = [
  /^\[cron:/,
  /^Task: Gmail/,
  /^Task: Email/,
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

function parseSessionFile(path: string): Turn[] {
  const turns: Turn[] = [];
  const sessionId = basename(path).replace(/\.jsonl$/, "");
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);

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

    // Check for automated content
    if (msg.role === "user" && isAutomatedMessage(text)) {
      hasAutomatedContent = true;
    }

    turns.push({
      sessionId,
      timestamp: entry.timestamp || "",
      role: msg.role,
      text,
      charLen: text.length,
    });
  }

  // If the first user message is automated, skip the entire session
  if (hasAutomatedContent) return [];

  return turns;
}

function extractAllTurns(): Turn[] {
  if (!existsSync(SESSIONS_DIR)) {
    console.error(`Sessions directory not found: ${SESSIONS_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".jsonl") && !f.includes(".deleted"))
    .map(f => join(SESSIONS_DIR, f));

  console.warn(`Found ${files.length} session files`);

  const allTurns: Turn[] = [];
  let skippedSessions = 0;

  for (const file of files) {
    const turns = parseSessionFile(file);
    if (turns.length === 0) {
      skippedSessions++;
      continue;
    }
    allTurns.push(...turns);
  }

  console.warn(`Extracted ${allTurns.length} turns from ${files.length - skippedSessions} sessions (skipped ${skippedSessions} automated sessions)`);
  return allTurns;
}

function sampleTurns(turns: Turn[], count: number = 100): Turn[] {
  // Stratified sampling: ~33 short, ~33 medium, ~34 long
  const short = turns.filter(t => t.charLen < 100);
  const medium = turns.filter(t => t.charLen >= 100 && t.charLen <= 500);
  const long = turns.filter(t => t.charLen > 500);

  console.warn(`Distribution: ${short.length} short, ${medium.length} medium, ${long.length} long`);

  const targetShort = Math.min(33, short.length);
  const targetMedium = Math.min(33, medium.length);
  const targetLong = Math.min(34, long.length);

  // Fill remaining quota from other buckets
  const remaining = count - targetShort - targetMedium - targetLong;

  const shuffle = <T>(arr: T[]): T[] => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const sampled = [
    ...shuffle(short).slice(0, targetShort),
    ...shuffle(medium).slice(0, targetMedium),
    ...shuffle(long).slice(0, targetLong),
  ];

  // Fill remaining from all turns
  if (remaining > 0) {
    const usedIds = new Set(sampled.map(t => `${t.sessionId}:${t.timestamp}`));
    const unused = shuffle(turns).filter(t => !usedIds.has(`${t.sessionId}:${t.timestamp}`));
    sampled.push(...unused.slice(0, remaining));
  }

  return shuffle(sampled);
}

// ============================================================================
// Step 2: Score with 3 Methods
// ============================================================================

// Method A: Heuristic
function scoreHeuristic(text: string): ScoredSample["heuristic"] {
  const capture = shouldCapture(text);
  const noise = isNoise(text);
  const category = detectCategory(text);
  return {
    shouldCapture: capture,
    isNoise: noise,
    category,
    score: capture && !noise ? 1.0 : 0.0,
  };
}

// Method B: Reranker
const RERANKER_ENDPOINT = "http://100.122.104.26:8090/rerank";
const RERANKER_MODEL = "bge-reranker-v2-m3-Q8_0";
const RERANKER_QUERY = "Important knowledge, preference, decision, fact, or technical detail worth remembering long-term";

/** Sigmoid normalization for raw cross-encoder logits */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

async function scoreRerankerBatch(texts: string[], batchSize: number = 20): Promise<number[]> {
  const scores: number[] = new Array(texts.length).fill(0);

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const body = {
      model: RERANKER_MODEL,
      query: RERANKER_QUERY,
      documents: batch,
      top_n: batch.length,
    };

    try {
      const resp = await fetch(RERANKER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        console.warn(`Reranker batch ${i}-${i + batch.length} failed: ${resp.status}`);
        continue;
      }

      const data = await resp.json() as any;
      const results = data.results || data.data || [];

      for (const item of results) {
        const idx = item.index;
        const score = item.relevance_score ?? item.score ?? 0;
        if (typeof idx === "number" && idx >= 0 && idx < batch.length) {
          scores[i + idx] = sigmoid(score);
        }
      }
    } catch (err) {
      console.warn(`Reranker batch ${i}-${i + batch.length} error:`, err);
    }

    // Small delay between batches
    if (i + batchSize < texts.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return scores;
}

// Method C: Generation LLM
const LLM_ENDPOINT = "http://100.122.104.26:8090/v1/chat/completions";

async function checkLLMAvailable(): Promise<boolean> {
  try {
    const resp = await fetch("http://100.122.104.26:8090/v1/models", {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return false;
    const data = await resp.json() as any;
    const models = data.data || [];
    // Look for a generation model (exclude embedding/reranker models)
    return models.some((m: any) => {
      const id = (m.id || "").toLowerCase();
      if (/embed|rerank/i.test(id)) return false;
      return /qwen|llama|gemma|phi|mistral/i.test(id);
    });
  } catch {
    return false;
  }
}

async function scoreLLM(text: string): Promise<{ score: number; raw: string }> {
  const truncated = text.slice(0, 1000);
  const body = {
    model: "Qwen3-0.6B-Instruct",
    messages: [
      {
        role: "system",
        content: `Score messages for an AI memory system (0.0-1.0). Remember = preference, decision, fact, technical detail. Forget = greeting, filler, acknowledgment, status, system output, short reactions. Examples:
"I prefer dark mode" → 0.9
"Hello" → 0.0
"We decided to use PostgreSQL" → 0.9
"OK sounds good" → 0.1
"Sure, go ahead" → 0.0
"yeah go for it" → 0.1
"thanks" → 0.0
"HEARTBEAT_OK" → 0.0
"My SSH key is on the bastion host" → 0.8
Reply with ONLY the score number.`,
      },
      {
        role: "user",
        content: truncated,
      },
    ],
    temperature: 0.0,
    max_tokens: 512, // Qwen3 uses reasoning tokens; needs headroom
  };

  try {
    const resp = await fetch(LLM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return { score: -1, raw: `HTTP ${resp.status}` };
    }

    const data = await resp.json() as any;
    const raw = data.choices?.[0]?.message?.content?.trim() || "";
    const match = raw.match(/(\d+\.?\d*)/);
    const score = match ? parseFloat(match[1]) : -1;
    return { score: Math.min(1.0, Math.max(0.0, score)), raw };
  } catch (err: any) {
    return { score: -1, raw: err.message || String(err) };
  }
}

// ============================================================================
// Step 3: Run Experiment
// ============================================================================

async function runExperiment() {
  const args = process.argv.slice(2);
  const extractOnly = args.includes("--extract-only");
  const scoreOnly = args.includes("--score-only");
  const labelMode = args.includes("--label");

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  // --- Extract samples ---
  let samples: Turn[];
  if (scoreOnly && existsSync(SAMPLES_PATH)) {
    samples = JSON.parse(readFileSync(SAMPLES_PATH, "utf-8"));
    console.warn(`Loaded ${samples.length} cached samples`);
  } else {
    const allTurns = extractAllTurns();
    samples = sampleTurns(allTurns, 100);
    writeFileSync(SAMPLES_PATH, JSON.stringify(samples, null, 2));
    console.warn(`Cached ${samples.length} samples to ${SAMPLES_PATH}`);
  }

  if (extractOnly) {
    console.warn("Extract-only mode — done.");
    return;
  }

  // --- Score samples ---
  console.warn("\n=== Method A: Heuristic (shouldCapture + isNoise) ===");
  const scored: ScoredSample[] = samples.map((turn, idx) => ({
    ...turn,
    index: idx,
    heuristic: scoreHeuristic(turn.text),
  }));

  const heuristicCaptures = scored.filter(s => s.heuristic.score > 0);
  console.warn(`Heuristic: ${heuristicCaptures.length}/${scored.length} captured (${(heuristicCaptures.length / scored.length * 100).toFixed(1)}%)`);

  console.warn("\n=== Method B: Reranker (bge-reranker-v2-m3) ===");
  const texts = scored.map(s => s.text);
  try {
    const rerankScores = await scoreRerankerBatch(texts);
    for (let i = 0; i < scored.length; i++) {
      scored[i].reranker = { score: rerankScores[i] };
    }
    const rerankAbove50 = scored.filter(s => (s.reranker?.score ?? 0) > 0.5);
    console.warn(`Reranker: ${rerankAbove50.length}/${scored.length} scored >0.5 (${(rerankAbove50.length / scored.length * 100).toFixed(1)}%)`);
  } catch (err) {
    console.warn("Reranker scoring failed:", err);
  }

  console.warn("\n=== Method C: Generation LLM (Qwen3-0.6B) ===");
  const llmAvailable = await checkLLMAvailable();
  if (llmAvailable) {
    console.warn("Generation model detected — scoring...");
    for (let i = 0; i < scored.length; i++) {
      scored[i].llm = await scoreLLM(scored[i].text);
      if ((i + 1) % 10 === 0) {
        console.warn(`  LLM scored ${i + 1}/${scored.length}`);
      }
      // Rate limit
      await new Promise(r => setTimeout(r, 50));
    }
    const llmAbove50 = scored.filter(s => (s.llm?.score ?? 0) > 0.5);
    console.warn(`LLM: ${llmAbove50.length}/${scored.length} scored >0.5 (${(llmAbove50.length / scored.length * 100).toFixed(1)}%)`);
  } else {
    console.warn("Generation model NOT available — skipping Method C.");
    console.warn("Deploy Qwen3-0.6B on Mac Mini and re-run to include LLM scoring.");
  }

  // Save scores
  writeFileSync(SCORES_PATH, JSON.stringify(scored, null, 2));
  console.warn(`\nScores saved to ${SCORES_PATH}`);

  // --- Output for labeling ---
  if (labelMode) {
    outputLabeling(scored);
  }

  // --- Print comparison ---
  printComparison(scored);
}

// ============================================================================
// Step 4: Human Labeling Output
// ============================================================================

function outputLabeling(scored: ScoredSample[]) {
  const lines = ["index\trole\tcharLen\theuristic\treranker\tllm\ttext_preview\thuman_label"];
  for (const s of scored) {
    const preview = s.text.slice(0, 120).replace(/\t/g, " ").replace(/\n/g, " ");
    lines.push([
      s.index,
      s.role,
      s.charLen,
      s.heuristic.score.toFixed(1),
      s.reranker?.score?.toFixed(3) ?? "N/A",
      s.llm?.score?.toFixed(2) ?? "N/A",
      preview,
      "", // human fills this in
    ].join("\t"));
  }
  writeFileSync(LABELS_PATH, lines.join("\n") + "\n");
  console.warn(`\nLabeling file written to ${LABELS_PATH}`);
  console.warn("Fill in the 'human_label' column with: yes, no, or maybe");
}

// ============================================================================
// Step 5: Comparison & Analysis
// ============================================================================

function printComparison(scored: ScoredSample[]) {
  console.log("\n" + "=".repeat(70));
  console.log("IMPORTANCE SCORING EXPERIMENT — RESULTS");
  console.log("=".repeat(70));

  // Summary table
  const hasReranker = scored.some(s => s.reranker != null);
  const hasLLM = scored.some(s => s.llm != null && s.llm.score >= 0);

  console.log(`\nSamples: ${scored.length} turns (${scored.filter(s => s.role === "user").length} user, ${scored.filter(s => s.role === "assistant").length} assistant)`);

  // Score distributions
  console.log("\n--- Score Distributions ---");
  const thresholds = [0.1, 0.3, 0.5, 0.7, 0.9];
  const header = ["Threshold", "Heuristic", ...(hasReranker ? ["Reranker"] : []), ...(hasLLM ? ["LLM"] : [])];
  console.log(header.map(h => h.padStart(12)).join(""));

  for (const t of thresholds) {
    const hCount = scored.filter(s => s.heuristic.score >= t).length;
    const row = [
      `>= ${t.toFixed(1)}`.padStart(12),
      `${hCount}`.padStart(12),
    ];
    if (hasReranker) {
      const rCount = scored.filter(s => (s.reranker?.score ?? 0) >= t).length;
      row.push(`${rCount}`.padStart(12));
    }
    if (hasLLM) {
      const lCount = scored.filter(s => (s.llm?.score ?? 0) >= t).length;
      row.push(`${lCount}`.padStart(12));
    }
    console.log(row.join(""));
  }

  // Agreement matrix (at threshold 0.5)
  if (hasReranker) {
    console.log("\n--- Agreement Matrix (threshold 0.5) ---");
    const hSet = new Set(scored.filter(s => s.heuristic.score >= 0.5).map(s => s.index));
    const rSet = new Set(scored.filter(s => (s.reranker?.score ?? 0) >= 0.5).map(s => s.index));

    const bothYes = scored.filter(s => hSet.has(s.index) && rSet.has(s.index)).length;
    const hOnlyYes = scored.filter(s => hSet.has(s.index) && !rSet.has(s.index)).length;
    const rOnlyYes = scored.filter(s => !hSet.has(s.index) && rSet.has(s.index)).length;
    const bothNo = scored.filter(s => !hSet.has(s.index) && !rSet.has(s.index)).length;

    console.log(`                   Reranker>=0.5   Reranker<0.5`);
    console.log(`Heuristic>=0.5     ${String(bothYes).padStart(8)}       ${String(hOnlyYes).padStart(8)}`);
    console.log(`Heuristic<0.5      ${String(rOnlyYes).padStart(8)}       ${String(bothNo).padStart(8)}`);

    if (hasLLM) {
      const lSet = new Set(scored.filter(s => (s.llm?.score ?? 0) >= 0.5).map(s => s.index));
      console.log(`\n                   LLM>=0.5        LLM<0.5`);
      console.log(`Heuristic>=0.5     ${String(scored.filter(s => hSet.has(s.index) && lSet.has(s.index)).length).padStart(8)}       ${String(scored.filter(s => hSet.has(s.index) && !lSet.has(s.index)).length).padStart(8)}`);
      console.log(`Heuristic<0.5      ${String(scored.filter(s => !hSet.has(s.index) && lSet.has(s.index)).length).padStart(8)}       ${String(scored.filter(s => !hSet.has(s.index) && !lSet.has(s.index)).length).padStart(8)}`);
    }
  }

  // Most interesting: disagreements
  if (hasReranker) {
    console.log("\n--- Disagreements (Heuristic=0, Reranker>0.5) — potentially missed by heuristic ---");
    const missed = scored
      .filter(s => s.heuristic.score === 0 && (s.reranker?.score ?? 0) > 0.5)
      .sort((a, b) => (b.reranker?.score ?? 0) - (a.reranker?.score ?? 0))
      .slice(0, 10);

    for (const s of missed) {
      const preview = s.text.slice(0, 100).replace(/\n/g, " ");
      console.log(`  [${s.index}] rerank=${s.reranker!.score.toFixed(3)} role=${s.role} "${preview}..."`);
    }

    console.log("\n--- Disagreements (Heuristic=1, Reranker<0.3) — false positives by heuristic ---");
    const falsePos = scored
      .filter(s => s.heuristic.score === 1 && (s.reranker?.score ?? 0) < 0.3)
      .sort((a, b) => (a.reranker?.score ?? 0) - (b.reranker?.score ?? 0))
      .slice(0, 10);

    for (const s of falsePos) {
      const preview = s.text.slice(0, 100).replace(/\n/g, " ");
      console.log(`  [${s.index}] rerank=${s.reranker!.score.toFixed(3)} cat=${s.heuristic.category} "${preview}..."`);
    }
  }

  // If human labels exist, compute precision/recall
  if (existsSync(LABELS_PATH)) {
    console.log("\n--- Human Label Comparison ---");
    const labelData = readFileSync(LABELS_PATH, "utf-8").split("\n").slice(1).filter(Boolean);
    const labels = new Map<number, string>();
    for (const line of labelData) {
      const parts = line.split("\t");
      const idx = parseInt(parts[0]);
      const label = parts[parts.length - 1]?.trim().toLowerCase();
      if (label === "yes" || label === "no" || label === "maybe") {
        labels.set(idx, label);
      }
    }

    if (labels.size > 0) {
      console.log(`Found ${labels.size} human labels`);
      // Treat "yes" and "maybe" as positive
      const positives = new Set([...labels.entries()].filter(([_, l]) => l === "yes" || l === "maybe").map(([i]) => i));
      const negatives = new Set([...labels.entries()].filter(([_, l]) => l === "no").map(([i]) => i));
      const total = positives.size + negatives.size;

      if (total > 0) {
        for (const [name, getScore] of [
          ["Heuristic", (s: ScoredSample) => s.heuristic.score] as const,
          ...(hasReranker ? [["Reranker", (s: ScoredSample) => s.reranker?.score ?? 0] as const] : []),
          ...(hasLLM ? [["LLM", (s: ScoredSample) => s.llm?.score ?? 0] as const] : []),
        ]) {
          console.log(`\n  ${name}:`);
          for (const threshold of [0.3, 0.5, 0.7]) {
            const predicted = new Set(scored.filter(s => labels.has(s.index) && getScore(s) >= threshold).map(s => s.index));
            const tp = [...predicted].filter(i => positives.has(i)).length;
            const fp = [...predicted].filter(i => negatives.has(i)).length;
            const fn = [...positives].filter(i => !predicted.has(i)).length;
            const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
            const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
            const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
            console.log(`    t=${threshold.toFixed(1)}: P=${(precision * 100).toFixed(1)}% R=${(recall * 100).toFixed(1)}% F1=${(f1 * 100).toFixed(1)}%`);
          }
        }
      }
    } else {
      console.log("No human labels found yet. Run with --label to generate labeling file.");
    }
  }

  console.log("\n" + "=".repeat(70));
}

// ============================================================================
// Main
// ============================================================================

runExperiment().catch(err => {
  console.error("Experiment failed:", err);
  process.exit(1);
});
