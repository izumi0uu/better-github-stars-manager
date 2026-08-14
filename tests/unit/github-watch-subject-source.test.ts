import { describe, expect, it, vi } from 'vitest';
import { fetchGitHubWatchSubjectDetail } from '@/api/github-watch-subject-source';
import type { WatchSubjectIdentity } from '@/watch/watch-model';

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

function identity(overrides: Partial<WatchSubjectIdentity> = {}): WatchSubjectIdentity {
  return {
    kind: 'issue',
    repositoryFullName: 'mindfold-ai/trellis',
    number: 42,
    apiUrl: 'https://api.github.com/repos/mindfold-ai/Trellis/issues/42',
    htmlUrl: 'https://github.com/mindfold-ai/trellis/issues/42',
    ...overrides,
  };
}

function detailPayload() {
  return {
    number: 42,
    title: 'Sample issue',
    state: 'open',
    state_reason: null,
    user: { login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', html_url: 'https://github.com/octocat' },
    labels: [],
    assignees: [],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
    comments: 0,
    body: 'Issue body',
    milestone: null,
    pull_request: undefined,
    // GitHub canonicalizes owner/repo casing in these URLs.
    repository_url: 'https://api.github.com/repos/mindfold-ai/Trellis',
    html_url: 'https://github.com/mindfold-ai/Trellis/issues/42',
  };
}

describe('GitHub Watch subject source', () => {
  it('accepts canonical casing from GitHub for repositories with uppercase names', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(detailPayload())) as typeof fetch;
    const detail = await fetchGitHubWatchSubjectDetail({
      token: 'token',
      identity: identity(),
      fetchImpl,
    });
    expect(detail.repositoryFullName).toBe('mindfold-ai/trellis');
    expect(detail.number).toBe(42);
    expect(detail.title).toBe('Sample issue');
  });

  it('rejects a mismatched repository_url instead of trusting stale data', async () => {
    const payload = detailPayload();
    payload.repository_url = 'https://api.github.com/repos/other/repo';
    const fetchImpl = vi.fn(async () => jsonResponse(payload)) as typeof fetch;
    await expect(fetchGitHubWatchSubjectDetail({
      token: 'token',
      identity: identity(),
      fetchImpl,
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
