import { describe, expect, it, vi } from 'vitest';
import {
  createRadarRefreshCoordinator,
  type RadarRefreshCoordinatorDependencies,
} from '@/background/radar-refresh';
import type { GitHubCredentialSnapshot } from '@/auth/auth-store';
import type {
  RadarReconciliationSourceStep,
  RadarSourceSnapshot,
} from '@/radar/radar-contract';
import {
  createRadarReconciliationCheckpoint,
  GitHubRadarError,
  type RadarActivityRecord,
  type RadarActivityPresentation,
  type RadarReconciliationCheckpoint,
  type RadarStateRecord,
} from '@/radar/radar-model';
import { createSerializedRunner } from '@/background/serialized-runner';
import type { Config, FollowingHistoryWindowDays } from '@/types';

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
    windowDays: 60,
    lastRefreshMode: 'full',
    lastIncrementalAt: null,
    lastFullReconciledAt: new Date(NOW - 2 * 24 * 60 * 60 * 1_000).toISOString(),
    credentialIdentity: JSON.stringify(['viewer', 'identity-a', true]),
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
    windowDays: 60,
    refreshMode: 'incremental',
    lookbackDays: 7,
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


type FetchStepOptions = Parameters<
  RadarRefreshCoordinatorDependencies['fetchReconciliationStep']
>[0];

/** One step that completes an empty epoch, for tests about routing not coverage. */
function terminalStep(
  checkpoint: RadarReconciliationCheckpoint,
): RadarReconciliationSourceStep {
  return {
    expectedReconciliationId: checkpoint.reconciliationId,
    expectedRevision: checkpoint.revision,
    checkpoint: {
      ...checkpoint,
      revision: checkpoint.revision + 1,
      cursor: { phase: 'activity', followingCount: 0, actors: [] },
    },
    activities: [],
    complete: true,
  };
}

/** One applied step that pauses on its request budget with the given quota left. */
function budgetPausedStep(
  checkpoint: RadarReconciliationCheckpoint,
  input: Readonly<{ actors: number; complete: number; remaining: number; cost: number }>,
): RadarReconciliationSourceStep {
  return {
    expectedReconciliationId: checkpoint.reconciliationId,
    expectedRevision: checkpoint.revision,
    checkpoint: {
      ...checkpoint,
      revision: checkpoint.revision + 1,
      cursor: {
        phase: 'activity',
        followingCount: input.actors,
        actors: Array.from({ length: input.actors }, (_, index) => ({
          login: `actor-${index}`,
          nextCursor: null,
          seenCursors: [],
          complete: index < input.complete,
        })),
      },
      scannedFollowingCount: input.complete,
      rateLimitRemaining: input.remaining,
      maxRequestCost: input.cost,
      pauseReason: 'request_budget',
      nextAllowedAt: null,
    },
    activities: [],
    complete: false,
  };
}

