import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import {
  assertRuntimeMessagePayload,
  browserRuntime,
  isBrowserStorageAvailable,
} from '../../src/platform/browser-runtime';

type Listener<TArgs extends unknown[]> = (...args: TArgs) => unknown;

function createEvent<TArgs extends unknown[]>() {
  const listeners = new Set<Listener<TArgs>>();
  return {
    addListener: vi.fn((listener: Listener<TArgs>) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: Listener<TArgs>) => {
      listeners.delete(listener);
    }),
    listeners,
  };
}

function stubBrowserApi() {
  const runtimeOnMessage = createEvent<[unknown, chrome.runtime.MessageSender, (response?: unknown) => void]>();
  const runtimeOnInstalled = createEvent<[chrome.runtime.InstalledDetails]>();
  const storageOnChanged = createEvent<[Record<string, chrome.storage.StorageChange>, chrome.storage.AreaName]>();
  const api = {
    runtime: {
      sendMessage: vi.fn(async (message: unknown) => ({ echoed: message })),
      onMessage: runtimeOnMessage,
      onInstalled: runtimeOnInstalled,
      openOptionsPage: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: unknown) => ({ keys })),
        set: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      },
      onChanged: storageOnChanged,
    },
    tabs: {
      create: vi.fn(async (createProperties: chrome.tabs.CreateProperties) => ({
        id: 17,
        url: createProperties.url,
      })),
    },
  };

  vi.stubGlobal('browser', api);
  vi.stubGlobal('chrome', undefined);
  return api;
}

