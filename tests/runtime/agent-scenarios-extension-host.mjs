#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertRuntimeReleaseDistIdentity,
  MAX_RUNTIME_EVIDENCE_BYTES,
  publishRuntimeEvidence,
  readRuntimeReleaseDistIdentity,
} from '../../scripts/agent-runtime-evidence-contract.mjs';
import {
  assertFailClosedNetworkIsolation,
  launchExtensionBrowser,
} from './puppeteer-runtime.mjs';
import {
  discoverExtension,
  hookPageDiagnostics,
  openExtensionPage,
} from './extension-runtime-targets.mjs';

export const SCENARIO_IDS = Object.freeze([
  'small-window-multiple-tools',
  'overflow-then-success',
  'malformed-summary-fallback',
  'cancel-during-compaction',
  'agent-port-disconnect',
  'organize-cross-batch-recovery',
  'organize-cancel-during-apply',
  'organize-port-reconnect',
  'cubby-artifact-continuation-coverage',
]);

const SCENARIO_EXPECTATIONS = Object.freeze({
  'small-window-multiple-tools': { terminalState: 'completed', eventKinds: ['tool_completed', 'continuation_finished'] },
  'overflow-then-success': { terminalState: 'completed', eventKinds: ['provider_error', 'context_reduction_finished'] },
  'malformed-summary-fallback': { terminalState: 'completed', eventKinds: ['context_reduction_finished', 'provider_finished'] },
  'cancel-during-compaction': { terminalState: 'cancelled', eventKinds: ['context_reduction_finished', 'root_cancelled'] },
  'agent-port-disconnect': { terminalState: 'completed', eventKinds: ['port_disconnected', 'delivery_state'] },
  'organize-cross-batch-recovery': { terminalState: 'completed', eventKinds: ['organize_batch_state', 'organize_durable_state'] },
  'organize-cancel-during-apply': { terminalState: 'cancelled', eventKinds: ['organize_apply_chunk', 'root_cancelled'] },
  'organize-port-reconnect': { terminalState: 'completed', eventKinds: ['organize_durable_state', 'organize_review_state'] },
  'cubby-artifact-continuation-coverage': {
    terminalState: 'completed',
    eventKinds: [
      'provider_request_prepared',
      'provider_finished',
      'tool_completed',
      'continuation_started',
      'continuation_finished',
      'context_reduction_finished',
    ],
    minProviderRequests: 12,
  },
});

const DIAGNOSTICS_PATH = '/src/dev-agent/index.html';
const PRODUCTION_DIST = path.resolve(process.cwd(), process.env.GSM_DIST_DIR ?? 'dist');
const TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 60_000;
const EVIDENCE_MESSAGE_BYTES = 256 * 1024;
const MAX_TRACE_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_EVIDENCE_COUNT = 1_000_000;
const MAX_ISSUE_ITEMS = 24;
const PRIVATE_MARKERS = Object.freeze([
  'SCENARIO_PRIVATE_PROMPT_CANARY',
  'SCENARIO_PRIVATE_RESPONSE_CANARY',
  'SCENARIO_PRIVATE_CURRENT_PROMPT_CANARY',
]);
const STAGES = new Set([
  'arguments',
  'development-build',
  'browser-launch',
  'extension-discovery',
  'worker-containment',
  'page-open',
  'raw-capture',
  'scenario-ready',
  'scenario-run',
  'trace-export',
  'trace-assertions',
  'evidence-identity',
  'evidence-publish',
  'teardown',
  'complete',
]);

if (isDirectExecution()) await main();

