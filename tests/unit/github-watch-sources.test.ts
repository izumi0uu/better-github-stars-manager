import { describe, expect, it, vi } from 'vitest';
import {
  fetchGitHubNotifications,
  mutateGitHubNotificationThread,
} from '@/api/github-notifications-source';
import { fetchGitHubWatchSubjectDetail } from '@/api/github-watch-subject-source';
import { fetchGitHubWatchScope } from '@/api/github-watch-scope-source';
import { createSerializedRunner } from '@/background/serialized-runner';
import { GitHubWatchError } from '@/watch/watch-model';

const NOW = '2026-08-05T03:04:05.000Z';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function hangingJsonResponse(signal: AbortSignal): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    }),
  } as Response;
}

function notification(id: string, fullName = 'Owner/Repo', overrides: Record<string, unknown> = {}) {
  return {
    id,
    unread: true,
    reason: 'future_reason',
    updated_at: '2026-08-05T02:00:00Z',
    last_read_at: null,
    repository: {
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
    },
    subject: {
      title: `Thread ${id}`,
      type: 'PullRequest',
      url: `https://api.github.com/repos/${fullName}/pulls/7`,
    },
    ...overrides,
  };
}

function subjectDetail(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: 'Review Watch details',
    state: 'open',
    state_reason: null,
    html_url: 'https://github.com/owner/repo/pull/7',
    repository_url: 'https://api.github.com/repos/owner/repo',
    user: {
      login: 'octocat',
      avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
      html_url: 'https://github.com/octocat',
    },
    created_at: '2026-08-05T01:00:00Z',
    updated_at: '2026-08-05T02:00:00Z',
    labels: [{ name: 'watch', color: 'AABBCC' }],
    assignees: [{
      login: 'hubot',
      avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4',
      html_url: 'https://github.com/hubot',
    }],
    milestone: { title: 'Inbox' },
    comments: 3,
    body: '**Bounded** _Markdown_ body',
    pull_request: {},
    ...overrides,
  };
}

