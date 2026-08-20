import { describe, expect, it, vi } from 'vitest';
import {
  createRecommendationRefreshCoordinator,
  isRecommendationCatchUpDue,
  isRecommendationRefreshDue,
  localDayKey,
  localRefreshBoundary,
  nextLocalRefreshAt,
  type RecommendationRefreshCoordinatorDependencies,
} from '@/background/recommendation-refresh';
import type { GitHubCredentialSnapshot } from '@/auth/auth-store';
import {
  GitHubRecommendationError,
  type RecommendationIgnoreRecord,
  type RecommendationRecord,
  type RecommendationSourceSnapshot,
  type RecommendationStateRecord,
} from '@/recommendations/recommendation-model';

const NOW = new Date(2026, 7, 13, 12, 0, 0, 0).getTime();

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

function state(overrides: Partial<RecommendationStateRecord> = {}): RecommendationStateRecord {
  return {
    id: 'singleton',
    accountLogin: 'viewer',
    lastAttemptAt: new Date(NOW - 1_000).toISOString(),
    lastSuccessfulAt: new Date(NOW - 1_000).toISOString(),
    errorCode: null,
    nextAllowedAt: null,
    candidateCount: 1,
    seedCount: 1,
    queryCount: 1,
    rateLimitRemaining: 8,
    rateLimitResetAt: null,
    ...overrides,
  };
}

const record: RecommendationRecord = {
  id: 'candidate/repo',
  accountLogin: 'viewer',
  repositoryKey: 'candidate/repo',
  repositoryFullName: 'Candidate/Repo',
  repositoryHtmlUrl: 'https://github.com/candidate/repo',
  description: '',
  language: 'TypeScript',
  stargazerCount: 10,
  topics: ['developer-tools'],
  owner: 'candidate',
  name: 'repo',
  pushedAt: new Date(NOW - 1_000).toISOString(),
  createdAt: null,
  fork: false,
  archived: false,
  score: 100,
  reason: {
    kind: 'topic',
    value: 'developer-tools',
    seedRepositoryKey: 'seed/repo',
    seedRepositoryFullName: 'Seed/Repo',
  },
  fetchedAt: new Date(NOW).toISOString(),
};

function snapshot(overrides: Partial<RecommendationSourceSnapshot> = {}): RecommendationSourceSnapshot {
  return {
    accountLogin: 'viewer',
    recommendations: [record],
    fetchedAt: new Date(NOW).toISOString(),
    seedCount: 1,
    queryCount: 1,
    rateLimitRemaining: 8,
    rateLimitResetAt: null,
    ...overrides,
  };
}

function makeCoordinator(input: {
  auth?: GitHubCredentialSnapshot;
  state?: RecommendationStateRecord | null;
  fetchRecommendations?: RecommendationRefreshCoordinatorDependencies['fetchRecommendations'];
  seeds?: Awaited<ReturnType<RecommendationRefreshCoordinatorDependencies['loadSeeds']>>;
} = {}) {
  let currentAuth = input.auth ?? authSnapshot();
  let currentState = input.state === undefined ? state() : input.state;
  const events: string[] = [];
  const store = {
    clearData: vi.fn(async () => { events.push('clear'); }),
    prepareAccount: vi.fn(async () => { events.push('prepare'); }),
    getState: vi.fn(async () => currentState),
    commitSnapshot: vi.fn(async () => { events.push('commit'); return currentState ?? state(); }),
    recordFailure: vi.fn(async (_login: string, code: RecommendationStateRecord['errorCode'], options: { nextAllowedAt?: string | null } = {}) => {
      events.push('failure');
      currentState = state({ errorCode: code, nextAllowedAt: options.nextAllowedAt ?? null });
      return currentState;
    }),
    listRecommendations: vi.fn(async () => [record]),
    ignoreRepository: vi.fn(async () => { events.push('ignore'); }),
    listIgnored: vi.fn(async (): Promise<RecommendationIgnoreRecord[]> => []),
    restoreIgnored: vi.fn(async () => { events.push('restore'); }),
  };
  const dependencies: RecommendationRefreshCoordinatorDependencies = {
    runSerialized: async <T,>(operation: () => Promise<T>) => operation(),
    auth: { getGitHubCredentialSnapshot: vi.fn(async () => currentAuth) },
    fetchRecommendations: input.fetchRecommendations ?? vi.fn(async () => snapshot()),
    loadSeeds: vi.fn(async () => input.seeds ?? [{
      repositoryKey: 'seed/repo',
      repositoryFullName: 'Seed/Repo',
      owner: 'seed',
      name: 'repo',
      language: 'TypeScript',
      topics: ['developer-tools'],
      descriptionKeywords: [],
      starredAt: new Date(NOW - 2_000).toISOString(),
      stargazerCount: 10,
    }]),
    loadExcludedRepositoryKeys: vi.fn(async () => new Set(['local/repo'])),
    store,
    now: () => NOW,
    broadcastChanged: vi.fn(() => { events.push('broadcast'); }),
  };
  const coordinator = createRecommendationRefreshCoordinator(dependencies);
  return {
    coordinator,
    dependencies,
    store,
    events,
    setAuth(next: GitHubCredentialSnapshot) { currentAuth = next; },
  };
}

