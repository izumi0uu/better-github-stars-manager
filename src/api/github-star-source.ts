import type { Star, SyncProgress } from '@/types';
import type { StarSource } from './star-source';
import { db } from '@/storage/db';
import { authStore } from '@/auth/auth-store';
import { getMessages } from '@/i18n';
import { GH_NO_TOKEN, GH_TOKEN_REJECTED, GH_RATE_LIMIT, GH_FORBIDDEN, GH_TIMEOUT, GH_NETWORK, GH_PAGE_STATUS, GH_BAD_SHAPE } from './errors';

/**
 * GitHub-backed `StarSource`.
 * - All sync modes use authenticated `GET /user/starred` with `star+json`
 *   media so the cursor, tombstone scan, and repo metadata all come from the
 *   same payload shape.
 * See `StarSource` for the sync job contract.
 */

const PER_PAGE = 100;
const API = 'https://api.github.com';
const WRITE_CHUNK = 500;

/** Response shape for `star+json` media (starred_at at top level, repo nested — incremental cursor depends on it). */
interface StarredRepoPayload {
  starred_at: string;
  repo: RepositoryPayload;
}
interface RepositoryPayload {
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  topics?: string[];
  pushed_at: string | null;
  created_at: string | null;
  fork: boolean;
  archived: boolean;
  private?: boolean;
}


function nullableString(value: unknown): string | null {
  return value === null || typeof value === 'string' ? value : null;
}


function parseRepositoryPayload(value: unknown, requestedFullName: string): RepositoryPayload {
  const input = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const fullName = typeof input?.full_name === 'string' ? input.full_name.trim() : '';
  const htmlUrl = typeof input?.html_url === 'string' ? input.html_url.trim() : '';
  const description = nullableString(input?.description);
  const language = nullableString(input?.language);
  const pushedAt = nullableString(input?.pushed_at);
  const createdAt = nullableString(input?.created_at);
  const topics = input?.topics === undefined
    ? []
    : Array.isArray(input.topics) && input.topics.every((topic) => typeof topic === 'string')
      ? input.topics
      : null;
  const stargazersCount = input?.stargazers_count;
  let parsedUrl: URL;
  try {
    splitFullName(fullName);
    parsedUrl = new URL(htmlUrl);
  } catch {
    throw new Error(GH_BAD_SHAPE);
  }
  if (
    fullName.toLocaleLowerCase('en-US') !== requestedFullName.toLocaleLowerCase('en-US')
    || parsedUrl.origin !== 'https://github.com'
    || parsedUrl.pathname.replace(/^\/+|\/+$/gu, '').toLocaleLowerCase('en-US')
      !== fullName.toLocaleLowerCase('en-US')
    || description === null && input?.description !== null
    || language === null && input?.language !== null
    || typeof stargazersCount !== 'number'
    || !Number.isSafeInteger(stargazersCount)
    || stargazersCount < 0
    || !(pushedAt === null || Number.isFinite(Date.parse(pushedAt)))
    || pushedAt === null && input?.pushed_at !== null
    || typeof createdAt !== 'string'
    || !Number.isFinite(Date.parse(createdAt))
    || typeof input?.fork !== 'boolean'
    || typeof input?.archived !== 'boolean'
    || topics === null
    || input?.private !== undefined && typeof input.private !== 'boolean'
  ) throw new Error(GH_BAD_SHAPE);

  return {
    full_name: fullName,
    html_url: htmlUrl,
    description,
    language,
    stargazers_count: stargazersCount,
    topics,
    pushed_at: pushedAt,
    created_at: createdAt,
    fork: input.fork,
    archived: input.archived,
    ...(input?.private === undefined ? {} : { private: input.private }),
  };
}

function tokenHeaders(token: string, accept = 'application/vnd.github.star+json'): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
  };
}

async function withMainCredential<T>(attempt: (token: string) => Promise<T>): Promise<T> {
  const token = await authStore.getToken();
  if (!token) throw new Error(GH_NO_TOKEN);
  return attempt(token);
}
async function getLocaleMessages() {
  return getMessages(await authStore.getLocale());
}

