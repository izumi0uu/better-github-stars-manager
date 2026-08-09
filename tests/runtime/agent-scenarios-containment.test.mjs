import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'vitest';
import {
  buildExtensionBrowserLaunchOptions,
} from './puppeteer-runtime.mjs';
import {
  buildScenarioFailureDiagnostic,
  installScenarioExtensionWithContainment,
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
      queueMicrotask(() => this.emit('Target.attachedToTarget', {
        sessionId: 'worker-session',
        targetInfo: {
          type: 'service_worker',
          url: 'chrome-extension://scenario-extension/background.js',
        },
      }));
    }
    return {};
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
