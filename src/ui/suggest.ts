import type { Star } from '@/types';

/**
 * Suggest tags derived from a repo's topics — NOT its language (language is a
 * separate filter; deriving it as a tag would duplicate it across two places).
 * Pure function — the actual write happens via the background (`bgCall('acceptSuggestions' | 'acceptSuggestionsBatch')`), which owns the IDB.
 * Skips tags already applied and excluded (deleted tombstones); caps at 5.
 */
export function suggestTags(star: Star, existing: string[], excluded: Iterable<string> = []): string[] {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const skip = new Set([...excluded].map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const t of star.topics) {
    const lc = t.toLowerCase();
    if (have.has(lc) || skip.has(lc)) continue;
    out.push(t);
  }
  return out.slice(0, 5);
}