async function main() {
  let runtime;
  let primaryFailure = null;
  let teardownFailure = null;

  try {
    runtime = createRuntime(requestedScenarios(process.argv.slice(2)));
    await run(runtime);
  } catch (error) {
    primaryFailure = captureFailure(runtime, error);
  }

  if (runtime) {
    try {
      runtime.stage = 'teardown';
      await teardown(runtime);
    } catch (error) {
      teardownFailure = captureFailure(runtime, error);
    }
  }

  if (primaryFailure || teardownFailure || !runtime) {
    const diagnostic = buildScenarioFailureDiagnostic(
      runtime,
      primaryFailure ?? teardownFailure,
      teardownFailure,
    );
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    process.exitCode = 1;
    return;
  }

  if (process.env.GSM_RUNTIME_EVIDENCE_DIR) {
    try {
      runtime.stage = 'evidence-publish';
      publishRuntimeEvidence({
        directory: process.env.GSM_RUNTIME_EVIDENCE_DIR,
        filename: 'agent-scenarios.schema-v1.json',
        evidence: buildScenarioEvidence(runtime),
        validateEvidence: validateScenarioEvidence,
        privateMarkers: PRIVATE_MARKERS,
      });
    } catch (error) {
      process.stderr.write(`${JSON.stringify(buildScenarioFailureDiagnostic(
        runtime,
        captureFailure(runtime, error),
      ))}\n`);
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    proofScope: 'development_scenario_lab',
    scenarios: runtime.facts.scenarios.rootCount,
    events: runtime.facts.scenarios.eventCount,
    unexpectedNetworkRequests: runtime.network.workerUnexpectedRequests + runtime.pageHttpPolicy.unexpectedRequests.length,
  })}\n`);
}

async function run(runtime) {
  runtime.stage = 'development-build';
  buildDevelopmentExtension(runtime.diagnosticsDist);
  runtime.diagnosticsDist = realpathSync(runtime.diagnosticsDist);

  runtime.stage = 'browser-launch';
  runtime.browser = await launchExtensionBrowser({
    dist: runtime.diagnosticsDist,
    userDataDir: runtime.profile,
    protocolTimeout: SCENARIO_TIMEOUT_MS,
    failClosedNetwork: true,
    deferExtensionInstall: true,
  });
  await assertFailClosedNetworkIsolation(runtime.browser);
  runtime.network.browserIsolationVerified = true;

  runtime.stage = 'worker-containment';
  const installed = await installScenarioExtensionWithContainment(
    runtime.browser,
    runtime.diagnosticsDist,
    runtime,
    { timeoutMs: TIMEOUT_MS },
  );

  runtime.stage = 'extension-discovery';
  const extension = await discoverExtension(runtime.browser, {
    dist: runtime.diagnosticsDist,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(extension.extensionId, installed.extensionId);

  runtime.stage = 'page-open';
  runtime.page = await openExtensionPage(
    runtime.browser,
    extension.extensionId,
    DIAGNOSTICS_PATH,
    'agent-scenario-lab',
    {
      timeoutMs: TIMEOUT_MS,
      readyTimeoutMs: TIMEOUT_MS,
      rootSelector: '[data-testid="agent-diagnostics-page"]',
      failClosedHttp: runtime.pageHttpPolicy,
      beforeNavigation(page) {
        runtime.pageDiagnostics = hookPageDiagnostics(page, 'agent-scenario-lab', {
          issues: runtime.pageIssues,
        });
      },
    },
  );

  runtime.stage = 'raw-capture';
  runtime.rawCapture = await verifyRawCaptureLifecycle(runtime.page);

  for (const [index, scenarioId] of runtime.requested.entries()) {
    runtime.currentScenarioId = scenarioId;
    process.stderr.write(`Running Scenario Lab fixture ${index + 1}/${runtime.requested.length}: ${scenarioId}\n`);
    await selectTab(runtime.page, 'Scenario Lab');
    runtime.stage = 'scenario-ready';
    try {
      await runtime.page.waitForFunction(
        () => document.querySelector('[data-testid="agent-diagnostics-run-scenario"]')?.disabled === false,
        { timeout: TIMEOUT_MS },
      );
    } catch {
      throw new Error('scenario_control_unavailable');
    }
    await runtime.page.select('[data-testid="agent-diagnostics-scenario-id"]', scenarioId);
    await clickSelector(runtime.page, '[data-testid="agent-diagnostics-run-scenario"]');
    runtime.stage = 'scenario-run';
    await waitForScenarioCompletion(runtime.page, index + 1);
  }

  if (runtime.requested.includes('cubby-artifact-continuation-coverage')) {
    await runtime.page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await runtime.page.waitForSelector('[data-testid="agent-diagnostics-page"]', { timeout: TIMEOUT_MS });
    await selectTab(runtime.page, 'Traces');
    await waitForScenarioCompletion(runtime.page, runtime.requested.length);
  }

  runtime.stage = 'trace-export';
  const artifact = await exportArtifact(runtime.page);
  runtime.stage = 'trace-assertions';
  runtime.facts = assertScenarioArtifact(artifact, runtime);

  if (process.env.GSM_RUNTIME_EVIDENCE_DIR) {
    runtime.stage = 'evidence-identity';
    runtime.releaseDist = readRuntimeReleaseDistIdentity(PRODUCTION_DIST);
    runtime.diagnosticsBuild = readRuntimeReleaseDistIdentity(runtime.diagnosticsDist);
    assert.notDeepEqual(runtime.diagnosticsBuild, runtime.releaseDist,
      'Scenario diagnostics build must remain distinct from the bound production package.');
  }
  runtime.stage = 'complete';
}

function createRuntime(requested) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'bgsm-agent-scenarios-'));
  return {
    requested,
    tempRoot,
    diagnosticsDist: path.join(tempRoot, 'dist'),
    profile: path.join(tempRoot, 'profile'),
    stage: 'arguments',
    currentScenarioId: null,
    browser: null,
    page: null,
    workerBrowserClient: null,
    workerAttachedListener: null,
    workerDetachedListener: null,
    workerAutoAttachActive: false,
    workerResources: new Set(),
    workerSetupTasks: new Set(),
    workerRecords: [],
    workerSetupFailure: null,
    pageDiagnostics: null,
    pageIssues: [],
    pageHttpPolicy: {
      unexpectedRequests: [],
      expectedRequests: [],
      overflow: false,
      interceptionFailure: false,
      close: null,
    },
    network: {
      browserIsolationVerified: false,
      workerUnexpectedRequests: 0,
      workerOverflow: false,
      workerInterceptionFailure: false,
    },
    rawCapture: null,
    facts: null,
    releaseDist: null,
    diagnosticsBuild: null,
    cleanupFailures: 0,
    cleanup: {
      networkGatesClosed: false,
      diagnosticsDetached: false,
      pagesClosed: false,
      browserClosed: false,
      temporaryStateRemoved: false,
    },
  };
}
export async function installScenarioExtensionWithContainment(browser, dist, runtime, {
  timeoutMs = TIMEOUT_MS,
} = {}) {
  if (!browser || typeof browser.installExtension !== 'function' || typeof browser.target !== 'function') {
    throw new Error('worker_containment_unavailable');
  }
  if (!runtime || !runtime.network || !Array.isArray(runtime.workerRecords)) {
    throw new TypeError('Scenario runtime must expose bounded worker containment state.');
  }
  runtime.workerResources ??= new Set();
  runtime.workerSetupTasks ??= new Set();

  const browserClient = await browser.target().createCDPSession();
  runtime.workerBrowserClient = browserClient;
  let rejectSetupFailure;
  const setupFailure = new Promise((_, reject) => { rejectSetupFailure = reject; });
  setupFailure.catch(() => {});

  const onAttached = (event) => {
    if (event.targetInfo?.type !== 'service_worker') return;
    const client = browserClient.connection().session(event.sessionId);
    const overflow = runtime.workerRecords.length >= MAX_ISSUE_ITEMS;
    if (overflow) runtime.network.workerOverflow = true;
    const overflowError = overflow ? new Error('worker_containment_overflow') : null;
    if (!client) {
      const error = overflowError ?? new Error('worker_containment_session_missing');
      runtime.workerSetupFailure ??= error;
      rejectSetupFailure(error);
      return;
    }
    const record = {
      sessionId: event.sessionId,
      targetUrl: event.targetInfo.url,
      client,
      listeners: null,
      fetchEnabled: false,
      resumed: false,
      detached: false,
    };
    runtime.workerResources.add(record);
    if (!overflow) runtime.workerRecords.push(record);
    let setupTask;
    setupTask = configurePausedWorker(record, runtime)
      .catch((setupError) => {
        runtime.workerSetupFailure ??= overflowError ?? setupError;
        rejectSetupFailure(runtime.workerSetupFailure);
      })
      .then(() => {
        if (overflowError) {
          runtime.workerSetupFailure ??= overflowError;
          rejectSetupFailure(runtime.workerSetupFailure);
        }
      })
      .finally(() => runtime.workerSetupTasks.delete(setupTask));
    runtime.workerSetupTasks.add(setupTask);
  };
  const onDetached = (event) => {
    const record = [...runtime.workerResources].find((candidate) => candidate.sessionId === event.sessionId);
    if (record) record.detached = true;
  };
  runtime.workerAttachedListener = onAttached;
  runtime.workerDetachedListener = onDetached;
  browserClient.on('Target.attachedToTarget', onAttached);
  browserClient.on('Target.detachedFromTarget', onDetached);
  await browserClient.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [
      { type: 'service_worker', exclude: false },
      { exclude: true },
    ],
  });
  runtime.workerAutoAttachActive = true;

  const extensionId = await withTimeout(
    Promise.race([
      Promise.resolve().then(() => browser.installExtension(dist)),
      setupFailure,
    ]),
    timeoutMs,
    'worker_containment_install_timeout',
  );
  if (typeof extensionId !== 'string' || extensionId.length === 0) {
    throw new Error('worker_containment_install_failed');
  }
  await waitUntil(
    () => {
      if (runtime.workerSetupFailure) throw runtime.workerSetupFailure;
      return runtime.workerRecords.find((record) => (
        record.resumed
        && record.targetUrl.startsWith(`chrome-extension://${extensionId}/`)
      )) ?? null;
    },
    timeoutMs,
    'worker_containment_startup_timeout',
  );
  return Object.freeze({ extensionId });
}
async function configurePausedWorker(record, runtime) {
  const onException = () => recordWorkerIssue(runtime, 'exception');
  const onConsole = (event) => {
    if (event.type === 'error') recordWorkerIssue(runtime, 'console-error');
  };
  const onRequestPaused = (event) => {
    incrementBoundedNetworkCount(runtime.network);
    void record.client.send('Fetch.failRequest', {
      requestId: event.requestId,
      errorReason: 'BlockedByClient',
    }).catch(() => {
      runtime.network.workerInterceptionFailure = true;
    });
  };
  record.listeners = { onException, onConsole, onRequestPaused };
  record.client.on('Runtime.exceptionThrown', onException);
  record.client.on('Runtime.consoleAPICalled', onConsole);
  record.client.on('Fetch.requestPaused', onRequestPaused);
  await record.client.send('Runtime.enable');
  await record.client.send('Fetch.enable', {
    patterns: [
      { urlPattern: 'http://*', requestStage: 'Request' },
      { urlPattern: 'https://*', requestStage: 'Request' },
    ],
  });
  record.fetchEnabled = true;
  await record.client.send('Runtime.runIfWaitingForDebugger');
  record.resumed = true;
}

