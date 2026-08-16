import type { GitHubCredentialSnapshot, authStore } from '@/auth/auth-store';
import {
  WATCH_DEFAULT_POLL_INTERVAL_SECONDS,
  WATCH_MAX_POLL_INTERVAL_SECONDS,
  type fetchGitHubNotifications,
  type mutateGitHubNotificationThread,
} from '@/api/github-notifications-source';
import type { fetchGitHubWatchScope } from '@/api/github-watch-scope-source';
import type { fetchGitHubWatchSubjectDetail } from '@/api/github-watch-subject-source';
import type {
  clearWatchData,
  applyWatchThreadMutation,
  disconnectWatchInbox,
  getWatchNotificationThread,
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
  watchSubjectIdentity,
  type WatchSubjectDetail,
  type WatchSubjectIdentity,
} from '@/watch/watch-model';
import {
  parseWatchAccountLogin,
  parseWatchThreadIds,
  type WatchInboxQueryResponse,
  type WatchRefreshResult,
  type WatchStatus,
  type WatchThreadAction,
  type WatchThreadMutationInput,
  type WatchThreadMutationResult,
} from '@/watch/watch-contract';

type WatchAuth = Pick<typeof authStore,
  | 'getGitHubCredentialSnapshot'
  | 'clearWatchNotificationsToken'
>;

export interface WatchRefreshCoordinatorDependencies {
  runSerialized<T>(operation: () => Promise<T>): Promise<T>;
  auth: WatchAuth;
  fetchScope: typeof fetchGitHubWatchScope;
  fetchNotifications: typeof fetchGitHubNotifications;
  mutateNotification: typeof mutateGitHubNotificationThread;
  fetchSubjectDetail: typeof fetchGitHubWatchSubjectDetail;
  loadLiveRepositoryNames(): Promise<string[]>;
  store: {
    getState: typeof getWatchState;
    getRepositories: typeof getWatchRepositories;
    queryInbox: typeof queryStoredWatchInbox;
    reconcileAccount: typeof reconcileWatchAccount;
    getNotificationThread: typeof getWatchNotificationThread;
    reconcileLiveStars: typeof reconcileWatchLiveStars;
    replaceScope: typeof replaceWatchScope;
    recordScopeFailure: typeof recordWatchScopeFailure;
    replaceInbox: typeof replaceWatchInbox;
    revalidateInbox: typeof revalidateWatchInbox;
    recordInboxFailure: typeof recordWatchInboxFailure;
    applyThreadMutation: typeof applyWatchThreadMutation;
    disconnectInbox: typeof disconnectWatchInbox;
    clearData: typeof clearWatchData;
  };
  now?: () => number;
  broadcastChanged(): void;
}

export interface WatchRefreshCoordinator {
  getStatus(): Promise<WatchStatus>;
  queryInbox(unreadOnly: boolean): Promise<WatchInboxQueryResponse>;
  refresh(): Promise<WatchRefreshResult>;
  getSubjectDetail(threadId: string): Promise<WatchSubjectDetail>;
  refreshInbox(): Promise<WatchRefreshResult>;
  markThreadsRead(input: WatchThreadMutationInput): Promise<WatchThreadMutationResult>;
  markThreadsDone(input: WatchThreadMutationInput): Promise<WatchThreadMutationResult>;
  disconnectInbox(): Promise<WatchStatus>;
  clearData(): Promise<WatchStatus>;
  reconcileAccount(options?: {
    invalidateNotificationsIdentity?: string | null;
  }): Promise<void>;
  isRefreshing(): boolean;
}

type AuthSnapshot = GitHubCredentialSnapshot;

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

const THREAD_MUTATION_CONCURRENCY = 4;
const SUBJECT_DETAIL_CACHE_LIMIT = 100;

function sameSubjectIdentity(
  left: WatchSubjectIdentity,
  right: WatchSubjectIdentity,
): boolean {
  return left.kind === right.kind &&
    left.repositoryFullName === right.repositoryFullName &&
    left.number === right.number &&
    left.apiUrl === right.apiUrl &&
    left.htmlUrl === right.htmlUrl;
}

