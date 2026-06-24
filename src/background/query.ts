import { db } from '@/storage/db';
import type { Star, Tag } from '@/types';
import type { FilterState, SortKey } from '@/ui/filter-store';

/**
 * Star query engine — runs in the background service worker, where the IndexedDB
 * (extension origin) lives. The content script can't share this IDB (content
 * scripts see the page's origin IDB), so ALL data access goes through here.
 *
 * Returns the filtered+sorted slice the UI asked for, plus facet counts for the
 * sidebar. We do NOT stream 9900 rows across the message boundary; the UI requests
 * a virtual window (offset/limit) and re-requests on scroll/filter change.
 */

export interface QueryParams {
  filter: Pick<
    FilterState,
    'query' | 'languages' | 'tags' | 'tagMode' | 'showTombstone' | 'onlyUntagged' | 'sortKey' | 'sortDir'
  >;
  offset: number;
  limit: number;
}

export interface QueryResult {
  rows: Star[];
  total: number; // filtered total
  grandTotal: number; // all stars in DB
  tagsForRows: Record<string, Tag | undefined>;
  languages: [string, number][]; // facet over ALL stars
  tagTree: { dim: string | null; name: string; count: number }[];
  tagTotal: number;
}

let cache: { stars: Star[]; tags: Map<string, Tag>; tagMeta: Map<string, string | null>; excluded: Set<string>; version: number } | null = null;
let cacheVersion = 0;

/** Invalidate the in-memory cache (called after any sync/write). */
export function invalidateCache() {
  cacheVersion++;
  cache = null;
}

async function ensureCache() {
  if (cache && cache.version === cacheVersion) return cache;
  const [stars, tags, tagMeta] = await Promise.all([
    db.stars.toArray(),
    db.tags.toArray(),
    db.tagMeta.toArray(),
  ]);
  const tagMap = new Map<string, Tag>();
  for (const t of tags) tagMap.set(t.full_name, t);
  const metaMap = new Map<string, string | null>();
  const excluded = new Set<string>();
  for (const m of tagMeta) {
    metaMap.set(m.name, m.dimension);
    if (m.excluded) excluded.add(m.name);
  }
  cache = { stars, tags: tagMap, tagMeta: metaMap, excluded, version: cacheVersion };
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

export async function queryStars(params: QueryParams): Promise<QueryResult> {
  const { filter, offset, limit } = params;
  const { stars, tags, tagMeta, excluded } = await ensureCache();

  const q = filter.query.trim().toLowerCase();
  const langSet = filter.languages.length ? new Set(filter.languages) : null;
  const tagSet = filter.tags.length ? new Set(filter.tags) : null;

  const filtered = stars.filter((s) => {
    if (!filter.showTombstone && s.tombstone) return false;
    if (langSet && (s.language === null || !langSet.has(s.language))) return false;
    const myTags = tags.get(s.full_name)?.tags ?? [];
    if (filter.onlyUntagged && myTags.length > 0) return false;
    if (tagSet) {
      if (filter.tagMode === 'all') {
        if (!filter.tags.every((t) => myTags.includes(t))) return false;
      } else if (!myTags.some((t) => tagSet.has(t))) return false;
    }
    if (q) {
      const hay = `${s.full_name} ${s.description} ${s.topics.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  sortRows(filtered, filter.sortKey, filter.sortDir);

  // Languages facet over ALL stars (stable sidebar regardless of filter).
  const langCounts = new Map<string, number>();
  for (const s of stars) if (s.language) langCounts.set(s.language, (langCounts.get(s.language) ?? 0) + 1);
  const languages: [string, number][] = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  // Tag tree facet over ALL stars' tags. Excluded (deleted) tags are omitted from
  // the sidebar tree — they're tombstones, not live filters — but their dimension
  // metadata still flows here from tagMeta for any tag that is live.
  const tagCounts = new Map<string, number>();
  for (const t of tags.values()) for (const tag of t.tags) {
    if (excluded.has(tag)) continue;
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const tagTree: QueryResult['tagTree'] = [...tagCounts.entries()]
    .map(([name, count]) => ({ dim: tagMeta.get(name) ?? null, name, count }))
    .sort((a, b) => b.count - a.count);

  // Slice for the requested window.
  const rows = filtered.slice(offset, offset + limit);
  const tagsForRows: Record<string, Tag | undefined> = {};
  for (const r of rows) tagsForRows[r.full_name] = tags.get(r.full_name);

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
