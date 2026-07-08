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
  repo: {
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
  };
}

async function authHeaders(accept = 'application/vnd.github.star+json'): Promise<HeadersInit> {
  const token = await authStore.getToken();
  if (!token) throw new Error(GH_NO_TOKEN);
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
  };
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
function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function fetchPage(page: number): Promise<{ items: StarredRepoPayload[]; link: string | null }> {
  const { signal, cancel } = withTimeout(30_000);
  let res: Response;
  try {
    res = await fetch(`${API}/user/starred?per_page=${PER_PAGE}&page=${page}`, {
      headers: await authHeaders(),
      cache: 'no-store', // avoid 304s that can hang the SW fetch in some Chrome versions
      signal,
    });
  } catch (e) {
    cancel();
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${GH_TIMEOUT}${page}`);
    }
    throw new Error(`${GH_NETWORK}${e instanceof Error ? e.message : String(e)}`);
  }
  cancel();
  if (res.status === 401) throw new Error(GH_TOKEN_REJECTED);
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') throw new Error(GH_RATE_LIMIT);
    throw new Error(GH_FORBIDDEN);
  }
  if (res.status === 204 || res.status === 304) {
    // 204 No Content / 304 Not Modified: no items this page. Treat as empty.
    return { items: [], link: res.headers.get('link') };
  }
  if (!res.ok) throw new Error(`${GH_PAGE_STATUS}${res.status}`);
  const items = (await res.json()) as StarredRepoPayload[];
  // Guard against an unexpected flat shape (e.g. if GitHub changes media behavior):
  // if items have no nested `repo`, the put() below would fail with a bad key.
  if (items.length && !items[0].repo) {
    throw new Error(GH_BAD_SHAPE);
  }
  return { items, link: res.headers.get('link') };
}

function splitFullName(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1 || fullName.indexOf('/', slash + 1) !== -1) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

async function deleteStar(fullName: string): Promise<void> {
  const { owner, repo } = splitFullName(fullName);
  const { signal, cancel } = withTimeout(30_000);
  let res: Response;
  try {
    res = await fetch(`${API}/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      method: 'DELETE',
      headers: await authHeaders('application/vnd.github+json'),
      cache: 'no-store',
      signal,
    });
  } catch (e) {
    cancel();
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${GH_NETWORK}request timed out`);
    }
    throw new Error(`${GH_NETWORK}${e instanceof Error ? e.message : String(e)}`);
  }
  cancel();
  if (res.status === 204 || res.status === 304 || res.status === 404) return;
  if (res.status === 401) throw new Error(GH_TOKEN_REJECTED);
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') throw new Error(GH_RATE_LIMIT);
    throw new Error(GH_FORBIDDEN);
  }
  throw new Error(`${GH_PAGE_STATUS}${res.status}`);
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
    starred_at: it.starred_at,
    tombstone: false,
    synced_at: new Date().toISOString(),
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
    const { items, total } = await fetchAllStarredPages(
      'full',
      (pageTotal) => m.background.fetchingPages(pageTotal),
      onProgress,
      (page, attempt) => m.background.fetchingPageRetry(page, attempt),
    );
    const stars = items.map(toStar);
    await bulkPutStars(stars);

    // Advance the incremental cursor to the newest starred_at.
    const newest = items[0]?.starred_at ?? new Date().toISOString();
    await authStore.update({ lastSyncStarredAt: newest });

    onProgress?.({ phase: 'full', done: total, total, message: m.background.syncedRepos(stars.length) });
    return { added: stars.length, updated: stars.length };
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
    const apiNames = new Set(all.map((it) => it.repo.full_name));

    // Refresh all live repos.
    await bulkPutStars(all.map(toStar));

    // Tombstone any local repo absent from the API (B2 soft delete). Preserve tags/notes.
    let tombstoned = 0;
    let revived = 0;
    const changed: Star[] = [];
    let scanned = 0;
    await db.stars.each((s) => {
      scanned++;
      const stillStarred = apiNames.has(s.full_name);
      if (stillStarred && previouslyTombstoned.has(s.full_name)) {
        revived++;
      } else if (!stillStarred && !s.tombstone) {
        tombstoned++;
        changed.push({ ...s, tombstone: true });
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
