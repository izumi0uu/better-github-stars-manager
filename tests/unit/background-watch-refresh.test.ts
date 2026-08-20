import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSerializedRunner } from '@/background/serialized-runner';
import {
  createWatchRefreshCoordinator,
  type WatchRefreshCoordinatorDependencies,
} from '@/background/watch-refresh';
import { db } from '@/storage/db';
import * as watchStore from '@/storage/watch-store';
import type { Config } from '@/types';
import {
  GitHubWatchError,
  type GitHubNotificationThread,
  type WatchNotificationSnapshot,
  type WatchScopeSnapshot,
} from '@/watch/watch-model';

const ACCOUNT = 'octocat';
const NOW = Date.parse('2026-08-05T03:04:05.000Z');
type FetchNotificationsOptions = Parameters<
  WatchRefreshCoordinatorDependencies['fetchNotifications']
>[0];

function config(): Config {
  return {
    tokenEncrypted: 'main-cipher',
    tokenCryptoMeta: { iv: 'main-iv', salt: 'main-salt' },
    githubCredentialStatus: 'ready',
    watchCollapsedRepositories: {},
    watchNotificationsEnabled: true,
    radarWindowDays: 60,
    watchNotificationsTokenEncrypted: 'watch-cipher',
    watchNotificationsTokenCryptoMeta: { iv: 'watch-iv', salt: 'watch-salt' },
    watchCredentialSource: 'dedicated',
    agentProvider: {
      provider: 'openai',
      protocol: null,
      baseUrl: null,
      model: 'gpt-5.4',
      declaredContextWindow: null,
      workingContextWindow: null,
      apiKeyEncrypted: null,
      apiKeyCryptoMeta: null,
      credentialScope: null,
      credentialRevision: null,
      capability: null,
    },
    agentDataDisclosureAcceptance: null,
    theme: 'dark',
    locale: 'en',
    defaultView: 'table',
    lastSyncStarredAt: null,
    gistId: null,
    gistSyncCursor: null,
    username: ACCOUNT,
    avatarUrl: null,
    displayName: null,
    onboardingStage: 'done',
    seenOnboarding: true,
    seenTooltips: 0,
    autoTagAgentPromptSeen: false,
    storeRatingPrompt: {
      version: 1,
      status: 'tracking',
      activeLocalDays: [],
      meaningfulActionCount: 0,
      exposureCount: 0,
      snoozeUntil: null,
    },
    autoTagLimit: 5,
    maxTagsPerRepo: 5,
    minTopicRepoCount: 3,
    libraryView: {
      version: 1,
      filters: {
        languages: [],
        tags: [],
        tagMode: 'any',
        showTombstone: false,
        onlyOwned: false,
        onlyFavorite: false,
        onlyUntagged: false,
        onlyArchived: false,
      },
      sort: { sortKey: 'starred_at', sortDir: 'desc' },
    },
    starsPanelDefaultEnabled: true,
    columnLayoutMode: 'default',
    customColumnLayout: null,
    langTagMigrationDone: true,
    lastSyncProgress: { phase: 'idle', done: 0, total: null, message: '' },
    backfills: {},
  };
}

function thread(id = '1', repositoryFullName = 'owner/repo'): GitHubNotificationThread {
  return {
    id,
    repositoryFullName,
    repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
    reason: 'subscribed',
    subjectType: 'Issue',
    subjectTitle: `Thread ${id}`,
    subjectApiUrl: `https://api.github.com/repos/${repositoryFullName}/issues/1`,
    subjectHtmlUrl: `https://github.com/${repositoryFullName}/issues/1`,
    unread: true,
    updatedAt: '2026-08-05T03:00:00.000Z',
    lastReadAt: null,
    fetchedAt: new Date(NOW).toISOString(),
  };
}

function scopeSnapshot(): WatchScopeSnapshot {
  return {
    repositories: [{ full_name: 'owner/repo' }, { full_name: 'other/repo' }],
    pageCount: 1,
    fetchedAt: new Date(NOW).toISOString(),
  };
}