describe('Recommendation refresh coordinator', () => {
  it('coalesces concurrent refreshes for one credential identity', async () => {
    let release!: (value: RecommendationSourceSnapshot) => void;
    const fetchRecommendations = vi.fn(() => new Promise<RecommendationSourceSnapshot>((resolve) => {
      release = resolve;
    }));
    const h = makeCoordinator({ fetchRecommendations });

    const first = h.coordinator.refresh();
    while (!release) await Promise.resolve();
    const second = h.coordinator.refresh();
    release(snapshot());

    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(fetchRecommendations).toHaveBeenCalledTimes(1);
    expect(h.store.commitSnapshot).toHaveBeenCalledTimes(1);
  });

  it('skips Search while a persisted cooldown is active', async () => {
    const h = makeCoordinator({
      state: state({
        errorCode: 'rate_limited',
        nextAllowedAt: new Date(NOW + 60_000).toISOString(),
      }),
    });

    const result = await h.coordinator.refresh();
    expect(h.dependencies.fetchRecommendations).not.toHaveBeenCalled();
    expect(result.published).toBe(false);
    expect(result.status.snapshotStatus).toBe('cooldown');
  });

  it('skips Search while a successful exhausted-bucket cooldown is active', async () => {
    const h = makeCoordinator({
      state: state({
        errorCode: null,
        rateLimitRemaining: 0,
        nextAllowedAt: new Date(NOW + 60_000).toISOString(),
      }),
    });

    const result = await h.coordinator.refresh();
    expect(h.dependencies.fetchRecommendations).not.toHaveBeenCalled();
    expect(result.published).toBe(false);
    expect(result.status.snapshotStatus).toBe('cooldown');
  });

  it('runs the first eligible entry once and coalesces it with a manual refresh', async () => {
    let release!: (value: RecommendationSourceSnapshot) => void;
    const fetchRecommendations = vi.fn(() => new Promise<RecommendationSourceSnapshot>((resolve) => {
      release = resolve;
    }));
    const h = makeCoordinator({ state: null, fetchRecommendations });

    const entry = h.coordinator.refreshFirstEligible();
    while (!release) await Promise.resolve();
    const manual = h.coordinator.refresh();
    release(snapshot());

    const [entryResult, manualResult] = await Promise.all([entry, manual]);
    expect(entryResult).toEqual(manualResult);
    expect(fetchRecommendations).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing credential', { auth: authSnapshot({ mainToken: null }) }],
    ['empty local library', { state: null, seeds: [] as Awaited<ReturnType<RecommendationRefreshCoordinatorDependencies['loadSeeds']>> }],
    ['completed empty snapshot', { state: state({ lastSuccessfulAt: new Date(NOW - 1_000).toISOString(), candidateCount: 0 }) }],
  ] as const)('keeps an ineligible first entry silent for %s', async (_label, input) => {
    const h = makeCoordinator(input);

    await expect(h.coordinator.refreshFirstEligible()).resolves.toBeNull();
    expect(h.dependencies.fetchRecommendations).not.toHaveBeenCalled();
    expect(h.store.recordFailure).not.toHaveBeenCalled();
  });

  it('computes local 08:00 boundaries without fixed UTC offsets', () => {
    const before = new Date(2026, 7, 13, 7, 59, 59, 999).getTime();
    const atEight = new Date(2026, 7, 13, 8, 0, 0, 0).getTime();
    const after = new Date(2026, 7, 13, 15, 0, 0, 0).getTime();

    expect(localRefreshBoundary(before)).toBe(atEight);
    expect(nextLocalRefreshAt(before)).toBe(atEight);
    expect(nextLocalRefreshAt(atEight)).toBe(new Date(2026, 7, 14, 8, 0, 0, 0).getTime());
    expect(localDayKey(after)).toBe('2026-08-13');
    expect(isRecommendationRefreshDue(new Date(2026, 7, 12, 9).toISOString(), before)).toBe(false);
    expect(isRecommendationRefreshDue(new Date(2026, 7, 12, 9).toISOString(), after)).toBe(true);
  });

  it('suppresses same-day success and limits startup catch-up to one attempt', () => {
    const current = new Date(2026, 7, 13, 12, 0, 0, 0).getTime();
    const yesterday = new Date(2026, 7, 12, 8, 0, 0, 0).toISOString();
    const today = new Date(2026, 7, 13, 9, 0, 0, 0).toISOString();

    expect(isRecommendationCatchUpDue(state({ lastSuccessfulAt: yesterday, lastAttemptAt: yesterday }), current)).toBe(true);
    expect(isRecommendationCatchUpDue(state({ lastSuccessfulAt: yesterday, lastAttemptAt: today }), current)).toBe(false);
    expect(isRecommendationCatchUpDue(state({ lastSuccessfulAt: today, lastAttemptAt: today }), current)).toBe(false);
  });

  it('runs a due scheduled refresh but not an already-attempted startup catch-up', async () => {
    const current = new Date(NOW);
    current.setHours(12, 0, 0, 0);
    const yesterdayDate = new Date(current);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = yesterdayDate.toISOString();
    const sameDayAttempt = current.toISOString();
    const scheduled = makeCoordinator({ state: state({ lastSuccessfulAt: yesterday, lastAttemptAt: yesterday }) });
    const caughtUp = makeCoordinator({ state: state({ lastSuccessfulAt: yesterday, lastAttemptAt: sameDayAttempt }) });

    await expect(scheduled.coordinator.refreshAtScheduledBoundary()).resolves.toMatchObject({ published: true });
    await expect(caughtUp.coordinator.refreshIfDue()).resolves.toBeNull();
    expect(scheduled.dependencies.fetchRecommendations).toHaveBeenCalledTimes(1);
    expect(caughtUp.dependencies.fetchRecommendations).not.toHaveBeenCalled();
  });

  it('records a rate-limit reset without replacing saved candidates', async () => {
    const resetAt = new Date(NOW + 60_000).toISOString();
    const h = makeCoordinator({
      fetchRecommendations: vi.fn(async () => {
        throw new GitHubRecommendationError('rate_limited', { status: 403, resetAt });
      }),
    });

    const result = await h.coordinator.refresh();
    expect(result.published).toBe(false);
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
    expect(h.store.recordFailure).toHaveBeenCalledWith(
      'viewer',
      'rate_limited',
      { nextAllowedAt: resetAt },
    );
    expect(h.store.listRecommendations).not.toHaveBeenCalled();
  });

  it('abandons an in-flight result when credentials change', async () => {
    let release!: (value: RecommendationSourceSnapshot) => void;
    const h = makeCoordinator({
      fetchRecommendations: vi.fn(() => new Promise<RecommendationSourceSnapshot>((resolve) => {
        release = resolve;
      })),
    });

    const refresh = h.coordinator.refresh();
    while (!release) await Promise.resolve();
    h.setAuth(authSnapshot({
      accountLogin: 'new-viewer',
      mainToken: 'new-token',
      mainIdentity: 'identity-b',
    }));
    release(snapshot());

    const result = await refresh;
    expect(result.published).toBe(false);
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
    expect(h.store.recordFailure).not.toHaveBeenCalled();
    expect(result.status.accountLogin).toBe('new-viewer');
  });

  it('queries saved rows without re-running account cleanup for an unchanged identity', async () => {
    const h = makeCoordinator();
    await h.coordinator.query();
    await h.coordinator.query();

    expect(h.store.prepareAccount).toHaveBeenCalledTimes(1);
    expect(h.store.listRecommendations).toHaveBeenCalledTimes(2);
  });

  it('loads excluded repository keys for the account being refreshed', async () => {
    const h = makeCoordinator();
    await h.coordinator.refresh();
    expect(h.dependencies.loadExcludedRepositoryKeys).toHaveBeenCalledWith('viewer');
  });

  it('persists an ignored repository for the authenticated account and broadcasts', async () => {
    const h = makeCoordinator();
    await h.coordinator.ignoreRepository('one/repo');
    expect(h.store.ignoreRepository).toHaveBeenCalledWith('viewer', 'one/repo', undefined);
    expect(h.events).toContain('ignore');
    expect(h.events).toContain('broadcast');
  });
  it('rejects ignoring a repository without an authenticated account', async () => {
    const h = makeCoordinator();
    h.setAuth(authSnapshot({ accountLogin: null, mainToken: null }));
    await expect(h.coordinator.ignoreRepository('one/repo')).rejects.toThrow(
      GitHubRecommendationError,
    );
    expect(h.store.ignoreRepository).not.toHaveBeenCalled();
  });

  it('restores an ignored repository and broadcasts', async () => {
    const h = makeCoordinator();
    await h.coordinator.restoreIgnored('one/repo');
    expect(h.store.restoreIgnored).toHaveBeenCalledWith('viewer', 'one/repo');
    expect(h.events).toContain('restore');
    expect(h.events).toContain('broadcast');
  });

  it('includes the ignored list in query responses', async () => {
    const ignoredRow = {
      id: 'viewer:one/repo',
      accountLogin: 'viewer',
      repositoryKey: 'one/repo',
      repositoryFullName: 'One/Repo',
      ignoredAt: new Date(NOW).toISOString(),
    };
    const h = makeCoordinator();
    h.store.listIgnored.mockResolvedValueOnce([ignoredRow]);
    const response = await h.coordinator.query();
    expect(response.ignored).toEqual([ignoredRow]);
  });
});
