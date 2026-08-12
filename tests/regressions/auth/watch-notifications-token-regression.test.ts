import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { createChromeMock, response } from '../../helpers/chrome-mock';
import {
  TOKEN_GISTS_FORBIDDEN,
  TOKEN_WATCHING_FORBIDDEN,
  TOKEN_WATCHING_NETWORK,
} from '@/api/errors';

const chromeMock = createChromeMock();
Object.defineProperty(globalThis, 'chrome', { value: chromeMock.api, configurable: true });
const originalFetch = globalThis.fetch;
const {
  authStore,
  CONFIG_STORAGE_KEY,
  GITHUB_CREDENTIALS_STORAGE_KEY,
} = await import('@/auth/auth-store');

type ProbeMode = 'ok' | 'forbidden' | 'network';

function classicPatFetch(input: {
  login?: string;
  notifications?: ProbeMode;
  gists?: ProbeMode;
  onRequest?: (url: string, token: string, method: string) => void;
} = {}): typeof fetch {
  const login = input.login ?? 'idah';
  return (async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request);
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string> | undefined;
    const token = headers?.Authorization?.replace(/^Bearer /u, '') ?? '';
    input.onRequest?.(url, token, method);
    if (url.endsWith('/user') && method === 'GET') {
      return response(200, { login, avatar_url: null, name: login }, {
        'x-oauth-scopes': 'repo, gist, notifications',
      });
    }
    if (url.includes('/user/starred') && method === 'GET') return response(200, []);
    if (url.endsWith('/gists') && method === 'POST') {
      if (input.gists === 'forbidden') return response(403, { message: 'denied' });
      if (input.gists === 'network') throw new Error('network down');
      return response(201, { id: 'probe-id' });
    }
    if (url.endsWith('/gists/probe-id') && method === 'DELETE') return response(204);
    if (url.includes('/notifications?all=true&per_page=1') && method === 'GET') {
      if (input.notifications === 'forbidden') return response(403, { message: 'denied' });
      if (input.notifications === 'network') throw new Error('network down');
      return response(200, []);
    }
    throw new Error(`unexpected Classic-PAT fetch: ${method} ${url}`);
  }) as typeof fetch;
}

