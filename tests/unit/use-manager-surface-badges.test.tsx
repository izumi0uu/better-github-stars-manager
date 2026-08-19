/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useManagerSurfaceBadges } from '@/ui/hooks/use-manager-surface-badges';
import { ExtensionManagerRuntime } from '@/runtime/extension-manager-runtime';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import {
  cleanupMountedRootsAndBody,
  mountReact,
  type MountedRoot,
} from './test-utils';

const badgeMocks = vi.hoisted(() => ({
  bgCall: vi.fn(),
}));

type RuntimeListener = (message: { type?: string }) => void;
type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

const runtimeListeners: RuntimeListener[] = [];
const storageListeners: StorageListener[] = [];
const mountedRoots: MountedRoot[] = [];

vi.mock('@/utils/messaging', () => ({
  bgCall: badgeMocks.bgCall,
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  GITHUB_CREDENTIALS_STORAGE_KEY: 'gsm_github_credentials',
  authStore: {},
}));

const runtime = new ExtensionManagerRuntime();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function storedCredential(username: string, tokenEncrypted = 'cipher') {
  return {
    username,
    tokenEncrypted,
    tokenCryptoMeta: { salt: 'salt', iv: 'iv' },
    githubCredentialStatus: 'ready',
    watchNotificationsEnabled: true,
  };
}

function BadgeProbe() {
  const counts = useManagerSurfaceBadges();
  return (
    <div data-testid="counts" data-watch={counts.watchUnreadCount} data-radar={counts.radarUnseenCount} />
  );
}

function Harness() {
  return <ManagerRuntimeProvider runtime={runtime}><BadgeProbe /></ManagerRuntimeProvider>;
}

beforeEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  badgeMocks.bgCall.mockReset();
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
  vi.unstubAllGlobals();
});

describe('useManagerSurfaceBadges', () => {
  it('loads both counts before either full surface is activated', async () => {
    badgeMocks.bgCall.mockResolvedValue({ watchUnreadCount: 4, radarUnseenCount: 7 });
    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => Promise.resolve());

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="counts"]')).toMatchObject({
        dataset: expect.objectContaining({ watch: '4', radar: '7' }),
      });
    });
    expect(badgeMocks.bgCall).toHaveBeenCalledWith('queryManagerSurfaceBadges');
  });

  it('refreshes for domain broadcasts and Watch capability changes while ignoring stale replies', async () => {
    const initial = deferred<{ watchUnreadCount: number; radarUnseenCount: number }>();
    const broadcast = deferred<{ watchUnreadCount: number; radarUnseenCount: number }>();
    badgeMocks.bgCall
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(broadcast.promise)
      .mockResolvedValueOnce({ watchUnreadCount: 8, radarUnseenCount: 9 });
    const container = mountReact(<Harness />, mountedRoots);

    await act(async () => {
      runtimeListeners[0]?.({ type: 'watchChanged' });
      broadcast.resolve({ watchUnreadCount: 5, radarUnseenCount: 6 });
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="counts"]')?.getAttribute('data-watch')).toBe('5');
    });

    await act(async () => {
      initial.resolve({ watchUnreadCount: 1, radarUnseenCount: 2 });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="counts"]')).toMatchObject({
      dataset: expect.objectContaining({ watch: '5', radar: '6' }),
    });

    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials: {
          oldValue: storedCredential('octocat'),
          newValue: { ...storedCredential('octocat'), watchNotificationsEnabled: false },
        },
      }, 'local');
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="counts"]')).toMatchObject({
        dataset: expect.objectContaining({ watch: '8', radar: '9' }),
      });
    });
    expect(badgeMocks.bgCall).toHaveBeenCalledTimes(3);
  });

  it('clears old-account counts when credential reload fails and ignores an older reply', async () => {
    const staleReload = deferred<{ watchUnreadCount: number; radarUnseenCount: number }>();
    badgeMocks.bgCall
      .mockResolvedValueOnce({ watchUnreadCount: 4, radarUnseenCount: 7 })
      .mockReturnValueOnce(staleReload.promise)
      .mockRejectedValueOnce(new Error('background unavailable'));
    const container = mountReact(<Harness />, mountedRoots);
    await act(async () => Promise.resolve());

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="counts"]')).toMatchObject({
        dataset: expect.objectContaining({ watch: '4', radar: '7' }),
      });
    });
    await act(async () => {
      runtimeListeners[0]?.({ type: 'watchChanged' });
      await Promise.resolve();
    });
    await act(async () => {
      storageListeners[0]?.({
        gsm_github_credentials: {
          oldValue: storedCredential('a', 'cipher-a'),
          newValue: storedCredential('b', 'cipher-b'),
        },
      }, 'local');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="counts"]')).toMatchObject({
      dataset: expect.objectContaining({ watch: '0', radar: '0' }),
    });
    await act(async () => {
      staleReload.resolve({ watchUnreadCount: 9, radarUnseenCount: 10 });
      await staleReload.promise;
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="counts"]')).toMatchObject({
      dataset: expect.objectContaining({ watch: '0', radar: '0' }),
    });
  });
});
