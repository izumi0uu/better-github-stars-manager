import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';
import { createChromeMock, response } from '../../helpers/chrome-mock';
import {
  TOKEN_EMPTY,
  TOKEN_GIST_CLEANUP_STATUS,
  TOKEN_PROFILE_STATUS,
  TOKEN_STARS_STATUS,
  TOKEN_WATCHING_NETWORK,
  translateError,
} from '../../../src/api/errors';
import { probeTokenCapabilities } from '../../../src/auth/token-probe';
import { mergeStatusPatch, mergeStatusSnapshot, type SyncStatus } from '../../../src/utils/messaging';

function fakeMessages() {
  return {
    errors: {
      tokenEmpty: 'token-empty',
      tokenRejected: 'token-rejected',
      tokenStarsForbidden: 'token-stars-forbidden',
      tokenGistsForbidden: 'token-gists-forbidden',
      tokenProfileStatus: (status: number | string) => `profile:${status}`,
      tokenProfileBadShape: 'profile-bad-shape',
      tokenProfileNetwork: 'profile-network',
      tokenStarsStatus: (status: number | string) => `stars:${status}`,
      tokenStarsNetwork: 'stars-network',
      tokenGistsStatus: (status: number | string) => `gists:${status}`,
      tokenGistsNetwork: 'gists-network',
      tokenGistProbeBadShape: 'gist-probe-bad-shape',
      tokenGistCleanupStatus: (status: number | string) => `gist-cleanup:${status}`,
      tokenGistCleanupNetwork: 'gist-cleanup-network',
      ghTokenRejected: 'gh-token-rejected',
      ghRateLimit: 'gh-rate-limit',
      ghForbidden: 'gh-forbidden',
      ghTimeout: (page: number) => `gh-timeout:${page}`,
      ghNetwork: (detail: string) => `gh-network:${detail}`,
      ghPageStatus: (status: number | string) => `gh-page-status:${status}`,
      ghNoToken: 'gh-no-token',
      ghBadShape: 'gh-bad-shape',
      gistNoToken: 'gist-no-token',
      gistCreateFailed: 'gist-create-failed',
      gistPushFailed: 'gist-push-failed',
      gistPullFailed: 'gist-pull-failed',
      unknown: (raw: string) => `unknown:${raw}`,
    },
  } as const;
}

const chromeMock = createChromeMock();
(globalThis as { chrome?: unknown }).chrome = chromeMock.api;
const originalFetch = globalThis.fetch;
const { authStore, GITHUB_CREDENTIALS_STORAGE_KEY } = await import(
  '../../../src/auth/auth-store'
);

async function storeReadableToken(token: string, probeId: string) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (url.endsWith('/user') && method === 'GET') {
      return response(200, { login: 'octocat', avatar_url: 'https://example.com/a.png', name: 'OctoCat' }, { 'x-oauth-scopes': '' });
    }
    if (url.includes('/user/starred') && method === 'GET') return response(200, []);
    if (url.endsWith('/gists') && method === 'POST') return response(201, { id: probeId });
    if (url.endsWith(`/gists/${probeId}`) && method === 'DELETE') return response(204);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
  await authStore.setToken(token);
  return authStore.getConfig();
}

