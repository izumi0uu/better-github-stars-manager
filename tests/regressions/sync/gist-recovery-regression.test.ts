import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';
import { GIST_PUSH_FAILED } from '../../../src/api/errors';
import type { GistPayload } from '../../../src/types';
import { createChromeMock, response } from '../../helpers/chrome-mock';

const chromeMock = createChromeMock();
(globalThis as { chrome?: unknown }).chrome = chromeMock.api;

const originalFetch = globalThis.fetch;

// These modules read chrome.storage during initialization; the mock above must exist first.
const { authStore } = await import('../../../src/auth/auth-store');
const { gistTagStore } = await import('../../../src/sync/gist-tag-store');
const { idbTagStore, resetDirtyForDev, snapshotDirty, snapshotDirtyForPush } = await import('../../../src/storage/idb-tag-store');
const { db } = await import('../../../src/storage/db');

async function resetState() {
  await db.delete();
  await db.open();
  await authStore.clearToken();
  resetDirtyForDev();
  await authStore.update({
    gistId: null,
    gistSyncCursor: null,
    username: null,
    avatarUrl: null,
    displayName: null,
    seenOnboarding: false,
    seenTooltips: 0,
  });
}


function parsePatchedPayload(init: RequestInit | undefined): GistPayload {
  const bodyText = init?.body;
  if (typeof bodyText !== 'string') throw new TypeError('expected JSON request body');
  const body = JSON.parse(bodyText) as { files: Record<string, { content: string }> };
  const file = body.files['better-github-stars-manager-tags.json'];
  assert.ok(file);
  return JSON.parse(file.content) as GistPayload;
}

