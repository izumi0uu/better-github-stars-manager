import type { Star, Tag, TagMeta } from '@/types';
import type { FilterState, SortKey } from '@/ui/filter-store';
import {
  canonicalTagKey,
  excludedCanonicalTagKeys,
  visibleTagNames,
} from '@/tags/tag-model';
import { normalizeStoredTag, type LegacyTagRow } from '@/storage/tag-shape';
import { createRepositorySearchMatcher } from '@/search/repository-search';

export type StarsQueryFilter = Readonly<Pick<
  FilterState,
  | 'query'
  | 'tagMode'
  | 'showTombstone'
  | 'onlyFavorite'
  | 'onlyUntagged'
  | 'onlyArchived'
  | 'onlyOwned'
  | 'sortKey'
  | 'sortDir'
>> & Readonly<{
  languages: readonly string[];
  tags: readonly string[];
}>;

export interface StarsQueryParams {
  filter: StarsQueryFilter;
  accountLogin?: string | null;
  offset: number;
  limit: number;
}

export interface StarsQueryResult {
  rows: Star[];
  total: number;
  grandTotal: number;
  tagsForRows: Record<string, Tag | undefined>;
  languages: [string, number][];
  tagTree: { name: string; count: number }[];
  tagTotal: number;
}

export type StarsQuerySource = Readonly<{
  stars: readonly Star[];
  tags: readonly Tag[];
  tagMeta: readonly TagMeta[];
}>;

export function normalizeStarForQuery(star: Star): Star {
  return {
    ...star,
    html_url: star.html_url || `https://github.com/${star.full_name}`,
    description: star.description ?? '',
    language: star.language ?? null,
    topics: Array.isArray(star.topics) ? star.topics : [],
    stargazers_count: typeof star.stargazers_count === 'number' ? star.stargazers_count : 0,
    starred_at: star.starred_at || star.created_at || new Date(0).toISOString(),
    pushed_at: star.pushed_at ?? null,
    created_at: star.created_at ?? null,
    fork: star.fork ?? false,
    archived: star.archived ?? false,
    tombstone: star.tombstone ?? false,
  };
}

export function compareNullableDate(
  aValue: string | null | undefined,
  bValue: string | null | undefined,
  tieBreakA: string,
  tieBreakB: string,
  dir: 'asc' | 'desc',
): number {
  const aMissing = aValue == null;
  const bMissing = bValue == null;
  if (aMissing || bMissing) {
    if (aMissing && bMissing) return tieBreakA.localeCompare(tieBreakB);
    return aMissing ? 1 : -1;
  }
  const cmp = aValue.localeCompare(bValue);
  return dir === 'asc' ? cmp : -cmp;
}

function sortRows(
  rows: Star[],
  key: SortKey,
  dir: 'asc' | 'desc',
  relevance?: ReadonlyMap<Star, number>,
): Star[] {
  const mul = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    if (relevance) {
      const relevanceDifference = (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0);
      if (relevanceDifference !== 0) return relevanceDifference;
    }
    let cmp = 0;
    switch (key) {
      case 'starred_at':
        cmp = a.starred_at.localeCompare(b.starred_at);
        break;
      case 'pushed_at':
        return compareNullableDate(a.pushed_at, b.pushed_at, a.full_name, b.full_name, dir);
      case 'created_at':
        return compareNullableDate(a.created_at, b.created_at, a.full_name, b.full_name, dir);
      case 'stargazers_count':
        cmp = a.stargazers_count - b.stargazers_count;
        break;
      case 'name':
        cmp = a.full_name.localeCompare(b.full_name);
        break;
    }
    return cmp * mul;
  });
}

function prepareSource(source: StarsQuerySource) {
  const excluded = excludedCanonicalTagKeys(source.tagMeta);
  const tags = new Map<string, Tag>();
  for (const row of source.tags) {
    const normalized = normalizeStoredTag(row as LegacyTagRow);
    tags.set(normalized.full_name, {
      ...normalized,
      manualTags: normalized.manualTags.filter((name) => !excluded.has(canonicalTagKey(name))),
      autoTags: normalized.autoTags.filter((name) => !excluded.has(canonicalTagKey(name))),
    });
  }
  return {
    stars: source.stars.map(normalizeStarForQuery),
    tags,
    excluded,
  };
}

