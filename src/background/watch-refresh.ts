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
  commitWatchInboxScanBatch,
  disconnectWatchInbox,
  getWatchNotificationThread,
  getWatchRepositories,
  getWatchState,
  markWatchInboxLoaded,
  queryStoredWatchInbox,
  reconcileWatchAccount,
  reconcileWatchLiveStars,
  recordWatchInboxFailure,
  recordWatchHistoryFailure,
  recordWatchScopeFailure,
  replaceWatchScope,
  revalidateWatchInbox,
  startWatchInboxScan,
  mergeWatchInboxDelta,
} from '@/storage/watch-store';
import {
  GitHubWatchError,
  canonicalRepositoryFullName,
  isValidWatchHistoryPage,
  projectWatchInbox,
  watchSubjectIdentity,
  type WatchSubjectDetail,
  type WatchSubjectIdentity,
} from '@/watch/watch-model';
import {
  parseWatchAccountLogin,
  parseWatchThreadIds,
  type WatchInboxQueryResponse,
  type WatchLoadOlderResult,
  type WatchRefreshPhase,
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
    startInboxScan: typeof startWatchInboxScan;
    commitInboxScanBatch: typeof commitWatchInboxScanBatch;
    mergeInboxDelta: typeof mergeWatchInboxDelta;
    markLoaded: typeof markWatchInboxLoaded;
    revalidateInbox: typeof revalidateWatchInbox;
    recordInboxFailure: typeof recordWatchInboxFailure;
    recordHistoryFailure: typeof recordWatchHistoryFailure;
    applyThreadMutation: typeof applyWatchThreadMutation;
    disconnectInbox: typeof disconnectWatchInbox;
    clearData: typeof clearWatchData;
  };
  now?: () => number;
  broadcastChanged(): void;
  broadcastStatusChanged(): void;
}

export interface WatchRefreshCoordinator {
  getStatus(): Promise<WatchStatus>;
  /** Read durable progress without entering the serialized mutation queue. */
  snapshotStatus(): Promise<WatchStatus>;
  queryInbox(unreadOnly: boolean): Promise<WatchInboxQueryResponse>;
  refresh(): Promise<WatchRefreshResult>;
  getSubjectDetail(threadId: string): Promise<WatchSubjectDetail>;
  loadOlder(): Promise<WatchLoadOlderResult>;
  markLoaded(): Promise<string | null>;
  refreshScope(): Promise<WatchRefreshResult>;
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
type SnapshotStabilityBudget = { restarts: number };
type ActiveWatchRefreshPhase = Exclude<WatchRefreshPhase, null>;
type WatchRefreshFlight = {
  identity: string;
  promise: Promise<WatchRefreshResult>;
};
type WatchRefreshExecution = {
  identity: string;
  phase: ActiveWatchRefreshPhase;
};

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
const INBOX_SCAN_BATCH_PAGES = 10;
const MANUAL_SNAPSHOT_RESTART_LIMIT = 3;

function validSnapshotValidator(value: string | null | undefined): value is string {
  const validator = value?.trim();
  return !!validator && Number.isFinite(Date.parse(validator));
}

function laterSnapshotBoundary(previous: string, timestampMs: number): string {
  return new Date(Math.max(timestampMs, Date.parse(previous) + 1)).toISOString();
}

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
  let inFlight: WatchRefreshFlight | null = null;
  let inboxInFlight: WatchRefreshFlight | null = null;
  let scopeInFlight: WatchRefreshFlight | null = null;
  let activeRefreshExecution: WatchRefreshExecution | null = null;
  let historyInFlight: { identity: string; promise: Promise<WatchLoadOlderResult> } | null = null;
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

  function activeRefreshPhase(auth: AuthSnapshot): WatchRefreshPhase {
    return activeRefreshExecution?.identity === refreshIdentity(auth)
      ? activeRefreshExecution.phase
      : null;
  }