function stubChromeApi() {
  const runtimeOnMessage = createEvent<[unknown, chrome.runtime.MessageSender, (response?: unknown) => void]>();
  const runtimeOnInstalled = createEvent<[chrome.runtime.InstalledDetails]>();
  const storageOnChanged = createEvent<[Record<string, chrome.storage.StorageChange>, chrome.storage.AreaName]>();
  const api = {
    runtime: {
      lastError: undefined as chrome.runtime.LastError | undefined,
      sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
        callback({ echoed: message });
      }),
      onMessage: runtimeOnMessage,
      onInstalled: runtimeOnInstalled,
      openOptionsPage: vi.fn((callback: () => void) => {
        callback();
      }),
    },
    storage: {
      local: {
        get: vi.fn((keys: unknown, callback: (items: Record<string, unknown>) => void) => {
          callback({ keys });
        }),
        set: vi.fn((_items: Record<string, unknown>, callback: () => void) => {
          callback();
        }),
        clear: vi.fn((callback: () => void) => {
          callback();
        }),
      },
      onChanged: storageOnChanged,
    },
    tabs: {
      create: vi.fn((createProperties: chrome.tabs.CreateProperties, callback: (tab: chrome.tabs.Tab) => void) => {
        callback({ id: 23, url: createProperties.url } as chrome.tabs.Tab);
      }),
    },
  };

  vi.stubGlobal('browser', undefined);
  vi.stubGlobal('chrome', api);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserRuntime runtime adapter', () => {
  it('uses Firefox/browser Promise runtime.sendMessage when browser is present', async () => {
    const api = stubBrowserApi();

    const response = await browserRuntime.runtime.sendMessage<{ echoed: { type: string } }>({ type: 'status' });

    assert.deepEqual(response, { echoed: { type: 'status' } });
    assert.equal(api.runtime.sendMessage.mock.calls.length, 1);
    assert.deepEqual(api.runtime.sendMessage.mock.calls[0], [{ type: 'status' }]);
  });

  it('normalizes Chrome callback runtime.sendMessage into a Promise', async () => {
    const api = stubChromeApi();

    const response = await browserRuntime.runtime.sendMessage<{ echoed: { type: string } }>({ type: 'sync' });

    assert.deepEqual(response, { echoed: { type: 'sync' } });
    assert.equal(api.runtime.sendMessage.mock.calls.length, 1);
    assert.equal(typeof api.runtime.sendMessage.mock.calls[0][1], 'function');
  });

  it('rejects Chrome callback operations when runtime.lastError is set', async () => {
    const api = stubChromeApi();
    api.runtime.sendMessage.mockImplementation((_message: unknown, callback: (response: unknown) => void) => {
      api.runtime.lastError = { message: 'No receiver' };
      callback(undefined);
    });

    await assert.rejects(
      () => browserRuntime.runtime.sendMessage({ type: 'missing-listener' }),
      /No receiver/,
    );
  });

  it('normalizes promise-returning runtime methods exposed on the chrome global', async () => {
    const api = stubChromeApi();
    api.runtime.sendMessage.mockImplementation((message: unknown) => Promise.resolve({ promised: message }));

    const response = await browserRuntime.runtime.sendMessage<{ promised: { type: string } }>({ type: 'modern' });

    assert.deepEqual(response, { promised: { type: 'modern' } });
    assert.equal(api.runtime.sendMessage.mock.calls.length, 1);
  });

  it('delegates runtime listener registration and removal', () => {
    const api = stubBrowserApi();
    const listener = vi.fn(() => false);

    browserRuntime.runtime.onMessage.addListener(listener);
    browserRuntime.runtime.onMessage.removeListener(listener);

    assert.equal(api.runtime.onMessage.addListener.mock.calls[0][0], listener);
    assert.equal(api.runtime.onMessage.removeListener.mock.calls[0][0], listener);
    assert.equal(api.runtime.onMessage.listeners.size, 0);
  });

  it('delegates runtime install listener registration and removal', () => {
    const api = stubBrowserApi();
    const listener = vi.fn();

    browserRuntime.runtime.onInstalled.addListener(listener);
    browserRuntime.runtime.onInstalled.removeListener(listener);

    assert.equal(api.runtime.onInstalled.addListener.mock.calls[0][0], listener);
    assert.equal(api.runtime.onInstalled.removeListener.mock.calls[0][0], listener);
    assert.equal(api.runtime.onInstalled.listeners.size, 0);
  });

  it('normalizes storage.local get/set/clear for Promise and callback APIs', async () => {
    const browserApi = stubBrowserApi();
    assert.deepEqual(await browserRuntime.storage.local.get('gsm_config'), { keys: 'gsm_config' });
    await browserRuntime.storage.local.set({ gsm_config: { locale: 'en' } });
    await browserRuntime.storage.local.clear();
    assert.equal(browserApi.storage.local.get.mock.calls.length, 1);
    assert.equal(browserApi.storage.local.set.mock.calls.length, 1);
    assert.equal(browserApi.storage.local.clear.mock.calls.length, 1);

    vi.unstubAllGlobals();
    const chromeApi = stubChromeApi();
    assert.deepEqual(await browserRuntime.storage.local.get(['theme']), { keys: ['theme'] });
    await browserRuntime.storage.local.set({ theme: 'dark' });
    await browserRuntime.storage.local.clear();
    assert.equal(typeof chromeApi.storage.local.get.mock.calls[0][1], 'function');
    assert.equal(typeof chromeApi.storage.local.set.mock.calls[0][1], 'function');
    assert.equal(typeof chromeApi.storage.local.clear.mock.calls[0][0], 'function');
  });

  it('delegates storage change listener registration and removal', () => {
    const api = stubBrowserApi();
    const listener = vi.fn();

    browserRuntime.storage.onChanged.addListener(listener);
    browserRuntime.storage.onChanged.removeListener(listener);

    assert.equal(api.storage.onChanged.addListener.mock.calls[0][0], listener);
    assert.equal(api.storage.onChanged.removeListener.mock.calls[0][0], listener);
    assert.equal(api.storage.onChanged.listeners.size, 0);
  });

  it('reports storage listener availability without requiring unrelated runtime APIs', () => {
    assert.equal(isBrowserStorageAvailable(), false);

    const storageOnChanged = createEvent<[Record<string, chrome.storage.StorageChange>, chrome.storage.AreaName]>();
    vi.stubGlobal('chrome', {
      storage: {
        onChanged: storageOnChanged,
      },
    });

    assert.equal(isBrowserStorageAvailable(), true);
  });

  it('normalizes tabs.create and runtime.openOptionsPage', async () => {
    const browserApi = stubBrowserApi();
    assert.deepEqual(await browserRuntime.tabs.create({ url: 'https://github.com/stars' }), {
      id: 17,
      url: 'https://github.com/stars',
    });
    await browserRuntime.runtime.openOptionsPage();
    assert.equal(browserApi.tabs.create.mock.calls.length, 1);
    assert.equal(browserApi.runtime.openOptionsPage.mock.calls.length, 1);

    vi.unstubAllGlobals();
    const chromeApi = stubChromeApi();
    assert.deepEqual(await browserRuntime.tabs.create({ url: 'https://github.com/idah?tab=stars' }), {
      id: 23,
      url: 'https://github.com/idah?tab=stars',
    });
    await browserRuntime.runtime.openOptionsPage();
    assert.equal(typeof chromeApi.tabs.create.mock.calls[0][1], 'function');
    assert.equal(typeof chromeApi.runtime.openOptionsPage.mock.calls[0][0], 'function');
  });

  it('accepts plain JSON-like runtime message payloads', () => {
    assert.doesNotThrow(() => {
      assertRuntimeMessagePayload({
        type: 'query',
        page: 1,
        filters: { tags: ['typescript'], archived: false },
        cursor: null,
      });
    });
  });

  it('rejects payload values that are risky across runtime messaging implementations', () => {
    class CustomPayload {
      value = 'not plain';
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    const rejectedPayloads = [
      { url: new URL('https://github.com/stars') },
      { error: new Error('boom') },
      { callback: () => undefined },
      { instance: new CustomPayload() },
      cycle,
      { count: Number.POSITIVE_INFINITY },
    ];

    for (const payload of rejectedPayloads) {
      assert.throws(() => assertRuntimeMessagePayload(payload), TypeError);
    }
  });
});
