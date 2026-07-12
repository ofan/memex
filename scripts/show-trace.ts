#!/usr/bin/env node
/**
 * show-trace — load and pretty-print a captured recall trace by debugId.
 *
 *   node --import jiti/register scripts/show-trace.ts <debugId>
 *
 * Resolves the trace file `<debugId>-*.json` (or `<debugId>.json`) from the
 * debug dir (MEMEX_DEBUG_RECALL, or ${tmpdir}/memex-debug-recall by default)
 * and prints a per-stage table: kept/dropped item counts, score columns, the
 * effective floor, and the final ranking. This is the "load it" step when a
 * user says "debug <debugId>".
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const rawDir = process.env.MEMEX_DEBUG_RECALL === "1" || !process.env.MEMEX_DEBUG_RECALL
  ? join(tmpdir(), "memex-debug-recall")
  : process.env.MEMEX_DEBUG_RECALL;

const debugId = process.argv[2];
if (!debugId) {
  console.error("usage: show-trace <debugId>");
  process.exit(1);
}

const files = await readdir(rawDir).catch(() => [] as string[]);
const match = files.find(f => f.startsWith(debugId));
if (!match) {
  console.error(`no trace found for ${debugId} in ${rawDir}`);
  process.exit(2);
}

const payload = JSON.parse(await readFile(join(rawDir, match), "utf8"));
const t = payload.trace;
console.log(`debugId   ${payload.debugId}`);
console.log(`query     ${payload.query}`);
console.log(`source    ${payload.source}   results: ${payload.resultCount}`);
console.log(`dir       ${rawDir}`);
if (!t) {
  console.log("\n(no trace captured — MEMEX_DEBUG_RECALL was off when this recall ran)");
  process.exit(0);
}
console.log(`pipeline  ${t.pipeline}   ts: ${t.ts}`);
if (t.config && Object.keys(t.config).length) {
  console.log(`config    ${JSON.stringify(t.config)}`);
}
console.log("");

for (const stage of t.stages as Array<{ name: string; kept: any[]; dropped?: any[]; meta?: Record<string, unknown> }>) {
  const drop = stage.dropped ?? [];
  console.log(`── ${stage.name} ──  (kept ${stage.kept.length}${drop.length ? `, dropped ${drop.length}` : ""})${stage.meta ? `  ${JSON.stringify(stage.meta)}` : ""}`);
  for (const item of stage.kept) {
    const sc = item.scores ? `  ${fmtScores(item.scores)}` : "";
    console.log(`  kept   ${item.score.toFixed(3)}  ${item.id.slice(0, 8)}  ${item.source ?? ""}${sc}`);
  }
  for (const item of drop) {
    const sc = item.scores ? `  ${fmtScores(item.scores)}` : "";
    console.log(`  DROP   ${item.score.toFixed(3)}  ${item.id.slice(0, 8)}  ${item.source ?? ""}${sc}`);
  }
}

console.log(`\nfinal order: ${(t.finalIds ?? []).map((id: string) => id.slice(0, 8)).join(", ")}`);

function fmtScores(s: Record<string, number | undefined>): string {
  return Object.entries(s)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${(v as number).toFixed(3)}`)
    .join(" ");
}
