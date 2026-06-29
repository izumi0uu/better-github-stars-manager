import type { Star } from '@/types';
import type { StarSource } from './star-source';
import { db } from '@/storage/db';
import { authStore } from '@/auth/auth-store';
import { getMessages } from '@/i18n';
import { GH_NO_TOKEN, GH_TOKEN_REJECTED, GH_RATE_LIMIT, GH_FORBIDDEN, GH_TIMEOUT, GH_NETWORK, GH_PAGE_STATUS, GH_BAD_SHAPE } from './errors';

/**
 * GitHub-backed `StarSource`.
 * - Incremental / rescan keep using authenticated `GET /user/starred`
 *   with `star+json` media (needed for the existing cursor + tombstone flow).
 * - Full sync uses GraphQL so release metadata can be hydrated in the same
 *   page request instead of doing one extra REST call per repo.
 * See `StarSource` for the sync job contract.
 */

const PER_PAGE = 100;
const API = 'https://api.github.com';
const GRAPHQL_API = `${API}/graphql`;
const WRITE_CHUNK = 500;
// GitHub GraphQL lets us fetch starred repos and `latestRelease` together,
// which keeps full sync to one request per page instead of one extra REST
// request per repo. One boundary to remember: the official docs say
// `StarredRepositoryConnection.isOverLimit` becomes true when a user's stars
// list is truncated for very large libraries, so this path should grow an
// explicit completeness check before we rely on it for huge accounts.
// Docs: https://docs.github.com/en/graphql/reference/repos#starredrepositoryconnection
const STARRED_REPOS_WITH_RELEASE_QUERY = `
  query StarredReposWithRelease($first: Int!, $after: String) {
    viewer {
      starredRepositories(
        first: $first
        after: $after
        orderBy: { field: STARRED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          starredAt
          node {
            nameWithOwner
            url
            description
            primaryLanguage {
              name
            }
            stargazerCount
            repositoryTopics(first: 100) {
              nodes {
                topic {
                  name
                }
              }
            }
            pushedAt
            isFork
            isArchived
            latestRelease {
              publishedAt
              createdAt
            }
          }
        }
      }
    }
  }
`;

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

interface LatestReleasePayload {
  published_at?: string | null;
  created_at?: string | null;
  publishedAt?: string | null;
  createdAt?: string | null;
}

interface GraphQlStarredRepoPayload {
  starredAt: string;
  node: {
    nameWithOwner: string;
    url: string;
    description: string | null;
    primaryLanguage: { name: string } | null;
    stargazerCount: number;
    repositoryTopics: {
      nodes: Array<{
        topic: { name: string } | null;
      } | null>;
    };
    pushedAt: string | null;
    isFork: boolean;
    isArchived: boolean;
    latestRelease: LatestReleasePayload | null;
  } | null;
}

interface GraphQlStarredPagePayload {
  totalCount: number;
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  edges: GraphQlStarredRepoPayload[];
}

interface GraphQlEnvelope {
  data?: {
    viewer?: {
      starredRepositories?: GraphQlStarredPagePayload;
    };
  };
  errors?: Array<{ message?: string }>;
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await authStore.getToken();
  if (!token) throw new Error(GH_NO_TOKEN);
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.star+json', // includes starred_at in each item
  };
}