function recordWorkerIssue(runtime, kind) {
  runtime.workerIssueCounts ??= { exception: 0, consoleError: 0, overflow: false };
  const key = kind === 'exception' ? 'exception' : 'consoleError';
  if (runtime.workerIssueCounts[key] >= MAX_ISSUE_ITEMS) {
    runtime.workerIssueCounts.overflow = true;
    return;
  }
  runtime.workerIssueCounts[key] += 1;
}

function incrementBoundedNetworkCount(network) {
  if (network.workerUnexpectedRequests >= MAX_EVIDENCE_COUNT) {
    network.workerOverflow = true;
    return;
  }
  network.workerUnexpectedRequests += 1;
}

function assertScenarioArtifact(artifact, runtime) {
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.roots.length, runtime.requested.length);
  assert.equal(artifact.integrity.rootCount, runtime.requested.length);
  assert.equal(artifact.events.at(-1)?.kind, 'root_terminal');

  for (const [index, scenarioId] of runtime.requested.entries()) {
    const rootEntry = artifact.roots[index];
    const expected = SCENARIO_EXPECTATIONS[scenarioId];
    assert.equal(rootEntry.terminalState, expected.terminalState, `${scenarioId} terminal state`);
    const eventKinds = new Set(artifact.events
      .filter((event) => event.rootOperationId === rootEntry.rootOperationId)
      .map((event) => event.kind));
    for (const eventKind of expected.eventKinds) {
      assert.equal(eventKinds.has(eventKind), true, `${scenarioId} is missing ${eventKind}`);
    }
    if (scenarioId === 'organize-cancel-during-apply') {
      const applyStates = artifact.events
        .filter((event) => event.rootOperationId === rootEntry.rootOperationId && event.kind === 'organize_apply_state')
        .map((event) => event.data.state);
      assert.equal(applyStates.includes('pause_requested'), true);
      assert.equal(applyStates.includes('paused'), true);
    }
  }

  const coverageIndex = runtime.requested.indexOf('cubby-artifact-continuation-coverage');
  const coverageRoot = coverageIndex < 0 ? null : artifact.roots[coverageIndex];
  const artifactContinuationProviderRequests = coverageRoot === null ? 0 : artifact.events.filter((event) => (
    event.rootOperationId === coverageRoot.rootOperationId
    && event.kind === 'provider_request_prepared'
  )).length;
  if (coverageRoot) {
    assert.equal(
      artifactContinuationProviderRequests >= SCENARIO_EXPECTATIONS['cubby-artifact-continuation-coverage'].minProviderRequests,
      true,
      'artifact coverage scenario must cross more than eight controlled Provider requests',
    );
  }

  const serializedArtifact = JSON.stringify(artifact);
  const rawCredentialOccurrences = [
    /\bauthorization\b/iu,
    /\bbearer\b/iu,
    /\bcookie\b/iu,
    /github_pat_|ghp_|sk-|api[-_ ]?key/iu,
  ].reduce((count, pattern) => count + (pattern.test(serializedArtifact) ? 1 : 0), 0);
  const privatePayloadOccurrences = PRIVATE_MARKERS.reduce(
    (count, marker) => count + (serializedArtifact.includes(marker) ? 1 : 0),
    0,
  );
  const writeOutcomeEvents = artifact.events.filter((event) => event.kind === 'tool_write_outcome').length;
  const workerIssueCount = totalWorkerIssues(runtime);
  const terminalStates = artifact.roots.map((entry) => entry.terminalState);
  const completedCount = terminalStates.filter((state) => state === 'completed').length;
  const cancelledCount = terminalStates.filter((state) => state === 'cancelled').length;
  const failedCount = terminalStates.length - completedCount - cancelledCount;

  assert.equal(runtime.network.workerUnexpectedRequests, 0);
  assert.equal(runtime.pageHttpPolicy.unexpectedRequests.length, 0);
  assert.equal(runtime.pageHttpPolicy.interceptionFailure, false);
  assert.equal(runtime.network.workerInterceptionFailure, false);
  assert.equal(runtime.pageIssues.length, 0);
  assert.equal(workerIssueCount, 0);
  assert.equal(rawCredentialOccurrences, 0);
  assert.equal(privatePayloadOccurrences, 0);
  assert.equal(writeOutcomeEvents, 0);
  assert.equal(failedCount, 0);

  return Object.freeze({
    scenarios: Object.freeze({
      ids: Object.freeze([...runtime.requested]),
      rootCount: artifact.roots.length,
      eventCount: artifact.events.length,
      completedCount,
      cancelledCount,
      failedCount,
      lastEventTerminal: artifact.events.at(-1)?.kind === 'root_terminal',
      artifactContinuationProviderRequests,
      writeOutcomeEvents,
    }),
    rawCapture: Object.freeze({ ...runtime.rawCapture }),
    issues: Object.freeze({ page: runtime.pageIssues.length, worker: workerIssueCount }),
    rawCredentialOccurrences,
    privatePayloadOccurrences,
  });
}

