import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionManagerRuntime } from '@/runtime/extension-manager-runtime';
import { DEFAULT_LIBRARY_VIEW_PREFS } from '@/preferences';
import type { Config } from '@/types';
import type { WatchStatus } from '@/watch/watch-contract';

const adapterMocks = vi.hoisted(() => ({
  bgCall: vi.fn(),
  getAccount: vi.fn(),
  getConfig: vi.fn(),
  update: vi.fn(),
  updateWatchRepositoryCollapse: vi.fn(),
}));

vi.mock('@/utils/messaging', () => ({
  bgCall: adapterMocks.bgCall,
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  GITHUB_CREDENTIALS_STORAGE_KEY: 'gsm_github_credentials',
  authStore: {
    getAccount: adapterMocks.getAccount,
    getConfig: adapterMocks.getConfig,
    update: adapterMocks.update,
    updateWatchRepositoryCollapse: adapterMocks.updateWatchRepositoryCollapse,
  },
}));

type RuntimeListener = (message: { type?: string; status?: WatchStatus }) => void;
type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

const runtimeListeners = new Set<RuntimeListener>();
const storageListeners = new Set<StorageListener>();
const runtimeAdd = vi.fn((listener: RuntimeListener) => runtimeListeners.add(listener));
const runtimeRemove = vi.fn((listener: RuntimeListener) => runtimeListeners.delete(listener));
const storageAdd = vi.fn((listener: StorageListener) => storageListeners.add(listener));
const storageRemove = vi.fn((listener: StorageListener) => storageListeners.delete(listener));

const preferences = {
  theme: 'dark',
  locale: 'en',
  radarWindowDays: 30,
  libraryView: DEFAULT_LIBRARY_VIEW_PREFS,
  watchCollapsedRepositories: {},
  columnLayoutMode: 'default',
  customColumnLayout: null,
} satisfies Pick<
  Config,
  | 'theme'
  | 'locale'
  | 'libraryView'
  | 'radarWindowDays'
  | 'watchCollapsedRepositories'
  | 'columnLayoutMode'
  | 'customColumnLayout'
>;

