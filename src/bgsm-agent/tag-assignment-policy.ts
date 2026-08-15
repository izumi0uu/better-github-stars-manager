import type { Star, Tag, TagMeta } from '@/types';
import {
  normalizeMaxTagsPerRepo,
  normalizeMinTopicRepoCount,
} from '@/preferences';
import {
  canonicalTagKey,
  excludedCanonicalTagKeys,
  visibleTagNames,
} from '@/tags/tag-model';

export type BgsmAgentTagCoverageSnapshot = Readonly<{
  repositoriesByTag: ReadonlyMap<string, ReadonlySet<string>>;
  visibleTagsByRepository: ReadonlyMap<string, ReadonlySet<string>>;
  excludedTagKeys: ReadonlySet<string>;
}>;

export type BgsmAgentTagAssignmentPolicy = Readonly<{
  maxTagsPerRepo: number;
  minRepoCount: number;
  loadCoverage(): Promise<BgsmAgentTagCoverageSnapshot>;
  invalidateCoverage(): void;
}>;

export type BgsmAgentTagPolicyLibrary = Readonly<{
  stars: readonly Star[];
  tags: readonly Tag[];
  tagMeta: readonly TagMeta[];
}>;

/** Snapshots preferences now and loads whole-library coverage only if Chat writes tags. */
export function createBgsmAgentTagAssignmentPolicy(
  config: unknown,
  loadLibrary: () => BgsmAgentTagPolicyLibrary | Promise<BgsmAgentTagPolicyLibrary>,
): BgsmAgentTagAssignmentPolicy {
  const source = isRecord(config) ? config : {};
  let coverage: Promise<BgsmAgentTagCoverageSnapshot> | null = null;
  return Object.freeze({
    maxTagsPerRepo: normalizeMaxTagsPerRepo(source.maxTagsPerRepo, source.autoTagLimit),
    minRepoCount: normalizeMinTopicRepoCount(source.minTopicRepoCount),
    loadCoverage() {
      coverage ??= Promise.resolve(loadLibrary()).then(buildBgsmAgentTagCoverageSnapshot);
      return coverage;
    },
    invalidateCoverage() {
      coverage = null;
    },
  });
}

export function buildBgsmAgentTagCoverageSnapshot(
  library: BgsmAgentTagPolicyLibrary,
): BgsmAgentTagCoverageSnapshot {
  const liveRepositoryIds = new Set(
    library.stars
      .filter((star) => !star.tombstone && star.viewer_has_starred !== false)
      .map((star) => star.full_name),
  );
  const excludedTagKeys = excludedCanonicalTagKeys(library.tagMeta);
  const tagsByRepository = new Map(
    library.tags
      .filter((tag) => liveRepositoryIds.has(tag.full_name))
      .map((tag) => [tag.full_name, tag] as const),
  );
  const repositoriesByTag = new Map<string, Set<string>>();
  const visibleTagsByRepository = new Map<string, ReadonlySet<string>>();

  for (const star of library.stars) {
    if (star.tombstone || star.viewer_has_starred === false) continue;
    const visibleTagKeys = new Set(
      visibleTagNames(tagsByRepository.get(star.full_name))
        .map(canonicalTagKey)
        .filter((key) => key && !excludedTagKeys.has(key)),
    );
    visibleTagsByRepository.set(star.full_name, visibleTagKeys);

    const sourceKeys = new Set([
      ...star.topics.map(canonicalTagKey),
      ...visibleTagKeys,
    ]);
    for (const key of sourceKeys) {
      if (!key || excludedTagKeys.has(key)) continue;
      const repositories = repositoriesByTag.get(key) ?? new Set<string>();
      repositories.add(star.full_name);
      repositoriesByTag.set(key, repositories);
    }
  }

  return Object.freeze({
    repositoriesByTag,
    visibleTagsByRepository,
    excludedTagKeys,
  });
}

export function prospectiveBgsmAgentTagCoverage(
  coverage: BgsmAgentTagCoverageSnapshot,
  fullName: string,
  tag: string,
): number {
  const key = canonicalTagKey(tag);
  if (!key || coverage.excludedTagKeys.has(key)) return 0;
  const repositories = coverage.repositoriesByTag.get(key);
  return (repositories?.size ?? 0) + (repositories?.has(fullName) ? 0 : 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
