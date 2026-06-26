import assert from 'node:assert/strict';
import {
  TOKEN_GIST_CLEANUP_STATUS,
  TOKEN_PROFILE_STATUS,
  TOKEN_STARS_STATUS,
  translateError,
} from '../src/api/errors';
import { probeTokenCapabilities } from '../src/auth/token-probe';
import { mergeStatusPatch, mergeStatusSnapshot, type SyncStatus } from '../src/utils/messaging';

const pass: string[] = [];
const fail: string[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  Promise.resolve(fn())
    .then(() => {
      pass.push(name);
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      fail.push(name);
      console.log(`  ✗ ${name}\n    ${(e as Error).message}`);
    });
}

function response(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

function createChromeMock() {
  const state: Record<string, unknown> = {};
  const listeners = new Set<(changes: Record<string, { oldValue: unknown; newValue: unknown }>, areaName: string) => void>();
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
const { authStore } = await import('../src/auth/auth-store');

console.log('Status/token regressions:');

test('mergeStatusPatch updates seenTooltips without dropping live progress', () => {
  const current: SyncStatus = {
    progress: { phase: 'gist', done: 2, total: 5, message: 'Uploading…' },
    hasToken: true,
    seenOnboarding: false,
    seenTooltips: 0,
    inFlight: true,
  };
  const next = mergeStatusPatch(current, { seenTooltips: 2 });
  assert.equal(next.seenTooltips, 2);
  assert.deepEqual(next.progress, current.progress);
  assert.equal(next.hasToken, true);
  assert.equal(next.inFlight, true);
});

test('mergeStatusSnapshot keeps live progress when a restored snapshot is idle', () => {
  const current: SyncStatus = {
    progress: { phase: 'full', done: 8, total: 20, message: 'Fetching…' },
    hasToken: true,
    seenOnboarding: true,
    seenTooltips: 3,
    inFlight: true,
  };
  const snapshot: SyncStatus = {
    progress: { phase: 'idle', done: 0, total: null, message: 'Last sync done' },
    hasToken: true,
    seenOnboarding: true,
    seenTooltips: 3,
    inFlight: false,
  };
  const merged = mergeStatusSnapshot(current, snapshot);
  assert.ok(merged);
  assert.deepEqual(merged!.progress, current.progress);
  assert.equal(merged!.inFlight, true);
});

test('translateError keeps split token-probe codes distinct', () => {
  const messages = fakeMessages();
  assert.equal(translateError(new Error(`${TOKEN_PROFILE_STATUS}502`), messages as never), 'profile:502');
  assert.equal(translateError(new Error(`${TOKEN_STARS_STATUS}503`), messages as never), 'stars:503');
  assert.equal(translateError(new Error(`${TOKEN_GIST_CLEANUP_STATUS}500`), messages as never), 'gist-cleanup:500');
});

test('probeTokenCapabilities rejects when probe-gist cleanup fails', async () => {
  const calls: string[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (calls.length === 1) {
      return response(200, { login: 'idah', avatar_url: null, name: 'Idah' }, { 'x-oauth-scopes': '' });
    }
    if (calls.length === 2) return response(200, []);
    if (calls.length === 3) return response(201, { id: 'probe-1' });
    if (calls.length === 4) return response(500);
    throw new Error(`unexpected fetch call ${calls.length}: ${method} ${url}`);
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

test('authStore.setToken does not persist anything when probe cleanup fails', async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (url.endsWith('/user') && method === 'GET') {
      return response(200, { login: 'idah', avatar_url: 'https://example.com/a.png', name: 'Idah' }, { 'x-oauth-scopes': '' });
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

test('authStore normalizes new behavior defaults for legacy configs', async () => {
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
  assert.equal(cfg.starsPanelDefaultEnabled, true);
});

await new Promise((resolve) => setTimeout(resolve, 100));
globalThis.fetch = originalFetch;

console.log(fail.length ? `\n❌ ${fail.length} FAILED` : '\n✅ All status/token regression tests passed');
process.exit(fail.length ? 1 : 0);
