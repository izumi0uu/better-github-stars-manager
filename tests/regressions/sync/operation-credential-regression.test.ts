import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createChromeMock } from '../../helpers/chrome-mock';
import { installGitHubCredential } from '../../helpers/github-credential';
import type { StarsQueryParams } from '../../../src/stars/stars-query';
import { GH_TOKEN_REJECTED } from '../../../src/api/errors';

const chromeMock = createChromeMock();
Object.defineProperty(globalThis, 'chrome', { value: chromeMock.api, configurable: true });
// Load the storage/query modules after Chrome exists so their commit listeners are installed.
const { authStore, GITHUB_CREDENTIAL_CHANGED } = await import('../../../src/auth/auth-store');
const { db } = await import('../../../src/storage/db');
const { githubStarSource, toStar } = await import('../../../src/api/github-star-source');
const { queryStars } = await import('../../../src/background/query');
const { gistTagStore } = await import('../../../src/sync/gist-tag-store');
const { idbTagStore, resetDirtyForDev, snapshotDirtyForPush } = await import('../../../src/storage/idb-tag-store');
const originalFetch = globalThis.fetch;

function starred(full_name: string, starred_at = '2026-09-05T00:00:00Z') {
  return { starred_at, repo: { full_name, html_url: `https://github.com/${full_name}`, description: '',
    language: null, stargazers_count: 1, topics: [], pushed_at: null, created_at: null, fork: false, archived: false } };
}
function page(items: unknown[], link = '') {
  return new Response(JSON.stringify(items), { status: 200, headers: { 'content-type': 'application/json', link } });
}
const nextPage = '<https://api.github.com/user/starred?page=2>; rel="next", <https://api.github.com/user/starred?page=2>; rel="last"';
const query: StarsQueryParams = {
  filter: { query: '', languages: [], tags: [], tagMode: 'any', showTombstone: false,
    onlyFavorite: false, onlyUntagged: false, onlyArchived: false, onlyOwned: false,
    sortKey: 'starred_at', sortDir: 'desc' },
  offset: 0,
  limit: 100,
};

beforeEach(async () => {
  await db.delete();
  await db.open();
  await chrome.storage.local.clear();
  await installGitHubCredential('github_pat_account_a', 'octocat');
  await authStore.update({ lastSyncStarredAt: null, gistId: null, gistSyncCursor: null });
  resetDirtyForDev();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});
afterAll(() => db.close());

async function replaceAccount() {
  await installGitHubCredential('github_pat_account_b', 'other-account');
}

describe('Stars operation credential ownership', () => {
  for (const mode of ['full', 'incremental', 'rescan'] as const) {
    it(`${mode} rejects a later page from a replaced identity without advancing cursor or tombstones`, async () => {
      const retained = toStar(starred('retained/repo', '2026-01-01T00:00:00Z'));
      await db.stars.put(retained);
      const headers: string[] = [];
      globalThis.fetch = async (input, init) => {
        headers.push(new Headers(init?.headers).get('Authorization')!);
        if (String(input).endsWith('page=1')) return page([starred('fresh/first')], nextPage);
        await replaceAccount();
        return page([starred('wrong/second')]);
      };
      const operation = mode === 'full' ? githubStarSource.syncFull(undefined, { includeOwnedPublic: false })
        : mode === 'incremental' ? githubStarSource.syncIncremental() : githubStarSource.syncRescan();
      await assert.rejects(operation, { message: GITHUB_CREDENTIAL_CHANGED });
      assert.deepEqual(headers, ['Bearer github_pat_account_a', 'Bearer github_pat_account_a']);
      assert.equal(await db.stars.get('wrong/second'), undefined);
      assert.equal((await db.stars.get('retained/repo'))?.tombstone, false);
      assert.equal(!!await db.stars.get('fresh/first'), mode === 'incremental');
      assert.equal((await authStore.getConfig()).lastSyncStarredAt, null);
    });
  }

  it('fences remaining full-sync chunks and cursor after an already committed chunk', async () => {
    globalThis.fetch = async () => page(Array.from({ length: 501 }, (_, i) => starred(`repo/item-${i}`)));
    const commit = authStore.withGitHubCredential.bind(authStore);
    let committed = 0;
    vi.spyOn(authStore, 'withGitHubCredential').mockImplementation(async (snapshot, write) => {
      const result = await commit(snapshot, write);
      if (++committed === 1) await replaceAccount();
      return result;
    });
    await assert.rejects(githubStarSource.syncFull(undefined, { includeOwnedPublic: false }), { message: GITHUB_CREDENTIAL_CHANGED });
    assert.equal(await db.stars.count(), 500);
    assert.equal((await authStore.getConfig()).lastSyncStarredAt, null);
  });

  it('keeps a committed incremental page visible to a prewarmed query when the next page fails', async () => {
    await db.stars.put(toStar(starred('retained/repo')));
    assert.equal((await queryStars(query)).grandTotal, 1);
    globalThis.fetch = async (input) => String(input).endsWith('page=1')
      ? page([starred('fresh/repo')], nextPage)
      : new Response(null, { status: 401 });
    await assert.rejects(githubStarSource.syncIncremental(), { message: GH_TOKEN_REJECTED });
    assert.equal((await queryStars(query)).grandTotal, 2);
    assert.equal((await authStore.getConfig()).lastSyncStarredAt, null);
  });

  it('settles parallel page callbacks before publishing the failed operation terminal', async () => {
    // Control the microtask drain without freezing IndexedDB's setImmediate tasks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = async (input) => {
      if (String(input).endsWith('page=1')) {
        return page([starred('repo/first')], '<https://api.github.com/user/starred?page=3>; rel="last"');
      }
      if (String(input).endsWith('page=2')) return new Response(null, { status: 401 });
      entered();
      await gate;
      return page([starred('repo/third')]);
    };
    const events: string[] = [];
    const operation = githubStarSource.syncFull(() => events.push('progress'), { includeOwnedPublic: false });
    const rejected = assert.rejects(operation, { message: GH_TOKEN_REJECTED }).then(() => { events.push('failed'); });
    await started;
    // Drain the already-resolved failing page without releasing its in-flight sibling.
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(events.includes('failed'), false);
    release();
    await rejected;
    assert.equal(events.at(-1), 'failed');
    assert.equal(await db.stars.count(), 0);
  });

  it('serializes credential replacement behind a local commit and rejects a stale cursor write', async () => {
    const credential = await authStore.getGitHubCredentialSnapshot();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const commit = authStore.withGitHubCredential(credential, async () => {
      entered();
      await gate;
      await db.stars.put(toStar(starred('owned/commit')));
    });
    await started;
    let replaced = false;
    const replacement = replaceAccount().then(() => { replaced = true; });
    await Promise.resolve();
    assert.equal(replaced, false);
    release();
    await Promise.all([commit, replacement]);
    await assert.rejects(authStore.updateForGitHubCredential(credential, { lastSyncStarredAt: 'stale' }), { message: GITHUB_CREDENTIAL_CHANGED });
    assert.equal((await authStore.getConfig()).lastSyncStarredAt, null);
  });
});

