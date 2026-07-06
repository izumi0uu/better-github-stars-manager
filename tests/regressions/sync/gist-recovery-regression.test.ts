import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';
import { GIST_PUSH_FAILED } from '../../../src/api/errors';
import type { GistPayload } from '../../../src/types';

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

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
      tags: ['alpha'],
      notes: 'hello',
      mtime: '2026-06-24T12:00:00.000Z',
    });
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
        if (calls.length === 3) return response(201, { id: 'probe-gist' });
        return response(201, { id: 'fresh-gist' });
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
        ) as { tags: Record<string, { tags: string[]; notes: string }> };
        assert.deepEqual(payload.tags['owner/repo'], {
          tags: ['alpha'],
          notes: 'hello',
          mtime: '2026-06-24T12:00:00.000Z',
        });
        return response(200, {});
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await authStore.setToken('github_pat_test');
    await authStore.update({ gistId: 'dead-gist' });

    const result = await gistTagStore.push(new Set(), false);
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
      tags: ['alpha'],
      notes: 'hello',
      mtime: '2026-06-24T12:00:00.000Z',
    });
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
        if (calls.length === 3) return response(201, { id: 'probe-gist' });
        return response(201, { id: 'fresh-gist' });
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

    const result = await gistTagStore.push(new Set(), false);
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

    const result = await gistTagStore.push(new Set(), false, undefined, dirtySnapshot);
    assert.equal(result.pushed, 1);
    assert.deepEqual(snapshotDirty(), { names: [], meta: false });
  });

  it('legacy direct push clears only the dirty names passed by the caller', async () => {
    await resetState();
    await storeSyntheticToken();
    await authStore.update({ gistId: 'bound-gist' });
    await idbTagStore.setTags('owner/repo-a', ['alpha']);
    await idbTagStore.setTags('owner/repo-b', ['beta']);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/gists/bound-gist') && method === 'GET') return response(200, {});
      if (url.endsWith('/gists/bound-gist') && method === 'PATCH') return response(200, {});
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const result = await gistTagStore.push(new Set(['owner/repo-a']), false);
    assert.equal(result.pushed, 1);
    assert.deepEqual(snapshotDirty(), { names: ['owner/repo-b'], meta: false });
  });
});
