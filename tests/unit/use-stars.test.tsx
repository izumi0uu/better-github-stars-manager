/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIBRARY_VIEW_PREFS } from '@/preferences';
import type {
  ManagerPreferences,
  ManagerRuntime,
  ManagerRuntimeListener,
  OwnedPublicRepositoryLoadResult,
} from '@/runtime/manager-runtime';
import type { StarsQueryParams, StarsQueryResult } from '@/stars/stars-query';
import { useFilterStore } from '@/ui/filter-store';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import { useStars } from '@/ui/use-stars';
import {
  cleanupMountedRootsAndBody,
  click,
  fakeStar,
  mountReact,
  type MountedRoot,
} from './test-utils';

const roots: MountedRoot[] = [];

const emptyStarsResult: StarsQueryResult = {
  rows: [],
  total: 0,
  grandTotal: 0,
  tagsForRows: {},
  languages: [],
  tagTree: [],
  tagTotal: 0,
};

function preferences(onlyOwned: boolean): ManagerPreferences {
  return {
    theme: 'dark',
    locale: 'en',
    radarWindowDays: 30,
    libraryView: {
      ...DEFAULT_LIBRARY_VIEW_PREFS,
      filters: {
        ...DEFAULT_LIBRARY_VIEW_PREFS.filters,
        onlyOwned,
      },
    },
    watchCollapsedRepositories: {},
    columnLayoutMode: 'default',
    customColumnLayout: null,
  };
}
function createRuntime(onlyOwned: boolean) {
  const listeners = new Set<ManagerRuntimeListener>();
  let resolveOwned: ((result: OwnedPublicRepositoryLoadResult) => void) | null = null;
  const ownedLoad = new Promise<OwnedPublicRepositoryLoadResult>((resolve) => {
    resolveOwned = resolve;
  });
  const queryStars = vi.fn(async (_params: StarsQueryParams) => emptyStarsResult);
  const loadOwnedPublicRepositories = vi.fn(() => ownedLoad);
  const unused = async () => {
    throw new Error('Unused runtime operation');
  };
  const runtime: ManagerRuntime = {
    resources: {
      resolveImage: ({ remoteUrl }) => remoteUrl,
      resolveLink: ({ remoteUrl }) => remoteUrl,
      onBlockedLink: () => {},
    },
    now: () => Date.parse('2026-08-16T12:00:00Z'),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAccount: async () => ({ username: 'synthetic-user', avatarUrl: null, displayName: 'Synthetic User' }),
    readPreferences: async () => preferences(onlyOwned),
    updatePreferences: unused,
    queryStars,
    loadOwnedPublicRepositories,
    querySurfaceBadges: unused,
    listExcludedTags: unused,
    setTags: unused,
    setNotes: unused,
    setFavorite: unused,
    markUnstarred: unused,
    removeVisibleTag: unused,
    deleteTag: unused,
    deleteAllTags: unused,
    queryWatchInbox: unused,
    getWatchRepositoryDetail: unused,
    getWatchSubjectDetail: unused,
    refreshWatch: unused,
    loadOlderWatch: unused,
    markWatchLoaded: unused,
    markWatchThreadsRead: unused,
    markWatchThreadsDone: unused,
    updateWatchCollapse: unused,
    queryRadar: unused,
    refreshRadar: unused,
    fullReconcileRadar: unused,
    markRadarActivitiesSeen: unused,
    dismissRadarActivities: unused,
    queryRecommendations: unused,
    refreshRecommendations: unused,
    ignoreRecommendation: unused,
    restoreIgnoredRecommendation: unused,
    starRepository: unused,
    addRepositoryTag: unused,
    reset: unused,
  };
  return {
    runtime,
    queryStars,
    loadOwnedPublicRepositories,
    resolveOwned: (result: OwnedPublicRepositoryLoadResult) => resolveOwned?.(result),
    emit: (kind: Parameters<ManagerRuntimeListener>[0]['kind']) => {
      for (const listener of [...listeners]) listener({ kind, epoch: 1 });
    },
  };
}