describe('Gist operation credential ownership', () => {
  it('never PATCHes an existing old-account Gist after its existence request changes identity', async () => {
    await authStore.update({ gistId: 'gist-a' });
    await idbTagStore.setTags('repo/example', ['local']);
    const calls: string[] = [];
    globalThis.fetch = async (_input, init) => {
      calls.push(`${init?.method ?? 'GET'}:${new Headers(init?.headers).get('Authorization')}`);
      await replaceAccount();
      return page([]);
    };
    await assert.rejects(gistTagStore.push(snapshotDirtyForPush()), { message: GITHUB_CREDENTIAL_CHANGED });
    assert.deepEqual(calls, ['GET:Bearer github_pat_account_a']);
    assert.equal(snapshotDirtyForPush().names.length, 1);
  });

  it('does not bind an old-account create response or follow it with PATCH', async () => {
    const methods: string[] = [];
    globalThis.fetch = async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      await replaceAccount();
      return new Response(JSON.stringify({ id: 'orphaned-old-account-gist' }), { status: 201 });
    };
    await assert.rejects(gistTagStore.push(snapshotDirtyForPush()), { message: GITHUB_CREDENTIAL_CHANGED });
    assert.deepEqual(methods, ['POST']);
    assert.equal((await authStore.getConfig()).gistId, null);
  });

  it('retains dirty state and cursor when identity changes during PATCH', async () => {
    await authStore.update({ gistId: 'gist-a' });
    await idbTagStore.setTags('repo/example', ['local']);
    const headers: string[] = [];
    globalThis.fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers).get('Authorization')!);
      if (init?.method === 'PATCH') await replaceAccount();
      return page([]);
    };
    await assert.rejects(gistTagStore.push(snapshotDirtyForPush()), { message: GITHUB_CREDENTIAL_CHANGED });
    assert.deepEqual(headers, ['Bearer github_pat_account_a', 'Bearer github_pat_account_a']);
    assert.equal(snapshotDirtyForPush().names.length, 1);
    assert.equal((await authStore.getConfig()).gistSyncCursor, null);
  });

  it('does not merge or clear a binding after a stale pull response', async () => {
    await authStore.update({ gistId: 'gist-a' });
    globalThis.fetch = async () => {
      await replaceAccount();
      await authStore.update({ gistId: 'gist-b' });
      return new Response(null, { status: 404 });
    };
    await assert.rejects(gistTagStore.pull(), { message: GITHUB_CREDENTIAL_CHANGED });
    assert.equal((await authStore.getConfig()).gistId, 'gist-b');
    assert.equal(await db.tags.count(), 0);
  });
});
