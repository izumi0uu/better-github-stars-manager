/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStars } from '@/ui/use-stars';
import { ExtensionManagerRuntime } from '@/runtime/extension-manager-runtime';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import { useFilterStore } from '@/ui/filter-store';
import type { Config } from '@/types';
import {
  cleanupMountedRootsAndBody,
  mountReact,
  type MountedRoot,
} from './test-utils';

const authMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateLibraryViewPrefs: vi.fn(),
}));

vi.mock('@/auth/auth-store', () => ({
  CONFIG_STORAGE_KEY: 'gsm_config',
  GITHUB_CREDENTIALS_STORAGE_KEY: 'gsm_github_credentials',
  authStore: {
    getConfig: authMocks.getConfig,
    update: vi.fn((patch: Partial<Config>) => patch.libraryView
      ? authMocks.updateLibraryViewPrefs(patch.libraryView)
      : Promise.resolve()),
  },
}));

const mountedRoots: MountedRoot[] = [];
const storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];
const runtimeListeners: Array<(message: { type?: string }) => void> = [];
const runtime = new ExtensionManagerRuntime();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function baseConfig(): Config {
  return {
    tokenEncrypted: null,
    githubCredentialStatus: null,
    watchNotificationsEnabled: false,
    tokenCryptoMeta: null,
    watchCollapsedRepositories: {},
    agentProvider: {
      provider: 'openai',
      protocol: null,
      baseUrl: null,
      model: 'gpt-5-mini',
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
    username: null,
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
        languages: ['TypeScript'],
        tags: ['react'],
        tagMode: 'all',
        showTombstone: true,
        onlyFavorite: true,
        onlyUntagged: false,
        onlyArchived: true,
        onlyOwned: true,
      },
      sort: {
        sortKey: 'created_at',
        sortDir: 'asc',
      },
    },
    starsPanelDefaultEnabled: true,
    columnLayoutMode: 'default',
    customColumnLayout: null,
    langTagMigrationDone: true,
    lastSyncProgress: { phase: 'idle', done: 0, total: null, message: '' },
    backfills: {},
  };
}

function externalConfig(): Config {
  return {
    ...baseConfig(),
    libraryView: {
      version: 1,
      filters: {
        languages: ['Rust'],
        tags: ['systems'],
        tagMode: 'any',
        showTombstone: false,
        onlyFavorite: false,
        onlyUntagged: true,
        onlyArchived: false,
        onlyOwned: false,
      },
      sort: {
        sortKey: 'name',
        sortDir: 'desc',
      },
    },
  };
}

function emitConfig(config: Config) {
  authMocks.getConfig.mockResolvedValue(config);
  for (const listener of storageListeners) {
    listener({
      gsm_config: { newValue: config } as chrome.storage.StorageChange,
    }, 'local');
  }
}

function resetFilterStore() {
  useFilterStore.setState({
    query: '',
    languages: [],
    tags: [],
    tagMode: 'any',
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    onlyOwned: false,
    sortKey: 'starred_at',
    sortDir: 'desc',
    libraryViewHydrated: false,
  });
}

function StarsProbe({ allowHashTagOverride = true }: Readonly<{ allowHashTagOverride?: boolean }>) {
  useStars(allowHashTagOverride);
  return null;
}

