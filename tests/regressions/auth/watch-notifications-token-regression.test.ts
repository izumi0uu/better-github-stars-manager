import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import { createChromeMock, response } from '../../helpers/chrome-mock';
import {
  WATCH_TOKEN_ACCOUNT_CHANGED,
  WATCH_TOKEN_ACCOUNT_MISMATCH,
  WATCH_TOKEN_EMPTY,
  WATCH_TOKEN_NOTIFICATIONS_FORBIDDEN,
} from '@/api/errors';

const chromeMock = createChromeMock();
Object.defineProperty(globalThis, 'chrome', { value: chromeMock.api, configurable: true });
const originalFetch = globalThis.fetch;
const {
  authStore,
  CONFIG_STORAGE_KEY,
  GITHUB_CREDENTIALS_STORAGE_KEY,
} = await import('@/auth/auth-store');

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
    throw new Error(`unexpected main-token fetch: ${method} ${url}`);
  }) as typeof fetch;
}

function watchTokenFetch(input: {
  login: string;
  notificationsStatus?: number;
  onRequest?: (url: string) => void;
}): typeof fetch {
  return (async (request: string | URL | Request) => {
    const url = String(request);
    input.onRequest?.(url);
    if (url.endsWith('/user')) return response(200, { login: input.login });
    if (url.includes('/notifications?all=true&per_page=1')) {
      const status = input.notificationsStatus ?? 200;
      return response(status, status === 200 ? [] : { message: 'denied' });
    }
    throw new Error(`unexpected Watch-token fetch: ${url}`);
  }) as typeof fetch;
}

async function configureMain(login = 'Idah', token = 'github_pat_main'): Promise<void> {
  globalThis.fetch = mainTokenFetch(login, `probe-${login}-${token}`);
  await authStore.setToken(token);
}

async function configureWatch(login = 'idah', token = 'ghp_watch'): Promise<void> {
  globalThis.fetch = watchTokenFetch({ login });
  await authStore.setWatchNotificationsToken(token);
}

