/**
 * Temporal Query Detection
 *
 * Detects temporal phrases in queries and converts them to absolute
 * date ranges [start, end] in epoch milliseconds.
 *
 * Covers ~80% of temporal queries via regex. Zero LLM cost.
 */

const MS_PER_DAY = 86_400_000;

// Month name lookup (case-insensitive)
const MONTH_MAP: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3,
  may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3,
  jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Patterns that look temporal but aren't — reject these before matching
const FALSE_POSITIVE_PATTERNS = [
  /\blast\s+resort\b/i,
  /\blast\s+chance\b/i,
  /\blast\s+straw\b/i,
  /\blast\s+name\b/i,
  /\blast\s+call\b/i,
  /\bthe\s+week\s+was\b/i,
  /\bweek\s+point\b/i,
  /\bweek\s+spot\b/i,
];

/**
 * Detect a temporal range from a natural-language query.
 *
 * @param query - The user query string
 * @param now - Current timestamp in ms (default: Date.now()). Exposed for testing.
 * @returns [start, end] in epoch milliseconds, or null if no temporal phrase found.
 */
export function detectTemporalRange(
  query: string,
  now: number = Date.now(),
): [number, number] | null {
  if (!query || typeof query !== "string") return null;

  // Limit input length to avoid ReDoS on pathological strings
  const q = query.slice(0, 500).toLowerCase().trim();
  if (!q) return null;

  // Check for false positives first
  for (const fp of FALSE_POSITIVE_PATTERNS) {
    if (fp.test(q)) return null;
  }

  const todayStart = startOfDay(now);

  // "yesterday"
  if (/\byesterday\b/.test(q)) {
    const start = todayStart - MS_PER_DAY;
    return [start, now];
  }

  // "N days ago"
  const daysAgoMatch = q.match(/\b(\d+)\s+days?\s+ago\b/);
  if (daysAgoMatch) {
    const n = parseInt(daysAgoMatch[1], 10);
    if (n > 0 && n < 3650) {
      const start = todayStart - n * MS_PER_DAY;
      return [start, now];
    }
  }

  // "N weeks ago"
  const weeksAgoMatch = q.match(/\b(\d+)\s+weeks?\s+ago\b/);
  if (weeksAgoMatch) {
    const n = parseInt(weeksAgoMatch[1], 10);
    if (n > 0 && n < 520) {
      const start = todayStart - n * 7 * MS_PER_DAY;
      return [start, now];
    }
  }

  // "last week"
  if (/\blast\s+week\b/.test(q)) {
    const start = todayStart - 7 * MS_PER_DAY;
    return [start, now];
  }

  // "last month"
  if (/\blast\s+month\b/.test(q)) {
    const start = todayStart - 30 * MS_PER_DAY;
    return [start, now];
  }

  // "in {month}" — e.g. "in March", "in January"
  const inMonthMatch = q.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/);
  if (inMonthMatch) {
    const monthName = inMonthMatch[1];
    const monthIdx = MONTH_MAP[monthName];
    if (monthIdx !== undefined) {
      const currentDate = new Date(now);
      let year = currentDate.getFullYear();
      // If the month is in the future this year, use last year
      if (monthIdx > currentDate.getMonth()) {
        year -= 1;
      }
      const start = new Date(year, monthIdx, 1).getTime();
      // End = first day of next month
      const end = new Date(year, monthIdx + 1, 1).getTime() - 1;
      return [start, Math.min(end, now)];
    }
  }

  return null;
}

/** Get the start of the day (midnight) for a given timestamp. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
