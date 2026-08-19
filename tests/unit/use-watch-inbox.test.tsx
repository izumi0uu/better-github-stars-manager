/**
 * @vitest-environment jsdom
 */
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWatchInbox } from '@/ui/hooks/use-watch-inbox';
import { ExtensionManagerRuntime } from '@/runtime/extension-manager-runtime';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import {
  WATCH_MAX_THREAD_ACTIONS,
  type WatchInboxQueryResponse,
  type WatchStatus,
} from '@/watch/watch-contract';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const watchMocks = vi.hoisted(() => ({
  bgCall: vi.fn(),
  getConfig: vi.fn(),
  updateWatchRepositoryCollapse: vi.fn(),
}));

type RuntimeListener = (message: { type?: string; status?: WatchStatus }) => void;
type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

const runtimeListeners: RuntimeListener[] = [];
const storageListeners: StorageListener[] = [];

const MANY_THREAD_IDS = Array.from({ length: 1_001 }, (_, index) => String(index + 1));
vi.mock('@/utils/messaging', () => ({
  bgCall: watchMocks.bgCall,
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  GITHUB_CREDENTIALS_STORAGE_KEY: 'gsm_github_credentials',
  authStore: {
    getConfig: watchMocks.getConfig,
    update: vi.fn(),
    updateWatchRepositoryCollapse: watchMocks.updateWatchRepositoryCollapse,
  },
}));
const runtime = new ExtensionManagerRuntime();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function queryResponse(
  totalCount: number,
  accountLogin = 'octocat',
): WatchInboxQueryResponse {
  return {
    threads: [],
    groups: [],
    unreadCount: totalCount,
    totalCount,
    status: {
      accountLogin,
      hasMainToken: true,
      hasNotificationsToken: true,
      refreshing: false,
      refreshPhase: null,
      scopeStatus: 'fresh',
      inboxStatus: 'fresh',
      state: null,
    },
  };
}

function cooldownResponse(
  totalCount: number,
  nextAllowedAt: string,
): WatchInboxQueryResponse {
  const response = queryResponse(totalCount);
  response.status.inboxStatus = 'cooldown';
  response.status.state = {
    id: 'singleton',
    accountLogin: 'octocat',
    scope: {
      lastAttemptAt: '2026-08-05T11:59:00Z',
      lastSuccessfulAt: '2026-08-05T11:59:00Z',
      errorCode: null,
      repositoryCount: 1,
    },
    inbox: {
      lastAttemptAt: '2026-08-05T11:59:00Z',
      lastSuccessfulAt: '2026-08-05T11:59:00Z',
      errorCode: null,
      lastModified: null,
      nextAllowedAt,
      candidateCount: totalCount,
      matchedCount: totalCount,
      truncated: false,
      newerThan: null,
      historyBefore: '2026-08-05T11:59:00Z',
      historyNextPage: null,
      historyExhausted: true,
      historyErrorCode: null,
      scanId: null,
      scanStatus: 'complete',
      scanStartedAt: null,
      scanPageCount: 1,
      lastConvergedAt: '2026-08-05T11:59:00Z',
    },
  };
  return response;
}

function loadedResponse(
  totalCount: number,
  newerThan: string,
  historyNextPage: number | null = 11,
): WatchInboxQueryResponse {
  const response = cooldownResponse(totalCount, '2026-08-05T12:00:00Z');
  response.status.inboxStatus = 'fresh';
  response.status.state!.inbox.nextAllowedAt = null;
  response.status.state!.inbox.newerThan = newerThan;
  response.status.state!.inbox.historyNextPage = historyNextPage;
  response.status.state!.inbox.historyExhausted = historyNextPage === null;
  return response;
}

