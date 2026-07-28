import { db } from '@/storage/db';
import type { Star, Tag } from '@/types';
import type { FilterState, SortKey } from '@/ui/filter-store';
import { visibleTagNames } from '@/tags/tag-model';
import { normalizeStoredTag, type LegacyTagRow } from '@/storage/tag-shape';
import {
  validateLaunchCandidateContract,
  type LaunchCandidateContract,
} from '@/bgsm-agent/scope';

/**
 * Star query engine (runs in the SW, owns IDB); returns a filtered+sorted window
 * + sidebar facet counts, never the full row set.
 */

export interface QueryParams {
  filter: Pick<
    FilterState,
    'query' | 'languages' | 'tags' | 'tagMode' | 'showTombstone' | 'onlyFavorite' | 'onlyUntagged' | 'onlyArchived' | 'sortKey' | 'sortDir'
  >;
  offset: number;
  limit: number;
}

type QueryFilter = Omit<QueryParams['filter'], 'languages' | 'tags'> & Readonly<{
  languages: readonly string[];
  tags: readonly string[];
}>;

export interface QueryResult {
  rows: Star[];
  total: number; // filtered total
  grandTotal: number; // all stars in DB
  tagsForRows: Record<string, Tag | undefined>;
  languages: [string, number][]; // facet over ALL stars
  tagTree: { name: string; count: number }[];
  tagTotal: number;
}

export interface ResolvedLaunchCandidate {
  contract: LaunchCandidateContract;
  repositoryIds: string[];
  label: string;
  filterSnapshot: string;
}

export type ResultSubsetResolver = (
  runId: string,
  generation: number,
) => readonly string[] | null;

let cache: { stars: Star[]; tags: Map<string, Tag>; excluded: Set<string>; version: number } | null = null;
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
  for (const t of tags) {
    const normalized = normalizeStoredTag(t as LegacyTagRow);
    tagMap.set(normalized.full_name, normalized);
  }
  const excluded = new Set<string>();
  for (const m of tagMeta) {
    if (m.excluded) excluded.add(m.name);
  }
  cache = { stars, tags: tagMap, excluded, version: cacheVersion };
  return cache;
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

