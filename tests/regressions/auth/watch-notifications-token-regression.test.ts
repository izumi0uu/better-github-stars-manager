import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import { createChromeMock, response } from '../../helpers/chrome-mock';
import {
  WATCH_TOKEN_ACCOUNT_CHANGED,
  WATCH_TOKEN_ACCOUNT_MISMATCH,
  WATCH_TOKEN_EMPTY,
  WATCH_TOKEN_NOTIFICATIONS_BAD_SHAPE,
  WATCH_TOKEN_NOTIFICATIONS_FORBIDDEN,
  WATCH_TOKEN_NOTIFICATIONS_NETWORK,
} from '@/api/errors';

const chromeMock = createChromeMock();
Object.defineProperty(globalThis, 'chrome', { value: chromeMock.api, configurable: true });
const originalFetch = globalThis.fetch;
const {
  authStore,
  CONFIG_STORAGE_KEY,
  GITHUB_CREDENTIALS_STORAGE_KEY,
} = await import('@/auth/auth-store');

type FetchOptions = {
  notifications?: 'ok' | 'forbidden' | 'network' | 'shape';
  onRequest?: (url: string, token: string) => void;
};

function mainTokenFetch(login: string, probeId: string, options: FetchOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string> | undefined;
    const token = headers?.Authorization?.replace(/^Bearer /u, '') ?? '';
    options.onRequest?.(url, token);
    if (url.endsWith('/user') && method === 'GET') {
      return response(200, { login, avatar_url: null, name: login }, { 'x-oauth-scopes': '' });
    }
    if (url.includes('/user/starred') && method === 'GET') return response(200, []);
    if (url.endsWith('/gists') && method === 'POST') return response(201, { id: probeId });
    if (url.endsWith(`/gists/${probeId}`) && method === 'DELETE') return response(204);
    if (url.includes('/user/subscriptions') && method === 'GET') return response(200, []);
    if (url.includes('/notifications?all=true&per_page=1') && method === 'GET') {
      if (options.notifications === 'forbidden') return response(403, { message: 'denied' });
      if (options.notifications === 'shape') return response(200, { message: 'not-an-array' });
      if (options.notifications === 'network') throw new Error('network down');
      return response(200, []);
    }
    throw new Error('unexpected main-token fetch');
  }) as typeof fetch;
}