function WatchProbe({
  initialActive = true,
  initialVisible = false,
}: {
  initialActive?: boolean;
  initialVisible?: boolean;
} = {}) {
  const [active, setActive] = useState(initialActive);
  const [visible, setVisible] = useState(initialVisible);
  const inbox = useWatchInbox({ active, visible });
  return (
    <div>
      <button type="button" data-testid="activate" onClick={() => setActive(true)}>
        Activate
      </button>
      <button type="button" data-testid="deactivate" onClick={() => setActive(false)}>
        Deactivate
      </button>
      <button type="button" data-testid="show" onClick={() => setVisible(true)}>
        Show Watch
      </button>
      <button type="button" data-testid="hide" onClick={() => setVisible(false)}>
        Hide Watch
      </button>
      <button type="button" data-testid="all" onClick={() => inbox.setUnreadOnly(false)}>
        All
      </button>
      <button type="button" data-testid="unread" onClick={() => inbox.setUnreadOnly(true)}>
        Unread
      </button>
      <button type="button" data-testid="refresh" onClick={() => void inbox.refresh()}>
        Refresh
      </button>
      <button type="button" data-testid="load-older" onClick={() => void inbox.loadOlder()}>
        Load older
      </button>
      <button
        type="button"
        data-testid="mark-read"
        onClick={() => void inbox.markThreadsRead(['1'])}
      >
        Mark read
      </button>
      <button
        type="button"
        data-testid="mark-done"
        onClick={() => void inbox.markThreadsDone(['1', '2'])}
      >
        Mark done
      </button>
      <button
        type="button"
        data-testid="mark-many-done"
        onClick={() => void inbox.markThreadsDone(MANY_THREAD_IDS)}
      >
        Mark many done
      </button>
      <button
        type="button"
        data-testid="collapse"
        onClick={() => inbox.updateRepositoryCollapse('owner/repo', 'signature')}
      >
        Collapse
      </button>
      <span data-testid="mode">{inbox.unreadOnly ? 'unread' : 'all'}</span>
      <span data-testid="active">{active ? 'active' : 'dormant'}</span>
      <span data-testid="loading">{inbox.loading ? 'loading' : 'ready'}</span>
      <span data-testid="count">{inbox.result?.totalCount ?? 'none'}</span>
      <span data-testid="scan-status">
        {inbox.result?.status.state?.inbox.scanStatus ?? 'none'}
      </span>
      <span data-testid="scan-pages">
        {inbox.result?.status.state?.inbox.scanPageCount ?? 'none'}
      </span>
      <span data-testid="boundary">{inbox.newerThan ?? 'none'}</span>
      <span data-testid="loading-older">{inbox.loadingOlder ? 'loading' : 'ready'}</span>
      <span data-testid="load-older-error">{inbox.loadOlderError ? 'error' : 'none'}</span>
      <span data-testid="collapsed">
        {Object.keys(inbox.collapsedRepositories).length}
      </span>
      <span data-testid="action-pending">
        {inbox.actionPending
          ? `${inbox.actionPending.action}:${inbox.actionPending.threadIds.join(',')}`
          : 'none'}
      </span>
      <span data-testid="action-error">{inbox.actionError ?? 'none'}</span>
    </div>
  );
}

function Harness(props: { initialActive?: boolean; initialVisible?: boolean } = {}) {
  return <ManagerRuntimeProvider runtime={runtime}><WatchProbe {...props} /></ManagerRuntimeProvider>;
}

const mountedRoots: MountedRoot[] = [];

