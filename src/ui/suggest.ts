import type { Star } from '@/types';

/**
 * Suggest tags for a repo based on its topics (NOT its language — language is
 * surfaced separately as a first-class filter in the sidebar's Languages section,
 * so deriving it as a tag would duplicate it across two places).
 * Pure function — no storage access. The actual write happens via the background
 * (`bgCall('acceptSuggestions' | 'acceptSuggestionsBatch')`), which owns the IDB.
 *
 * Returns suggestions not already applied (case-insensitive dedupe), capped at 5.
 * `excluded` are names the user has deleted (`tagMeta.excluded` tombstones), so
 * auto-assign / "accept all" cannot resurrect a removed tag.
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
