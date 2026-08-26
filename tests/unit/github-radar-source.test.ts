import { describe, expect, it, vi } from 'vitest';
import {
  fetchGitHubRadar,
  fetchGitHubRadarReconciliationStep,
} from '@/api/github-radar-source';
import {
  createRadarReconciliationCheckpoint,
  type RadarReconciliationCheckpoint,
} from '@/radar/radar-model';

const NOW = new Date('2026-08-10T12:00:00.000Z');

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

function followingEnvelope(input: {
  logins: string[];
  totalCount?: number;
  hasNextPage?: boolean;
  endCursor?: string | null;
  remaining?: number;
  cost?: number;
}) {
  return {
    data: {
      viewer: {
        login: 'Viewer',
        following: {
          totalCount: input.totalCount ?? input.logins.length,
          nodes: input.logins.map((login) => ({ login })),
          pageInfo: {
            hasNextPage: input.hasNextPage ?? false,
            endCursor: input.endCursor ?? null,
          },
        },
      },
      rateLimit: {
        ...(input.cost === undefined ? {} : { cost: input.cost }),
        remaining: input.remaining ?? 4999,
        resetAt: '2026-08-10T13:00:00Z',
      },
    },
  };
}

function repository(
  nameWithOwner: string,
  overrides: Partial<{
    description: string | null;
    isPrivate: boolean;
    stargazerCount: number;
    viewerHasStarred: boolean;
    languageName: string | null;
    languageColor: string | null;
    ownerLogin: string | null;
    ownerAvatarUrl: string | null;
    topics: string[];
  }> = {},
) {
  const languageName = overrides.languageName === undefined ? 'TypeScript' : overrides.languageName;
  const languageColor = overrides.languageColor === undefined ? '#3178c6' : overrides.languageColor;
  const ownerLogin = overrides.ownerLogin === undefined
    ? nameWithOwner.split('/')[0]!
    : overrides.ownerLogin;
  return {
    nameWithOwner,
    description: overrides.description ?? `${nameWithOwner} description`,
    isPrivate: overrides.isPrivate ?? false,
    stargazerCount: overrides.stargazerCount ?? 10,
    viewerHasStarred: overrides.viewerHasStarred ?? false,
    primaryLanguage: languageName ? { name: languageName, color: languageColor } : null,
    repositoryTopics: {
      nodes: (overrides.topics ?? []).map((name) => ({ topic: { name } })),
    },
    owner: ownerLogin ? { login: ownerLogin, avatarUrl: overrides.ownerAvatarUrl ?? null } : null,
  };
}

function activityEnvelope(followers: Array<{
  login: string;
  avatarUrl?: string | null;
  edges: Array<{ starredAt: string; node: unknown }>;
  hasNextPage?: boolean;
  endCursor?: string | null;
}>, remaining = 4900, cost?: number) {
  return {
    data: {
      ...Object.fromEntries(followers.map((follower, index) => [
        `follower${index}`,
        {
          avatarUrl: follower.avatarUrl === undefined
            ? `https://avatars.example/${follower.login}.png`
            : follower.avatarUrl,
          login: follower.login,
          starredRepositories: {
            edges: follower.edges,
            pageInfo: {
              hasNextPage: follower.hasNextPage ?? false,
              endCursor: follower.endCursor ?? null,
            },
          },
        },
      ])),
      rateLimit: {
        ...(cost === undefined ? {} : { cost }),
        remaining,
        resetAt: '2026-08-10T13:00:00Z',
      },
    },
  };
}