beforeEach(() => {
  watchMocks.bgCall.mockReset();
  watchMocks.getConfig.mockReset();
  watchMocks.getConfig.mockResolvedValue({ watchCollapsedRepositories: {} });
  watchMocks.updateWatchRepositoryCollapse.mockReset();
  watchMocks.updateWatchRepositoryCollapse.mockResolvedValue(undefined);
  runtimeListeners.length = 0;
  storageListeners.length = 0;
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: vi.fn((listener: RuntimeListener) => runtimeListeners.push(listener)),
        removeListener: vi.fn((listener: RuntimeListener) => {
          const index = runtimeListeners.indexOf(listener);
          if (index >= 0) runtimeListeners.splice(index, 1);
        }),
      },
    },
    storage: {
      onChanged: {
        addListener: vi.fn((listener: StorageListener) => storageListeners.push(listener)),
        removeListener: vi.fn((listener: StorageListener) => {
          const index = storageListeners.indexOf(listener);
          if (index >= 0) storageListeners.splice(index, 1);
        }),
      },
    },
  });
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useWatchInbox', () => {
  it('stays dormant without presenting a request as in flight', async () => {
    watchMocks.bgCall.mockResolvedValue(queryResponse(1));
    const container = mountReact(<Harness initialActive={false} />, mountedRoots);

    await act(async () => {
      await Promise.resolve();
      runtimeListeners[0]?.({ type: 'watchChanged' });
      storageListeners[0]?.({
        gsm_github_credentials: { newValue: { watchCredentialSource: 'main' } },
      }, 'local');
      await Promise.resolve();
    });

    expect(watchMocks.bgCall).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="active"]')?.textContent).toBe('dormant');
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('none');
  });

  it('starts exactly one visible initial query on first activation', async () => {
    const firstQuery = deferred<WatchInboxQueryResponse>();
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryWatchInbox') return firstQuery.promise;
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness initialActive={false} />, mountedRoots);

    await click(container.querySelector<HTMLButtonElement>('[data-testid="activate"]')!);

    expect(watchMocks.bgCall).toHaveBeenCalledTimes(1);
    expect(watchMocks.bgCall).toHaveBeenCalledWith('queryWatchInbox', { unreadOnly: false });
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('loading');

    await act(async () => {
      firstQuery.resolve(queryResponse(1));
      await firstQuery.promise;
      await Promise.resolve();
    });

    expect(watchMocks.bgCall).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1');
  });

  it('renders pushed scan progress while the follow-up query is queued behind refresh', async () => {
    const initial = cooldownResponse(2_162, '2026-08-05T12:01:00Z');
    const blockedQuery = deferred<WatchInboxQueryResponse>();
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      queryCount++;
      return queryCount === 1 ? Promise.resolve(initial) : blockedQuery.promise;
    });
    const container = mountReact(<Harness />, mountedRoots);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const progressStatus: WatchStatus = {
      ...initial.status,
      refreshing: true,
      inboxStatus: 'fresh',
      state: {
        ...initial.status.state!,
        inbox: {
          ...initial.status.state!.inbox,
          nextAllowedAt: null,
          candidateCount: 997,
          truncated: true,
          historyNextPage: 21,
          historyExhausted: false,
          scanId: 'scan-progress',
          scanStatus: 'scanning',
          scanStartedAt: '2026-08-05T12:00:00Z',
          scanPageCount: 20,
        },
      },
    };

    await act(async () => {
      runtimeListeners[0]?.({ type: 'watchChanged', status: progressStatus });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="scan-status"]')?.textContent).toBe('scanning');
    expect(container.querySelector('[data-testid="scan-pages"]')?.textContent).toBe('20');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2162');
    expect(queryCount).toBe(2);
  });

  it('holds the previous Watch-load boundary stable for one visible visit', async () => {
    const firstBoundary = '2026-08-04T10:00:00.000Z';
    const nextBoundary = '2026-08-05T10:00:00.000Z';
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'markWatchInboxLoaded') return Promise.resolve(nextBoundary);
      if (type === 'queryWatchInbox') {
        queryCount++;
        return Promise.resolve(loadedResponse(
          2,
          queryCount === 1 ? firstBoundary : nextBoundary,
          null,
        ));
      }
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness initialVisible />, mountedRoots);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="boundary"]')?.textContent).toBe(firstBoundary);
    expect(watchMocks.bgCall.mock.calls.filter(([type]) => type === 'markWatchInboxLoaded'))
      .toHaveLength(1);

    await act(async () => {
      runtimeListeners[0]?.({ type: 'watchChanged' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="boundary"]')?.textContent).toBe(firstBoundary);

    await click(container.querySelector<HTMLButtonElement>('[data-testid="hide"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="show"]')!);
    expect(container.querySelector('[data-testid="boundary"]')?.textContent).toBe(nextBoundary);
    expect(watchMocks.bgCall.mock.calls.filter(([type]) => type === 'markWatchInboxLoaded'))
      .toHaveLength(2);
  });

  it('fills up to 1,000 notification candidates when Watch is visible', async () => {
    let historyNextPage = 11;
    let totalCount = 500;
    let queryCount = 0;
    let historyLoadCount = 0;
    const loadedPages: number[] = [];
    const historyLoads = Array.from({ length: 5 }, () => deferred<unknown>());
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'markWatchInboxLoaded') {
        return Promise.resolve('2026-08-05T12:00:00.000Z');
      }
      if (type === 'queryWatchInbox') {
        queryCount += 1;
        return Promise.resolve(loadedResponse(
          totalCount,
          '2026-08-04T10:00:00.000Z',
          historyNextPage,
        ));
      }
      if (type === 'loadOlderWatchInbox') {
        loadedPages.push(historyNextPage);
        return historyLoads[historyLoadCount++]!.promise;
      }
      throw new Error(`Unexpected request: ${type}`);
    });

    const container = mountReact(<Harness initialVisible />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(historyLoadCount).toBe(1);

    for (const [index, historyLoad] of historyLoads.entries()) {
      await act(async () => {
        historyNextPage += 2;
        totalCount += 100;
        historyLoad.resolve({});
        await historyLoad.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(historyLoadCount).toBe(Math.min(index + 2, historyLoads.length));
    }

    expect(queryCount).toBe(6);
    expect(loadedPages).toEqual([11, 13, 15, 17, 19]);
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1000');
    expect(container.querySelector('[data-testid="loading-older"]')?.textContent).toBe('ready');
  });

  it('loads an older page and then reloads the saved Watch projection', async () => {
    const older = deferred<unknown>();
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryWatchInbox') {
        queryCount++;
        return Promise.resolve(loadedResponse(queryCount, '2026-08-04T10:00:00.000Z'));
      }
      if (type === 'loadOlderWatchInbox') return older.promise;
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(watchMocks.bgCall).not.toHaveBeenCalledWith('loadOlderWatchInbox');

    await click(container.querySelector<HTMLButtonElement>('[data-testid="load-older"]')!);
    expect(container.querySelector('[data-testid="loading-older"]')?.textContent).toBe('loading');
    await act(async () => {
      older.resolve({});
      await older.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryCount).toBe(2);
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="loading-older"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="load-older-error"]')?.textContent).toBe('none');
  });

  it('shows a persisted history failure without automatically retrying it', async () => {
    const persistedFailure = loadedResponse(1, '2026-08-04T10:00:00.000Z');
    persistedFailure.status.state!.inbox.historyErrorCode = 'rate_limited';
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryWatchInbox') return Promise.resolve(persistedFailure);
      if (type === 'markWatchInboxLoaded') {
        return Promise.resolve('2026-08-05T12:00:00.000Z');
      }
      throw new Error(`Unexpected request: ${type}`);
    });

    const container = mountReact(<Harness initialVisible />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="load-older-error"]')?.textContent)
      .toBe('error');
    expect(watchMocks.bgCall).not.toHaveBeenCalledWith('loadOlderWatchInbox');
  });

  it('clears dormant cached rows on credential change and visibly reloads on activation', async () => {
    const reactivationQuery = deferred<WatchInboxQueryResponse>();
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      queryCount += 1;
      return queryCount === 1 ? Promise.resolve(queryResponse(1)) : reactivationQuery.promise;
    });
    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await click(container.querySelector<HTMLButtonElement>('[data-testid="deactivate"]')!);
    await act(async () => {
      runtimeListeners[0]?.({ type: 'watchChanged' });
      storageListeners[0]?.({
        gsm_github_credentials: { newValue: { watchCredentialSource: 'dedicated' } },
      }, 'local');
      await Promise.resolve();
    });
    expect(queryCount).toBe(1);
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('none');

    await click(container.querySelector<HTMLButtonElement>('[data-testid="activate"]')!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryCount).toBe(2);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('loading');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('none');

    await act(async () => {
      reactivationQuery.resolve(queryResponse(2));
      await reactivationQuery.promise;
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(queryCount).toBe(2);
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');
  });

  it('keeps the latest local Unread/All mode after an in-flight refresh completes', async () => {
    const refresh = deferred<unknown>();
    const queryModes: boolean[] = [];
    watchMocks.bgCall.mockImplementation((type: string, payload?: { unreadOnly?: boolean }) => {
      if (type === 'refreshWatchInbox') return refresh.promise;
      if (type === 'queryWatchInbox') {
        queryModes.push(payload?.unreadOnly ?? true);
        return Promise.resolve(queryResponse(2));
      }
      throw new Error(`Unexpected request: ${type}`);
    });

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');

    await click(container.querySelector<HTMLButtonElement>('[data-testid="refresh"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="all"]')!);
    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe('all');

    await act(async () => {
      refresh.resolve({});
      await refresh.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryModes).toEqual([false, false]);
    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe('all');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
  });

  it('switches projection mode locally without clearing or requerying the fetched snapshot', async () => {
    const queryModes: boolean[] = [];
    watchMocks.bgCall.mockImplementation((type: string, payload?: { unreadOnly?: boolean }) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      queryModes.push(payload?.unreadOnly ?? true);
      return Promise.resolve(queryResponse(2));
    });

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await click(container.querySelector<HTMLButtonElement>('[data-testid="all"]')!);

    expect(queryModes).toEqual([false]);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');
  });

  it('clears the cached result while reloading an authoritative credential change', async () => {
    const credentialQuery = deferred<WatchInboxQueryResponse>();
    const queryModes: boolean[] = [];
    watchMocks.bgCall.mockImplementation((
      type: string,
      payload?: { unreadOnly?: boolean },
    ) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      queryModes.push(payload?.unreadOnly ?? true);
      if (queryModes.length === 2) return credentialQuery.promise;
      return Promise.resolve(queryResponse(1));
    });

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1');
    expect(storageListeners).toHaveLength(1);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="all"]')!);

    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials: { newValue: {} },
      }, 'sync');
      storageListeners[0]?.({
        gsm_config: { newValue: { watchCollapsedRepositories: { 'owner/repo': 'signature' } } },
      }, 'local');
      await Promise.resolve();
    });
    expect(queryModes).toEqual([false]);

    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials: {
          oldValue: { watchNotificationsTokenEncrypted: null },
          newValue: { watchNotificationsTokenEncrypted: 'ciphertext' },
        },
      }, 'local');
      await Promise.resolve();
    });

    expect(queryModes).toEqual([false, false]);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('loading');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('none');

    await act(async () => {
      credentialQuery.resolve(queryResponse(3));
      await credentialQuery.promise;
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('3');
  });

  it('keeps old-account results cleared when credential reload fails and an older query resolves', async () => {
    const staleQuery = deferred<WatchInboxQueryResponse>();
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      queryCount += 1;
      if (queryCount === 1) return Promise.resolve(queryResponse(4));
      if (queryCount === 2) return staleQuery.promise;
      return Promise.reject(new Error('background unavailable'));
    });
    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('4');

    await act(async () => {
      runtimeListeners[0]?.({ type: 'watchChanged' });
      await Promise.resolve();
    });
    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials: { oldValue: { accountLogin: 'a' }, newValue: { accountLogin: 'b' } },
      }, 'local');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('none');
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');

    await act(async () => {
      staleQuery.resolve(queryResponse(9));
      await staleQuery.promise;
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('none');
  });

  it('requeries local status once the persisted cooldown expires', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-08-05T12:00:00Z');
    vi.setSystemTime(now);
    const cooldown = cooldownResponse(1, '2026-08-05T12:00:01Z');
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      queryCount++;
      return Promise.resolve(queryCount === 1 ? cooldown : queryResponse(2));
    });

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(queryCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
    });
    expect(queryCount).toBe(2);
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');
  });

  it('reschedules a changed cooldown and clears its timer on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-05T12:00:00Z'));
    const responses = [
      cooldownResponse(1, '2026-08-05T12:00:01Z'),
      cooldownResponse(2, '2026-08-05T12:00:02Z'),
      cooldownResponse(3, '2026-08-05T12:00:04Z'),
    ];
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      const response = responses[queryCount];
      queryCount++;
      if (!response) throw new Error('Unexpected cooldown query');
      return Promise.resolve(response);
    });

    mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryCount).toBe(1);

    await act(async () => {
      runtimeListeners[0]?.({ type: 'watchChanged' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryCount).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_025);
    });
    expect(queryCount).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(queryCount).toBe(3);

    const root = mountedRoots.pop();
    act(() => root?.unmount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(queryCount).toBe(3);
  });

  it('rechecks the remaining deadline when the wall clock moves backward', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-08-05T12:00:00Z');
    vi.setSystemTime(now);
    const cooldown = cooldownResponse(1, '2026-08-05T12:00:01Z');
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      queryCount++;
      return Promise.resolve(queryCount < 3 ? cooldown : queryResponse(3));
    });

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryCount).toBe(1);

    vi.setSystemTime(now - 1_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_025);
      await Promise.resolve();
    });
    expect(queryCount).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(queryCount).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(queryCount).toBe(3);
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('3');
  });

  it('falls back to empty collapse memory when config hydration fails', async () => {
    watchMocks.bgCall.mockResolvedValue(queryResponse(1));
    watchMocks.getConfig.mockRejectedValue(new Error('storage unavailable'));

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(watchMocks.getConfig).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="collapsed"]')?.textContent?.trim()).toBe('0');
  });

  it('clears optimistic collapse memory when persistence and recovery both fail', async () => {
    watchMocks.bgCall.mockResolvedValue(queryResponse(1));
    watchMocks.getConfig
      .mockResolvedValueOnce({ watchCollapsedRepositories: {} })
      .mockRejectedValueOnce(new Error('storage unavailable'));
    watchMocks.updateWatchRepositoryCollapse.mockRejectedValue(new Error('write failed'));

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await click(container.querySelector<HTMLButtonElement>('[data-testid="collapse"]')!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(watchMocks.updateWatchRepositoryCollapse).toHaveBeenCalledWith(
      'owner/repo',
      'signature',
    );
    expect(watchMocks.getConfig).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="collapsed"]')?.textContent?.trim()).toBe('0');
  });
  it('tracks notification mutations and reloads the authoritative projection', async () => {
    const mutation = deferred<unknown>();
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((
      type: string,
      payload?: { accountLogin?: string; threadIds?: string[] },
    ) => {
      if (type === 'queryWatchInbox') {
        queryCount++;
        return Promise.resolve(queryResponse(queryCount === 1 ? 2 : 1));
      }
      if (type === 'markWatchThreadsRead') {
        expect(payload).toEqual({ accountLogin: 'octocat', threadIds: ['1'] });
        return mutation.promise;
      }
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await click(container.querySelector<HTMLButtonElement>('[data-testid="mark-read"]')!);
    expect(container.querySelector('[data-testid="action-pending"]')?.textContent).toBe('read:1');

    mutation.resolve(undefined);
    await act(async () => {
      await mutation.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="action-pending"]')?.textContent).toBe('none');
    expect(container.querySelector('[data-testid="action-error"]')?.textContent).toBe('none');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1');
  });

  it('chunks a repository action with more than one thousand notifications', async () => {
    const mutationBatches: string[][] = [];
    const mutationAccounts: Array<string | undefined> = [];
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((
      type: string,
      payload?: { accountLogin?: string; threadIds?: string[] },
    ) => {
      if (type === 'queryWatchInbox') {
        queryCount += 1;
        return Promise.resolve(queryResponse(1_001));
      }
      if (type === 'markWatchThreadsDone') {
        const threadIds = payload?.threadIds ?? [];
        mutationAccounts.push(payload?.accountLogin);
        mutationBatches.push(threadIds);
        return threadIds.length <= WATCH_MAX_THREAD_ACTIONS
          ? Promise.resolve(undefined)
          : Promise.reject(new Error('oversized Watch mutation'));
      }
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await click(container.querySelector<HTMLButtonElement>('[data-testid="mark-many-done"]')!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mutationBatches.map((batch) => batch.length)).toEqual([500, 500, 1]);
    expect(mutationBatches.flat()).toEqual(MANY_THREAD_IDS);
    expect(mutationAccounts).toEqual(['octocat', 'octocat', 'octocat']);
    expect(container.querySelector('[data-testid="action-error"]')?.textContent).toBe('none');
    expect(queryCount).toBe(2);
  });

  it('stops remaining chunks when the active GitHub account changes', async () => {
    const firstBatch = deferred<unknown>();
    const mutationRequests: Array<{
      accountLogin: string | undefined;
      threadIds: string[];
    }> = [];
    let activeAccount = 'octocat';
    let queryCount = 0;
    watchMocks.bgCall.mockImplementation((
      type: string,
      payload?: { accountLogin?: string; threadIds?: string[] },
    ) => {
      if (type === 'queryWatchInbox') {
        queryCount += 1;
        return Promise.resolve(queryResponse(1_001, activeAccount));
      }
      if (type === 'markWatchThreadsDone') {
        const request = {
          accountLogin: payload?.accountLogin,
          threadIds: payload?.threadIds ?? [],
        };
        mutationRequests.push(request);
        if (request.accountLogin !== activeAccount) {
          return Promise.reject(new Error('Watch account changed'));
        }
        return mutationRequests.length === 1 ? firstBatch.promise : Promise.resolve(undefined);
      }
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await click(container.querySelector<HTMLButtonElement>('[data-testid="mark-many-done"]')!);
    await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
    expect(mutationRequests[0]).toMatchObject({ accountLogin: 'octocat' });

    activeAccount = 'another-user';
    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials: {
          oldValue: { accountLogin: 'octocat' },
          newValue: { accountLogin: activeAccount },
        },
      }, 'local');
      await Promise.resolve();
      await Promise.resolve();
    });
    firstBatch.resolve(undefined);
    await act(async () => {
      await firstBatch.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mutationRequests).toHaveLength(2);
    expect(mutationRequests.map((request) => request.accountLogin))
      .toEqual(['octocat', 'octocat']);
    expect(mutationRequests.map((request) => request.threadIds.length)).toEqual([500, 500]);
    expect(container.querySelector('[data-testid="action-error"]')?.textContent).toBe('done');
    expect(queryCount).toBe(3);
  });

  it('surfaces a failed done mutation after reloading saved rows', async () => {
    watchMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryWatchInbox') return Promise.resolve(queryResponse(2));
      if (type === 'markWatchThreadsDone') return Promise.reject(new Error('failed'));
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await click(container.querySelector<HTMLButtonElement>('[data-testid="mark-done"]')!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="action-pending"]')?.textContent).toBe('none');
    expect(container.querySelector('[data-testid="action-error"]')?.textContent).toBe('done');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');
  });


  it('removes credential and runtime invalidation listeners on unmount', async () => {
    watchMocks.bgCall.mockResolvedValue(queryResponse(1));
    mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(runtimeListeners).toHaveLength(1);
    expect(storageListeners).toHaveLength(1);

    const root = mountedRoots.pop();
    act(() => root?.unmount());

    expect(runtimeListeners).toHaveLength(0);
    expect(storageListeners).toHaveLength(0);
  });
});