beforeEach(async () => {
  await chromeMock.api.storage.local.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('single Classic PAT credential contract', () => {
  it('persists one encrypted credential and routes Stars and Notifications through it', async () => {
    const requests: Array<{ url: string; token: string; method: string }> = [];
    globalThis.fetch = classicPatFetch({
      onRequest: (url, token, method) => requests.push({ url, token, method }),
    });

    const result = await authStore.setToken('ghp_single');
    const config = await authStore.getConfig();
    const snapshot = await authStore.getGitHubCredentialSnapshot();

    assert.equal(result.username, 'idah');
    assert.deepEqual(result.notifications, { available: true });
    assert.equal(config.githubCredentialStatus, 'ready');
    assert.equal(config.watchNotificationsEnabled, true);
    assert.equal(snapshot.mainToken, 'ghp_single');
    assert.equal(snapshot.notificationsToken, 'ghp_single');
    assert.equal(snapshot.notificationsConfigured, true);
    assert.equal(snapshot.mainIdentity.includes('ghp_single'), false);
    assert.equal(snapshot.notificationsIdentity.includes('ghp_single'), false);
    assert.deepEqual(requests.map(({ url, method }) => `${method} ${url}`), [
      'GET https://api.github.com/user',
      'GET https://api.github.com/user/starred?per_page=1&page=1',
      'POST https://api.github.com/gists',
      'DELETE https://api.github.com/gists/probe-id',
      'GET https://api.github.com/notifications?all=true&per_page=1',
    ]);
  });

  it('saves required Stars/Gist access while disabling optional Watch when Notifications is forbidden', async () => {
    globalThis.fetch = classicPatFetch({ notifications: 'forbidden' });

    const result = await authStore.setToken('ghp_without_notifications');
    const config = await authStore.getConfig();
    const snapshot = await authStore.getGitHubCredentialSnapshot();

    assert.deepEqual(result.notifications, {
      available: false,
      errorCode: TOKEN_WATCHING_FORBIDDEN,
    });
    assert.equal(config.githubCredentialStatus, 'ready');
    assert.equal(config.watchNotificationsEnabled, false);
    assert.equal(snapshot.mainToken, 'ghp_without_notifications');
    assert.equal(snapshot.notificationsToken, null);
    assert.equal(snapshot.notificationsConfigured, false);
  });

  it('does not replace an existing credential when a required capability fails', async () => {
    globalThis.fetch = classicPatFetch();
    await authStore.setToken('ghp_existing');
    const before = await authStore.getConfig();

    globalThis.fetch = classicPatFetch({ gists: 'forbidden' });
    await assert.rejects(
      () => authStore.setToken('ghp_invalid_replacement'),
      (error: unknown) => error instanceof Error && error.message === TOKEN_GISTS_FORBIDDEN,
    );

    const after = await authStore.getConfig();
    assert.equal(after.tokenEncrypted, before.tokenEncrypted);
    assert.deepEqual(after.tokenCryptoMeta, before.tokenCryptoMeta);
    assert.equal(await authStore.getToken(), 'ghp_existing');
  });

  it('marks legacy credentials for reauthorization without exposing them to callers', async () => {
    globalThis.fetch = classicPatFetch();
    await authStore.setToken('ghp_legacy');
    const stored = await chromeMock.api.storage.local.get([
      CONFIG_STORAGE_KEY,
      GITHUB_CREDENTIALS_STORAGE_KEY,
    ]);
    const legacyConfig = { ...(stored[CONFIG_STORAGE_KEY] as Record<string, unknown>) };
    const legacyCredentials = { ...(stored[GITHUB_CREDENTIALS_STORAGE_KEY] as Record<string, unknown>) };
    delete legacyConfig.githubCredentialStatus;
    delete legacyCredentials.githubCredentialStatus;
    await chromeMock.api.storage.local.set({
      [CONFIG_STORAGE_KEY]: legacyConfig,
      [GITHUB_CREDENTIALS_STORAGE_KEY]: legacyCredentials,
    });

    const config = await authStore.getConfig();
    const snapshot = await authStore.getGitHubCredentialSnapshot();
    assert.equal(config.githubCredentialStatus, 'reauthorization_required');
    assert.equal(config.tokenEncrypted, legacyCredentials.tokenEncrypted);
    assert.equal(await authStore.hasToken(), false);
    assert.equal(await authStore.getToken(), null);
    assert.equal(snapshot.mainToken, null);
    assert.equal(snapshot.notificationsToken, null);
  });

  it('retains the main credential when Watch is explicitly disabled', async () => {
    globalThis.fetch = classicPatFetch();
    await authStore.setToken('ghp_watch_disable');
    const before = await authStore.getConfig();

    await authStore.clearWatchNotificationsToken();
    const after = await authStore.getConfig();
    const snapshot = await authStore.getGitHubCredentialSnapshot();

    assert.equal(after.tokenEncrypted, before.tokenEncrypted);
    assert.deepEqual(after.tokenCryptoMeta, before.tokenCryptoMeta);
    assert.equal(after.watchNotificationsEnabled, false);
    assert.equal(await authStore.getToken(), 'ghp_watch_disable');
    assert.equal(snapshot.notificationsToken, null);
  });

  it('treats an optional Notifications network failure as unverified, not a required-token rejection', async () => {
    globalThis.fetch = classicPatFetch({ notifications: 'network' });
    const result = await authStore.setToken('ghp_network');

    assert.deepEqual(result.notifications, {
      available: false,
      errorCode: TOKEN_WATCHING_NETWORK,
    });
    assert.equal(await authStore.hasToken(), true);
    assert.equal((await authStore.getConfig()).watchNotificationsEnabled, false);
  });
});