beforeEach(() => {
  adapterMocks.bgCall.mockReset();
  adapterMocks.getAccount.mockReset();
  adapterMocks.getConfig.mockReset();
  adapterMocks.update.mockReset();
  adapterMocks.updateWatchRepositoryCollapse.mockReset();
  runtimeAdd.mockClear();
  runtimeRemove.mockClear();
  storageAdd.mockClear();
  storageRemove.mockClear();
  runtimeListeners.clear();
  storageListeners.clear();
  adapterMocks.getAccount.mockResolvedValue({
    username: 'octocat',
    avatarUrl: 'https://example.test/avatar.png',
    displayName: 'Octo Cat',
    gistId: 'extension-only',
  });
  adapterMocks.getConfig.mockResolvedValue(preferences as unknown as Config);
  adapterMocks.update.mockResolvedValue(undefined);
  adapterMocks.updateWatchRepositoryCollapse.mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: runtimeAdd, removeListener: runtimeRemove },
    },
    storage: {
      onChanged: { addListener: storageAdd, removeListener: storageRemove },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExtensionManagerRuntime', () => {
  it('maps named manager operations to the existing background envelopes without reordering', async () => {
    adapterMocks.bgCall
      .mockResolvedValueOnce({ rows: [], total: 0, grandTotal: 0, tagsForRows: {}, languages: [], tagTree: [], tagTotal: 0 })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ removed: true });
    const runtime = new ExtensionManagerRuntime();
    const params = {
      filter: {
        query: '',
        languages: [],
        tags: [],
        tagMode: 'any' as const,
        showTombstone: false,
        onlyFavorite: false,
        onlyUntagged: false,
        onlyArchived: false,
        onlyOwned: false,
        sortKey: 'starred_at' as const,
        sortDir: 'desc' as const,
      },
      offset: 0,
      limit: 25,
    };

    await runtime.queryStars(params);
    await runtime.setTags('owner/repo', ['work', 'typescript']);
    await runtime.removeVisibleTag('owner/repo', 'work');

    expect(adapterMocks.bgCall.mock.calls).toEqual([
      ['query', { params }],
      ['setTags', { full_name: 'owner/repo', tags: ['work', 'typescript'] }],
      ['removeVisibleTag', { full_name: 'owner/repo', name: 'work' }],
    ]);
  });

  it('maps on-demand owned repository loading to its background command', async () => {
    adapterMocks.bgCall.mockResolvedValue({ added: 2, updated: 3 });
    const runtime = new ExtensionManagerRuntime();

    await expect(runtime.loadOwnedPublicRepositories()).resolves.toEqual({ added: 2, updated: 3 });
    expect(adapterMocks.bgCall).toHaveBeenCalledWith('syncOwnedPublicRepositories');
  });

  it('maps Watch history and visible-load commands to dedicated envelopes', async () => {
    const historyResult = { addedCount: 2, hasMore: true, status: {} };
    adapterMocks.bgCall
      .mockResolvedValueOnce(historyResult)
      .mockResolvedValueOnce('2026-08-16T12:00:00.000Z');
    const runtime = new ExtensionManagerRuntime();

    await expect(runtime.loadOlderWatch()).resolves.toBe(historyResult);
    await expect(runtime.markWatchLoaded()).resolves.toBe('2026-08-16T12:00:00.000Z');
    expect(adapterMocks.bgCall.mock.calls).toEqual([
      ['loadOlderWatchInbox'],
      ['markWatchInboxLoaded'],
    ]);
  });

  it('maps lightweight preferences and strips extension-only account fields', async () => {
    const runtime = new ExtensionManagerRuntime();
    await expect(runtime.getAccount()).resolves.toEqual({
      username: 'octocat',
      avatarUrl: 'https://example.test/avatar.png',
      displayName: 'Octo Cat',
    });
    await expect(runtime.readPreferences()).resolves.toEqual(preferences);
    await runtime.updatePreferences({ theme: 'light' });
    await runtime.updateWatchCollapse('Owner/Repo', 'signature');
    expect(adapterMocks.update).toHaveBeenCalledWith({ theme: 'light' });
    expect(adapterMocks.updateWatchRepositoryCollapse).toHaveBeenCalledWith('Owner/Repo', 'signature');
  });

  it('shares ordered Watch status and invalidations across subscribers and cleans up listeners', () => {
    const runtime = new ExtensionManagerRuntime();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = runtime.subscribe(first);
    const unsubscribeSecond = runtime.subscribe(second);

    expect(runtimeAdd).toHaveBeenCalledTimes(1);
    expect(storageAdd).toHaveBeenCalledTimes(1);
    const watchStatus: WatchStatus = {
      accountLogin: 'octocat',
      hasMainToken: true,
      hasNotificationsToken: true,
      refreshing: true,
      refreshPhase: 'scope',
      scopeStatus: 'fresh',
      inboxStatus: 'fresh',
      state: null,
    };
    for (const listener of runtimeListeners) {
      listener({ type: 'watchStatusChanged', status: watchStatus });
    }
    expect(first).toHaveBeenLastCalledWith({ kind: 'watch-status', epoch: 1, watchStatus });
    expect(second).toHaveBeenLastCalledWith({ kind: 'watch-status', epoch: 1, watchStatus });

    for (const listener of runtimeListeners) listener({ type: 'watchChanged', status: watchStatus });
    expect(first).toHaveBeenLastCalledWith({ kind: 'watch', epoch: 2, watchStatus });
    expect(second).toHaveBeenLastCalledWith({ kind: 'watch', epoch: 2, watchStatus });

    for (const listener of storageListeners) {
      listener({ gsm_config: { oldValue: {}, newValue: {} } }, 'local');
    }
    expect(first).toHaveBeenLastCalledWith({ kind: 'preferences', epoch: 3 });
    expect(second).toHaveBeenLastCalledWith({ kind: 'preferences', epoch: 3 });

    const credential = (tokenEncrypted: string, watchNotificationsEnabled: boolean) => ({
      tokenEncrypted,
      tokenCryptoMeta: { salt: 'salt', iv: 'iv' },
      githubCredentialStatus: 'ready',
      watchNotificationsEnabled,
      username: 'octocat',
    });
    for (const listener of storageListeners) {
      listener({
        gsm_github_credentials: {
          oldValue: credential('cipher-a', true),
          newValue: credential('cipher-a', false),
        },
      }, 'local');
    }
    expect(first).toHaveBeenLastCalledWith({ kind: 'watch', epoch: 4 });
    expect(second).toHaveBeenLastCalledWith({ kind: 'watch', epoch: 4 });

    for (const listener of storageListeners) {
      listener({
        gsm_github_credentials: {
          oldValue: credential('cipher-a', false),
          newValue: credential('cipher-b', false),
        },
      }, 'local');
    }
    expect(first).toHaveBeenLastCalledWith({ kind: 'reset', epoch: 5 });
    expect(second).toHaveBeenLastCalledWith({ kind: 'reset', epoch: 5 });

    unsubscribeFirst();
    expect(runtimeRemove).not.toHaveBeenCalled();
    unsubscribeSecond();
    unsubscribeSecond();
    expect(runtimeRemove).toHaveBeenCalledTimes(1);
    expect(storageRemove).toHaveBeenCalledTimes(1);
    expect(runtimeListeners.size).toBe(0);
    expect(storageListeners.size).toBe(0);
  });
});
