import { describe, expect, it, vi } from 'vitest';
import {
  createRadarRefreshCoordinator,
  type RadarRefreshCoordinatorDependencies,
} from '@/background/radar-refresh';
import type { GitHubCredentialSnapshot } from '@/auth/auth-store';
import { GitHubRadarError, type RadarActivityRecord, type RadarActivityPresentation, type RadarStateRecord } from '@/radar/radar-model';
import type { RadarSourceSnapshot } from '@/radar/radar-contract';

const NOW = 1_786_000_000_000;

function authSnapshot(overrides: Partial<GitHubCredentialSnapshot> = {}): GitHubCredentialSnapshot {
  return {
    accountLogin: 'viewer',
    mainToken: 'main-token',
    notificationsToken: null,
    notificationsConfigured: false,
    mainIdentity: 'identity-a',
    notificationsIdentity: 'notifications-a',
    ...overrides,
  };
}

function state(overrides: Partial<RadarStateRecord> = {}): RadarStateRecord {
  return {
    id: 'singleton',
    accountLogin: 'viewer',
    lastAttemptAt: new Date(NOW - 1_000).toISOString(),
    lastSuccessfulAt: new Date(NOW - 1_000).toISOString(),
    errorCode: null,
    nextAllowedAt: null,
    activityCount: 1,
    followingCount: 2,
    scannedFollowingCount: 2,
    batchCount: 1,
    partialReasons: [],
    rateLimitRemaining: 4000,
    rateLimitResetAt: null,
    ...overrides,
  };
}

const activity = {
  id: 'activity-1',
  accountLogin: 'viewer',
  actorLogin: 'friend',
  actorAvatarUrl: 'https://avatars.example/friend.png',
  repositoryKey: 'owner/repo',
  repositoryFullName: 'owner/repo',
  repositoryDisplayName: 'owner/repo',
  repositoryHtmlUrl: 'https://github.com/owner/repo',
  repositoryDescription: 'repo',
  repositoryLanguage: 'TypeScript',
  repositoryLanguageColor: '#3178c6',
  repositoryStargazerCount: 10,
  repositoryTopics: ['repo-topic'],
  viewerHadStarred: false,
  starredAt: '2026-08-10T11:00:00.000Z',
  dismissedAt: null,
  seenAt: null,
} satisfies RadarActivityRecord;

function snapshot(overrides: Partial<RadarSourceSnapshot> = {}): RadarSourceSnapshot {
  return {
    accountLogin: 'viewer',
    activities: [activity],
    fetchedAt: new Date(NOW).toISOString(),
    followingCount: 2,
    scannedFollowingCount: 2,
    batchCount: 1,
    partialReasons: [],
    rateLimitRemaining: 4000,
    rateLimitResetAt: null,
    ...overrides,
  };
}
const followingActivity = {
  ...activity,
  source: 'following',
  seen: false,
  viewerHasStarred: false,
  favorite: false,
  tags: [],
  suggestedTags: ['repo-topic'],
  displayedStargazerCount: activity.repositoryStargazerCount,
} satisfies RadarActivityPresentation;


function makeCoordinator(input: {
  auth?: GitHubCredentialSnapshot;
  state?: RadarStateRecord | null;
  fetchRadar?: RadarRefreshCoordinatorDependencies['fetchRadar'];
  activities?: RadarActivityPresentation[];
} = {}) {
  let currentAuth = input.auth ?? authSnapshot();
  const currentState = input.state === undefined ? state() : input.state;
  const events: string[] = [];
  const runSerialized: RadarRefreshCoordinatorDependencies['runSerialized'] = async <T,>(
    operation: () => Promise<T>,
  ) => operation();
  const store = {
    clearData: vi.fn(async () => { events.push('clear'); }),
    prepareAccount: vi.fn(async () => { events.push('prepare'); }),
    getState: vi.fn(async () => currentState),
    commitSnapshot: vi.fn(async () => { events.push('commit'); return currentState ?? state(); }),
    recordFailure: vi.fn(async () => { events.push('failure'); return currentState ?? state(); }),
    listActivities: vi.fn(async () => input.activities ?? [] as RadarActivityPresentation[]),
    dismissActivities: vi.fn(async () => 0),
    markActivitiesSeen: vi.fn(async () => 0),
  };
  const dependencies: RadarRefreshCoordinatorDependencies = {
    runSerialized,
    auth: {
      getGitHubCredentialSnapshot: vi.fn(async () => currentAuth),
    },
    fetchRadar: input.fetchRadar ?? vi.fn(async () => snapshot()),
    store,
    now: () => NOW,
    broadcastChanged: vi.fn(() => { events.push('broadcast'); }),
  };
  const coordinator = createRadarRefreshCoordinator(dependencies);
  return {
    coordinator,
    dependencies,
    store,
    events,
    setAuth(next: GitHubCredentialSnapshot) { currentAuth = next; },
  };
}