function sortRows(rows: Star[], key: SortKey, dir: 'asc' | 'desc'): Star[] {
  const mul = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'starred_at':
        cmp = a[key].localeCompare(b[key]);
        break;
      case 'pushed_at': {
        return compareNullableDate(a.pushed_at, b.pushed_at, a.full_name, b.full_name, dir);
      }
      case 'created_at': {
        return compareNullableDate(a.created_at, b.created_at, a.full_name, b.full_name, dir);
      }
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

function filterAndSortRows(
  stars: readonly Star[],
  tags: ReadonlyMap<string, Tag>,
  filter: QueryFilter,
): Star[] {
  const q = filter.query.trim().toLowerCase();
  const langSet = filter.languages.length ? new Set(filter.languages) : null;
  const tagSet = filter.tags.length ? new Set(filter.tags) : null;

  const filtered = stars.filter((s) => {
    if (!filter.showTombstone && s.tombstone) return false;
    if (filter.onlyArchived && !s.archived) return false;
    if (langSet && (s.language === null || !langSet.has(s.language))) return false;
    const tagRecord = tags.get(s.full_name);
    const myTags = visibleTagNames(tagRecord);
    if (filter.onlyFavorite && !tagRecord?.favorite) return false;
    if (filter.onlyUntagged && myTags.length > 0) return false;
    if (tagSet) {
      if (filter.tagMode === 'all') {
        if (!filter.tags.every((t) => myTags.includes(t))) return false;
      } else if (!myTags.some((t) => tagSet.has(t))) return false;
    }
    if (q) {
      const notes = tagRecord?.notes ?? '';
      const hay = `${s.full_name} ${s.description} ${s.topics.join(' ')} ${notes}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return sortRows(filtered, filter.sortKey, filter.sortDir);
}

/** Resolves every matching repository ID using the same authoritative filter/sort semantics as queryStars. */
export async function queryAllMatchingStarIds(filter: QueryParams['filter']): Promise<string[]> {
  const { stars, tags } = await ensureCache();
  return filterAndSortRows(stars, tags, filter).map((star) => star.full_name);
}

export async function resolveLaunchCandidate(
  contract: LaunchCandidateContract,
  resolveResultSubset?: ResultSubsetResolver,
): Promise<ResolvedLaunchCandidate> {
  validateLaunchCandidateContract(contract);
  const { stars, tags } = await ensureCache();
  let repositoryIds: string[];
  let label: string;
  let filterSnapshot: string;

  if (contract.kind === 'current_view') {
    repositoryIds = filterAndSortRows(stars, tags, contract.filter).map((star) => star.full_name);
    label = 'Current view';
    filterSnapshot = JSON.stringify(contract.filter);
  } else if (contract.kind === 'selected_repository') {
    const selected = stars.find((star) => (
      star.full_name === contract.selectedRepositoryIdHint && !star.tombstone
    ));
    repositoryIds = selected ? [selected.full_name] : [];
    label = selected?.full_name ?? contract.selectedRepositoryIdHint;
    filterSnapshot = `Selected repository: ${contract.selectedRepositoryIdHint}`;
  } else if (contract.kind === 'all_live_stars') {
    repositoryIds = stars
      .filter((star) => !star.tombstone)
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
      .map((star) => star.full_name);
    label = 'All starred repositories';
    filterSnapshot = 'All live stars';
  } else if (contract.kind === 'still_untagged_after_auto_tags') {
    repositoryIds = stars
      .filter((star) => !star.tombstone && visibleTagNames(tags.get(star.full_name)).length === 0)
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
      .map((star) => star.full_name);
    label = 'Still untagged';
    filterSnapshot = 'Live stars with no visible tags after Auto Tags';
  } else {
    repositoryIds = [...(resolveResultSubset?.(contract.sourceRunId, contract.sourceGeneration) ?? [])];
    label = 'Remaining results';
    filterSnapshot = `Result subset from ${contract.sourceRunId} generation ${contract.sourceGeneration}`;
  }

  return {
    contract,
    repositoryIds: [...new Set(repositoryIds)],
    label,
    filterSnapshot,
  };
}

export async function resolveLiveLaunchCandidate(
  contract: LaunchCandidateContract,
  resolveResultSubset?: ResultSubsetResolver,
): Promise<ResolvedLaunchCandidate> {
  const resolved = await resolveLaunchCandidate(contract, resolveResultSubset);
  const { stars } = await ensureCache();
  const liveRepositoryIds = new Set(
    stars.filter((star) => !star.tombstone).map((star) => star.full_name),
  );
  return {
    ...resolved,
    repositoryIds: resolved.repositoryIds.filter((repositoryId) => (
      liveRepositoryIds.has(repositoryId)
    )),
  };
}

export async function queryStars(params: QueryParams): Promise<QueryResult> {
  const { filter, offset, limit } = params;
  const { stars, tags, excluded } = await ensureCache();
  const filtered = filterAndSortRows(stars, tags, filter);

  // Languages facet over ALL stars (stable sidebar regardless of filter).
  const langCounts = new Map<string, number>();
  for (const s of stars) if (s.language) langCounts.set(s.language, (langCounts.get(s.language) ?? 0) + 1);
  const languages: [string, number][] = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  // Tag tree facet over ALL stars' tags. Excluded (deleted) tags are omitted from
  // the sidebar tree — they're tombstones, not live filters. The tree is a flat
  // list sorted by count (no dimension grouping); topic-derived and user-authored
  // tags sit side by side.
  const tagCounts = new Map<string, number>();
  for (const t of tags.values()) {
    for (const tag of visibleTagNames(t)) {
      if (excluded.has(tag)) continue;
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const tagTree: QueryResult['tagTree'] = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
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