/** Parse the Link header to find the last page number (for progress totals). */
function lastPage(linkHeader: string | null): number | null {
  if (!linkHeader) return null;
  const m = linkHeader.match(/[?&]page=(\d+)>;\s*rel="last"/);
  return m ? Number(m[1]) : null;
}

/** Abort a request after 30s so a hung connection surfaces as an error, not a stuck UI. */
function responseError(res: Response): Error {
  if (res.status === 401) return new Error(GH_TOKEN_REJECTED);
  if (res.status === 403 || res.status === 429) {
    return new Error(
      res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0'
        ? GH_RATE_LIMIT
        : GH_FORBIDDEN,
    );
  }
  return new Error(`${GH_PAGE_STATUS}${res.status}`);
}

function assertJsonResponse(res: Response): void {
  const contentType = res.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().includes('json')) {
    throw new Error(GH_BAD_SHAPE);
  }
}

function hasNextPage(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return linkHeader.split(',').some((part) => /\brel="[^"]*\bnext\b[^"]*"/u.test(part));
}
function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function fetchPage(page: number): Promise<{ items: StarredRepoPayload[]; link: string | null }> {
  return withMainCredential(async (token) => {
    const { signal, cancel } = withTimeout(30_000);
    let res: Response;
    try {
      res = await fetch(`${API}/user/starred?per_page=${PER_PAGE}&page=${page}`, {
        headers: tokenHeaders(token),
        cache: 'no-store',
        signal,
      });
    } catch (e) {
      cancel();
      if (e instanceof Error && e.name === 'AbortError') throw new Error(`${GH_TIMEOUT}${page}`);
      throw new Error(`${GH_NETWORK}${e instanceof Error ? e.message : String(e)}`);
    }
    cancel();
    if (res.status === 401) throw new Error(GH_TOKEN_REJECTED);
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') throw new Error(GH_RATE_LIMIT);
      throw new Error(GH_FORBIDDEN);
    }
    if (res.status === 204 || res.status === 304) return { items: [], link: res.headers.get('link') };
    if (!res.ok) throw new Error(`${GH_PAGE_STATUS}${res.status}`);
    const items = (await res.json()) as StarredRepoPayload[];
    if (items.length && !items[0].repo) throw new Error(GH_BAD_SHAPE);
    return { items, link: res.headers.get('link') };
  });
}
async function fetchOwnedPublicPage(
  username: string,
  page: number,
): Promise<{ items: RepositoryPayload[]; hasNext: boolean }> {
  const url = `${API}/users/${encodeURIComponent(username)}/repos?type=owner&sort=full_name&direction=asc&per_page=${PER_PAGE}&page=${page}`;
  const res = await withMainCredential(async (token) => {
    const response = await fetchWithTimeout(url, {
      headers: tokenHeaders(token, 'application/vnd.github+json'),
      cache: 'no-store',
    });
    if (!response.ok) throw responseError(response);
    return response;
  });
  assertJsonResponse(res);
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(GH_BAD_SHAPE);
  }
  if (!Array.isArray(payload)) throw new Error(GH_BAD_SHAPE);
  const ownerPrefix = `${username.toLocaleLowerCase('en-US')}/`;
  const items = payload.map((item) => {
    const input = typeof item === 'object' && item !== null && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null;
    const fullName = typeof input?.full_name === 'string' ? input.full_name.trim() : '';
    const repository = parseRepositoryPayload(item, fullName);
    if (
      repository.private === true ||
      !repository.full_name.toLocaleLowerCase('en-US').startsWith(ownerPrefix)
    ) throw new Error(GH_BAD_SHAPE);
    return repository;
  });
  return { items, hasNext: hasNextPage(res.headers.get('link')) };
}

async function fetchAllOwnedPublicRepositories(username: string): Promise<RepositoryPayload[]> {
  const items: RepositoryPayload[] = [];
  for (let page = 1; ; page++) {
    const current = await fetchOwnedPublicPage(username, page);
    items.push(...current.items);
    if (!current.hasNext) return items;
  }
}