function watchTokenFetch(input: {
  login: string;
  notifications?: 'ok' | 'forbidden' | 'network' | 'shape';
  onRequest?: (url: string, token: string) => void;
}): typeof fetch {
  return (async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request);
    const headers = init?.headers as Record<string, string> | undefined;
    const token = headers?.Authorization?.replace(/^Bearer /u, '') ?? '';
    input.onRequest?.(url, token);
    if (url.endsWith('/user')) return response(200, { login: input.login });
    if (url.includes('/notifications?all=true&per_page=1')) {
      if (input.notifications === 'forbidden') return response(403, { message: 'denied' });
      if (input.notifications === 'shape') return response(200, { message: 'not-an-array' });
      if (input.notifications === 'network') throw new Error('network down');
      return response(200, []);
    }
    throw new Error('unexpected Watch-token fetch');
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

async function countStorageWrites<T>(callback: () => Promise<T>): Promise<{ result: T; writes: number }> {
  let writes = 0;
  const originalSet = chromeMock.api.storage.local.set;
  chromeMock.api.storage.local.set = (async (...args: Parameters<typeof originalSet>) => {
    writes++;
    return originalSet(...args);
  }) as typeof originalSet;
  try {
    return { result: await callback(), writes };
  } finally {
    chromeMock.api.storage.local.set = originalSet;
  }
}

async function assertRejectedWithoutStorageWrites(
  callback: () => Promise<unknown>,
  errorCode: string,
): Promise<void> {
  let writes = 0;
  const originalSet = chromeMock.api.storage.local.set;
  chromeMock.api.storage.local.set = (async (...args: Parameters<typeof originalSet>) => {
    writes++;
    return originalSet(...args);
  }) as typeof originalSet;
  try {
    await assert.rejects(
      callback,
      (error: unknown) => error instanceof Error && error.message === errorCode,
    );
  } finally {
    chromeMock.api.storage.local.set = originalSet;
  }
  assert.equal(writes, 0);
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

describe('Watch Notifications credential state machine', () => {
  it('enables Watch with the main credential without creating a second cipher', async () => {
    await configureMain('Idah', 'main-capable');
    const calls: string[] = [];
    globalThis.fetch = mainTokenFetch('IDAH', 'unused', {
      onRequest: (url, token) => {
        calls.push(url);
        assert.equal(token, 'main-capable');
      },
    });

    const enabled = await countStorageWrites(() => authStore.enableWatchWithMainToken());
    const config = await authStore.getConfig();
    const snapshot = await authStore.getGitHubCredentialSnapshot();
    assert.equal(enabled.result.username, 'IDAH');
    assert.equal(enabled.writes, 1);
    assert.equal(config.watchCredentialSource, 'main');
    assert.equal(config.watchNotificationsTokenEncrypted, null);
    assert.equal(config.watchNotificationsTokenCryptoMeta, null);
    assert.equal(await authStore.getWatchNotificationsToken(), 'main-capable');
    assert.equal(await authStore.hasWatchNotificationsToken(), true);
    assert.equal(snapshot.watchCredentialSource, 'main');
    assert.equal(snapshot.mainToken, 'main-capable');
    assert.equal(snapshot.notificationsToken, 'main-capable');
    assert.equal(snapshot.notificationsConfigured, true);
    assert.deepEqual(calls, [
      'https://api.github.com/user',
      'https://api.github.com/notifications?all=true&per_page=1',
    ]);
  });

  it('replaces dedicated authority with main without copying or retaining its secret', async () => {
    await configureMain('idah', 'main-reused');
    await configureWatch('idah', 'dedicated-obsolete');
    const before = await authStore.getConfig();
    assert.ok(before.watchNotificationsTokenEncrypted);
    globalThis.fetch = mainTokenFetch('idah', 'unused');

    await authStore.enableWatchWithMainToken();
    const after = await authStore.getConfig();
    assert.equal(after.watchCredentialSource, 'main');
    assert.equal(after.watchNotificationsTokenEncrypted, null);
    assert.equal(after.watchNotificationsTokenCryptoMeta, null);
    assert.equal(after.tokenEncrypted, before.tokenEncrypted);
    assert.deepEqual(after.tokenCryptoMeta, before.tokenCryptoMeta);
    assert.equal(await authStore.getWatchNotificationsToken(), 'main-reused');
  });

  it('routes reads and identity through the selected source', async () => {
    await configureMain('idah', 'main-selected');
    globalThis.fetch = mainTokenFetch('idah', 'unused');
    await authStore.enableWatchWithMainToken();
    const mainSnapshot = await authStore.getGitHubCredentialSnapshot();

    await configureWatch('IDAH', 'dedicated-selected');
    const dedicatedSnapshot = await authStore.getGitHubCredentialSnapshot();
    assert.equal(mainSnapshot.watchCredentialSource, 'main');
    assert.equal(mainSnapshot.notificationsToken, 'main-selected');
    assert.equal(dedicatedSnapshot.watchCredentialSource, 'dedicated');
    assert.equal(dedicatedSnapshot.notificationsToken, 'dedicated-selected');
    assert.equal(dedicatedSnapshot.notificationsConfigured, true);
    assert.notEqual(dedicatedSnapshot.notificationsIdentity, mainSnapshot.notificationsIdentity);

    await authStore.clearWatchNotificationsToken();
    const disabledSnapshot = await authStore.getGitHubCredentialSnapshot();
    assert.equal(disabledSnapshot.watchCredentialSource, null);
    assert.equal(disabledSnapshot.notificationsToken, null);
    assert.equal(disabledSnapshot.notificationsConfigured, false);
    assert.notEqual(disabledSnapshot.notificationsIdentity, dedicatedSnapshot.notificationsIdentity);
  });

  it('falls back to a dedicated classic token only after main capability is forbidden', async () => {
    await configureMain('Idah', 'main-no-notifications');
    const calls: string[] = [];
    globalThis.fetch = mainTokenFetch('Idah', 'unused', {
      notifications: 'forbidden',
      onRequest: (url) => calls.push(url),
    });
    await assert.rejects(
      () => authStore.enableWatchWithMainToken(),
      (error: unknown) => error instanceof Error && error.message === WATCH_TOKEN_NOTIFICATIONS_FORBIDDEN,
    );
    assert.equal((await authStore.getConfig()).watchCredentialSource, null);
    assert.equal(await authStore.getWatchNotificationsToken(), null);
    assert.deepEqual(calls, [
      'https://api.github.com/user',
      'https://api.github.com/notifications?all=true&per_page=1',
    ]);

    await configureWatch('idah', 'dedicated-fallback');
    const config = await authStore.getConfig();
    assert.equal(config.watchCredentialSource, 'dedicated');
    assert.equal(await authStore.getWatchNotificationsToken(), 'dedicated-fallback');
    assert.equal(await authStore.getToken(), 'main-no-notifications');
  });

  it('preserves the prior authority for permission, network, shape, and account failures', async () => {
    const failures: Array<{
      name: string;
      options: FetchOptions;
      expected: string;
      calls: number;
    }> = [
      { name: 'permission', options: { notifications: 'forbidden' }, expected: WATCH_TOKEN_NOTIFICATIONS_FORBIDDEN, calls: 2 },
      { name: 'network', options: { notifications: 'network' }, expected: WATCH_TOKEN_NOTIFICATIONS_NETWORK, calls: 2 },
      { name: 'shape', options: { notifications: 'shape' }, expected: WATCH_TOKEN_NOTIFICATIONS_BAD_SHAPE, calls: 2 },
      { name: 'account', options: {}, expected: WATCH_TOKEN_ACCOUNT_MISMATCH, calls: 1 },
    ];
    for (const failure of failures) {
      await chromeMock.api.storage.local.clear();
      await configureMain('Idah', `main-${failure.name}`);
      await configureWatch('idah', 'dedicated-existing');
      const previous = await authStore.getConfig();
      const calls: string[] = [];
      globalThis.fetch = mainTokenFetch(
        failure.name === 'account' ? 'other-account' : 'idah',
        `unused-${failure.name}`,
        { ...failure.options, onRequest: (url) => calls.push(url) },
      );
      await assertRejectedWithoutStorageWrites(
        () => authStore.enableWatchWithMainToken(),
        failure.expected,
      );
      const current = await authStore.getConfig();
      assert.equal(current.watchCredentialSource, previous.watchCredentialSource, failure.name);
      assert.equal(await authStore.getWatchNotificationsToken(), 'dedicated-existing', failure.name);
      assert.deepEqual(calls, [
        'https://api.github.com/user',
        ...(failure.calls === 2
          ? ['https://api.github.com/notifications?all=true&per_page=1']
          : []),
      ], failure.name);
    }
  });

  it('preserves prior authority when main enablement cannot persist', async () => {
    await configureMain('idah', 'main-storage');
    await configureWatch('idah', 'dedicated-storage');
    const previous = await authStore.getConfig();
    let writes = 0;
    const originalSet = chromeMock.api.storage.local.set;
    chromeMock.api.storage.local.set = (async (...args: Parameters<typeof originalSet>) => {
      writes++;
      return originalSet(...args);
    }) as typeof originalSet;
    chromeMock.rejectNextSet(new Error('storage failed'));
    try {
      await assert.rejects(() => authStore.enableWatchWithMainToken(), /storage failed/);
    } finally {
      chromeMock.api.storage.local.set = originalSet;
    }
    assert.equal(writes, 1);
    const current = await authStore.getConfig();
    assert.equal(current.watchCredentialSource, previous.watchCredentialSource);
    assert.equal(await authStore.getWatchNotificationsToken(), 'dedicated-storage');
    assert.equal(await authStore.getToken(), 'main-storage');
  });

  it('rejects a main enable race and leaves the previous dedicated authority intact', async () => {
    await configureMain('idah', 'main-race');
    await configureWatch('idah', 'dedicated-race');
    let resolveNotifications!: (value: Response) => void;
    let notificationsStarted!: () => void;
    const started = new Promise<void>((resolve) => { notificationsStarted = resolve; });
    const pendingNotifications = new Promise<Response>((resolve) => { resolveNotifications = resolve; });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/user')) return response(200, { login: 'idah' });
      if (url.includes('/notifications?all=true&per_page=1')) {
        notificationsStarted();
        return pendingNotifications;
      }
      throw new Error('unexpected race fetch');
    }) as typeof fetch;

    const pending = authStore.enableWatchWithMainToken();
    await started;
    globalThis.fetch = mainTokenFetch('IDAH', 'race-account');
    await authStore.setToken('main-race-replacement');
    resolveNotifications(response(200, []));
    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof Error && error.message === WATCH_TOKEN_ACCOUNT_CHANGED,
    );
    assert.equal((await authStore.getConfig()).watchCredentialSource, 'dedicated');
    assert.equal(await authStore.getWatchNotificationsToken(), 'dedicated-race');
  });

  it('commits dedicated source only after both checks, with no work for whitespace', async () => {
    await configureMain('idah', 'main-whitespace');
    let fetchCalls = 0;
    let storageWrites = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('must not fetch');
    }) as typeof fetch;
    const originalSet = chromeMock.api.storage.local.set;
    chromeMock.api.storage.local.set = (async (...args: Parameters<typeof originalSet>) => {
      storageWrites++;
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
    assert.equal(storageWrites, 0);
    assert.equal((await authStore.getConfig()).watchCredentialSource, null);
  });

  it('preserves a dedicated source when replacement proof or persistence fails', async () => {
    await configureMain('idah', 'main-dedicated-failures');
    await configureWatch('idah', 'dedicated-existing');
    const previous = await authStore.getConfig();
    const failures = [
      { name: 'account', login: 'other-account', notifications: 'ok' as const, expected: WATCH_TOKEN_ACCOUNT_MISMATCH },
      { name: 'permission', login: 'idah', notifications: 'forbidden' as const, expected: WATCH_TOKEN_NOTIFICATIONS_FORBIDDEN },
      { name: 'network', login: 'idah', notifications: 'network' as const, expected: WATCH_TOKEN_NOTIFICATIONS_NETWORK },
      { name: 'shape', login: 'idah', notifications: 'shape' as const, expected: WATCH_TOKEN_NOTIFICATIONS_BAD_SHAPE },
    ];
    for (const failure of failures) {
      const candidate = `dedicated-${failure.name}`;
      globalThis.fetch = watchTokenFetch({
        login: failure.login,
        notifications: failure.notifications,
        onRequest: (_url, token) => assert.equal(token, candidate),
      });
      await assertRejectedWithoutStorageWrites(
        () => authStore.setWatchNotificationsToken(candidate),
        failure.expected,
      );
      const current = await authStore.getConfig();
      assert.equal(current.watchCredentialSource, 'dedicated', failure.name);
      assert.equal(current.watchNotificationsTokenEncrypted, previous.watchNotificationsTokenEncrypted, failure.name);
      assert.deepEqual(current.watchNotificationsTokenCryptoMeta, previous.watchNotificationsTokenCryptoMeta, failure.name);
      assert.equal(await authStore.getWatchNotificationsToken(), 'dedicated-existing', failure.name);
    }

    globalThis.fetch = watchTokenFetch({ login: 'idah' });
    let writes = 0;
    const originalSet = chromeMock.api.storage.local.set;
    chromeMock.api.storage.local.set = (async (...args: Parameters<typeof originalSet>) => {
      writes++;
      return originalSet(...args);
    }) as typeof originalSet;
    chromeMock.rejectNextSet(new Error('storage failed'));
    try {
      await assert.rejects(
        () => authStore.setWatchNotificationsToken('dedicated-storage-failure'),
        /storage failed/,
      );
    } finally {
      chromeMock.api.storage.local.set = originalSet;
    }
    assert.equal(writes, 1);
    assert.equal((await authStore.getConfig()).watchCredentialSource, 'dedicated');
    assert.equal(await authStore.getWatchNotificationsToken(), 'dedicated-existing');
  });

  it('preserves a dedicated binding after same-account main rotation but disables main binding', async () => {
    await configureMain('Idah', 'main-first');
    globalThis.fetch = mainTokenFetch('Idah', 'unused');
    await authStore.enableWatchWithMainToken();
    globalThis.fetch = mainTokenFetch('IDAH', 'main-rotation');
    await authStore.setToken('main-second');
    assert.equal((await authStore.getConfig()).watchCredentialSource, null);
    assert.equal(await authStore.getWatchNotificationsToken(), null);

    await configureWatch('idah', 'dedicated-survives');
    globalThis.fetch = mainTokenFetch('IDAH', 'main-rotation-2');
    await authStore.setToken('main-third');
    assert.equal((await authStore.getConfig()).watchCredentialSource, 'dedicated');
    assert.equal(await authStore.getWatchNotificationsToken(), 'dedicated-survives');
  });

  it('clears every Watch authority on account change and logout', async () => {
    await configureMain('idah', 'main-account-change');
    await configureWatch('idah', 'dedicated-account-change');
    globalThis.fetch = mainTokenFetch('other-account', 'account-change');
    await authStore.setToken('main-other');
    let config = await authStore.getConfig();
    assert.equal(config.watchCredentialSource, null);
    assert.equal(config.watchNotificationsTokenEncrypted, null);
    assert.equal(await authStore.getWatchNotificationsToken(), null);

    await configureWatch('other-account', 'dedicated-before-clear');
    await authStore.clearToken();
    config = await authStore.getConfig();
    assert.equal(config.watchCredentialSource, null);
    assert.equal(config.tokenEncrypted, null);
    assert.equal(config.watchNotificationsTokenEncrypted, null);
    assert.equal(await authStore.getWatchNotificationsToken(), null);
  });

  it('disconnects Watch without clearing the main credential', async () => {
    await configureMain('idah', 'main-retained');
    globalThis.fetch = mainTokenFetch('idah', 'unused');
    await authStore.enableWatchWithMainToken();
    const before = await authStore.getConfig();
    await authStore.clearWatchNotificationsToken();
    const after = await authStore.getConfig();
    assert.equal(after.watchCredentialSource, null);
    assert.equal(after.tokenEncrypted, before.tokenEncrypted);
    assert.deepEqual(after.tokenCryptoMeta, before.tokenCryptoMeta);
    assert.equal(await authStore.getToken(), 'main-retained');
    assert.equal(await authStore.hasToken(), true);
  });

  it('normalizes a legacy complete dedicated credential and rejects incomplete authority', async () => {
    await configureMain('idah', 'main-legacy');
    await configureWatch('idah', 'dedicated-legacy');
    const stored = await chromeMock.api.storage.local.get([
      CONFIG_STORAGE_KEY,
      GITHUB_CREDENTIALS_STORAGE_KEY,
    ]);
    const storedConfig = stored[CONFIG_STORAGE_KEY] as Record<string, unknown>;
    const storedCredentials = stored[GITHUB_CREDENTIALS_STORAGE_KEY] as Record<string, unknown>;
    const { watchCredentialSource: _configSource, ...legacyConfig } = storedConfig;
    const { watchCredentialSource: _credentialSource, ...legacyCredentials } = storedCredentials;
    await chromeMock.api.storage.local.set({
      [CONFIG_STORAGE_KEY]: legacyConfig,
      [GITHUB_CREDENTIALS_STORAGE_KEY]: legacyCredentials,
    });
    assert.equal((await authStore.getConfig()).watchCredentialSource, 'dedicated');

    await chromeMock.api.storage.local.set({
      [CONFIG_STORAGE_KEY]: { ...legacyConfig, watchCredentialSource: 'dedicated' },
      [GITHUB_CREDENTIALS_STORAGE_KEY]: {
        ...legacyCredentials,
        watchNotificationsTokenEncrypted: null,
        watchNotificationsTokenCryptoMeta: null,
      },
    });
    assert.equal((await authStore.getConfig()).watchCredentialSource, null);
    assert.equal(await authStore.getWatchNotificationsToken(), null);
  });
});