function makeCoordinator(input: {
  auth?: GitHubCredentialSnapshot;
  state?: RadarStateRecord | null;
  fetchRadar?: RadarRefreshCoordinatorDependencies['fetchRadar'];
  fetchReconciliationStep?: RadarRefreshCoordinatorDependencies['fetchReconciliationStep'];
  reconciliation?: RadarReconciliationCheckpoint | null;
  activities?: RadarActivityPresentation[];
  runSerialized?: RadarRefreshCoordinatorDependencies['runSerialized'];
} = {}) {
  let currentAuth = input.auth ?? authSnapshot();
  let currentWindowDays: FollowingHistoryWindowDays = 60;
  let currentReconciliation = input.reconciliation ?? null;
  const currentState = input.state === undefined ? state() : input.state;
  const events: string[] = [];
  const runSerialized = input.runSerialized ?? (async <T,>(operation: () => Promise<T>) => operation());
  const store = {
    clearData: vi.fn(async () => { events.push('clear'); }),
    prepareAccount: vi.fn(async () => { events.push('prepare'); }),
    getState: vi.fn(async () => currentState),
    getReconciliation: vi.fn(async () => currentReconciliation),
    startReconciliation: vi.fn(async (checkpoint: RadarReconciliationCheckpoint) => {
      currentReconciliation = checkpoint;
      return { state: currentState ?? state(), checkpoint };
    }),
    commitReconciliationStep: vi.fn(async (input: { step: RadarReconciliationSourceStep }) => {
      currentReconciliation = input.step.complete ? null : input.step.checkpoint;
      return {
        applied: true,
        state: currentState ?? state(),
        checkpoint: currentReconciliation,
      };
    }),
    abandonReconciliation: vi.fn(async () => {
      currentReconciliation = null;
      return true;
    }),
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
      getConfig: vi.fn(async () => ({ radarWindowDays: currentWindowDays }) as Config),
    },
    fetchRadar: input.fetchRadar ?? vi.fn(async (options) => snapshot({
      windowDays: options.windowDays,
      refreshMode: options.refreshMode,
      lookbackDays: options.lookbackDays,
    })),
    // A full plan always routes through the resumable step, so the default
    // completes one epoch immediately and keeps snapshot-path tests focused.
    fetchReconciliationStep: input.fetchReconciliationStep
      ?? vi.fn(async (options: FetchStepOptions) => terminalStep(options.checkpoint)),
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
    setWindowDays(next: FollowingHistoryWindowDays) { currentWindowDays = next; },
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
    expect(h.store.commitSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      { credentialIdentity: JSON.stringify(['viewer', 'identity-a', true]) },
    );
    expect(fetchRadar).toHaveBeenCalledWith(expect.objectContaining({ windowDays: 60 }));
    expect(h.events.at(-1)).toBe('broadcast');
  });

  it('coalesces repeated full reconciliations while one full step is active', async () => {
    let release!: () => void;
    const fetchStep = vi.fn(async (options: FetchStepOptions) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return terminalStep(options.checkpoint);
    });
    const h = makeCoordinator({
      fetchReconciliationStep: fetchStep,
      runSerialized: createSerializedRunner().run,
    });

    const first = h.coordinator.fullReconcile();
    while (!release) await Promise.resolve();
    const second = h.coordinator.fullReconcile();
    release();

    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(fetchStep).toHaveBeenCalledTimes(1);
    expect(h.store.commitReconciliationStep).toHaveBeenCalledTimes(1);
    expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();
  });

  it('queues one full step after incremental work without overlapping fetches', async () => {
    let releaseIncremental!: () => void;
    let releaseFull!: () => void;
    let activeFetches = 0;
    let peakFetches = 0;
    const order: string[] = [];
    const fetchRadar = vi.fn(async (options) => {
      order.push(options.refreshMode ?? '');
      activeFetches += 1;
      peakFetches = Math.max(peakFetches, activeFetches);
      await new Promise<void>((resolve) => { releaseIncremental = resolve; });
      activeFetches -= 1;
      return snapshot({
        windowDays: options.windowDays,
        refreshMode: options.refreshMode,
        lookbackDays: options.lookbackDays,
      });
    });
    const fetchStep = vi.fn(async (options: FetchStepOptions) => {
      order.push('full');
      activeFetches += 1;
      peakFetches = Math.max(peakFetches, activeFetches);
      await new Promise<void>((resolve) => { releaseFull = resolve; });
      activeFetches -= 1;
      return terminalStep(options.checkpoint);
    });
    const h = makeCoordinator({
      fetchRadar,
      fetchReconciliationStep: fetchStep,
      runSerialized: createSerializedRunner().run,
    });

    const incremental = h.coordinator.refresh();
    while (!releaseIncremental) await Promise.resolve();
    const fullOne = h.coordinator.fullReconcile();
    const fullTwo = h.coordinator.fullReconcile();
    releaseIncremental();
    while (!releaseFull) await Promise.resolve();
    releaseFull();

    const [incrementalResult, one, two] = await Promise.all([incremental, fullOne, fullTwo]);
    expect(incrementalResult.published).toBe(true);
    expect(one).toEqual(two);
    expect(fetchRadar).toHaveBeenCalledTimes(1);
    expect(fetchStep).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['incremental', 'full']);
    expect(peakFetches).toBe(1);
  });

  it('coalesces an automatic refresh into a queued full handoff', async () => {
    let releaseIncremental!: () => void;
    let releaseFull!: () => void;
    const fetchRadar = vi.fn(async (options) => {
      await new Promise<void>((resolve) => { releaseIncremental = resolve; });
      return snapshot({
        windowDays: options.windowDays,
        refreshMode: options.refreshMode,
        lookbackDays: options.lookbackDays,
      });
    });
    const fetchStep = vi.fn(async (options: FetchStepOptions) => {
      await new Promise<void>((resolve) => { releaseFull = resolve; });
      return terminalStep(options.checkpoint);
    });
    const h = makeCoordinator({
      fetchRadar,
      fetchReconciliationStep: fetchStep,
      runSerialized: createSerializedRunner().run,
    });

    const incremental = h.coordinator.refresh();
    while (!releaseIncremental) await Promise.resolve();

    let releaseWindow!: () => void;
    const configGate = new Promise<Config>((resolve) => {
      releaseWindow = () => resolve({ radarWindowDays: 60 } as Config);
    });
    let configRead!: () => void;
    const configReadPromise = new Promise<void>((resolve) => { configRead = resolve; });
    vi.spyOn(h.dependencies.auth, 'getConfig').mockImplementationOnce(() => {
      configRead();
      return configGate;
    });

    const fullOne = h.coordinator.fullReconcile();
    await configReadPromise;

    let automatic!: ReturnType<typeof h.coordinator.refresh>;
    const automaticReady = configGate.then(() => new Promise<void>((resolve) => {
      queueMicrotask(() => {
        automatic = h.coordinator.refresh();
        resolve();
      });
    }));
    releaseWindow();
    await automaticReady;
    let automaticSettled = false;
    const automaticResult = automatic.then((result) => {
      automaticSettled = true;
      return result;
    });

    const fullTwo = h.coordinator.fullReconcile();
    releaseIncremental();
    while (!releaseFull) await Promise.resolve();
    expect(automaticSettled).toBe(false);
    releaseFull();

    const [incrementalResult, one, two, auto] = await Promise.all([
      incremental,
      fullOne,
      fullTwo,
      automaticResult,
    ]);
    expect(incrementalResult.published).toBe(true);
    expect(one).toEqual(two);
    expect(one).toEqual(auto);
    expect(fetchRadar).toHaveBeenCalledTimes(1);
    expect(fetchStep).toHaveBeenCalledTimes(1);
  });
  it('starts a durable checkpoint for a forced full reconciliation', async () => {
    const credentialIdentity = JSON.stringify(['viewer', 'identity-a', true]);
    const fetchStep: NonNullable<RadarRefreshCoordinatorDependencies['fetchReconciliationStep']> =
      vi.fn(async (options) => {
        const nextCheckpoint: RadarReconciliationCheckpoint = {
          ...options.checkpoint,
          revision: options.checkpoint.revision + 1,
          updatedAt: new Date(NOW).toISOString(),
          cursor: {
            phase: 'following',
            nextCursor: 'following-next',
            seenCursors: ['following-next'],
            logins: [],
            totalCount: null,
          },
        };
        return {
          expectedReconciliationId: options.checkpoint.reconciliationId,
          expectedRevision: options.checkpoint.revision,
          checkpoint: nextCheckpoint,
          activities: [],
          complete: false,
        };
      });
    const h = makeCoordinator({ fetchReconciliationStep: fetchStep });

    const result = await h.coordinator.fullReconcile();

    expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();
    expect(h.store.startReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      revision: 0,
      accountLogin: 'viewer',
      credentialIdentity,
      windowDays: 60,
    }));
    expect(fetchStep).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({ revision: 0 }),
    }));
    expect(result.published).toBe(true);
    expect(result.status.reconciliation).toMatchObject({ phase: 'following' });
  });

  it('resumes a persisted full reconciliation before selecting a new refresh plan', async () => {
    const credentialIdentity = JSON.stringify(['viewer', 'identity-a', true]);
    const checkpoint = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:resume',
      accountLogin: 'viewer',
      credentialIdentity,
      windowDays: 60,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    const nextCheckpoint: RadarReconciliationCheckpoint = {
      ...checkpoint,
      revision: 1,
      updatedAt: new Date(NOW).toISOString(),
      cursor: {
        phase: 'following',
        nextCursor: 'following-next',
        seenCursors: ['following-next'],
        logins: [],
        totalCount: null,
      },
    };
    const fetchStep: NonNullable<RadarRefreshCoordinatorDependencies['fetchReconciliationStep']> =
      vi.fn(async (options) => ({
        expectedReconciliationId: options.checkpoint.reconciliationId,
        expectedRevision: options.checkpoint.revision,
        checkpoint: nextCheckpoint,
        activities: [],
        complete: false,
      }));
    const h = makeCoordinator({
      reconciliation: checkpoint,
      fetchReconciliationStep: fetchStep,
    });

    const result = await h.coordinator.refresh();

    expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();
    expect(fetchStep).toHaveBeenCalledWith(expect.objectContaining({
      token: 'main-token',
      checkpoint,
    }));
    expect(h.store.startReconciliation).not.toHaveBeenCalled();
    expect(h.store.commitReconciliationStep).toHaveBeenCalledWith(expect.objectContaining({
      accountLogin: 'viewer',
      credentialIdentity,
      windowDays: 60,
    }));
    expect(result.published).toBe(true);
    expect(result.status.reconciliation).toMatchObject({
      phase: 'following',
      totalCount: null,
      pauseReason: 'interrupted',
    });
  });

  it('chains budget-paused steps within one wake until the epoch completes', async () => {
    const checkpoint = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:chain',
      accountLogin: 'viewer',
      credentialIdentity: JSON.stringify(['viewer', 'identity-a', true]),
      windowDays: 60,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    let calls = 0;
    const fetchStep = vi.fn(async (options: FetchStepOptions) => {
      calls += 1;
      if (calls < 3) {
        return budgetPausedStep(options.checkpoint, {
          actors: 150,
          complete: calls * 50,
          remaining: 4_000,
          cost: 9,
        });
      }
      return terminalStep(options.checkpoint);
    });
    const h = makeCoordinator({
      reconciliation: checkpoint,
      fetchReconciliationStep: fetchStep,
    });

    const result = await h.coordinator.refresh();

    expect(fetchStep).toHaveBeenCalledTimes(3);
    expect(result.published).toBe(true);
    expect(result.status.reconciliation).toBeNull();
    // Each applied step publishes, so the surface advances instead of waiting
    // for the whole chain.
    expect(h.dependencies.broadcastChanged).toHaveBeenCalledTimes(3);
  });

  it('stops chaining when another step would breach the quota reserve', async () => {
    const checkpoint = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:reserve-stop',
      accountLogin: 'viewer',
      credentialIdentity: JSON.stringify(['viewer', 'identity-a', true]),
      windowDays: 60,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    // 10 requests priced at the observed 9-point cost would leave 50 or less.
    const fetchStep = vi.fn(async (options: FetchStepOptions) => budgetPausedStep(
      options.checkpoint,
      { actors: 150, complete: 50, remaining: 140, cost: 9 },
    ));
    const h = makeCoordinator({
      reconciliation: checkpoint,
      fetchReconciliationStep: fetchStep,
    });

    const result = await h.coordinator.refresh();

    expect(fetchStep).toHaveBeenCalledTimes(1);
    expect(result.published).toBe(true);
    expect(result.status.reconciliation).toMatchObject({ pauseReason: 'request_budget' });
  });

  it('does not chain past a deadline or quota pause', async () => {
    const checkpoint = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:pause-stop',
      accountLogin: 'viewer',
      credentialIdentity: JSON.stringify(['viewer', 'identity-a', true]),
      windowDays: 60,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    for (const pauseReason of ['deadline', 'rate_reserve'] as const) {
      const fetchStep = vi.fn(async (options: FetchStepOptions) => {
        const paused = budgetPausedStep(options.checkpoint, {
          actors: 150,
          complete: 50,
          remaining: 4_000,
          cost: 9,
        });
        return {
          ...paused,
          checkpoint: { ...paused.checkpoint, pauseReason },
        };
      });
      const h = makeCoordinator({
        reconciliation: checkpoint,
        fetchReconciliationStep: fetchStep,
      });

      await h.coordinator.refresh();

      expect(fetchStep).toHaveBeenCalledTimes(1);
    }
  });

  it('does not chain when GitHub reported no usable quota metadata', async () => {
    const checkpoint = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:unknown-quota',
      accountLogin: 'viewer',
      credentialIdentity: JSON.stringify(['viewer', 'identity-a', true]),
      windowDays: 60,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    const fetchStep = vi.fn(async (options: FetchStepOptions) => {
      const paused = budgetPausedStep(options.checkpoint, {
        actors: 150,
        complete: 50,
        remaining: 4_000,
        cost: 9,
      });
      return {
        ...paused,
        checkpoint: { ...paused.checkpoint, rateLimitRemaining: null, maxRequestCost: null },
      };
    });
    const h = makeCoordinator({
      reconciliation: checkpoint,
      fetchReconciliationStep: fetchStep,
    });

    await h.coordinator.refresh();

    expect(fetchStep).toHaveBeenCalledTimes(1);
  });

  it('abandons an epoch whose own fence keeps rejecting its step', async () => {
    const credentialIdentity = JSON.stringify(['viewer', 'identity-a', true]);
    const checkpoint = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:stuck',
      accountLogin: 'viewer',
      credentialIdentity,
      windowDays: 60,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    const fetchStep = vi.fn(async (options: FetchStepOptions) => terminalStep(options.checkpoint));
    const h = makeCoordinator({
      reconciliation: checkpoint,
      fetchReconciliationStep: fetchStep,
    });
    // The stored cursor refuses this step while the fence stays put, so
    // recomputing it would fail identically on every later wake.
    h.store.commitReconciliationStep.mockResolvedValueOnce({
      applied: false,
      state: state(),
      checkpoint,
    });

    const result = await h.coordinator.refresh();

    expect(result.published).toBe(false);
    expect(h.store.abandonReconciliation).toHaveBeenCalledWith('viewer', checkpoint.reconciliationId);
    expect(h.dependencies.broadcastChanged).not.toHaveBeenCalled();
  });

  it('leaves a moved fence alone when another epoch already advanced', async () => {
    const credentialIdentity = JSON.stringify(['viewer', 'identity-a', true]);
    const checkpoint = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:raced',
      accountLogin: 'viewer',
      credentialIdentity,
      windowDays: 60,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    const fetchStep = vi.fn(async (options: FetchStepOptions) => terminalStep(options.checkpoint));
    const h = makeCoordinator({
      reconciliation: checkpoint,
      fetchReconciliationStep: fetchStep,
    });
    h.store.commitReconciliationStep.mockResolvedValueOnce({
      applied: false,
      state: state(),
      checkpoint: { ...checkpoint, revision: checkpoint.revision + 1 },
    });

    const result = await h.coordinator.refresh();

    expect(result.published).toBe(false);
    expect(h.store.abandonReconciliation).not.toHaveBeenCalled();
  });
  it('uses the selected history window for the epoch, query, and status', async () => {
    const h = makeCoordinator();
    h.setWindowDays(90);

    // A widened window invalidates the saved baseline, so this refresh starts a
    // full epoch rather than an incremental snapshot.
    const refresh = await h.coordinator.refresh();
    const query = await h.coordinator.query();

    expect(h.store.startReconciliation).toHaveBeenCalledWith(expect.objectContaining({ windowDays: 90 }));
    expect(h.store.listActivities).toHaveBeenCalledWith('viewer', NOW, 90);
    expect(refresh.status.windowDays).toBe(90);
    expect(query.status.windowDays).toBe(90);
  });

  it('uses the selected history window for an incremental snapshot', async () => {
    const h = makeCoordinator({ state: state({ windowDays: 90 }) });
    h.setWindowDays(90);

    const refresh = await h.coordinator.refresh();

    expect(h.store.startReconciliation).not.toHaveBeenCalled();
    expect(h.dependencies.fetchRadar).toHaveBeenCalledWith(expect.objectContaining({
      windowDays: 90,
      refreshMode: 'incremental',
      lookbackDays: 7,
    }));
    expect(refresh.status.windowDays).toBe(90);
  });

  it('routes every policy branch to the path that owns it', async () => {
    const cases: Array<{
      request: 'auto' | 'full';
      state: RadarStateRecord | null;
      windowDays?: FollowingHistoryWindowDays;
      auth?: GitHubCredentialSnapshot;
      expected: { mode: 'full' | 'incremental'; windowDays: FollowingHistoryWindowDays };
    }> = [
      {
        request: 'full',
        state: state(),
        expected: { mode: 'full', windowDays: 60 },
      },
      {
        request: 'auto',
        state: null,
        expected: { mode: 'full', windowDays: 60 },
      },
      {
        request: 'auto',
        state: state({ partialReasons: ['github_star_list_truncated'] }),
        expected: { mode: 'incremental', windowDays: 60 },
      },
      {
        request: 'auto',
        state: state({ errorCode: 'network_error' }),
        expected: { mode: 'full', windowDays: 60 },
      },
      {
        request: 'auto',
        state: state({ windowDays: 60 }),
        windowDays: 90,
        expected: { mode: 'full', windowDays: 90 },
      },
      {
        request: 'auto',
        state: state(),
        auth: authSnapshot({ mainIdentity: 'identity-b' }),
        expected: { mode: 'full', windowDays: 60 },
      },
      {
        request: 'auto',
        state: state({
          lastFullReconciledAt: new Date(NOW - 7 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
        expected: { mode: 'full', windowDays: 60 },
      },
      {
        request: 'auto',
        state: state(),
        expected: { mode: 'incremental', windowDays: 60 },
      },
    ];

    for (const testCase of cases) {
      const h = makeCoordinator({ state: testCase.state, auth: testCase.auth });
      if (testCase.windowDays) h.setWindowDays(testCase.windowDays);
      await h.coordinator.refresh(testCase.request);
      if (testCase.expected.mode === 'full') {
        expect(h.store.startReconciliation).toHaveBeenCalledWith(expect.objectContaining({
          windowDays: testCase.expected.windowDays,
        }));
        expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();
      } else {
        expect(h.dependencies.fetchRadar).toHaveBeenCalledWith(expect.objectContaining({
          refreshMode: 'incremental',
          lookbackDays: 7,
          windowDays: testCase.expected.windowDays,
        }));
        expect(h.store.startReconciliation).not.toHaveBeenCalled();
      }
    }
  });
  it('abandons an in-flight result when the history window changes', async () => {
    let release!: (value: RadarSourceSnapshot) => void;
    const fetchRadar = vi.fn(() => new Promise<RadarSourceSnapshot>((resolve) => { release = resolve; }));
    const h = makeCoordinator({ fetchRadar });

    const refresh = h.coordinator.refresh();
    while (!release) await Promise.resolve();
    h.setWindowDays(90);
    release(snapshot({ windowDays: 60 }));

    const result = await refresh;
    expect(result.published).toBe(false);
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
    expect(result.status.windowDays).toBe(90);
  });

  it('does not publish when the history window changes during snapshot commit', async () => {
    let releaseCommit!: () => void;
    const h = makeCoordinator();
    h.store.commitSnapshot.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseCommit = resolve; });
      return state();
    });

    const refresh = h.coordinator.refresh();
    while (!releaseCommit) await Promise.resolve();
    h.setWindowDays(90);
    releaseCommit();

    const result = await refresh;
    expect(h.store.commitSnapshot).toHaveBeenCalledTimes(1);
    expect(result.published).toBe(false);
    expect(h.dependencies.broadcastChanged).not.toHaveBeenCalled();
    expect(result.status.windowDays).toBe(90);
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

  it('honors a future cooldown regardless of the previous error code', async () => {
    const h = makeCoordinator({
      state: state({
        errorCode: 'permission_denied',
        nextAllowedAt: new Date(NOW + 60_000).toISOString(),
      }),
    });

    const result = await h.coordinator.refresh();

    expect(result.published).toBe(false);
    expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
  });

  it('fences the fetch when the account window changes during preparation', async () => {
    const h = makeCoordinator();
    h.store.prepareAccount
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { h.setWindowDays(90); });

    const result = await h.coordinator.refresh();

    expect(result.published).toBe(false);
    expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
    expect(result.status.windowDays).toBe(90);
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
  it('does not surface a failure-recording error or broadcast stale failure state', async () => {
    const h = makeCoordinator({
      fetchRadar: vi.fn(async () => {
        throw new GitHubRadarError('permission_denied', { status: 403 });
      }),
    });
    h.store.recordFailure.mockRejectedValueOnce(new Error('storage unavailable'));

    const result = await h.coordinator.refresh();

    expect(result.published).toBe(false);
    expect(h.dependencies.broadcastChanged).not.toHaveBeenCalled();
  });


  it('rejects a source snapshot published for a different account', async () => {
    const h = makeCoordinator({
      fetchRadar: vi.fn(async () => snapshot({ accountLogin: 'other-user' })),
    });

    const result = await h.coordinator.refresh();

    expect(result.published).toBe(false);
    expect(h.store.commitSnapshot).not.toHaveBeenCalled();
    expect(h.store.recordFailure).toHaveBeenCalledWith('viewer', 'invalid_response', {
      nextAllowedAt: new Date(NOW + 5 * 60 * 1_000).toISOString(),
    });
  });

  it('lets an explicit full request pass a transient-failure cooldown', async () => {
    const fetchStep = vi.fn(async (options: FetchStepOptions) => terminalStep(options.checkpoint));
    const h = makeCoordinator({
      state: state({
        errorCode: 'network_error',
        nextAllowedAt: new Date(NOW + 60_000).toISOString(),
      }),
      fetchReconciliationStep: fetchStep,
    });

    const automatic = await h.coordinator.refresh('auto');
    expect(automatic.published).toBe(false);
    expect(fetchStep).not.toHaveBeenCalled();
    expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();

    const explicit = await h.coordinator.refresh('full');
    expect(explicit.published).toBe(true);
    expect(h.store.startReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      windowDays: 60,
    }));
    expect(fetchStep).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit full request behind an active rate-limit cooldown', async () => {
    const fetchStep = vi.fn(async (options: FetchStepOptions) => terminalStep(options.checkpoint));
    const h = makeCoordinator({
      state: state({
        errorCode: 'rate_limited',
        nextAllowedAt: new Date(NOW + 60_000).toISOString(),
      }),
      fetchReconciliationStep: fetchStep,
    });

    const result = await h.coordinator.refresh('full');

    expect(result.published).toBe(false);
    expect(fetchStep).not.toHaveBeenCalled();
    expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();
  });

  it('keeps an explicit full request behind a rate-reserve checkpoint', async () => {
    const credentialIdentity = JSON.stringify(['viewer', 'identity-a', true]);
    const base = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:reserve',
      accountLogin: 'viewer',
      credentialIdentity,
      windowDays: 60,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    const fetchStep = vi.fn();
    const h = makeCoordinator({
      state: state({ nextAllowedAt: null }),
      reconciliation: {
        ...base,
        pauseReason: 'rate_reserve',
        nextAllowedAt: new Date(NOW + 60_000).toISOString(),
      },
      fetchReconciliationStep: fetchStep,
    });

    const result = await h.coordinator.refresh('full');

    expect(result.published).toBe(false);
    expect(fetchStep).not.toHaveBeenCalled();
    expect(h.dependencies.fetchRadar).not.toHaveBeenCalled();
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
