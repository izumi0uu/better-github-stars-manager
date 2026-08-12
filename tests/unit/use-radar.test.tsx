/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRadar } from '@/ui/hooks/use-radar';
import type { RadarQueryResponse, RadarRefreshResult, RadarStatus } from '@/radar/radar-contract';
import type { RadarActivityPresentation } from '@/radar/radar-model';
import { cleanupMountedRootsAndBody, mountReact, type MountedRoot } from './test-utils';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const radarMocks = vi.hoisted(() => ({ bgCall: vi.fn() }));
type RuntimeListener = (message: { type?: string }) => void;
const runtimeListeners: RuntimeListener[] = [];

vi.mock('@/utils/messaging', () => ({ bgCall: radarMocks.bgCall }));

function response(overrides: Partial<RadarQueryResponse['status']> = {}): RadarQueryResponse {
  return {
    activities: [],
    unseenCount: 0,
    suggestedTags: ['ai'],
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
  starredAt: '2026-08-10T10:00:00.000Z',
  dismissedAt: null,
  seenAt: null,
  source: 'following',
  seen: false,
  viewerHasStarred: false,
  favorite: false,
  tags: [],
  displayedStargazerCount: 1,
} satisfies RadarActivityPresentation;


function Harness() {
  const radar = useRadar();
  return (
    <div>
      <button type="button" data-testid="refresh" onClick={() => void radar.refresh()}>Refresh</button>
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
      <span data-testid="loading">{radar.loading ? 'loading' : 'ready'}</span>
      <span data-testid="refreshing">{radar.refreshing ? 'refreshing' : 'idle'}</span>
      <span data-testid="error">{radar.error ?? 'none'}</span>
      <span data-testid="status">{radar.result?.status.snapshotStatus ?? 'none'}</span>
      <span data-testid="count">{radar.result?.activities.length ?? 'none'}</span>
      <span data-testid="unseen">{radar.result?.unseenCount ?? 'none'}</span>
      <span data-testid="first-seen">{radar.result?.activities[0]?.seen ? 'seen' : 'unseen'}</span>
      <span data-testid="sources">
        {radar.sources.following ? 'following:on' : 'following:off'}·
        {radar.sources.self ? 'self:on' : 'self:off'}
      </span>
    </div>
  );
}

const mountedRoots: MountedRoot[] = [];

beforeEach(() => {
  radarMocks.bgCall.mockReset();
  runtimeListeners.length = 0;
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
  it('defaults to Following and enables Me without a background request', async () => {
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') return Promise.resolve(response());
      throw new Error(`Unexpected request: ${type}`);
    });
    const container = mountReact(<Harness />, mountedRoots);
    await settle();

    expect(container.querySelector('[data-testid="sources"]')?.textContent)
      .toBe('following:on·self:off');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="show-self"]')?.click();
    });
    expect(container.querySelector('[data-testid="sources"]')?.textContent)
      .toBe('following:on·self:on');
    expect(radarMocks.bgCall).toHaveBeenCalledTimes(1);
  });

  it('keeps old data and exposes a refresh error when the coordinator cannot publish', async () => {
    const loaded = response();
    const failed = response({ snapshotStatus: 'stale', errorCode: 'network_error' });
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type === 'queryRadar') return Promise.resolve(loaded);
      if (type === 'refreshRadar') return Promise.resolve(refreshResponse({ published: false, status: failed.status }));
      throw new Error(`Unexpected request: ${type}`);
    });

    const container = mountReact(<Harness />, mountedRoots);
    await settle();
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('ready');

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

  it('reloads only after an authoritative Radar message and suppresses stale responses', async () => {
    const first = response();
    const second = response({ snapshotStatus: 'partial' });
    let queries = 0;
    radarMocks.bgCall.mockImplementation((type: string) => {
      if (type !== 'queryRadar') throw new Error(`Unexpected request: ${type}`);
      queries += 1;
      return Promise.resolve(queries === 1 ? first : second);
    });

    const container = mountReact(<Harness />, mountedRoots);
    await settle();
    expect(queries).toBe(1);

    await act(async () => {
      runtimeListeners[0]?.({ type: 'dataChanged' });
      runtimeListeners[0]?.({ type: 'unrelated' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queries).toBe(2);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('partial');
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
});
