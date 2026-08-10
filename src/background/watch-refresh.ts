import type { authStore } from '@/auth/auth-store';
import {
  WATCH_DEFAULT_POLL_INTERVAL_SECONDS,
  WATCH_MAX_POLL_INTERVAL_SECONDS,
  type fetchGitHubNotifications,
} from '@/api/github-notifications-source';
import type { fetchGitHubWatchScope } from '@/api/github-watch-scope-source';
import type {
  clearWatchData,
  getWatchRepositories,
  getWatchState,
  queryStoredWatchInbox,
  reconcileWatchAccount,
  reconcileWatchLiveStars,
  recordWatchInboxFailure,
  recordWatchScopeFailure,
  replaceWatchInbox,
  replaceWatchScope,
  revalidateWatchInbox,
} from '@/storage/watch-store';
import {
  GitHubWatchError,
  canonicalRepositoryFullName,
  projectWatchInbox,
  type GitHubNotificationThread,
} from '@/watch/watch-model';
import type {
  WatchInboxQueryResponse,
  WatchRefreshResult,
  WatchStatus,
} from '@/watch/watch-contract';

type WatchAuth = Pick<typeof authStore, 'getGitHubCredentialSnapshot'>;

export interface WatchRefreshCoordinatorDependencies {
  runSerialized<T>(operation: () => Promise<T>): Promise<T>;
  auth: WatchAuth;
  fetchScope: typeof fetchGitHubWatchScope;
  fetchNotifications: typeof fetchGitHubNotifications;
  loadLiveRepositoryNames(): Promise<string[]>;
  store: {
    getState: typeof getWatchState;
    getRepositories: typeof getWatchRepositories;
    queryInbox: typeof queryStoredWatchInbox;
    reconcileAccount: typeof reconcileWatchAccount;
    reconcileLiveStars: typeof reconcileWatchLiveStars;
    replaceScope: typeof replaceWatchScope;
    recordScopeFailure: typeof recordWatchScopeFailure;
    replaceInbox: typeof replaceWatchInbox;
    revalidateInbox: typeof revalidateWatchInbox;
    recordInboxFailure: typeof recordWatchInboxFailure;
    clearData: typeof clearWatchData;
  };
  now?: () => number;
  broadcastChanged(): void;
}

export interface WatchRefreshCoordinator {
  getStatus(): Promise<WatchStatus>;
  queryInbox(unreadOnly: boolean): Promise<WatchInboxQueryResponse>;
  refresh(): Promise<WatchRefreshResult>;
  clearData(): Promise<WatchStatus>;
  reconcileAccount(): Promise<void>;
  isRefreshing(): boolean;
}

type AuthSnapshot = Awaited<ReturnType<WatchAuth['getGitHubCredentialSnapshot']>>;

type RefreshOutcome = Omit<WatchRefreshResult, 'status'>;

function stableErrorCode(error: unknown): string {
  return error instanceof GitHubWatchError ? error.code : 'internal_error';
}

function nextAllowedAt(attemptedAtMs: number, pollIntervalSeconds: number): string {
  const seconds = Number.isSafeInteger(pollIntervalSeconds) &&
    pollIntervalSeconds > 0 &&
    pollIntervalSeconds <= WATCH_MAX_POLL_INTERVAL_SECONDS
    ? pollIntervalSeconds
    : WATCH_DEFAULT_POLL_INTERVAL_SECONDS;
  return new Date(attemptedAtMs + seconds * 1_000).toISOString();
}

