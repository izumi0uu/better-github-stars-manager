import {
  GitHubWatchError,
  dedupeNotificationThreads,
  normalizeNotificationThread,
  type GitHubNotificationThread,
  type WatchNotificationSnapshot,
} from '@/watch/watch-model';

const API_ORIGIN = 'https://api.github.com';
const NOTIFICATIONS_PATH = '/notifications';
const PER_PAGE = 50;
const DEFAULT_MAX_PAGES = 10;
export const WATCH_DEFAULT_POLL_INTERVAL_SECONDS = 60;
export const WATCH_MAX_POLL_INTERVAL_SECONDS = 24 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 30_000;

type FetchLike = typeof fetch;

export interface FetchGitHubNotificationsOptions {
  token: string;
  before?: Date | string | number;
  lastModified?: string | null;
  fetchImpl?: FetchLike;
  now?: () => Date | string | number;
  maxPages?: number;
  timeoutMs?: number;
}

function isoTimestamp(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new GitHubWatchError('invalid_response');
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

function pollIntervalSeconds(value: string | null): number {
  if (!value || !/^\d+$/u.test(value.trim())) return WATCH_DEFAULT_POLL_INTERVAL_SECONDS;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= WATCH_MAX_POLL_INTERVAL_SECONDS
    ? seconds
    : WATCH_DEFAULT_POLL_INTERVAL_SECONDS;
}

function lastModifiedValidator(value: string | null | undefined): string | null {
  const validator = value?.trim();
  return validator && Number.isFinite(Date.parse(validator)) ? validator : null;
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
    url.pathname !== NOTIFICATIONS_PATH ||
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

async function requestPage(input: {
  token: string;
  before: string;
  page: number;
  lastModified: string | null;
  fetchedAt: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<{
  response: Response;
  threads: GitHubNotificationThread[];
  nextPage: number | null;
}> {
  const url = new URL(NOTIFICATIONS_PATH, API_ORIGIN);
  url.searchParams.set('all', 'true');
  url.searchParams.set('participating', 'false');
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('before', input.before);
  url.searchParams.set('page', String(input.page));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/vnd.github+json',
  };
  if (input.page === 1 && input.lastModified) {
    headers['If-Modified-Since'] = input.lastModified;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(url.toString(), {
      headers,
      cache: 'no-store',
      signal: controller.signal,
    });
    if (input.page === 1 && response.status === 304 && input.lastModified) {
      return { response, threads: [], nextPage: null };
    }
    if (!response.ok) throw responseError(response, input.page);
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.toLowerCase().includes('json')) {
      throw new GitHubWatchError('invalid_content_type', undefined, {
        status: response.status,
        page: input.page,
      });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GitHubWatchError('deadline_exceeded', undefined, { page: input.page });
      }
      throw new GitHubWatchError('invalid_response', undefined, {
        status: response.status,
        page: input.page,
      });
    }
    if (!Array.isArray(payload)) {
      throw new GitHubWatchError('invalid_response', undefined, {
        status: response.status,
        page: input.page,
      });
    }
    let threads: GitHubNotificationThread[];
    try {
      threads = payload.map((row) => normalizeNotificationThread(row, { fetchedAt: input.fetchedAt }));
    } catch (error) {
      if (error instanceof GitHubWatchError) {
        throw new GitHubWatchError(error.code, undefined, { status: response.status, page: input.page });
      }
      throw new GitHubWatchError('invalid_response', undefined, {
        status: response.status,
        page: input.page,
      });
    }
    const pageAfter = nextPage(response.headers.get('link'), input.page);
    if (threads.length === 0 && pageAfter !== null) {
      throw new GitHubWatchError('invalid_pagination', undefined, { page: input.page });
    }
    return { response, threads, nextPage: pageAfter };
  } catch (error) {
    if (error instanceof GitHubWatchError) throw error;
    if (controller.signal.aborted) {
      throw new GitHubWatchError('deadline_exceeded', undefined, { page: input.page });
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new GitHubWatchError('request_aborted', undefined, { page: input.page });
    }
    throw new GitHubWatchError('network_error', undefined, { page: input.page });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGitHubNotifications(
  options: FetchGitHubNotificationsOptions,
): Promise<WatchNotificationSnapshot> {
  const token = options.token.trim();
  if (!token) throw new GitHubWatchError('authentication_required');
  const nowValue = options.now?.() ?? new Date();
  const fetchedAt = isoTimestamp(nowValue);
  const before = isoTimestamp(options.before ?? nowValue);
  const maxPages = Number.isFinite(options.maxPages)
    ? Math.max(1, Math.floor(options.maxPages!))
    : DEFAULT_MAX_PAGES;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs!))
    : DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const conditionalLastModified = lastModifiedValidator(options.lastModified);
  const allThreads: GitHubNotificationThread[] = [];
  let page = 1;
  let pageCount = 0;
  let truncated = false;
  let lastModified: string | null = null;
  let pollSeconds = WATCH_DEFAULT_POLL_INTERVAL_SECONDS;
  for (;;) {
    const result = await requestPage({
      token,
      before,
      page,
      lastModified: conditionalLastModified,
      fetchedAt,
      fetchImpl,
      timeoutMs,
    });
    pageCount++;
    if (pageCount === 1) {
      lastModified = result.response.status === 304
        ? conditionalLastModified
        : lastModifiedValidator(result.response.headers.get('last-modified'));
      pollSeconds = pollIntervalSeconds(result.response.headers.get('x-poll-interval'));
      if (result.response.status === 304) {
        return {
          threads: [],
          candidateCount: 0,
          matchedCount: 0,
          pageCount,
          truncated: false,
          notModified: true,
          before,
          fetchedAt,
          lastModified,
          pollIntervalSeconds: pollSeconds,
        };
      }
    }
    allThreads.push(...result.threads);
    if (result.nextPage === null) break;
    if (pageCount >= maxPages) {
      truncated = true;
      break;
    }
    page = result.nextPage;
  }
  const threads = dedupeNotificationThreads(allThreads);
  return {
    threads,
    candidateCount: threads.length,
    matchedCount: threads.length,
    pageCount,
    truncated,
    notModified: false,
    before,
    fetchedAt,
    lastModified,
    pollIntervalSeconds: pollSeconds,
  };
}

export const fetchNotifications = fetchGitHubNotifications;
