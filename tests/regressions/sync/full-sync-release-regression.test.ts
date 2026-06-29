import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';
import { db } from '../../../src/storage/db';
import { authStore, CONFIG_STORAGE_KEY } from '../../../src/auth/auth-store';
import { githubStarSource } from '../../../src/api/github-star-source';

function createChromeMock() {
  const state: Record<string, unknown> = {};
  const listeners = new Set<
    (changes: Record<string, { oldValue: unknown; newValue: unknown }>, areaName: string) => void
  >();
  return {
    api: {
      storage: {
        local: {
          async get(key: string) {
            return { [key]: state[key] };
          },
          async set(next: Record<string, unknown>) {
            const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};
            for (const [key, value] of Object.entries(next)) {
              changes[key] = { oldValue: state[key], newValue: value };
              state[key] = value;
            }
            for (const listener of listeners) listener(changes, 'local');
          },
        },
        onChanged: {
          addListener(listener: (changes: Record<string, { oldValue: unknown; newValue: unknown }>, areaName: string) => void) {
            listeners.add(listener);
          },
          removeListener(listener: (changes: Record<string, { oldValue: unknown; newValue: unknown }>, areaName: string) => void) {
            listeners.delete(listener);
          },
        },
      },
    },
  };
}

(globalThis as { chrome?: unknown }).chrome = createChromeMock().api;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await db.close();
});

describe('Full sync release regressions', () => {
  it('syncFull hydrates latest release timestamps from GraphQL without per-repo release calls', async () => {
    await db.delete();
    await db.open();
    await chrome.storage.local.set({
      [CONFIG_STORAGE_KEY]: {
        tokenEncrypted: null,
        tokenCryptoMeta: null,
        theme: 'dark',
        locale: 'en',
        defaultView: 'table',
        lastSyncStarredAt: null,
        gistId: null,
        gistSyncCursor: null,
        username: 'idah',
        avatarUrl: null,
        displayName: null,
        seenOnboarding: false,
        seenTooltips: 0,
        langTagMigrationDone: false,
        lastSyncProgress: { phase: 'idle', done: 0, total: null, message: '' },
      },
    });

    const seenUrls: string[] = [];
    const graphQlBodies: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seenUrls.push(url);
      if (url !== 'https://api.github.com/graphql') {
        throw new Error(`unexpected fetch: ${url}`);
      }
      graphQlBodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({
        data: {
          viewer: {
            starredRepositories: {
              totalCount: 2,
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              edges: [
                {
                  starredAt: '2026-06-28T10:00:00Z',
                  node: {
                    nameWithOwner: 'a/with-release',
                    url: 'https://github.com/a/with-release',
                    description: 'has release',
                    primaryLanguage: { name: 'TypeScript' },
                    stargazerCount: 10,
                    repositoryTopics: {
                      nodes: [{ topic: { name: 'tooling' } }],
                    },
                    pushedAt: '2026-06-27T00:00:00Z',
                    isFork: false,
                    isArchived: false,
                    latestRelease: {
                      publishedAt: '2026-06-20T12:00:00Z',
                      createdAt: '2026-06-19T12:00:00Z',
                    },
                  },
                },
                {
                  starredAt: '2026-06-27T10:00:00Z',
                  node: {
                    nameWithOwner: 'b/no-release',
                    url: 'https://github.com/b/no-release',
                    description: 'no release',
                    primaryLanguage: null,
                    stargazerCount: 5,
                    repositoryTopics: {
                      nodes: [],
                    },
                    pushedAt: null,
                    isFork: true,
                    isArchived: true,
                    latestRelease: null,
                  },
                },
              ],
            },
          },
        },
      }), { status: 200 });
    }) as typeof fetch;

    const originalGetToken = authStore.getToken;
    authStore.getToken = async () => 'github_pat_test';

    try {
      const result = await githubStarSource.syncFull();
      assert.deepEqual(result, { added: 2, updated: 2 });
      assert.deepEqual(seenUrls, ['https://api.github.com/graphql']);
      assert.match(graphQlBodies[0] ?? '', /starredRepositories/);
      assert.match(graphQlBodies[0] ?? '', /latestRelease/);

      const withRelease = await db.stars.get('a/with-release');
      assert.equal(withRelease?.latest_release_at, '2026-06-20T12:00:00Z');
      assert.ok(withRelease?.latest_release_synced_at);
      assert.equal(withRelease?.topics[0], 'tooling');

      const noRelease = await db.stars.get('b/no-release');
      assert.equal(noRelease?.latest_release_at, null);
      assert.ok(noRelease?.latest_release_synced_at);
      assert.equal(noRelease?.pushed_at, '2026-06-27T10:00:00Z');
      assert.equal(noRelease?.archived, true);
      assert.equal((await authStore.getConfig()).lastSyncStarredAt, '2026-06-28T10:00:00Z');
    } finally {
      authStore.getToken = originalGetToken;
    }
  });
});
