import type { Star } from '@/types';
import { DEFAULT_AUTO_TAG_LIMIT, normalizeAutoTagLimit, normalizeMinTopicRepoCount } from '@/preferences';

export type AutoTagSuggestionPolicy =
  | number
  | {
      limit?: number;
      minRepoCount?: number;
      topicRepoCounts?: ReadonlyMap<string, number>;
    };

function resolveSuggestionPolicy(policy: AutoTagSuggestionPolicy): {
  limit: number;
  minRepoCount: number;
  topicRepoCounts: ReadonlyMap<string, number> | null;
} {
  if (typeof policy === 'number') {
    return {
      limit: normalizeAutoTagLimit(policy),
      minRepoCount: 1,
      topicRepoCounts: null,
    };
  }
  return {
    limit: normalizeAutoTagLimit(policy.limit),
    minRepoCount: policy.minRepoCount === undefined ? 1 : normalizeMinTopicRepoCount(policy.minRepoCount),
    topicRepoCounts: policy.topicRepoCounts ?? null,
  };
}

export function countTopicRepoFrequency(stars: Pick<Star, 'topics'>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const star of stars) {
    const repoTopics = new Set(star.topics.map((topic) => topic.toLowerCase()));
    for (const topic of repoTopics) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Suggest tags derived from a repo's topics — NOT its language (language is a
 * separate filter; deriving it as a tag would duplicate it across two places).
 * Pure function — the actual write happens via the background (`bgCall('acceptSuggestions' | 'acceptSuggestionsBatch')`), which owns the IDB.
 * Skips tags already applied and excluded (deleted tombstones).
 */
export function suggestTags(
  star: Pick<Star, 'topics'>,
  existing: string[],
  excluded: Iterable<string> = [],
  policy: AutoTagSuggestionPolicy = DEFAULT_AUTO_TAG_LIMIT,
): string[] {
  const { limit, minRepoCount, topicRepoCounts } = resolveSuggestionPolicy(policy);
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const skip = new Set([...excluded].map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const t of star.topics) {
    const lc = t.toLowerCase();
    if (have.has(lc) || skip.has(lc)) continue;
    if (topicRepoCounts && (topicRepoCounts.get(lc) ?? 0) < minRepoCount) continue;
    out.push(t);
    have.add(lc);
  }
  return out.slice(0, limit);
}