async function verifyRawCaptureLifecycle(page) {
  const warning = await page.$eval(
    '[data-testid="agent-diagnostics-raw-capture"]',
    (element) => element.textContent ?? '',
  );
  assert.match(warning, /repository code and private notes/u);
  assert.match(warning, /Codex or browser automation/u);
  assert.match(warning, /unrecognized secret/u);

  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-diagnostics-toggle-raw-capture"]')?.disabled === false,
    { timeout: TIMEOUT_MS },
  );
  await clickSelector(page, '[data-testid="agent-diagnostics-toggle-raw-capture"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-diagnostics-raw-status"]')?.textContent?.includes('Armed for the next real Cubby run'),
    { timeout: TIMEOUT_MS },
  );

  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForSelector('[data-testid="agent-diagnostics-page"]', { timeout: TIMEOUT_MS });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-diagnostics-toggle-raw-capture"]')?.disabled === false,
    { timeout: TIMEOUT_MS },
  );
  await clickSelector(page, '[data-testid="agent-diagnostics-toggle-raw-capture"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-diagnostics-raw-status"]')?.textContent?.includes('Armed for the next real Cubby run'),
    { timeout: TIMEOUT_MS },
  );
  await clickSelector(page, '[data-testid="agent-diagnostics-toggle-raw-capture"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-diagnostics-raw-status"]')?.textContent?.includes('Not armed'),
    { timeout: TIMEOUT_MS },
  );

  return Object.freeze({
    warningRendered: true,
    armedBeforeReload: true,
    disarmedAfterReload: true,
  });
}

