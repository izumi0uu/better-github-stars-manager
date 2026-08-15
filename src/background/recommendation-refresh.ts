import type { GitHubCredentialSnapshot, authStore } from '@/auth/auth-store';
import { fetchGitHubRecommendations } from '@/api/github-recommendation-source';
import {
  buildRecommendationQueryPlan,
  GitHubRecommendationError,
  selectRecommendationSeeds,
  type RecommendationErrorCode,
  type RecommendationQueryResponse,
  type RecommendationRefreshResult,
  type RecommendationStateRecord,
  type RecommendationStatus,
} from '@/recommendations/recommendation-model';
import {
  clearRecommendationData,
  commitRecommendationSnapshot,
  getRecommendationState,
  ignoreRecommendation,
  listIgnoredRepositories,
  listRecommendations,
  makeRecommendationStatus,
  prepareRecommendationAccount,
  recordRecommendationFailure,
  restoreIgnoredRecommendation,
} from '../storage/recommendation-store';
import { db } from '@/storage/db';
import { normalizeRepositoryFullName } from '@/watch/watch-model';
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1_000;

type RecommendationAuth = Pick<typeof authStore, 'getGitHubCredentialSnapshot'>;
type AuthSnapshot = GitHubCredentialSnapshot;

export interface RecommendationRefreshCoordinatorDependencies {
  runSerialized<T>(operation: () => Promise<T>): Promise<T>;
  auth: RecommendationAuth;
  fetchRecommendations: typeof fetchGitHubRecommendations;
  loadSeeds(): Promise<ReturnType<typeof selectRecommendationSeeds>>;
  loadExcludedRepositoryKeys(accountLogin: string): Promise<Set<string>>;
  store: {
    clearData: typeof clearRecommendationData;
    prepareAccount: typeof prepareRecommendationAccount;
    getState: typeof getRecommendationState;
    commitSnapshot: typeof commitRecommendationSnapshot;
    recordFailure: typeof recordRecommendationFailure;
    listRecommendations: typeof listRecommendations;
    ignoreRepository: typeof ignoreRecommendation;
    listIgnored: typeof listIgnoredRepositories;
    restoreIgnored: typeof restoreIgnoredRecommendation;
  };
  now?: () => number;
  broadcastChanged(): void;
}

export interface RecommendationRefreshCoordinator {
  getStatus(): Promise<RecommendationStatus>;
  query(): Promise<RecommendationQueryResponse>;
  refresh(): Promise<RecommendationRefreshResult>;
  refreshFirstEligible(): Promise<RecommendationRefreshResult | null>;
  refreshIfDue(): Promise<RecommendationRefreshResult | null>;
  refreshAtScheduledBoundary(): Promise<RecommendationRefreshResult | null>;
  nextDailyRefreshAt(nowMillis?: number): Promise<number | null>;
  clear(): Promise<RecommendationStatus>;
  ignoreRepository(repositoryKey: string, repositoryFullName?: string): Promise<void>;
  restoreIgnored(repositoryKey: string): Promise<void>;
  reconcileAccount(): Promise<void>;
  isRefreshing(): boolean;
}

function identity(auth: AuthSnapshot): string {
  return JSON.stringify([auth.accountLogin, auth.mainIdentity, auth.mainToken !== null]);
}

function stableErrorCode(error: unknown): RecommendationErrorCode {
  return error instanceof GitHubRecommendationError ? error.code : 'network_error';
}

function rateLimitNextAllowedAt(error: unknown, attemptedAt: number): string | null {
  if (!(error instanceof GitHubRecommendationError) || error.code !== 'rate_limited') return null;
  if (error.resetAt && Number.isFinite(Date.parse(error.resetAt))) return error.resetAt;
  return new Date(attemptedAt + DEFAULT_RATE_LIMIT_COOLDOWN_MS).toISOString();
}