function filterAndSortRows(
  stars: readonly Star[],
  tags: ReadonlyMap<string, Tag>,
  filter: StarsQueryFilter,
  accountLogin: string | null,
): Star[] {
  const search = createRepositorySearchMatcher(filter.query);
  const relevance = new Map<Star, number>();
  const languages = filter.languages.length ? new Set(filter.languages) : null;
  const selectedTags = filter.tags.length
    ? new Set(filter.tags.map((tag) => canonicalTagKey(tag)))
    : null;
  const ownedPrefix = accountLogin?.trim().normalize('NFKC').toLocaleLowerCase('en-US');

  const filtered = stars.filter((star) => {
    if (!filter.onlyOwned && star.viewer_has_starred === false) return false;
    if (!filter.showTombstone && star.tombstone) return false;
    if (filter.onlyArchived && !star.archived) return false;
    if (
      filter.onlyOwned
      && (!ownedPrefix || !star.full_name.normalize('NFKC').toLocaleLowerCase('en-US').startsWith(`${ownedPrefix}/`))
    ) return false;
    if (languages && (star.language === null || !languages.has(star.language))) return false;
    const tagRecord = tags.get(star.full_name);
    const visibleTags = visibleTagNames(tagRecord);
    const visibleTagKeys = visibleTags.map((tag) => canonicalTagKey(tag));
    if (filter.onlyFavorite && !tagRecord?.favorite) return false;
    if (filter.onlyUntagged && visibleTags.length > 0) return false;
    if (selectedTags) {
      if (filter.tagMode === 'all') {
        if (!filter.tags.every((tag) => visibleTagKeys.includes(canonicalTagKey(tag)))) return false;
      } else if (!visibleTagKeys.some((tag) => selectedTags.has(tag))) return false;
    }
    if (!search.empty) {
      const match = search.match({
        fullName: star.full_name,
        description: star.description,
        topics: star.topics,
        notes: tagRecord?.notes ?? '',
      });
      if (!match.matched) return false;
      relevance.set(star, match.relevance);
    }
    return true;
  });

  return sortRows(filtered, filter.sortKey, filter.sortDir, search.empty ? undefined : relevance);
}

export function projectMatchingStars(
  source: StarsQuerySource,
  filter: StarsQueryParams['filter'],
  accountLogin: string | null = null,
): Star[] {
  const prepared = prepareSource(source);
  return filterAndSortRows(prepared.stars, prepared.tags, filter, accountLogin);
}

export function projectStarsQuery(
  source: StarsQuerySource,
  params: StarsQueryParams,
): StarsQueryResult {
  const { stars, tags, excluded } = prepareSource(source);
  const filtered = filterAndSortRows(stars, tags, params.filter, params.accountLogin ?? null);

  const languageCounts = new Map<string, number>();
  for (const star of stars) {
    if (star.language) languageCounts.set(star.language, (languageCounts.get(star.language) ?? 0) + 1);
  }
  const languages: [string, number][] = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  const tagCounts = new Map<string, { name: string; count: number }>();
  for (const tag of tags.values()) {
    for (const name of visibleTagNames(tag)) {
      const key = canonicalTagKey(name);
      if (excluded.has(key)) continue;
      const current = tagCounts.get(key);
      tagCounts.set(key, {
        name: current?.name ?? name,
        count: (current?.count ?? 0) + 1,
      });
    }
  }
  const tagTree = [...tagCounts.values()].sort((a, b) => b.count - a.count);
  const rows = filtered.slice(params.offset, params.offset + params.limit);
  const tagsForRows: Record<string, Tag | undefined> = {};
  for (const row of rows) tagsForRows[row.full_name] = tags.get(row.full_name);

  return {
    rows,
    total: filtered.length,
    grandTotal: stars.length,
    tagsForRows,
    languages,
    tagTree,
    tagTotal: tagCounts.size,
  };
}
