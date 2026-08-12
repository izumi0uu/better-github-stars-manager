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
          async get(key: string | string[]) {
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(keys.map((item) => [item, state[item]]));
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

describe('Full sync repo-created-time regressions', () => {
  it('syncFull hydrates repository creation timestamps from REST starred pages', async () => {
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
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seenUrls.push(url);
      if (url.includes('/users/idah/repos?')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://api.github.com/user/starred?per_page=100&page=1') {
        return new Response(JSON.stringify([
          {
            starred_at: '2026-06-28T10:00:00Z',
            repo: {
              full_name: 'a/old-repo',
              html_url: 'https://github.com/a/old-repo',
              description: 'old repo',
              language: 'TypeScript',
              stargazers_count: 10,
              topics: ['tooling'],
              pushed_at: '2026-06-27T00:00:00Z',
              created_at: '2020-01-02T12:00:00Z',
              fork: false,
              archived: false,
            },
          },
        ]), {
          status: 200,
          headers: {
            link: '<https://api.github.com/user/starred?per_page=100&page=2>; rel="next", <https://api.github.com/user/starred?per_page=100&page=2>; rel="last"',
          },
        });
      }
      if (url === 'https://api.github.com/user/starred?per_page=100&page=2') {
        return new Response(JSON.stringify([
          {
            starred_at: '2026-06-27T10:00:00Z',
            repo: {
              full_name: 'b/archived-repo',
              html_url: 'https://github.com/b/archived-repo',
              description: 'archived repo',
              language: null,
              stargazers_count: 5,
              topics: [],
              pushed_at: '2026-06-27T10:00:00Z',
              created_at: '2021-03-04T08:00:00Z',
              fork: true,
              archived: true,
            },
          },
        ]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${(init?.method ?? 'GET')}`);
    }) as typeof fetch;

    const originalGetUsername = authStore.getUsername;
    const originalGetToken = authStore.getToken;
    authStore.getToken = async () => 'github_pat_test';
    authStore.getUsername = async () => 'idah';

    try {
      const result = await githubStarSource.syncFull();
      assert.deepEqual(result, { added: 2, updated: 2 });
      assert.deepEqual(seenUrls, [
        'https://api.github.com/user/starred?per_page=100&page=1',
        'https://api.github.com/users/idah/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=1',
        'https://api.github.com/user/starred?per_page=100&page=2',
      ]);

      const oldRepo = await db.stars.get('a/old-repo');
      assert.equal(oldRepo?.created_at, '2020-01-02T12:00:00Z');
      assert.equal(oldRepo?.topics[0], 'tooling');

      const archivedRepo = await db.stars.get('b/archived-repo');
      assert.equal(archivedRepo?.created_at, '2021-03-04T08:00:00Z');
      assert.equal(archivedRepo?.pushed_at, '2026-06-27T10:00:00Z');
      assert.equal(archivedRepo?.archived, true);
      assert.equal((await authStore.getConfig()).lastSyncStarredAt, '2026-06-28T10:00:00Z');
    } finally {
      authStore.getUsername = originalGetUsername;
      authStore.getToken = originalGetToken;
    }
  });
});