export function localDayKey(nowMillis: number): string {
  const date = new Date(nowMillis);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function localRefreshBoundary(nowMillis: number): number {
  const date = new Date(nowMillis);
  if (!Number.isFinite(date.getTime())) return Number.NaN;
  date.setHours(8, 0, 0, 0);
  return date.getTime();
}

export function nextLocalRefreshAt(nowMillis: number): number {
  const boundary = localRefreshBoundary(nowMillis);
  if (!Number.isFinite(boundary)) return Number.NaN;
  const next = new Date(boundary);
  if (nowMillis >= boundary) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function isRecommendationRefreshDue(
  lastSuccessfulAt: string | null,
  nowMillis: number,
): boolean {
  const boundary = localRefreshBoundary(nowMillis);
  if (!Number.isFinite(boundary) || nowMillis < boundary) return false;
  if (!lastSuccessfulAt) return true;
  const successfulAt = Date.parse(lastSuccessfulAt);
  return !Number.isFinite(successfulAt)
    || localDayKey(successfulAt) !== localDayKey(nowMillis);
}

export function isRecommendationCatchUpDue(
  state: Pick<RecommendationStateRecord, 'lastAttemptAt' | 'lastSuccessfulAt'> | null,
  nowMillis: number,
): boolean {
  if (!state?.lastSuccessfulAt || !isRecommendationRefreshDue(state.lastSuccessfulAt, nowMillis)) {
    return false;
  }
  const lastAttemptAt = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : Number.NaN;
  return !Number.isFinite(lastAttemptAt) || localDayKey(lastAttemptAt) !== localDayKey(nowMillis);
}

export function createRecommendationRefreshCoordinator(
  dependencies: RecommendationRefreshCoordinatorDependencies,
): RecommendationRefreshCoordinator {
  const now = dependencies.now ?? Date.now;
  let inFlight: { identity: string; promise: Promise<RecommendationRefreshResult> } | null = null;
  let preparedIdentity: string | null = null;
  let firstEntryCheck: { identity: string; promise: Promise<RecommendationRefreshResult | null> } | null = null;

  const readAuth = () => dependencies.auth.getGitHubCredentialSnapshot();
  const sameCredentials = async (snapshot: AuthSnapshot) => {
    const latest = await readAuth();
    return latest.accountLogin === snapshot.accountLogin
      && latest.mainToken !== null
      && latest.mainIdentity === snapshot.mainIdentity;
  };
  const statusForAuth = async (
    auth: AuthSnapshot,
    refreshing: boolean,
    stateOverride?: RecommendationStateRecord | null,
  ): Promise<RecommendationStatus> => {
    const hasMainToken = !!(auth.accountLogin && auth.mainToken);
    const state = stateOverride !== undefined
      ? stateOverride
      : hasMainToken && auth.accountLogin
        ? await dependencies.store.getState(auth.accountLogin)
        : null;
    return makeRecommendationStatus(auth.accountLogin, hasMainToken, refreshing, state, now());
  };

  async function reconcileAccount(): Promise<void> {
    const auth = await readAuth();
    const nextIdentity = identity(auth);
    if (preparedIdentity === nextIdentity) return;
    await dependencies.runSerialized(async () => {
      const latest = await readAuth();
      const latestIdentity = identity(latest);
      if (latest.accountLogin && latest.mainToken) {
        await dependencies.store.prepareAccount(latest.accountLogin);
      } else {
        await dependencies.store.clearData();
      }
      preparedIdentity = latestIdentity;
    });
  }

  async function getStatus(): Promise<RecommendationStatus> {
    await reconcileAccount();
    return statusForAuth(await readAuth(), inFlight !== null);
  }

  async function query(): Promise<RecommendationQueryResponse> {
    await reconcileAccount();
    const auth = await readAuth();
    const accountLogin = auth.accountLogin && auth.mainToken ? auth.accountLogin : null;
    const [recommendations, state, ignored] = await Promise.all([
      accountLogin
        ? dependencies.store.listRecommendations(accountLogin)
        : Promise.resolve([]),
      accountLogin ? dependencies.store.getState(accountLogin) : Promise.resolve(null),
      accountLogin
        ? dependencies.store.listIgnored(accountLogin)
        : Promise.resolve([]),
    ]);
    const latest = await readAuth();
    if (identity(auth) !== identity(latest)) {
      return {
        recommendations: [],
        ignored: [],
        status: await statusForAuth(latest, inFlight !== null),
      };
    }
    return {
      recommendations,
      ignored,
      status: await statusForAuth(auth, inFlight !== null, state),
    };
  }

  async function performRefresh(auth: AuthSnapshot): Promise<{ published: boolean }> {
    if (!auth.accountLogin || !auth.mainToken || !await sameCredentials(auth)) {
      return { published: false };
    }
    const attemptedAt = now();
    await dependencies.store.prepareAccount(auth.accountLogin);
    const previousState = await dependencies.store.getState(auth.accountLogin);
    if (
      previousState?.nextAllowedAt
      && Date.parse(previousState.nextAllowedAt) > attemptedAt
    ) return { published: false };

    try {
      const [seeds, excludedRepositoryKeys] = await Promise.all([
        dependencies.loadSeeds(),
        dependencies.loadExcludedRepositoryKeys(auth.accountLogin),
      ]);
      const queryPlan = buildRecommendationQueryPlan(seeds);
      const snapshot = await dependencies.fetchRecommendations({
        token: auth.mainToken,
        accountLogin: auth.accountLogin,
        seeds,
        queryPlan,
        excludedRepositoryKeys,
        now: () => new Date(attemptedAt),
      });
      if (snapshot.accountLogin !== auth.accountLogin.trim().toLocaleLowerCase('en-US')) {
        throw new GitHubRecommendationError('invalid_response');
      }
      if (!await sameCredentials(auth)) return { published: false };
      await dependencies.store.commitSnapshot(snapshot);
      dependencies.broadcastChanged();
      return { published: true };
    } catch (error) {
      if (await sameCredentials(auth)) {
        await dependencies.store.recordFailure(
          auth.accountLogin,
          stableErrorCode(error),
          { nextAllowedAt: rateLimitNextAllowedAt(error, attemptedAt) },
        );
        dependencies.broadcastChanged();
      }
      return { published: false };
    }
  }

  async function refresh(): Promise<RecommendationRefreshResult> {
    await reconcileAccount();
    const requestedAuth = await readAuth();
    const requestedIdentity = identity(requestedAuth);
    const current = inFlight;
    if (current) {
      if (current.identity === requestedIdentity) return current.promise;
      try {
        await current.promise;
      } catch {
        // A changed credential identity gets a separate attempt.
      }
      if (inFlight === current) inFlight = null;
      return refresh();
    }
    const operation = dependencies.runSerialized(() => performRefresh(requestedAuth));
    const promise = operation.then(async (outcome) => ({
      ...outcome,
      status: await statusForAuth(await readAuth(), false),
    }));
    inFlight = { identity: requestedIdentity, promise };
    void promise.finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    }).catch(() => {});
    return promise;
  }

  async function refreshFirstEligible(): Promise<RecommendationRefreshResult | null> {
    await reconcileAccount();
    const requestedAuth = await readAuth();
    const requestedIdentity = identity(requestedAuth);
    const currentCheck = firstEntryCheck;
    if (currentCheck?.identity === requestedIdentity) return currentCheck.promise;
    const promise = (async () => {
      if (!requestedAuth.accountLogin || !requestedAuth.mainToken) return null;
      const state = await dependencies.store.getState(requestedAuth.accountLogin);
      if (state?.lastSuccessfulAt) return null;
      const seeds = await dependencies.loadSeeds();
      if (seeds.length === 0 || !await sameCredentials(requestedAuth)) return null;
      return refresh();
    })();
    firstEntryCheck = { identity: requestedIdentity, promise };
    void promise.finally(() => {
      if (firstEntryCheck?.promise === promise) firstEntryCheck = null;
    }).catch(() => {});
    return promise;
  }

  async function refreshIfDue(): Promise<RecommendationRefreshResult | null> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) return null;
    const state = await dependencies.store.getState(auth.accountLogin);
    if (!isRecommendationCatchUpDue(state, now())) return null;
    return refresh();
  }

  async function refreshAtScheduledBoundary(): Promise<RecommendationRefreshResult | null> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) return null;
    const state = await dependencies.store.getState(auth.accountLogin);
    if (!state?.lastSuccessfulAt || !isRecommendationRefreshDue(state.lastSuccessfulAt, now())) return null;
    return refresh();
  }

  async function nextDailyRefreshAt(nowMillis = now()): Promise<number | null> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) return null;
    const state = await dependencies.store.getState(auth.accountLogin);
    if (!state?.lastSuccessfulAt) return null;
    return nextLocalRefreshAt(nowMillis);
  }

  async function clear(): Promise<RecommendationStatus> {
    await dependencies.runSerialized(() => dependencies.store.clearData());
    dependencies.broadcastChanged();
    return statusForAuth(await readAuth(), inFlight !== null, null);
  }

  async function ignoreRepository(repositoryKey: string, repositoryFullName?: string): Promise<void> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) {
      throw new GitHubRecommendationError('authentication_required');
    }
    await dependencies.runSerialized(async () => {
      const latest = await readAuth();
      if (!latest.accountLogin || !latest.mainToken) {
        throw new GitHubRecommendationError('authentication_required');
      }
      await dependencies.store.ignoreRepository(latest.accountLogin, repositoryKey, repositoryFullName);
    });
    dependencies.broadcastChanged();
  }

  async function restoreIgnored(repositoryKey: string): Promise<void> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) {
      throw new GitHubRecommendationError('authentication_required');
    }
    await dependencies.runSerialized(async () => {
      const latest = await readAuth();
      if (!latest.accountLogin || !latest.mainToken) {
        throw new GitHubRecommendationError('authentication_required');
      }
      await dependencies.store.restoreIgnored(latest.accountLogin, repositoryKey);
    });
    dependencies.broadcastChanged();
  }

  return {
    getStatus,
    query,
    refresh,
    refreshFirstEligible,
    refreshAtScheduledBoundary,
    refreshIfDue,
    nextDailyRefreshAt,
    clear,
    ignoreRepository,
    restoreIgnored,
    reconcileAccount,
    isRefreshing: () => inFlight !== null,
  };
}

export function createProductionRecommendationLoaders() {
  return {
    loadSeeds: async () => selectRecommendationSeeds(await db.stars.toArray()),
    loadExcludedRepositoryKeys: async (accountLogin: string) => new Set([
      ...(await db.stars.toArray())
        .filter((star) => !star.tombstone && star.viewer_has_starred !== false)
        .map((star) => normalizeRepositoryFullName(star.full_name)),
      ...(await db.recommendationIgnores
        .where('accountLogin')
        .equals(accountLogin.trim().toLocaleLowerCase('en-US'))
        .toArray())
        .map((row) => row.repositoryKey),
    ]),
  };
}