describe('Radar refresh coordinator', () => {
  it('coalesces concurrent refreshes for one credential identity', async () => {
    let release!: (value: RadarSourceSnapshot) => void;
    const fetchRadar = vi.fn(() => new Promise<RadarSourceSnapshot>((resolve) => { release = resolve; }));
    const h = makeCoordinator({ fetchRadar });

    const first = h.coordinator.refresh();
    while (!release) await Promise.resolve();
    const second = h.coordinator.refresh();
    release(snapshot());

    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(fetchRadar).toHaveBeenCalledTimes(1);
    expect(h.store.commitSnapshot).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toBe('broadcast');
  });

  it('skips all network work while a rate-limit cooldown is active', async () => {
    const h = makeCoordinator({
      state: state({
        errorCode: 'rate_limited',
        nextAllowedAt: new Date(NOW + 60_000).toISOString(),
      }),
    });

    const result = await h.coordinator.refresh();

    expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
    expect(result.published).toBe(false);
    expect(result.status.snapshotStatus).toBe('cooldown');
  });

  it('records a stable failure without deleting the previous published snapshot', async () => {
    const h = makeCoordinator({
      fetchRadar: vi.fn(async () => {
        throw new GitHubRadarError('permission_denied', { status: 403 });
      }),
    });

    const result = await h.coordinator.refresh();

    expect(result.published).toBe(false);
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
    expect(h.store.recordFailure).toHaveBeenCalledWith('viewer', 'permission_denied', { nextAllowedAt: null });
    expect(h.events).toEqual(['prepare', 'prepare', 'failure', 'broadcast']);
  });

  it('rejects a source snapshot published for a different account', async () => {
    const h = makeCoordinator({
      fetchRadar: vi.fn(async () => snapshot({ accountLogin: 'other-user' })),
    });

    const result = await h.coordinator.refresh();

    expect(result.published).toBe(false);
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
    expect(h.store.recordFailure).toHaveBeenCalledWith('viewer', 'invalid_response', { nextAllowedAt: null });
  });

  it('abandons an in-flight result when the credential identity changes', async () => {
    let release!: (value: RadarSourceSnapshot) => void;
    const fetchRadar = vi.fn(() => new Promise<RadarSourceSnapshot>((resolve) => { release = resolve; }));
    const h = makeCoordinator({ fetchRadar });

    const refresh = h.coordinator.refresh();
    while (!release) await Promise.resolve();
    h.setAuth(authSnapshot({
      accountLogin: 'new-viewer',
      mainIdentity: 'identity-b',
      mainToken: 'new-token',
    }));
    release(snapshot());

    const result = await refresh;
    expect(result.published).toBe(false);
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
    expect(h.store.recordFailure).not.toHaveBeenCalled();
    expect(result.status.accountLogin).toBe('new-viewer');
  });

  it('counts unseen following activities in the shared query projection', async () => {
    const h = makeCoordinator({
      activities: [
        followingActivity,
        { ...followingActivity, id: 'seen', seen: true, seenAt: new Date(NOW).toISOString() },
        { ...followingActivity, id: 'self', source: 'self', seen: true },
      ],
    });

    const result = await h.coordinator.query();

    expect(result.unseenCount).toBe(1);
    expect(result).not.toHaveProperty('suggestedTags');
  });

  it('serializes seen mutations and broadcasts only when storage changes', async () => {
    const h = makeCoordinator();
    h.store.markActivitiesSeen.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await h.coordinator.markSeen(['activity-1']);
    await h.coordinator.markSeen(['activity-1']);

    expect(h.store.markActivitiesSeen).toHaveBeenNthCalledWith(1, 'viewer', ['activity-1']);
    expect(h.dependencies.broadcastChanged).toHaveBeenCalledTimes(1);
  });
});