beforeEach(async () => {
  await chromeMock.api.storage.local.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('Watch Notifications token lifecycle', () => {
  it('binds a classic token to the main account case-insensitively', async () => {
    await configureMain('Idah');
    await configureWatch('IDAH', 'ghp_notifications');

    const config = await authStore.getConfig();
    assert.ok(config.watchNotificationsTokenEncrypted);
    assert.ok(config.watchNotificationsTokenCryptoMeta);
    assert.equal(await authStore.hasWatchNotificationsToken(), true);
    assert.equal(await authStore.getWatchNotificationsToken(), 'ghp_notifications');
  });

  it('stops before Notifications on account mismatch and preserves the existing token', async () => {
    await configureMain();
    await configureWatch('idah', 'ghp_existing');
    const previous = await authStore.getConfig();
    const calls: string[] = [];
    globalThis.fetch = watchTokenFetch({ login: 'another-user', onRequest: (url) => calls.push(url) });

    await assert.rejects(
      () => authStore.setWatchNotificationsToken('ghp_wrong_account'),
      (error: unknown) => error instanceof Error && error.message === WATCH_TOKEN_ACCOUNT_MISMATCH,
    );

    assert.deepEqual(calls, ['https://api.github.com/user']);
    const current = await authStore.getConfig();
    assert.equal(current.watchNotificationsTokenEncrypted, previous.watchNotificationsTokenEncrypted);
    assert.deepEqual(current.watchNotificationsTokenCryptoMeta, previous.watchNotificationsTokenCryptoMeta);
    assert.equal(await authStore.getWatchNotificationsToken(), 'ghp_existing');
  });

  it('preserves the existing token on permission or storage failure', async () => {
    await configureMain();
    await configureWatch('idah', 'ghp_existing');
    const previous = await authStore.getConfig();

    globalThis.fetch = watchTokenFetch({ login: 'idah', notificationsStatus: 403 });
    await assert.rejects(
      () => authStore.setWatchNotificationsToken('ghp_forbidden'),
      (error: unknown) => error instanceof Error && error.message === WATCH_TOKEN_NOTIFICATIONS_FORBIDDEN,
    );

    globalThis.fetch = watchTokenFetch({ login: 'idah' });
    chromeMock.rejectNextSet(new Error('storage failed'));
    await assert.rejects(
      () => authStore.setWatchNotificationsToken('ghp_write_failure'),
      /storage failed/,
    );

    const current = await authStore.getConfig();
    assert.equal(current.watchNotificationsTokenEncrypted, previous.watchNotificationsTokenEncrypted);
    assert.deepEqual(current.watchNotificationsTokenCryptoMeta, previous.watchNotificationsTokenCryptoMeta);
    assert.equal(await authStore.getWatchNotificationsToken(), 'ghp_existing');
  });

  it('rejects whitespace without network or storage work', async () => {
    let fetchCalls = 0;
    let setCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('must not fetch');
    }) as typeof fetch;
    const originalSet = chromeMock.api.storage.local.set;
    chromeMock.api.storage.local.set = (async (...args: Parameters<typeof originalSet>) => {
      setCalls++;
      return originalSet(...args);
    }) as typeof originalSet;
    try {
      await assert.rejects(
        () => authStore.setWatchNotificationsToken('  \n\t  '),
        (error: unknown) => error instanceof Error && error.message === WATCH_TOKEN_EMPTY,
      );
    } finally {
      chromeMock.api.storage.local.set = originalSet;
    }
    assert.equal(fetchCalls, 0);
    assert.equal(setCalls, 0);
  });

  it('keeps the token for a same-account main PAT replacement and clears it on account change or logout', async () => {
    await configureMain('Idah', 'github_pat_first');
    await configureWatch('idah', 'ghp_existing');

    globalThis.fetch = mainTokenFetch('IDAH', 'probe-same-account');
    await authStore.setToken('github_pat_second');
    assert.equal(await authStore.getWatchNotificationsToken(), 'ghp_existing');

    globalThis.fetch = mainTokenFetch('another-user', 'probe-new-account');
    await authStore.setToken('github_pat_other');
    assert.equal(await authStore.getWatchNotificationsToken(), null);
    assert.equal((await authStore.getConfig()).watchNotificationsTokenEncrypted, null);

    await configureWatch('another-user', 'ghp_other');
    await authStore.clearToken();
    assert.equal(await authStore.getWatchNotificationsToken(), null);
    assert.equal((await authStore.getConfig()).watchNotificationsTokenCryptoMeta, null);
  });

  it('does not let a stale settings write resurrect credentials after logout', async () => {
    await configureMain();
    await configureWatch('idah', 'ghp_existing');
    const before = await chromeMock.api.storage.local.get(CONFIG_STORAGE_KEY);
    const staleConfig = before[CONFIG_STORAGE_KEY] as Record<string, unknown>;

    await authStore.clearToken();
    await chromeMock.api.storage.local.set({
      [CONFIG_STORAGE_KEY]: {
        ...staleConfig,
        theme: staleConfig.theme === 'dark' ? 'light' : 'dark',
      },
    });

    const current = await authStore.getConfig();
    assert.equal(current.username, null);
    assert.equal(current.tokenEncrypted, null);
    assert.equal(current.watchNotificationsTokenEncrypted, null);
    assert.equal(await authStore.getToken(), null);
    assert.equal(await authStore.getWatchNotificationsToken(), null);
  });

  it('normalizes an orphaned classic credential away without a bound main account', async () => {
    await configureMain();
    await configureWatch('idah', 'ghp_existing');

    const stored = await chromeMock.api.storage.local.get(GITHUB_CREDENTIALS_STORAGE_KEY);
    await chromeMock.api.storage.local.set({
      [GITHUB_CREDENTIALS_STORAGE_KEY]: {
        ...(stored[GITHUB_CREDENTIALS_STORAGE_KEY] as object),
        tokenEncrypted: null,
        tokenCryptoMeta: null,
        username: null,
      },
    });

    const normalized = await authStore.getConfig();
    assert.equal(normalized.watchNotificationsTokenEncrypted, null);
    assert.equal(normalized.watchNotificationsTokenCryptoMeta, null);
    assert.equal(await authStore.getWatchNotificationsToken(), null);
  });

  it('serializes concurrent main and Notifications credential replacements', async () => {
    await configureMain('idah', 'github_pat_existing');
    let releaseMainProfile!: () => void;
    const mainProfileGate = new Promise<void>((resolve) => {
      releaseMainProfile = resolve;
    });
    const mainFetch = mainTokenFetch('idah', 'probe-concurrent-main');
    const notificationsFetch = watchTokenFetch({ login: 'idah' });
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const authorization = headers?.Authorization ?? '';
      const url = String(request);
      if (authorization === 'Bearer github_pat_replacement') {
        if (url.endsWith('/user')) await mainProfileGate;
        return mainFetch(request, init);
      }
      if (authorization === 'Bearer ghp_concurrent') {
        return notificationsFetch(request, init);
      }
      throw new Error(`unexpected concurrent credential fetch: ${authorization} ${url}`);
    }) as typeof fetch;

    const mainReplacement = authStore.setToken('github_pat_replacement');
    await Promise.resolve();
    const notificationsReplacement = authStore.setWatchNotificationsToken('ghp_concurrent');
    await Promise.resolve();

    releaseMainProfile();
    await Promise.all([mainReplacement, notificationsReplacement]);

    assert.equal(await authStore.getToken(), 'github_pat_replacement');
    assert.equal(await authStore.getWatchNotificationsToken(), 'ghp_concurrent');
    assert.equal((await authStore.getConfig()).username, 'idah');
  });

  it('cannot publish a probed token after the main credential changes', async () => {
    await configureMain();
    let resolveNotifications!: (response: Response) => void;
    const pendingNotifications = new Promise<Response>((resolve) => {
      resolveNotifications = resolve;
    });
    let markNotificationsStarted!: () => void;
    const notificationsStarted = new Promise<void>((resolve) => {
      markNotificationsStarted = resolve;
    });
    globalThis.fetch = (async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith('/user')) return response(200, { login: 'idah' });
      if (url.includes('/notifications?all=true&per_page=1')) {
        markNotificationsStarted();
        return pendingNotifications;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const pending = authStore.setWatchNotificationsToken('ghp_racing');
    const rejected = assert.rejects(
      () => pending,
      (error: unknown) => error instanceof Error && error.message === WATCH_TOKEN_ACCOUNT_CHANGED,
    );
    await notificationsStarted;
    globalThis.fetch = mainTokenFetch('another-user', 'probe-racing-account');
    await authStore.setToken('github_pat_another_account');
    resolveNotifications(response(200, []));

    await rejected;
    assert.equal((await authStore.getConfig()).watchNotificationsTokenEncrypted, null);
  });
});