export function createWatchRefreshCoordinator(
  dependencies: WatchRefreshCoordinatorDependencies,
): WatchRefreshCoordinator {
  const now = dependencies.now ?? Date.now;
  let inFlight: { identity: string; promise: Promise<WatchRefreshResult> } | null = null;
  let inboxInFlight: { identity: string; promise: Promise<WatchRefreshResult> } | null = null;
  const subjectDetails = new Map<string, WatchSubjectDetail>();
  const subjectDetailInFlight = new Map<string, Promise<WatchSubjectDetail>>();
  let subjectAuthority = '';
  let subjectGeneration = 0;

  async function readAuth(): Promise<AuthSnapshot> {
    return dependencies.auth.getGitHubCredentialSnapshot();
  }

  async function sameCredentials(
    snapshot: AuthSnapshot,
    includeNotifications: boolean,
  ): Promise<boolean> {
    const latest = await readAuth();
    return latest.accountLogin === snapshot.accountLogin &&
      latest.mainToken !== null &&
      latest.mainIdentity === snapshot.mainIdentity &&
      (!includeNotifications || (
        latest.notificationsToken === snapshot.notificationsToken &&
        latest.notificationsIdentity === snapshot.notificationsIdentity
      ));
  }

  async function loadLiveNames(): Promise<Set<string>> {
    return new Set((await dependencies.loadLiveRepositoryNames()).flatMap((name) => {
      const canonical = canonicalRepositoryFullName(name);
      return canonical ? [canonical] : [];
    }));
  }

  function refreshIdentity(auth: AuthSnapshot): string {
    return JSON.stringify([
      auth.accountLogin,
      auth.mainIdentity,
      auth.notificationsIdentity,
      auth.mainToken !== null,
      auth.notificationsToken !== null,
    ]);
  }

  function subjectAuthorityFor(auth: AuthSnapshot): string {
    return JSON.stringify([auth.accountLogin, auth.mainIdentity, auth.mainToken !== null]);
  }

  function synchronizeSubjectAuthority(auth: AuthSnapshot): number {
    const nextAuthority = subjectAuthorityFor(auth);
    if (subjectAuthority !== nextAuthority) {
      subjectAuthority = nextAuthority;
      subjectGeneration++;
      subjectDetails.clear();
      subjectDetailInFlight.clear();
    }
    return subjectGeneration;
  }

  function subjectCacheKey(auth: AuthSnapshot, identity: WatchSubjectIdentity): string {
    return JSON.stringify([
      auth.mainIdentity,
      identity.repositoryFullName,
      identity.kind,
      identity.number,
    ]);
  }

  function readSubjectCache(key: string): WatchSubjectDetail | null {
    const cached = subjectDetails.get(key);
    if (!cached) return null;
    subjectDetails.delete(key);
    subjectDetails.set(key, cached);
    return cached;
  }

  function writeSubjectCache(key: string, detail: WatchSubjectDetail): void {
    subjectDetails.delete(key);
    subjectDetails.set(key, detail);
    while (subjectDetails.size > SUBJECT_DETAIL_CACHE_LIMIT) {
      const oldest = subjectDetails.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      subjectDetails.delete(oldest);
    }
  }

  async function getSubjectDetail(threadId: string): Promise<WatchSubjectDetail> {
    const auth = await readAuth();
    const generation = synchronizeSubjectAuthority(auth);
    if (!auth.accountLogin || !auth.mainToken) {
      throw new GitHubWatchError('authentication_required');
    }
    const thread = await dependencies.store.getNotificationThread({
      accountLogin: auth.accountLogin,
      threadId,
    });
    const identity = thread ? watchSubjectIdentity(thread) : null;
    if (!identity) throw new GitHubWatchError('subject_not_found');

    const key = subjectCacheKey(auth, identity);
    const cached = readSubjectCache(key);
    if (cached) return cached;
    const active = subjectDetailInFlight.get(key);
    if (active) return active;

    const promise = (async () => {
      const detail = await dependencies.fetchSubjectDetail({
        token: auth.mainToken!,
        identity,
      });
      const latestAuth = await readAuth();
      if (
        synchronizeSubjectAuthority(latestAuth) !== generation ||
        latestAuth.accountLogin !== auth.accountLogin ||
        latestAuth.mainIdentity !== auth.mainIdentity ||
        latestAuth.mainToken === null
      ) throw new GitHubWatchError('credential_changed');
      const latestThread = await dependencies.store.getNotificationThread({
        accountLogin: auth.accountLogin,
        threadId,
      });
      const latestIdentity = latestThread ? watchSubjectIdentity(latestThread) : null;
      if (!latestIdentity || !sameSubjectIdentity(identity, latestIdentity)) {
        throw new GitHubWatchError('credential_changed');
      }
      if (generation !== subjectGeneration) throw new GitHubWatchError('credential_changed');
      writeSubjectCache(key, detail);
      return detail;
    })();
    subjectDetailInFlight.set(key, promise);
    void promise.finally(() => {
      if (subjectDetailInFlight.get(key) === promise) subjectDetailInFlight.delete(key);
    }).catch(() => {});
    return promise;
  }


  async function deriveStatusForAuth(
    auth: AuthSnapshot,
    refreshing: boolean,
    stateOverride?: WatchStatus['state'],
  ): Promise<WatchStatus> {
    const hasMainToken = !!(auth.accountLogin && auth.mainToken);
    const hasNotificationsToken = !!auth.notificationsToken;
    const state = stateOverride === undefined && hasMainToken && auth.accountLogin
      ? await dependencies.store.getState(auth.accountLogin)
      : stateOverride ?? null;
    const scopeStatus: WatchStatus['scopeStatus'] = !hasMainToken
      ? 'not_configured'
      : !state?.scope.lastSuccessfulAt
        ? state?.scope.errorCode ? 'error' : 'never_loaded'
        : state.scope.errorCode ? 'stale' : 'fresh';
    let inboxStatus: WatchStatus['inboxStatus'];
    if (!hasNotificationsToken) {
      inboxStatus = 'not_configured';
    } else if (!state?.inbox.lastSuccessfulAt) {
      inboxStatus = state?.inbox.errorCode ? 'error' : 'never_loaded';
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
      hasNotificationsToken,
      refreshing,
      scopeStatus,
      inboxStatus,
      state,
    };
  }

  async function deriveStatus(refreshing = inFlight !== null || inboxInFlight !== null): Promise<WatchStatus> {
    return deriveStatusForAuth(await readAuth(), refreshing);
  }

  async function queryInbox(unreadOnly: boolean): Promise<WatchInboxQueryResponse> {
    const auth = await readAuth();
    const accountLogin = auth.mainToken
      ? auth.accountLogin
      : null;
    const result = await dependencies.store.queryInbox({ accountLogin, unreadOnly });
    const latest = await readAuth();
    if (refreshIdentity(auth) !== refreshIdentity(latest)) {
      return {
        ...projectWatchInbox([], { unreadOnly }),
        status: await deriveStatusForAuth(
          latest,
          inFlight !== null || inboxInFlight !== null,
        ),
      };
    }
    return {
      threads: result.threads,
      groups: result.groups,
      unreadCount: result.unreadCount,
      totalCount: result.totalCount,
      status: await deriveStatusForAuth(
        auth,
        inFlight !== null || inboxInFlight !== null,
        result.state,
      ),
    };
  }

  function emptyOutcome(): RefreshOutcome {
    return {
      scopePublished: false,
      inboxPublished: false,
      notModified: false,
    };
  }

  async function publishInbox(
    auth: AuthSnapshot,
    refreshStartedAt: number,
    attemptedAt: string,
  ): Promise<{
    inboxPublished: boolean;
    notModified: boolean;
    changed: boolean;
    credentialsChanged: boolean;
  }> {
    const state = await dependencies.store.getState(auth.accountLogin!);
    try {
      if (!auth.notificationsToken) throw new GitHubWatchError('authentication_required');
      const snapshot = await dependencies.fetchNotifications({
        token: auth.notificationsToken,
        before: refreshStartedAt,
        lastModified: state?.inbox.lastModified ?? null,
        now: () => refreshStartedAt,
      });
      if (!await sameCredentials(auth, true)) {
        return {
          inboxPublished: false,
          notModified: false,
          changed: false,
          credentialsChanged: true,
        };
      }
      const allowedAt = nextAllowedAt(now(), snapshot.pollIntervalSeconds);
      if (snapshot.notModified) {
        await dependencies.store.revalidateInbox({
          accountLogin: auth.accountLogin!,
          attemptedAt,
          successfulAt: snapshot.fetchedAt,
          nextAllowedAt: allowedAt,
          lastModified: snapshot.lastModified,
          requireLiveStars: true,
        });
        return {
          inboxPublished: false,
          notModified: true,
          changed: true,
          credentialsChanged: false,
        };
      }
      await dependencies.store.replaceInbox({
        accountLogin: auth.accountLogin!,
        threads: snapshot.threads,
        attemptedAt,
        successfulAt: snapshot.fetchedAt,
        lastModified: snapshot.lastModified,
        nextAllowedAt: allowedAt,
        candidateCount: snapshot.candidateCount,
        truncated: snapshot.truncated,
        mode: state?.inbox.lastModified ? 'merge' : 'replace',
        requireLiveStars: true,
      });
      return {
        inboxPublished: true,
        notModified: false,
        changed: true,
        credentialsChanged: false,
      };
    } catch (error) {
      if (!await sameCredentials(auth, true)) {
        return {
          inboxPublished: false,
          notModified: false,
          changed: false,
          credentialsChanged: true,
        };
      }
      await dependencies.store.recordInboxFailure({
        accountLogin: auth.accountLogin!,
        attemptedAt,
        errorCode: stableErrorCode(error),
      });
      return {
        inboxPublished: false,
        notModified: false,
        changed: true,
        credentialsChanged: false,
      };
    }
  }

  async function performRefresh(auth: AuthSnapshot): Promise<RefreshOutcome> {
    const empty = emptyOutcome();
    if (!auth.accountLogin || !auth.mainToken || !await sameCredentials(auth, false)) {
      return empty;
    }
    const refreshStartedAt = now();
    const attemptedAt = new Date(refreshStartedAt).toISOString();

    let changed = false;
    if (!await sameCredentials(auth, false)) return empty;
    let scopePublished = false;
    try {
      const remoteScope = await dependencies.fetchScope({
        token: auth.mainToken,
        now: () => refreshStartedAt,
      });
      if (!await sameCredentials(auth, false)) return empty;
      const currentLiveNames = await loadLiveNames();
      if (!await sameCredentials(auth, false)) return empty;
      const repositories = remoteScope.repositories.filter((repository) => (
        currentLiveNames.has(repository.full_name)
      ));
      await dependencies.store.replaceScope({
        accountLogin: auth.accountLogin,
        repositories,
        attemptedAt,
        successfulAt: remoteScope.fetchedAt,
      });
      scopePublished = true;
      changed = true;
    } catch (error) {
      if (!await sameCredentials(auth, false)) return empty;
      await dependencies.store.recordScopeFailure({
        accountLogin: auth.accountLogin,
        attemptedAt,
        errorCode: stableErrorCode(error),
      });
      changed = true;
    }

    let inboxPublished = false;
    let notModified = false;
    if (
      auth.notificationsToken &&
      await sameCredentials(auth, true)
    ) {
      const state = await dependencies.store.getState(auth.accountLogin);
      const inboxCoolingDown = !!(
        state?.inbox.nextAllowedAt &&
        Date.parse(state.inbox.nextAllowedAt) > refreshStartedAt
      );
      if (!inboxCoolingDown) {
        const inbox = await publishInbox(auth, refreshStartedAt, attemptedAt);
        if (inbox.credentialsChanged) {
          if (changed) dependencies.broadcastChanged();
          return { ...empty, scopePublished };
        }
        inboxPublished = inbox.inboxPublished;
        notModified = inbox.notModified;
        changed ||= inbox.changed;
      }
    }
    if (changed) dependencies.broadcastChanged();
    return { scopePublished, inboxPublished, notModified };
  }

  async function performInboxRefresh(auth: AuthSnapshot): Promise<RefreshOutcome> {
    const empty = emptyOutcome();
    if (
      !auth.accountLogin ||
      !auth.mainToken ||
      !auth.notificationsToken ||
      !await sameCredentials(auth, true)
    ) return empty;

    const refreshStartedAt = now();
    const attemptedAt = new Date(refreshStartedAt).toISOString();
    const state = await dependencies.store.getState(auth.accountLogin);
    if (
      state?.inbox.nextAllowedAt &&
      Date.parse(state.inbox.nextAllowedAt) > refreshStartedAt
    ) return empty;
    const inbox = await publishInbox(auth, refreshStartedAt, attemptedAt);
    if (inbox.changed) dependencies.broadcastChanged();
    return {
      scopePublished: false,
      inboxPublished: inbox.inboxPublished,
      notModified: inbox.notModified,
    };
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

  async function refreshInbox(): Promise<WatchRefreshResult> {
    const activeBeforeReconcile = inFlight ?? inboxInFlight;
    if (activeBeforeReconcile) return activeBeforeReconcile.promise;

    await reconcileAccount();
    const requestedAuth = await readAuth();
    const activeAfterReconcile = inFlight ?? inboxInFlight;
    if (activeAfterReconcile) return activeAfterReconcile.promise;

    const identity = refreshIdentity(requestedAuth);
    const operation = dependencies.runSerialized(() => performInboxRefresh(requestedAuth));
    const promise = operation.then(async (outcome) => ({
      ...outcome,
      status: await deriveStatus(false),
    }));
    inboxInFlight = { identity, promise };
    void promise.finally(() => {
      if (inboxInFlight?.promise === promise) inboxInFlight = null;
    }).catch(() => {});
    return promise;
  }

  async function performThreadMutation(
    auth: AuthSnapshot,
    action: WatchThreadAction,
    input: WatchThreadMutationInput,
  ): Promise<WatchThreadMutationResult> {
    const accountLogin = parseWatchAccountLogin(input.accountLogin);
    const threadIds = parseWatchThreadIds(input.threadIds);
    if (!threadIds) throw new GitHubWatchError('invalid_thread');
    if (
      !accountLogin ||
      auth.accountLogin !== accountLogin ||
      !auth.mainToken ||
      !auth.notificationsToken ||
      !await sameCredentials(auth, true)
    ) throw new GitHubWatchError('authentication_required');

    const stored = await dependencies.store.queryInbox({
      accountLogin: auth.accountLogin,
      unreadOnly: false,
    });
    const byId = new Map(stored.threads.map((thread) => [thread.id, thread]));
    const targets = threadIds.filter((id) => {
      const thread = byId.get(id);
      return thread !== undefined && (action === 'done' || thread.unread);
    });
    if (targets.length === 0) {
      return { action, requestedCount: threadIds.length, changedCount: 0 };
    }

    // A repository action can cover a thousand-plus threads. One transient
    // failure (rate limit, stale thread) must not abort the rest of the batch;
    // succeeded threads are applied and the remainder converges on retry.
    let cursor = 0;
    let firstFailure: unknown = null;
    const succeeded: string[] = [];
    const workers = Array.from(
      { length: Math.min(THREAD_MUTATION_CONCURRENCY, targets.length) },
      async () => {
        for (;;) {
          const index = cursor++;
          const threadId = targets[index];
          if (threadId === undefined) return;
          try {
            await dependencies.mutateNotification({
              token: auth.notificationsToken!,
              threadId,
              action,
            });
            succeeded.push(threadId);
          } catch (error) {
            if (firstFailure === null) firstFailure = error;
          }
        }
      },
    );
    await Promise.all(workers);

    if (!await sameCredentials(auth, true)) {
      throw new GitHubWatchError('authentication_required');
    }
    const changedCount = succeeded.length > 0
      ? await dependencies.store.applyThreadMutation({
        accountLogin: auth.accountLogin,
        threadIds: succeeded,
        action,
      })
      : 0;
    if (changedCount > 0) dependencies.broadcastChanged();
    if (succeeded.length === 0 && firstFailure !== null) throw firstFailure;
    return { action, requestedCount: threadIds.length, changedCount };
  }

  async function mutateThreads(
    action: WatchThreadAction,
    input: WatchThreadMutationInput,
  ): Promise<WatchThreadMutationResult> {
    await reconcileAccount();
    const auth = await readAuth();
    return dependencies.runSerialized(() => performThreadMutation(auth, action, input));
  }

  async function disconnectInboxCommand(): Promise<WatchStatus> {
    await reconcileAccount();
    await dependencies.runSerialized(async () => {
      const auth = await readAuth();
      await dependencies.auth.clearWatchNotificationsToken();
      await dependencies.store.disconnectInbox(auth.accountLogin);
      dependencies.broadcastChanged();
    });
    return deriveStatus(false);
  }

  async function clearDataCommand(): Promise<WatchStatus> {
    await reconcileAccount();
    await dependencies.runSerialized(async () => {
      await dependencies.auth.clearWatchNotificationsToken();
      await dependencies.store.clearData();
      dependencies.broadcastChanged();
    });
    return deriveStatus(false);
  }

  async function reconcileAccount(options: {
    invalidateNotificationsIdentity?: string | null;
  } = {}): Promise<void> {
    await dependencies.runSerialized(async () => {
      const auth = await readAuth();
      const dataCleared = await dependencies.store.reconcileAccount(auth.accountLogin);
      const scopePruned = !dataCleared && auth.accountLogin
        ? await dependencies.store.reconcileLiveStars(auth.accountLogin)
        : false;
      const shouldClearNotifications = !auth.accountLogin || (
        !!options.invalidateNotificationsIdentity &&
        auth.notificationsIdentity === options.invalidateNotificationsIdentity
      );
      let credentialsCleared = false;
      if (shouldClearNotifications) {
        const latest = await readAuth();
        if (
          !latest.accountLogin ||
          latest.notificationsIdentity === options.invalidateNotificationsIdentity
        ) {
          await dependencies.auth.clearWatchNotificationsToken();
          credentialsCleared = true;
        }
      }
      if (dataCleared || scopePruned || credentialsCleared) dependencies.broadcastChanged();
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
    getSubjectDetail,
    refresh,
    refreshInbox,
    markThreadsRead: (input) => mutateThreads('read', input),
    markThreadsDone: (input) => mutateThreads('done', input),
    disconnectInbox: disconnectInboxCommand,
    clearData: clearDataCommand,
    reconcileAccount,
    isRefreshing: () => inFlight !== null || inboxInFlight !== null,
  };
}
