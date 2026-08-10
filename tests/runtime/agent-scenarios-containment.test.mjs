import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  buildExtensionBrowserLaunchOptions,
} from './puppeteer-runtime.mjs';
import {
  buildScenarioFailureDiagnostic,
  installScenarioExtensionWithContainment,
  teardownScenarioRuntime,
} from './agent-scenarios-extension-host.mjs';
import { openExtensionPage } from './extension-runtime-targets.mjs';

class FakePage extends EventEmitter {
  constructor(order) {
    super();
    this.order = order;
    this.closed = false;
  }

  async setRequestInterception(enabled) {
    this.order.push(`interception:${enabled}`);
  }

  async goto() {
    this.order.push('goto');
  }

  async waitForFunction() {
    this.order.push('ready');
  }

  isClosed() {
    return this.closed;
  }

  async close() {
    this.closed = true;
    this.order.push('page-close');
  }
}

class FakeCdpClient extends EventEmitter {
  constructor(order, sessionId = null) {
    super();
    this.order = order;
    this.sessionId = sessionId;
    this.calls = [];
    this.autoAttachEvents = [];
  }

  connection() {
    return this;
  }

  session(sessionId) {
    return this.sessionId === sessionId ? this : null;
  }

  async send(method) {
    this.calls.push(method);
    this.order.push(`${this.sessionId ? 'worker' : 'browser'}:${method}`);
    if (method === 'Target.setAutoAttach') {
      const event = this.autoAttachEvents.shift();
      if (event) queueMicrotask(() => this.emit('Target.attachedToTarget', event));
    }
    return {};
  }

  queueAutoAttach(sessionId, url = 'chrome-extension://scenario-extension/background.js') {
    this.autoAttachEvents.push({
      sessionId,
      targetInfo: { type: 'service_worker', url },
    });
  }

  async detach() {
    this.order.push(`${this.sessionId ? 'worker' : 'browser'}:detach`);
  }
}

function runtimeState() {
  return {
    network: {
      workerUnexpectedRequests: 0,
      workerOverflow: false,
      workerInterceptionFailure: false,
    },
    workerRecords: [],
    workerSetupFailure: null,
  };
}

test('deferred launch removes extension load flags and requires pipe extension support', () => {
  const regular = buildExtensionBrowserLaunchOptions({ dist: '/tmp/dist', executablePath: '/tmp/chrome' });
  assert.equal(regular.pipe, undefined);
  assert.equal(regular.args.some((arg) => arg.startsWith('--load-extension=')), true);

  const deferred = buildExtensionBrowserLaunchOptions({
    dist: '/tmp/dist',
    executablePath: '/tmp/chrome',
    deferExtensionInstall: true,
    failClosedNetwork: true,
  });
  assert.equal(deferred.pipe, true);
  assert.equal(deferred.enableExtensions, true);
  assert.equal(deferred.args.some((arg) => arg.startsWith('--load-extension=')), false);
  assert.equal(deferred.args.includes('--proxy-server=http://127.0.0.1:9'), true);
});

test('Scenario worker containment arms auto-attach before installing and resumes after Fetch setup', async () => {
  const order = [];
  const worker = new FakeCdpClient(order, 'worker-session');
  const browserClient = new FakeCdpClient(order);
  browserClient.queueAutoAttach('worker-session');
  browserClient.connection = () => ({ session: (sessionId) => sessionId === 'worker-session' ? worker : null });
  const browser = {
    target: () => ({ createCDPSession: async () => browserClient }),
    installExtension: async () => {
      order.push('install-extension');
      return 'scenario-extension';
    },
  };
  const runtime = runtimeState();
  const installed = await installScenarioExtensionWithContainment(browser, '/tmp/dist', runtime, { timeoutMs: 500 });

  assert.equal(installed.extensionId, 'scenario-extension');
  assert.equal(runtime.workerRecords.length, 1);
  assert.equal(runtime.workerRecords[0].resumed, true);
  assert.ok(order.indexOf('browser:Target.setAutoAttach') < order.indexOf('install-extension'));
  assert.ok(order.indexOf('worker:Runtime.enable') < order.indexOf('worker:Fetch.enable'));
  assert.ok(order.indexOf('worker:Fetch.enable') < order.indexOf('worker:Runtime.runIfWaitingForDebugger'));
  assert.equal(runtime.network.workerUnexpectedRequests, 0);
});

test('Scenario teardown closes workers attached while auto-attach is being disabled', async () => {
  const order = [];
  const firstWorker = new FakeCdpClient(order, 'first-worker-session');
  const lateWorker = new FakeCdpClient(order, 'late-worker-session');
  const workers = new Map([
    ['first-worker-session', firstWorker],
    ['late-worker-session', lateWorker],
  ]);
  const browserClient = new FakeCdpClient(order);
  browserClient.connection = () => ({ session: (sessionId) => workers.get(sessionId) ?? null });
  browserClient.queueAutoAttach('first-worker-session');
  const browser = {
    target: () => ({ createCDPSession: async () => browserClient }),
    installExtension: async () => 'scenario-extension',
    process: () => null,
    close: async () => { order.push('browser-close'); },
  };
  const runtime = runtimeState();
  await installScenarioExtensionWithContainment(browser, '/tmp/dist', runtime, { timeoutMs: 500 });
  browserClient.queueAutoAttach('late-worker-session');
  const pageHttpPolicy = {
    closed: false,
    async close() { this.closed = true; },
  };
  Object.assign(runtime, {
    browser,
    page: null,
    pageHttpPolicy,
    pageDiagnostics: { cleanup: () => {} },
    cleanupFailures: 0,
    cleanup: {
      networkGatesClosed: false,
      diagnosticsDetached: false,
      pagesClosed: false,
      browserClosed: false,
      temporaryStateRemoved: false,
    },
    tempRoot: mkdtempSync(path.join(os.tmpdir(), 'bgsm-scenario-teardown-')),
  });

  await teardownScenarioRuntime(runtime);

  assert.equal(lateWorker.calls.includes('Fetch.disable'), true);
  assert.equal(lateWorker.calls.includes('Runtime.disable'), true);
  assert.equal(order.filter((entry) => entry === 'worker:detach').length, 2);
  assert.equal(runtime.workerResources.size, 0);
  assert.equal(Object.values(runtime.cleanup).every(Boolean), true);
});

