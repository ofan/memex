/**
 * Entity Graph — lightweight adjacency-based memory linking
 *
 * Links memories sharing 2+ entities. One-hop expansion at retrieval.
 */

import type { Database } from "./db.js";
import { entityOverlap } from "./entities.js";

const MAX_LINKS_PER_MEMORY = 10;
const MIN_SHARED_ENTITIES = 2;

export function ensureGraphSchema(db: Database): void {
  const sql = [
    `CREATE TABLE IF NOT EXISTS memory_links (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      shared_entities TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, target_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ml_source ON memory_links(source_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ml_target ON memory_links(target_id)`,
  ];
  for (const s of sql) db.prepare(s).run();
}

export function createLinks(
  db: Database,
  memoryId: string,
  entities: string[],
): number {
  if (entities.length < MIN_SHARED_ENTITIES) return 0;

  const candidates = db.prepare(
    "SELECT id, metadata FROM memories WHERE id != ? AND metadata LIKE '%\"entities\"%'"
  ).all(memoryId) as { id: string; metadata: string }[];

  const now = Date.now();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO memory_links (source_id, target_id, shared_entities, created_at) VALUES (?, ?, ?, ?)"
  );

  let linkCount = 0;
  for (const candidate of candidates) {
    if (linkCount >= MAX_LINKS_PER_MEMORY) break;
    let candidateEntities: string[] = [];
    try { candidateEntities = JSON.parse(candidate.metadata).entities || []; } catch { continue; }

    const overlap = entityOverlap(entities, candidateEntities);
    if (overlap >= MIN_SHARED_ENTITIES) {
      const shared = entities.filter(e =>
        candidateEntities.some(ce => ce.toLowerCase() === e.toLowerCase())
      );
      // Check cap on both sides
      const candidateLinkCount = (db.prepare(
        "SELECT COUNT(*) as c FROM memory_links WHERE source_id = ?"
      ).get(candidate.id) as any).c;
      if (candidateLinkCount >= MAX_LINKS_PER_MEMORY) continue;

      insert.run(memoryId, candidate.id, JSON.stringify(shared), now);
      insert.run(candidate.id, memoryId, JSON.stringify(shared), now);
      linkCount++;
    }
  }
  return linkCount;
}

export function expandOneHop(db: Database, memoryIds: string[]): string[] {
  if (memoryIds.length === 0) return [];
  const ph = memoryIds.map(() => "?").join(",");
  const linked = db.prepare(
    `SELECT DISTINCT target_id FROM memory_links WHERE source_id IN (${ph}) AND target_id NOT IN (${ph})`
  ).all(...memoryIds, ...memoryIds) as { target_id: string }[];
  return linked.map(r => r.target_id);
}

export function deleteLinks(db: Database, memoryId: string): void {
  db.prepare("DELETE FROM memory_links WHERE source_id = ? OR target_id = ?").run(memoryId, memoryId);
}

export const LINK_SCORE_DISCOUNT_FACTOR = 0.7;
