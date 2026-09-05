import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubRadar, fetchGitHubRadarReconciliationStep } from '@/api/github-radar-source';
import { authStore, type GitHubCredentialSnapshot } from '@/auth/auth-store';
import { createRadarRefreshCoordinator } from '@/background/radar-refresh';
import { createSerializedRunner } from '@/background/serialized-runner';
import { createRadarReconciliationCheckpoint } from '@/radar/radar-model';
import { db } from '@/storage/db';
import {
  abandonRadarReconciliation,
  clearRadarData,
  commitRadarReconciliationStep,
  commitRadarSnapshot,
  dismissRadarActivities,
  getRadarReconciliation,
  getRadarState,
  listRadarActivities,
  markRadarActivitiesSeen,
  prepareRadarAccount,
  recordRadarFailure,
  startRadarReconciliation,
} from '@/storage/radar-store';
import { createChromeMock } from '../../helpers/chrome-mock';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const RESET_AT = '2026-08-10T13:00:00.000Z';
const ACTORS = Array.from({ length: 80 }, (_, index) => `actor-${index}`);
const AUTH: GitHubCredentialSnapshot = {
  accountLogin: 'viewer',
  mainToken: 'synthetic-token',
  mainIdentity: 'synthetic-identity',
  notificationsToken: null,
  notificationsIdentity: 'synthetic-notifications',
  notificationsConfigured: false,
};
const CREDENTIAL_IDENTITY = JSON.stringify(['viewer', AUTH.mainIdentity, true]);

async function seedActivityCheckpoint(remaining: number) {
  const checkpoint = createRadarReconciliationCheckpoint({
    reconciliationId: 'radar-reconcile:continuation',
    accountLogin: 'viewer',
    credentialIdentity: CREDENTIAL_IDENTITY,
    windowDays: 30,
    startedAt: new Date(NOW).toISOString(),
  });
  await startRadarReconciliation(checkpoint);
  const seeded = await commitRadarReconciliationStep({
    accountLogin: 'viewer',
    credentialIdentity: CREDENTIAL_IDENTITY,
    windowDays: 30,
    step: {
      expectedReconciliationId: checkpoint.reconciliationId,
      expectedRevision: checkpoint.revision,
      complete: false,
      activities: [],
      hasCurrentRequestCost: true,
      checkpoint: {
        ...checkpoint,
        revision: 1,
        rateLimitRemaining: remaining,
        maxRequestCost: 1,
        pauseReason: 'request_budget',
        cursor: {
          phase: 'activity',
          followingCount: ACTORS.length,
          actors: ACTORS.map((login) => ({
            login,
            nextCursor: `saved-${login}`,
            seenCursors: [`saved-${login}`],
            complete: false,
          })),
        },
      },
    },
  });
  expect(seeded.applied).toBe(true);
}

