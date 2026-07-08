import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { Star, Tag, TagMeta } from '../../src/types';
import { authStore } from '../../src/auth/auth-store';
import { githubStarSource } from '../../src/api/github-star-source';
import { db } from '../../src/storage/db';
import '../../src/background/index';

type BackgroundResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

type BackgroundListener = (
  req: unknown,
  sender: unknown,
  sendResponse: (response: BackgroundResponse) => void,
) => boolean;

const chromeHarness = vi.hoisted(() => {
  type StorageListener = (
    changes: Record<string, { oldValue: unknown; newValue: unknown }>,
    areaName: string,
  ) => void;

  const storageState: Record<string, unknown> = {
    gsm_config: { langTagMigrationDone: true },
  };
  const storageListeners = new Set<StorageListener>();
  const messages: unknown[] = [];
  const messageListeners: BackgroundListener[] = [];
  let sendObserver: ((message: unknown) => void) | null = null;

  const api = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: storageState[key] };
        },
        async set(next: Record<string, unknown>) {
          const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};
          for (const [key, value] of Object.entries(next)) {
            changes[key] = { oldValue: storageState[key], newValue: value };
            storageState[key] = value;
          }
          for (const listener of storageListeners) listener(changes, 'local');
        },
        async clear() {
          const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};
          for (const key of Object.keys(storageState)) {
            changes[key] = { oldValue: storageState[key], newValue: undefined };
            delete storageState[key];
          }
          for (const listener of storageListeners) listener(changes, 'local');
        },
      },
      onChanged: {
        addListener(listener: StorageListener) {
          storageListeners.add(listener);
        },
        removeListener(listener: StorageListener) {
          storageListeners.delete(listener);
        },
      },
    },
    runtime: {
      async sendMessage(message: unknown) {
        messages.push(message);
        sendObserver?.(message);
      },
      onMessage: {
        addListener(listener: BackgroundListener) {
          messageListeners.push(listener);
        },
      },
      onInstalled: {
        addListener() {},
      },
    },
  };

  Object.defineProperty(globalThis, 'chrome', { value: api, configurable: true });

  return {
    api,
    messages,
    messageListeners,
    reset() {
      messages.length = 0;
      sendObserver = null;
    },
    setSendObserver(observer: ((message: unknown) => void) | null) {
      sendObserver = observer;
    },
  };
});

function starRow(fullName = 'octo/repo'): Star {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: 'A repository',
    language: 'TypeScript',
    stargazers_count: 42,
    topics: ['testing'],
    pushed_at: '2030-01-02T03:04:05.000Z',
    created_at: '2020-01-02T03:04:05.000Z',
    fork: false,
    archived: false,
    starred_at: '2030-01-01T00:00:00.000Z',
    tombstone: false,
    synced_at: '2030-01-02T03:04:05.000Z',
  };
}

function tagRow(fullName = 'octo/repo'): Tag {
  return {
    full_name: fullName,
    manualTags: ['keeper'],
    autoTags: ['topic'],
    dismissedAutoTags: ['dismissed'],
    manualTagsMtime: '2030-01-01T00:00:00.000Z',
    autoTagsMtime: '2030-01-01T00:00:00.000Z',
    dismissedAutoTagsMtime: '2030-01-01T00:00:00.000Z',
    notes: 'preserve me',
    favorite: true,
    mtime: '2030-01-01T00:00:00.000Z',
  };
}

function tagMetaRow(): TagMeta {
  return {
    name: 'keeper',
    dimension: 'framework',
    color: '#123456',
    mtime: '2030-01-01T00:00:00.000Z',
    excluded: false,
  };
}

async function sendBackground(req: unknown): Promise<BackgroundResponse> {
  const listener = chromeHarness.messageListeners.at(-1);
  assert.ok(listener, 'background onMessage listener should be registered');

  const responses: BackgroundResponse[] = [];
  const keepAlive = listener(req, {}, (response) => responses.push(response));
  assert.equal(keepAlive, true);

  await vi.waitFor(() => assert.equal(responses.length, 1));
  return responses[0];
}

