import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';
import { db } from '../../../src/storage/db';
import { authStore, CONFIG_STORAGE_KEY } from '../../../src/auth/auth-store';
import { githubStarSource } from '../../../src/api/github-star-source';
import { installGitHubCredential } from '../../helpers/github-credential';
import { createChromeMock } from '../../helpers/chrome-mock';


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
        username: 'octocat',
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
      if (url.includes('/users/octocat/repos?')) {
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
              owner: { avatar_url: 'https://avatars.githubusercontent.com/u/10?v=4' },
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
              owner: { avatar_url: 'https://avatars.githubusercontent.com/u/11?v=4' },
            },
          },
        ]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${(init?.method ?? 'GET')}`);
    }) as typeof fetch;

    await installGitHubCredential();
      const result = await githubStarSource.syncFull();
      assert.deepEqual(result, { added: 2, updated: 2 });
      assert.deepEqual([...seenUrls].sort(), [
        'https://api.github.com/user/starred?per_page=100&page=1',
        'https://api.github.com/users/octocat/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=1',
        'https://api.github.com/user/starred?per_page=100&page=2',
      ].sort());

      const oldRepo = await db.stars.get('a/old-repo');
      assert.equal(oldRepo?.created_at, '2020-01-02T12:00:00Z');
      assert.equal(oldRepo?.owner_avatar_url, 'https://avatars.githubusercontent.com/u/10?v=4');
      assert.equal(oldRepo?.topics[0], 'tooling');

      const archivedRepo = await db.stars.get('b/archived-repo');
      assert.equal(archivedRepo?.created_at, '2021-03-04T08:00:00Z');
      assert.equal(archivedRepo?.pushed_at, '2026-06-27T10:00:00Z');
      assert.equal(archivedRepo?.archived, true);
      assert.equal(archivedRepo?.owner_avatar_url, 'https://avatars.githubusercontent.com/u/11?v=4');
      assert.equal((await authStore.getConfig()).lastSyncStarredAt, '2026-06-28T10:00:00Z');
  });
});
