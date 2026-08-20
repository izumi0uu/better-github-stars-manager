import type { GitHubCredentialSnapshot, authStore } from '@/auth/auth-store';
import type { FollowingHistoryWindowDays } from '@/types';
import { fetchGitHubRadar } from '@/api/github-radar-source';
import {
  GitHubRadarError,
  type RadarActivityPresentation,
  type RadarErrorCode,
  type RadarStateRecord,
} from '@/radar/radar-model';
import type {
  RadarQueryResponse,
  RadarRefreshResult,
  RadarStatus,
} from '@/radar/radar-contract';
import {
  commitRadarSnapshot,
  dismissRadarActivities,
  getRadarState,
  listRadarActivities,
  markRadarActivitiesSeen,
  makeRadarStatus,
  prepareRadarAccount,
  recordRadarFailure,
  clearRadarData,
} from '@/storage/radar-store';

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1_000;

type RadarAuth = Pick<typeof authStore, 'getGitHubCredentialSnapshot' | 'getConfig'>;
type AuthSnapshot = GitHubCredentialSnapshot;

type RadarRefreshOutcome = Readonly<{ published: boolean }>;

export interface RadarRefreshCoordinatorDependencies {
  runSerialized<T>(operation: () => Promise<T>): Promise<T>;
  auth: RadarAuth;
  fetchRadar: typeof fetchGitHubRadar;
  store: {
    clearData: typeof clearRadarData;
    prepareAccount: typeof prepareRadarAccount;
    getState: typeof getRadarState;
    commitSnapshot: typeof commitRadarSnapshot;
    recordFailure: typeof recordRadarFailure;
    listActivities: typeof listRadarActivities;
    dismissActivities: typeof dismissRadarActivities;
    markActivitiesSeen: typeof markRadarActivitiesSeen;
  };
  now?: () => number;
  broadcastChanged(): void;
}

export interface RadarRefreshCoordinator {
  getStatus(): Promise<RadarStatus>;
  query(): Promise<RadarQueryResponse>;
  refresh(): Promise<RadarRefreshResult>;
  dismiss(activityIds: readonly string[]): Promise<RadarStatus>;
  markSeen(activityIds: readonly string[]): Promise<RadarStatus>;
  reconcileAccount(): Promise<void>;
  isRefreshing(): boolean;
}

function identity(auth: AuthSnapshot): string {
  return JSON.stringify([auth.accountLogin, auth.mainIdentity, auth.mainToken !== null]);
}

function stableErrorCode(error: unknown): RadarErrorCode {
  return error instanceof GitHubRadarError ? error.code : 'network_error';
}

function rateLimitNextAllowedAt(error: unknown, attemptedAt: number): string | null {
  if (!(error instanceof GitHubRadarError) || error.code !== 'rate_limited') return null;
  if (error.resetAt && Number.isFinite(Date.parse(error.resetAt))) return error.resetAt;
  return new Date(attemptedAt + DEFAULT_RATE_LIMIT_COOLDOWN_MS).toISOString();
}

