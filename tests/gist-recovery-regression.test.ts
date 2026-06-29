import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';

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

const { authStore } = await import('../src/auth/auth-store');
const { gistTagStore } = await import('../src/sync/gist-tag-store');
const { db } = await import('../src/storage/db');

async function resetState() {
  await db.delete();
  await db.open();
  await authStore.clearToken();
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
});