function splitFullName(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1 || fullName.indexOf('/', slash + 1) !== -1) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const { signal, cancel } = withTimeout(30_000);
  try {
    return await fetch(url, { ...init, signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${GH_NETWORK}request timed out`);
    }
    throw new Error(`${GH_NETWORK}${e instanceof Error ? e.message : String(e)}`);
  } finally {
    cancel();
  }
}

async function assertRepoAccessible(owner: string, repo: string, headers: HeadersInit): Promise<void> {
  const res = await fetchWithTimeout(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });
  if (res.ok || res.status === 304) return;
  if (res.status === 401) throw new Error(GH_TOKEN_REJECTED);
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') throw new Error(GH_RATE_LIMIT);
    throw new Error(GH_FORBIDDEN);
  }
  throw new Error(`${GH_PAGE_STATUS}${res.status}`);
}

async function deleteStar(fullName: string): Promise<void> {
  const { owner, repo } = splitFullName(fullName);
  await withMainCredential(async (token) => {
    const headers = tokenHeaders(token, 'application/vnd.github+json');
    const res = await fetchWithTimeout(`${API}/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      method: 'DELETE', headers, cache: 'no-store',
    });
    if (res.status === 204 || res.status === 304) return;
    if (res.status === 404) {
      await assertRepoAccessible(owner, repo, headers);
      return;
    }
    if (res.status === 401) throw new Error(GH_TOKEN_REJECTED);
    if (res.status === 403) {
      if (res.headers.get('x-ratelimit-remaining') === '0') throw new Error(GH_RATE_LIMIT);
      throw new Error(GH_FORBIDDEN);
    }
    throw new Error(`${GH_PAGE_STATUS}${res.status}`);
  });
}
async function putStar(fullName: string): Promise<Star> {
  const { owner, repo } = splitFullName(fullName);
  return withMainCredential(async (token) => {
    const headers = tokenHeaders(token, 'application/vnd.github+json');
    const starResponse = await fetchWithTimeout(
      `${API}/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { method: 'PUT', headers, cache: 'no-store' },
    );
    if (starResponse.status !== 204 && starResponse.status !== 304) {
      if (starResponse.status === 401) throw new Error(GH_TOKEN_REJECTED);
      if (starResponse.status === 403) {
        if (starResponse.headers.get('x-ratelimit-remaining') === '0') throw new Error(GH_RATE_LIMIT);
        throw new Error(GH_FORBIDDEN);
      }
      throw new Error(`${GH_PAGE_STATUS}${starResponse.status}`);
    }
    const repositoryResponse = await fetchWithTimeout(
      `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers, cache: 'no-store' },
    );
    if (repositoryResponse.status === 401) throw new Error(GH_TOKEN_REJECTED);
    if (repositoryResponse.status === 403) {
      if (repositoryResponse.headers.get('x-ratelimit-remaining') === '0') throw new Error(GH_RATE_LIMIT);
      throw new Error(GH_FORBIDDEN);
    }
    if (!repositoryResponse.ok) throw new Error(`${GH_PAGE_STATUS}${repositoryResponse.status}`);
    assertJsonResponse(repositoryResponse);
    const repository = parseRepositoryPayload(await repositoryResponse.json(), fullName);
    const star = toStar({ starred_at: new Date().toISOString(), repo: repository });
    await db.stars.put(star);
    return star;
  });
}
function retryableErrorCode(raw: string): boolean {
  if (raw.startsWith(GH_TIMEOUT) || raw.startsWith(GH_NETWORK)) return true;
  if (!raw.startsWith(GH_PAGE_STATUS)) return false;
  const status = Number(raw.slice(GH_PAGE_STATUS.length));
  return status === 408 || status === 429 || status >= 500;
}

async function fetchPageWithRetry(
  page: number,
  onRetry?: (attempt: number) => void,
  maxAttempts = 3,
): Promise<{ items: StarredRepoPayload[]; link: string | null }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchPage(page);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (!retryableErrorCode(raw) || attempt === maxAttempts) throw e;
      onRetry?.(attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(`${GH_TIMEOUT}${page}`);
}

export function toStar(it: StarredRepoPayload): Star {
  const r = it.repo;
  return {
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description ?? '',
    language: r.language,
    stargazers_count: r.stargazers_count,
    topics: r.topics ?? [],
    pushed_at: r.pushed_at,
    created_at: r.created_at ?? null,
    fork: r.fork,
    archived: r.archived,
    viewer_has_starred: true,
    starred_at: it.starred_at,
    tombstone: false,
    synced_at: new Date().toISOString(),
  };
}