function buildDevelopmentExtension(outDir) {
  const pnpmExecPath = process.env.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const args = pnpmExecPath ? [pnpmExecPath, 'build'] : ['pnpm', 'build'];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GSM_DEV: 'true',
      GSM_RELEASE: 'false',
      GSM_DIST_DIR: outDir,
    },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.error || result.status !== 0) throw new Error('development_build_failed');
}

async function clickSelector(page, selector) {
  await page.evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector);
    if (!(element instanceof HTMLElement)) throw new Error('missing_diagnostics_control');
    element.click();
  }, selector);
}

async function waitForScenarioCompletion(page, minimumRoots) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const completed = await page.evaluate((expectedRoots) => {
      const traces = [...document.querySelectorAll('[role="tab"]')]
        .find((element) => element.textContent === 'Traces');
      const runs = document.querySelectorAll('[data-testid="agent-diagnostics-runs"] > li');
      return traces?.getAttribute('aria-selected') === 'true' && runs.length >= expectedRoots;
    }, minimumRoots);
    if (completed) return;
    await delay(100);
  }
  throw new Error('scenario_timeout');
}

async function selectTab(page, label) {
  await page.evaluate((tabLabel) => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((element) => element.textContent === tabLabel);
    if (!(tab instanceof HTMLButtonElement)) throw new Error('missing_diagnostics_tab');
    tab.click();
  }, label);
  await page.waitForFunction(
    (tabLabel) => [...document.querySelectorAll('[role="tab"]')]
      .some((element) => element.textContent === tabLabel && element.getAttribute('aria-selected') === 'true'),
    { timeout: TIMEOUT_MS },
    label,
  );
}

async function exportArtifact(page) {
  return page.evaluate((messageBytes, maxArtifactBytes) => new Promise((resolve, reject) => {
    const requestId = `runtime-export-${crypto.randomUUID()}`;
    const chunks = [];
    const scope = { kind: 'all_retained', id: null };
    let snapshotId = null;
    let nextChunkIndex = 0;
    let totalBytes = 0;
    const port = chrome.runtime.connect({ name: 'bgsm-agent-dev-evidence-v1' });
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('trace_export_timeout'));
    }, 30_000);
    const requestChunk = (cursor) => port.postMessage({
      version: 1,
      requestId,
      type: 'export',
      scope,
      cursor,
      maxBytes: messageBytes,
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        reject(new Error('trace_export_disconnected'));
      }
    });
    port.onMessage.addListener((message) => {
      if (message?.type === 'ready') {
        requestChunk(null);
        return;
      }
      if (message?.requestId !== requestId) return;
      if (message.type === 'evidence_error') {
        clearTimeout(timer);
        port.disconnect();
        reject(new Error('trace_export_rejected'));
        return;
      }
      if (message.type !== 'export_chunk') return;
      const actualBytes = new TextEncoder().encode(message.jsonChunk).byteLength;
      totalBytes += actualBytes;
      if (
        message.chunkIndex !== nextChunkIndex
        || message.byteLength !== actualBytes
        || message.done !== (message.cursor === null)
        || (snapshotId !== null && message.snapshotId !== snapshotId)
        || totalBytes > maxArtifactBytes
      ) {
        clearTimeout(timer);
        port.disconnect();
        reject(new Error('trace_export_invalid'));
        return;
      }
      snapshotId ??= message.snapshotId;
      chunks.push(message.jsonChunk);
      nextChunkIndex += 1;
      if (!message.done) {
        requestChunk(message.cursor);
        return;
      }
      clearTimeout(timer);
      port.disconnect();
      try {
        resolve(JSON.parse(chunks.join('')));
      } catch {
        reject(new Error('trace_export_invalid'));
      }
    });
  }), EVIDENCE_MESSAGE_BYTES, MAX_TRACE_ARTIFACT_BYTES);
}

