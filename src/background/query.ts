import { db } from '@/storage/db';
import type { Star, Tag } from '@/types';
import type { FilterState, SortKey } from '@/ui/filter-store';

export type StarFilter = Pick<
  FilterState,
  'query' | 'languages' | 'tags' | 'tagMode' | 'showTombstone' | 'onlyFavorite' | 'onlyUntagged' | 'onlyArchived' | 'sortKey' | 'sortDir'
>;

export interface QueryParams {
  filter: StarFilter;
  offset: number;
  limit: number;
}

export interface QueryMetaResult {
  total: number;
  grandTotal: number;
  languages: [string, number][];
  tagTree: { name: string; count: number }[];
  tagTotal: number;
}

export interface QueryPageResult {
  offset: number;
  limit: number;
  rows: Star[];
  tagsForRows: Record<string, Tag | undefined>;
}

export interface QueryResult extends QueryMetaResult, Omit<QueryPageResult, 'offset' | 'limit'> {}

interface BaseCache {
  stars: Star[];
  tags: Map<string, Tag>;
  excluded: Set<string>;
  version: number;
}

interface FilteredCache {
  key: string;
  baseVersion: number;
  filtered: Star[];
  meta: QueryMetaResult;
}

let cache: BaseCache | null = null;
let filteredCache: FilteredCache | null = null;
let cacheVersion = 0;

export function invalidateCache() {
  cacheVersion++;
  cache = null;
  filteredCache = null;
}

async function ensureCache(): Promise<BaseCache> {
  if (cache && cache.version === cacheVersion) return cache;
  const [stars, tags, tagMeta] = await Promise.all([
    db.stars.toArray(),
    db.tags.toArray(),
    db.tagMeta.toArray(),
  ]);
  const tagMap = new Map<string, Tag>();
  for (const tag of tags) tagMap.set(tag.full_name, tag);
  const excluded = new Set<string>();
  for (const meta of tagMeta) {
    if (meta.excluded) excluded.add(meta.name);
  }
  cache = { stars, tags: tagMap, excluded, version: cacheVersion };
  return cache;
}

function sortRows(rows: Star[], key: SortKey, dir: 'asc' | 'desc'): Star[] {
  const mul = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'starred_at':
      case 'pushed_at':
        cmp = a[key].localeCompare(b[key]);
        break;
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

function buildFilterKey(filter: StarFilter): string {
  return JSON.stringify(filter);
}

function filterRows(stars: Star[], tags: Map<string, Tag>, filter: StarFilter): Star[] {
  const q = filter.query.trim().toLowerCase();
  const langSet = filter.languages.length ? new Set(filter.languages) : null;
  const tagSet = filter.tags.length ? new Set(filter.tags) : null;

  return stars.filter((star) => {
    if (!filter.showTombstone && star.tombstone) return false;
    if (filter.onlyArchived && !star.archived) return false;
    if (langSet && (star.language === null || !langSet.has(star.language))) return false;
    const tagRecord = tags.get(star.full_name);
    const myTags = tagRecord?.tags ?? [];
    if (filter.onlyFavorite && !tagRecord?.favorite) return false;
    if (filter.onlyUntagged && myTags.length > 0) return false;
    if (tagSet) {
      if (filter.tagMode === 'all') {
        if (!filter.tags.every((tag) => myTags.includes(tag))) return false;
      } else if (!myTags.some((tag) => tagSet.has(tag))) return false;
    }
    if (q) {
      const notes = tagRecord?.notes ?? '';
      const hay = `${star.full_name} ${star.description} ${star.topics.join(' ')} ${notes}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function buildMeta(stars: Star[], tags: Map<string, Tag>, excluded: Set<string>, total: number): QueryMetaResult {
  const langCounts = new Map<string, number>();
  for (const star of stars) {
    if (!star.language) continue;
    langCounts.set(star.language, (langCounts.get(star.language) ?? 0) + 1);
  }
  const languages: [string, number][] = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  const tagCounts = new Map<string, number>();
  for (const tagRecord of tags.values()) {
    for (const tag of tagRecord.tags) {
      if (excluded.has(tag)) continue;
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const tagTree = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total,
    grandTotal: stars.length,
    languages,
    tagTree,
    tagTotal: tagCounts.size,
  };
}

async function ensureFilteredCache(filter: StarFilter): Promise<FilteredCache> {
  const base = await ensureCache();
  const key = buildFilterKey(filter);
  if (filteredCache && filteredCache.key === key && filteredCache.baseVersion === base.version) {
    return filteredCache;
  }

  const filtered = sortRows(filterRows(base.stars, base.tags, filter), filter.sortKey, filter.sortDir);
  const meta = buildMeta(base.stars, base.tags, base.excluded, filtered.length);
  filteredCache = {
    key,
    baseVersion: base.version,
    filtered,
    meta,
  };
  return filteredCache;
}

export async function queryMeta(filter: StarFilter): Promise<QueryMetaResult> {
  return (await ensureFilteredCache(filter)).meta;
}

export async function queryPage(params: QueryParams): Promise<QueryPageResult> {
  const { filter, offset, limit } = params;
  const [{ filtered }, { tags }] = await Promise.all([
    ensureFilteredCache(filter),
    ensureCache(),
  ]);
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(0, limit);
  const rows = filtered.slice(safeOffset, safeOffset + safeLimit);
  const tagsForRows: Record<string, Tag | undefined> = {};
  for (const row of rows) tagsForRows[row.full_name] = tags.get(row.full_name);
  return {
    offset: safeOffset,
    limit: safeLimit,
    rows,
    tagsForRows,
  };
}

export async function queryStars(params: QueryParams): Promise<QueryResult> {
  const [meta, page] = await Promise.all([
    queryMeta(params.filter),
    queryPage(params),
  ]);
  return {
    ...meta,
    rows: page.rows,
    tagsForRows: page.tagsForRows,
  };
}