function successfulProbeFetch(probeId: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (url.endsWith('/user') && method === 'GET') {
      return response(200, { login: 'later', avatar_url: 'https://example.com/later.png', name: 'Later' }, { 'x-oauth-scopes': '' });
    }
    if (url.includes('/user/starred') && method === 'GET') return response(200, []);
    if (url.endsWith('/gists') && method === 'POST') return response(201, { id: probeId });
    if (url.endsWith(`/gists/${probeId}`) && method === 'DELETE') return response(204);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('Status/token regressions', () => {
  it('mergeStatusPatch updates seenTooltips without dropping live progress', () => {
    const current: SyncStatus = {
      progress: { phase: 'gist', done: 2, total: 5, message: 'Uploading…' },
      hasToken: true,
      onboardingStage: 'syncing',
      seenOnboarding: false,
      seenTooltips: 0,
      backfills: {},
      activeBackfillId: null,
      inFlight: true,
    };
    const next = mergeStatusPatch(current, { seenTooltips: 2 });
    assert.equal(next.seenTooltips, 2);
    assert.deepEqual(next.progress, current.progress);
    assert.equal(next.hasToken, true);
    assert.equal(next.inFlight, true);
  });

  it('mergeStatusSnapshot keeps live progress when a restored snapshot is idle', () => {
    const current: SyncStatus = {
      progress: { phase: 'full', done: 8, total: 20, message: 'Fetching…' },
      hasToken: true,
      onboardingStage: 'syncing',
      seenOnboarding: true,
      seenTooltips: 3,
      backfills: {},
      activeBackfillId: null,
      inFlight: true,
    };
    const snapshot: SyncStatus = {
      progress: { phase: 'idle', done: 0, total: null, message: 'Last sync done' },
      hasToken: true,
      onboardingStage: 'coach',
      seenOnboarding: true,
      seenTooltips: 3,
      backfills: {},
      activeBackfillId: null,
      inFlight: false,
    };
    const merged = mergeStatusSnapshot(current, snapshot);
    assert.ok(merged);
    assert.deepEqual(merged!.progress, current.progress);
    assert.equal(merged!.inFlight, true);
  });

  it('translateError keeps split token-probe codes distinct', () => {
    const messages = fakeMessages();
    assert.equal(translateError(new Error(`${TOKEN_PROFILE_STATUS}502`), messages as never), 'profile:502');
    assert.equal(translateError(new Error(`${TOKEN_STARS_STATUS}503`), messages as never), 'stars:503');
    assert.equal(translateError(new Error(`${TOKEN_GIST_CLEANUP_STATUS}500`), messages as never), 'gist-cleanup:500');
  });

  it('probeTokenCapabilities rejects when probe-gist cleanup fails', async () => {
    const calls: string[] = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.endsWith('/user') && method === 'GET') {
        return response(200, { login: 'octocat', avatar_url: null, name: 'OctoCat' }, { 'x-oauth-scopes': '' });
      }
      if (url.includes('/user/starred?per_page=1&page=1') && method === 'GET') return response(200, []);
      if (url.endsWith('/gists') && method === 'POST') return response(201, { id: 'probe-1' });
      if (url.endsWith('/gists/probe-1') && method === 'DELETE') return response(500);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      () => probeTokenCapabilities('github_pat_test', fetchMock),
      (e: unknown) => e instanceof Error && e.message === `${TOKEN_GIST_CLEANUP_STATUS}500`,
    );
    assert.deepEqual(calls, [
      'GET https://api.github.com/user',
      'GET https://api.github.com/user/starred?per_page=1&page=1',
      'POST https://api.github.com/gists',
      'DELETE https://api.github.com/gists/probe-1',
    ]);
  });

  it('authStore.setToken does not persist anything when probe cleanup fails', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/user') && method === 'GET') {
        return response(200, { login: 'octocat', avatar_url: 'https://example.com/a.png', name: 'OctoCat' }, { 'x-oauth-scopes': '' });
      }
      if (url.includes('/user/starred') && method === 'GET') return response(200, []);
      if (url.endsWith('/gists') && method === 'POST') return response(201, { id: 'probe-2' });
      if (url.endsWith('/gists/probe-2') && method === 'DELETE') return response(500);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

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

    await assert.rejects(
      () => authStore.setToken('github_pat_test'),
      (e: unknown) => e instanceof Error && e.message === `${TOKEN_GIST_CLEANUP_STATUS}500`,
    );

    const cfg = await authStore.getConfig();
    assert.equal(cfg.tokenEncrypted, null);
    assert.equal(cfg.username, null);
    assert.equal(await authStore.getToken(), null);
  });

  it('persists a valid main token while reporting optional Notifications permission failure', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/user') && method === 'GET') {
        return response(200, { login: 'octocat', avatar_url: null, name: 'OctoCat' }, { 'x-oauth-scopes': '' });
      }
      if (url.includes('/user/starred') && method === 'GET') return response(200, []);
      if (url.endsWith('/gists') && method === 'POST') return response(201, { id: 'notifications-optional' });
      if (url.endsWith('/gists/notifications-optional') && method === 'DELETE') return response(204);
      if (url.includes('/notifications?all=true&per_page=1') && method === 'GET') throw new Error('network down');
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await authStore.clearToken();
    const result = await authStore.setToken('github_pat_without_notifications');

    assert.deepEqual(result.notifications, {
      available: false,
      errorCode: TOKEN_WATCHING_NETWORK,
    });
    const cfg = await authStore.getConfig();
    assert.ok(cfg.tokenEncrypted);
    assert.equal(cfg.username, 'octocat');
    assert.equal(await authStore.getToken(), 'github_pat_without_notifications');
  });

  it('authStore.update keeps the previous cached config when storage write fails', async () => {
    await authStore.update({ theme: 'dark', locale: 'en' });
    chromeMock.rejectNextSet(new Error('storage write failed'));

    await assert.rejects(
      () => authStore.update({ theme: 'light' }),
      /storage write failed/,
    );

    const cfg = await authStore.getConfig();
    assert.equal(cfg.theme, 'dark');
  });

  it('authStore.setToken does not cache plaintext when storage write fails', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/user') && method === 'GET') {
        return response(200, { login: 'octocat', avatar_url: 'https://example.com/a.png', name: 'OctoCat' }, { 'x-oauth-scopes': '' });
      }
      if (url.includes('/user/starred') && method === 'GET') return response(200, []);
      if (url.endsWith('/gists') && method === 'POST') return response(201, { id: 'probe-3' });
      if (url.endsWith('/gists/probe-3') && method === 'DELETE') return response(204);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await authStore.clearToken();
    chromeMock.rejectNextSet(new Error('storage write failed'));

    await assert.rejects(
      () => authStore.setToken('github_pat_storage_failure'),
      /storage write failed/,
    );

    assert.equal(await authStore.getToken(), null);
    const cfg = await authStore.getConfig();
    assert.equal(cfg.tokenEncrypted, null);
    assert.equal(cfg.username, null);
  });

  it('authStore normalizes new behavior defaults for legacy configs', async () => {
    await chromeMock.api.storage.local.set({
      gsm_config: {
        tokenEncrypted: null,
        tokenCryptoMeta: null,
        theme: 'dark',
        locale: 'en',
        defaultView: 'table',
        lastSyncStarredAt: null,
        gistId: null,
        gistSyncCursor: null,
        username: null,
        avatarUrl: null,
        displayName: null,
        onboardingStage: 'needs_token',
        seenOnboarding: false,
        seenTooltips: 0,
        langTagMigrationDone: false,
        lastSyncProgress: { phase: 'idle', done: 0, total: null, message: '' },
      },
    });

    const cfg = await authStore.getConfig();
    assert.equal(cfg.autoTagLimit, 5);
    assert.equal(cfg.maxTagsPerRepo, 5);
    assert.equal(cfg.minTopicRepoCount, 3);
    assert.deepEqual(cfg.libraryView, {
      version: 1,
      filters: {
        languages: [],
        tags: [],
        tagMode: 'any',
        showTombstone: false,
        onlyFavorite: false,
        onlyUntagged: false,
        onlyArchived: false,
        onlyOwned: false,
      },
      sort: {
        sortKey: 'starred_at',
        sortDir: 'desc',
      },
    });
    assert.equal(cfg.starsPanelDefaultEnabled, true);
    assert.equal(cfg.columnLayoutMode, 'default');
    assert.equal(cfg.customColumnLayout, null);
    assert.deepEqual(cfg.backfills, {});
  });

  it('authStore maps legacy autoTagLimit to maxTagsPerRepo when the split field is absent', async () => {
    await chromeMock.api.storage.local.set({
      gsm_config: {
        autoTagLimit: 7,
      },
    });

    const cfg = await authStore.getConfig();
    assert.equal(cfg.autoTagLimit, 7);
    assert.equal(cfg.maxTagsPerRepo, 7);
    assert.equal(cfg.minTopicRepoCount, 3);
  });

  it('authStore normalizes stored column layout preferences', async () => {
    await chromeMock.api.storage.local.set({
      gsm_config: {
        columnLayoutMode: 'custom',
        customColumnLayout: {
          order: ['tags', 'repository', 'unknown', 'tags'],
          hidden: ['favorite', 'description', 'description'],
          widths: {
            repository: 260,
            favorite: 300,
            language: 20,
            tags: Number.NaN,
          },
        },
      },
    });

    const cfg = await authStore.getConfig();
    assert.equal(cfg.columnLayoutMode, 'custom');
    assert.deepEqual(cfg.customColumnLayout, {
      order: ['tags', 'repository', 'description', 'language', 'stars', 'updated', 'created', 'starAction', 'favorite', 'notes'],
      hidden: ['description'],
      widths: {
        repository: 260,
        language: 64,
      },
    });
  });

  it('authStore.setToken keeps existing persisted token when probe cleanup fails', async () => {
    const previousConfig = await storeReadableToken('github_pat_existing_cleanup_guard', 'probe-existing');
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/user') && method === 'GET') {
        return response(200, { login: 'later', avatar_url: 'https://example.com/later.png', name: 'Later' }, { 'x-oauth-scopes': '' });
      }
      if (url.includes('/user/starred') && method === 'GET') return response(200, []);
      if (url.endsWith('/gists') && method === 'POST') return response(201, { id: 'probe-cleanup-blocked' });
      if (url.endsWith('/gists/probe-cleanup-blocked') && method === 'DELETE') return response(500);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      () => authStore.setToken('github_pat_rejected_cleanup_guard'),
      (e: unknown) => e instanceof Error && e.message === `${TOKEN_GIST_CLEANUP_STATUS}500`,
    );

    const cfg = await authStore.getConfig();
    assert.equal(cfg.tokenEncrypted, previousConfig.tokenEncrypted);
    assert.deepEqual(cfg.tokenCryptoMeta, previousConfig.tokenCryptoMeta);
    assert.equal(cfg.username, 'octocat');
    assert.equal(await authStore.getToken(), 'github_pat_existing_cleanup_guard');
  });

  it('authStore.setToken leaves existing plaintext cache unchanged when storage write fails', async () => {
    const previousConfig = await storeReadableToken('github_pat_existing_write_guard', 'probe-write-existing');
    globalThis.fetch = successfulProbeFetch('probe-write-failed');
    chromeMock.rejectNextSet(new Error('storage write failed'));

    await assert.rejects(
      () => authStore.setToken('github_pat_rejected_write_guard'),
      /storage write failed/,
    );

    const cfg = await authStore.getConfig();
    assert.equal(cfg.tokenEncrypted, previousConfig.tokenEncrypted);
    assert.deepEqual(cfg.tokenCryptoMeta, previousConfig.tokenCryptoMeta);
    assert.equal(cfg.username, 'octocat');
    assert.equal(await authStore.getToken(), 'github_pat_existing_write_guard');
  });

  it('authStore.setToken rejects whitespace without fetch, encryption, or storage writes', async () => {
    let fetchCalls = 0;
    let storageWrites = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('whitespace token must not fetch');
    }) as typeof fetch;
    const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let encryptCalls = 0;
    crypto.subtle.encrypt = (async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      encryptCalls += 1;
      return originalEncrypt(...args);
    }) as SubtleCrypto['encrypt'];
    const originalSet = chromeMock.api.storage.local.set;
    chromeMock.api.storage.local.set = (async (...args: Parameters<typeof originalSet>) => {
      storageWrites += 1;
      return originalSet(...args);
    }) as typeof originalSet;

    try {
      await assert.rejects(
        () => authStore.setToken('   \n\t  '),
        (e: unknown) => e instanceof Error && e.message === TOKEN_EMPTY,
      );
    } finally {
      crypto.subtle.encrypt = originalEncrypt as SubtleCrypto['encrypt'];
      chromeMock.api.storage.local.set = originalSet;
    }

    assert.equal(fetchCalls, 0);
    assert.equal(encryptCalls, 0);
    assert.equal(storageWrites, 0);
  });

  it('authStore clears cached plaintext on external token crypto changes only', async () => {
    const persisted = await storeReadableToken('github_pat_cache_invalidation_guard', 'probe-cache-guard');
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let decryptCalls = 0;
    crypto.subtle.decrypt = (async (...args: Parameters<SubtleCrypto['decrypt']>) => {
      decryptCalls += 1;
      return originalDecrypt(...args);
    }) as SubtleCrypto['decrypt'];

    try {
      await chromeMock.api.storage.local.set({
        gsm_config: {
          ...persisted,
          theme: persisted.theme === 'dark' ? 'light' : 'dark',
        },
      });
      assert.equal(await authStore.getToken(), 'github_pat_cache_invalidation_guard');
      assert.equal(decryptCalls, 0);

      assert.ok(persisted.tokenEncrypted);
      const changedCipher = `${persisted.tokenEncrypted[0] === 'A' ? 'B' : 'A'}${persisted.tokenEncrypted.slice(1)}`;
      assert.notEqual(persisted.tokenEncrypted, changedCipher);
      const stored = await chromeMock.api.storage.local.get(GITHUB_CREDENTIALS_STORAGE_KEY);
      await chromeMock.api.storage.local.set({
        [GITHUB_CREDENTIALS_STORAGE_KEY]: {
          ...(stored[GITHUB_CREDENTIALS_STORAGE_KEY] as object),
          tokenEncrypted: changedCipher,
        },
      });
      assert.equal(await authStore.getToken(), null);
      assert.equal(decryptCalls, 1);
    } finally {
      crypto.subtle.decrypt = originalDecrypt as SubtleCrypto['decrypt'];
    }
  });
});
