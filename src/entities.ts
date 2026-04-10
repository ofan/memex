/**
 * Entity Extraction
 *
 * Lightweight NER using compromise (rule-based, 250KB, ~0.1ms/call).
 * Extracts people, places, organizations, and capitalized proper nouns.
 * Used as 3rd retrieval signal (ACT-R spreading activation).
 */

import nlp from "compromise";

const MAX_ENTITIES = 10;

/**
 * Extract named entities from text.
 * Returns lowercase, deduplicated array capped at MAX_ENTITIES.
 */
export function extractEntities(text: string): string[] {
  if (!text || text.trim().length === 0) return [];

  const entities = new Set<string>();

  try {
    const doc = nlp(text);

    // People, places, organizations from compromise
    for (const t of doc.people().out("array") as string[]) {
      if (t.trim()) entities.add(t.trim().toLowerCase());
    }
    for (const t of doc.places().out("array") as string[]) {
      if (t.trim()) entities.add(t.trim().toLowerCase());
    }
    for (const t of doc.organizations().out("array") as string[]) {
      if (t.trim()) entities.add(t.trim().toLowerCase());
    }

    // Capitalized proper nouns that compromise may miss (technical terms)
    // Match: "Gemma 4", "Mac Mini", "Qwen3.5", "mbp-1" etc.
    for (const match of text.matchAll(/\b[A-Z][a-zA-Z0-9]*(?:[-.][\w]+)*(?:\s+[A-Z][a-zA-Z0-9]*(?:[-.][\w]+)*)*/g)) {
      let term = match[0].trim();
      // Strip possessives
      term = term.replace(/'s$/i, "");
      // Skip very short or very common words
      if (term.length >= 2 && !STOP_WORDS.has(term.toLowerCase())) {
        entities.add(term.toLowerCase());
      }
    }
  } catch {
    // If compromise fails, fall back to regex-only
    for (const match of text.matchAll(/\b[A-Z][a-zA-Z0-9]+(?:[-.][\w]+)*\b/g)) {
      entities.add(match[0].toLowerCase());
    }
  }

  // Cap at MAX_ENTITIES
  const result = [...entities].slice(0, MAX_ENTITIES);
  return result;
}

/**
 * Count overlapping entities between two sets (case-insensitive).
 */
export function entityOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b.map(e => e.toLowerCase()));
  return a.filter(e => setB.has(e.toLowerCase())).length;
}

// Common words to exclude from proper noun extraction
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "shall", "must",
  "i", "you", "he", "she", "it", "we", "they", "me", "him",
  "her", "us", "them", "my", "your", "his", "its", "our",
  "their", "this", "that", "these", "those", "what", "which",
  "who", "whom", "where", "when", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "because", "as", "until",
  "while", "of", "at", "by", "for", "with", "about", "against",
  "between", "through", "during", "before", "after", "above",
  "below", "to", "from", "up", "down", "in", "out", "on", "off",
  "over", "under", "again", "further", "then", "once", "here",
  "there", "when", "where", "why", "how", "all", "any", "both",
  "run", "use", "set", "get", "put", "let", "new", "old",
  "also", "if", "but", "or", "and", "so", "yet", "still",
]);
