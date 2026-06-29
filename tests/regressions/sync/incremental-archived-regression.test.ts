import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';
import { db } from '../../../src/storage/db';
import { authStore, CONFIG_STORAGE_KEY } from '../../../src/auth/auth-store';
import { githubStarSource } from '../../../src/api/github-star-source';
import { invalidateCache, queryStars } from '../../../src/background/query';
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

describe('Incremental archived regressions', () => {
  it('syncIncremental refreshes archived state on older rows within touched pages', async () => {
    await db.delete();
    await db.open();
    await chrome.storage.local.set({
      [CONFIG_STORAGE_KEY]: {
        tokenEncrypted: null,
        tokenCryptoMeta: null,
        theme: 'dark',
        locale: 'en',
        defaultView: 'table',
        lastSyncStarredAt: '2026-06-20T00:00:00Z',
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

    await db.stars.bulkPut([
      {
        ...base,
        full_name: 'old/repo',
        html_url: 'https://github.com/old/repo',
        starred_at: '2026-06-19T00:00:00Z',
        pushed_at: '2026-06-19T00:00:00Z',
        archived: false,
        tombstone: false,
      },
    ] as Star[]);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('/user/starred?per_page=100&page=1')) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return new Response(JSON.stringify([
        {
          starred_at: '2026-06-22T00:00:00Z',
          repo: {
            full_name: 'new/repo',
            html_url: 'https://github.com/new/repo',
            description: 'fresh',
            language: 'TypeScript',
            stargazers_count: 10,
            topics: [],
            pushed_at: '2026-06-22T00:00:00Z',
            fork: false,
            archived: false,
          },
        },
        {
          starred_at: '2026-06-19T00:00:00Z',
          repo: {
            full_name: 'old/repo',
            html_url: 'https://github.com/old/repo',
            description: 'same repo, now archived',
            language: 'TypeScript',
            stargazers_count: 11,
            topics: [],
            pushed_at: '2026-06-22T00:00:00Z',
            fork: false,
            archived: true,
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
      const result = await githubStarSource.syncIncremental();
      assert.deepEqual(result, { added: 1 });
      invalidateCache();
      const rows = await queryStars({
        filter: {
          query: '',
          languages: [],
          tags: [],
          tagMode: 'any',
          showTombstone: false,
          onlyFavorite: false,
          onlyUntagged: false,
          onlyArchived: true,
          sortKey: 'starred_at',
          sortDir: 'desc',
        },
        offset: 0,
        limit: 100,
      });
      assert.deepEqual(rows.rows.map((s) => s.full_name), ['old/repo']);
      assert.equal(rows.rows[0]?.archived, true);
    } finally {
      authStore.getToken = originalGetToken;
    }
  });
});