const EXTENSION_ID = 'a'.repeat(32);

test('extension page diagnostics hook runs after HTTP policy and before navigation', async () => {
  const order = [];
  const page = new FakePage(order);
  const browser = { newPage: async () => page };
  const policy = { unexpectedRequests: [], expectedRequests: [], close: null };
  await openExtensionPage(browser, EXTENSION_ID, '/src/dev-agent/index.html', 'scenario', {
    rootSelector: '#root',
    failClosedHttp: policy,
    beforeNavigation(hookedPage) {
      assert.equal(hookedPage, page);
      order.push('diagnostics-hook');
    },
  });
  assert.ok(order.indexOf('interception:true') < order.indexOf('diagnostics-hook'));
  assert.ok(order.indexOf('diagnostics-hook') < order.indexOf('goto'));
});

test('page hook failure closes the policy and page before propagating', async () => {
  const order = [];
  const page = new FakePage(order);
  const browser = { newPage: async () => page };
  const policy = { unexpectedRequests: [], expectedRequests: [], close: null };
  await assert.rejects(
    () => openExtensionPage(browser, EXTENSION_ID, '/src/dev-agent/index.html', 'scenario', {
      failClosedHttp: policy,
      beforeNavigation() {
        throw new Error('hook-failed');
      },
    }),
    /Packaged extension page scenario did not become ready/u,
  );
  assert.equal(order.includes('goto'), false);
  assert.equal(order.includes('interception:false'), true);
  assert.equal(order.includes('page-close'), true);
});

test('deferred containment rejects a browser without extension installation support', async () => {
  await assert.rejects(
    () => installScenarioExtensionWithContainment({ target: () => ({ createCDPSession: async () => new FakeCdpClient([]) }) }, '/tmp/dist', runtimeState()),
    /worker_containment_unavailable/u,
  );
});

test('Scenario failure diagnostics preserve primary failure and expose only exact bounded safe fields', () => {
  const runtime = {
    stage: 'teardown',
    currentScenarioId: null,
    facts: null,
    pageIssues: [],
    workerIssueCounts: { exception: 0, consoleError: 0, overflow: false },
    network: { workerUnexpectedRequests: 0, workerOverflow: false },
    pageHttpPolicy: { unexpectedRequests: [], overflow: false },
    cleanupFailures: 1,
  };
  const primary = { stage: 'trace-assertions', error: new Error('SCENARIO_PRIVATE_PROMPT_CANARY') };
  const teardown = { stage: 'teardown', error: new Error('cleanup_failed') };

  assert.deepEqual(buildScenarioFailureDiagnostic(runtime, primary, teardown), {
    status: 'failed',
    proofScope: 'development_scenario_lab',
    stage: 'trace-assertions',
    code: 'trace_assertion_failed',
    teardownCode: 'cleanup_failed',
    scenarioId: 'none',
    rootCount: 0,
    pageIssues: 0,
    workerIssues: 0,
    unexpectedNetworkRequests: 0,
    overflow: false,
    cleanupFailures: 1,
  });

  const bounded = buildScenarioFailureDiagnostic({
    ...runtime,
    currentScenarioId: 'cubby-artifact-continuation-coverage',
    facts: { scenarios: { rootCount: 9 } },
    pageIssues: Array.from({ length: 25 }, () => 'SCENARIO_PRIVATE_RESPONSE_CANARY'),
    workerIssueCounts: { exception: 24, consoleError: 24, overflow: true },
    network: { workerUnexpectedRequests: 1_000_000, workerOverflow: true },
    pageHttpPolicy: {
      unexpectedRequests: Array.from({ length: 24 }, () => 'SCENARIO_PRIVATE_CURRENT_PROMPT_CANARY'),
      overflow: true,
    },
    cleanupFailures: 25,
  }, {
    stage: 'scenario-run',
    error: new Error('SCENARIO_PRIVATE_PROMPT_CANARY'),
  });
  assert.deepEqual(bounded, {
    status: 'failed',
    proofScope: 'development_scenario_lab',
    stage: 'scenario-run',
    code: 'scenario_run_failed',
    teardownCode: 'none',
    scenarioId: 'cubby-artifact-continuation-coverage',
    rootCount: 9,
    pageIssues: 24,
    workerIssues: 24,
    unexpectedNetworkRequests: 1_000_000,
    overflow: true,
    cleanupFailures: 24,
  });
  assert.equal(JSON.stringify(bounded).includes('SCENARIO_PRIVATE'), false);
});
