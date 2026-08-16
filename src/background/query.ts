import { db } from '@/storage/db';
import {
  validateLaunchCandidateContract,
  type LaunchCandidateContract,
} from '@/bgsm-agent/scope';
import {
  projectMatchingStars,
  projectStarsQuery,
  type StarsQueryParams,
  type StarsQueryResult,
  type StarsQuerySource,
} from '@/stars/stars-query';

/**
 * Star query engine (runs in the SW, owns IDB); returns a filtered+sorted window
 * + sidebar facet counts, never the full row set.
 */


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

let cache: { source: StarsQuerySource; version: number } | null = null;
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
  cache = {
    source: { stars, tags, tagMeta },
    version: cacheVersion,
  };
  return cache;
}



/** Resolves every matching repository ID using the same authoritative filter/sort semantics as queryStars. */
export async function queryAllMatchingStarIds(
  filter: StarsQueryParams['filter'],
  accountLogin: string | null = null,
): Promise<string[]> {
  const { source } = await ensureCache();
  return projectMatchingStars(source, filter, accountLogin).map((star) => star.full_name);
}

export async function resolveLaunchCandidate(
  contract: LaunchCandidateContract,
  resolveResultSubset?: ResultSubsetResolver,
  accountLogin: string | null = null,
): Promise<ResolvedLaunchCandidate> {
  validateLaunchCandidateContract(contract);
  const { source } = await ensureCache();
  let repositoryIds: string[];
  let label: string;
  let filterSnapshot: string;

  if (contract.kind === 'current_view') {
    repositoryIds = projectMatchingStars(source, contract.filter, accountLogin)
      .map((star) => star.full_name);
    label = 'Current view';
    filterSnapshot = JSON.stringify(contract.filter);
  } else if (contract.kind === 'selected_repository') {
    const selected = source.stars.find((star) => (
      star.full_name === contract.selectedRepositoryIdHint
      && !star.tombstone
    ));
    repositoryIds = selected ? [selected.full_name] : [];
    label = selected?.full_name ?? contract.selectedRepositoryIdHint;
    filterSnapshot = `Selected repository: ${contract.selectedRepositoryIdHint}`;
  } else if (contract.kind === 'all_live_stars') {
    repositoryIds = source.stars
      .filter((star) => !star.tombstone && star.viewer_has_starred !== false)
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
      .map((star) => star.full_name);
    label = 'All starred repositories';
    filterSnapshot = 'All live stars';
  } else if (contract.kind === 'still_untagged_after_auto_tags') {
    repositoryIds = projectMatchingStars(source, {
      query: '',
      languages: [],
      tags: [],
      tagMode: 'any',
      showTombstone: false,
      onlyFavorite: false,
      onlyUntagged: true,
      onlyArchived: false,
      onlyOwned: false,
      sortKey: 'name',
      sortDir: 'asc',
    })
      .filter((star) => star.viewer_has_starred !== false)
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
  accountLogin: string | null = null,
): Promise<ResolvedLaunchCandidate> {
  const resolved = await resolveLaunchCandidate(contract, resolveResultSubset, accountLogin);
  const { source } = await ensureCache();
  const liveRepositoryIds = new Set(
    source.stars.filter((star) => !star.tombstone).map((star) => star.full_name),
  );
  return {
    ...resolved,
    repositoryIds: resolved.repositoryIds.filter((repositoryId) => (
      liveRepositoryIds.has(repositoryId)
    )),
  };
}

export async function queryStars(params: StarsQueryParams): Promise<StarsQueryResult> {
  const { source } = await ensureCache();
  return projectStarsQuery(source, params);
}