function Harness() {
  const stars = useStars();
  return (
    <div data-phase={stars.phase} data-loading={stars.loading} data-error={stars.error ?? ''}>
      {stars.rows.map((row) => <span key={row.full_name}>{row.full_name}</span>)}
      <button type="button" onClick={stars.refresh}>Retry</button>
    </div>
  );
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function flushTimer() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
afterEach(() => {
  vi.useRealTimers();
  cleanupMountedRootsAndBody(roots);
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
});

describe('useStars owned-repository loading', () => {
  it('renders starred rows without waiting for owned repository hydration', async () => {
    const manager = createRuntime(false);
    mountReact(
      <ManagerRuntimeProvider runtime={manager.runtime}>
        <Harness />
      </ManagerRuntimeProvider>,
      roots,
    );

    await flushEffects();

    expect(manager.queryStars).toHaveBeenCalledTimes(1);
    expect(manager.queryStars.mock.calls[0]?.[0].filter.onlyOwned).toBe(false);
    expect(manager.queryStars.mock.invocationCallOrder[0]).toBeLessThan(
      manager.loadOwnedPublicRepositories.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await flushTimer();
    expect(manager.loadOwnedPublicRepositories).toHaveBeenCalledTimes(1);
  });

  it('refreshes an owned view after silent hydration invalidates the query', async () => {
    const manager = createRuntime(true);
    mountReact(
      <ManagerRuntimeProvider runtime={manager.runtime}>
        <Harness />
      </ManagerRuntimeProvider>,
      roots,
    );

    await flushEffects();
    expect(manager.queryStars).toHaveBeenCalledTimes(1);
    expect(manager.queryStars.mock.calls[0]?.[0].filter.onlyOwned).toBe(true);
    expect(manager.queryStars.mock.invocationCallOrder[0]).toBeLessThan(
      manager.loadOwnedPublicRepositories.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await flushTimer();
    expect(manager.loadOwnedPublicRepositories).toHaveBeenCalledTimes(1);

    await act(async () => {
      manager.resolveOwned({ added: 1, updated: 0 });
      manager.emit('data');
      await Promise.resolve();
    });

    expect(manager.queryStars).toHaveBeenCalledTimes(2);
    expect(manager.queryStars.mock.calls[1]?.[0].filter.onlyOwned).toBe(true);
  });
});

describe('Stars query terminal ownership', () => {
  it('retains committed rows, exits fading-out on failure, and retries the current query', async () => {
    vi.useFakeTimers();
    const manager = createRuntime(false);
    const committed = { ...emptyStarsResult, rows: [fakeStar()], total: 1, grandTotal: 1 };
    manager.queryStars.mockResolvedValueOnce(committed);
    const container = mountReact(
      <ManagerRuntimeProvider runtime={manager.runtime}><Harness /></ManagerRuntimeProvider>, roots,
    );
    await flushEffects();
    manager.queryStars.mockRejectedValueOnce(new Error('QUERY_UNAVAILABLE'));
    act(() => useFilterStore.getState().setQuery('new query'));
    expect(container.firstElementChild?.getAttribute('data-phase')).toBe('fading-out');
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(container.firstElementChild?.getAttribute('data-phase')).toBe('idle');
    expect(container.firstElementChild?.getAttribute('data-loading')).toBe('false');
    expect(container.firstElementChild?.getAttribute('data-error')).toBe('query');
    expect(container.textContent).toContain('owner/repo');

    manager.queryStars.mockResolvedValueOnce({ ...emptyStarsResult, rows: [fakeStar({ full_name: 'owner/new' })] });
    await click(container.querySelector('button')!);
    expect(container.firstElementChild?.getAttribute('data-error')).toBe('');
    expect(container.firstElementChild?.getAttribute('data-phase')).toBe('idle');
    expect(container.textContent).toContain('owner/new');
    expect(manager.queryStars.mock.lastCall?.[0].filter.query).toBe('new query');
  });

  it.each(['success', 'failure'] as const)('ignores a stale %s after a newer query commits', async (settlement) => {
    vi.useFakeTimers();
    const manager = createRuntime(false);
    const container = mountReact(
      <ManagerRuntimeProvider runtime={manager.runtime}><Harness /></ManagerRuntimeProvider>, roots,
    );
    await flushEffects();
    const { promise, resolve, reject } = Promise.withResolvers<StarsQueryResult>();
    manager.queryStars.mockReturnValueOnce(promise);
    act(() => useFilterStore.getState().setQuery('old'));
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    manager.queryStars.mockResolvedValueOnce({ ...emptyStarsResult, rows: [fakeStar({ full_name: 'owner/current' })] });
    act(() => useFilterStore.getState().setQuery('current'));
    await act(async () => { await vi.advanceTimersByTimeAsync(280); });
    await act(async () => {
      if (settlement === 'failure') reject(new Error('OLD_QUERY_FAILED'));
      else resolve({ ...emptyStarsResult, rows: [fakeStar({ full_name: 'owner/stale' })] });
      await Promise.resolve();
    });
    expect(container.firstElementChild?.getAttribute('data-phase')).toBe('idle');
    expect(container.firstElementChild?.getAttribute('data-error')).toBe('');
    expect(container.textContent).toContain('owner/current');
    expect(container.textContent).not.toContain('owner/stale');
  });
});
