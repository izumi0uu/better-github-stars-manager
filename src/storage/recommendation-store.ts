import {
  canonicalRepositoryKey,
  GitHubRecommendationError,
  RECOMMENDATION_MAX_CANDIDATES,
  type RecommendationErrorCode,
  type RecommendationIgnoreRecord,
  type RecommendationRecord,
  type RecommendationSnapshotStatus,
  type RecommendationSourceSnapshot,
  type RecommendationStateRecord,
  type RecommendationStatus,
} from '@/recommendations/recommendation-model';
import { normalizeRepositoryFullName } from '@/watch/watch-model';
import { db } from './db';

const RECOMMENDATION_STATE_ID = 'singleton' as const;
const RECOMMENDATION_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

function now(): string {
  return new Date().toISOString();
}

function accountKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyState(
  accountLogin: string,
  lastAttemptAt = now(),
): RecommendationStateRecord {
  return {
    id: RECOMMENDATION_STATE_ID,
    accountLogin: accountKey(accountLogin),
    lastAttemptAt,
    lastSuccessfulAt: null,
    errorCode: null,
    nextAllowedAt: null,
    candidateCount: 0,
    seedCount: 0,
    queryCount: 0,
    rateLimitRemaining: null,
    rateLimitResetAt: null,
  };
}

function stateForAccount(
  state: RecommendationStateRecord | undefined,
  accountLogin: string,
): RecommendationStateRecord | null {
  return state && state.accountLogin === accountKey(accountLogin) ? state : null;
}

function normalizedRecommendation(
  recommendation: RecommendationRecord,
  accountLogin: string,
  fetchedAt: string,
): RecommendationRecord {
  let repositoryKey: string;
  let seedRepositoryKey: string;
  try {
    repositoryKey = normalizeRepositoryFullName(recommendation.repositoryKey);
    seedRepositoryKey = normalizeRepositoryFullName(recommendation.reason.seedRepositoryKey);
  } catch {
    throw new GitHubRecommendationError('invalid_candidate');
  }
  const parsedFetchedAt = timestamp(fetchedAt);
  if (
    parsedFetchedAt === null
    || recommendation.id !== repositoryKey
    || !Number.isFinite(recommendation.score)
    || recommendation.score < 0
    || recommendation.repositoryFullName.trim().length === 0
    || recommendation.reason.seedRepositoryFullName.trim().length === 0
    || recommendation.stargazerCount < 0
    || !Number.isSafeInteger(recommendation.stargazerCount)
  ) throw new GitHubRecommendationError('invalid_candidate');
  let repositoryHtmlUrl: URL;
  try {
    repositoryHtmlUrl = new URL(recommendation.repositoryHtmlUrl);
  } catch {
    throw new GitHubRecommendationError('invalid_candidate');
  }
  if (repositoryHtmlUrl.protocol !== 'https:' || repositoryHtmlUrl.hostname !== 'github.com') {
    throw new GitHubRecommendationError('invalid_candidate');
  }
  return {
    ...recommendation,
    id: repositoryKey,
    accountLogin,
    repositoryKey,
    repositoryHtmlUrl: repositoryHtmlUrl.toString(),
    reason: {
      ...recommendation.reason,
      seedRepositoryKey,
    },
    fetchedAt: new Date(parsedFetchedAt).toISOString(),
  };
}

/** Remove another account's derived cache before the active account can query it. */
export async function prepareRecommendationAccount(accountLogin: string): Promise<void> {
  const key = accountKey(accountLogin);
  await db.transaction('rw', db.recommendations, db.recommendationState, async () => {
    const state = await db.recommendationState.get(RECOMMENDATION_STATE_ID);
    if (state?.accountLogin === key) return;
    await db.recommendations.clear();
    await db.recommendationState.delete(RECOMMENDATION_STATE_ID);
  });
}