function inboxSnapshot(overrides: Partial<WatchNotificationSnapshot> = {}): WatchNotificationSnapshot {
  return {
    threads: [thread()],
    candidateCount: 1,
    matchedCount: 1,
    pageCount: 1,
    truncated: false,
    nextPage: null,
    notModified: false,
    before: new Date(NOW).toISOString(),
    fetchedAt: new Date(NOW).toISOString(),
    lastModified: 'Wed, 05 Aug 2026 03:04:05 GMT',
    pollIntervalSeconds: 60,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(input: {
  watchCredentialSource?: Config['watchCredentialSource'];
  fetchScope?: WatchRefreshCoordinatorDependencies['fetchScope'];
  fetchNotifications?: WatchRefreshCoordinatorDependencies['fetchNotifications'];
  validateSnapshot?: WatchRefreshCoordinatorDependencies['fetchNotifications'];
  mutateNotification?: WatchRefreshCoordinatorDependencies['mutateNotification'];
  queryInbox?: typeof watchStore.queryStoredWatchInbox;
  disconnectInbox?: typeof watchStore.disconnectWatchInbox;
  liveRepositoryNames?: string[] | (() => string[] | Promise<string[]>);
  currentTime?: number;
  now?: () => number;
  runSerialized?: WatchRefreshCoordinatorDependencies['runSerialized'];
  beforeCredentialSnapshot?: () => void | Promise<void>;
} = {}) {
  let currentConfig: Config = {
    ...config(),
    watchCredentialSource: input.watchCredentialSource === undefined
      ? 'dedicated'
      : input.watchCredentialSource,
  };
  let mainToken: string | null = 'main-token';
  let dedicatedNotificationsToken: string | null = 'watch-token';
  if (currentConfig.watchCredentialSource !== 'dedicated') {
    dedicatedNotificationsToken = null;
    currentConfig = {
      ...currentConfig,
      watchNotificationsTokenEncrypted: null,
      watchNotificationsTokenCryptoMeta: null,
    };
  }
  const selectedNotificationsConfigured = () => {
    const source = currentConfig.watchCredentialSource;
    if (source === 'main') {
      return !!(
        currentConfig.username?.trim() &&
        currentConfig.tokenEncrypted &&
        currentConfig.tokenCryptoMeta
      );
    }
    return source === 'dedicated' && !!(
      currentConfig.username?.trim() &&
      currentConfig.watchNotificationsTokenEncrypted &&
      currentConfig.watchNotificationsTokenCryptoMeta
    );
  };
  const selectedNotificationsIdentity = () => {
    const source = currentConfig.watchCredentialSource;
    return JSON.stringify([
      source,
      source === 'main'
        ? currentConfig.tokenEncrypted
        : source === 'dedicated'
          ? currentConfig.watchNotificationsTokenEncrypted
          : null,
      source === 'main'
        ? currentConfig.tokenCryptoMeta
        : source === 'dedicated'
          ? currentConfig.watchNotificationsTokenCryptoMeta
          : null,
    ]);
  };
  const fetchScope = input.fetchScope ?? vi.fn(async () => scopeSnapshot());
  const fetchNotifications = input.fetchNotifications ?? vi.fn(async () => inboxSnapshot());
  const validateSnapshot = input.validateSnapshot ?? vi.fn(async (options: FetchNotificationsOptions) => inboxSnapshot({
    threads: [],
    candidateCount: 0,
    matchedCount: 0,
    notModified: true,
    before: new Date(options.before ?? NOW).toISOString(),
    lastModified: options.lastModified ?? null,
    fetchedAt: new Date(input.now?.() ?? input.currentTime ?? NOW).toISOString(),
  }));
  const coordinatorFetchNotifications: WatchRefreshCoordinatorDependencies['fetchNotifications'] = (
    options,
  ) => options.maxPages === 1 && options.startPage === 1 && !!options.lastModified
    ? validateSnapshot(options)
    : fetchNotifications(options);
  const mutateNotification = input.mutateNotification ?? vi.fn();
  const broadcastChanged = vi.fn();
  const broadcastStatusChanged = vi.fn();
  const clearWatchNotificationsToken = vi.fn(async () => {
    dedicatedNotificationsToken = null;
    currentConfig = {
      ...currentConfig,
      watchCredentialSource: null,
      watchNotificationsTokenEncrypted: null,
      watchNotificationsTokenCryptoMeta: null,
    };
  });
  const runner = createSerializedRunner();
  const runSerialized = input.runSerialized ?? ((operation) => runner.run(operation));
  const coordinator = createWatchRefreshCoordinator({
    runSerialized,
    auth: {
      getGitHubCredentialSnapshot: async () => {
        await input.beforeCredentialSnapshot?.();
        return {
          watchCredentialSource: currentConfig.watchCredentialSource,
          accountLogin: currentConfig.username?.trim().toLowerCase() ?? null,
          mainToken,
          notificationsToken: currentConfig.watchCredentialSource === 'main'
            ? mainToken
            : currentConfig.watchCredentialSource === 'dedicated'
              ? dedicatedNotificationsToken
              : null,
          notificationsConfigured: selectedNotificationsConfigured(),
          mainIdentity: JSON.stringify([
            currentConfig.username?.trim().toLowerCase() ?? null,
            currentConfig.tokenEncrypted,
            currentConfig.tokenCryptoMeta,
          ]),
          notificationsIdentity: selectedNotificationsIdentity(),
        };
      },
      clearWatchNotificationsToken,
    },
    fetchScope,
    fetchNotifications: coordinatorFetchNotifications,
    mutateNotification,
    fetchSubjectDetail: vi.fn(),
    loadLiveRepositoryNames: async () => typeof input.liveRepositoryNames === 'function'
      ? input.liveRepositoryNames()
      : input.liveRepositoryNames ?? (await db.stars.toArray()).map((star) => star.full_name),
    store: {
      getState: watchStore.getWatchState,
      getRepositories: watchStore.getWatchRepositories,
      queryInbox: input.queryInbox ?? watchStore.queryStoredWatchInbox,
      reconcileAccount: watchStore.reconcileWatchAccount,
      reconcileLiveStars: watchStore.reconcileWatchLiveStars,
      replaceScope: watchStore.replaceWatchScope,
      recordScopeFailure: watchStore.recordWatchScopeFailure,
      startInboxScan: watchStore.startWatchInboxScan,
      commitInboxScanBatch: watchStore.commitWatchInboxScanBatch,
      mergeInboxDelta: watchStore.mergeWatchInboxDelta,
      markLoaded: watchStore.markWatchInboxLoaded,
      getNotificationThread: watchStore.getWatchNotificationThread,
      revalidateInbox: watchStore.revalidateWatchInbox,
      recordInboxFailure: watchStore.recordWatchInboxFailure,
      recordHistoryFailure: watchStore.recordWatchHistoryFailure,
      disconnectInbox: input.disconnectInbox ?? watchStore.disconnectWatchInbox,
      applyThreadMutation: watchStore.applyWatchThreadMutation,
      clearData: watchStore.clearWatchData,
    },
    now: input.now ?? (() => input.currentTime ?? NOW),
    broadcastChanged,
    broadcastStatusChanged,
  });
  return {
    coordinator,
    fetchScope,
    fetchNotifications,
    validateSnapshot,
    mutateNotification,
    broadcastChanged,
    broadcastStatusChanged,
    clearWatchNotificationsToken,
    clearWatchToken() {
      dedicatedNotificationsToken = null;
      currentConfig = {
        ...currentConfig,
        watchCredentialSource: null,
        watchNotificationsTokenEncrypted: null,
        watchNotificationsTokenCryptoMeta: null,
      };
    },
    setWatchToken(value = 'replacement-watch-token') {
      dedicatedNotificationsToken = value;
      currentConfig = {
        ...currentConfig,
        watchCredentialSource: 'dedicated',
        watchNotificationsTokenEncrypted: `${value}:cipher`,
        watchNotificationsTokenCryptoMeta: { iv: `${value}:iv`, salt: `${value}:salt` },
      };
    },
    useMainWatchCredential() {
      dedicatedNotificationsToken = null;
      currentConfig = {
        ...currentConfig,
        watchCredentialSource: 'main',
        watchNotificationsTokenEncrypted: null,
        watchNotificationsTokenCryptoMeta: null,
      };
    },
    getNotificationsIdentity() {
      return selectedNotificationsIdentity();
    },
    logout() {
      currentConfig = { ...currentConfig, username: null };
      mainToken = null;
    },
    changeAccount(login: string) {
      currentConfig = {
        ...currentConfig,
        username: login,
        tokenEncrypted: `${currentConfig.tokenEncrypted}:${login}`,
      };
      mainToken = `main-token:${login}`;
    },
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await db.stars.put({
    full_name: 'owner/repo',
    html_url: 'https://github.com/owner/repo',
    description: '',
    language: null,
    stargazers_count: 0,
    topics: [],
    pushed_at: null,
    created_at: null,
    fork: false,
    archived: false,
    starred_at: new Date(NOW).toISOString(),
    tombstone: false,
    synced_at: new Date(NOW).toISOString(),
  });
});

afterAll(async () => {
  await db.close();
});

describe('Watch background refresh coordinator', () => {
  it('snapshots durable status without entering the serialized mutation queue', async () => {
    const runSerialized = vi.fn(
      async (operation: () => Promise<unknown>) => operation(),
    ) as WatchRefreshCoordinatorDependencies['runSerialized'];
    const h = harness({ runSerialized });

    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      accountLogin: ACCOUNT.toLowerCase(),
      refreshing: false,
    });
    expect(runSerialized).not.toHaveBeenCalled();

    await h.coordinator.getStatus();
    expect(runSerialized).toHaveBeenCalledTimes(1);
  });

  it('rejects a thread mutation bound to a different GitHub account', async () => {
    const mutateNotification = vi.fn();
    const h = harness({ mutateNotification });

    await expect(h.coordinator.markThreadsDone({
      accountLogin: 'another-user',
      threadIds: ['1'],
    })).rejects.toMatchObject({ code: 'authentication_required' });
    expect(mutateNotification).not.toHaveBeenCalled();
  });

  it('applies the successful part of an oversized done batch', async () => {
    const threads = Array.from({ length: 500 }, (_, index) => thread(String(index + 1)));
    await db.watchNotificationThreads.bulkPut(threads);
    await db.watchState.put({
      id: 'singleton',
      accountLogin: ACCOUNT,
      scope: {
        lastAttemptAt: null,
        lastSuccessfulAt: null,
        errorCode: null,
        repositoryCount: 0,
      },
      inbox: {
        lastAttemptAt: null,
        lastSuccessfulAt: null,
        errorCode: null,
        lastModified: null,
        nextAllowedAt: null,
        candidateCount: 0,
        matchedCount: 0,
        truncated: false,
        newerThan: null,
        historyBefore: null,
        historyNextPage: null,
        historyExhausted: true,
        historyErrorCode: null,
        scanId: null,
        scanStatus: 'complete',
        scanStartedAt: null,
        scanPageCount: 0,
        lastConvergedAt: null,
      },
    });
    const mutateNotification = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === '250') throw new GitHubWatchError('rate_limited');
    });
    const h = harness({ mutateNotification });
    await h.coordinator.reconcileAccount();
    h.broadcastChanged.mockClear();

    const result = await h.coordinator.markThreadsDone({
      accountLogin: ACCOUNT,
      threadIds: threads.map((item) => item.id),
    });

    expect(mutateNotification).toHaveBeenCalledTimes(500);
    expect(result).toEqual({ action: 'done', requestedCount: 500, changedCount: 499 });
    const remaining = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(remaining.threads.map((item) => item.id)).toEqual(['250']);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('rejects a done batch when every thread mutation fails', async () => {
    await db.watchNotificationThreads.bulkPut([thread('1'), thread('2')]);
    await db.watchState.put({
      id: 'singleton',
      accountLogin: ACCOUNT,
      scope: {
        lastAttemptAt: null,
        lastSuccessfulAt: null,
        errorCode: null,
        repositoryCount: 0,
      },
      inbox: {
        lastAttemptAt: null,
        lastSuccessfulAt: null,
        errorCode: null,
        lastModified: null,
        nextAllowedAt: null,
        candidateCount: 0,
        matchedCount: 0,
        truncated: false,
        newerThan: null,
        historyBefore: null,
        historyNextPage: null,
        historyExhausted: true,
        historyErrorCode: null,
        scanId: null,
        scanStatus: 'complete',
        scanStartedAt: null,
        scanPageCount: 0,
        lastConvergedAt: null,
      },
    });
    const mutateNotification = vi.fn(async () => {
      throw new GitHubWatchError('rate_limited');
    });
    const h = harness({ mutateNotification });
    await h.coordinator.reconcileAccount();
    h.broadcastChanged.mockClear();

    await expect(h.coordinator.markThreadsDone({
      accountLogin: ACCOUNT,
      threadIds: ['1', '2'],
    })).rejects.toMatchObject({ code: 'rate_limited' });
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads)
      .toHaveLength(2);
    expect(h.broadcastChanged).not.toHaveBeenCalled();
  });

  it('revalidates credentials before applying completed thread mutations', async () => {
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('1')],
      attemptedAt: new Date(NOW).toISOString(),
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const pendingMutation = deferred<void>();
    const mutateNotification = vi.fn(async () => pendingMutation.promise);
    const h = harness({ mutateNotification });

    const mutation = h.coordinator.markThreadsDone({
      accountLogin: ACCOUNT,
      threadIds: ['1'],
    });
    const rejected = expect(mutation).rejects.toMatchObject({ code: 'authentication_required' });
    await vi.waitFor(() => expect(mutateNotification).toHaveBeenCalledTimes(1));
    h.changeAccount('another-user');
    pendingMutation.resolve();

    await rejected;
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads)
      .toHaveLength(1);
    expect(h.broadcastChanged).not.toHaveBeenCalled();
  });

  it('caps thread mutations at four workers and consumes every target once', async () => {
    const threads = Array.from({ length: 9 }, (_, index) => thread(String(index + 1)));
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads,
      attemptedAt: new Date(NOW).toISOString(),
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: threads.length,
      truncated: false,
      mode: 'replace',
    });
    const releaseMutations = deferred<void>();
    const seen: string[] = [];
    let active = 0;
    let peakActive = 0;
    const mutateNotification = vi.fn(async ({ threadId }: { threadId: string }) => {
      seen.push(threadId);
      active += 1;
      peakActive = Math.max(peakActive, active);
      await releaseMutations.promise;
      active -= 1;
    });
    const h = harness({ mutateNotification });

    const mutation = h.coordinator.markThreadsDone({
      accountLogin: ACCOUNT,
      threadIds: threads.map((item) => item.id),
    });
    await vi.waitFor(() => expect(mutateNotification).toHaveBeenCalledTimes(4));
    expect(active).toBe(4);
    expect(peakActive).toBe(4);

    releaseMutations.resolve();
    const result = await mutation;

    expect(result).toEqual({ action: 'done', requestedCount: 9, changedCount: 9 });
    expect(mutateNotification).toHaveBeenCalledTimes(9);
    expect([...seen].sort((left, right) => Number(left) - Number(right)))
      .toEqual(threads.map((item) => item.id));
    expect(peakActive).toBe(4);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping thread mutation commands', async () => {
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('1'), thread('2')],
      attemptedAt: new Date(NOW).toISOString(),
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 2,
      truncated: false,
      mode: 'replace',
    });
    const releaseFirstMutation = deferred<void>();
    let mutationCalls = 0;
    const mutateNotification = vi.fn(async () => {
      mutationCalls += 1;
      if (mutationCalls === 1) await releaseFirstMutation.promise;
    });
    const runner = createSerializedRunner();
    let serializedRuns = 0;
    let activeRuns = 0;
    let peakActiveRuns = 0;
    const runSerialized: WatchRefreshCoordinatorDependencies['runSerialized'] = (operation) => {
      serializedRuns += 1;
      return runner.run(async () => {
        activeRuns += 1;
        peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
        try {
          return await operation();
        } finally {
          activeRuns -= 1;
        }
      });
    };
    const h = harness({ mutateNotification, runSerialized });

    const first = h.coordinator.markThreadsDone({ accountLogin: ACCOUNT, threadIds: ['1'] });
    const second = h.coordinator.markThreadsDone({ accountLogin: ACCOUNT, threadIds: ['2'] });
    await vi.waitFor(() => expect(mutateNotification).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mutateNotification).toHaveBeenCalledTimes(1);

    releaseFirstMutation.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { action: 'done', requestedCount: 1, changedCount: 1 },
      { action: 'done', requestedCount: 1, changedCount: 1 },
    ]);
    expect(mutateNotification).toHaveBeenCalledTimes(2);
    expect(serializedRuns).toBe(4);
    expect(peakActiveRuns).toBe(1);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(2);
  });

  it('publishes arbitrary repository Notifications with an empty Stars library', async () => {
    await db.stars.clear();
    const remoteThreads = [thread('1', 'owner/repo'), thread('2', 'outside/repo')];
    const h = harness({
      fetchScope: vi.fn(async () => ({
        repositories: [],
        pageCount: 1,
        fetchedAt: new Date(NOW).toISOString(),
      })),
      fetchNotifications: vi.fn(async () => inboxSnapshot({
        threads: remoteThreads,
        candidateCount: 2,
        matchedCount: 2,
      })),
    });

    const result = await h.coordinator.refresh();

    expect(result.scopePublished).toBe(true);
    expect(result.inboxPublished).toBe(true);
    expect(await watchStore.getWatchRepositories(ACCOUNT)).toEqual([]);
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads)
      .toEqual(remoteThreads);
    expect(await watchStore.countUnreadWatchThreads(ACCOUNT)).toBe(2);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps a Notification when its local Star changes during the fetch', async () => {
    const pendingInbox = deferred<WatchNotificationSnapshot>();
    const h = harness({ fetchNotifications: vi.fn(async () => pendingInbox.promise) });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(h.fetchNotifications).toHaveBeenCalledTimes(1));
    await db.stars.update('owner/repo', { tombstone: true, viewer_has_starred: false });
    pendingInbox.resolve(inboxSnapshot());

    const result = await refresh;
    expect(result.inboxPublished).toBe(true);
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads)
      .toEqual([thread()]);
  });

  it('publishes a Notification independently of a Star added in flight', async () => {
    const pendingInbox = deferred<WatchNotificationSnapshot>();
    await db.stars.clear();
    const h = harness({ fetchNotifications: vi.fn(async () => pendingInbox.promise) });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(h.fetchNotifications).toHaveBeenCalledTimes(1));
    await db.stars.put({
      full_name: 'owner/repo',
      html_url: 'https://github.com/owner/repo',
      description: '',
      language: null,
      stargazers_count: 1,
      topics: [],
      pushed_at: null,
      created_at: null,
      fork: false,
      archived: false,
      starred_at: new Date(NOW).toISOString(),
      tombstone: false,
      viewer_has_starred: true,
      synced_at: new Date(NOW).toISOString(),
    });
    pendingInbox.resolve(inboxSnapshot());

    await refresh;
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads)
      .toEqual([thread()]);
  });

  it('coalesces repeated refresh requests and publishes all Notifications', async () => {
    const pendingScope = deferred<WatchScopeSnapshot>();
    const fetchScope = vi.fn(async () => pendingScope.promise);
    const h = harness({ fetchScope });

    const first = h.coordinator.refresh();
    const second = h.coordinator.refresh();
    await Promise.resolve();
    pendingScope.resolve(scopeSnapshot());
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(fetchScope).toHaveBeenCalledTimes(1);
    expect(h.fetchNotifications).toHaveBeenCalledTimes(1);
    expect(await watchStore.getWatchRepositories(ACCOUNT)).toEqual([{ full_name: 'owner/repo' }]);
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads).toHaveLength(1);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('coalesces scope refreshes that overlap during account reconciliation', async () => {
    const reconciliationGate = deferred<void>();
    const pendingScope = deferred<WatchScopeSnapshot>();
    const runner = createSerializedRunner();
    const runSerialized: WatchRefreshCoordinatorDependencies['runSerialized'] = (operation) => (
      runner.run(operation)
    );
    const blocker = runSerialized(() => reconciliationGate.promise);
    const fetchScope = vi.fn(async () => pendingScope.promise);
    const h = harness({ fetchScope, runSerialized });

    const first = h.coordinator.refreshScope();
    const second = h.coordinator.refreshScope();
    reconciliationGate.resolve(undefined);
    await blocker;
    await vi.waitFor(() => expect(fetchScope).toHaveBeenCalledTimes(1));
    pendingScope.resolve(scopeSnapshot());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(fetchScope).toHaveBeenCalledTimes(1);
  });

  it('queues a scope refresh when the credential identity changes in flight', async () => {
    const firstScope = deferred<WatchScopeSnapshot>();
    const fetchScope = vi.fn(async () => (
      fetchScope.mock.calls.length === 1 ? firstScope.promise : scopeSnapshot()
    ));
    const h = harness({ fetchScope });

    const first = h.coordinator.refreshScope();
    await vi.waitFor(() => expect(fetchScope).toHaveBeenCalledTimes(1));
    h.changeAccount('another-user');
    const second = h.coordinator.refreshScope();
    firstScope.resolve(scopeSnapshot());
    await Promise.all([first, second]);

    expect(fetchScope).toHaveBeenCalledTimes(2);
    expect((await watchStore.getWatchState('another-user'))?.scope.lastSuccessfulAt)
      .toBe(new Date(NOW).toISOString());
  });

  it('publishes scope then Inbox phases during manual refresh', async () => {
    const pendingScope = deferred<WatchScopeSnapshot>();
    const pendingInbox = deferred<WatchNotificationSnapshot>();
    const h = harness({
      fetchScope: vi.fn(async () => pendingScope.promise),
      fetchNotifications: vi.fn(async () => pendingInbox.promise),
    });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(h.fetchScope).toHaveBeenCalledTimes(1));
    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      refreshing: true,
      refreshPhase: 'scope',
    });
    expect(h.broadcastStatusChanged).toHaveBeenCalledTimes(2);

    pendingScope.resolve(scopeSnapshot());
    await vi.waitFor(() => expect(h.fetchNotifications).toHaveBeenCalledTimes(1));
    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      refreshing: true,
      refreshPhase: 'inbox',
    });
    expect(h.broadcastStatusChanged).toHaveBeenCalledTimes(4);

    pendingInbox.resolve(inboxSnapshot());
    await expect(refresh).resolves.toMatchObject({
      status: {
        refreshing: false,
        refreshPhase: null,
      },
    });
    await vi.waitFor(() => expect(h.broadcastStatusChanged).toHaveBeenCalledTimes(6));
  });

  it('captures the executing phase before an asynchronous credential read', async () => {
    const pendingScope = deferred<WatchScopeSnapshot>();
    const pendingInbox = deferred<WatchNotificationSnapshot>();
    const credentialReadStarted = deferred<void>();
    const credentialReadGate = deferred<void>();
    let pauseNextCredentialRead = false;
    const h = harness({
      beforeCredentialSnapshot: async () => {
        if (!pauseNextCredentialRead) return;
        pauseNextCredentialRead = false;
        credentialReadStarted.resolve(undefined);
        await credentialReadGate.promise;
      },
      fetchScope: vi.fn(async () => pendingScope.promise),
      fetchNotifications: vi.fn(async () => pendingInbox.promise),
    });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(h.fetchScope).toHaveBeenCalledTimes(1));
    pauseNextCredentialRead = true;
    const scopeStatus = h.coordinator.snapshotStatus();
    await credentialReadStarted.promise;

    pendingScope.resolve(scopeSnapshot());
    await vi.waitFor(() => expect(h.fetchNotifications).toHaveBeenCalledTimes(1));
    credentialReadGate.resolve(undefined);
    await expect(scopeStatus).resolves.toMatchObject({
      refreshing: true,
      refreshPhase: 'scope',
    });
    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      refreshing: true,
      refreshPhase: 'inbox',
    });

    pendingInbox.resolve(inboxSnapshot());
    await refresh;
  });

  it('keeps the executing scope phase while an Inbox refresh waits in the queue', async () => {
    const pendingScope = deferred<WatchScopeSnapshot>();
    const pendingInbox = deferred<WatchNotificationSnapshot>();
    const h = harness({
      fetchScope: vi.fn(async () => pendingScope.promise),
      fetchNotifications: vi.fn(async () => pendingInbox.promise),
    });

    const scopeRefresh = h.coordinator.refreshScope();
    const inboxRefresh = h.coordinator.refreshInbox();
    await vi.waitFor(() => expect(h.fetchScope).toHaveBeenCalledTimes(1));
    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      refreshing: true,
      refreshPhase: 'scope',
    });

    pendingScope.resolve(scopeSnapshot());
    await vi.waitFor(() => expect(h.fetchNotifications).toHaveBeenCalledTimes(1));
    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      refreshing: true,
      refreshPhase: 'inbox',
    });

    pendingInbox.resolve(inboxSnapshot());
    await Promise.all([scopeRefresh, inboxRefresh]);
    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      refreshing: false,
      refreshPhase: null,
    });
  });

  it('keeps the executing Inbox phase while a scope refresh waits in the queue', async () => {
    const pendingScope = deferred<WatchScopeSnapshot>();
    const pendingInbox = deferred<WatchNotificationSnapshot>();
    const h = harness({
      fetchScope: vi.fn(async () => pendingScope.promise),
      fetchNotifications: vi.fn(async () => pendingInbox.promise),
    });

    const inboxRefresh = h.coordinator.refreshInbox();
    const scopeRefresh = h.coordinator.refreshScope();
    await vi.waitFor(() => expect(h.fetchNotifications).toHaveBeenCalledTimes(1));
    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      refreshing: true,
      refreshPhase: 'inbox',
    });

    pendingInbox.resolve(inboxSnapshot());
    await vi.waitFor(() => expect(h.fetchScope).toHaveBeenCalledTimes(1));
    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      refreshing: true,
      refreshPhase: 'scope',
    });

    pendingScope.resolve(scopeSnapshot());
    await Promise.all([inboxRefresh, scopeRefresh]);
    await expect(h.coordinator.snapshotStatus()).resolves.toMatchObject({
      refreshing: false,
      refreshPhase: null,
    });
  });

  it('drains a 44-page scan without gaps or duplicate rows during manual refresh', async () => {
    const historyBefore = new Date(NOW).toISOString();
    const fetchNotifications = vi.fn(async (
      options: Parameters<WatchRefreshCoordinatorDependencies['fetchNotifications']>[0],
    ) => {
      const startPage = options.startPage ?? 1;
      const pageCount = Math.min(10, 45 - startPage);
      const threads = Array.from(
        { length: pageCount },
        (_, index) => thread(String(startPage + index)),
      );
      if (startPage === 11) threads.push(thread('1'));
      const nextPage = startPage + pageCount <= 44 ? startPage + pageCount : null;
      return inboxSnapshot({
        threads,
        candidateCount: threads.length,
        matchedCount: threads.length,
        pageCount,
        truncated: nextPage !== null,
        nextPage,
        before: historyBefore,
      });
    });
    const h = harness({ fetchNotifications });

    await h.coordinator.refresh();

    expect(fetchNotifications).toHaveBeenCalledTimes(5);
    expect(fetchNotifications.mock.calls.map(([options]) => options.startPage ?? 1))
      .toEqual([1, 11, 21, 31, 41]);
    expect(fetchNotifications).toHaveBeenLastCalledWith(expect.objectContaining({
      token: 'watch-token',
      before: historyBefore,
      startPage: 41,
      maxPages: 10,
      lastModified: null,
    }));
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads).toHaveLength(44);
    expect(new Set(stored.threads.map((item) => item.id)).size).toBe(44);
    expect(stored.state?.inbox).toEqual(expect.objectContaining({
      candidateCount: 44,
      matchedCount: 44,
      scanStatus: 'complete',
      scanId: null,
      scanPageCount: 44,
      historyNextPage: null,
      historyExhausted: true,
      truncated: false,
    }));
    await expect(h.coordinator.loadOlder()).resolves.toEqual(expect.objectContaining({
      addedCount: 0,
      hasMore: false,
    }));
    expect(fetchNotifications).toHaveBeenCalledTimes(5);
    expect(h.validateSnapshot).toHaveBeenCalledTimes(1);
    expect(h.validateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      before: historyBefore,
      startPage: 1,
      maxPages: 1,
      lastModified: 'Wed, 05 Aug 2026 03:04:05 GMT',
    }));
    expect(h.broadcastChanged).toHaveBeenCalledTimes(5);
  });

  it('runs queued serialized work before the next durable manual Inbox batch', async () => {
    const historyBefore = new Date(NOW).toISOString();
    const firstBatch = deferred<WatchNotificationSnapshot>();
    const unrelatedGate = deferred<void>();
    const order: string[] = [];
    const runner = createSerializedRunner();
    const runSerialized: WatchRefreshCoordinatorDependencies['runSerialized'] = (operation) => (
      runner.run(operation)
    );
    const fetchNotifications = vi.fn(async (options: FetchNotificationsOptions) => {
      const startPage = options.startPage ?? 1;
      order.push(`batch-${startPage}`);
      if (startPage === 1) return firstBatch.promise;
      return inboxSnapshot({
        threads: [thread('older')],
        before: historyBefore,
      });
    });
    const h = harness({ fetchNotifications, runSerialized });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(fetchNotifications).toHaveBeenCalledTimes(1));
    const unrelated = runSerialized(async () => {
      order.push('unrelated');
      expect(h.coordinator.isRefreshing()).toBe(true);
      await unrelatedGate.promise;
    });
    firstBatch.resolve(inboxSnapshot({
      threads: [thread('newer')],
      pageCount: 10,
      truncated: true,
      nextPage: 11,
      before: historyBefore,
    }));

    await vi.waitFor(() => expect(order).toEqual(['batch-1', 'unrelated']));
    expect(fetchNotifications).toHaveBeenCalledTimes(1);
    expect(h.coordinator.isRefreshing()).toBe(true);
    unrelatedGate.resolve(undefined);
    await Promise.all([refresh, unrelated]);
    expect(order).toEqual(['batch-1', 'unrelated', 'batch-11']);
    expect(fetchNotifications.mock.calls.map(([options]) => options.startPage ?? 1))
      .toEqual([1, 11]);
    expect((await watchStore.getWatchState(ACCOUNT))?.inbox.scanStatus).toBe('complete');
  });

  it('loads older from durable counts without materializing the Inbox projection', async () => {
    const queryInbox = vi.fn(async () => {
      throw new Error('Inbox projection should not be queried');
    }) as typeof watchStore.queryStoredWatchInbox;
    const fetchNotifications = vi.fn(async () => inboxSnapshot({
      threads: [thread('new')],
      pageCount: 10,
      truncated: true,
      nextPage: 11,
    }));
    const h = harness({ fetchNotifications, queryInbox });

    await expect(h.coordinator.loadOlder()).resolves.toEqual(expect.objectContaining({
      addedCount: 1,
      hasMore: true,
    }));
    expect(queryInbox).not.toHaveBeenCalled();
    expect((await watchStore.getWatchState(ACCOUNT))?.inbox).toEqual(expect.objectContaining({
      matchedCount: 1,
      scanStatus: 'scanning',
    }));
  });

  it('preserves a moving thread until a restarted snapshot is stably confirmed', async () => {
    const movingBefore = { ...thread('moving'), updatedAt: '2026-08-05T02:00:00.000Z' };
    const absent = thread('absent');
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [movingBefore, absent],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
      lastModified: 'Wed, 05 Aug 2026 03:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 2,
      truncated: false,
      mode: 'replace',
    });
    const movingAfter = { ...movingBefore, updatedAt: '2026-08-05T03:04:05.500Z' };
    const boundaries: string[] = [];
    let scanRequest = 0;
    const fetchNotifications = vi.fn(async (options: FetchNotificationsOptions) => {
      scanRequest++;
      const boundary = new Date(options.before ?? NOW).toISOString();
      boundaries.push(boundary);
      if (scanRequest === 2) {
        const preserved = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
        expect(preserved.threads.map((item) => item.id).sort()).toEqual(['absent', 'moving']);
        expect(preserved.threads.find((item) => item.id === 'moving')?.updatedAt)
          .toBe(movingBefore.updatedAt);
      }
      const threads = scanRequest === 1
        ? [thread('present')]
        : [movingAfter, thread('present')];
      return inboxSnapshot({
        threads,
        candidateCount: threads.length,
        matchedCount: threads.length,
        before: boundary,
        fetchedAt: boundary,
        lastModified: scanRequest === 1
          ? 'Wed, 05 Aug 2026 03:04:05 GMT'
          : 'Wed, 05 Aug 2026 03:04:06 GMT',
      });
    });
    let validationRequest = 0;
    const validateSnapshot = vi.fn(async (options: FetchNotificationsOptions) => {
      validationRequest++;
      return inboxSnapshot({
        threads: validationRequest === 1 ? [movingAfter] : [],
        candidateCount: validationRequest === 1 ? 1 : 0,
        matchedCount: validationRequest === 1 ? 1 : 0,
        notModified: validationRequest === 2,
        before: new Date(options.before ?? NOW).toISOString(),
        fetchedAt: new Date(NOW + validationRequest * 1_000).toISOString(),
        lastModified: options.lastModified ?? null,
        pollIntervalSeconds: 120,
      });
    });
    const h = harness({ fetchNotifications, validateSnapshot });

    await h.coordinator.refresh();

    expect(fetchNotifications).toHaveBeenCalledTimes(2);
    expect(validateSnapshot).toHaveBeenCalledTimes(2);
    expect(Date.parse(boundaries[1]!)).toBeGreaterThan(Date.parse(boundaries[0]!));
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id).sort()).toEqual(['moving', 'present']);
    expect(new Set(stored.threads.map((item) => item.id)).size).toBe(2);
    expect(stored.threads.find((item) => item.id === 'moving')?.updatedAt)
      .toBe(movingAfter.updatedAt);
    expect(stored.state?.inbox).toEqual(expect.objectContaining({
      scanStatus: 'complete',
      errorCode: null,
      historyErrorCode: null,
      lastSuccessfulAt: new Date(NOW + 2_000).toISOString(),
      lastConvergedAt: new Date(NOW + 2_000).toISOString(),
      lastModified: 'Wed, 05 Aug 2026 03:04:06 GMT',
      nextAllowedAt: new Date(NOW + 122_000).toISOString(),
    }));
    expect(h.broadcastChanged).toHaveBeenCalledTimes(2);
  });

  it('keeps cached rows recoverable when the active scan has no validator', async () => {
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
      lastModified: 'Wed, 05 Aug 2026 03:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const h = harness({
      fetchNotifications: vi.fn(async (options: FetchNotificationsOptions) => inboxSnapshot({
        threads: [thread('replacement')],
        before: new Date(options.before ?? NOW).toISOString(),
        lastModified: null,
      })),
    });

    const result = await h.coordinator.refresh();

    expect(result.inboxPublished).toBe(false);
    expect(h.validateSnapshot).not.toHaveBeenCalled();
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id)).toEqual(['cached']);
    expect(stored.state?.inbox).toEqual(expect.objectContaining({
      scanStatus: 'partial',
      errorCode: 'snapshot_unstable',
      historyErrorCode: 'snapshot_unstable',
      historyNextPage: 1,
    }));
  });

  it('preserves cached rows when final snapshot validation fails', async () => {
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
      lastModified: 'Wed, 05 Aug 2026 03:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const h = harness({
      validateSnapshot: vi.fn(async () => {
        throw new GitHubWatchError('network_error');
      }),
    });

    const result = await h.coordinator.refresh();

    expect(result.inboxPublished).toBe(false);
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id)).toEqual(['cached']);
    expect(stored.state?.inbox).toEqual(expect.objectContaining({
      scanStatus: 'partial',
      errorCode: 'network_error',
      historyErrorCode: 'network_error',
      historyNextPage: 1,
    }));
  });

  it('bounds repeated manual snapshot restarts in a durable partial state', async () => {
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
      lastModified: 'Wed, 05 Aug 2026 03:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const boundaries: string[] = [];
    const fetchNotifications = vi.fn(async (options: FetchNotificationsOptions) => {
      const boundary = new Date(options.before ?? NOW).toISOString();
      boundaries.push(boundary);
      return inboxSnapshot({
        threads: [thread(`candidate-${boundaries.length}`)],
        before: boundary,
        fetchedAt: boundary,
      });
    });
    const validateSnapshot = vi.fn(async (options: FetchNotificationsOptions) => inboxSnapshot({
      threads: [thread('changed')],
      notModified: false,
      before: new Date(options.before ?? NOW).toISOString(),
      lastModified: options.lastModified ?? null,
    }));
    const h = harness({ fetchNotifications, validateSnapshot });

    const result = await h.coordinator.refresh();

    expect(result.inboxPublished).toBe(false);
    expect(fetchNotifications).toHaveBeenCalledTimes(4);
    expect(validateSnapshot).toHaveBeenCalledTimes(4);
    expect(boundaries.map(Date.parse)).toEqual([...boundaries.map(Date.parse)].sort((a, b) => a - b));
    expect(new Set(boundaries).size).toBe(4);
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id)).toEqual(['cached']);
    expect(stored.state?.inbox).toEqual(expect.objectContaining({
      scanStatus: 'partial',
      errorCode: 'snapshot_unstable',
      historyErrorCode: 'snapshot_unstable',
      historyNextPage: 1,
      historyBefore: boundaries[3],
      scanPageCount: 0,
    }));
    expect(h.broadcastChanged).toHaveBeenCalledTimes(4);
  });

  it('keeps the exact cursor and prior rows when a continuation batch fails', async () => {
    let request = 0;
    const fetchNotifications = vi.fn(async () => {
      request++;
      if (request === 1) {
        return inboxSnapshot({ threads: [thread('new')], pageCount: 10, truncated: true, nextPage: 11 });
      }
      throw new GitHubWatchError('rate_limited');
    });
    const h = harness({ fetchNotifications });

    await h.coordinator.refresh();

    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id)).toEqual(['new']);
    expect(stored.state?.inbox).toEqual(expect.objectContaining({
      errorCode: 'rate_limited',
      historyErrorCode: 'rate_limited',
      historyNextPage: 11,
      historyExhausted: false,
      scanStatus: 'partial',
      candidateCount: 1,
      matchedCount: 1,
    }));
  });

  it('reconstructs a coordinator and resumes one persisted scheduled batch', async () => {
    const historyBefore = new Date(NOW).toISOString();
    const firstFetch = vi.fn(async () => inboxSnapshot({
      threads: [thread('new')],
      pageCount: 10,
      truncated: true,
      nextPage: 11,
      before: historyBefore,
    }));
    await harness({ fetchNotifications: firstFetch }).coordinator.refreshInbox();

    const resumedFetch = vi.fn(async () => inboxSnapshot({
      threads: [thread('old')],
      pageCount: 3,
      truncated: false,
      nextPage: null,
      before: historyBefore,
    }));
    const restarted = harness({ fetchNotifications: resumedFetch });
    await restarted.coordinator.refreshInbox();

    expect(resumedFetch).toHaveBeenCalledTimes(1);
    expect(restarted.validateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      before: historyBefore,
      startPage: 1,
      maxPages: 1,
      lastModified: 'Wed, 05 Aug 2026 03:04:05 GMT',
    }));
    expect(resumedFetch).toHaveBeenCalledWith(expect.objectContaining({
      before: historyBefore,
      startPage: 11,
      maxPages: 10,
      lastModified: null,
    }));
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id).sort()).toEqual(['new', 'old']);
    expect(stored.state?.inbox.scanStatus).toBe('complete');
    expect(stored.state?.inbox.scanPageCount).toBe(13);
  });

  it('restarts one active scheduled final batch durably without publishing an unstable boundary', async () => {
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
      lastModified: 'Wed, 05 Aug 2026 03:00:00 GMT',
      nextAllowedAt: new Date(NOW - 60_000).toISOString(),
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const historyBefore = new Date(NOW - 30_000).toISOString();
    await watchStore.startWatchInboxScan({
      accountLogin: ACCOUNT,
      scanId: 'scan-scheduled-final',
      scanStartedAt: historyBefore,
      before: historyBefore,
      attemptedAt: historyBefore,
      lastModified: null,
    });
    const fetchNotifications = vi.fn(async (options: FetchNotificationsOptions) => inboxSnapshot({
      threads: [thread('changed')],
      before: new Date(options.before ?? NOW).toISOString(),
      lastModified: 'Wed, 05 Aug 2026 03:04:05 GMT',
    }));
    const validateSnapshot = vi.fn(async (options: FetchNotificationsOptions) => inboxSnapshot({
      threads: [thread('moved')],
      notModified: false,
      before: new Date(options.before ?? NOW).toISOString(),
      fetchedAt: new Date(NOW).toISOString(),
      lastModified: options.lastModified ?? null,
    }));
    const h = harness({ fetchNotifications, validateSnapshot });

    const result = await h.coordinator.refreshInbox();

    expect(result.inboxPublished).toBe(false);
    expect(fetchNotifications).toHaveBeenCalledTimes(1);
    expect(validateSnapshot).toHaveBeenCalledTimes(1);
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id)).toEqual(['cached']);
    expect(stored.state?.inbox).toEqual(expect.objectContaining({
      scanStatus: 'scanning',
      historyNextPage: 1,
      scanPageCount: 0,
      lastModified: null,
    }));
    expect(Date.parse(stored.state!.inbox.historyBefore!)).toBeGreaterThan(
      Date.parse(historyBefore),
    );
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('discards a stable validation response after the credential changes', async () => {
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
      lastModified: 'Wed, 05 Aug 2026 03:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const pendingValidation = deferred<WatchNotificationSnapshot>();
    let validationOptions: Parameters<WatchRefreshCoordinatorDependencies['fetchNotifications']>[0]
      | null = null;
    const validateSnapshot = vi.fn(async (options: FetchNotificationsOptions) => {
      validationOptions = options;
      return pendingValidation.promise;
    });
    const h = harness({ validateSnapshot });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(validateSnapshot).toHaveBeenCalledTimes(1));
    h.setWatchToken('rotated-during-validation');
    pendingValidation.resolve(inboxSnapshot({
      threads: [],
      candidateCount: 0,
      matchedCount: 0,
      notModified: true,
      before: new Date(validationOptions!.before ?? NOW).toISOString(),
      lastModified: validationOptions!.lastModified ?? null,
    }));

    const result = await refresh;
    expect(result.inboxPublished).toBe(false);
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id)).toEqual(['cached']);
    expect(stored.state?.inbox.scanStatus).toBe('scanning');
  });

  it('uses a converged scheduled head poll without advancing the visible-load watermark', async () => {
    let clock = NOW;
    const fetchNotifications = vi.fn(async () => inboxSnapshot({
      threads: [thread('1')],
      before: new Date(clock).toISOString(),
      fetchedAt: new Date(clock).toISOString(),
    }));
    const validateSnapshot = vi.fn(async (options: FetchNotificationsOptions) => {
      const before = new Date(options.before ?? clock).toISOString();
      if (clock === NOW) {
        return inboxSnapshot({
          threads: [],
          candidateCount: 0,
          matchedCount: 0,
          notModified: true,
          before,
          fetchedAt: new Date(clock).toISOString(),
          lastModified: options.lastModified ?? null,
        });
      }
      return inboxSnapshot({
        threads: [thread('2')],
        before,
        fetchedAt: new Date(clock).toISOString(),
      });
    });
    const h = harness({ fetchNotifications, validateSnapshot, now: () => clock });
    await h.coordinator.refresh();
    const acknowledgedAt = await h.coordinator.markLoaded();

    clock += 61_000;
    await h.coordinator.refreshInbox();

    expect(fetchNotifications).toHaveBeenCalledTimes(1);
    expect(validateSnapshot).toHaveBeenCalledTimes(2);
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id)).toEqual(['1', '2']);
    expect(stored.state?.inbox.lastModified).toBe('Wed, 05 Aug 2026 03:04:05 GMT');
    expect(stored.state?.inbox.newerThan).toBe(acknowledgedAt);
    expect(stored.state?.inbox.scanStatus).toBe('complete');
  });

  it('manual refresh ignores a converged cooldown and refreshes scope plus Inbox', async () => {
    await watchStore.replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: new Date(NOW - 1_000).toISOString(),
    });
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread()],
      attemptedAt: new Date(NOW - 1_000).toISOString(),
      lastModified: null,
      nextAllowedAt: new Date(NOW + 30_000).toISOString(),
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const h = harness();

    const result = await h.coordinator.refresh();

    expect(h.fetchScope).toHaveBeenCalledTimes(1);
    expect(h.fetchNotifications).toHaveBeenCalledTimes(1);
    expect(result.scopePublished).toBe(true);
    expect(result.inboxPublished).toBe(true);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('fetches Notifications through the configured credential', async () => {
    const h = harness();
    await h.coordinator.refresh();
    expect(h.fetchNotifications).toHaveBeenCalledWith(expect.objectContaining({ token: 'watch-token' }));
  });

  it('refreshes only native scope when Watch has no selected credential', async () => {
    const h = harness({ watchCredentialSource: null });
    const result = await h.coordinator.refresh();

    expect(h.fetchScope).toHaveBeenCalledTimes(1);
    expect(h.fetchNotifications).not.toHaveBeenCalled();
    expect(result.scopePublished).toBe(true);
    expect(result.status.inboxStatus).toBe('not_configured');
  });

  it('continues Inbox refresh when watched-membership refresh fails', async () => {
    const fetchScope = vi.fn(async () => {
      throw new GitHubWatchError('network_error');
    });
    const h = harness({ fetchScope });

    const result = await h.coordinator.refresh();

    expect(h.fetchNotifications).toHaveBeenCalledTimes(1);
    expect(result.inboxPublished).toBe(true);
    expect(result.status.scopeStatus).toBe('error');
    expect(result.status.inboxStatus).toBe('cooldown');
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads)
      .toEqual([thread()]);
  });

  it('continues Inbox refresh against a stale watched-membership snapshot', async () => {
    await watchStore.replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
    });
    const fetchScope = vi.fn(async () => {
      throw new GitHubWatchError('network_error');
    });
    const h = harness({ fetchScope });

    const result = await h.coordinator.refresh();

    expect(h.fetchNotifications).toHaveBeenCalledTimes(1);
    expect(result.inboxPublished).toBe(true);
    expect(result.status.scopeStatus).toBe('stale');
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads).toHaveLength(1);
  });

  it('revalidates a 304 without replacing cached rows', async () => {
    await watchStore.replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
    });
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
      lastModified: 'Tue, 04 Aug 2026 03:04:05 GMT',
      nextAllowedAt: new Date(NOW - 60_000).toISOString(),
      candidateCount: 1,
      truncated: true,
      mode: 'replace',
    });
    await watchStore.recordWatchInboxFailure({
      accountLogin: ACCOUNT,
      attemptedAt: new Date(NOW - 30_000).toISOString(),
      errorCode: 'network_error',
    });
    const h = harness({
      fetchNotifications: vi.fn(async () => inboxSnapshot({
        threads: [],
        candidateCount: 0,
        matchedCount: 0,
        notModified: true,
        pollIntervalSeconds: 120,
      })),
    });

    const result = await h.coordinator.refreshInbox();

    expect(result.notModified).toBe(true);
    expect(result.inboxPublished).toBe(false);
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id)).toEqual(['cached']);
    expect(stored.state?.inbox.errorCode).toBeNull();
    expect(stored.state?.inbox.truncated).toBe(false);
  });

  it('merges a conditional scheduled 200 delta without sweeping the complete baseline', async () => {
    const lastConvergedAt = new Date(NOW - 120_000).toISOString();
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: lastConvergedAt,
      lastModified: 'Tue, 04 Aug 2026 03:04:05 GMT',
      nextAllowedAt: new Date(NOW - 60_000).toISOString(),
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const validateSnapshot = vi.fn(async (options: FetchNotificationsOptions) => {
      expect(options.lastModified).toBe('Tue, 04 Aug 2026 03:04:05 GMT');
      expect(options.maxPages).toBe(1);
      return inboxSnapshot({
        threads: [thread('custom')],
        candidateCount: 1,
        matchedCount: 1,
      });
    });
    const h = harness({ validateSnapshot });

    const result = await h.coordinator.refreshInbox();

    expect(result.inboxPublished).toBe(true);
    expect(result.notModified).toBe(false);
    expect(h.fetchNotifications).not.toHaveBeenCalled();
    expect(validateSnapshot).toHaveBeenCalledTimes(1);
    expect(h.fetchScope).not.toHaveBeenCalled();
    const stored = await watchStore.queryStoredWatchInbox({
      accountLogin: ACCOUNT,
      unreadOnly: false,
    });
    expect(stored.threads.map((item) => item.id).sort()).toEqual(['cached', 'custom']);
    expect(stored.state?.inbox.lastModified).toBe(
      'Wed, 05 Aug 2026 03:04:05 GMT',
    );
    expect(stored.state?.inbox.candidateCount).toBe(2);
    expect(stored.state?.inbox.matchedCount).toBe(2);
    expect(stored.state?.inbox.scanStatus).toBe('complete');
    expect(stored.state?.inbox.lastConvergedAt).toBe(lastConvergedAt);
  });

  it('starts an unconditioned full scan when a conditional delta spans pages', async () => {
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
      lastModified: 'Tue, 04 Aug 2026 03:04:05 GMT',
      nextAllowedAt: new Date(NOW - 60_000).toISOString(),
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const validateSnapshot = vi.fn(async (options: FetchNotificationsOptions) => {
      expect(options.maxPages).toBe(1);
      return inboxSnapshot({
        threads: [thread('delta-page-one')],
        candidateCount: 1,
        matchedCount: 1,
        nextPage: 2,
      });
    });
    const h = harness({ validateSnapshot });

    const result = await h.coordinator.refreshInbox();

    expect(result.inboxPublished).toBe(false);
    expect(validateSnapshot).toHaveBeenCalledTimes(1);
    const stored = await watchStore.queryStoredWatchInbox({
      accountLogin: ACCOUNT,
      unreadOnly: false,
    });
    expect(stored.threads.map((item) => item.id)).toEqual(['cached']);
    expect(stored.state?.inbox.scanStatus).toBe('scanning');
    expect(stored.state?.inbox.historyNextPage).toBe(1);
    expect(stored.state?.inbox.lastModified).toBeNull();
  });

  it('does not return cached private rows when the account changes during a query', async () => {
    await watchStore.replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
    });
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('private')],
      attemptedAt: new Date(NOW - 120_000).toISOString(),
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const queryStarted = deferred<void>();
    const releaseQuery = deferred<void>();
    const queryInbox: typeof watchStore.queryStoredWatchInbox = async (input) => {
      const result = await watchStore.queryStoredWatchInbox(input);
      queryStarted.resolve();
      await releaseQuery.promise;
      return result;
    };
    const h = harness({ queryInbox });

    const pending = h.coordinator.queryInbox(false);
    await queryStarted.promise;
    h.changeAccount('another-user');
    releaseQuery.resolve();
    const result = await pending;

    expect(result.threads).toEqual([]);
    expect(result.groups).toEqual([]);
    expect(result).not.toHaveProperty('state');
    expect(result.status.accountLogin).toBe('another-user');
  });

  it('prunes only native membership when a Star is tombstoned before a Watch query', async () => {
    const h = harness();
    await watchStore.replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: new Date(NOW).toISOString(),
    });
    await watchStore.replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: new Date(NOW).toISOString(),
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    await db.stars.update('owner/repo', { tombstone: true });

    const result = await h.coordinator.queryInbox(false);

    expect(result.threads.map((item) => item.id)).toEqual(['cached']);
    expect(await watchStore.getWatchRepositories(ACCOUNT)).toEqual([]);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('queues a new refresh when credentials change during an in-flight refresh', async () => {
    const firstScope = deferred<WatchScopeSnapshot>();
    const fetchScope = vi.fn(async () => (
      fetchScope.mock.calls.length === 1 ? firstScope.promise : scopeSnapshot()
    ));
    const h = harness({
      watchCredentialSource: null,
      fetchScope,
    });

    const first = h.coordinator.refresh();
    await vi.waitFor(() => expect(fetchScope).toHaveBeenCalledTimes(1));
    h.changeAccount('another-user');
    const second = h.coordinator.refresh();
    firstScope.resolve(scopeSnapshot());
    await Promise.all([first, second]);

    expect(fetchScope).toHaveBeenCalledTimes(2);
    expect((await watchStore.getWatchState('another-user'))?.scope.lastSuccessfulAt)
      .toBe(new Date(NOW).toISOString());
  });

  it('starts the poll cooldown after the response completes', async () => {
    let clock = NOW;
    const h = harness({
      now: () => clock,
      fetchNotifications: vi.fn(async () => {
        clock += 120_000;
        return inboxSnapshot({ pollIntervalSeconds: 60 });
      }),
    });

    await h.coordinator.refresh();

    const state = await watchStore.getWatchState(ACCOUNT);
    expect(state?.inbox.nextAllowedAt).toBe(new Date(clock + 60_000).toISOString());
  });

  it('does not send the old Notifications token when it is revoked during scope refresh', async () => {
    const pendingScope = deferred<WatchScopeSnapshot>();
    const h = harness({ fetchScope: vi.fn(async () => pendingScope.promise) });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(h.fetchScope).toHaveBeenCalledTimes(1));
    h.clearWatchToken();
    pendingScope.resolve(scopeSnapshot());

    await refresh;
    expect(h.fetchNotifications).not.toHaveBeenCalled();
  });

  it('keeps a queued scope refresh but skips Inbox when Watch authority is disabled', async () => {
    const pending: Array<() => Promise<void>> = [];
    const runSerialized = ((operation: () => Promise<unknown>) => new Promise<unknown>((resolve, reject) => {
      pending.push(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      });
    })) as WatchRefreshCoordinatorDependencies['runSerialized'];
    const h = harness({ runSerialized });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await pending.shift()!(); // entry reconciliation
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    h.clearWatchToken();
    await pending.shift()!(); // refresh operation

    const result = await refresh;
    expect(result.scopePublished).toBe(true);
    expect(h.fetchScope).toHaveBeenCalledTimes(1);
    expect(h.fetchNotifications).not.toHaveBeenCalled();
  });

  it('does not publish Inbox rows when the selected Watch source changes during fetch', async () => {
    const pendingInbox = deferred<WatchNotificationSnapshot>();
    const fetchNotifications = vi.fn(async () => pendingInbox.promise);
    const h = harness({
      watchCredentialSource: 'dedicated',
      fetchNotifications,
    });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(fetchNotifications).toHaveBeenCalledTimes(1));
    h.useMainWatchCredential();
    pendingInbox.resolve(inboxSnapshot());

    const result = await refresh;
    expect(result.inboxPublished).toBe(false);
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads).toEqual([]);
  });

  it('does not publish Inbox rows when the selected credential identity changes during fetch', async () => {
    const pendingInbox = deferred<WatchNotificationSnapshot>();
    const fetchNotifications = vi.fn(async () => pendingInbox.promise);
    const h = harness({ fetchNotifications });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(fetchNotifications).toHaveBeenCalledTimes(1));
    h.setWatchToken('rotated-watch-token');
    pendingInbox.resolve(inboxSnapshot());

    const result = await refresh;
    expect(result.inboxPublished).toBe(false);
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads).toEqual([]);
  });

  it('reconciles an interrupted account cleanup without deleting a newer Watch token', async () => {
    await watchStore.replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: new Date(NOW).toISOString(),
    });
    const h = harness();
    const previousNotificationsIdentity = h.getNotificationsIdentity();
    h.changeAccount('another-user');
    h.setWatchToken();

    await h.coordinator.reconcileAccount({
      invalidateNotificationsIdentity: previousNotificationsIdentity,
    });

    expect(await watchStore.getWatchState(ACCOUNT)).toBeNull();
    expect((await h.coordinator.getStatus()).hasNotificationsToken).toBe(true);
  });

  it('clears the old classic credential only when its persisted identity still matches', async () => {
    await watchStore.replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: new Date(NOW).toISOString(),
    });
    const h = harness();
    const previousNotificationsIdentity = h.getNotificationsIdentity();
    h.changeAccount('another-user');

    await h.coordinator.reconcileAccount({
      invalidateNotificationsIdentity: previousNotificationsIdentity,
    });

    expect((await h.coordinator.getStatus()).hasNotificationsToken).toBe(false);
    expect(await watchStore.getWatchState(ACCOUNT)).toBeNull();
  });

  it('clears stale account data and the classic credential after logout on the next Watch entry', async () => {
    await watchStore.replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: new Date(NOW).toISOString(),
    });
    const h = harness();
    h.logout();

    const status = await h.coordinator.getStatus();

    expect(status.hasNotificationsToken).toBe(false);
  });

  it('disconnects Watch while retaining the main credential and native scope', async () => {
    const h = harness({ watchCredentialSource: 'main' });

    await h.coordinator.refresh();
    expect(h.fetchScope).toHaveBeenCalledTimes(1);
    expect(h.fetchNotifications).toHaveBeenCalledTimes(1);

    const status = await h.coordinator.disconnectInbox();
    expect(status.hasMainToken).toBe(true);
    expect(status.hasNotificationsToken).toBe(false);
    expect(await watchStore.getWatchRepositories(ACCOUNT)).toEqual([{ full_name: 'owner/repo' }]);
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads).toEqual([]);

    const afterDisconnect = await h.coordinator.refresh();
    expect(h.fetchScope).toHaveBeenCalledTimes(2);
    expect(h.fetchNotifications).toHaveBeenCalledTimes(1);
    expect(afterDisconnect.status.hasMainToken).toBe(true);
  });

  it('broadcasts disconnect invalidation only after cached threads are cleared', async () => {
    const pendingDisconnect = deferred<void>();
    const disconnectInbox = vi.fn(async () => pendingDisconnect.promise);
    const h = harness({ disconnectInbox });

    const disconnect = h.coordinator.disconnectInbox();
    await vi.waitFor(() => {
      expect(h.clearWatchNotificationsToken).toHaveBeenCalledTimes(1);
      expect(disconnectInbox).toHaveBeenCalledWith(ACCOUNT);
    });
    expect(h.broadcastChanged).not.toHaveBeenCalled();

    pendingDisconnect.resolve();
    await disconnect;

    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });
});
