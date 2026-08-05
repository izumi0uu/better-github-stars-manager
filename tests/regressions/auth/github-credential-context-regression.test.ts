import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createChromeMock, response } from '../../helpers/chrome-mock';

let chromeMock: ReturnType<typeof createChromeMock>;
let originalFetch: typeof fetch;
let originalNavigator: unknown;

function mainTokenFetch(login: string, probeId: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/user') && method === 'GET') {
      return response(200, { login, avatar_url: null, name: login }, { 'x-oauth-scopes': '' });
    }
    if (url.includes('/user/starred') && method === 'GET') return response(200, []);
    if (url.endsWith('/gists') && method === 'POST') return response(201, { id: probeId });
    if (url.endsWith(`/gists/${probeId}`) && method === 'DELETE') return response(204);
    if (url.includes('/user/subscriptions') && method === 'GET') return response(200, []);
    throw new Error(`unexpected credential fetch: ${method} ${url}`);
  }) as typeof fetch;
}

function lockManager() {
  let tail: Promise<void> = Promise.resolve();
  return {
    request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
      const result = tail.then(callback, callback);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

function delayedFirstLockResult() {
  let tail: Promise<void> = Promise.resolve();
  let requestCount = 0;
  let markFirstOperationFinished!: () => void;
  let releaseFirstResult!: () => void;
  const firstOperationFinished = new Promise<void>((resolve) => {
    markFirstOperationFinished = resolve;
  });
  const firstResultGate = new Promise<void>((resolve) => {
    releaseFirstResult = resolve;
  });
  return {
    manager: {
      request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
        const operation = tail.then(callback, callback);
        tail = operation.then(() => undefined, () => undefined);
        requestCount++;
        if (requestCount !== 1) return operation;
        return operation.then(
          async (value) => {
            markFirstOperationFinished();
            await firstResultGate;
            return value;
          },
          async (error: unknown) => {
            markFirstOperationFinished();
            await firstResultGate;
            throw error;
          },
        );
      },
    },
    firstOperationFinished,
    releaseFirstResult,
  };
}

async function loadAuthStores() {
  vi.resetModules();
  const first = await import('@/auth/auth-store');
  vi.resetModules();
  const second = await import('@/auth/auth-store');
  return { first, second };
}

beforeEach(() => {
  chromeMock = createChromeMock();
  Object.defineProperty(globalThis, 'chrome', {
    value: chromeMock.api,
    configurable: true,
  });
  originalFetch = globalThis.fetch;
  originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { locks: lockManager() },
    configurable: true,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
  });
});

describe('GitHub credential context isolation', () => {
  it('publishes plaintext cache changes before releasing the shared credential lock', async () => {
    const delayedLock = delayedFirstLockResult();
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks: delayedLock.manager },
      configurable: true,
    });
    const { first, second } = await loadAuthStores();
    globalThis.fetch = mainTokenFetch('idah', 'probe-context-cache-order');

    const setToken = first.authStore.setToken('github_pat_context_cache_order');
    await delayedLock.firstOperationFinished;
    await second.authStore.clearToken();
    delayedLock.releaseFirstResult();
    await setToken;

    const current = await first.authStore.getConfig();
    assert.equal(current.tokenEncrypted, null);
    assert.equal(current.onboardingStage, 'needs_token');
  });

  it('keeps the authoritative credential record after a stale settings write', async () => {
    const { first, second } = await loadAuthStores();
    globalThis.fetch = mainTokenFetch('idah', 'probe-context-main');
    await first.authStore.setToken('github_pat_context_main');

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/user')) return response(200, { login: 'idah' });
      if (url.includes('/notifications?all=true&per_page=1')) return response(200, []);
      throw new Error(`unexpected Notifications fetch: ${url}`);
    }) as typeof fetch;
    await first.authStore.setWatchNotificationsToken('ghp_context_watch');

    const stale = await chromeMock.api.storage.local.get('gsm_config');
    await second.authStore.clearToken();
    await chromeMock.api.storage.local.set({
      gsm_config: {
        ...(stale.gsm_config as Record<string, unknown>),
        theme: 'light',
      },
    });

    const current = await first.authStore.getConfig();
    assert.equal(current.username, null);
    assert.equal(current.tokenEncrypted, null);
    assert.equal(current.watchNotificationsTokenEncrypted, null);
    assert.equal(await first.authStore.getToken(), null);
    assert.equal(await first.authStore.getWatchNotificationsToken(), null);
    assert.equal(await second.authStore.getToken(), null);
    assert.equal(await second.authStore.getWatchNotificationsToken(), null);
  });

  it('does not publish a decrypted token when the credential record changes mid-read', async () => {
    const { first, second } = await loadAuthStores();
    globalThis.fetch = mainTokenFetch('idah', 'probe-context-late-read');
    await first.authStore.setToken('github_pat_late_read');

    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let releaseDecrypt!: () => void;
    let decryptStarted!: () => void;
    const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
    const decryptReady = new Promise<void>((resolve) => { decryptStarted = resolve; });
    let delayed = true;
    crypto.subtle.decrypt = (async (...args: Parameters<SubtleCrypto['decrypt']>) => {
      if (delayed) {
        delayed = false;
        decryptStarted();
        await decryptGate;
      }
      return originalDecrypt(...args);
    }) as SubtleCrypto['decrypt'];

    try {
      const pending = second.authStore.getToken();
      await decryptReady;
      const stored = await chromeMock.api.storage.local.get('gsm_github_credentials_v1');
      await chromeMock.api.storage.local.set({
        gsm_github_credentials_v1: {
          ...(stored.gsm_github_credentials_v1 as Record<string, unknown>),
          tokenEncrypted: null,
          tokenCryptoMeta: null,
          watchNotificationsTokenEncrypted: null,
          watchNotificationsTokenCryptoMeta: null,
          username: null,
          avatarUrl: null,
          displayName: null,
        },
      });
      releaseDecrypt();
      assert.equal(await pending, null);
      assert.equal(await second.authStore.getToken(), null);
    } finally {
      crypto.subtle.decrypt = originalDecrypt as SubtleCrypto['decrypt'];
    }
  });
});
