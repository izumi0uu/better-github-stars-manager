import assert from 'node:assert/strict';
import { test } from 'vitest';
import { hookPageDiagnostics } from './extension-runtime-targets.mjs';

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

  page.emit('requestfailed', failedRequest('chrome-extension://abcdefghijklmnop/assets/content.js'));
  page.emit('requestfailed', failedRequest('chrome-extension://abcdefghijklmnop/assets/replaced.png', {
    errorText: 'net::ERR_ABORTED',
  }));
  page.emit('requestfailed', failedRequest('https://api.github.com/user', { method: 'delete' }));
  page.emit('requestfailed', failedRequest('https://api.github.com/user', {
    errorText: 'net::ERR_ABORTED',
  }));
  page.emit('requestfailed', failedRequest('https://api.github.com/user/subscriptions?per_page=1&page=1'));
  page.emit('requestfailed', failedRequest('https://api.github.com/notifications?all=true&per_page=1'));
  page.emit('requestfailed', failedRequest('data:image/png;base64,AA=='));
  page.emit('requestfailed', failedRequest('blob:https://github.com/runtime-blob'));
  page.emit('requestfailed', failedRequest('about:blank'));
  page.emit('requestfailed', failedRequest('https://github.com/runtime-user?tab=stars', {
    navigation: true,
    errorText: 'net::ERR_ABORTED',
  }));

  assert.deepEqual(issues, [
    { label: 'runtime-target', kind: 'request-failed', value: 'GET extension-resource' },
    { label: 'runtime-target', kind: 'request-failed', value: 'DELETE github-user' },
    { label: 'runtime-target', kind: 'request-failed', value: 'GET github-user' },
    { label: 'runtime-target', kind: 'request-failed', value: 'GET github-watch-scope' },
    { label: 'runtime-target', kind: 'request-failed', value: 'GET github-notifications' },
  ]);

  diagnostics.cleanup();
  page.emit('requestfailed', failedRequest('https://api.github.com/user'));
  assert.equal(issues.length, 5);
});
