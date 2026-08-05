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
      accountLogin: 'idah',
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
    accountLogin: 'idah',
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
      <button type="button" data-testid="refresh" onClick={() => void inbox.refresh()}>
        Refresh
      </button>
      <span data-testid="mode">{inbox.unreadOnly ? 'unread' : 'all'}</span>
      <span data-testid="loading">{inbox.loading ? 'loading' : 'ready'}</span>
      <span data-testid="count">{inbox.result?.totalCount ?? 'none'}</span>
    </div>
  );
}

const mountedRoots: MountedRoot[] = [];

beforeEach(() => {
  watchMocks.bgCall.mockReset();
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
  it('uses the latest Unread/All mode after an in-flight refresh completes', async () => {
    const refresh = deferred<unknown>();
    const queryModes: boolean[] = [];
    watchMocks.bgCall.mockImplementation((type: string, payload?: { unreadOnly?: boolean }) => {
      if (type === 'refreshWatchInbox') return refresh.promise;
      if (type === 'queryWatchInbox') {
        const unreadOnly = payload?.unreadOnly ?? true;
        queryModes.push(unreadOnly);
        return Promise.resolve(queryResponse(unreadOnly ? 1 : 2));
      }
      throw new Error(`Unexpected request: ${type}`);
    });

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1');

    await click(container.querySelector<HTMLButtonElement>('[data-testid="refresh"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="all"]')!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe('all');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');

    await act(async () => {
      refresh.resolve({});
      await refresh.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryModes).toEqual([true, false, false]);
    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe('all');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
  });

  it('marks a projection mode change as loading until the new query commits', async () => {
    const allQuery = deferred<WatchInboxQueryResponse>();
    watchMocks.bgCall.mockImplementation((type: string, payload?: { unreadOnly?: boolean }) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      return payload?.unreadOnly === false
        ? allQuery.promise
        : Promise.resolve(queryResponse(1));
    });

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await click(container.querySelector<HTMLButtonElement>('[data-testid="all"]')!);

    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('loading');

    await act(async () => {
      allQuery.resolve(queryResponse(2));
      await allQuery.promise;
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');
  });

  it('silently reloads when the authoritative GitHub credential record changes', async () => {
    const credentialQuery = deferred<WatchInboxQueryResponse>();
    const queryModes: boolean[] = [];
    watchMocks.bgCall.mockImplementation((
      type: string,
      payload?: { unreadOnly?: boolean },
    ) => {
      if (type !== 'queryWatchInbox') throw new Error(`Unexpected request: ${type}`);
      const mode = payload?.unreadOnly ?? true;
      queryModes.push(mode);
      if (queryModes.length === 3) return credentialQuery.promise;
      return Promise.resolve(queryResponse(queryModes.length));
    });

    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1');
    expect(storageListeners).toHaveLength(1);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="all"]')!);
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');

    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials_v1: { newValue: {} },
      }, 'sync');
      storageListeners[0]?.({
        gsm_config: { newValue: {} },
      }, 'local');
      await Promise.resolve();
    });
    expect(queryModes).toEqual([true, false]);

    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials_v1: {
          oldValue: { watchNotificationsTokenEncrypted: null },
          newValue: { watchNotificationsTokenEncrypted: 'ciphertext' },
        },
      }, 'local');
      await Promise.resolve();
    });

    expect(queryModes).toEqual([true, false, false]);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('2');

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
