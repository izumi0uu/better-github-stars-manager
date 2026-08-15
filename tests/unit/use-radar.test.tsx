/**
 * @vitest-environment jsdom
 */
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRadar } from '@/ui/hooks/use-radar';
import type { RadarQueryResponse, RadarRefreshResult, RadarStatus } from '@/radar/radar-contract';
import type { RadarActivityPresentation } from '@/radar/radar-model';
import type {
  RecommendationQueryResponse,
  RecommendationRefreshResult,
} from '@/recommendations/recommendation-model';
import { cleanupMountedRootsAndBody, mountReact, type MountedRoot } from './test-utils';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const radarMocks = vi.hoisted(() => ({ bgCall: vi.fn() }));
type RuntimeListener = (message: { type?: string }) => void;
type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;
const runtimeListeners: RuntimeListener[] = [];
const storageListeners: StorageListener[] = [];

vi.mock('@/utils/messaging', () => ({ bgCall: radarMocks.bgCall }));

vi.mock('@/auth/auth-store', () => ({
  GITHUB_CREDENTIALS_STORAGE_KEY: 'gsm_github_credentials',
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function response(overrides: Partial<RadarQueryResponse['status']> = {}): RadarQueryResponse {
  return {
    activities: [],
    unseenCount: 0,
    status: {
      accountLogin: 'viewer',
      hasMainToken: true,
      refreshing: false,
      snapshotStatus: 'fresh',
      errorCode: null,
      state: null,
      ...overrides,
    },
  };
}

function refreshResponse(overrides: Partial<RadarRefreshResult> = {}): RadarRefreshResult {
  return {
    published: true,
    status: response().status,
    ...overrides,
  };
}

function recommendationResponse(
  overrides: Partial<RecommendationQueryResponse['status']> = {},
): RecommendationQueryResponse {
  return {
    recommendations: [],
    ignored: [],
    status: {
      accountLogin: 'viewer',
      hasMainToken: true,
      refreshing: false,
      snapshotStatus: 'fresh',
      errorCode: null,
      state: null,
      ...overrides,
    },
  };
}

const unseenActivity = {
  id: 'activity-1',
  accountLogin: 'viewer',
  actorLogin: 'friend',
  actorAvatarUrl: null,
  repositoryKey: 'owner/repo',
  repositoryFullName: 'owner/repo',
  repositoryDisplayName: 'owner/repo',
  repositoryHtmlUrl: 'https://github.com/owner/repo',
  repositoryDescription: '',
  repositoryLanguage: null,
  repositoryLanguageColor: null,
  repositoryStargazerCount: 1,
  viewerHadStarred: false,
  repositoryTopics: [],
  starredAt: '2026-08-10T10:00:00.000Z',
  dismissedAt: null,
  seenAt: null,
  source: 'following',
  seen: false,
  viewerHasStarred: false,
  favorite: false,
  tags: [],
  suggestedTags: [],
  displayedStargazerCount: 1,
} satisfies RadarActivityPresentation;

function Harness({ initialActive = true }: { initialActive?: boolean } = {}) {
  const [active, setActive] = useState(initialActive);
  const radar = useRadar({ active });
  return (
    <div>
      <button type="button" data-testid="activate" onClick={() => setActive(true)}>
        Activate
      </button>
      <button type="button" data-testid="deactivate" onClick={() => setActive(false)}>
        Deactivate
      </button>
      <button type="button" data-testid="refresh" onClick={() => void radar.refresh()}>Refresh</button>
      <button
        type="button"
        data-testid="refresh-recommendations"
        onClick={() => void radar.refreshRecommendations()}
      >
        Refresh recommendations
      </button>
      <button
        type="button"
        data-testid="show-self"
        onClick={() => radar.setSourceEnabled('self', true)}
      >
        Show self
      </button>
      <button type="button" data-testid="mark-seen" onClick={() => radar.markSeen(['activity-1'])}>
        Mark seen
      </button>
      <button
        type="button"
        data-testid="star"
        onClick={() => void radar.star('owner/repo', 'owner/repo')}
      >
        Star
      </button>
      <button
        type="button"
        data-testid="unstar"
        onClick={() => void radar.unstar('owner/repo', 'owner/repo')}
      >
        Unstar
      </button>
      <span data-testid="active">{active ? 'active' : 'dormant'}</span>
      <span data-testid="loading">{radar.loading ? 'loading' : 'ready'}</span>
      <span data-testid="refreshing">{radar.refreshing ? 'refreshing' : 'idle'}</span>
      <span data-testid="error">{radar.error ?? 'none'}</span>
      <span data-testid="pending-action">{radar.pendingAction?.kind ?? 'none'}</span>
      <span data-testid="status">{radar.result?.status.snapshotStatus ?? 'none'}</span>
      <span data-testid="count">{radar.result?.activities.length ?? 'none'}</span>
      <span data-testid="unseen">{radar.result?.unseenCount ?? 'none'}</span>
      <span data-testid="first-seen">{radar.result?.activities[0]?.seen ? 'seen' : 'unseen'}</span>
      <span data-testid="sources">
        {radar.sources.following ? 'following:on' : 'following:off'}·
        {radar.sources.self ? 'self:on' : 'self:off'}
      </span>
      <span data-testid="recommendation-loading">
        {radar.recommendationLoading ? 'loading' : 'ready'}
      </span>
      <span data-testid="recommendation-refreshing">
        {radar.recommendationRefreshing ? 'refreshing' : 'idle'}
      </span>
      <span data-testid="recommendation-error">{radar.recommendationError ?? 'none'}</span>
      <span data-testid="recommendation-status">
        {radar.recommendations?.status.snapshotStatus ?? 'none'}
      </span>
    </div>
  );
}

const mountedRoots: MountedRoot[] = [];

beforeEach(() => {
  radarMocks.bgCall.mockReset();
  radarMocks.bgCall.mockImplementation((type: string) => {
    if (type === 'queryRadar') return Promise.resolve(response());
    if (type === 'queryRecommendations') return Promise.resolve(recommendationResponse());
    throw new Error(`Unexpected request: ${type}`);
  });
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useRadar', () => {
  it('stays dormant without querying either resource', async () => {
    const container = mountReact(<Harness initialActive={false} />, mountedRoots);

    await act(async () => {
      await Promise.resolve();
      runtimeListeners[0]?.({ type: 'dataChanged' });
      await Promise.resolve();
    });

    expect(radarMocks.bgCall).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="active"]')?.textContent).toBe('dormant');
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="recommendation-loading"]')?.textContent)
      .toBe('ready');
  });

  it('starts both first-load queries together and only once on activation', async () => {
    const radarQuery = deferred<RadarQueryResponse>();
    const recommendationQuery = deferred<RecommendationQueryResponse>();
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') return radarQuery.promise;
      if (type === 'queryRecommendations') return recommendationQuery.promise;
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness initialActive={false} />, mountedRoots);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="activate"]')?.click();
    });

    expect(radarMocks.bgCall.mock.calls.map(([type]) => type).sort()).toEqual([
      'queryRadar',
      'queryRecommendations',
    ]);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('loading');
    expect(container.querySelector('[data-testid="recommendation-loading"]')?.textContent)
      .toBe('loading');

    await act(async () => {
      radarQuery.resolve(response());
      recommendationQuery.resolve(recommendationResponse());
      await Promise.all([radarQuery.promise, recommendationQuery.promise]);
      await Promise.resolve();
    });

    expect(radarMocks.bgCall).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="recommendation-loading"]')?.textContent)
      .toBe('ready');
  });

  it('clears both account-bound projections when credential reloads fail', async () => {
    const radarReload = deferred<RadarQueryResponse>();
    const recommendationReload = deferred<RecommendationQueryResponse>();
    let radarQueries = 0;
    let recommendationQueries = 0;
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') {
        radarQueries += 1;
        return radarQueries === 1
          ? Promise.resolve({ ...response(), activities: [unseenActivity], unseenCount: 1 })
          : radarReload.promise;
      }
      if (type === 'queryRecommendations') {
        recommendationQueries += 1;
        return recommendationQueries === 1
          ? Promise.resolve(recommendationResponse())
          : recommendationReload.promise;
      }
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness />, mountedRoots);
    await settle();
    expect(container.querySelector('[data-testid="unseen"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="recommendation-status"]')?.textContent)
      .toBe('fresh');

    act(() => {
      storageListeners[0]?.({
        gsm_github_credentials: { oldValue: { accountLogin: 'a' }, newValue: { accountLogin: 'b' } },
      }, 'local');
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('none');
    expect(container.querySelector('[data-testid="recommendation-status"]')?.textContent)
      .toBe('none');
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('loading');

    await act(async () => {
      radarReload.reject(new Error('background unavailable'));
      recommendationReload.reject(new Error('background unavailable'));
      await Promise.allSettled([radarReload.promise, recommendationReload.promise]);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('none');
    expect(container.querySelector('[data-testid="recommendation-status"]')?.textContent)
      .toBe('none');
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('query');
    expect(container.querySelector('[data-testid="recommendation-error"]')?.textContent)
      .toBe('query');
  });

  it('preserves both cached projections during one silent reactivation query each', async () => {
    const radarReactivation = deferred<RadarQueryResponse>();
    const recommendationReactivation = deferred<RecommendationQueryResponse>();
    let radarQueries = 0;
    let recommendationQueries = 0;
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') {
        radarQueries += 1;
        return radarQueries === 1
          ? Promise.resolve(response({ snapshotStatus: 'fresh' }))
          : radarReactivation.promise;
      }
      if (type === 'queryRecommendations') {
        recommendationQueries += 1;
        return recommendationQueries === 1
          ? Promise.resolve(recommendationResponse({ snapshotStatus: 'fresh' }))
          : recommendationReactivation.promise;
      }
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness />, mountedRoots);
    await settle();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="deactivate"]')?.click();
    });
    await act(async () => {
      runtimeListeners[0]?.({ type: 'dataChanged' });
      await Promise.resolve();
    });
    expect(radarQueries).toBe(1);
    expect(recommendationQueries).toBe(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="activate"]')?.click();
    });
    await settle();

    expect(radarQueries).toBe(2);
    expect(recommendationQueries).toBe(2);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('fresh');
    expect(container.querySelector('[data-testid="recommendation-status"]')?.textContent)
      .toBe('fresh');
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');
    expect(container.querySelector('[data-testid="recommendation-loading"]')?.textContent)
      .toBe('ready');

    await act(async () => {
      radarReactivation.resolve(response({ snapshotStatus: 'partial' }));
      recommendationReactivation.resolve(recommendationResponse({ snapshotStatus: 'stale' }));
      await Promise.all([radarReactivation.promise, recommendationReactivation.promise]);
      await Promise.resolve();
    });
    expect(radarQueries).toBe(2);
    expect(recommendationQueries).toBe(2);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('partial');
    expect(container.querySelector('[data-testid="recommendation-status"]')?.textContent)
      .toBe('stale');
  });

  it('defaults to Following and enables Me without a background request', async () => {
    const container = mountReact(<Harness />, mountedRoots);
    await settle();

    expect(container.querySelector('[data-testid="sources"]')?.textContent)
      .toBe('following:on·self:off');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="show-self"]')?.click();
    });
    expect(container.querySelector('[data-testid="sources"]')?.textContent)
      .toBe('following:on·self:on');
    expect(radarMocks.bgCall).toHaveBeenCalledTimes(2);
  });

  it('keeps old Following data and exposes a refresh error when publication fails', async () => {
    const loaded = response();
    const failed = response({ snapshotStatus: 'stale', errorCode: 'network_error' });
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') return Promise.resolve(loaded);
      if (type === 'queryRecommendations') return Promise.resolve(recommendationResponse());
      if (type === 'refreshRadar') {
        return Promise.resolve(refreshResponse({ published: false, status: failed.status }));
      }
      throw new Error(`Unexpected request: ${type}`);
    });

    const container = mountReact(<Harness />, mountedRoots);
    await settle();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="refresh"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('refresh');
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('fresh');
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('0');
    expect(container.querySelector('[data-testid="refreshing"]')?.textContent).toBe('idle');
  });

  it('keeps saved recommendations when refresh cannot publish', async () => {
    const loaded = recommendationResponse();
    const failed = recommendationResponse({ snapshotStatus: 'stale', errorCode: 'network_error' });
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') return Promise.resolve(response());
      if (type === 'queryRecommendations') return Promise.resolve(loaded);
      if (type === 'refreshRecommendations') {
        return Promise.resolve({ published: false, status: failed.status } satisfies RecommendationRefreshResult);
      }
      throw new Error(`Unexpected request: ${type}`);
    });

    const container = mountReact(<Harness />, mountedRoots);
    await settle();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="refresh-recommendations"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="recommendation-error"]')?.textContent)
      .toBe('refresh');
    expect(container.querySelector('[data-testid="recommendation-status"]')?.textContent)
      .toBe('fresh');
    expect(container.querySelector('[data-testid="recommendation-refreshing"]')?.textContent)
      .toBe('idle');
  });

  it('reloads authoritative projections for their broadcasts and cleans listeners', async () => {
    let radarQueries = 0;
    let recommendationQueries = 0;
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') {
        radarQueries += 1;
        return Promise.resolve(response({ snapshotStatus: radarQueries === 1 ? 'fresh' : 'partial' }));
      }
      if (type === 'queryRecommendations') {
        recommendationQueries += 1;
        return Promise.resolve(recommendationResponse({
          snapshotStatus: recommendationQueries === 1 ? 'fresh' : 'stale',
        }));
      }
      throw new Error(`Unexpected request: ${type}`);
    });

    const container = mountReact(<Harness />, mountedRoots);
    await settle();
    expect(runtimeListeners).toHaveLength(1);
    expect(storageListeners).toHaveLength(1);

    await act(async () => {
      runtimeListeners[0]?.({ type: 'recommendationsChanged' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(radarQueries).toBe(1);
    expect(recommendationQueries).toBe(2);
    expect(container.querySelector('[data-testid="recommendation-status"]')?.textContent)
      .toBe('stale');

    await act(async () => {
      runtimeListeners[0]?.({ type: 'dataChanged' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(radarQueries).toBe(2);
    expect(recommendationQueries).toBe(3);

    act(() => {
      mountedRoots.pop()?.unmount();
    });
    expect(runtimeListeners).toHaveLength(0);
    expect(storageListeners).toHaveLength(0);
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
  });

  it('projects seen immediately and reconciles with the authoritative query', async () => {
    const initial = { ...response(), activities: [unseenActivity], unseenCount: 1 };
    const authoritative = {
      ...initial,
      activities: [{ ...unseenActivity, seen: true, seenAt: '2026-08-11T10:00:00.000Z' }],
      unseenCount: 0,
    };
    let resolveMark!: (value: RadarStatus) => void;
    let queries = 0;
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') {
        queries += 1;
        return Promise.resolve(queries === 1 ? initial : authoritative);
      }
      if (type === 'queryRecommendations') return Promise.resolve(recommendationResponse());
      if (type === 'markRadarActivitiesSeen') {
        return new Promise<RadarStatus>((resolve) => { resolveMark = resolve; });
      }
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness />, mountedRoots);
    await settle();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mark-seen"]')?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="unseen"]')?.textContent).toBe('0');
    expect(container.querySelector('[data-testid="first-seen"]')?.textContent).toBe('seen');
    expect(radarMocks.bgCall).toHaveBeenCalledWith(
      'markRadarActivitiesSeen',
      { activityIds: ['activity-1'] },
    );

    resolveMark(response().status);
    await settle();
    expect(queries).toBe(2);
    expect(container.querySelector('[data-testid="first-seen"]')?.textContent).toBe('seen');
  });

  it('stars then unstars through the shared mutation boundary and reconciles both projections', async () => {
    let radarQueries = 0;
    let recommendationQueries = 0;
    let resolveUnstar!: () => void;
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') {
        radarQueries += 1;
        const snapshotStatus = radarQueries === 1 ? 'fresh' : radarQueries === 2 ? 'partial' : 'stale';
        return Promise.resolve(response({ snapshotStatus }));
      }
      if (type === 'queryRecommendations') {
        recommendationQueries += 1;
        const snapshotStatus = recommendationQueries === 1
          ? 'fresh'
          : recommendationQueries === 2 ? 'error' : 'stale';
        return Promise.resolve(recommendationResponse({ snapshotStatus }));
      }
      if (type === 'radarStarRepository') return Promise.resolve();
      if (type === 'markUnstarred') {
        return new Promise<void>((resolve) => { resolveUnstar = resolve; });
      }
      throw new Error(`Unexpected request: ${type}`);
    });

    const container = mountReact(<Harness />, mountedRoots);
    await settle();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="star"]')?.click();
      await Promise.resolve();
    });
    await settle();
    await settle();

    expect(radarQueries).toBe(2);
    expect(recommendationQueries).toBe(2);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('partial');
    expect(container.querySelector('[data-testid="recommendation-status"]')?.textContent)
      .toBe('error');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="unstar"]')?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="pending-action"]')?.textContent).toBe('star');
    expect(radarMocks.bgCall.mock.calls.filter(([type]) => type === 'markUnstarred')).toEqual([
      ['markUnstarred', { full_name: 'owner/repo' }],
    ]);
    expect(radarQueries).toBe(2);
    expect(recommendationQueries).toBe(2);

    resolveUnstar();
    await settle();
    await settle();

    expect(radarQueries).toBe(3);
    expect(recommendationQueries).toBe(3);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('stale');
    expect(container.querySelector('[data-testid="recommendation-status"]')?.textContent)
      .toBe('stale');
    expect(container.querySelector('[data-testid="pending-action"]')?.textContent).toBe('none');
  });
});
