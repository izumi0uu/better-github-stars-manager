import type { Star } from '@/types';
import type { StarSource } from './star-source';
import { db } from '@/storage/db';
import { authStore } from '@/auth/auth-store';
import { getMessages } from '@/i18n';
import { GH_NO_TOKEN, GH_TOKEN_REJECTED, GH_RATE_LIMIT, GH_FORBIDDEN, GH_TIMEOUT, GH_NETWORK, GH_PAGE_STATUS, GH_BAD_SHAPE } from './errors';

/**
 * GitHub-backed `StarSource` using the authenticated `GET /user/starred`
 * with `star+json` media (which surfaces `starred_at`); pages are pulled
 * concurrently. See `StarSource` for the sync job contract.
 */

const PER_PAGE = 100;
const API = 'https://api.github.com';

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
    pushed_at: string;
    fork: boolean;
    archived: boolean;
  };
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await authStore.getToken();
  if (!token) throw new Error(GH_NO_TOKEN);
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.star+json', // includes starred_at in each item
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
    fork: r.fork,
    archived: r.archived,
    starred_at: it.starred_at,
    tombstone: false,
    synced_at: new Date().toISOString(),
  };
}

/** Concurrently fetch a range of pages; returns in page-number order, not completion order. */
async function fetchPages(pages: number[], onPageDone?: () => void, concurrency = 6): Promise<StarredRepoPayload[][]> {
  const out: StarredRepoPayload[][] = new Array(pages.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
    while (idx < pages.length) {
      const my = pages[idx];
      const slot = idx;
      idx++;
      const { items } = await fetchPage(my);
      out[slot] = items; // place by input index, not push-by-completion
      onPageDone?.();
    }
  });
  await Promise.all(workers);
  return out;
}

export const githubStarSource: StarSource = {
  async getUsername() {
    const u = await authStore.getUsername();
    if (!u) throw new Error('Username unknown — re-add the token in options.');
    return u;
  },

  async syncFull(onProgress) {
    const m = await getLocaleMessages();
    const first = await fetchPage(1);
    const total = lastPage(first.link) ?? 1;
    onProgress?.({ phase: 'full', done: 1, total, message: m.background.fetchingPages(total) });

    // We already have page 1; fetch the rest concurrently.
    const restPages = total > 1 ? Array.from({ length: total - 1 }, (_, i) => i + 2) : [];
    let fetched = 1;
    const rest = await fetchPages(restPages, () => {
      fetched++;
      onProgress?.({ phase: 'full', done: fetched, total, message: m.background.fetchingPages(total) });
    });
    const all = [...first.items, ...rest.flat()];

    // Bulk upsert. Dexie bulkPut is the fastest path.
    const stars = all.map(toStar);
    await db.stars.bulkPut(stars);

    // Advance the incremental cursor to the newest starred_at.
    const newest = all[0]?.starred_at ?? new Date().toISOString();
    await authStore.update({ lastSyncStarredAt: newest });

    onProgress?.({ phase: 'full', done: total, total, message: m.background.syncedRepos(stars.length) });
    return { added: stars.length, updated: stars.length };
  },

  async syncIncremental() {
    const cursor = (await authStore.getConfig()).lastSyncStarredAt;
    let added = 0;
    let page = 1;
    let stop = false;
    let newestStarredAt: string | null = null;
    // Walk pages in starred_at-desc order; page 1 holds the newest (captured as the next cursor). Cap at 5 pages.
    while (!stop && page <= 5) {
      const { items } = await fetchPage(page);
      if (items.length === 0) break;
      if (page === 1) newestStarredAt = items[0]?.starred_at ?? newestStarredAt;
      const fresh = cursor ? items.filter((it) => it.starred_at > cursor) : items;
      if (fresh.length > 0) {
        await db.stars.bulkPut(fresh.map(toStar));
        added += fresh.length;
      }
      if (cursor && items.some((it) => it.starred_at <= cursor)) stop = true;
      if (fresh.length < items.length) stop = true;
      page++;
    }
    // Advance cursor to the newest we saw this run.
    if (newestStarredAt) await authStore.update({ lastSyncStarredAt: newestStarredAt });
    return { added };
  },

  async syncRescan(onProgress) {
    const m = await getLocaleMessages();
    const first = await fetchPage(1);
    const total = lastPage(first.link) ?? 1;
    onProgress?.({ phase: 'rescan', done: 1, total, message: m.background.rescanningPages(total) });

    const restPages = total > 1 ? Array.from({ length: total - 1 }, (_, i) => i + 2) : [];
    let fetched = 1;
    const rest = await fetchPages(restPages, () => {
      fetched++;
      onProgress?.({ phase: 'rescan', done: fetched, total, message: m.background.rescanningPages(total) });
    });
    const all = [...first.items, ...rest.flat()];
    const apiNames = new Set(all.map((it) => it.repo.full_name));

    // Refresh all live repos.
    await db.stars.bulkPut(all.map(toStar));

    // Tombstone any local repo absent from the API (B2 soft delete). Preserve tags/notes.
    let tombstoned = 0;
    let revived = 0;
    await db.stars.each((s) => {
      const stillStarred = apiNames.has(s.full_name);
      if (!stillStarred && !s.tombstone) {
        tombstoned++;
        db.stars.update(s.full_name, { tombstone: true });
      } else if (stillStarred && s.tombstone) {
        revived++;
        db.stars.update(s.full_name, { tombstone: false });
      }
    });

    onProgress?.({ phase: 'rescan', done: total, total, message: `Rescan: ${tombstoned} removed from live set, ${revived} restored` });
    return { tombstoned, revived };
  },
};
