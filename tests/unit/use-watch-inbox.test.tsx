/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWatchInbox } from '@/ui/hooks/use-watch-inbox';
import type { WatchInboxQueryResponse } from '@/watch/watch-contract';
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

type RuntimeListener = (message: { type?: string }) => void;
type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

const runtimeListeners: RuntimeListener[] = [];
const storageListeners: StorageListener[] = [];

vi.mock('@/utils/messaging', () => ({
  bgCall: watchMocks.bgCall,
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  GITHUB_CREDENTIALS_STORAGE_KEY: 'gsm_github_credentials_v1',
  authStore: {
    getConfig: watchMocks.getConfig,
    updateWatchRepositoryCollapse: watchMocks.updateWatchRepositoryCollapse,
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function queryResponse(totalCount: number): WatchInboxQueryResponse {
  return {
    threads: [],
    groups: [],
    unreadCount: totalCount,
    totalCount,
    status: {
      accountLogin: 'octocat',
      credentialSource: 'main',
      hasMainToken: true,
      hasNotificationsToken: true,
      refreshing: false,
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
    },
  };
  return response;
}

function Harness() {
  const inbox = useWatchInbox();
  return (
    <div>
      <button type="button" data-testid="all" onClick={() => inbox.setUnreadOnly(false)}>
        All
      </button>
      <button type="button" data-testid="unread" onClick={() => inbox.setUnreadOnly(true)}>
        Unread
      </button>
      <button type="button" data-testid="refresh" onClick={() => void inbox.refresh()}>
        Refresh
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
        data-testid="collapse"
        onClick={() => inbox.updateRepositoryCollapse('owner/repo', 'signature')}
      >
        Collapse
      </button>
      <span data-testid="mode">{inbox.unreadOnly ? 'unread' : 'all'}</span>
      <span data-testid="loading">{inbox.loading ? 'loading' : 'ready'}</span>
      <span data-testid="count">{inbox.result?.totalCount ?? 'none'}</span>
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

  it('silently reloads only when the authoritative GitHub credential record changes', async () => {
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
        gsm_github_credentials_v1: { newValue: {} },
      }, 'sync');
      storageListeners[0]?.({
        gsm_config: { newValue: { watchCollapsedRepositories: { 'owner/repo': 'signature' } } },
      }, 'local');
      await Promise.resolve();
    });
    expect(queryModes).toEqual([false]);

    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials_v1: {
          oldValue: { watchNotificationsTokenEncrypted: null },
          newValue: { watchNotificationsTokenEncrypted: 'ciphertext' },
        },
      }, 'local');
      await Promise.resolve();
    });

    expect(queryModes).toEqual([false, false]);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1');

    await act(async () => {
      credentialQuery.resolve(queryResponse(3));
      await credentialQuery.promise;
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('3');
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
    watchMocks.bgCall.mockImplementation((type: string, payload?: { threadIds?: string[] }) => {
      if (type === 'queryWatchInbox') {
        queryCount++;
        return Promise.resolve(queryResponse(queryCount === 1 ? 2 : 1));
      }
      if (type === 'markWatchThreadsRead') {
        expect(payload?.threadIds).toEqual(['1']);
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
