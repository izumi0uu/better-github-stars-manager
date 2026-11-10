import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';
import { createChromeMock } from '../../helpers/chrome-mock';
import { installGitHubCredential } from '../../helpers/github-credential';
import { db } from '../../../src/storage/db';
import { CONFIG_STORAGE_KEY } from '../../../src/auth/auth-store';
import { githubStarSource } from '../../../src/api/github-star-source';
import { queryStars } from '../../../src/background/query';
import type { Star } from '../../../src/types';

(globalThis as { chrome?: unknown }).chrome = createChromeMock().api;

const base = {
  html_url: 'https://github.com/x',
  description: '',
  language: null as string | null,
  stargazers_count: 0,
  topics: [] as string[],
  pushed_at: '',
  created_at: null as string | null,
  fork: false,
  archived: false,
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
        username: 'octocat',
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
      if (url.includes('/users/octocat/repos?')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
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

    await installGitHubCredential();
    const result = await githubStarSource.syncIncremental();
    assert.deepEqual(result, { added: 1 });
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
        onlyOwned: false,
        sortKey: 'starred_at',
        sortDir: 'desc',
      },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(rows.rows.map((s) => s.full_name), ['old/repo']);
    assert.equal(rows.rows[0]?.archived, true);
  });
});
