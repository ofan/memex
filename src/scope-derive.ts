/**
 * Scope Derivation — server-authoritative tag derivation.
 *
 * Derives scope tags from environment signals (git, cwd, client info).
 * One algorithm, one place — clients cannot get it wrong because they are
 * not the ones doing it.
 *
 * Design: docs/design/memory-scoping.md
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ============================================================================
// Types
// ============================================================================

export interface DeriveScopesInput {
  /** Current working directory (or CLAUDE_PROJECT_DIR). */
  cwd: string;
  /** Environment variables (for CLAUDE_PROJECT_DIR fast path). */
  env?: Record<string, string | undefined>;
  /** Client name (e.g. "claude-code", "openclaw"). Only becomes a tag when explicitly specific. */
  clientName?: string;
  /** Session identifier. Only becomes a tag when explicitly specific. */
  sessionId?: string;
  /** Explicit overrides from client (wins over derived values for those dimensions). */
  explicit?: {
    client?: string;
    agent?: string;
    session?: string;
    device?: string; // metadata only, validated
  };
}

export interface DeriveScopesOutput {
  /** The set of scope tags for this memory. */
  tags: string[];
  /** Provenance metadata (all paths hashed — raw paths never stored). */
  metadata: Record<string, unknown>;
}

// ============================================================================
// Hashing
// ============================================================================

/** SHA-256 truncated to first 16 hex chars. */
export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// ============================================================================
// Git remote normalization
// ============================================================================

/**
 * Normalize a git remote URL for identity comparison:
 * - Strip trailing `.git`
 * - Convert SSH form (`git@host:path`) to HTTPS (`https://host/path`)
 * - Lowercase hostname
 */
export function normalizeGitRemote(remote: string): string {
  let normalized = remote.trim();
  if (!normalized) return "";

  // Strip trailing .git
  normalized = normalized.replace(/\.git$/, "");

  // Convert SSH form to HTTPS: git@github.com:user/repo → https://github.com/user/repo
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const path = sshMatch[2];
    normalized = `https://${host}/${path}`;
  }

  // Lowercase hostname in HTTPS URLs
  const httpsMatch = normalized.match(/^(https?:\/\/)([^\/]+)(.*)$/i);
  if (httpsMatch) {
    normalized = `${httpsMatch[1]}${httpsMatch[2].toLowerCase()}${httpsMatch[3]}`;
  }

  return normalized;
}

// ============================================================================
// Git helpers
// ============================================================================

interface GitInfo {
  root: string;
  remote: string | null;
  branch: string | null;
}

/** Run git command in a given directory, return stdout or null on failure. */
function gitCmd(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Extract git info from a directory. Returns null if not a git repo.
 */
function getGitInfo(cwd: string): GitInfo | null {
  if (!existsSync(cwd)) return null;

  const root = gitCmd(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;

  let remote: string | null = null;
  try {
    remote = gitCmd(cwd, ["remote", "get-url", "origin"]);
  } catch {
    remote = null;
  }

  let branch: string | null = null;
  try {
    const b = gitCmd(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (b && b !== "HEAD") branch = b;
  } catch {
    branch = null;
  }

  return { root, remote, branch };
}

// ============================================================================
// Device identity
// ============================================================================

function deriveDeviceId(): string {
  const host = (() => {
    try { return require("node:os").hostname(); } catch { return "unknown"; }
  })();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const raw = `device:${host}:${home}`;
  return hashValue(raw);
}

// ============================================================================
// Main derivation
// ============================================================================

export function deriveScopes(input: DeriveScopesInput): DeriveScopesOutput {
  const tags: string[] = [];
  const metadata: Record<string, unknown> = {};

  // --- cwd resolution ---
  const effectiveCwd = input.env?.CLAUDE_PROJECT_DIR && existsSync(input.env.CLAUDE_PROJECT_DIR)
    ? input.env.CLAUDE_PROJECT_DIR
    : input.cwd;

  // --- cwd hash (always captured, hashed) ---
  metadata.cwd_hash = hashValue(effectiveCwd);

  // --- global tag (always) ---
  tags.push("global");

  // --- project tag (auto) ---
  const gitInfo = getGitInfo(effectiveCwd);
  if (gitInfo) {
    // git root hash
    metadata.project_root = hashValue(gitInfo.root);

    // git remote (normalized)
    if (gitInfo.remote) {
      const normalized = normalizeGitRemote(gitInfo.remote);
      metadata.git_remote = normalized;
      tags.push(`project:${hashValue(normalized)}`);
    } else {
      // No remote — use local path hash
      tags.push(`project:${hashValue(gitInfo.root)}`);
    }

    // git branch
    if (gitInfo.branch) {
      metadata.git_branch = gitInfo.branch;
    }
  } else if (existsSync(effectiveCwd)) {
    // Not a git repo — use cwd hash
    tags.push(`project:${hashValue(effectiveCwd)}`);
    metadata.project_root = hashValue(effectiveCwd);
  }
  // If cwd doesn't exist either — no project tag (global still set)

  // --- client tag (opt-in — only when explicitly specific) ---
  const client = input.explicit?.client || input.clientName;
  if (client) {
    tags.push(`client:${client}`);
    metadata.client = client;
  }

  // --- agent tag (opt-in, explicit only) ---
  if (input.explicit?.agent) {
    tags.push(`agent:${input.explicit.agent}`);
  }

  // --- session tag (opt-in — only when explicitly specific) ---
  const sessionId = input.explicit?.session || input.sessionId;
  if (sessionId) {
    // Format: session:<sha256(client)[0:8]>:<id>
    const clientHash = client
      ? createHash("sha256").update(client).digest("hex").slice(0, 8)
      : "00000000";
    tags.push(`session:${clientHash}:${sessionId}`);
  }

  // --- device (metadata only, never a tag) ---
  const deviceId = input.explicit?.device || deriveDeviceId();
  metadata.device_id = deviceId;

  // --- timestamp ---
  metadata.captured_at = Date.now();

  return { tags, metadata };
}
