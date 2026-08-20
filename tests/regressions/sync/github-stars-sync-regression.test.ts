import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it, vi } from 'vitest';
import {
  DEFAULT_AUTO_TAG_LIMIT,
  DEFAULT_LIBRARY_VIEW_PREFS,
  DEFAULT_MIN_TOPIC_REPO_COUNT,
} from '../../../src/preferences';
import type { Config } from '../../../src/types';
import { createChromeMock } from '../../helpers/chrome-mock';

const chromeMock = createChromeMock();
Object.defineProperty(globalThis, 'chrome', { value: chromeMock.api, configurable: true });

const { db } = await import('../../../src/storage/db');
const { authStore, CONFIG_STORAGE_KEY } = await import('../../../src/auth/auth-store');
const { githubStarSource, toStar } = await import('../../../src/api/github-star-source');

const originalFetch = globalThis.fetch;
const originalGetToken = authStore.getToken;
const originalGetUsername = authStore.getUsername;

function configWithCursor(lastSyncStarredAt: string | null): Config {
  return {
    tokenEncrypted: null,
    githubCredentialStatus: null,
    watchNotificationsEnabled: false,
    tokenCryptoMeta: null,
    watchCollapsedRepositories: {},
    radarWindowDays: 60,
    agentProvider: {
      provider: 'openai',
      protocol: null,
      baseUrl: null,
      model: 'gpt-5-mini',
      apiKeyEncrypted: null,
      apiKeyCryptoMeta: null,
      credentialScope: null,
      credentialRevision: null,
      capability: null,
    },
    agentDataDisclosureAcceptance: null,
    theme: 'dark',
    locale: 'en',
    defaultView: 'table',
    lastSyncStarredAt,
    gistId: null,
    gistSyncCursor: null,
    username: 'octocat',
    avatarUrl: null,
    displayName: null,
    onboardingStage: 'awaiting_sync',
    seenOnboarding: false,
    seenTooltips: 0,
    autoTagAgentPromptSeen: false,
    storeRatingPrompt: {
      version: 1,
      status: 'tracking',
      activeLocalDays: [],
      meaningfulActionCount: 0,
      exposureCount: 0,
      snoozeUntil: null,
    },
    autoTagLimit: DEFAULT_AUTO_TAG_LIMIT,
    maxTagsPerRepo: DEFAULT_AUTO_TAG_LIMIT,
    minTopicRepoCount: DEFAULT_MIN_TOPIC_REPO_COUNT,
    libraryView: DEFAULT_LIBRARY_VIEW_PREFS,
    starsPanelDefaultEnabled: true,
    columnLayoutMode: 'default',
    customColumnLayout: null,
    langTagMigrationDone: true,
    lastSyncProgress: { phase: 'idle', done: 0, total: null, message: '' },
    backfills: {},
  };
}

async function resetState(lastSyncStarredAt: string | null) {
  await db.delete();
  await db.open();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: configWithCursor(lastSyncStarredAt) });
  authStore.getToken = async () => 'github_pat_synthetic';
  authStore.getUsername = async () => 'octocat';
}

function starredRepo(
  full_name: string,
  starred_at: string,
  overrides: Partial<{
    html_url: string;
    description: string;
    language: string | null;
    stargazers_count: number;
    topics: string[];
    pushed_at: string | null;
    created_at: string | null;
    fork: boolean;
    archived: boolean;
    owner: unknown;
  }> = {},
) {
  return {
    starred_at,
    repo: {
      full_name,
      html_url: overrides.html_url ?? `https://github.com/${full_name}`,
      description: overrides.description ?? `${full_name} description`,
      language: overrides.language ?? 'TypeScript',
      stargazers_count: overrides.stargazers_count ?? 1,
      topics: overrides.topics ?? [],
      pushed_at: overrides.pushed_at ?? starred_at,
      created_at: overrides.created_at ?? '2020-01-01T00:00:00Z',
      fork: overrides.fork ?? false,
      archived: overrides.archived ?? false,
      owner: overrides.owner ?? { avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
    },
  };
}
function pageResponse(items: unknown[], link = ''): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { link, 'content-type': 'application/json' },
  });
}