function toOwnedPublicRepository(
  repository: RepositoryPayload,
  existing: Star | undefined,
): Star {
  const now = new Date().toISOString();
  return {
    full_name: repository.full_name,
    html_url: repository.html_url,
    description: repository.description ?? '',
    language: repository.language,
    stargazers_count: repository.stargazers_count,
    topics: repository.topics ?? [],
    pushed_at: repository.pushed_at,
    created_at: repository.created_at,
    fork: repository.fork,
    archived: repository.archived,
    viewer_has_starred: false,
    // Non-starred rows have no GitHub star timestamp. Creation time keeps the
    // existing non-null sort contract without pretending the user starred it.
    starred_at: existing?.starred_at ?? repository.created_at ?? now,
    tombstone: false,
    synced_at: now,
  };
}

/** Concurrently fetch a range of pages; returns in page-number order, not completion order. */
async function fetchPages(
  pages: number[],
  onPageDone?: () => void,
  onPageRetry?: (page: number, attempt: number) => void,
  concurrency = 6,
): Promise<StarredRepoPayload[][]> {
  const out: StarredRepoPayload[][] = new Array(pages.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
    while (idx < pages.length) {
      const my = pages[idx];
      const slot = idx;
      idx++;
      const { items } = await fetchPageWithRetry(my, (attempt) => onPageRetry?.(my, attempt));
      out[slot] = items; // place by input index, not push-by-completion
      onPageDone?.();
    }
  });
  await Promise.all(workers);
  return out;
}

async function bulkPutStars(stars: Star[]): Promise<void> {
  for (let i = 0; i < stars.length; i += WRITE_CHUNK) {
    await db.stars.bulkPut(stars.slice(i, i + WRITE_CHUNK));
    if (i + WRITE_CHUNK < stars.length) await Promise.resolve();
  }
}

type ProgressReporter = ((progress: SyncProgress) => void) | undefined;

async function fetchAllStarredPages(
  phase: Extract<SyncProgress['phase'], 'full' | 'rescan'>,
  progressMessage: (total: number) => string,
  onProgress: ProgressReporter,
  retryMessage: (page: number, attempt: number) => string,
): Promise<{ items: StarredRepoPayload[]; total: number }> {
  const first = await fetchPageWithRetry(1, (attempt) => {
    onProgress?.({ phase, done: 0, total: null, message: retryMessage(1, attempt) });
  });
  const total = lastPage(first.link) ?? 1;
  onProgress?.({ phase, done: 1, total, message: progressMessage(total) });

  const restPages = total > 1 ? Array.from({ length: total - 1 }, (_, i) => i + 2) : [];
  let fetched = 1;
  const rest = await fetchPages(
    restPages,
    () => {
      fetched++;
      onProgress?.({ phase, done: fetched, total, message: progressMessage(total) });
    },
    (page, attempt) => {
      onProgress?.({ phase, done: fetched, total, message: retryMessage(page, attempt) });
    },
  );

  return { items: [...first.items, ...rest.flat()], total };
}