describe('GitHub Watch API sources', () => {
  it('publishes a complete canonical watched-repository snapshot after every page succeeds', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get('page') === '1') {
        return jsonResponse([{ full_name: 'Owner/One' }], {
          headers: {
            link: '<https://api.github.com/user/subscriptions?per_page=100&page=2>; rel="next", <https://api.github.com/user/subscriptions?per_page=100&page=2>; rel="last"',
          },
        });
      }
      return jsonResponse([{ full_name: 'owner/TWO' }, { full_name: 'OWNER/one' }]);
    });

    const result = await fetchGitHubWatchScope({
      token: 'github_pat_scope',
      fetchImpl,
      now: () => NOW,
    });

    expect(result).toEqual({
      repositories: [{ full_name: 'owner/one' }, { full_name: 'owner/two' }],
      pageCount: 2,
      fetchedAt: NOW,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).toContain('/user/subscriptions?per_page=100&page=');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer github_pat_scope');
      expect(init?.cache).toBe('no-store');
    }
  });

  it('rejects a failed later scope page without returning a partial snapshot', async () => {
    let requestCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      requestCount++;
      return requestCount === 1
        ? jsonResponse([{ full_name: 'owner/one' }], {
          headers: {
            link: '<https://api.github.com/user/subscriptions?per_page=100&page=2>; rel="next"',
          },
        })
        : jsonResponse({ message: 'unavailable' }, { status: 503 });
    });

    await expect(fetchGitHubWatchScope({ token: 'token', fetchImpl }))
      .rejects.toMatchObject({ code: 'github_unavailable', page: 2 });
  });

  it('rejects a scope snapshot that exceeds its bounded page window', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return jsonResponse([{ full_name: `owner/repo-${page}` }], {
        headers: {
          link: `<https://api.github.com/user/subscriptions?per_page=100&page=${page + 1}>; rel="next"`,
        },
      });
    });

    await expect(fetchGitHubWatchScope({
      token: 'token',
      fetchImpl,
      maxPages: 2,
    })).rejects.toMatchObject({ code: 'page_limit_exceeded', page: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects skipped pages instead of publishing incomplete snapshots', async () => {
    const scopeFetch = vi.fn<typeof fetch>(async () => jsonResponse(
      [{ full_name: 'owner/one' }],
      {
        headers: {
          link: '<https://api.github.com/user/subscriptions?per_page=100&page=3>; rel="next"',
        },
      },
    ));
    await expect(fetchGitHubWatchScope({ token: 'token', fetchImpl: scopeFetch }))
      .rejects.toMatchObject({ code: 'invalid_pagination', page: 1 });
    expect(scopeFetch).toHaveBeenCalledTimes(1);

    const notificationsFetch = vi.fn<typeof fetch>(async () => jsonResponse(
      [notification('1')],
      {
        headers: {
          link: `<https://api.github.com/notifications?all=true&participating=false&per_page=50&before=${encodeURIComponent(NOW)}&page=3>; rel="next"`,
        },
      },
    ));
    await expect(fetchGitHubNotifications({
      token: 'token',
      fetchImpl: notificationsFetch,
      now: () => NOW,
    })).rejects.toMatchObject({ code: 'invalid_pagination', page: 1 });
    expect(notificationsFetch).toHaveBeenCalledTimes(1);
  });

  it('accepts valid repository names that begin with punctuation', async () => {
    const scope = await fetchGitHubWatchScope({
      token: 'token',
      fetchImpl: vi.fn(async () => jsonResponse([{ full_name: 'github/.github' }])),
      now: () => NOW,
    });
    expect(scope.repositories).toEqual([{ full_name: 'github/.github' }]);

    const inbox = await fetchGitHubNotifications({
      token: 'token',
      fetchImpl: vi.fn(async () => jsonResponse([
        notification('dot', 'github/.github'),
      ])),
      now: () => NOW,
    });
    expect(inbox.threads[0]?.repositoryFullName).toBe('github/.github');
  });

  it('uses one frozen Notifications boundary and preserves unknown reason/type values', async () => {
    const calls: Array<{ url: URL; headers: Headers }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.searchParams.get('page') === '1') {
        return jsonResponse([notification('1')], {
          headers: {
            link: '<https://api.github.com/notifications?all=true&participating=false&per_page=50&before=2026-08-05T03%3A04%3A05.000Z&page=2>; rel="next"',
            'last-modified': 'Wed, 05 Aug 2026 03:04:05 GMT',
            'x-poll-interval': '90',
          },
        });
      }
      return jsonResponse([notification('2', 'owner/Repo', {
        subject: {
          title: 'Future subject',
          type: 'FutureSubject',
          url: 'https://api.github.com/repos/owner/Repo/releases/4',
        },
      })]);
    });

    const result = await fetchGitHubNotifications({
      token: 'classic_notifications',
      fetchImpl,
      now: () => NOW,
      lastModified: 'Tue, 04 Aug 2026 03:04:05 GMT',
    });

    expect(result.pageCount).toBe(2);
    expect(result.before).toBe(NOW);
    expect(result.lastModified).toBe('Wed, 05 Aug 2026 03:04:05 GMT');
    expect(result.pollIntervalSeconds).toBe(90);
    expect(result.truncated).toBe(false);
    expect(result.threads.map((thread) => [thread.id, thread.reason, thread.subjectType]))
      .toEqual([
        ['1', 'future_reason', 'PullRequest'],
        ['2', 'future_reason', 'FutureSubject'],
      ]);
    expect(result.threads[0]?.subjectHtmlUrl).toBe('https://github.com/owner/repo/pull/7');
    expect(result.threads[1]?.subjectHtmlUrl).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get('if-modified-since')).toBe('Tue, 04 Aug 2026 03:04:05 GMT');
    expect(calls[1]?.headers.get('if-modified-since')).toBeNull();
    for (const call of calls) {
      expect(call.url.searchParams.get('all')).toBe('true');
      expect(call.url.searchParams.get('participating')).toBe('false');
      expect(call.url.searchParams.get('per_page')).toBe('50');
      expect(call.url.searchParams.get('before')).toBe(NOW);
    }
  });

  it('returns a non-destructive 304 revalidation result', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 304,
      headers: { 'x-poll-interval': '120' },
    }));

    const result = await fetchGitHubNotifications({
      token: 'classic_notifications',
      fetchImpl,
      now: () => NOW,
      lastModified: 'Wed, 05 Aug 2026 03:04:05 GMT',
    });

    expect(result.notModified).toBe(true);
    expect(result.threads).toEqual([]);
    expect(result.lastModified).toBe('Wed, 05 Aug 2026 03:04:05 GMT');
    expect(result.pollIntervalSeconds).toBe(120);
  });

  it('limits absurd poll intervals to the conservative default', async () => {
    const result = await fetchGitHubNotifications({
      token: 'classic_notifications',
      fetchImpl: vi.fn(async () => jsonResponse([], {
        headers: { 'x-poll-interval': '999999999999999999999' },
      })),
      now: () => NOW,
    });

    expect(result.pollIntervalSeconds).toBe(60);
  });

  it('calls a supplied Notifications fetch function without a synthetic receiver', async () => {
    const fetchImpl = function (this: unknown): Promise<Response> {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return Promise.resolve(jsonResponse([]));
    } as typeof fetch;

    const result = await fetchGitHubNotifications({
      token: 'classic_notifications',
      fetchImpl,
      now: () => NOW,
    });

    expect(result.pageCount).toBe(1);
  });

  it('keeps the timeout active while consuming a response body and releases the shared queue', async () => {
    const runner = createSerializedRunner();
    const hangingFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error('expected abort signal');
      return hangingJsonResponse(signal);
    });

    const scope = runner.run(() => fetchGitHubWatchScope({
      token: 'token',
      fetchImpl: hangingFetch,
      timeoutMs: 5,
    }));
    const next = runner.run(async () => 'next operation');
    await expect(scope).rejects.toMatchObject({ code: 'deadline_exceeded', page: 1 });
    await expect(next).resolves.toBe('next operation');

    await expect(fetchGitHubNotifications({
      token: 'token',
      fetchImpl: hangingFetch,
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: 'deadline_exceeded', page: 1 });
  });

  it('rejects an unsolicited 304 and clears a validator missing from a new 200', async () => {
    const unsolicited = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
    await expect(fetchGitHubNotifications({
      token: 'classic_notifications',
      fetchImpl: unsolicited,
      now: () => NOW,
    })).rejects.toMatchObject({ code: 'invalid_response', status: 304, page: 1 });

    const replaced = await fetchGitHubNotifications({
      token: 'classic_notifications',
      fetchImpl: vi.fn(async () => jsonResponse([])),
      now: () => NOW,
      lastModified: 'Tue, 04 Aug 2026 03:04:05 GMT',
    });
    expect(replaced.notModified).toBe(false);
    expect(replaced.lastModified).toBeNull();
  });

  it('classifies a secondary rate limit from Retry-After without reading the body', async () => {
    const limited = vi.fn<typeof fetch>(async () => jsonResponse(
      { message: 'slow down' },
      { status: 403, headers: { 'retry-after': '60' } },
    ));
    await expect(fetchGitHubWatchScope({ token: 'token', fetchImpl: limited }))
      .rejects.toMatchObject({ code: 'rate_limited', status: 403 });
    await expect(fetchGitHubNotifications({ token: 'token', fetchImpl: limited }))
      .rejects.toMatchObject({ code: 'rate_limited', status: 403 });
  });

  it('marks the bounded Notifications window truncated only when another page exists', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page'));
      return jsonResponse([notification(String(page))], {
        headers: {
          link: `<https://api.github.com/notifications?all=true&participating=false&per_page=50&before=${encodeURIComponent(NOW)}&page=${page + 1}>; rel="next"`,
        },
      });
    });

    const result = await fetchGitHubNotifications({
      token: 'classic_notifications',
      fetchImpl,
      now: () => NOW,
      maxPages: 3,
    });

    expect(result.pageCount).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.candidateCount).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('classifies malformed thread payloads with a stable error code', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse([{ id: 'bad' }]));
    await expect(fetchGitHubNotifications({ token: 'token', fetchImpl }))
      .rejects.toEqual(expect.objectContaining<Partial<GitHubWatchError>>({
        code: 'invalid_thread',
        page: 1,
      }));
  });
  it('marks one notification thread read or done with the dedicated token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Response(null, {
      status: init?.method === 'PATCH' ? 205 : 204,
    }));

    await mutateGitHubNotificationThread({
      token: 'classic_notifications',
      threadId: '123',
      action: 'read',
      fetchImpl,
    });
    await mutateGitHubNotificationThread({
      token: 'classic_notifications',
      threadId: '456',
      action: 'done',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1,
      'https://api.github.com/notifications/threads/123',
      expect.objectContaining({ method: 'PATCH', cache: 'no-store' }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2,
      'https://api.github.com/notifications/threads/456',
      expect.objectContaining({ method: 'DELETE', cache: 'no-store' }));
    for (const [, init] of fetchImpl.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer classic_notifications');
      expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    }
  });

  it('rejects malformed notification mutation ids and non-contract statuses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    await expect(mutateGitHubNotificationThread({
      token: 'token',
      threadId: 'not-a-thread',
      action: 'read',
      fetchImpl,
    })).rejects.toMatchObject({ code: 'invalid_thread' });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(mutateGitHubNotificationThread({
      token: 'token',
      threadId: '123',
      action: 'done',
      fetchImpl,
    })).rejects.toMatchObject({ code: 'invalid_response', status: 404 });
  });

  it('fetches and normalizes Issue/PR details with the main-token contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(subjectDetail()));

    const detail = await fetchGitHubWatchSubjectDetail({
      token: 'github_pat_main',
      identity: {
        kind: 'pull_request',
        repositoryFullName: 'owner/repo',
        number: 7,
        apiUrl: 'https://api.github.com/repos/owner/repo/issues/7',
        htmlUrl: 'https://github.com/owner/repo/pull/7',
      },
      fetchImpl,
    });

    expect(detail).toEqual(expect.objectContaining({
      kind: 'pull_request',
      repositoryFullName: 'owner/repo',
      number: 7,
      title: 'Review Watch details',
      state: 'open',
      labels: [{ name: 'watch', color: 'aabbcc' }],
      commentCount: 3,
      bodyMarkdown: '**Bounded** _Markdown_ body',
    }));
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/issues/7',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    );
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer github_pat_main');
    expect(headers.get('accept')).toBe('application/vnd.github.raw+json');
    expect(headers.get('x-github-api-version')).toBe('2026-03-10');
  });

  it('accepts null or empty raw Markdown and rejects missing or oversized bodies', async () => {
    const identity = {
      kind: 'pull_request' as const,
      repositoryFullName: 'owner/repo',
      number: 7,
      apiUrl: 'https://api.github.com/repos/owner/repo/issues/7',
      htmlUrl: 'https://github.com/owner/repo/pull/7',
    };

    for (const body of [null, '']) {
      await expect(fetchGitHubWatchSubjectDetail({
        token: 'token',
        identity,
        fetchImpl: vi.fn(async () => jsonResponse(subjectDetail({ body }))),
      })).resolves.toMatchObject({ bodyMarkdown: body });
    }

    await expect(fetchGitHubWatchSubjectDetail({
      token: 'token',
      identity,
      fetchImpl: vi.fn(async () => jsonResponse(subjectDetail({ body: undefined }))),
    })).rejects.toMatchObject({ code: 'invalid_response' });

    await expect(fetchGitHubWatchSubjectDetail({
      token: 'token',
      identity,
      fetchImpl: vi.fn(async () => jsonResponse(subjectDetail({ body: 'x'.repeat(100_001) }))),
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects redirected, oversized, and identity-mismatched subject detail responses', async () => {
    const identity = {
      kind: 'issue' as const,
      repositoryFullName: 'owner/repo',
      number: 7,
      apiUrl: 'https://api.github.com/repos/owner/repo/issues/7',
      htmlUrl: 'https://github.com/owner/repo/issues/7',
    };
    const redirected = vi.fn<typeof fetch>(async () => jsonResponse({}, { status: 301 }));
    await expect(fetchGitHubWatchSubjectDetail({ token: 'token', identity, fetchImpl: redirected }))
      .rejects.toMatchObject({ code: 'subject_not_found' });

    const oversized = vi.fn<typeof fetch>(async () => jsonResponse({}, {
      headers: { 'content-length': String(512 * 1024 + 1) },
    }));
    await expect(fetchGitHubWatchSubjectDetail({ token: 'token', identity, fetchImpl: oversized }))
      .rejects.toMatchObject({ code: 'invalid_response' });

    const mismatched = vi.fn<typeof fetch>(async () => jsonResponse(subjectDetail({
      html_url: 'https://github.com/other/repo/issues/7',
      pull_request: undefined,
    })));
    await expect(fetchGitHubWatchSubjectDetail({ token: 'token', identity, fetchImpl: mismatched }))
      .rejects.toMatchObject({ code: 'invalid_response' });

    const hostileAvatarQuery = vi.fn<typeof fetch>(async () => jsonResponse(subjectDetail({
      user: {
        login: 'octocat',
        avatar_url: 'https://avatars.githubusercontent.com/u/1?redirect=https://attacker.example',
        html_url: 'https://github.com/octocat',
      },
    })));
    await expect(fetchGitHubWatchSubjectDetail({
      token: 'token',
      identity,
      fetchImpl: hostileAvatarQuery,
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps subject-detail HTTP failures to stable codes with safe statuses', async () => {
    const identity = {
      kind: 'issue' as const,
      repositoryFullName: 'owner/repo',
      number: 7,
      apiUrl: 'https://api.github.com/repos/owner/repo/issues/7',
      htmlUrl: 'https://github.com/owner/repo/issues/7',
    };
    const rejected = vi.fn<typeof fetch>(async () => jsonResponse({}, { status: 401 }));
    await expect(fetchGitHubWatchSubjectDetail({ token: 'token', identity, fetchImpl: rejected }))
      .rejects.toMatchObject({ code: 'authentication_required', status: 401 });

    const forbidden = vi.fn<typeof fetch>(async () => jsonResponse({}, { status: 403 }));
    await expect(fetchGitHubWatchSubjectDetail({ token: 'token', identity, fetchImpl: forbidden }))
      .rejects.toMatchObject({ code: 'permission_denied', status: 403 });

    const limited = vi.fn<typeof fetch>(async () => jsonResponse({}, {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
    }));
    await expect(fetchGitHubWatchSubjectDetail({ token: 'token', identity, fetchImpl: limited }))
      .rejects.toMatchObject({ code: 'rate_limited', status: 403 });

    const unavailable = vi.fn<typeof fetch>(async () => jsonResponse({}, { status: 503 }));
    await expect(fetchGitHubWatchSubjectDetail({ token: 'token', identity, fetchImpl: unavailable }))
      .rejects.toMatchObject({ code: 'github_unavailable', status: 503 });

    const hanging = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Expected subject detail abort signal');
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    });
    await expect(fetchGitHubWatchSubjectDetail({
      token: 'token',
      identity,
      fetchImpl: hanging,
      timeoutMs: 1,
    })).rejects.toMatchObject({ code: 'deadline_exceeded' });
  });
});