export function createRadarRefreshCoordinator(
  dependencies: RadarRefreshCoordinatorDependencies,
): RadarRefreshCoordinator {
  const now = dependencies.now ?? Date.now;
  let inFlight: { identity: string; promise: Promise<RadarRefreshResult> } | null = null;

  async function readAuth(): Promise<AuthSnapshot> {
    return dependencies.auth.getGitHubCredentialSnapshot();
  }

  async function readWindowDays(): Promise<FollowingHistoryWindowDays> {
    return (await dependencies.auth.getConfig()).radarWindowDays;
  }

  async function sameCredentials(snapshot: AuthSnapshot): Promise<boolean> {
    const latest = await readAuth();
    return latest.accountLogin === snapshot.accountLogin
      && latest.mainToken !== null
      && latest.mainIdentity === snapshot.mainIdentity;
  }

  async function sameRequest(
    snapshot: AuthSnapshot,
    windowDays: FollowingHistoryWindowDays,
  ): Promise<boolean> {
    return await sameCredentials(snapshot) && await readWindowDays() === windowDays;
  }

  async function statusForAuth(
    auth: AuthSnapshot,
    refreshing: boolean,
    stateOverride?: RadarStateRecord | null,
    windowDaysOverride?: FollowingHistoryWindowDays,
  ): Promise<RadarStatus> {
    const windowDays = windowDaysOverride ?? await readWindowDays();
    const hasMainToken = !!(auth.accountLogin && auth.mainToken);
    const state = stateOverride !== undefined
      ? stateOverride
      : hasMainToken && auth.accountLogin
        ? await dependencies.store.getState(auth.accountLogin)
        : null;
    return makeRadarStatus(auth.accountLogin, hasMainToken, refreshing, state, now(), windowDays);
  }

  async function reconcileAccount(): Promise<void> {
    await dependencies.runSerialized(async () => {
      const auth = await readAuth();
      if (auth.accountLogin && auth.mainToken) {
        await dependencies.store.prepareAccount(auth.accountLogin);
      } else {
        await dependencies.store.clearData();
      }
    });
  }

  async function getStatus(): Promise<RadarStatus> {
    await reconcileAccount();
    return statusForAuth(await readAuth(), inFlight !== null);
  }

  async function query(): Promise<RadarQueryResponse> {
    await reconcileAccount();
    const [auth, windowDays] = await Promise.all([readAuth(), readWindowDays()]);
    const accountLogin = auth.accountLogin && auth.mainToken ? auth.accountLogin : null;
    const queriedAt = now();
    const [activities, state] = await Promise.all([
      accountLogin
        ? dependencies.store.listActivities(accountLogin, queriedAt, windowDays)
        : Promise.resolve([] as RadarActivityPresentation[]),
      accountLogin ? dependencies.store.getState(accountLogin) : Promise.resolve(null),
    ]);
    const [latest, latestWindowDays] = await Promise.all([readAuth(), readWindowDays()]);
    if (identity(auth) !== identity(latest) || windowDays !== latestWindowDays) {
      return {
        activities: [],
        unseenCount: 0,
        status: await statusForAuth(latest, inFlight !== null, undefined, latestWindowDays),
      };
    }
    return {
      activities,
      unseenCount: activities.reduce((count, activity) => count + (activity.seen ? 0 : 1), 0),
      status: await statusForAuth(auth, inFlight !== null, state, windowDays),
    };
  }

  async function performRefresh(
    auth: AuthSnapshot,
    windowDays: FollowingHistoryWindowDays,
  ): Promise<RadarRefreshOutcome> {
    if (!auth.accountLogin || !auth.mainToken || !await sameRequest(auth, windowDays)) {
      return { published: false };
    }
    const attemptedAt = now();
    await dependencies.store.prepareAccount(auth.accountLogin);
    const previousState = await dependencies.store.getState(auth.accountLogin);
    if (
      previousState?.nextAllowedAt
      && Date.parse(previousState.nextAllowedAt) > attemptedAt
      && previousState.errorCode === 'rate_limited'
    ) {
      return { published: false };
    }

    try {
      const snapshot = await dependencies.fetchRadar({
        token: auth.mainToken,
        now: () => new Date(attemptedAt),
        windowDays,
      });
      if (
        snapshot.windowDays !== windowDays
        || snapshot.accountLogin.trim().toLocaleLowerCase('en-US')
          !== auth.accountLogin.trim().toLocaleLowerCase('en-US')
      ) {
        throw new GitHubRadarError('invalid_response');
      }
      if (!await sameRequest(auth, windowDays)) return { published: false };
      await dependencies.store.commitSnapshot(snapshot);
      // Config can change while the IndexedDB commit yields; never announce that stale result.
      if (!await sameRequest(auth, windowDays)) return { published: false };
      dependencies.broadcastChanged();
      return { published: true };
    } catch (error) {
      if (await sameRequest(auth, windowDays)) {
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

  async function refresh(): Promise<RadarRefreshResult> {
    await reconcileAccount();
    const [requestedAuth, windowDays] = await Promise.all([readAuth(), readWindowDays()]);
    const requestedIdentity = JSON.stringify([identity(requestedAuth), windowDays]);
    const current = inFlight;
    if (current) {
      if (current.identity === requestedIdentity) return current.promise;
      try {
        await current.promise;
      } catch {
        // A changed credential or history window gets its own isolated attempt.
      }
      if (inFlight === current) inFlight = null;
      return refresh();
    }

    const operation = dependencies.runSerialized(() => performRefresh(requestedAuth, windowDays));
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

  async function dismiss(activityIds: readonly string[]): Promise<RadarStatus> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) return statusForAuth(auth, inFlight !== null);
    await dependencies.runSerialized(async () => {
      if (!await sameCredentials(auth)) return;
      const changed = await dependencies.store.dismissActivities(auth.accountLogin!, activityIds);
      if (changed > 0) dependencies.broadcastChanged();
    });
    return statusForAuth(await readAuth(), inFlight !== null);
  }
  async function markSeen(activityIds: readonly string[]): Promise<RadarStatus> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) return statusForAuth(auth, inFlight !== null);
    await dependencies.runSerialized(async () => {
      if (!await sameCredentials(auth)) return;
      const changed = await dependencies.store.markActivitiesSeen(auth.accountLogin!, activityIds);
      if (changed > 0) dependencies.broadcastChanged();
    });
    return statusForAuth(await readAuth(), inFlight !== null);
  }


  return {
    getStatus,
    query,
    refresh,
    dismiss,
    markSeen,
    reconcileAccount,
    isRefreshing: () => inFlight !== null,
  };
}
