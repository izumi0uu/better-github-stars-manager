import type { GitHubCredentialSnapshot, authStore } from '@/auth/auth-store';
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

type RadarAuth = Pick<typeof authStore, 'getGitHubCredentialSnapshot'>;
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

  async function sameCredentials(snapshot: AuthSnapshot): Promise<boolean> {
    const latest = await readAuth();
    return latest.accountLogin === snapshot.accountLogin
      && latest.mainToken !== null
      && latest.mainIdentity === snapshot.mainIdentity;
  }

  async function statusForAuth(
    auth: AuthSnapshot,
    refreshing: boolean,
    stateOverride?: RadarStateRecord | null,
  ): Promise<RadarStatus> {
    const hasMainToken = !!(auth.accountLogin && auth.mainToken);
    const state = stateOverride !== undefined
      ? stateOverride
      : hasMainToken && auth.accountLogin
        ? await dependencies.store.getState(auth.accountLogin)
        : null;
    return makeRadarStatus(auth.accountLogin, hasMainToken, refreshing, state, now());
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
    const auth = await readAuth();
    const accountLogin = auth.accountLogin && auth.mainToken ? auth.accountLogin : null;
    const [activities, state] = await Promise.all([
      accountLogin
        ? dependencies.store.listActivities(accountLogin, now())
        : Promise.resolve([] as RadarActivityPresentation[]),
      accountLogin ? dependencies.store.getState(accountLogin) : Promise.resolve(null),
    ]);
    const latest = await readAuth();
    if (identity(auth) !== identity(latest)) {
      return {
        activities: [],
        unseenCount: 0,
        status: await statusForAuth(latest, inFlight !== null),
      };
    }
    return {
      activities,
      unseenCount: activities.reduce((count, activity) => count + (activity.seen ? 0 : 1), 0),
      status: await statusForAuth(auth, inFlight !== null, state),
    };
  }

  async function performRefresh(auth: AuthSnapshot): Promise<RadarRefreshOutcome> {
    if (!auth.accountLogin || !auth.mainToken || !await sameCredentials(auth)) {
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
      });
      if (snapshot.accountLogin.trim().toLocaleLowerCase('en-US')
        !== auth.accountLogin.trim().toLocaleLowerCase('en-US')) {
        throw new GitHubRadarError('invalid_response');
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

  async function refresh(): Promise<RadarRefreshResult> {
    await reconcileAccount();
    const requestedAuth = await readAuth();
    const requestedIdentity = identity(requestedAuth);
    const current = inFlight;
    if (current) {
      if (current.identity === requestedIdentity) return current.promise;
      try {
        await current.promise;
      } catch {
        // A changed credential identity gets its own isolated attempt.
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
