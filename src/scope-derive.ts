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
 * - Strip trailing slashes
 * - Convert SSH form (`git@host:path`) to HTTPS (`https://host/path`)
 * - Convert ssh:// form (`ssh://git@host[:port]/path`) to HTTPS (`https://host/path`)
 * - Strip default SSH port (:22) from ssh:// URLs
 * - Lowercase hostname
 */
export function normalizeGitRemote(remote: string): string {
  let normalized = remote.trim();
  if (!normalized) return "";

  // Convert ssh:// form to HTTPS: ssh://git@host[:port]/path → https://host/path
  // Strip the default SSH port (:22) since it carries no identity information.
  const sshUrlMatch = normalized.match(/^ssh:\/\/git@([^:\/]+)(?::22)?(\/.+)$/i);
  if (sshUrlMatch) {
    const host = sshUrlMatch[1].toLowerCase();
    const path = sshUrlMatch[2];
    normalized = `https://${host}${path}`;
  }

  // Convert SCP-style SSH form to HTTPS: git@github.com:user/repo → https://github.com/user/repo
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const path = sshMatch[2];
    normalized = `https://${host}/${path}`;
  }

  // Strip trailing .git
  normalized = normalized.replace(/\.git$/, "");

  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, "");

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
      // Readable project name (last path segment of the normalized remote) for
      // observability — scope-visibility #7. The stable filter key stays
      // project:<hash>; project_name is human-readable provenance only.
      const repoName = normalized.replace(/^https?:\/\//, "").split("/").filter(Boolean).pop();
      if (repoName) metadata.project_name = repoName;
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

  // --- client identity resolution ---
  // clientName (auto-detected by callers, e.g. "claude-code", "openclaw")
  // is provenance metadata ONLY. It does NOT become a scope tag.
  //
  // Contract: callers (mcp-server.ts detectClientName, tools.ts detectPluginClientName)
  // pass clientName as provenance. deriveScopes stores it in metadata.client but does
  // NOT auto-tag `client:<name>`. This prevents general facts from being walled into
  // a capturing client (e.g. "I like dark mode" captured in Claude Code would be
  // hidden from Codex if auto-tagged). Only explicit.client creates a scope tag.
  //
  // The client identity is also used for the session tag hash prefix (if available).
  const client = input.explicit?.client || input.clientName;
  if (input.clientName) {
    metadata.client = input.clientName;
  }

  // --- client tag (opt-in — only when explicitly requested) ---
  if (input.explicit?.client) {
    tags.push(`client:${input.explicit.client}`);
    metadata.client = input.explicit.client; // explicit overrides auto-detected in metadata
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
  // In stdio mode, deriveDeviceId() hashes hostname+HOME. In HTTP mode,
  // the client supplies a device_id — it must also be hashed for symmetry.
  // Raw device identifiers are never stored.
  const deviceId = input.explicit?.device
    ? hashValue(input.explicit.device)
    : deriveDeviceId();
  metadata.device_id = deviceId;

  // --- timestamp ---
  metadata.captured_at = Date.now();

  return { tags, metadata };
}