export function createWatchRefreshCoordinator(
  dependencies: WatchRefreshCoordinatorDependencies,
): WatchRefreshCoordinator {
  const now = dependencies.now ?? Date.now;
  let inFlight: { identity: string; promise: Promise<WatchRefreshResult> } | null = null;

  async function readAuth(): Promise<AuthSnapshot> {
    return dependencies.auth.getGitHubCredentialSnapshot();
  }

  async function sameCredentials(snapshot: AuthSnapshot): Promise<boolean> {
    const latest = await readAuth();
    return latest.accountLogin === snapshot.accountLogin &&
      latest.mainToken !== null &&
      latest.mainIdentity === snapshot.mainIdentity;
  }

  function refreshIdentity(auth: AuthSnapshot): string {
    return JSON.stringify([
      auth.accountLogin,
      auth.mainIdentity,
      auth.mainToken !== null,
    ]);
  }

  function sameAuthSnapshot(left: AuthSnapshot, right: AuthSnapshot): boolean {
    return refreshIdentity(left) === refreshIdentity(right);
  }

  async function deriveStatusForAuth(
    auth: AuthSnapshot,
    refreshing: boolean,
    stateOverride?: WatchStatus['state'],
  ): Promise<WatchStatus> {
    const hasMainToken = !!(auth.accountLogin && auth.mainToken);
    const state = stateOverride === undefined && hasMainToken && auth.accountLogin
      ? await dependencies.store.getState(auth.accountLogin)
      : stateOverride ?? null;
    const scopeStatus: WatchStatus['scopeStatus'] = !hasMainToken
      ? 'not_configured'
      : !state?.scope.lastSuccessfulAt
        ? state?.scope.errorCode ? 'error' : 'never_loaded'
        : state.scope.errorCode ? 'stale' : 'fresh';
    let inboxStatus: WatchStatus['inboxStatus'];
    if (!hasMainToken) {
      inboxStatus = 'not_configured';
    } else if (!state?.scope.lastSuccessfulAt) {
      inboxStatus = 'scope_unavailable';
    } else if (!state.inbox.lastSuccessfulAt) {
      inboxStatus = state.inbox.errorCode ? 'error' : 'never_loaded';
    } else if (state.inbox.errorCode) {
      inboxStatus = 'stale';
    } else if (
      state.inbox.nextAllowedAt &&
      Date.parse(state.inbox.nextAllowedAt) > now()
    ) {
      inboxStatus = 'cooldown';
    } else {
      inboxStatus = 'fresh';
    }
    return {
      accountLogin: auth.accountLogin,
      hasMainToken,
      refreshing,
      scopeStatus,
      inboxStatus,
      state,
    };
  }

  async function deriveStatus(refreshing = inFlight !== null): Promise<WatchStatus> {
    return deriveStatusForAuth(await readAuth(), refreshing);
  }

  async function queryInbox(unreadOnly: boolean): Promise<WatchInboxQueryResponse> {
    const auth = await readAuth();
    const accountLogin = auth.mainToken
      ? auth.accountLogin
      : null;
    const result = await dependencies.store.queryInbox({ accountLogin, unreadOnly });
    const latest = await readAuth();
    if (!sameAuthSnapshot(auth, latest)) {
      return {
        ...projectWatchInbox([], { unreadOnly }),
        status: await deriveStatusForAuth(latest, inFlight !== null),
      };
    }
    return {
      threads: result.threads,
      groups: result.groups,
      unreadCount: result.unreadCount,
      totalCount: result.totalCount,
      status: await deriveStatusForAuth(auth, inFlight !== null, result.state),
    };
  }

  async function performRefresh(auth: AuthSnapshot): Promise<RefreshOutcome> {
    const empty: RefreshOutcome = {
      scopePublished: false,
      inboxPublished: false,
      notModified: false,
    };
    if (!auth.accountLogin || !auth.mainToken || !await sameCredentials(auth)) {
      return empty;
    }
    const refreshStartedAt = now();
    const attemptedAt = new Date(refreshStartedAt).toISOString();
    const previousState = await dependencies.store.getState(auth.accountLogin);
    if (
      previousState?.inbox.nextAllowedAt &&
      Date.parse(previousState.inbox.nextAllowedAt) > refreshStartedAt
    ) return empty;

    let changed = false;
    let scopeAvailable = false;
    let scopeNames = new Set<string>();
    let scopePublished = false;
    try {
      const [remoteScope, liveNames] = await Promise.all([
        dependencies.fetchScope({ token: auth.mainToken, now: () => refreshStartedAt }),
        dependencies.loadLiveRepositoryNames(),
      ]);
      if (!await sameCredentials(auth)) return empty;
      const live = new Set(liveNames.flatMap((name) => {
        const canonical = canonicalRepositoryFullName(name);
        return canonical ? [canonical] : [];
      }));
      const repositories = remoteScope.repositories.filter((repository) => live.has(repository.full_name));
      await dependencies.store.replaceScope({
        accountLogin: auth.accountLogin,
        repositories,
        attemptedAt,
        successfulAt: remoteScope.fetchedAt,
      });
      scopeNames = new Set(repositories.map((repository) => repository.full_name));
      scopeAvailable = true;
      scopePublished = true;
      changed = true;
    } catch (error) {
      if (!await sameCredentials(auth)) return empty;
      await dependencies.store.recordScopeFailure({
        accountLogin: auth.accountLogin,
        attemptedAt,
        errorCode: stableErrorCode(error),
      });
      changed = true;
      const state = await dependencies.store.getState(auth.accountLogin);
      if (state?.scope.lastSuccessfulAt) {
        const repositories = await dependencies.store.getRepositories(auth.accountLogin);
        scopeNames = new Set(repositories.map((repository) => repository.full_name));
        scopeAvailable = true;
      }
    }

    let inboxPublished = false;
    let notModified = false;
    if (auth.mainToken && scopeAvailable && await sameCredentials(auth)) {
      const state = await dependencies.store.getState(auth.accountLogin);
      try {
        const snapshot = await dependencies.fetchNotifications({
          token: auth.mainToken,
          before: refreshStartedAt,
          lastModified: state?.inbox.lastModified ?? null,
          now: () => refreshStartedAt,
        });
        if (!await sameCredentials(auth)) {
          if (changed) dependencies.broadcastChanged();
          return { ...empty, scopePublished };
        }
        const allowedThreads: GitHubNotificationThread[] = snapshot.threads.filter((thread) => (
          scopeNames.has(thread.repositoryFullName)
        ));
        const allowedAt = nextAllowedAt(now(), snapshot.pollIntervalSeconds);
        if (snapshot.notModified) {
          await dependencies.store.revalidateInbox({
            accountLogin: auth.accountLogin,
            attemptedAt,
            successfulAt: snapshot.fetchedAt,
            nextAllowedAt: allowedAt,
            lastModified: snapshot.lastModified,
          });
          notModified = true;
        } else {
          await dependencies.store.replaceInbox({
            accountLogin: auth.accountLogin,
            threads: allowedThreads,
            attemptedAt,
            successfulAt: snapshot.fetchedAt,
            lastModified: snapshot.lastModified,
            nextAllowedAt: allowedAt,
            candidateCount: snapshot.candidateCount,
            truncated: snapshot.truncated,
          });
          inboxPublished = true;
        }
        changed = true;
      } catch (error) {
        if (await sameCredentials(auth)) {
          await dependencies.store.recordInboxFailure({
            accountLogin: auth.accountLogin,
            attemptedAt,
            errorCode: stableErrorCode(error),
          });
          changed = true;
        }
      }
    }
    if (changed) dependencies.broadcastChanged();
    return { scopePublished, inboxPublished, notModified };
  }

  async function refresh(): Promise<WatchRefreshResult> {
    await reconcileAccount();
    const requestedAuth = await readAuth();
    const identity = refreshIdentity(requestedAuth);
    const current = inFlight;
    if (current) {
      if (current.identity === identity) return current.promise;
      try {
        await current.promise;
      } catch {
        // The new credential identity still deserves its own queued attempt.
      }
      if (inFlight === current) inFlight = null;
      return refresh();
    }

    const operation = dependencies.runSerialized(() => performRefresh(requestedAuth));
    const promise = operation.then(async (outcome) => ({
      ...outcome,
      status: await deriveStatus(false),
    }));
    inFlight = { identity, promise };
    void promise.finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    }).catch(() => {});
    return promise;
  }

  async function clearDataCommand(): Promise<WatchStatus> {
    await reconcileAccount();
    await dependencies.runSerialized(async () => {
      await dependencies.store.clearData();
      dependencies.broadcastChanged();
    });
    return deriveStatus(false);
  }

  async function reconcileAccount(): Promise<void> {
    await dependencies.runSerialized(async () => {
      const auth = await readAuth();
      const dataCleared = await dependencies.store.reconcileAccount(auth.accountLogin);
      const scopePruned = !dataCleared && auth.accountLogin
        ? await dependencies.store.reconcileLiveStars(auth.accountLogin)
        : false;
      if (dataCleared || scopePruned) dependencies.broadcastChanged();
    });
  }

  return {
    async getStatus() {
      await reconcileAccount();
      return deriveStatus();
    },
    async queryInbox(unreadOnly) {
      await reconcileAccount();
      return queryInbox(unreadOnly);
    },
    refresh,
    clearData: clearDataCommand,
    reconcileAccount,
    isRefreshing: () => inFlight !== null,
  };
}