function urlFrom(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  authStore.getToken = originalGetToken;
  authStore.getUsername = originalGetUsername;
  vi.useRealTimers();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  authStore.getToken = originalGetToken;
  authStore.getUsername = originalGetUsername;
  await db.close();
});

describe('GitHub stars sync regressions', () => {
  it('syncFull preserves page-number order when later pages resolve out of order', async () => {
    await resetState(null);

    let releasePage2: ((response: Response) => void) | undefined;
    const fetchStarts: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      const url = urlFrom(input);
      fetchStarts.push(url);
      if (url.includes('/users/octocat/repos?')) return pageResponse([]);
      if (url.endsWith('page=1')) {
        return pageResponse(
          [starredRepo('newest/repo', '2026-07-03T00:00:00Z')],
          '<https://api.github.com/user/starred?per_page=100&page=2>; rel="next", <https://api.github.com/user/starred?per_page=100&page=3>; rel="last"',
        );
      }
      if (url.endsWith('page=2')) {
        return new Promise<Response>((resolve) => {
          releasePage2 = resolve;
        });
      }
      if (url.endsWith('page=3')) {
        return pageResponse([
          starredRepo('order/probe', '2026-07-01T00:00:00Z', {
            description: 'page 3 wins only when page slots are flattened in input order',
            stargazers_count: 3,
          }),
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    globalThis.fetch = fetchMock;

    const fullSync = githubStarSource.syncFull();
    while (!releasePage2) await Promise.resolve();
    const resolvePage2 = releasePage2;
    assert.ok(resolvePage2);
    resolvePage2(pageResponse([
      starredRepo('order/probe', '2026-07-02T00:00:00Z', {
        description: 'page 2 would win if completion order overwrote page order',
        stargazers_count: 2,
      }),
    ]));

    const result = await fullSync;
    assert.deepEqual(result, { added: 3, updated: 3 });
    assert.deepEqual(fetchStarts, [
      'https://api.github.com/user/starred?per_page=100&page=1',
      'https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=1',
      'https://api.github.com/user/starred?per_page=100&page=2',
      'https://api.github.com/user/starred?per_page=100&page=3',
    ]);

    const orderProbe = await db.stars.get('order/probe');
    assert.equal(orderProbe?.description, 'page 3 wins only when page slots are flattened in input order');
    assert.equal(orderProbe?.stargazers_count, 3);
  });

  it('syncFull merges every owned public repository without widening starred-only semantics', async () => {
    await resetState(null);
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = urlFrom(input);
      requests.push(url);
      if (url === 'https://api.github.com/user/starred?per_page=100&page=1') {
        return pageResponse([
          starredRepo('octocat/starred-owned', '2026-07-03T00:00:00Z', {
            description: 'authoritative starred payload',
            owner: { avatar_url: 'https://avatars.githubusercontent.com/u/101?v=4' },
          }),
          starredRepo('elsewhere/starred', '2026-07-02T00:00:00Z'),
        ]);
      }
      if (url === 'https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=1') {
        return pageResponse([
          {
            ...starredRepo('octocat/not-starred', '2020-01-01T00:00:00Z').repo,
            private: false,
            description: 'owned but not starred',
            owner: { avatar_url: 'https://avatars.githubusercontent.com/u/102?v=4' },
          },
          {
            ...starredRepo('octocat/starred-owned', '2020-01-01T00:00:00Z').repo,
            private: false,
            description: 'owned endpoint must not overwrite starred metadata',
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await githubStarSource.syncFull();

    assert.deepEqual(result, { added: 3, updated: 3 });
    assert.deepEqual(requests, [
      'https://api.github.com/user/starred?per_page=100&page=1',
      'https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=1',
    ]);
    assert.deepEqual(
      (await db.stars.toArray()).map((row) => row.full_name).sort(),
      ['elsewhere/starred', 'octocat/not-starred', 'octocat/starred-owned'],
    );
    assert.equal((await db.stars.get('octocat/not-starred'))?.viewer_has_starred, false);
    assert.equal((await db.stars.get('octocat/not-starred'))?.tombstone, false);
    assert.equal((await db.stars.get('octocat/starred-owned'))?.viewer_has_starred, true);
    assert.equal((await db.stars.get('octocat/starred-owned'))?.description, 'authoritative starred payload');
    assert.equal((await db.stars.get('octocat/not-starred'))?.owner_avatar_url, 'https://avatars.githubusercontent.com/u/102?v=4');
    assert.equal((await db.stars.get('octocat/starred-owned'))?.owner_avatar_url, 'https://avatars.githubusercontent.com/u/101?v=4');
  });

  it('syncIncremental pulls newly owned public repositories without downgrading known stars', async () => {
    await resetState('2026-06-20T00:00:00Z');
    await db.stars.put(toStar(starredRepo('octocat/existing-starred', '2026-06-10T00:00:00Z', {
      description: 'stale starred metadata',
      archived: false,
    })));
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = urlFrom(input);
      requests.push(url);
      if (url === 'https://api.github.com/user/starred?per_page=100&page=1') {
        return pageResponse([]);
      }
      if (url === 'https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=1') {
        return pageResponse([
          {
            ...starredRepo('octocat/existing-starred', '2020-01-01T00:00:00Z', {
              archived: true,
            }).repo,
            private: false,
            description: 'refreshed owned metadata',
          },
        ], '<https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=2>; rel="next"');
      }
      if (url === 'https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=2') {
        return pageResponse([
          {
            ...starredRepo('octocat/latest-public', '2026-06-21T00:00:00Z').repo,
            private: false,
            description: 'newly created owned repository',
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await githubStarSource.syncIncremental();

    assert.deepEqual(result, { added: 1 });
    assert.deepEqual(requests, [
      'https://api.github.com/user/starred?per_page=100&page=1',
      'https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=1',
      'https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=2',
    ]);
    const latest = await db.stars.get('octocat/latest-public');
    assert.equal(latest?.viewer_has_starred, false);
    assert.equal(latest?.tombstone, false);
    assert.equal(latest?.description, 'newly created owned repository');
    const existingStarred = await db.stars.get('octocat/existing-starred');
    assert.equal(existingStarred?.viewer_has_starred, true);
    assert.equal(existingStarred?.starred_at, '2026-06-10T00:00:00Z');
    assert.equal(existingStarred?.tombstone, false);
    assert.equal(existingStarred?.description, 'refreshed owned metadata');
    assert.equal(existingStarred?.archived, true);
  });

  it('syncIncremental refreshes touched older rows but counts only fresh stars as added', async () => {
    await resetState('2026-06-20T00:00:00Z');
    await db.stars.put({
      full_name: 'old/repo',
      html_url: 'https://github.com/old/repo',
      description: 'stale metadata',
      language: 'TypeScript',
      stargazers_count: 4,
      topics: [],
      pushed_at: '2026-06-19T00:00:00Z',
      created_at: '2020-01-01T00:00:00Z',
      fork: false,
      archived: false,
      starred_at: '2026-06-19T00:00:00Z',
      tombstone: false,
      synced_at: '2026-06-19T00:00:00Z',
    });

    const fetchMock: typeof fetch = async (input) => {
      const url = urlFrom(input);
      if (url.includes('/users/octocat/repos?')) return pageResponse([]);
      if (!url.endsWith('page=1')) throw new Error(`unexpected fetch: ${url}`);
      return pageResponse([
        starredRepo('fresh/repo', '2026-06-22T00:00:00Z', {
          description: 'new star',
          stargazers_count: 10,
        }),
        starredRepo('old/repo', '2026-06-19T00:00:00Z', {
          description: 'refreshed metadata from touched old row',
          stargazers_count: 11,
          pushed_at: '2026-06-21T00:00:00Z',
          archived: true,
          owner: { avatar_url: 'https://avatars.githubusercontent.com/u/11?v=4' },
        }),
      ]);
    };
    globalThis.fetch = fetchMock;

    const result = await githubStarSource.syncIncremental();
    assert.deepEqual(result, { added: 1 });

    const oldRepo = await db.stars.get('old/repo');
    assert.equal(oldRepo?.description, 'refreshed metadata from touched old row');
    assert.equal(oldRepo?.stargazers_count, 11);
    assert.equal(oldRepo?.pushed_at, '2026-06-21T00:00:00Z');
    assert.equal(oldRepo?.archived, true);
    assert.equal(oldRepo?.owner_avatar_url, 'https://avatars.githubusercontent.com/u/11?v=4');
    assert.equal((await db.stars.get('fresh/repo'))?.tombstone, false);
    assert.equal((await authStore.getConfig()).lastSyncStarredAt, '2026-06-22T00:00:00Z');
  });

  it('syncIncremental does not advance the cursor when the page cap hides the previous cursor', async () => {
    await resetState('2026-06-01T00:00:00Z');
    const fetchedPages: number[] = [];

    const fetchMock: typeof fetch = async (input) => {
      const url = urlFrom(input);
      if (url.includes('/users/octocat/repos?')) return pageResponse([]);
      const page = Number(new URL(url).searchParams.get('page'));
      fetchedPages.push(page);
      if (page < 1 || page > 5) throw new Error(`unexpected fetch: ${url}`);
      return pageResponse([
        starredRepo(`fresh/page-${page}`, `2026-06-${String(20 - page).padStart(2, '0')}T00:00:00Z`),
      ]);
    };
    globalThis.fetch = fetchMock;

    const result = await githubStarSource.syncIncremental();

    assert.deepEqual(result, { added: 5 });
    assert.deepEqual(fetchedPages, [1, 2, 3, 4, 5]);
    assert.equal((await authStore.getConfig()).lastSyncStarredAt, '2026-06-01T00:00:00Z');
  });

  it('syncFull records a deterministic cursor when the starred account is empty', async () => {
    await resetState('2026-06-20T00:00:00Z');

    const progress: Array<{ phase: string; done: number; total: number | null }> = [];
    const fetchMock: typeof fetch = async (input) => {
      const url = urlFrom(input);
      if (url.includes('/users/octocat/repos?')) return pageResponse([]);
      if (!url.endsWith('page=1')) throw new Error(`unexpected fetch: ${url}`);
      return pageResponse([]);
    };
    globalThis.fetch = fetchMock;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-02T03:04:05.000Z'));
    const result = await githubStarSource.syncFull((p) => {
      progress.push({ phase: p.phase, done: p.done, total: p.total });
    });

    assert.deepEqual(result, { added: 0, updated: 0 });
    assert.equal(await db.stars.count(), 0);
    assert.equal((await authStore.getConfig()).lastSyncStarredAt, '2030-01-02T03:04:05.000Z');
    assert.deepEqual(progress.at(-1), { phase: 'full', done: 1, total: 1 });
  });
  it('stars a Radar repository and persists canonical metadata after the remote write', async () => {
    await resetState(null);
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = urlFrom(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/user/starred/owner/radar-repo')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/repos/owner/radar-repo')) {
        return new Response(JSON.stringify({
          full_name: 'Owner/radar-repo',
          html_url: 'https://github.com/Owner/radar-repo',
          description: 'Radar repository',
          language: 'Rust',
          stargazers_count: 77,
          topics: ['radar'],
          pushed_at: '2026-08-01T00:00:00Z',
          created_at: '2020-01-01T00:00:00Z',
          fork: false,
          archived: true,
          owner: { avatar_url: 'https://avatars.githubusercontent.com/u/77?v=4' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const created = await githubStarSource.star('owner/radar-repo');

    assert.equal(created.full_name, 'Owner/radar-repo');
    assert.equal(created.archived, true);
    assert.equal((await db.stars.get('Owner/radar-repo'))?.stargazers_count, 77);
    assert.equal(created.owner_avatar_url, 'https://avatars.githubusercontent.com/u/77?v=4');
    assert.deepEqual(requests.map(({ url, method }) => [method, url]), [
      ['PUT', 'https://api.github.com/user/starred/owner/radar-repo'],
      ['GET', 'https://api.github.com/repos/owner/radar-repo'],
    ]);
  });
});