async function graphQlHeaders(): Promise<HeadersInit> {
  const token = await authStore.getToken();
  if (!token) throw new Error(GH_NO_TOKEN);
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
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

async function fetchGraphQlPage(after: string | null): Promise<GraphQlStarredPagePayload> {
  const { signal, cancel } = withTimeout(30_000);
  let res: Response;
  try {
    res = await fetch(GRAPHQL_API, {
      method: 'POST',
      headers: await graphQlHeaders(),
      body: JSON.stringify({
        query: STARRED_REPOS_WITH_RELEASE_QUERY,
        variables: {
          first: PER_PAGE,
          after,
        },
      }),
      cache: 'no-store',
      signal,
    });
  } catch (e) {
    cancel();
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${GH_TIMEOUT}graphql`);
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
  if (!res.ok) throw new Error(`${GH_PAGE_STATUS}${res.status}`);
  const body = (await res.json()) as GraphQlEnvelope;
  if (body.errors?.length) {
    throw new Error(body.errors.map((err) => err.message || 'Unknown GraphQL error').join('; '));
  }
  const page = body.data?.viewer?.starredRepositories;
  if (!page) throw new Error(GH_BAD_SHAPE);
  return page;
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

async function fetchGraphQlPageWithRetry(
  after: string | null,
  onRetry?: (attempt: number) => void,
  maxAttempts = 3,
): Promise<GraphQlStarredPagePayload> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchGraphQlPage(after);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (!retryableErrorCode(raw) || attempt === maxAttempts) throw e;
      onRetry?.(attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(`${GH_TIMEOUT}graphql`);
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
    latest_release_at: null,
    latest_release_synced_at: null,
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
  const existing = await db.stars.bulkGet(stars.map((star) => star.full_name));
  const merged = stars.map((star, index) => {
    const prev = existing[index];
    if (!prev || star.latest_release_at !== null || star.latest_release_synced_at !== null) return star;
    return {
      ...star,
      latest_release_at: prev.latest_release_at,
      latest_release_synced_at: prev.latest_release_synced_at,
    };
  });
  for (let i = 0; i < merged.length; i += WRITE_CHUNK) {
    await db.stars.bulkPut(merged.slice(i, i + WRITE_CHUNK));
    if (i + WRITE_CHUNK < stars.length) await Promise.resolve();
  }
}

function parseReleaseTimestamp(body: LatestReleasePayload): string | null {
  return body.published_at ?? body.publishedAt ?? body.created_at ?? body.createdAt ?? null;
}

function toStarFromGraphQl(it: GraphQlStarredRepoPayload, latestReleaseSyncedAt: string): Star {
  const repo = it.node;
  if (!repo) throw new Error(GH_BAD_SHAPE);
  return {
    full_name: repo.nameWithOwner,
    html_url: repo.url,
    description: repo.description ?? '',
    language: repo.primaryLanguage?.name ?? null,
    stargazers_count: repo.stargazerCount,
    topics: repo.repositoryTopics.nodes.flatMap((node) => node?.topic?.name ? [node.topic.name] : []),
    pushed_at: repo.pushedAt ?? it.starredAt,
    fork: repo.isFork,
    archived: repo.isArchived,
    starred_at: it.starredAt,
    latest_release_at: parseReleaseTimestamp(repo.latestRelease ?? {}),
    latest_release_synced_at: latestReleaseSyncedAt,
    tombstone: false,
    synced_at: new Date().toISOString(),
  };
}

async function fetchLatestReleaseAt(
  fullName: string,
  headers: HeadersInit,
): Promise<string | null> {
  const { signal, cancel } = withTimeout(15_000);
  try {
    const res = await fetch(`${API}/repos/${fullName}/releases/latest`, {
      headers: {
        ...headers,
        Accept: 'application/vnd.github+json',
      },
      cache: 'no-store',
      signal,
    });
    if (res.status === 404) return null;
    if (res.status === 401) throw new Error(GH_TOKEN_REJECTED);
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') throw new Error(GH_RATE_LIMIT);
      throw new Error(GH_FORBIDDEN);
    }
    if (!res.ok) throw new Error(`${GH_PAGE_STATUS}${res.status}`);
    return parseReleaseTimestamp((await res.json()) as LatestReleasePayload);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${GH_TIMEOUT}release:${fullName}`);
    }
    throw e;
  } finally {
    cancel();
  }
}

export async function hydrateLatestReleaseDates(fullNames: string[]): Promise<{ updated: number }> {
  const unique = [...new Set(fullNames)].filter(Boolean);
  if (unique.length === 0) return { updated: 0 };
  const headers = await authHeaders();
  const existing = await db.stars.bulkGet(unique);
  const updates: Star[] = [];
  let idx = 0;
  const workerCount = Math.min(6, unique.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (idx < unique.length) {
      const current = idx;
      idx++;
      const fullName = unique[current];
      const row = existing[current];
      if (!row) continue;
      const checkedAt = new Date().toISOString();
      const latestReleaseAt = await fetchLatestReleaseAt(fullName, headers);
      updates.push({
        ...row,
        latest_release_at: latestReleaseAt,
        latest_release_synced_at: checkedAt,
      });
    }
  });
  await Promise.all(workers);
  if (updates.length > 0) await bulkPutStars(updates);
  return { updated: updates.length };
}