  function setExecutingRefreshPhase(auth: AuthSnapshot, phase: ActiveWatchRefreshPhase): void {
    const identity = refreshIdentity(auth);
    if (
      !activeRefreshExecution
      || activeRefreshExecution.identity !== identity
      || activeRefreshExecution.phase === phase
    ) return;
    activeRefreshExecution.phase = phase;
    dependencies.broadcastStatusChanged();
  }

  function runRefreshOperation<T>(
    auth: AuthSnapshot,
    phase: ActiveWatchRefreshPhase,
    operation: () => Promise<T>,
  ): Promise<T> {
    const execution: WatchRefreshExecution = {
      identity: refreshIdentity(auth),
      phase,
    };
    return dependencies.runSerialized(async () => {
      activeRefreshExecution = execution;
      dependencies.broadcastStatusChanged();
      try {
        return await operation();
      } finally {
        if (activeRefreshExecution === execution) {
          activeRefreshExecution = null;
          dependencies.broadcastStatusChanged();
        }
      }
    });
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
    const refreshPhase = refreshing ? activeRefreshPhase(auth) : null;
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
      state.inbox.scanStatus === 'complete' &&
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
      refreshPhase,
      scopeStatus,
      inboxStatus,
      state,
    };
  }

  async function deriveStatus(
    refreshing = inFlight !== null || inboxInFlight !== null || scopeInFlight !== null,
  ): Promise<WatchStatus> {
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
          inFlight !== null || inboxInFlight !== null || scopeInFlight !== null,
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
        inFlight !== null || inboxInFlight !== null || scopeInFlight !== null,
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

  type InboxBatchOutcome = {
    inboxPublished: boolean;
    notModified: boolean;
    changed: boolean;
    credentialsChanged: boolean;
    failure: unknown | null;
  };

  async function performInboxBatch(
    auth: AuthSnapshot,
    trigger: 'manual' | 'scheduled',
    stabilityBudget: SnapshotStabilityBudget | null = null,
  ): Promise<InboxBatchOutcome> {
    const unchanged = (): InboxBatchOutcome => ({
      inboxPublished: false,
      notModified: false,
      changed: false,
      credentialsChanged: false,
      failure: null,
    });
    if (!auth.accountLogin || !auth.notificationsToken) return unchanged();

    const startedAtMs = now();
    const attemptedAt = new Date(startedAtMs).toISOString();
    let state = await dependencies.store.getState(auth.accountLogin);
    const hasContinuation = !!state
      && (state.inbox.scanStatus === 'scanning' || state.inbox.scanStatus === 'partial')
      && !!state.inbox.scanId
      && !!state.inbox.scanStartedAt
      && !!state.inbox.historyBefore
      && state.inbox.historyNextPage !== null
      && isValidWatchHistoryPage(state.inbox.historyNextPage);
    const conditionalValidator = trigger === 'scheduled'
      && state?.inbox.scanStatus === 'complete'
      && validSnapshotValidator(state.inbox.lastModified)
      ? state.inbox.lastModified.trim()
      : null;
    const conditionalHead = conditionalValidator !== null;
    const scanId = hasContinuation
      ? state!.inbox.scanId!
      : `watch-inbox:${crypto.randomUUID()}`;
    const before = hasContinuation
      ? state!.inbox.historyBefore!
      : attemptedAt;
    const expectedPage = hasContinuation
      ? state!.inbox.historyNextPage!
      : 1;
    const scanStartedAt = hasContinuation
      ? state!.inbox.scanStartedAt!
      : attemptedAt;

    try {
      if (!await sameCredentials(auth, true)) {
        return { ...unchanged(), credentialsChanged: true };
      }
      // Manual, pending, and restarted scans persist the frozen first cursor
      // before network work. A conditional converged poll stays complete until
      // GitHub returns 200, so only that state can accept a 304.
      if (!hasContinuation && !conditionalHead) {
        state = await dependencies.store.startInboxScan({
          accountLogin: auth.accountLogin,
          scanId,
          scanStartedAt,
          before,
          attemptedAt,
          lastModified: null,
        });
      }
      const snapshot = await dependencies.fetchNotifications({
        token: auth.notificationsToken,
        before,
        startPage: expectedPage,
        maxPages: conditionalHead ? 1 : INBOX_SCAN_BATCH_PAGES,
        lastModified: conditionalValidator,
        now: () => startedAtMs,
      });
      if (!await sameCredentials(auth, true)) {
        return { ...unchanged(), credentialsChanged: true };
      }
      const allowedAt = nextAllowedAt(now(), snapshot.pollIntervalSeconds);
      if (snapshot.notModified) {
        if (!conditionalHead || state?.inbox.scanStatus !== 'complete') {
          throw new GitHubWatchError('invalid_response');
        }
        await dependencies.store.revalidateInbox({
          accountLogin: auth.accountLogin,
          attemptedAt,
          successfulAt: snapshot.fetchedAt,
          nextAllowedAt: allowedAt,
          lastModified: snapshot.lastModified,
        });
        return {
          inboxPublished: false,
          notModified: true,
          changed: true,
          credentialsChanged: false,
          failure: null,
        };
      }
      if (snapshot.before !== before) {
        throw new GitHubWatchError('invalid_pagination', undefined, { page: expectedPage });
      }
      if (!hasContinuation && conditionalValidator !== null) {
        if (!validSnapshotValidator(snapshot.lastModified)) {
          throw new GitHubWatchError('snapshot_unstable');
        }
        if (snapshot.pageCount !== 1 || snapshot.nextPage !== null) {
          await dependencies.store.startInboxScan({
            accountLogin: auth.accountLogin,
            scanId,
            scanStartedAt,
            before,
            attemptedAt,
            lastModified: null,
          });
          return {
            inboxPublished: false,
            notModified: false,
            changed: true,
            credentialsChanged: false,
            failure: null,
          };
        }
        const merged = await dependencies.store.mergeInboxDelta({
          accountLogin: auth.accountLogin,
          expectedLastModified: conditionalValidator,
          threads: snapshot.threads,
          attemptedAt,
          successfulAt: snapshot.fetchedAt,
          lastModified: snapshot.lastModified.trim(),
          nextAllowedAt: allowedAt,
        });
        if (!merged.applied) {
          return { ...unchanged(), credentialsChanged: true };
        }
        return {
          inboxPublished: snapshot.threads.length > 0,
          notModified: false,
          changed: true,
          credentialsChanged: false,
          failure: null,
        };
      }
      let commitSuccessfulAt = snapshot.fetchedAt;
      let commitPollIntervalSeconds = snapshot.pollIntervalSeconds;
      let commitCooldownStartedAtMs = now();
      let commitLastModified: string | null | undefined = expectedPage === 1
        ? snapshot.lastModified
        : undefined;
      // Numeric pages can reorder while a frozen traversal is running. Never
      // expose a terminal batch to the sweeping store commit until page 1 says
      // this exact boundary and validator remained unchanged.
      if (snapshot.nextPage === null) {
        const validatorCandidate = expectedPage === 1
          ? snapshot.lastModified
          : state?.inbox.lastModified;
        if (!validSnapshotValidator(validatorCandidate)) {
          throw new GitHubWatchError('snapshot_unstable');
        }
        const validator = validatorCandidate.trim();
        if (!await sameCredentials(auth, true)) {
          return { ...unchanged(), credentialsChanged: true };
        }
        const validationStartedAtMs = now();
        const validation = await dependencies.fetchNotifications({
          token: auth.notificationsToken,
          before,
          startPage: 1,
          maxPages: 1,
          lastModified: validator,
          now: () => validationStartedAtMs,
        });
        if (!await sameCredentials(auth, true)) {
          return { ...unchanged(), credentialsChanged: true };
        }
        if (validation.before !== before) {
          throw new GitHubWatchError('invalid_pagination', undefined, { page: 1 });
        }
        const current = await dependencies.store.getState(auth.accountLogin);
        if (
          current?.inbox.scanId !== scanId
          || (current.inbox.scanStatus !== 'scanning' && current.inbox.scanStatus !== 'partial')
          || current.inbox.historyBefore !== before
          || current.inbox.historyNextPage !== expectedPage
        ) {
          return { ...unchanged(), credentialsChanged: true };
        }
        if (!validation.notModified) {
          if (
            trigger === 'manual'
            && stabilityBudget
            && stabilityBudget.restarts >= MANUAL_SNAPSHOT_RESTART_LIMIT
          ) {
            throw new GitHubWatchError('snapshot_unstable');
          }
          const validationAtMs = Date.parse(validation.fetchedAt);
          const restartedAt = laterSnapshotBoundary(
            before,
            Number.isFinite(validationAtMs) ? Math.max(now(), validationAtMs) : now(),
          );
          await dependencies.store.startInboxScan({
            accountLogin: auth.accountLogin,
            scanId: `watch-inbox:${crypto.randomUUID()}`,
            scanStartedAt: restartedAt,
            before: restartedAt,
            attemptedAt: restartedAt,
            lastModified: null,
          });
          if (trigger === 'manual' && stabilityBudget) stabilityBudget.restarts++;
          return {
            inboxPublished: false,
            notModified: false,
            changed: true,
            credentialsChanged: false,
            failure: null,
          };
        }
        if (validation.lastModified !== validator) {
          throw new GitHubWatchError('snapshot_unstable');
        }
        const validatedAtMs = Date.parse(validation.fetchedAt);
        commitCooldownStartedAtMs = Number.isFinite(validatedAtMs)
          ? validatedAtMs
          : validationStartedAtMs;
        commitSuccessfulAt = validation.fetchedAt;
        commitPollIntervalSeconds = validation.pollIntervalSeconds;
        commitLastModified = validator;
      }
      const committed = await dependencies.store.commitInboxScanBatch({
        accountLogin: auth.accountLogin,
        scanId,
        before,
        expectedPage,
        pageCount: snapshot.pageCount,
        threads: snapshot.threads,
        nextPage: snapshot.nextPage,
        attemptedAt,
        successfulAt: commitSuccessfulAt,
        lastModified: commitLastModified,
        nextAllowedAt: snapshot.nextPage === null || expectedPage === 1
          ? nextAllowedAt(commitCooldownStartedAtMs, commitPollIntervalSeconds)
          : undefined,
      });
      if (!committed.applied) {
        return { ...unchanged(), credentialsChanged: true };
      }
      return {
        inboxPublished: true,
        notModified: false,
        changed: true,
        credentialsChanged: false,
        failure: null,
      };
    } catch (error) {
      if (!await sameCredentials(auth, true)) {
        return { ...unchanged(), credentialsChanged: true };
      }
      await dependencies.store.recordInboxFailure({
        accountLogin: auth.accountLogin,
        attemptedAt,
        errorCode: stableErrorCode(error),
      });
      return {
        inboxPublished: false,
        notModified: false,
        changed: true,
        credentialsChanged: false,
        failure: error,
      };
    }
  }

  async function performLoadOlder(auth: AuthSnapshot): Promise<{
    addedCount: number;
    hasMore: boolean;
  }> {
    if (
      !auth.accountLogin
      || !auth.mainToken
      || !auth.notificationsToken
      || !await sameCredentials(auth, true)
    ) throw new GitHubWatchError('authentication_required');
    const before = await dependencies.store.queryInbox({
      accountLogin: auth.accountLogin,
      unreadOnly: false,
    });
    if (before.state?.inbox.scanStatus === 'complete') {
      return { addedCount: 0, hasMore: false };
    }
    const batch = await performInboxBatch(auth, 'scheduled');
    if (batch.failure) throw batch.failure;
    if (batch.changed) dependencies.broadcastChanged();
    const after = await dependencies.store.queryInbox({
      accountLogin: auth.accountLogin,
      unreadOnly: false,
    });
    return {
      addedCount: Math.max(0, after.totalCount - before.totalCount),
      hasMore: after.state?.inbox.scanStatus !== 'complete',
    };
  }

  async function performScopeRefresh(auth: AuthSnapshot): Promise<{
    scopePublished: boolean;
    changed: boolean;
  }> {
    if (!auth.accountLogin || !auth.mainToken || !await sameCredentials(auth, false)) {
      return { scopePublished: false, changed: false };
    }
    const refreshStartedAt = now();
    const attemptedAt = new Date(refreshStartedAt).toISOString();
    try {
      const remoteScope = await dependencies.fetchScope({
        token: auth.mainToken,
        now: () => refreshStartedAt,
      });
      if (!await sameCredentials(auth, false)) {
        return { scopePublished: false, changed: false };
      }
      const currentLiveNames = await loadLiveNames();
      if (!await sameCredentials(auth, false)) {
        return { scopePublished: false, changed: false };
      }
      await dependencies.store.replaceScope({
        accountLogin: auth.accountLogin,
        repositories: remoteScope.repositories.filter((repository) => (
          currentLiveNames.has(repository.full_name)
        )),
        attemptedAt,
        successfulAt: remoteScope.fetchedAt,
      });
      return { scopePublished: true, changed: true };
    } catch (error) {
      if (!await sameCredentials(auth, false)) {
        return { scopePublished: false, changed: false };
      }
      await dependencies.store.recordScopeFailure({
        accountLogin: auth.accountLogin,
        attemptedAt,
        errorCode: stableErrorCode(error),
      });
      return { scopePublished: false, changed: true };
    }
  }

  async function performRefresh(auth: AuthSnapshot): Promise<RefreshOutcome> {
    const empty = emptyOutcome();
    if (!auth.accountLogin || !auth.mainToken || !await sameCredentials(auth, false)) {
      return empty;
    }
    const scope = await performScopeRefresh(auth);
    const stabilityBudget: SnapshotStabilityBudget = { restarts: 0 };
    let changed = scope.changed;
    let changedBroadcast = false;
    let inboxPublished = false;
    if (auth.notificationsToken && await sameCredentials(auth, true)) {
      setExecutingRefreshPhase(auth, 'inbox');
      for (;;) {
        const batch = await performInboxBatch(auth, 'manual', stabilityBudget);
        changed ||= batch.changed;
        inboxPublished ||= batch.inboxPublished;
        if (batch.changed) {
          dependencies.broadcastChanged();
          changedBroadcast = true;
        }
        if (batch.credentialsChanged || batch.failure) break;
        const state = await dependencies.store.getState(auth.accountLogin);
        if (state?.inbox.scanStatus === 'complete') break;
      }
    }
    if (changed && !changedBroadcast) dependencies.broadcastChanged();
    return { scopePublished: scope.scopePublished, inboxPublished, notModified: false };
  }

  async function performScopeOnlyRefresh(auth: AuthSnapshot): Promise<RefreshOutcome> {
    const scope = await performScopeRefresh(auth);
    if (scope.changed) dependencies.broadcastChanged();
    return {
      scopePublished: scope.scopePublished,
      inboxPublished: false,
      notModified: false,
    };
  }

  async function performInboxRefresh(auth: AuthSnapshot): Promise<RefreshOutcome> {
    const empty = emptyOutcome();
    if (
      !auth.accountLogin
      || !auth.mainToken
      || !auth.notificationsToken
      || !await sameCredentials(auth, true)
    ) return empty;
    const state = await dependencies.store.getState(auth.accountLogin);
    if (
      state?.inbox.scanStatus === 'complete'
      && state.inbox.nextAllowedAt
      && Date.parse(state.inbox.nextAllowedAt) > now()
    ) return empty;
    const batch = await performInboxBatch(auth, 'scheduled');
    if (batch.changed) dependencies.broadcastChanged();
    return {
      scopePublished: false,
      inboxPublished: batch.inboxPublished,
      notModified: batch.notModified,
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

    const operation = runRefreshOperation(
      requestedAuth,
      'scope',
      () => performRefresh(requestedAuth),
    );
    const promise = operation.then(async (outcome) => ({
      ...outcome,
      status: await deriveStatus(false),
    }));
    inFlight = { identity, promise };
    dependencies.broadcastStatusChanged();
    void promise.finally(() => {
      if (inFlight?.promise === promise) {
        inFlight = null;
        dependencies.broadcastStatusChanged();
      }
    }).catch(() => {});
    return promise;
  }

  async function refreshScope(): Promise<WatchRefreshResult> {
    const active = inFlight ?? scopeInFlight;
    if (active) return active.promise;
    await reconcileAccount();
    const requestedAuth = await readAuth();
    const identity = refreshIdentity(requestedAuth);
    const operation = runRefreshOperation(
      requestedAuth,
      'scope',
      () => performScopeOnlyRefresh(requestedAuth),
    );
    const promise = operation.then(async (outcome) => ({
      ...outcome,
      status: await deriveStatus(false),
    }));
    scopeInFlight = { identity, promise };
    dependencies.broadcastStatusChanged();
    void promise.finally(() => {
      if (scopeInFlight?.promise === promise) {
        scopeInFlight = null;
        dependencies.broadcastStatusChanged();
      }
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
    const operation = runRefreshOperation(
      requestedAuth,
      'inbox',
      () => performInboxRefresh(requestedAuth),
    );
    const promise = operation.then(async (outcome) => ({
      ...outcome,
      status: await deriveStatus(false),
    }));
    inboxInFlight = { identity, promise };
    dependencies.broadcastStatusChanged();
    void promise.finally(() => {
      if (inboxInFlight?.promise === promise) {
        inboxInFlight = null;
        dependencies.broadcastStatusChanged();
      }
    }).catch(() => {});
    return promise;
  }

  async function loadOlder(): Promise<WatchLoadOlderResult> {
    await reconcileAccount();
    const requestedAuth = await readAuth();
    const identity = refreshIdentity(requestedAuth);
    const current = historyInFlight;
    if (current) {
      if (current.identity === identity) return current.promise;
      try {
        await current.promise;
      } catch {
        // A changed credential identity gets its own queued history attempt.
      }
      if (historyInFlight === current) historyInFlight = null;
      return loadOlder();
    }

    const operation = dependencies.runSerialized(() => performLoadOlder(requestedAuth));
    const promise = operation.then(async (outcome) => ({
      ...outcome,
      status: await deriveStatus(false),
    }));
    historyInFlight = { identity, promise };
    void promise.finally(() => {
      if (historyInFlight?.promise === promise) historyInFlight = null;
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

  async function markLoaded(): Promise<string | null> {
    await reconcileAccount();
    const auth = await readAuth();
    if (!auth.accountLogin || !auth.mainToken) return null;
    const accountLogin = auth.accountLogin;
    const loadedAt = new Date(now()).toISOString();
    return dependencies.runSerialized(async () => {
      if (!await sameCredentials(auth, false)) return null;
      const state = await dependencies.store.markLoaded({ accountLogin, loadedAt });
      return state?.inbox.newerThan ?? null;
    });
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
    snapshotStatus: () => deriveStatus(),
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
    loadOlder,
    markLoaded,
    markThreadsRead: (input) => mutateThreads('read', input),
    refreshScope,
    markThreadsDone: (input) => mutateThreads('done', input),
    disconnectInbox: disconnectInboxCommand,
    clearData: clearDataCommand,
    reconcileAccount,
    isRefreshing: () => inFlight !== null || inboxInFlight !== null || scopeInFlight !== null,
  };
}
