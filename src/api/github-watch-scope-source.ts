import {
  GitHubWatchError,
  normalizeWatchRepository,
  type WatchScopeSnapshot,
} from '@/watch/watch-model';

const API_ORIGIN = 'https://api.github.com';
const SCOPE_PATH = '/user/subscriptions';
const PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

type FetchLike = typeof fetch;

export interface FetchGitHubWatchScopeOptions {
  token: string;
  fetchImpl?: FetchLike;
  now?: () => Date | string | number;
  timeoutMs?: number;
}

function timestampFrom(now: FetchGitHubWatchScopeOptions['now']): string {
  const value = now?.() ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new GitHubWatchError('invalid_response');
  }
  return date.toISOString();
}

function responseError(response: Response, page: number): GitHubWatchError {
  if (response.status === 401) {
    return new GitHubWatchError('authentication_required', undefined, { status: response.status, page });
  }
  if (response.status === 403 || response.status === 429) {
    const code = response.status === 429 ||
      response.headers.get('x-ratelimit-remaining') === '0' ||
      response.headers.has('retry-after')
      ? 'rate_limited'
      : 'permission_denied';
    return new GitHubWatchError(code, undefined, { status: response.status, page });
  }
  if (response.status >= 500) {
    return new GitHubWatchError('github_unavailable', undefined, { status: response.status, page });
  }
  return new GitHubWatchError('invalid_response', undefined, { status: response.status, page });
}

function nextPage(linkHeader: string | null, currentPage: number): number | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  const nextParts = parts.filter((part) => /\brel="[^"]*\bnext\b[^"]*"/u.test(part));
  if (nextParts.length === 0) {
    if (/\brel\s*=\s*"?next\b/iu.test(linkHeader)) {
      throw new GitHubWatchError('invalid_pagination', undefined, { page: currentPage });
    }
    return null;
  }
  if (nextParts.length !== 1) {
    throw new GitHubWatchError('invalid_pagination', undefined, { page: currentPage });
  }
  const nextPart = nextParts[0]!;
  const match = nextPart.match(/^\s*<([^>]+)>\s*;/u);
  if (!match) throw new GitHubWatchError('invalid_pagination', undefined, { page: currentPage });
  let url: URL;
  try {
    url = new URL(match[1]!);
  } catch {
    throw new GitHubWatchError('invalid_pagination', undefined, { page: currentPage });
  }
  const page = Number(url.searchParams.get('page'));
  if (
    url.origin !== API_ORIGIN ||
    url.pathname !== SCOPE_PATH ||
    !Number.isSafeInteger(page) ||
    page !== currentPage + 1 ||
    url.searchParams.getAll('page').length !== 1 ||
    url.searchParams.get('per_page') !== String(PER_PAGE) ||
    url.searchParams.getAll('per_page').length !== 1
  ) {
    throw new GitHubWatchError('invalid_pagination', undefined, { page: currentPage });
  }
  return page;
}

async function fetchPage(
  token: string,
  page: number,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ repositories: ReturnType<typeof normalizeWatchRepository>[]; nextPage: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(SCOPE_PATH, API_ORIGIN);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));
    const response = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw responseError(response, page);
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.toLowerCase().includes('json')) {
      throw new GitHubWatchError('invalid_content_type', undefined, { status: response.status, page });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GitHubWatchError('deadline_exceeded', undefined, { page });
      }
      throw new GitHubWatchError('invalid_response', undefined, { status: response.status, page });
    }
    if (!Array.isArray(payload)) {
      throw new GitHubWatchError('invalid_response', undefined, { status: response.status, page });
    }
    let repositories: ReturnType<typeof normalizeWatchRepository>[];
    try {
      repositories = payload.map(normalizeWatchRepository);
    } catch (error) {
      if (error instanceof GitHubWatchError) {
        throw new GitHubWatchError(error.code, undefined, { status: response.status, page });
      }
      throw new GitHubWatchError('invalid_response', undefined, { status: response.status, page });
    }
    const pageAfter = nextPage(response.headers.get('link'), page);
    if (repositories.length === 0 && pageAfter !== null) {
      throw new GitHubWatchError('invalid_pagination', undefined, { page });
    }
    return { repositories, nextPage: pageAfter };
  } catch (error) {
    if (error instanceof GitHubWatchError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new GitHubWatchError('deadline_exceeded', undefined, { page });
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new GitHubWatchError('request_aborted', undefined, { page });
    }
    throw new GitHubWatchError('network_error', undefined, { page });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGitHubWatchScope(
  options: FetchGitHubWatchScopeOptions,
): Promise<WatchScopeSnapshot> {
  const token = options.token.trim();
  if (!token) throw new GitHubWatchError('authentication_required');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs!))
    : DEFAULT_TIMEOUT_MS;
  const fetchedAt = timestampFrom(options.now);
  const byName = new Map<string, ReturnType<typeof normalizeWatchRepository>>();
  let page = 1;
  let pageCount = 0;
  for (;;) {
    const result = await fetchPage(token, page, fetchImpl, timeoutMs);
    pageCount++;
    for (const repository of result.repositories) byName.set(repository.full_name, repository);
    if (result.nextPage === null) break;
    page = result.nextPage;
  }
  return {
    repositories: [...byName.values()].sort((left, right) => left.full_name.localeCompare(right.full_name)),
    pageCount,
    fetchedAt,
  };
}

export const fetchWatchScope = fetchGitHubWatchScope;