export async function getRecommendationState(
  accountLogin: string,
): Promise<RecommendationStateRecord | null> {
  return stateForAccount(
    await db.recommendationState.get(RECOMMENDATION_STATE_ID),
    accountLogin,
  );
}

/** Atomically replace the disposable candidate cache after a complete Search refresh. */
export async function commitRecommendationSnapshot(
  snapshot: RecommendationSourceSnapshot,
): Promise<RecommendationStateRecord> {
  const accountLogin = accountKey(snapshot.accountLogin);
  const fetchedAtMillis = timestamp(snapshot.fetchedAt);
  if (!accountLogin || fetchedAtMillis === null) {
    throw new GitHubRecommendationError('invalid_response');
  }
  const fetchedAt = new Date(fetchedAtMillis).toISOString();
  const byRepository = new Map<string, RecommendationRecord>();
  for (const raw of snapshot.recommendations) {
    const recommendation = normalizedRecommendation(raw, accountLogin, fetchedAt);
    if (!byRepository.has(recommendation.repositoryKey)) {
      byRepository.set(recommendation.repositoryKey, recommendation);
    }
  }
  const ranked = [...byRepository.values()]
    .sort((left, right) => (
      right.score - left.score
        || right.stargazerCount - left.stargazerCount
        || left.repositoryKey.localeCompare(right.repositoryKey)
    ))
    .slice(0, RECOMMENDATION_MAX_CANDIDATES);
  const attemptAt = now();
  return db.transaction('rw', db.recommendations, db.recommendationState, db.recommendationIgnores, async () => {
    const ignoredKeys = new Set((await db.recommendationIgnores
      .where('accountLogin').equals(accountLogin).toArray())
      .map((row) => row.repositoryKey));
    const recommendations = ranked
      .filter((recommendation) => !ignoredKeys.has(recommendation.repositoryKey));
    await db.recommendations.clear();
    if (recommendations.length > 0) await db.recommendations.bulkPut(recommendations);
    const previous = stateForAccount(
      await db.recommendationState.get(RECOMMENDATION_STATE_ID),
      accountLogin,
    );
    const resetAt = timestamp(snapshot.rateLimitResetAt);
    const state: RecommendationStateRecord = {
      ...(previous ?? emptyState(accountLogin, attemptAt)),
      id: RECOMMENDATION_STATE_ID,
      accountLogin,
      lastAttemptAt: attemptAt,
      lastSuccessfulAt: fetchedAt,
      errorCode: null,
      nextAllowedAt: snapshot.rateLimitRemaining === 0 && resetAt !== null && resetAt > fetchedAtMillis
        ? new Date(resetAt).toISOString()
        : null,
      candidateCount: recommendations.length,
      seedCount: Math.max(0, snapshot.seedCount),
      queryCount: Math.max(0, snapshot.queryCount),
      rateLimitRemaining: snapshot.rateLimitRemaining,
      rateLimitResetAt: snapshot.rateLimitResetAt,
    };
    await db.recommendationState.put(state);
    return state;
  });
}

/** Persist an account decision: never recommend this repository again. */
export async function ignoreRecommendation(
  accountLogin: string,
  repositoryKey: string,
  repositoryFullName?: string,
): Promise<void> {
  const account = accountKey(accountLogin);
  const key = canonicalRepositoryKey(repositoryKey);
  if (!account || !key) throw new GitHubRecommendationError('invalid_candidate');
  const fullName = canonicalRepositoryKey(repositoryFullName) === key
    ? (repositoryFullName as string)
    : key;
  await db.recommendationIgnores.put({
    id: `${account}:${key}`,
    accountLogin: account,
    repositoryKey: key,
    repositoryFullName: fullName,
    ignoredAt: now(),
  });
}

export async function listIgnoredRepositories(
  accountLogin: string,
): Promise<RecommendationIgnoreRecord[]> {
  const account = accountKey(accountLogin);
  if (!account) return [];
  return (await db.recommendationIgnores.where('accountLogin').equals(account).toArray())
    .sort((left, right) => right.ignoredAt.localeCompare(left.ignoredAt));
}