export const githubStarSource: StarSource = {
  async getUsername() {
    const u = await authStore.getUsername();
    if (!u) throw new Error('Username unknown — re-add the token in options.');
    return u;
  },

  async syncFull(onProgress) {
    const m = await getLocaleMessages();
    const checkedAt = new Date().toISOString();
    const first = await fetchGraphQlPageWithRetry(null, (attempt) => {
      onProgress?.({ phase: 'full', done: 0, total: null, message: m.background.fetchingPageRetry(1, attempt) });
    });
    const total = Math.max(1, Math.ceil(first.totalCount / PER_PAGE));
    onProgress?.({ phase: 'full', done: 1, total, message: m.background.fetchingPages(total) });

    const edges: GraphQlStarredRepoPayload[] = [...first.edges];
    let fetched = 1;
    let cursor = first.pageInfo.endCursor;
    while (first.totalCount > 0 && cursor && fetched < total) {
      const nextPageNumber = fetched + 1;
      const page = await fetchGraphQlPageWithRetry(cursor, (attempt) => {
        onProgress?.({ phase: 'full', done: fetched, total, message: m.background.fetchingPageRetry(nextPageNumber, attempt) });
      });
      edges.push(...page.edges);
      fetched++;
      cursor = page.pageInfo.endCursor;
      onProgress?.({ phase: 'full', done: fetched, total, message: m.background.fetchingPages(total) });
      if (!page.pageInfo.hasNextPage) break;
    }

    // Bulk upsert. Dexie bulkPut is the fastest path.
    const stars = edges
      .filter((edge) => edge.node)
      .map((edge) => toStarFromGraphQl(edge, checkedAt));
    await bulkPutStars(stars);

    // Advance the incremental cursor to the newest starred_at.
    const newest = edges[0]?.starredAt ?? new Date().toISOString();
    await authStore.update({ lastSyncStarredAt: newest });

    onProgress?.({ phase: 'full', done: total, total, message: m.background.syncedRepos(stars.length) });
    return { added: stars.length, updated: stars.length };
  },

  async syncIncremental() {
    const cursor = (await authStore.getConfig()).lastSyncStarredAt;
    let added = 0;
    let page = 1;
    let stop = false;
    let stopReason = '';
    let newestStarredAt: string | null = null;
    // Walk pages in starred_at-desc order; page 1 holds the newest (captured as the next cursor). Cap at 5 pages.
    console.log('[GSM] incremental START | cursor:', cursor ?? '(none)');
    while (!stop && page <= 5) {
      const { items } = await fetchPageWithRetry(page);
      if (items.length === 0) { stopReason = `empty page ${page}`; break; }
      if (page === 1) newestStarredAt = items[0]?.starred_at ?? newestStarredAt;
      const fresh = cursor ? items.filter((it) => it.starred_at > cursor) : items;
      console.log(`[GSM] incremental page ${page} | items=${items.length} fresh=${fresh.length}`);
      // Upsert every repo we touch so repo metadata like `archived` stays fresh
      // even for rows that are older than the incremental cursor.
      await bulkPutStars(items.map(toStar));
      added += fresh.length;
      if (cursor && items.some((it) => it.starred_at <= cursor)) { stop = true; stopReason = `hit old data on page ${page}`; }
      if (fresh.length < items.length) { stop = true; stopReason = stopReason || `mixed page ${page} (fresh<items)`; }
      page++;
    }
    if (!stop && page > 5) stopReason = 'hit 5-page cap';
    // Advance cursor to the newest we saw this run.
    if (newestStarredAt) await authStore.update({ lastSyncStarredAt: newestStarredAt });
    console.log('[GSM] incremental END | added:', added, '| stop:', stopReason || 'loop exhausted', '| nextCursor:', newestStarredAt ?? '(none)');
    return { added };
  },

  async syncRescan(onProgress) {
    const m = await getLocaleMessages();
    const previouslyTombstoned = new Set<string>();
    await db.stars.each((s) => {
      if (s.tombstone) previouslyTombstoned.add(s.full_name);
    });
    const first = await fetchPageWithRetry(1, (attempt) => {
      onProgress?.({ phase: 'rescan', done: 0, total: null, message: m.background.fetchingPageRetry(1, attempt) });
    });
    const total = lastPage(first.link) ?? 1;
    onProgress?.({ phase: 'rescan', done: 1, total, message: m.background.rescanningPages(total) });

    const restPages = total > 1 ? Array.from({ length: total - 1 }, (_, i) => i + 2) : [];
    let fetched = 1;
    const rest = await fetchPages(
      restPages,
      () => {
        fetched++;
        onProgress?.({ phase: 'rescan', done: fetched, total, message: m.background.rescanningPages(total) });
      },
      (page, attempt) => {
        onProgress?.({ phase: 'rescan', done: fetched, total, message: m.background.fetchingPageRetry(page, attempt) });
      },
    );
    const all = [...first.items, ...rest.flat()];
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
