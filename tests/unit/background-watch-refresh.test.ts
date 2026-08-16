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

function config(): Config {
  return {
    tokenEncrypted: 'main-cipher',
    tokenCryptoMeta: { iv: 'main-iv', salt: 'main-salt' },
    githubCredentialStatus: 'ready',
    watchCollapsedRepositories: {},
    watchNotificationsEnabled: true,
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
  mutateNotification?: WatchRefreshCoordinatorDependencies['mutateNotification'];
  queryInbox?: typeof watchStore.queryStoredWatchInbox;
  disconnectInbox?: typeof watchStore.disconnectWatchInbox;
  liveRepositoryNames?: string[] | (() => string[] | Promise<string[]>);
  currentTime?: number;
  now?: () => number;
  runSerialized?: WatchRefreshCoordinatorDependencies['runSerialized'];
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
  const mutateNotification = input.mutateNotification ?? vi.fn();
  const broadcastChanged = vi.fn();
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
      getGitHubCredentialSnapshot: async () => ({
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
      }),
      clearWatchNotificationsToken,
    },
    fetchScope,
    fetchNotifications,
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
      replaceInbox: watchStore.replaceWatchInbox,
      getNotificationThread: watchStore.getWatchNotificationThread,
      revalidateInbox: watchStore.revalidateWatchInbox,
      recordInboxFailure: watchStore.recordWatchInboxFailure,
      disconnectInbox: input.disconnectInbox ?? watchStore.disconnectWatchInbox,
      applyThreadMutation: watchStore.applyWatchThreadMutation,
      clearData: watchStore.clearWatchData,
    },
    now: input.now ?? (() => input.currentTime ?? NOW),
    broadcastChanged,
  });
  return {
    coordinator,
    fetchScope,
    fetchNotifications,
    mutateNotification,
    broadcastChanged,
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

  it('publishes live-star Notifications even when native scope omits the repository', async () => {
    const h = harness({
      fetchScope: vi.fn(async () => ({
        repositories: [],
        pageCount: 1,
        fetchedAt: new Date(NOW).toISOString(),
      })),
    });

    const result = await h.coordinator.refresh();

    expect(result.scopePublished).toBe(true);
    expect(result.inboxPublished).toBe(true);
    expect(await watchStore.getWatchRepositories(ACCOUNT)).toEqual([]);
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads)
      .toEqual([thread()]);
    expect(h.broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('rechecks live Stars in the publication transaction after Notifications fetch', async () => {
    const pendingInbox = deferred<WatchNotificationSnapshot>();
    const h = harness({ fetchNotifications: vi.fn(async () => pendingInbox.promise) });

    const refresh = h.coordinator.refresh();
    await vi.waitFor(() => expect(h.fetchNotifications).toHaveBeenCalledTimes(1));
    await db.stars.update('owner/repo', { tombstone: true, viewer_has_starred: false });
    pendingInbox.resolve(inboxSnapshot());

    const result = await refresh;
    expect(result.inboxPublished).toBe(true);
    expect((await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT })).threads)
      .toEqual([]);
  });

  it('publishes a Star added while Notifications are in flight', async () => {
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

  it('coalesces repeated refresh requests and publishes only live-star Notifications', async () => {
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
  it('refreshes native membership but skips Notifications during Inbox cooldown', async () => {
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
    expect(h.fetchNotifications).not.toHaveBeenCalled();
    expect(result.scopePublished).toBe(true);
    expect(result.status.inboxStatus).toBe('cooldown');
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

    const result = await h.coordinator.refresh();

    expect(result.notModified).toBe(true);
    expect(result.inboxPublished).toBe(false);
    const stored = await watchStore.queryStoredWatchInbox({ accountLogin: ACCOUNT });
    expect(stored.threads.map((item) => item.id)).toEqual(['cached']);
    expect(stored.state?.inbox.errorCode).toBeNull();
    expect(stored.state?.inbox.truncated).toBe(true);
  });

  it('keeps the Notifications validator when watched membership changes', async () => {
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
      truncated: false,
      mode: 'replace',
    });
    const fetchNotifications = vi.fn(async (options) => {
      expect(options.lastModified).toBe('Tue, 04 Aug 2026 03:04:05 GMT');
      return inboxSnapshot({
        threads: [thread('custom')],
        candidateCount: 1,
        matchedCount: 1,
      });
    });
    const h = harness({
      fetchScope: vi.fn(async () => ({
        repositories: [],
        pageCount: 1,
        fetchedAt: new Date(NOW).toISOString(),
      })),
      fetchNotifications,
    });

    await h.coordinator.refresh();

    expect(fetchNotifications).toHaveBeenCalledTimes(1);
    const stored = await watchStore.queryStoredWatchInbox({
      accountLogin: ACCOUNT,
      unreadOnly: false,
    });
    expect(stored.threads.map((item) => item.id)).toEqual(['cached', 'custom']);
    expect(stored.state?.inbox.lastModified).toBe(
      'Wed, 05 Aug 2026 03:04:05 GMT',
    );
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

  it('repairs a tombstoned star before returning a cached Watch projection', async () => {
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

    expect(result.threads).toEqual([]);
    expect(result.groups).toEqual([]);
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
