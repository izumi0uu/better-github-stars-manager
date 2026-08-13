import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';
import type { Config } from '@/types';
import { createChromeMock, response } from '../../helpers/chrome-mock';

let chromeMock: ReturnType<typeof createChromeMock>;
let originalFetch: typeof fetch;

function classicPatFetch(login: string, probeId: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/user') && method === 'GET') {
      return response(200, { login, avatar_url: null, name: login }, { 'x-oauth-scopes': 'repo,gist,notifications' });
    }
    if (url.includes('/user/starred') && method === 'GET') return response(200, []);
    if (url.endsWith('/gists') && method === 'POST') return response(201, { id: probeId });
    if (url.endsWith(`/gists/${probeId}`) && method === 'DELETE') return response(204);
    if (url.includes('/notifications?all=true&per_page=1') && method === 'GET') return response(200, []);
    throw new Error(`unexpected credential fetch: ${method} ${url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  chromeMock = createChromeMock();
  Object.defineProperty(globalThis, 'chrome', { value: chromeMock.api, configurable: true });
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GitHub credential context isolation', () => {
  it('publishes the single Classic PAT across auth contexts', async () => {
    const first = await import('@/auth/auth-store');
    globalThis.fetch = classicPatFetch('octocat', 'probe-context-main');
    await first.authStore.setToken('github_pat_context_main');

    const second = await import('@/auth/auth-store');
    const snapshot = await second.authStore.getGitHubCredentialSnapshot();
    assert.equal(snapshot.accountLogin, 'octocat');
    assert.equal(snapshot.mainToken, 'github_pat_context_main');
    assert.equal(snapshot.notificationsToken, 'github_pat_context_main');
    assert.equal(snapshot.notificationsConfigured, true);
  });

  it('clears both main and optional Watch capability on logout', async () => {
    const { authStore } = await import('@/auth/auth-store');
    globalThis.fetch = classicPatFetch('octocat', 'probe-context-clear');
    await authStore.setToken('github_pat_context_clear');
    await authStore.clearToken();

    const config = await authStore.getConfig();
    const snapshot = await authStore.getGitHubCredentialSnapshot();
    assert.equal(config.username, null);
    assert.equal(config.tokenEncrypted, null);
    assert.equal((config as Config).watchNotificationsEnabled, false);
    assert.equal(snapshot.mainToken, null);
    assert.equal(snapshot.notificationsToken, null);
  });

  it('does not expose a credential while a legacy record needs reauthorization', async () => {
    const { authStore, CONFIG_STORAGE_KEY, GITHUB_CREDENTIALS_STORAGE_KEY } = await import('@/auth/auth-store');
    globalThis.fetch = classicPatFetch('octocat', 'probe-context-legacy');
    await authStore.setToken('github_pat_context_legacy');
    const stored = await chromeMock.api.storage.local.get([CONFIG_STORAGE_KEY, GITHUB_CREDENTIALS_STORAGE_KEY]);
    const config = { ...(stored[CONFIG_STORAGE_KEY] as Record<string, unknown>) };
    const credentials = { ...(stored[GITHUB_CREDENTIALS_STORAGE_KEY] as Record<string, unknown>) };
    delete config.githubCredentialStatus;
    delete credentials.githubCredentialStatus;
    await chromeMock.api.storage.local.set({
      [CONFIG_STORAGE_KEY]: config,
      [GITHUB_CREDENTIALS_STORAGE_KEY]: credentials,
    });

    assert.equal((await authStore.getConfig()).githubCredentialStatus, 'reauthorization_required');
    assert.equal(await authStore.hasToken(), false);
    assert.equal(await authStore.getToken(), null);
  });
});
