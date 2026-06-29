import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';
import { db } from '../../../src/storage/db';
import { authStore, CONFIG_STORAGE_KEY } from '../../../src/auth/auth-store';
import { githubStarSource } from '../../../src/api/github-star-source';
import type { Star } from '../../../src/types';

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

const base = {
  html_url: 'https://github.com/x',
  description: '',
  language: null as string | null,
  stargazers_count: 0,
  topics: [] as string[],
  pushed_at: '',
  fork: false,
  archived: false,
  latest_release_at: null as string | null,
  latest_release_synced_at: null as string | null,
  synced_at: '',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await db.close();
});

describe('Rescan regressions', () => {
  it('syncRescan reports revived repos when tombstones reappear in API', async () => {
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

    const stars: Star[] = [
      { ...base, full_name: 'a/live', html_url: 'https://github.com/a/live', starred_at: '2026-06-20', pushed_at: '2026-06-20', tombstone: false },
      { ...base, full_name: 'b/old', html_url: 'https://github.com/b/old', starred_at: '2026-06-19', pushed_at: '2026-06-19', tombstone: false },
      { ...base, full_name: 'c/revived', html_url: 'https://github.com/c/revived', starred_at: '2026-06-18', pushed_at: '2026-06-18', tombstone: true },
    ];
    await db.stars.bulkPut(stars);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('/user/starred?per_page=100&page=1')) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return new Response(JSON.stringify([
        {
          starred_at: '2026-06-22T00:00:00Z',
          repo: {
            full_name: 'a/live',
            html_url: 'https://github.com/a/live',
            description: 'still here',
            language: 'TypeScript',
            stargazers_count: 10,
            topics: [],
            pushed_at: '2026-06-22T00:00:00Z',
            fork: false,
            archived: false,
          },
        },
        {
          starred_at: '2026-06-23T00:00:00Z',
          repo: {
            full_name: 'c/revived',
            html_url: 'https://github.com/c/revived',
            description: 'came back',
            language: 'Python',
            stargazers_count: 7,
            topics: [],
            pushed_at: '2026-06-23T00:00:00Z',
            fork: false,
            archived: false,
          },
        },
      ]), {
        status: 200,
        headers: { link: '' },
      });
    }) as typeof fetch;

    const originalGetToken = authStore.getToken;
    authStore.getToken = async () => 'github_pat_test';

    try {
      const result = await githubStarSource.syncRescan();
      assert.deepEqual(result, { tombstoned: 1, revived: 1 });
      assert.equal((await db.stars.get('a/live'))?.tombstone, false);
      assert.equal((await db.stars.get('b/old'))?.tombstone, true);
      assert.equal((await db.stars.get('c/revived'))?.tombstone, false);
    } finally {
      authStore.getToken = originalGetToken;
    }
  });
});
