import type { Star } from '@/types';
import type { StarSource } from './star-source';
import { db } from '@/storage/db';
import { authStore } from '@/auth/auth-store';

/**
 * GitHubStarSource — MVP StarSource implementation backed by the authenticated
 * GET /user/starred endpoint (Q4: fine-grained PAT, public_repo scope).
 *
 * Endpoint facts (verified during grill):
 *  - GET /user/starred (authenticated) returns each item WITH a `starred_at` field,
 *    ordered by starred_at DESC. (The anonymous /users/{u}/starred omits it.)
 *  - 100/page max. ~99 pages for a 9900-star account.
 *  - Authenticated rate limit 5000/h — a full pull is ~99 requests, well within.
 *
 * Three sync primitives (Q5):
 *  - syncFull:        pull all pages, upsert into stars store.
 *  - syncIncremental: pull pages until we hit the lastSyncStarredAt cursor (1–2 reqs).
 *  - syncRescan:      pull all, tombstone any local repo no longer present (B2 soft-delete).
 */

const PER_PAGE = 100;
const API = 'https://api.github.com';

interface StarredItem {
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  topics?: string[];
  pushed_at: string;
  fork: boolean;
  archived: boolean;
  starred_at: string;
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await authStore.getToken();
  if (!token) throw new Error('No GitHub token configured. Open the extension options to add one.');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.star+json', // includes starred_at in each item
  };
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

async function fetchPage(page: number): Promise<{ items: StarredItem[]; link: string | null }> {
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
      throw new Error(`GitHub /user/starred page ${page} timed out after 30s.`);
    }
    throw new Error(`Network error fetching page ${page}: ${e instanceof Error ? e.message : String(e)}`);
  }
  cancel();
  if (res.status === 401) throw new Error('GitHub token rejected (401). Re-add it in options.');
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') throw new Error('GitHub rate limit hit. Wait and retry.');
    throw new Error(`GitHub 403 (forbidden). Check token scopes / repository access.`);
  }
  if (res.status === 204 || res.status === 304) {
    // 204 No Content / 304 Not Modified: no items this page. Treat as empty.
    return { items: [], link: res.headers.get('link') };
  }
  if (!res.ok) throw new Error(`GitHub /user/starred page ${page} returned ${res.status}`);
  const items = (await res.json()) as StarredItem[];
  return { items, link: res.headers.get('link') };
}

function toStar(it: StarredItem): Star {
  return {
    full_name: it.full_name,
    html_url: it.html_url,
    description: it.description ?? '',
    language: it.language,
    stargazers_count: it.stargazers_count,
    topics: it.topics ?? [],
    pushed_at: it.pushed_at,
    fork: it.fork,
    archived: it.archived,
    starred_at: it.starred_at,
    tombstone: false,
    synced_at: new Date().toISOString(),
  };
}

/** Concurrently fetch a range of pages, bounded to avoid hammering the API. */
async function fetchPages(pages: number[], concurrency = 6): Promise<StarredItem[][]> {
  const out: StarredItem[][] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
    while (idx < pages.length) {
      const my = pages[idx++];
      const { items } = await fetchPage(my);
      out.push(items);
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
    const first = await fetchPage(1);
    const total = lastPage(first.link) ?? 1;
    onProgress?.({ phase: 'full', done: 1, total, message: `Fetching ${total} pages…` });

    // We already have page 1; fetch the rest concurrently.
    const restPages = total > 1 ? Array.from({ length: total - 1 }, (_, i) => i + 2) : [];
    const rest = await fetchPages(restPages);
    const all = [...first.items, ...rest.flat()];

    // Bulk upsert. Dexie bulkPut is the fastest path.
    const stars = all.map(toStar);
    await db.stars.bulkPut(stars);

    // Advance the incremental cursor to the newest starred_at.
    const newest = all[0]?.starred_at ?? new Date().toISOString();
    await authStore.update({ lastSyncStarredAt: newest });

    onProgress?.({ phase: 'full', done: total, total, message: `Synced ${stars.length} repos` });
    return { added: stars.length, updated: stars.length };
  },

  async syncIncremental() {
    const cursor = (await authStore.getConfig()).lastSyncStarredAt;
    let added = 0;
    let page = 1;
    let stop = false;
    // Walk pages in starred_at-desc order; stop when we see a repo at/before the cursor.
    while (!stop && page <= 5) {
      // Cap at 5 pages: if more than ~500 new stars since last sync, the user can run full.
      const { items } = await fetchPage(page);
      if (items.length === 0) break;
      const fresh = cursor ? items.filter((it) => it.starred_at > cursor) : items;
      if (fresh.length > 0) {
        await db.stars.bulkPut(fresh.map(toStar));
        added += fresh.length;
      }
      if (cursor && items.some((it) => it.starred_at <= cursor)) stop = true;
      // If the whole page was fresh, there may be more — keep paging (up to the cap).
      if (fresh.length < items.length) stop = true;
      page++;
    }
    // Advance cursor to the newest we saw.
    const { items: top } = await fetchPage(1);
    if (top[0]) await authStore.update({ lastSyncStarredAt: top[0].starred_at });
    return { added };
  },

  async syncRescan(onProgress) {
    const first = await fetchPage(1);
    const total = lastPage(first.link) ?? 1;
    onProgress?.({ phase: 'rescan', done: 1, total, message: `Rescanning ${total} pages…` });

    const restPages = total > 1 ? Array.from({ length: total - 1 }, (_, i) => i + 2) : [];
    const rest = await fetchPages(restPages);
    const all = [...first.items, ...rest.flat()];
    const apiNames = new Set(all.map((it) => it.full_name));

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

    onProgress?.({ phase: 'rescan', done: total, total, message: `Rescan: ${tombstoned} unstarred, ${revived} revived` });
    return { tombstoned, revived };
  },
};