export function buildScenarioEvidence(runtime) {
  return {
    schemaVersion: 1,
    status: 'passed',
    proofScope: 'development_scenario_lab',
    productionDistExercised: false,
    releaseDist: runtime.releaseDist,
    diagnosticsBuild: runtime.diagnosticsBuild,
    scenarioLab: {
      scenarios: { ...runtime.facts.scenarios },
      rawCapture: { ...runtime.facts.rawCapture },
      issues: { ...runtime.facts.issues },
    },
    containment: {
      networkFailClosed: runtime.network.browserIsolationVerified,
      unexpectedNetworkRequests: runtime.network.workerUnexpectedRequests
        + runtime.pageHttpPolicy.unexpectedRequests.length,
      rawCredentialOccurrences: runtime.facts.rawCredentialOccurrences,
      privatePayloadOccurrences: runtime.facts.privatePayloadOccurrences,
      overflow: runtime.network.workerOverflow
        || runtime.network.workerInterceptionFailure
        || runtime.pageHttpPolicy.overflow
        || runtime.pageHttpPolicy.interceptionFailure
        || runtime.workerIssueCounts?.overflow === true,
    },
    cleanup: { ...runtime.cleanup },
    evidenceBytes: 0,
  };
}

export function validateScenarioEvidence(value) {
  exactKeys(value, [
    'schemaVersion',
    'status',
    'proofScope',
    'productionDistExercised',
    'releaseDist',
    'diagnosticsBuild',
    'scenarioLab',
    'containment',
    'cleanup',
    'evidenceBytes',
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.status, 'passed');
  assert.equal(value.proofScope, 'development_scenario_lab');
  assert.equal(value.productionDistExercised, false);
  assertRuntimeReleaseDistIdentity(value.releaseDist);
  assertRuntimeReleaseDistIdentity(value.diagnosticsBuild);
  assert.notDeepEqual(value.diagnosticsBuild, value.releaseDist);

  exactKeys(value.scenarioLab, ['scenarios', 'rawCapture', 'issues']);
  exactKeys(value.scenarioLab.scenarios, [
    'ids',
    'rootCount',
    'eventCount',
    'completedCount',
    'cancelledCount',
    'failedCount',
    'lastEventTerminal',
    'artifactContinuationProviderRequests',
    'writeOutcomeEvents',
  ]);
  assert.deepEqual(value.scenarioLab.scenarios.ids, SCENARIO_IDS);
  for (const key of [
    'rootCount',
    'eventCount',
    'completedCount',
    'cancelledCount',
    'failedCount',
    'artifactContinuationProviderRequests',
    'writeOutcomeEvents',
  ]) assertBoundedEvidenceCount(value.scenarioLab.scenarios[key]);
  const scenarios = value.scenarioLab.scenarios;
  const expectedCancelled = SCENARIO_IDS.filter((id) => SCENARIO_EXPECTATIONS[id].terminalState === 'cancelled').length;
  assert.equal(scenarios.rootCount, SCENARIO_IDS.length);
  assert.equal(scenarios.completedCount, SCENARIO_IDS.length - expectedCancelled);
  assert.equal(scenarios.cancelledCount, expectedCancelled);
  assert.equal(scenarios.failedCount, 0);
  assert.equal(scenarios.completedCount + scenarios.cancelledCount, scenarios.rootCount);
  assert.equal(scenarios.eventCount > 0, true);
  assert.equal(scenarios.lastEventTerminal, true);
  assert.equal(
    scenarios.artifactContinuationProviderRequests
      >= SCENARIO_EXPECTATIONS['cubby-artifact-continuation-coverage'].minProviderRequests,
    true,
  );
  assert.equal(scenarios.writeOutcomeEvents, 0);

  exactKeys(value.scenarioLab.rawCapture, ['warningRendered', 'armedBeforeReload', 'disarmedAfterReload']);
  assert.deepEqual(value.scenarioLab.rawCapture, {
    warningRendered: true,
    armedBeforeReload: true,
    disarmedAfterReload: true,
  });
  exactKeys(value.scenarioLab.issues, ['page', 'worker']);
  assert.deepEqual(value.scenarioLab.issues, { page: 0, worker: 0 });

  exactKeys(value.containment, [
    'networkFailClosed',
    'unexpectedNetworkRequests',
    'rawCredentialOccurrences',
    'privatePayloadOccurrences',
    'overflow',
  ]);
  assert.deepEqual(value.containment, {
    networkFailClosed: true,
    unexpectedNetworkRequests: 0,
    rawCredentialOccurrences: 0,
    privatePayloadOccurrences: 0,
    overflow: false,
  });
  exactKeys(value.cleanup, [
    'networkGatesClosed',
    'diagnosticsDetached',
    'pagesClosed',
    'browserClosed',
    'temporaryStateRemoved',
  ]);
  assert.equal(Object.values(value.cleanup).every((entry) => entry === true), true);
  assert.equal(
    Number.isSafeInteger(value.evidenceBytes)
      && value.evidenceBytes > 0
      && value.evidenceBytes <= MAX_RUNTIME_EVIDENCE_BYTES,
    true,
  );
}

async function teardown(runtime) {
  const cleanup = async (operation) => {
    try {
      await operation();
      return true;
    } catch {
      runtime.cleanupFailures += 1;
      return false;
    }
  };

  const pageGateClosed = await cleanup(async () => {
    await runtime.pageHttpPolicy.close?.();
    if (runtime.pageHttpPolicy.close && runtime.pageHttpPolicy.closed !== true) {
      throw new Error('page_gate_close_failed');
    }
  });
  const pageDiagnosticsDetached = await cleanup(async () => runtime.pageDiagnostics?.cleanup());
  const workerRecords = [
    ...new Set([
      ...(runtime.workerRecords ?? []),
      ...(runtime.workerResources ?? []),
    ]),
  ];
  if (
    runtime.workerSetupFailure === null
    && workerRecords.every((record) => record.resumed || record.detached)
  ) {
    await Promise.allSettled([...(runtime.workerSetupTasks ?? [])]);
  }
  const hasPausedWorker = runtime.workerSetupFailure !== null
    || workerRecords.some((record) => !record.resumed && !record.detached);

  let workerGateClosed = false;
  let workerDiagnosticsDetached = false;
  if (!hasPausedWorker) {
    await Promise.allSettled([...(runtime.workerSetupTasks ?? [])]);
    workerGateClosed = await cleanup(async () => {
      for (const record of workerRecords) {
        if (record.fetchEnabled && !record.detached) await record.client.send('Fetch.disable');
        record.fetchEnabled = false;
      }
      if (runtime.workerAutoAttachActive) {
        await runtime.workerBrowserClient.send('Target.setAutoAttach', {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        runtime.workerAutoAttachActive = false;
      }
    });
    workerDiagnosticsDetached = await cleanup(async () => {
      const parent = runtime.workerBrowserClient;
      if (parent && runtime.workerAttachedListener) {
        removeListener(parent, 'Target.attachedToTarget', runtime.workerAttachedListener);
      }
      if (parent && runtime.workerDetachedListener) {
        removeListener(parent, 'Target.detachedFromTarget', runtime.workerDetachedListener);
      }
      for (const record of workerRecords) {
        if (record.listeners) {
          removeListener(record.client, 'Runtime.exceptionThrown', record.listeners.onException);
          removeListener(record.client, 'Runtime.consoleAPICalled', record.listeners.onConsole);
          removeListener(record.client, 'Fetch.requestPaused', record.listeners.onRequestPaused);
          record.listeners = null;
        }
        if (!record.detached) {
          await record.client.send('Runtime.disable').catch(() => {});
          await record.client.detach();
        }
      }
      runtime.workerResources?.clear();
      runtime.workerSetupTasks?.clear();
      await parent?.detach();
      runtime.workerBrowserClient = null;
    });
  }

  runtime.cleanup.pagesClosed = await cleanup(async () => {
    if (runtime.page && !runtime.page.isClosed()) await runtime.page.close();
    if (runtime.page && !runtime.page.isClosed()) throw new Error('page_close_failed');
  });
  runtime.cleanup.browserClosed = await cleanup(async () => closeBrowser(runtime.browser));
  if (hasPausedWorker) {
    await Promise.allSettled([...(runtime.workerSetupTasks ?? [])]);
    workerGateClosed = runtime.cleanup.browserClosed;
    workerDiagnosticsDetached = await cleanup(async () => {
      const parent = runtime.workerBrowserClient;
      if (parent && runtime.workerAttachedListener) {
        removeListener(parent, 'Target.attachedToTarget', runtime.workerAttachedListener);
      }
      if (parent && runtime.workerDetachedListener) {
        removeListener(parent, 'Target.detachedFromTarget', runtime.workerDetachedListener);
      }
      for (const record of workerRecords) {
        if (!record.listeners) continue;
        removeListener(record.client, 'Runtime.exceptionThrown', record.listeners.onException);
        removeListener(record.client, 'Runtime.consoleAPICalled', record.listeners.onConsole);
        removeListener(record.client, 'Fetch.requestPaused', record.listeners.onRequestPaused);
        record.listeners = null;
      }
      runtime.workerBrowserClient = null;
      runtime.workerResources?.clear();
      runtime.workerSetupTasks?.clear();
    });
  }
  runtime.cleanup.networkGatesClosed = pageGateClosed && workerGateClosed;
  runtime.cleanup.diagnosticsDetached = pageDiagnosticsDetached && workerDiagnosticsDetached;
  runtime.cleanup.temporaryStateRemoved = await cleanup(async () => {
    rmSync(runtime.tempRoot, { recursive: true, force: true });
    if (existsSync(runtime.tempRoot)) throw new Error('temporary_state_remove_failed');
  });

  if (runtime.cleanupFailures > 0) throw new Error('cleanup_failed');
}

async function closeBrowser(browser) {
  if (!browser) return;
  const browserProcess = browser.process();
  let gracefullyClosed = false;
  await Promise.race([
    browser.close().then(() => { gracefullyClosed = true; }),
    delay(3_000),
  ]);
  if (gracefullyClosed) return;
  if (!browserProcess || browserProcess.killed || !browserProcess.kill('SIGKILL')) {
    throw new Error('browser_close_failed');
  }
  await Promise.race([
    new Promise((resolve) => browserProcess.once('exit', resolve)),
    delay(2_000),
  ]);
  if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
    throw new Error('browser_close_failed');
  }
}

function removeListener(emitter, event, listener) {
  if (typeof emitter.off === 'function') emitter.off(event, listener);
  else emitter.removeListener?.(event, listener);
}

function requestedScenarios(args) {
  if (args.length === 0) return [...SCENARIO_IDS];
  if (args.length !== 2 || args[0] !== '--scenario' || !SCENARIO_IDS.includes(args[1])) {
    throw new Error('invalid_arguments');
  }
  if (process.env.GSM_RUNTIME_EVIDENCE_DIR) {
    throw new Error('evidence_requires_complete_scenario_set');
  }
  return [args[1]];
}

function captureFailure(runtime, error) {
  return {
    stage: runtime && STAGES.has(runtime.stage) ? runtime.stage : 'arguments',
    error,
  };
}

export function buildScenarioFailureDiagnostic(runtime, failure, teardownFailure = null) {
  const stage = failure && STAGES.has(failure.stage) ? failure.stage : 'arguments';
  return {
    status: 'failed',
    proofScope: 'development_scenario_lab',
    stage,
    code: failureCode(stage, failure?.error),
    teardownCode: teardownFailure === null
      ? 'none'
      : failureCode('teardown', teardownFailure.error),
    scenarioId: runtime?.currentScenarioId && SCENARIO_IDS.includes(runtime.currentScenarioId)
      ? runtime.currentScenarioId
      : 'none',
    rootCount: runtime?.facts?.scenarios?.rootCount ?? 0,
    pageIssues: Math.min(runtime?.pageIssues?.length ?? 0, MAX_ISSUE_ITEMS),
    workerIssues: Math.min(totalWorkerIssues(runtime), MAX_ISSUE_ITEMS),
    unexpectedNetworkRequests: Math.min(
      (runtime?.network?.workerUnexpectedRequests ?? 0)
        + (runtime?.pageHttpPolicy?.unexpectedRequests?.length ?? 0),
      MAX_EVIDENCE_COUNT,
    ),
    overflow: runtime?.network?.workerOverflow === true
      || runtime?.pageHttpPolicy?.overflow === true
      || runtime?.workerIssueCounts?.overflow === true,
    cleanupFailures: Math.min(runtime?.cleanupFailures ?? 0, MAX_ISSUE_ITEMS),
  };
}

function failureCode(stage, error) {
  const explicit = error instanceof Error ? error.message : '';
  const allowed = new Set([
    'invalid_arguments',
    'evidence_requires_complete_scenario_set',
    'development_build_failed',
    'worker_containment_unavailable',
    'worker_containment_overflow',
    'worker_containment_session_missing',
    'worker_containment_install_timeout',
    'worker_containment_install_failed',
    'worker_containment_startup_timeout',
    'scenario_control_unavailable',
    'scenario_timeout',
    'trace_export_timeout',
    'trace_export_disconnected',
    'trace_export_rejected',
    'trace_export_invalid',
    'cleanup_failed',
  ]);
  if (allowed.has(explicit)) return explicit;
  return {
    'browser-launch': 'browser_launch_failed',
    'extension-discovery': 'extension_discovery_failed',
    'page-open': 'page_open_failed',
    'raw-capture': 'raw_capture_failed',
    'scenario-ready': 'scenario_ready_failed',
    'scenario-run': 'scenario_run_failed',
    'trace-export': 'trace_export_failed',
    'trace-assertions': 'trace_assertion_failed',
    'evidence-identity': 'evidence_identity_failed',
    'evidence-publish': 'evidence_publish_failed',
    teardown: 'cleanup_failed',
  }[stage] ?? 'unexpected_failure';
}

function totalWorkerIssues(runtime) {
  return (runtime?.workerIssueCounts?.exception ?? 0) + (runtime?.workerIssueCounts?.consoleError ?? 0);
}

function exactKeys(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value), keys);
}

function assertBoundedEvidenceCount(value) {
  assert.equal(Number.isSafeInteger(value) && value >= 0 && value <= MAX_EVIDENCE_COUNT, true);
}

function isDirectExecution() {
  return typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(read, timeoutMs, timeoutCode) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(timeoutCode);
}

async function withTimeout(promise, timeoutMs, timeoutCode) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutCode)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