describe('GitHub Radar source', () => {
  it('scans followed accounts, omits private activity, and publishes one normalized flat feed', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown>; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push({ ...body, init: init ?? {} });
      if (body.query.includes('RadarFollowing')) {
        return jsonResponse(followingEnvelope({ logins: ['Alice', 'Bob'] }));
      }
      return jsonResponse(activityEnvelope([
        {
          login: 'Alice',
          edges: [
            {
              starredAt: '2026-08-10T10:00:00Z',
              node: repository('Owner/One', {
                viewerHasStarred: true,
                stargazerCount: 21,
                topics: [' TypeScript ', 'ai', 'typescript', 'AI'],
              }),
            },
            {
              starredAt: '2026-08-10T09:00:00Z',
              node: repository('private/secret', { isPrivate: true }),
            },
          ],
        },
        {
          login: 'Bob',
          edges: [{
            starredAt: '2026-08-10T11:00:00Z',
            node: repository('Owner/Two', {
              languageName: 'Rust',
              languageColor: '#dea584',
              stargazerCount: 34,
            }),
          }],
        },
      ]));
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({ token: ' secret ', fetchImpl, now: () => NOW });

    expect(snapshot).toMatchObject({
      accountLogin: 'viewer',
      fetchedAt: NOW.toISOString(),
      windowDays: 30,
      refreshMode: 'full',
      lookbackDays: 30,
      followingCount: 2,
      scannedFollowingCount: 2,
      batchCount: 1,
      partialReasons: ['private_activity_omitted'],
      rateLimitRemaining: 4900,
      rateLimitResetAt: '2026-08-10T13:00:00.000Z',
    });
    expect(snapshot.activities.map((activity) => activity.repositoryKey)).toEqual([
      'owner/two',
      'owner/one',
    ]);
    expect(snapshot.activities[1]).toMatchObject({
      actorLogin: 'Alice',
      actorAvatarUrl: 'https://avatars.example/Alice.png',
      repositoryFullName: 'Owner/One',
      viewerHadStarred: true,
      seenAt: null,
      repositoryStargazerCount: 21,
      repositoryTopics: ['ai', 'typescript'],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.variables).toEqual({
      login0: 'Alice',
      cursor0: null,
      login1: 'Bob',
      cursor1: null,
    });
    expect(calls[1]?.query).toContain('avatarUrl');
    expect(calls[1]?.query).toContain('first: 30');
    expect(calls[1]?.query).toContain('repositoryTopics(first: 20)');
    expect(calls[1]?.query).toContain('after: $cursor0');
    expect(calls[1]?.query).toContain('after: $cursor1');
    expect(calls[1]?.query).toMatch(/node\s*\{\s*nameWithOwner\s*owner\s*\{\s*login\s+avatarUrl\s*\}/u);
    expect(calls[1]?.query).not.toMatch(/starredRepositories\([^)]*owner\s*\{/u);
    expect(calls[0]?.init).toMatchObject({ method: 'POST' });
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer secret');
  });

  it('retries only the failed Following page after a transient GitHub failure', async () => {
    vi.useFakeTimers();
    try {
      const followingCursors: unknown[] = [];
      let secondPageAttempts = 0;
      const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (body.query.includes('RadarFollowing')) {
          followingCursors.push(body.variables.cursor);
          if (body.variables.cursor === null) {
            return jsonResponse(followingEnvelope({
              logins: ['alice'],
              totalCount: 2,
              hasNextPage: true,
              endCursor: 'following-page-2',
            }));
          }
          secondPageAttempts += 1;
          if (secondPageAttempts === 1) return new Response('', { status: 503 });
          return jsonResponse(followingEnvelope({ logins: ['bob'], totalCount: 2 }));
        }
        return jsonResponse(activityEnvelope([
          { login: 'alice', edges: [] },
          { login: 'bob', edges: [] },
        ]));
      }) as typeof fetch;

      const result = fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW });
      await vi.advanceTimersByTimeAsync(500);
      const snapshot = await result;

      expect(followingCursors).toEqual([null, 'following-page-2', 'following-page-2']);
      expect(snapshot.scannedFollowingCount).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries only the failed activity batch after a transient network failure', async () => {
    vi.useFakeTimers();
    try {
      const logins = ['one', 'two', 'three', 'four', 'five', 'six'];
      const activityVariables: Record<string, unknown>[] = [];
      let followingRequests = 0;
      let finalBatchAttempts = 0;
      const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (body.query.includes('RadarFollowing')) {
          followingRequests += 1;
          return jsonResponse(followingEnvelope({ logins }));
        }
        activityVariables.push(body.variables);
        const batchLogins = Object.entries(body.variables)
          .filter(([name]) => name.startsWith('login'))
          .map(([, login]) => String(login));
        if (batchLogins.length === 1) {
          finalBatchAttempts += 1;
          if (finalBatchAttempts === 1) throw new TypeError('synthetic network failure');
        }
        return jsonResponse(activityEnvelope(batchLogins.map((login) => ({ login, edges: [] }))));
      }) as typeof fetch;

      const result = fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW });
      await vi.advanceTimersByTimeAsync(500);
      const snapshot = await result;

      expect(followingRequests).toBe(1);
      expect(activityVariables).toHaveLength(3);
      expect(activityVariables[1]).toEqual({ login0: 'six', cursor0: null });
      expect(activityVariables[2]).toEqual(activityVariables[1]);
      expect(snapshot.batchCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds persistent transient failures to three attempts', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
      const rejection = expect(fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW }))
        .rejects.toMatchObject({ code: 'github_unavailable', status: 503 });

      await vi.advanceTimersByTimeAsync(1_500);
      await rejection;
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops transient retry backoff at the global deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
      let caughtError: unknown = null;
      const result = fetchGitHubRadar({
        token: 'token',
        fetchImpl,
        now: () => NOW,
        deadlineMs: 100,
      }).catch((error: unknown) => {
        caughtError = error;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(caughtError).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(caughtError).toMatchObject({ code: 'deadline_exceeded' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves caller abort while waiting to retry a transient failure', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => new Response('', { status: 503 })) as typeof fetch;
      const rejection = expect(fetchGitHubRadar({
        token: 'token',
        fetchImpl,
        now: () => NOW,
        signal: controller.signal,
      })).rejects.toMatchObject({ code: 'request_aborted' });

      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await rejection;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps valid activity aliases when a followed account is missing', async () => {
    let request = 0;
    const fetchImpl = vi.fn(async () => {
      request += 1;
      if (request === 1) {
        return jsonResponse(followingEnvelope({ logins: ['alice', 'bob'] }));
      }
      const valid = activityEnvelope([{
        login: 'bob',
        edges: [{ starredAt: NOW.toISOString(), node: repository('owner/valid') }],
      }]);
      return jsonResponse({
        data: {
          ...valid.data,
          follower0: null,
          follower1: (valid.data as Record<string, unknown>).follower0,
        },
        errors: [{ type: 'NOT_FOUND', path: ['follower0'] }],
      });
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW });

    expect(snapshot.activities.map((activity) => activity.repositoryKey)).toEqual(['owner/valid']);
    expect(snapshot.scannedFollowingCount).toBe(1);
    expect(snapshot.batchCount).toBe(1);
    expect(snapshot.partialReasons).toEqual(['following_scan_truncated']);
  });

  it('keeps earlier activity when a continuation alias disappears', async () => {
    let request = 0;
    const fetchImpl = vi.fn(async () => {
      request += 1;
      if (request === 1) return jsonResponse(followingEnvelope({ logins: ['alice'] }));
      if (request === 2) {
        return jsonResponse(activityEnvelope([{
          login: 'alice',
          edges: [{ starredAt: NOW.toISOString(), node: repository('owner/first-page') }],
          hasNextPage: true,
          endCursor: 'page-2',
        }]));
      }
      return jsonResponse({
        data: {
          follower0: null,
          rateLimit: { remaining: 4_800, resetAt: '2026-08-10T13:00:00Z' },
        },
        errors: [{ type: 'NOT_FOUND', path: ['follower0'] }],
      });
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW });

    expect(snapshot.activities.map((activity) => activity.repositoryKey)).toEqual(['owner/first-page']);
    expect(snapshot.scannedFollowingCount).toBe(1);
    expect(snapshot.batchCount).toBe(2);
    expect(snapshot.partialReasons).toEqual(['github_star_list_truncated']);
  });

  it.each([
    {
      name: 'unscoped missing resource',
      errors: [{ type: 'NOT_FOUND', path: ['viewer'] }],
      code: 'invalid_response',
    },
    {
      name: 'out-of-range activity alias',
      errors: [{ type: 'NOT_FOUND', path: ['follower9'] }],
      code: 'invalid_response',
    },
    {
      name: 'mixed missing and rate-limited aliases',
      errors: [
        { type: 'NOT_FOUND', path: ['follower0'] },
        { type: 'RATE_LIMITED', path: ['rateLimit'] },
      ],
      code: 'rate_limited',
    },
  ])('keeps $name GraphQL errors fatal', async ({ errors, code }) => {
    let request = 0;
    const fetchImpl = vi.fn(async () => {
      request += 1;
      if (request === 1) return jsonResponse(followingEnvelope({ logins: ['alice'] }));
      return jsonResponse({
        ...activityEnvelope([{ login: 'alice', edges: [] }]),
        errors,
      });
    }) as typeof fetch;

    await expect(fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW }))
      .rejects.toMatchObject({ code });
  });

  it('truthfully reports following truncation before making unaffordable activity requests', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(followingEnvelope({
      logins: ['alice', 'bob'],
      totalCount: 3,
      hasNextPage: true,
      endCursor: 'next',
      remaining: 40,
    }))) as typeof fetch;

    const snapshot = await fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(snapshot.activities).toEqual([]);
    expect(snapshot.followingCount).toBe(3);
    expect(snapshot.scannedFollowingCount).toBe(0);
    expect(snapshot.partialReasons).toEqual(['following_scan_truncated']);
  });

  it('splits the default 30-edge activity query into five-actor batches', async () => {
    const logins = ['one', 'two', 'three', 'four', 'five', 'six'];
    const activityBatchSizes: number[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes('RadarFollowing')) {
        return jsonResponse(followingEnvelope({ logins }));
      }
      const batchLogins = Object.entries(body.variables)
        .filter(([name]) => name.startsWith('login'))
        .map(([, login]) => String(login));
      activityBatchSizes.push(batchLogins.length);
      return jsonResponse(activityEnvelope(batchLogins.map((login) => ({ login, edges: [] }))));
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW });

    expect(activityBatchSizes).toEqual([5, 1]);
    expect(snapshot.batchCount).toBe(2);
    expect(snapshot.scannedFollowingCount).toBe(6);
  });

  it('deduplicates activity without applying a global 30-row display bound', async () => {
    const followers = ['alice', 'bob'].map((login, followerIndex) => ({
      login,
      edges: Array.from({ length: 20 }, (_, index) => {
        const position = followerIndex * 20 + index;
        return {
          starredAt: new Date(NOW.getTime() - position * 60_000).toISOString(),
          node: repository(`owner/repo-${position}`),
        };
      }),
    }));
    followers[0]!.edges.push(followers[0]!.edges[0]!);
    let request = 0;
    const fetchImpl = vi.fn(async () => {
      request += 1;
      return request === 1
        ? jsonResponse(followingEnvelope({ logins: ['alice', 'bob'] }))
        : jsonResponse(activityEnvelope(followers));
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW });

    expect(snapshot.activities).toHaveLength(40);
    expect(new Set(snapshot.activities.map((activity) => activity.id)).size).toBe(40);
    expect(snapshot.activities[0]?.repositoryKey).toBe('owner/repo-0');
    expect(snapshot.activities.at(-1)?.repositoryKey).toBe('owner/repo-39');
    expect(snapshot.activities[0]?.repositoryOwnerLogin).toBe('owner');
    expect(snapshot.activities[0]?.repositoryOwnerAvatarUrl).toBeNull();
    expect(snapshot.activities.at(-1)?.repositoryOwnerLogin).toBe('owner');
  });

  it('pages active accounts until their activity crosses the default 30-day cutoff', async () => {
    const recentOne = new Date(NOW.getTime() - 60_000).toISOString();
    const recentTwo = new Date(NOW.getTime() - 120_000).toISOString();
    const recentThree = new Date(NOW.getTime() - 180_000).toISOString();
    const expired = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1_000).toISOString();
    const activityVariables: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes('RadarFollowing')) {
        return jsonResponse(followingEnvelope({ logins: ['alice'] }));
      }
      activityVariables.push(body.variables);
      if (body.variables.cursor0 === null) {
        return jsonResponse(activityEnvelope([{
          login: 'alice',
          edges: [
            { starredAt: recentOne, node: repository('owner/one') },
            { starredAt: recentTwo, node: repository('owner/two') },
          ],
          hasNextPage: true,
          endCursor: 'page-2',
        }]));
      }
      return jsonResponse(activityEnvelope([{
        login: 'alice',
        edges: [
          { starredAt: recentThree, node: repository('owner/three') },
          { starredAt: expired, node: repository('owner/expired') },
        ],
        hasNextPage: true,
        endCursor: 'page-3',
      }]));
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({
      token: 'token',
      fetchImpl,
      now: () => NOW,
      starsPerFollower: 2,
    });

    expect(activityVariables).toEqual([
      { login0: 'alice', cursor0: null },
      { login0: 'alice', cursor0: 'page-2' },
    ]);
    expect(snapshot.activities.map((activity) => activity.repositoryKey)).toEqual([
      'owner/one',
      'owner/two',
      'owner/three',
    ]);
    expect(snapshot.batchCount).toBe(2);
    expect(snapshot.windowDays).toBe(30);
    expect(snapshot.partialReasons).toEqual([]);
  });

  it('publishes fetched pages as partial when the rate reserve blocks continuation', async () => {
    let request = 0;
    const fetchImpl = vi.fn(async () => {
      request += 1;
      if (request === 1) return jsonResponse(followingEnvelope({ logins: ['alice'] }));
      return jsonResponse(activityEnvelope([{
        login: 'alice',
        edges: [{ starredAt: NOW.toISOString(), node: repository('owner/recent') }],
        hasNextPage: true,
        endCursor: 'page-2',
      }], 50));
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(snapshot.activities.map((activity) => activity.repositoryKey)).toEqual(['owner/recent']);
    expect(snapshot.partialReasons).toEqual(['github_star_list_truncated']);
  });

  it('uses the selected rolling 90-day cutoff', async () => {
    const recent = new Date(NOW.getTime() - 89 * 24 * 60 * 60 * 1_000).toISOString();
    const expired = new Date(NOW.getTime() - 91 * 24 * 60 * 60 * 1_000).toISOString();
    let request = 0;
    const fetchImpl = vi.fn(async () => {
      request += 1;
      return request === 1
        ? jsonResponse(followingEnvelope({ logins: ['alice'] }))
        : jsonResponse(activityEnvelope([{
          login: 'alice',
          edges: [
            { starredAt: recent, node: repository('owner/recent') },
            { starredAt: expired, node: repository('owner/expired') },
          ],
        }]));
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({ token: 'token', fetchImpl, now: () => NOW, windowDays: 90 });

    expect(snapshot.activities.map((activity) => activity.repositoryKey)).toEqual(['owner/recent']);
    expect(snapshot.windowDays).toBe(90);
  });

  it('maps primary rate limits and caller aborts to stable error codes', async () => {
    const rateLimitedFetch = vi.fn(async () => new Response('', {
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1786368600',
      },
    })) as typeof fetch;

    await expect(fetchGitHubRadar({ token: 'token', fetchImpl: rateLimitedFetch }))
      .rejects.toMatchObject({
        code: 'rate_limited',
        status: 403,
      });

    expect(rateLimitedFetch).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    const neverFetch = vi.fn() as unknown as typeof fetch;
    await expect(fetchGitHubRadar({ token: 'token', fetchImpl: neverFetch, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'request_aborted' });
    expect(neverFetch).not.toHaveBeenCalled();
  });

  it('uses a fixed seven-day cutoff for incremental refreshes', async () => {
    const recent = new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1_000).toISOString();
    const expired = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1_000).toISOString();
    let request = 0;
    const fetchImpl = vi.fn(async () => {
      request += 1;
      return request === 1
        ? jsonResponse(followingEnvelope({ logins: ['alice'] }))
        : jsonResponse(activityEnvelope([{
          login: 'alice',
          edges: [
            { starredAt: recent, node: repository('owner/recent') },
            { starredAt: expired, node: repository('owner/expired') },
          ],
        }]));
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({
      token: 'token',
      fetchImpl,
      now: () => NOW,
      windowDays: 90,
      refreshMode: 'incremental',
      lookbackDays: 90,
    });

    expect(snapshot.activities.map((activity) => activity.repositoryKey)).toEqual(['owner/recent']);
    expect(snapshot).toMatchObject({ refreshMode: 'incremental', lookbackDays: 7, windowDays: 90 });
  });

  it('uses the selected window cutoff for full reconciliation', async () => {
    const recent = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1_000).toISOString();
    let request = 0;
    const fetchImpl = vi.fn(async () => {
      request += 1;
      return request === 1
        ? jsonResponse(followingEnvelope({ logins: ['alice'] }))
        : jsonResponse(activityEnvelope([{
          login: 'alice',
          edges: [{ starredAt: recent, node: repository('owner/recent') }],
        }]));
    }) as typeof fetch;

    const snapshot = await fetchGitHubRadar({
      token: 'token',
      fetchImpl,
      now: () => NOW,
      windowDays: 90,
      refreshMode: 'full',
      lookbackDays: 7,
    });

    expect(snapshot.activities.map((activity) => activity.repositoryKey)).toEqual(['owner/recent']);
    expect(snapshot).toMatchObject({ refreshMode: 'full', lookbackDays: 90, windowDays: 90 });
  });
  it('walks multi-page Following and actor pages inside one request budget', async () => {
    const initial = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:test',
      accountLogin: 'viewer',
      credentialIdentity: 'viewer:identity:true',
      windowDays: 30,
      startedAt: NOW.toISOString(),
    });
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      requests.push(body);
      if (body.query.includes('RadarFollowing')) {
        return body.variables.cursor === null
          ? jsonResponse(followingEnvelope({
            logins: ['alice'],
            totalCount: 2,
            hasNextPage: true,
            endCursor: 'following-next',
            cost: 7,
          }))
          : jsonResponse(followingEnvelope({
            logins: ['bob'],
            totalCount: 2,
            cost: 6,
          }));
      }
      return jsonResponse(activityEnvelope([
        {
          login: 'alice',
          edges: [{ starredAt: NOW.toISOString(), node: repository('owner/alice-star') }],
        },
        {
          login: 'bob',
          edges: [{ starredAt: NOW.toISOString(), node: repository('owner/bob-star') }],
        },
      ], 4_900, 4));
    }) as typeof fetch;

    const step = await fetchGitHubRadarReconciliationStep({
      token: 'token',
      checkpoint: initial,
      fetchImpl,
      now: () => NOW,
    });

    expect(requests.map((request) => request.variables)).toEqual([
      { cursor: null },
      { cursor: 'following-next' },
      { login0: 'alice', cursor0: null, login1: 'bob', cursor1: null },
    ]);
    expect(step.complete).toBe(true);
    expect(step.checkpoint.pauseReason).toBeNull();
    expect(step.checkpoint.partialReasons).toEqual([]);
    expect(step.checkpoint.scannedFollowingCount).toBe(2);
    expect(step.checkpoint.maxRequestCost).toBe(7);
    expect(step.checkpoint.cursor).toMatchObject({
      phase: 'activity',
      followingCount: 2,
      actors: [
        { login: 'alice', complete: true, nextCursor: null },
        { login: 'bob', complete: true, nextCursor: null },
      ],
    });
    expect(step.activities.map((activity) => activity.repositoryKey))
      .toEqual(['owner/alice-star', 'owner/bob-star']);
  });

  it('resumes the stored Following cursor after a request-budget pause', async () => {
    const initial = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:resume',
      accountLogin: 'viewer',
      credentialIdentity: 'viewer:identity:true',
      windowDays: 30,
      startedAt: NOW.toISOString(),
    });
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      requests.push(body);
      if (body.query.includes('RadarFollowing')) {
        return body.variables.cursor === null
          ? jsonResponse(followingEnvelope({
            logins: ['alice'],
            totalCount: 1,
            hasNextPage: true,
            endCursor: 'following-next',
          }))
          : jsonResponse(followingEnvelope({ logins: [], totalCount: 1 }));
      }
      return jsonResponse(activityEnvelope([{
        login: 'alice',
        edges: [{ starredAt: NOW.toISOString(), node: repository('owner/resumed') }],
      }]));
    }) as typeof fetch;
    const step = (checkpoint: RadarReconciliationCheckpoint) => fetchGitHubRadarReconciliationStep({
      token: 'token',
      checkpoint,
      fetchImpl,
      now: () => NOW,
      maxRequests: 1,
    });

    const first = await step(initial);
    expect(first.checkpoint.pauseReason).toBe('request_budget');
    expect(first.checkpoint.cursor).toMatchObject({
      phase: 'following',
      nextCursor: 'following-next',
    });

    const second = await step(first.checkpoint);
    expect(requests[1]?.variables).toEqual({ cursor: 'following-next' });
    expect(second.checkpoint.cursor.phase).toBe('activity');
    expect(second.complete).toBe(false);

    const third = await step(second.checkpoint);
    expect(requests[2]?.variables).toEqual({ login0: 'alice', cursor0: null });
    expect(third.complete).toBe(true);
    expect(third.checkpoint.pauseReason).toBeNull();
    expect(third.activities.map((activity) => activity.repositoryKey)).toEqual(['owner/resumed']);
  });

  it('persists a request-budget pause with the advanced actor cursor', async () => {
    const base = createRadarReconciliationCheckpoint({
      reconciliationId: 'radar-reconcile:budget',
      accountLogin: 'viewer',
      credentialIdentity: 'viewer:identity:true',
      windowDays: 30,
      startedAt: NOW.toISOString(),
    });
    const checkpoint = {
      ...base,
      cursor: {
        phase: 'activity' as const,
        followingCount: 1,
        actors: [{ login: 'alice', nextCursor: null, seenCursors: [], complete: false }],
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(activityEnvelope([{
      login: 'alice',
      edges: [{ starredAt: NOW.toISOString(), node: repository('owner/page-one') }],
      hasNextPage: true,
      endCursor: 'actor-next',
    }]))) as typeof fetch;

    const result = await fetchGitHubRadarReconciliationStep({
      token: 'token',
      checkpoint,
      fetchImpl,
      now: () => NOW,
      maxRequests: 1,
    });

    expect(result.complete).toBe(false);
    expect(result.checkpoint.pauseReason).toBe('request_budget');
    expect(result.checkpoint.cursor).toMatchObject({
      phase: 'activity',
      actors: [{ login: 'alice', nextCursor: 'actor-next', complete: false }],
    });
  });
});
