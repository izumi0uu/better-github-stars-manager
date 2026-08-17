import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  discoverExtension,
  extensionOrigin,
  extensionUrl,
  hookPageDiagnostics,
  normalizeRuntimeTarget,
} from './extension-runtime-targets.mjs';
import {
  FIREFOX_GECKO_ID,
  FIREFOX_TEST_UUID,
} from '../../scripts/build-firefox-extension.mjs';

class FakePage {
  constructor() {
    this.listeners = new Map();
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function failedRequest(url, {
  method = 'GET',
  navigation = false,
  errorText = 'net::ERR_FAILED',
} = {}) {
  return {
    url: () => url,
    method: () => method,
    isNavigationRequest: () => navigation,
    failure: () => ({ errorText }),
  };
}

test('page diagnostics retain extension and HTTP failures but ignore lifecycle-only schemes', () => {
  const page = new FakePage();
  const issues = [];
  const diagnostics = hookPageDiagnostics(page, 'runtime-target', { issues });

  page.emit('console', {
    type: () => 'error',
    text: () => 'Failed to load resource: 403',
    location: () => ({ url: 'https://api.github.com/notifications?all=true&per_page=1' }),
  });

  page.emit('requestfailed', failedRequest('chrome-extension://abcdefghijklmnop/assets/content.js'));
  page.emit('requestfailed', failedRequest(`moz-extension://${FIREFOX_TEST_UUID}/assets/content.js`));
  page.emit('requestfailed', failedRequest('chrome-extension://abcdefghijklmnop/assets/replaced.png', {
    errorText: 'net::ERR_ABORTED',
  }));

  page.emit('requestfailed', failedRequest('https://api.github.com/user', { method: 'delete' }));
  page.emit('requestfailed', failedRequest('https://api.github.com/user', {
    errorText: 'net::ERR_ABORTED',
  }));
  page.emit('requestfailed', failedRequest('https://api.github.com/user/subscriptions?per_page=1&page=1'));
  page.emit('requestfailed', failedRequest('https://api.github.com/notifications?all=true&per_page=1'));
  page.emit('requestfailed', failedRequest('https://api.github.com/repos/octo/project/issues/17'));
  page.emit('requestfailed', failedRequest('data:image/png;base64,AA=='));
  page.emit('requestfailed', failedRequest('blob:https://github.com/runtime-blob'));
  page.emit('requestfailed', failedRequest('about:blank'));
  page.emit('requestfailed', failedRequest('https://github.com/runtime-user?tab=stars', {
    navigation: true,
    errorText: 'net::ERR_ABORTED',
  }));

  assert.deepEqual(issues, [
    { label: 'runtime-target', kind: 'console-error', value: 'github-notifications' },
    { label: 'runtime-target', kind: 'request-failed', value: 'GET extension-resource' },
    { label: 'runtime-target', kind: 'request-failed', value: 'GET extension-resource' },
    { label: 'runtime-target', kind: 'request-failed', value: 'DELETE github-user' },
    { label: 'runtime-target', kind: 'request-failed', value: 'GET github-user' },
    { label: 'runtime-target', kind: 'request-failed', value: 'GET github-watch-scope' },
    { label: 'runtime-target', kind: 'request-failed', value: 'GET github-notifications' },
    { label: 'runtime-target', kind: 'request-failed', value: 'GET github-watch-subject' },
  ]);

  diagnostics.cleanup();
  page.emit('requestfailed', failedRequest('https://api.github.com/user'));
  assert.equal(issues.length, 8);
});
test('Chrome and Edge share Chromium extension URLs while unknown targets fail', () => {
  const extensionId = 'a'.repeat(32);
  assert.equal(normalizeRuntimeTarget('edge'), 'edge');
  assert.equal(extensionOrigin(extensionId, 'edge'), `chrome-extension://${extensionId}`);
  assert.equal(extensionOrigin(extensionId, 'edge'), extensionOrigin(extensionId, 'chrome'));
  assert.equal(
    extensionUrl(extensionId, '/src/popup/index.html', 'edge'),
    `chrome-extension://${extensionId}/src/popup/index.html`,
  );
  assert.equal(
    extensionUrl(extensionId, '/src/popup/index.html', 'edge'),
    extensionUrl(extensionId, '/src/popup/index.html', 'chrome'),
  );
  assert.throws(() => normalizeRuntimeTarget('opera'), /Unsupported runtime target: opera/u);
});

test('Edge shares Chrome MV3 service-worker discovery behavior', async () => {
  const extensionId = 'b'.repeat(32);
  const dist = '/tmp/dist-edge';
  const executionContext = { evaluate: async () => extensionId };
  const backgroundTarget = {
    type: () => 'service_worker',
    url: () => `chrome-extension://${extensionId}/service-worker-loader.js`,
    worker: async () => executionContext,
  };
  const extension = { id: extensionId, enabled: true, path: dist };
  const discovered = await discoverExtension({
    extensions: async () => new Map([[extensionId, extension]]),
    targets: () => [backgroundTarget],
  }, {
    target: 'edge',
    dist,
    timeoutMs: 100,
    pollMs: 1,
  });

  assert.equal(discovered.extensionId, extensionId);
  assert.equal(discovered.backgroundKind, 'service_worker');
  assert.equal(discovered.target, backgroundTarget);
  assert.equal(discovered.worker, executionContext);
});


test('Firefox extension URLs use the fixed test UUID while runtime discovery keeps the Gecko ID', async () => {
  assert.equal(
    extensionOrigin(FIREFOX_GECKO_ID, 'firefox'),
    `moz-extension://${FIREFOX_TEST_UUID}`,
  );
  assert.equal(
    extensionUrl(FIREFOX_GECKO_ID, '/src/options/index.html', 'firefox'),
    `moz-extension://${FIREFOX_TEST_UUID}/src/options/index.html`,
  );

  const navigationOptions = [];
  const controlTarget = { type: () => 'page', url: () => 'about:blank' };
  const controlPage = {
    goto: async (_url, options) => {
      navigationOptions.push(options);
      throw new Error('Firefox BiDi navigation lifecycle timeout');
    },
    waitForFunction: async () => {},
    evaluate: async () => ({
      runtimeId: FIREFOX_GECKO_ID,
      backgroundUrl: `moz-extension://${FIREFOX_TEST_UUID}/_generated_background_page.html`,
    }),
    target: () => controlTarget,
    close: async () => {},
  };
  const browser = {
    newPage: async () => controlPage,
  };

  const discovered = await discoverExtension(browser, {
    target: 'firefox',
    dist: '/ignored-for-fixed-firefox-id',
    timeoutMs: 5_000,
    pollMs: 1,
  });
  assert.equal(discovered.extensionId, FIREFOX_GECKO_ID);
  assert.equal(discovered.backgroundKind, 'event_page');
  assert.equal(discovered.backgroundPage, null);
  assert.equal(discovered.controlPage, controlPage);
  assert.equal(discovered.target, null);
  assert.deepEqual(navigationOptions, [{ waitUntil: 'domcontentloaded', timeout: 1_000 }]);
});

test('Firefox discovery accepts an externally opened extension control page', async () => {
  const expectedPageUrl = `moz-extension://${FIREFOX_TEST_UUID}/src/popup/index.html`;
  const openCalls = [];
  const controlPage = {
    waitForFunction: async (_predicate, _options, actualUrl) => {
      assert.equal(actualUrl, expectedPageUrl);
    },
    evaluate: async () => ({
      runtimeId: FIREFOX_GECKO_ID,
      backgroundUrl: `moz-extension://${FIREFOX_TEST_UUID}/_generated_background_page.html`,
    }),
    close: async () => {},
  };

  const discovered = await discoverExtension({}, {
    target: 'firefox',
    dist: '/ignored-for-fixed-firefox-id',
    timeoutMs: 5_000,
    openPage: async (url, options) => {
      openCalls.push({ url, options });
      return controlPage;
    },
  });

  assert.equal(discovered.controlPage, controlPage);
  assert.equal(discovered.target, null);
  assert.deepEqual(openCalls, [{
    url: expectedPageUrl,
    options: { timeoutMs: 5_000, readyTimeoutMs: 5_000 },
  }]);
});