export async function restoreIgnoredRecommendation(
  accountLogin: string,
  repositoryKey: string,
): Promise<void> {
  const account = accountKey(accountLogin);
  const key = canonicalRepositoryKey(repositoryKey);
  if (!account || !key) throw new GitHubRecommendationError('invalid_candidate');
  await db.recommendationIgnores.delete(`${account}:${key}`);
}

export async function recordRecommendationFailure(
  accountLogin: string,
  errorCode: RecommendationErrorCode,
  options: { nextAllowedAt?: string | null } = {},
): Promise<RecommendationStateRecord> {
  const key = accountKey(accountLogin);
  const attemptAt = now();
  return db.transaction('rw', db.recommendationState, async () => {
    const previous = stateForAccount(
      await db.recommendationState.get(RECOMMENDATION_STATE_ID),
      key,
    );
    const state: RecommendationStateRecord = {
      ...(previous ?? emptyState(key, attemptAt)),
      id: RECOMMENDATION_STATE_ID,
      accountLogin: key,
      lastAttemptAt: attemptAt,
      errorCode,
      nextAllowedAt: options.nextAllowedAt ?? null,
    };
    await db.recommendationState.put(state);
    return state;
  });
}

/** Query cache rows for one account, excluding ignored and already-starred repositories. */
export async function listRecommendations(accountLogin: string): Promise<RecommendationRecord[]> {
  const key = accountKey(accountLogin);
  const [stored, stars, ignores] = await Promise.all([
    db.recommendations.where('accountLogin').equals(key).toArray(),
    db.stars.toArray(),
    db.recommendationIgnores.where('accountLogin').equals(key).toArray(),
  ]);
  const liveLibrary = new Set(stars.flatMap((star) => {
    if (star.tombstone || star.viewer_has_starred === false) return [];
    try {
      return [normalizeRepositoryFullName(star.full_name)];
    } catch {
      return [];
    }
  }));
  const ignoredKeys = new Set(ignores.map((row) => row.repositoryKey));
  return stored
    .filter((recommendation) => (
      !liveLibrary.has(recommendation.repositoryKey)
      && !ignoredKeys.has(recommendation.repositoryKey)
    ))
    .sort((left, right) => (
      right.score - left.score
        || right.stargazerCount - left.stargazerCount
        || left.repositoryKey.localeCompare(right.repositoryKey)
    ));
}

export async function clearRecommendationData(): Promise<void> {
  await db.transaction('rw', db.recommendations, db.recommendationState, async () => {
    await db.recommendations.clear();
    await db.recommendationState.clear();
  });
}

export function recommendationSnapshotStatus(
  state: RecommendationStateRecord | null,
  nowMillis = Date.now(),
): RecommendationSnapshotStatus {
  if (!state) return 'never_loaded';
  const nextAllowedAt = timestamp(state.nextAllowedAt);
  if (nextAllowedAt !== null && nextAllowedAt > nowMillis) return 'cooldown';
  const lastSuccessfulAt = timestamp(state.lastSuccessfulAt);
  if (lastSuccessfulAt === null) return state.errorCode !== null ? 'error' : 'never_loaded';
  if (state.errorCode !== null || nowMillis - lastSuccessfulAt > RECOMMENDATION_STALE_AFTER_MS) {
    return 'stale';
  }
  return 'fresh';
}

export function makeRecommendationStatus(
  accountLogin: string | null,
  hasMainToken: boolean,
  refreshing: boolean,
  state: RecommendationStateRecord | null,
  nowMillis = Date.now(),
): RecommendationStatus {
  return {
    accountLogin: accountLogin ? accountKey(accountLogin) : null,
    hasMainToken,
    refreshing,
    snapshotStatus: !hasMainToken
      ? 'not_configured'
      : recommendationSnapshotStatus(state, nowMillis),
    errorCode: state?.errorCode ?? null,
    state,
  };
}
