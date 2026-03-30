import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type MemexHealthStatus = "ok" | "warn" | "fail";

export interface MemexHealthCheck {
  name: string;
  status: MemexHealthStatus;
  detail?: string;
  meta?: Record<string, unknown>;
}

export interface MemexHealthSnapshot {
  status: MemexHealthStatus;
  plugin: {
    id: string;
    version: string;
  };
  checks: MemexHealthCheck[];
}

export function aggregateHealthStatus(checks: MemexHealthCheck[]): MemexHealthStatus {
  if (checks.some(check => check.status === "fail")) return "fail";
  if (checks.some(check => check.status === "warn")) return "warn";
  return "ok";
}

export function filterMemexLogLines(rawLog: string, limit = 100): string[] {
  const truncateLine = (line: string, maxChars = 240): string =>
    line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;

  const lines = rawLog
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => /\bmemex\b|memex@/i.test(line))
    .map(line => truncateLine(line));

  return lines.slice(-Math.max(0, limit));
}

export async function getLatestOpenClawLogPath(logDir = "/tmp/openclaw"): Promise<string | null> {
  try {
    const entries = await readdir(logDir, { withFileTypes: true });
    const candidates = entries
      .filter(entry => entry.isFile() && /^openclaw-.*\.log$/.test(entry.name))
      .map(entry => entry.name)
      .sort();

    if (candidates.length === 0) return null;
    return join(logDir, candidates[candidates.length - 1]);
  } catch {
    return null;
  }
}

export async function collectMemexLogEvidence(opts?: {
  logDir?: string;
  logPath?: string;
  maxLines?: number;
}): Promise<{ path: string | null; lines: string[] }> {
  const logPath = opts?.logPath ?? await getLatestOpenClawLogPath(opts?.logDir);
  if (!logPath) {
    return { path: null, lines: [] };
  }

  try {
    const raw = await readFile(logPath, "utf8");
    return {
      path: logPath,
      lines: filterMemexLogLines(raw, opts?.maxLines ?? 100),
    };
  } catch {
    return { path: logPath, lines: [] };
  }
}

export function buildAuditPrompt(
  snapshot: Pick<MemexHealthSnapshot, "status" | "plugin" | "checks">,
  logLines: string[],
): string {
  const checks = snapshot.checks
    .map(check => `- ${check.name}: ${check.status}${check.detail ? ` — ${check.detail}` : ""}`)
    .join("\n");
  const evidence = logLines.length > 0
    ? logLines.map(line => `- ${line}`).join("\n")
    : "- No recent memex log lines were available.";

  return [
    "Audit the memex plugin state and recent logs.",
    "",
    "Return three sections with short labels:",
    "1. Severity: ok, warn, or fail",
    "2. Findings: flat bullet list of concrete issues or 'none'",
    "3. Actions: flat bullet list of the next operator actions or 'none'",
    "",
    "Health Snapshot",
    `- plugin: ${snapshot.plugin.id}@${snapshot.plugin.version}`,
    `- overall: ${snapshot.status}`,
    checks,
    "",
    "Log Evidence",
    evidence,
  ].join("\n");
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(flattenText).filter(Boolean).join("\n").trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if ("content" in record) return flattenText(record.content);
    if ("parts" in record) return flattenText(record.parts);
  }
  return "";
}

export function extractAuditConclusion(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const text = flattenText(record.content).trim();
    if (text) return text;
  }

  return "";
}