function gistGet(payload: unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (url.endsWith('/gists/bound-gist') && method === 'GET') {
      return response(200, {
        files: {
          'better-github-stars-manager-tags.json': {
            content: JSON.stringify(payload),
          },
        },
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
}

async function storeSyntheticToken() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (url.endsWith('/user') && method === 'GET') return response(200, { login: 'idah', avatar_url: null, name: 'Idah' });
    if (url.includes('/user/starred?per_page=1&page=1') && method === 'GET') return response(200, []);
    if (url.endsWith('/gists') && method === 'POST') return response(201, { id: 'probe-gist' });
    if (url.endsWith('/gists/probe-gist') && method === 'DELETE') return response(204);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
  await authStore.setToken('github_pat_gist_regression');
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await db.close();
});

describe('Gist recovery regressions', () => {
  it('push recreates a deleted remote gist even when local dirty set is empty', async () => {
    await resetState();
    await db.tags.put({
      full_name: 'owner/repo',
      manualTags: ['alpha'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-06-24T12:00:00.000Z',
      autoTagsMtime: '2026-06-24T12:00:00.000Z',
      dismissedAutoTagsMtime: '2026-06-24T12:00:00.000Z',
      notes: 'hello',
      mtime: '2026-06-24T12:00:00.000Z',
    });
    const calls: string[] = [];
    let gistCreateCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);

      if (url.endsWith('/user') && method === 'GET') {
        return response(200, { login: 'idah', avatar_url: null, name: 'Idah' });
      }
      if (url.includes('/user/starred?per_page=1&page=1') && method === 'GET') {
        return response(200, []);
      }
      if (url.endsWith('/gists') && method === 'POST') {
        gistCreateCount++;
        return response(201, { id: gistCreateCount === 1 ? 'probe-gist' : 'fresh-gist' });
      }
      if (url.endsWith('/gists/probe-gist') && method === 'DELETE') {
        return response(204);
      }
      if (url.endsWith('/gists/dead-gist') && method === 'GET') {
        return response(404);
      }
      if (url.endsWith('/gists/fresh-gist') && method === 'PATCH') {
        const raw = init?.body;
        const parsed = JSON.parse(String(raw)) as {
          files: Record<string, { content: string }>;
        };
        const payload = JSON.parse(
          parsed.files['better-github-stars-manager-tags.json'].content,
        ) as GistPayload;
        assert.equal(payload.v, 2);
        assert.deepEqual(payload.tags['owner/repo'], {
          manualTags: ['alpha'],
          autoTags: [],
          dismissedAutoTags: [],
          manualTagsMtime: '2026-06-24T12:00:00.000Z',
          autoTagsMtime: '2026-06-24T12:00:00.000Z',
          dismissedAutoTagsMtime: '2026-06-24T12:00:00.000Z',
          notes: 'hello',
          favorite: false,
          gh_list_id: null,
          mtime: '2026-06-24T12:00:00.000Z',
        });
        return response(200, {});
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await authStore.setToken('github_pat_test');
    await authStore.update({ gistId: 'dead-gist' });

    const result = await gistTagStore.push(snapshotDirtyForPush());
    assert.equal(result.pushed, 0);
    assert.equal(result.recreated, true);
    assert.equal(result.snapshot, 1);

    const cfg = await authStore.getConfig();
    assert.equal(cfg.gistId, 'fresh-gist');
    assert.match(String(cfg.gistSyncCursor), /^20/);
    assert.deepEqual(calls.slice(-3), [
      'GET https://api.github.com/gists/dead-gist',
      'POST https://api.github.com/gists',
      'PATCH https://api.github.com/gists/fresh-gist',
    ]);
  });

  it('pull clears a dead bound gist id after remote 404', async () => {
    await resetState();
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);

      if (url.endsWith('/user') && method === 'GET') {
        return response(200, { login: 'idah', avatar_url: null, name: 'Idah' });
      }
      if (url.includes('/user/starred?per_page=1&page=1') && method === 'GET') {
        return response(200, []);
      }
      if (url.endsWith('/gists') && method === 'POST') {
        return response(201, { id: 'probe-gist' });
      }
      if (url.endsWith('/gists/probe-gist') && method === 'DELETE') {
        return response(204);
      }
      if (url.endsWith('/gists/dead-gist') && method === 'GET') {
        return response(404);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await authStore.setToken('github_pat_test');
    await authStore.update({ gistId: 'dead-gist' });

    const result = await gistTagStore.pull();
    assert.deepEqual(result, { merged: 0, total: 0, missing: true });

    const cfg = await authStore.getConfig();
    assert.equal(cfg.gistId, null);
    const account = await authStore.getAccount();
    assert.equal(account.gistId, null);
    assert.deepEqual(calls.at(-1), 'GET https://api.github.com/gists/dead-gist');
  });

  it('push creates a new gist when none is currently bound, even without dirty changes', async () => {
    await resetState();
    await db.tags.put({
      full_name: 'owner/repo',
      manualTags: ['alpha'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-06-24T12:00:00.000Z',
      autoTagsMtime: '2026-06-24T12:00:00.000Z',
      dismissedAutoTagsMtime: '2026-06-24T12:00:00.000Z',
      notes: 'hello',
      mtime: '2026-06-24T12:00:00.000Z',
    });
    const calls: string[] = [];
    let gistCreateCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);

      if (url.endsWith('/user') && method === 'GET') {
        return response(200, { login: 'idah', avatar_url: null, name: 'Idah' });
      }
      if (url.includes('/user/starred?per_page=1&page=1') && method === 'GET') {
        return response(200, []);
      }
      if (url.endsWith('/gists') && method === 'POST') {
        gistCreateCount++;
        return response(201, { id: gistCreateCount === 1 ? 'probe-gist' : 'fresh-gist' });
      }
      if (url.endsWith('/gists/probe-gist') && method === 'DELETE') {
        return response(204);
      }
      if (url.endsWith('/gists/fresh-gist') && method === 'PATCH') {
        return response(200, {});
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await authStore.setToken('github_pat_test');

    const result = await gistTagStore.push(snapshotDirtyForPush());
    assert.equal(result.pushed, 0);
    assert.equal(result.recreated, true);
    assert.equal(result.snapshot, 1);

    const cfg = await authStore.getConfig();
    assert.equal(cfg.gistId, 'fresh-gist');
    assert.deepEqual(calls.slice(-2), [
      'POST https://api.github.com/gists',
      'PATCH https://api.github.com/gists/fresh-gist',
    ]);
  });

  it('push failure keeps dirty repo and tag meta queued', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    await idbTagStore.setTags('owner/repo', ['alpha']);
    await idbTagStore.upsertMeta({ name: 'alpha', color: '#ff0000', dimension: null, excluded: false, mtime: '2026-06-24T12:00:00.000Z' });

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/gists/bound-gist') && method === 'GET') return response(200, {});
      if (url.endsWith('/gists/bound-gist') && method === 'PATCH') return response(500, {});
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      () => idbTagStore.syncPush(),
      (e: unknown) => e instanceof Error && e.message === GIST_PUSH_FAILED,
    );
    assert.deepEqual(snapshotDirty(), { names: ['owner/repo'], meta: true });
  });

  it('push only clears the dirty versions included in the uploaded snapshot', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    await idbTagStore.setTags('owner/repo', ['alpha']);
    const patched = { payload: null as GistPayload | null };

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/gists/bound-gist') && method === 'GET') return response(200, {});
      if (url.endsWith('/gists/bound-gist') && method === 'PATCH') {
        patched.payload = parsePatchedPayload(init);
        await idbTagStore.setNotes('owner/repo', 'changed while patch was in flight');
        return response(200, {});
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const result = await idbTagStore.syncPush();
    assert.equal(result.pushed, 1);
    assert.equal(patched.payload?.tags['owner/repo']?.notes, '');
    assert.deepEqual(snapshotDirty(), { names: ['owner/repo'], meta: false });
  });

  it('push only clears tag meta when the uploaded meta version is still current', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    await idbTagStore.upsertMeta({ name: 'alpha', color: '#ff0000', dimension: null, excluded: false, mtime: '2026-06-24T12:00:00.000Z' });
    const patched = { payload: null as GistPayload | null };

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/gists/bound-gist') && method === 'GET') return response(200, {});
      if (url.endsWith('/gists/bound-gist') && method === 'PATCH') {
        patched.payload = parsePatchedPayload(init);
        await idbTagStore.upsertMeta({ name: 'alpha', color: '#00ff00', dimension: null, excluded: false, mtime: '2026-06-24T12:01:00.000Z' });
        return response(200, {});
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const result = await idbTagStore.syncPush();
    assert.equal(result.pushed, 1);
    assert.equal(patched.payload?.tagMeta.alpha.color, '#ff0000');
    assert.deepEqual(snapshotDirty(), { names: [], meta: true });
  });

  it('derives dirty meta state from the pushed snapshot instead of caller flags', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    await idbTagStore.upsertMeta({ name: 'alpha', color: '#ff0000', dimension: null, excluded: false, mtime: '2026-06-24T12:00:00.000Z' });
    const dirtySnapshot = snapshotDirtyForPush();

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/gists/bound-gist') && method === 'GET') return response(200, {});
      if (url.endsWith('/gists/bound-gist') && method === 'PATCH') {
        const payload = parsePatchedPayload(init);
        assert.equal(payload.tagMeta.alpha.color, '#ff0000');
        return response(200, {});
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const result = await gistTagStore.push(dirtySnapshot);
    assert.equal(result.pushed, 1);
    assert.deepEqual(snapshotDirty(), { names: [], meta: false });
  });

  it('pull imports v1 tags as manual tags', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    const payload: GistPayload = {
      v: 1,
      exportedAt: '2026-06-24T12:00:00.000Z',
      tags: {
        'owner/v1': {
          tags: ['legacy'],
          notes: 'v1',
          mtime: '2026-06-24T12:00:00.000Z',
        },
      },
      tagMeta: {},
    };

    globalThis.fetch = gistGet(payload);

    const result = await gistTagStore.pull();
    assert.deepEqual(result, { merged: 1, total: 1, missing: false });
    assert.deepEqual((await db.tags.get('owner/v1'))?.manualTags, ['legacy']);
    assert.deepEqual((await db.tags.get('owner/v1'))?.autoTags, []);
    assert.deepEqual((await db.tags.get('owner/v1'))?.dismissedAutoTags, []);
  });

  it('pull imports v2 explicit layers as source of truth', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    const payload: GistPayload = {
      v: 2,
      exportedAt: '2026-06-24T12:00:00.000Z',
      tags: {
        'owner/v2': {
          manualTags: [],
          autoTags: ['auto'],
          dismissedAutoTags: ['dismissed'],
          manualTagsMtime: '2026-06-24T12:00:00.000Z',
          autoTagsMtime: '2026-06-24T12:00:00.000Z',
          dismissedAutoTagsMtime: '2026-06-24T12:00:00.000Z',
          notes: 'v2',
          mtime: '2026-06-24T12:00:00.000Z',
        },
      },
      tagMeta: {},
    };

    globalThis.fetch = gistGet(payload);

    const result = await gistTagStore.pull();
    assert.deepEqual(result, { merged: 1, total: 1, missing: false });
    assert.deepEqual((await db.tags.get('owner/v2'))?.manualTags, []);
    assert.deepEqual((await db.tags.get('owner/v2'))?.autoTags, ['auto']);
    assert.deepEqual((await db.tags.get('owner/v2'))?.dismissedAutoTags, ['dismissed']);
  });

  it('pull ignores v2 rows that only contain the released v1 tags shape', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    const payload = {
      v: 2,
      exportedAt: '2026-06-24T12:00:00.000Z',
      tags: {
        'owner/partial': {
          tags: ['legacy-fallback-should-not-import'],
          notes: 'partial',
          mtime: '2026-06-24T12:00:00.000Z',
        },
      },
      tagMeta: {},
    };

    globalThis.fetch = gistGet(payload);

    const result = await gistTagStore.pull();
    assert.deepEqual(result, { merged: 0, total: 1, missing: false });
    assert.equal(await db.tags.get('owner/partial'), undefined);
  });

  it('pull ignores v2 rows missing layer mtimes', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    const payload = {
      v: 2,
      exportedAt: '2026-06-24T12:00:00.000Z',
      tags: {
        'owner/no-layer-mtime': {
          manualTags: ['manual'],
          autoTags: ['auto'],
          dismissedAutoTags: [],
          notes: 'missing layer mtimes',
          mtime: '2026-06-24T12:00:00.000Z',
        },
      },
      tagMeta: {},
    };

    globalThis.fetch = gistGet(payload);

    const result = await gistTagStore.pull();
    assert.deepEqual(result, { merged: 0, total: 1, missing: false });
    assert.equal(await db.tags.get('owner/no-layer-mtime'), undefined);
  });

  it('pull merges tag layers independently so remote auto changes do not overwrite newer local manual tags', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    await db.tags.put({
      full_name: 'owner/layered',
      manualTags: ['local-manual'],
      autoTags: ['old-auto'],
      dismissedAutoTags: [],
      manualTagsMtime: '2026-06-24T12:10:00.000Z',
      autoTagsMtime: '2026-06-24T12:00:00.000Z',
      dismissedAutoTagsMtime: '2026-06-24T12:00:00.000Z',
      notes: 'same-note',
      favorite: false,
      mtime: '2026-06-24T12:10:00.000Z',
    });
    const payload: GistPayload = {
      v: 2,
      exportedAt: '2026-06-24T12:20:00.000Z',
      tags: {
        'owner/layered': {
          manualTags: ['stale-manual'],
          autoTags: ['new-auto'],
          dismissedAutoTags: [],
          manualTagsMtime: '2026-06-24T12:00:00.000Z',
          autoTagsMtime: '2026-06-24T12:20:00.000Z',
          dismissedAutoTagsMtime: '2026-06-24T12:00:00.000Z',
          notes: 'same-note',
          favorite: false,
          mtime: '2026-06-24T12:20:00.000Z',
        },
      },
      tagMeta: {},
    };

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/gists/bound-gist') && method === 'GET') {
        return response(200, {
          files: {
            'better-github-stars-manager-tags.json': {
              content: JSON.stringify(payload),
            },
          },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const result = await gistTagStore.pull();
    assert.deepEqual(result, { merged: 1, total: 1, missing: false });
    const layered = await db.tags.get('owner/layered');
    assert.deepEqual(layered?.manualTags, ['local-manual']);
    assert.deepEqual(layered?.autoTags, ['new-auto']);
    assert.deepEqual(layered?.manualTagsMtime, '2026-06-24T12:10:00.000Z');
    assert.deepEqual(layered?.autoTagsMtime, '2026-06-24T12:20:00.000Z');
  });
});