function activityEnvelope(logins: string[], remaining: number, cost: number | undefined) {
  return {
    data: {
      ...Object.fromEntries(logins.map((login, index) => [`follower${index}`, {
        login,
        avatarUrl: null,
        starredRepositories: {
          edges: [{
            starredAt: new Date(NOW - 60_000).toISOString(),
            node: {
              nameWithOwner: `owner/${login}`,
              owner: { login: 'owner', avatarUrl: null },
              description: 'Synthetic public repository',
              isPrivate: false,
              stargazerCount: 1,
              viewerHasStarred: false,
              primaryLanguage: null,
              repositoryTopics: { nodes: [] },
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }])),
      rateLimit: { remaining, ...(cost === undefined ? {} : { cost }), resetAt: RESET_AT },
    },
  };
}

async function makeHarness(boundary: 'reserve' | 'deadline' | 'healthy' | 'missing-cost' | 'invalid-cost') {
  const costBoundary = boundary === 'missing-cost' || boundary === 'invalid-cost';
  const quota = {
    remaining: costBoundary ? 81 : 4_000,
    cost: boundary === 'missing-cost' ? undefined : boundary === 'invalid-cost' ? -1 : 1,
  };
  await seedActivityCheckpoint(quota.remaining);
  const clock = { now: NOW };
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  const requests: string[][] = [];
  let completedActors = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe('https://api.github.com/graphql');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain('query RadarActivityBatch');
    const logins = ACTORS.slice(completedActors, completedActors + 5);
    expect(logins).toHaveLength(5);
    expect(body.variables).toEqual(Object.fromEntries(logins.flatMap((login, index) => [
      [`login${index}`, login],
      [`cursor${index}`, `saved-${login}`],
    ])));
    requests.push(logins);
    const requestNumber = requests.length;
    if (boundary === 'reserve' && requestNumber === 10) {
      return new Response(null, {
        status: 504,
        headers: {
          'x-ratelimit-remaining': '49',
          'x-ratelimit-reset': String(Date.parse(RESET_AT) / 1_000),
        },
      });
    }
    if (costBoundary) quota.remaining -= 2;
    const remaining = costBoundary
      ? quota.remaining
      : boundary === 'reserve' && requestNumber < 10 ? 70 - requestNumber : 4_000;
    const envelope = activityEnvelope(logins, remaining, quota.cost);
    completedActors += logins.length;
    const response = new Response(JSON.stringify(envelope), {
      headers: { 'content-type': 'application/json' },
    });
    if (boundary === 'deadline' && requestNumber === 10) {
      // Only the body crosses the deadline; IndexedDB continues using real timers.
      clock.now = NOW + 119_999;
      vi.spyOn(response, 'json').mockImplementation(async () => {
        clock.now = NOW + 120_001;
        return envelope;
      });
    }
    return response;
  });
  const config = await authStore.getConfig();
  const createCoordinator = () => createRadarRefreshCoordinator({
    runSerialized: createSerializedRunner().run,
    auth: {
      getGitHubCredentialSnapshot: async () => AUTH,
      getConfig: async () => ({ ...config, radarWindowDays: 30 }),
    },
    fetchRadar: (options) => fetchGitHubRadar({ ...options, fetchImpl }),
    fetchReconciliationStep: (options) => fetchGitHubRadarReconciliationStep({ ...options, fetchImpl }),
    store: {
      abandonReconciliation: abandonRadarReconciliation,
      clearData: clearRadarData,
      commitReconciliationStep: commitRadarReconciliationStep,
      commitSnapshot: commitRadarSnapshot,
      dismissActivities: dismissRadarActivities,
      getReconciliation: getRadarReconciliation,
      getState: getRadarState,
      listActivities: listRadarActivities,
      markActivitiesSeen: markRadarActivitiesSeen,
      prepareAccount: prepareRadarAccount,
      recordFailure: recordRadarFailure,
      startReconciliation: startRadarReconciliation,
    },
    now: () => clock.now,
    broadcastChanged: vi.fn(),
  });
  return { clock, quota, requests, fetchImpl, createCoordinator };
}

describe('Radar continuation boundaries', () => {
  beforeEach(async () => {
    vi.stubGlobal('chrome', createChromeMock().api);
    await db.delete();
    await db.open();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => db.close());

  it('persists a failed-request reserve boundary and resumes only the saved actors after reset', async () => {
    const h = await makeHarness('reserve');
    const coordinator = h.createCoordinator();
    const result = await coordinator.refresh();

    expect(result.published).toBe(true);
    expect(h.fetchImpl).toHaveBeenCalledTimes(10);
    const checkpoint = await getRadarReconciliation('viewer');
    expect(checkpoint).toMatchObject({
      revision: 2,
      pauseReason: 'rate_reserve',
      rateLimitRemaining: 49,
      rateLimitResetAt: RESET_AT,
      nextAllowedAt: RESET_AT,
      maxRequestCost: 1,
      scannedFollowingCount: 45,
      batchCount: 9,
      partialReasons: [],
    });
    expect(checkpoint?.cursor).toEqual({
      phase: 'activity',
      followingCount: 80,
      actors: ACTORS.map((login, index) => ({
        login,
        nextCursor: index < 45 ? null : `saved-${login}`,
        seenCursors: [`saved-${login}`],
        complete: index < 45,
      })),
    });
    expect(await db.radarActivities.count()).toBe(45);
    expect(await getRadarState('viewer')).toMatchObject({
      lastFullReconciledAt: null,
      lastSuccessfulAt: null,
      credentialIdentity: null,
      rateLimitRemaining: 49,
      rateLimitResetAt: RESET_AT,
      errorCode: null,
    });
    expect((await coordinator.fullReconcile()).published).toBe(false);
    expect(h.fetchImpl).toHaveBeenCalledTimes(10);

    await db.close();
    await db.open();
    h.clock.now = Date.parse(RESET_AT) + 1;
    expect((await h.createCoordinator().refresh()).published).toBe(true);
    expect(h.fetchImpl).toHaveBeenCalledTimes(17);
    expect(h.requests.slice(10).flat()).toEqual(ACTORS.slice(45));
    expect(await getRadarReconciliation('viewer')).toBeNull();
    expect(await db.radarActivities.count()).toBe(80);
    expect(await getRadarState('viewer')).toMatchObject({
      lastFullReconciledAt: new Date(h.clock.now).toISOString(),
      scannedFollowingCount: 80,
      partialReasons: [],
      errorCode: null,
    });
  });

  it('saves a deadline pause when the final budgeted response body finishes after the deadline', async () => {
    const h = await makeHarness('deadline');
    const result = await h.createCoordinator().refresh();

    expect(result.published).toBe(true);
    expect(h.fetchImpl).toHaveBeenCalledTimes(10);
    expect(await getRadarReconciliation('viewer')).toMatchObject({
      revision: 2,
      pauseReason: 'deadline',
      rateLimitRemaining: 4_000,
      nextAllowedAt: null,
      scannedFollowingCount: 50,
      batchCount: 10,
      partialReasons: [],
    });
    expect(await db.radarActivities.count()).toBe(50);
    expect(await getRadarState('viewer')).toMatchObject({
      lastFullReconciledAt: null,
      lastSuccessfulAt: null,
      credentialIdentity: null,
      errorCode: null,
    });
  });

  it.each(['missing-cost', 'invalid-cost'] as const)(
    'commits ten requests without spending the reserve on a historical estimate after %s responses',
    async (boundary) => {
      const h = await makeHarness(boundary);
      const coordinator = h.createCoordinator();
      const result = await coordinator.refresh();

      expect(result.published).toBe(true);
      expect(h.fetchImpl).toHaveBeenCalledTimes(10);
      expect(h.quota.remaining).toBe(61);
      expect(h.requests.flat()).toEqual(ACTORS.slice(0, 50));
      const checkpoint = await getRadarReconciliation('viewer');
      expect(checkpoint).toMatchObject({
        revision: 2,
        pauseReason: 'request_budget',
        rateLimitRemaining: 61,
        maxRequestCost: 1,
        nextAllowedAt: null,
        scannedFollowingCount: 50,
        batchCount: 10,
        partialReasons: [],
      });
      expect(checkpoint?.cursor).toEqual({
        phase: 'activity',
        followingCount: 80,
        actors: ACTORS.map((login, index) => ({
          login,
          nextCursor: index < 50 ? null : `saved-${login}`,
          seenCursors: [`saved-${login}`],
          complete: index < 50,
        })),
      });
      expect(await db.radarActivities.count()).toBe(50);
      expect(await getRadarState('viewer')).toMatchObject({
        lastFullReconciledAt: null,
        lastSuccessfulAt: null,
        credentialIdentity: null,
        rateLimitRemaining: 61,
        maxRequestCost: 1,
        errorCode: null,
      });
      expect(checkpoint).not.toHaveProperty('hasCurrentRequestCost');
      const storedState = await db.radarState.get('singleton');
      expect(storedState).not.toHaveProperty('hasCurrentRequestCost');
      expect(storedState?.reconciliation).not.toHaveProperty('hasCurrentRequestCost');
      expect(result.status).not.toHaveProperty('hasCurrentRequestCost');
      expect(result.status.state).not.toHaveProperty('hasCurrentRequestCost');
      expect(result.status.reconciliation).not.toHaveProperty('hasCurrentRequestCost');
      expect(result.status.reconciliation).toMatchObject({
        completedCount: 50,
        totalCount: 80,
        pauseReason: 'request_budget',
      });

      await db.close();
      await db.open();
      h.clock.now = Date.parse(RESET_AT) + 1;
      h.quota.remaining = 4_000;
      h.quota.cost = 2;
      const resumed = await h.createCoordinator().refresh();

      expect(resumed.published).toBe(true);
      expect(h.fetchImpl).toHaveBeenCalledTimes(16);
      expect(h.quota.remaining).toBe(3_988);
      expect(h.requests.slice(10).flat()).toEqual(ACTORS.slice(50));
      expect(await getRadarReconciliation('viewer')).toBeNull();
      expect(await db.radarActivities.count()).toBe(80);
      expect(await getRadarState('viewer')).toMatchObject({
        lastFullReconciledAt: new Date(h.clock.now).toISOString(),
        credentialIdentity: CREDENTIAL_IDENTITY,
        maxRequestCost: 2,
        scannedFollowingCount: 80,
        batchCount: 16,
        partialReasons: [],
        errorCode: null,
      });
      expect(await db.radarState.get('singleton')).not.toHaveProperty('hasCurrentRequestCost');
      expect(resumed.status.state).not.toHaveProperty('hasCurrentRequestCost');
    },
  );

  it('chains affordable request-budget steps to terminal coverage in one wake', async () => {
    const h = await makeHarness('healthy');
    const result = await h.createCoordinator().refresh();

    expect(result.published).toBe(true);
    expect(h.fetchImpl).toHaveBeenCalledTimes(16);
    expect(h.requests.flat()).toEqual(ACTORS);
    expect(await getRadarReconciliation('viewer')).toBeNull();
    expect(await db.radarActivities.count()).toBe(80);
    expect(await getRadarState('viewer')).toMatchObject({
      lastFullReconciledAt: new Date(NOW).toISOString(),
      credentialIdentity: CREDENTIAL_IDENTITY,
      scannedFollowingCount: 80,
      batchCount: 16,
      partialReasons: [],
      errorCode: null,
    });
  });
});