describe('background markUnstarred contract', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    chromeHarness.reset();
    await db.delete();
    await db.open();
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ gsm_config: { langTagMigrationDone: true } });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    chromeHarness.reset();
    await db.delete();
  });

  it('handles markUnstarred as a first-class background request for unknown repos', async () => {
    const unstar = vi.spyOn(githubStarSource, 'unstar').mockResolvedValue(undefined);

    const response = await sendBackground({ type: 'markUnstarred', full_name: 'missing/repo' });

    assert.deepEqual(response, { ok: false, error: 'Unknown repo: missing/repo' });
    assert.equal(unstar.mock.calls.length, 0);
  });

  it('remote-unstars before tombstoning, then broadcasts after the star row is persisted', async () => {
    const fullName = 'octo/repo';
    const events: string[] = [];
    await db.stars.put(starRow(fullName));
    await db.tags.put(tagRow(fullName));
    await db.tagMeta.put(tagMetaRow());

    chromeHarness.setSendObserver((message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'dataChanged') {
        events.push('broadcast');
      }
    });

    vi.spyOn(githubStarSource, 'unstar').mockImplementation(async (requestedFullName) => {
      assert.equal(requestedFullName, fullName);
      events.push('remote-unstar');
    });

    const recordStarsPut = (_modifications: unknown, primKey: string) => {
      if (primKey === fullName) events.push('stars-put');
    };
    db.stars.hook('updating', recordStarsPut);

    let response: BackgroundResponse;
    try {
      response = await sendBackground({ type: 'markUnstarred', full_name: fullName });
    } finally {
      db.stars.hook('updating').unsubscribe(recordStarsPut);
    }

    assert.deepEqual(response, { ok: true, data: { full_name: fullName, tombstone: true } });

    assert.deepEqual(events, ['remote-unstar', 'stars-put', 'broadcast']);
    assert.equal((await db.stars.get(fullName))?.tombstone, true);
    assert.deepEqual(await db.tags.get(fullName), tagRow(fullName));
    assert.deepEqual(await db.tagMeta.get('keeper'), tagMetaRow());
  });

  it('does not tombstone or broadcast when the remote unstar fails', async () => {
    const fullName = 'octo/repo';
    const events: string[] = [];
    await db.stars.put(starRow(fullName));
    await db.tags.put(tagRow(fullName));
    await db.tagMeta.put(tagMetaRow());

    chromeHarness.setSendObserver((message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'dataChanged') {
        events.push('broadcast');
      }
    });

    vi.spyOn(githubStarSource, 'unstar').mockImplementation(async () => {
      events.push('remote-unstar');
      throw new Error('REMOTE_UNSTAR_FAILED');
    });

    const recordStarsPut = (_modifications: unknown, primKey: string) => {
      if (primKey === fullName) events.push('stars-put');
    };
    db.stars.hook('updating', recordStarsPut);

    let response: BackgroundResponse;
    try {
      response = await sendBackground({ type: 'markUnstarred', full_name: fullName });
    } finally {
      db.stars.hook('updating').unsubscribe(recordStarsPut);
    }

    assert.equal(response.ok, false);
    assert.match(response.ok ? '' : response.error, /REMOTE_UNSTAR_FAILED/);
    assert.deepEqual(events, ['remote-unstar']);
    assert.equal((await db.stars.get(fullName))?.tombstone, false);
    assert.deepEqual(await db.tags.get(fullName), tagRow(fullName));
    assert.deepEqual(await db.tagMeta.get('keeper'), tagMetaRow());
  });

  it('queues markUnstarred behind an in-flight sync before applying the tombstone', async () => {
    const fullName = 'octo/repo';
    const events: string[] = [];
    let releaseSync!: () => void;
    const syncMayWrite = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });

    await db.stars.put(starRow(fullName));

    vi.spyOn(authStore, 'hasToken').mockResolvedValue(true);
    vi.spyOn(githubStarSource, 'syncIncremental').mockImplementation(async () => {
      events.push('sync-start');
      await syncMayWrite;
      await db.stars.put({ ...starRow(fullName), tombstone: false, synced_at: '2030-01-03T00:00:00.000Z' });
      events.push('sync-stale-put');
      return { added: 0 };
    });
    const unstar = vi.spyOn(githubStarSource, 'unstar').mockImplementation(async () => {
      events.push('remote-unstar');
    });

    const syncResponse = sendBackground({ type: 'syncIncremental' });
    await vi.waitFor(() => assert.deepEqual(events, ['sync-start']));

    const markResponse = sendBackground({ type: 'markUnstarred', full_name: fullName });
    await Promise.resolve();

    assert.equal(unstar.mock.calls.length, 0);
    assert.deepEqual(events, ['sync-start']);

    releaseSync();

    assert.equal((await syncResponse).ok, true);
    assert.deepEqual(await markResponse, { ok: true, data: { full_name: fullName, tombstone: true } });
    assert.deepEqual(events, ['sync-start', 'sync-stale-put', 'remote-unstar']);
    assert.equal((await db.stars.get(fullName))?.tombstone, true);
  });
});

describe('githubStarSource unstar contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects malformed full names before calling GitHub', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected network request');
    });

    for (const fullName of ['/repo', 'owner/', 'owner/repo/extra']) {
      await assert.rejects(
        () => githubStarSource.unstar(fullName),
        (error: unknown) => error instanceof Error && error.message === `Invalid repository name: ${fullName}`,
      );
    }

    assert.equal(fetchSpy.mock.calls.length, 0);
  });

  it('deletes the authenticated GitHub star resource for the selected repo', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_synthetic');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    });

    await githubStarSource.unstar('octo/repo name');

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.github.com/user/starred/octo/repo%20name');
    assert.equal(requests[0].init?.method, 'DELETE');

    const headers = new Headers(requests[0].init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer github_pat_synthetic');
    assert.equal(headers.get('accept'), 'application/vnd.github+json');
  });

  it('accepts delete 404 only after confirming the repo is accessible', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_synthetic');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: requests.length === 1 ? 404 : 200 });
    });

    await githubStarSource.unstar('octo/repo');

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://api.github.com/user/starred/octo/repo');
    assert.equal(requests[0].init?.method, 'DELETE');
    assert.equal(requests[1].url, 'https://api.github.com/repos/octo/repo');
    assert.equal(requests[1].init?.method, 'GET');
  });

  it('rejects delete 404 when the repo cannot be verified as accessible', async () => {
    vi.spyOn(authStore, 'getToken').mockResolvedValue('github_pat_synthetic');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    await assert.rejects(
      () => githubStarSource.unstar('octo/repo'),
      (error: unknown) => error instanceof Error && error.message === 'GH_PAGE_STATUS:404',
    );
  });
});