function Harness({ allowHashTagOverride = true }: Readonly<{ allowHashTagOverride?: boolean }> = {}) {
  return (
    <ManagerRuntimeProvider runtime={runtime}>
      <StarsProbe allowHashTagOverride={allowHashTagOverride} />
    </ManagerRuntimeProvider>
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('library view preference persistence', () => {
  beforeEach(() => {
    resetFilterStore();
    authMocks.getConfig.mockReset();
    authMocks.updateLibraryViewPrefs.mockReset();
    storageListeners.length = 0;
    runtimeListeners.length = 0;
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(() => Promise.resolve({
          ok: true,
          data: {
            rows: [],
            total: 0,
            grandTotal: 0,
            tagsForRows: {},
            languages: [],
            tagTree: [],
            tagTotal: 0,
          },
        })),
        onMessage: {
          addListener: vi.fn((listener) => runtimeListeners.push(listener)),
          removeListener: vi.fn((listener) => {
            const index = runtimeListeners.indexOf(listener);
            if (index >= 0) runtimeListeners.splice(index, 1);
          }),
        },
      },
      storage: {
        onChanged: {
          addListener: vi.fn((listener) => storageListeners.push(listener)),
          removeListener: vi.fn((listener) => {
            const index = storageListeners.indexOf(listener);
            if (index >= 0) storageListeners.splice(index, 1);
          }),
        },
      },
    });
    window.history.replaceState(null, '', '/stars');
  });

  afterEach(() => {
    cleanupMountedRootsAndBody(mountedRoots);
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('hydrates before the first visible query and does not persist defaults', async () => {
    authMocks.getConfig.mockResolvedValue(baseConfig());
    mountReact(<Harness />, mountedRoots);

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(authMocks.updateLibraryViewPrefs).not.toHaveBeenCalled();

    await flush();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'query',
      params: {
        filter: {
          query: '',
          languages: ['TypeScript'],
          tags: ['react'],
          tagMode: 'all',
          showTombstone: true,
          onlyFavorite: true,
          onlyUntagged: false,
          onlyArchived: true,
          onlyOwned: true,
          sortKey: 'created_at',
          sortDir: 'asc',
        },
        offset: 0,
        limit: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(authMocks.updateLibraryViewPrefs).not.toHaveBeenCalled();
  });

  it('persists changes after hydration and reset preserves sort and tag mode', async () => {
    authMocks.getConfig.mockResolvedValue(baseConfig());
    mountReact(<Harness />, mountedRoots);
    await flush();

    act(() => {
      useFilterStore.getState().toggleTag('react');
      useFilterStore.getState().resetFilters();
    });
    await flush();

    expect(authMocks.updateLibraryViewPrefs).toHaveBeenLastCalledWith({
      version: 1,
      filters: {
        languages: [],
        tags: [],
        tagMode: 'all',
        showTombstone: false,
        onlyFavorite: false,
        onlyUntagged: false,
        onlyArchived: false,
        onlyOwned: false,
      },
      sort: {
        sortKey: 'created_at',
        sortDir: 'asc',
      },
    });
  });

  it('lets #gsm-tag override persisted tags before the first query', async () => {
    window.history.replaceState(null, '', '/stars#gsm-tag=vue');
    authMocks.getConfig.mockResolvedValue(baseConfig());
    mountReact(<Harness />, mountedRoots);
    await flush();

    const message = vi.mocked(chrome.runtime.sendMessage).mock.calls[0][0] as unknown as {
      params: { filter: { tags: string[]; languages: string[]; sortKey: string } };
    };
    expect(message.params.filter.tags).toEqual(['vue']);
    expect(message.params.filter.languages).toEqual(['TypeScript']);
    expect(message.params.filter.sortKey).toBe('created_at');
    expect(authMocks.updateLibraryViewPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ tags: ['vue'] }),
      }),
    );
  });

  it('does not apply extension hash state when the host disables it', async () => {
    window.history.replaceState(null, '', '/stars#gsm-tag=vue');
    authMocks.getConfig.mockResolvedValue(baseConfig());
    mountReact(<Harness allowHashTagOverride={false} />, mountedRoots);
    await flush();

    const message = vi.mocked(chrome.runtime.sendMessage).mock.calls[0][0] as unknown as {
      params: { filter: { tags: string[]; languages: string[]; sortKey: string } };
    };
    expect(message.params.filter.tags).toEqual(['react']);
    expect(message.params.filter.languages).toEqual(['TypeScript']);
    expect(message.params.filter.sortKey).toBe('created_at');
    expect(authMocks.updateLibraryViewPrefs).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#gsm-tag=vue');
  });

  it('ignores malformed #gsm-tag values without discarding persisted preferences', async () => {
    window.history.replaceState(null, '', '/stars#gsm-tag=%E0%A4%A');
    authMocks.getConfig.mockResolvedValue(baseConfig());
    mountReact(<Harness />, mountedRoots);
    await flush();

    const message = vi.mocked(chrome.runtime.sendMessage).mock.calls[0][0] as unknown as {
      params: { filter: { tags: string[]; languages: string[]; sortKey: string } };
    };
    expect(message.params.filter.tags).toEqual(['react']);
    expect(message.params.filter.languages).toEqual(['TypeScript']);
    expect(message.params.filter.sortKey).toBe('created_at');
    expect(authMocks.updateLibraryViewPrefs).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('applies external storage changes without writing them back', async () => {
    authMocks.getConfig.mockResolvedValue(baseConfig());
    mountReact(<Harness />, mountedRoots);
    await flush();
    authMocks.updateLibraryViewPrefs.mockClear();

    act(() => {
      useFilterStore.getState().setQuery('zustand');
    });

    act(() => {
      emitConfig(externalConfig());
    });
    await flush();

    expect(useFilterStore.getState()).toEqual(expect.objectContaining({
      languages: ['Rust'],
      tags: ['systems'],
      tagMode: 'any',
      onlyUntagged: true,
      sortKey: 'name',
      sortDir: 'desc',
      libraryViewHydrated: true,
    }));
    expect(useFilterStore.getState().query).toBe('zustand');
    expect(authMocks.updateLibraryViewPrefs).not.toHaveBeenCalled();
  });

  it('does not let stale initial hydration overwrite fresher storage changes', async () => {
    const initialConfig = deferred<Config>();
    authMocks.getConfig.mockReturnValue(initialConfig.promise);
    mountReact(<Harness />, mountedRoots);

    act(() => {
      emitConfig(externalConfig());
    });
    await flush();

    act(() => {
      initialConfig.resolve(baseConfig());
    });
    await flush();

    expect(useFilterStore.getState()).toEqual(expect.objectContaining({
      languages: ['Rust'],
      tags: ['systems'],
      onlyUntagged: true,
      sortKey: 'name',
      sortDir: 'desc',
      libraryViewHydrated: true,
    }));
    expect(authMocks.updateLibraryViewPrefs).not.toHaveBeenCalled();
  });

  it('keeps a #gsm-tag override when storage hydration wins the initial race', async () => {
    window.history.replaceState(null, '', '/stars#gsm-tag=vue');
    const initialConfig = deferred<Config>();
    authMocks.getConfig.mockReturnValue(initialConfig.promise);
    mountReact(<Harness />, mountedRoots);

    act(() => {
      emitConfig(externalConfig());
    });
    await flush();

    const message = vi.mocked(chrome.runtime.sendMessage).mock.calls[0][0] as unknown as {
      params: { filter: { tags: string[]; languages: string[]; sortKey: string; onlyUntagged: boolean } };
    };
    expect(message.params.filter.tags).toEqual(['vue']);
    expect(message.params.filter.languages).toEqual(['Rust']);
    expect(message.params.filter.onlyUntagged).toBe(true);
    expect(message.params.filter.sortKey).toBe('name');
    expect(authMocks.updateLibraryViewPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ tags: ['vue'] }),
      }),
    );
    expect(window.location.hash).toBe('');

    act(() => {
      initialConfig.resolve(baseConfig());
    });
    await flush();

    expect(useFilterStore.getState()).toEqual(expect.objectContaining({
      languages: ['Rust'],
      tags: ['vue'],
      onlyUntagged: true,
      sortKey: 'name',
      sortDir: 'desc',
      libraryViewHydrated: true,
    }));
  });
});
