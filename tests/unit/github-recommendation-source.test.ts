import { describe, expect, it, vi } from 'vitest';
import { fetchGitHubRecommendations } from '@/api/github-recommendation-source';
import {
  GitHubRecommendationError,
  selectRecommendationSeeds,
  buildRecommendationQueryPlan,
} from '@/recommendations/recommendation-model';

const NOW = new Date('2026-08-10T12:00:00.000Z');

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-ratelimit-remaining': '8',
      'x-ratelimit-reset': '1786368600',
      ...(init.headers ?? {}),
    },
  });
}

function remoteRepository(
  fullName: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const [owner, name] = fullName.split('/');
  return {
    full_name: fullName,
    name,
    html_url: `https://github.com/${fullName}`,
    description: `${fullName} description`,
    language: 'TypeScript',
    stargazers_count: 120,
    topics: ['developer-tools'],
    owner: { login: owner },
    pushed_at: '2026-08-09T12:00:00Z',
    created_at: '2025-01-01T00:00:00Z',
    fork: false,
    archived: false,
    ...overrides,
  };
}

function recommendationInputs() {
  const seeds = selectRecommendationSeeds([{
    full_name: 'Seed/Repo',
    language: 'TypeScript',
    topics: ['developer-tools'],
    starred_at: '2026-08-10T11:00:00Z',
    stargazers_count: 10,
    tombstone: false,
    viewer_has_starred: true,
  }]);
  return { seeds, queryPlan: buildRecommendationQueryPlan(seeds, 2) };
}

describe('GitHub recommendation source', () => {
  it('fetches bounded Search pages and ranks only validated non-library candidates', async () => {
    const { seeds, queryPlan } = recommendationInputs();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe('https://api.github.com/search/repositories');
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return jsonResponse({
        items: [remoteRepository('Candidate/Tool'), remoteRepository('Local/Repo')],
      });
    }) as typeof fetch;

    const result = await fetchGitHubRecommendations({
      token: ' secret ',
      accountLogin: 'Viewer',
      seeds,
      queryPlan,
      excludedRepositoryKeys: new Set(['local/repo']),
      fetchImpl,
      now: () => NOW,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      accountLogin: 'viewer',
      fetchedAt: NOW.toISOString(),
      seedCount: 1,
      queryCount: 2,
      rateLimitRemaining: 8,
    });
    expect(result.recommendations.map((row) => row.repositoryKey)).toEqual(['candidate/tool']);
  });

  it('can rank sixty unique candidates from the bounded Search pool', async () => {
    const { seeds, queryPlan } = recommendationInputs();
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const query = new URL(String(input)).searchParams.get('q') ?? 'query';
      const queryKey = query.replaceAll(/[^a-z0-9]+/giu, '-').replaceAll(/^-|-$/gu, '').slice(0, 24);
      return jsonResponse({
        items: Array.from({ length: 45 }, (_, index) => remoteRepository(`Candidate/${queryKey}-${index}`)),
      });
    }) as typeof fetch;

    const result = await fetchGitHubRecommendations({
      token: 'token',
      accountLogin: 'viewer',
      seeds,
      queryPlan,
      excludedRepositoryKeys: new Set(),
      fetchImpl,
      now: () => NOW,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.recommendations).toHaveLength(60);
  });

  it('rejects malformed remote candidates instead of caching partial rows', async () => {
    const { seeds, queryPlan } = recommendationInputs();
    const fetchImpl = vi.fn(async () => jsonResponse({
      items: [remoteRepository('Candidate/Tool', { html_url: 'javascript:alert(1)' })],
    })) as typeof fetch;

    await expect(fetchGitHubRecommendations({
      token: 'token',
      accountLogin: 'viewer',
      seeds,
      queryPlan,
      excludedRepositoryKeys: new Set(),
      fetchImpl,
    })).rejects.toMatchObject({ code: 'invalid_candidate' });
  });

  it('maps Search rate-limit responses to a durable reset time', async () => {
    const { seeds, queryPlan } = recommendationInputs();
    const fetchImpl = vi.fn(async () => new Response('', {
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1786368600',
      },
    })) as typeof fetch;

    await expect(fetchGitHubRecommendations({
      token: 'token',
      accountLogin: 'viewer',
      seeds,
      queryPlan,
      excludedRepositoryKeys: new Set(),
      fetchImpl,
    })).rejects.toMatchObject({
      code: 'rate_limited',
      resetAt: new Date(1_786_368_600_000).toISOString(),
    });
  });

  it('maps caller abort without issuing a Search request', async () => {
    const { seeds, queryPlan } = recommendationInputs();
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(fetchGitHubRecommendations({
      token: 'token',
      accountLogin: 'viewer',
      seeds,
      queryPlan,
      excludedRepositoryKeys: new Set(),
      fetchImpl,
      signal: controller.signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'request_aborted' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects empty credentials before Search', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(fetchGitHubRecommendations({
      token: ' ',
      accountLogin: 'viewer',
      seeds: [],
      queryPlan: [],
      excludedRepositoryKeys: new Set(),
      fetchImpl,
    })).rejects.toBeInstanceOf(GitHubRecommendationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