export const githubStarSource: StarSource = {
  async getUsername() {
    const u = await authStore.getUsername();
    if (!u) throw new Error('Username unknown — re-add the token in options.');
    return u;
  },

  async syncFull(onProgress) {
    const m = await getLocaleMessages();
    const username = await authStore.getUsername();
    if (!username) throw new Error('Username unknown — re-add the token in options.');
    const [starredPageSet, ownedPublic] = await Promise.all([
      fetchAllStarredPages(
        'full',
        (pageTotal) => m.background.fetchingPages(pageTotal),
        onProgress,
        (page, attempt) => m.background.fetchingPageRetry(page, attempt),
      ),
      fetchAllOwnedPublicRepositories(username),
    ]);
    const existingOwned = ownedPublic.length > 0
      ? await db.stars.bulkGet(ownedPublic.map((repo) => repo.full_name))
      : [];
    const starred = starredPageSet.items.map(toStar);
    const starredNames = new Set(starred.map((row) => row.full_name.toLocaleLowerCase('en-US')));
    const ownedOnly = ownedPublic.flatMap((repository, index) => (
      starredNames.has(repository.full_name.toLocaleLowerCase('en-US'))
        ? []
        : [toOwnedPublicRepository(repository, existingOwned[index])]
    ));
    await bulkPutStars([...ownedOnly, ...starred]);

    // Advance the incremental cursor from the authoritative starred payload.
    const newest = starredPageSet.items[0]?.starred_at ?? new Date().toISOString();
    await authStore.update({ lastSyncStarredAt: newest });

    onProgress?.({
      phase: 'full',
      done: starredPageSet.total,
      total: starredPageSet.total,
      message: m.background.syncedRepos(starred.length + ownedOnly.length),
    });
    return {
      added: starred.length + ownedOnly.length,
      updated: starred.length + ownedOnly.length,
    };
  },

  async syncIncremental() {
    const cursor = (await authStore.getConfig()).lastSyncStarredAt;
    let added = 0;
    let page = 1;
    let stop = false;
    let crossedCursor = !cursor;
    let newestStarredAt: string | null = null;
    // Walk pages in starred_at-desc order; page 1 holds the newest (captured as the next cursor). Cap at 5 pages.
    while (!stop && page <= 5) {
      const { items } = await fetchPageWithRetry(page);
      if (items.length === 0) break;
      if (page === 1) newestStarredAt = items[0]?.starred_at ?? newestStarredAt;
      const fresh = cursor ? items.filter((it) => it.starred_at > cursor) : items;
      // Upsert every repo we touch so repo metadata like `archived` stays fresh
      // even for rows that are older than the incremental cursor.
      await bulkPutStars(items.map(toStar));
      added += fresh.length;
      if (fresh.length < items.length) {
        crossedCursor = true;
        stop = true;
      }
      page++;
    }
    // Advance the cursor only after proving every newer item was covered.
    // If the page cap is hit first, a later full sync/rescan can still recover
    // the skipped window because the old cursor remains in place.
    if (newestStarredAt && crossedCursor) await authStore.update({ lastSyncStarredAt: newestStarredAt });
    return { added };
  },

  async unstar(fullName: string) {
    await deleteStar(fullName);
  },

  async star(fullName: string) {
    return putStar(fullName);
  },

  async syncRescan(onProgress) {
    const m = await getLocaleMessages();
    const previouslyTombstoned = new Set<string>();
    await db.stars.each((s) => {
      if (s.tombstone) previouslyTombstoned.add(s.full_name);
    });
    const { items: all, total } = await fetchAllStarredPages(
      'rescan',
      (pageTotal) => m.background.rescanningPages(pageTotal),
      onProgress,
      (page, attempt) => m.background.fetchingPageRetry(page, attempt),
    );
    const apiNames = new Set(all.map((it) => it.repo.full_name.toLocaleLowerCase('en-US')));

    // Refresh every starred row before reconciling prior star state.
    await bulkPutStars(all.map(toStar));

    // Tombstone any local repo absent from the API (B2 soft delete). Preserve tags/notes.
    let tombstoned = 0;
    let revived = 0;
    const changed: Star[] = [];
    let scanned = 0;
    await db.stars.each((s) => {
      scanned++;
      const stillStarred = apiNames.has(s.full_name.toLocaleLowerCase('en-US'));
      const wasStarred = s.viewer_has_starred !== false;
      if (stillStarred) {
        if (previouslyTombstoned.has(s.full_name)) revived++;
      } else if (!wasStarred) {
        // Owned public repositories remain live even when the account does not
        // star them. Full Sync refreshes their canonical metadata.
      } else if (!s.tombstone) {
        tombstoned++;
        changed.push({ ...s, viewer_has_starred: false, tombstone: true });
      }
      if (scanned % 250 === 0) {
        onProgress?.({ phase: 'rescan', done: total, total, message: m.background.reconcilingLocal(scanned) });
      }
    });
    if (changed.length > 0) await bulkPutStars(changed);

    onProgress?.({ phase: 'rescan', done: total, total, message: m.background.rescanSummary(tombstoned, revived) });
    return { tombstoned, revived };
  },
};
