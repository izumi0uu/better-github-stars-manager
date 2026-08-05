#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchExtensionBrowser } from './puppeteer-runtime.mjs';

const SCENARIOS = [
  'small-window-multiple-tools',
  'overflow-then-success',
  'malformed-summary-fallback',
  'cancel-during-compaction',
  'agent-port-disconnect',
  'organize-cross-batch-recovery',
  'organize-cancel-during-apply',
  'organize-port-reconnect',
];
const SCENARIO_EXPECTATIONS = {
  'small-window-multiple-tools': { terminalState: 'completed', eventKinds: ['tool_completed', 'continuation_finished'] },
  'overflow-then-success': { terminalState: 'completed', eventKinds: ['provider_error', 'context_reduction_finished'] },
  'malformed-summary-fallback': { terminalState: 'completed', eventKinds: ['context_reduction_finished', 'provider_finished'] },
  'cancel-during-compaction': { terminalState: 'cancelled', eventKinds: ['context_reduction_finished', 'root_cancelled'] },
  'agent-port-disconnect': { terminalState: 'completed', eventKinds: ['port_disconnected', 'delivery_state'] },
  'organize-cross-batch-recovery': { terminalState: 'completed', eventKinds: ['organize_batch_state', 'organize_durable_state'] },
  'organize-cancel-during-apply': { terminalState: 'cancelled', eventKinds: ['organize_apply_chunk', 'root_cancelled'] },
  'organize-port-reconnect': { terminalState: 'completed', eventKinds: ['organize_durable_state', 'organize_review_state'] },
};
const DIAGNOSTICS_PATH = '/src/dev-agent/index.html';
const TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 60_000;
const root = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'bgsm-agent-scenarios-'));
const dist = path.join(tempRoot, 'dist');
const profile = path.join(tempRoot, 'profile');
const requested = requestedScenarios(process.argv.slice(2));
let browser;
let workerClient;
const workerIssues = [];

try {
  buildDevelopmentExtension(dist);
  browser = await launchExtensionBrowser({ dist, userDataDir: profile });
  const { extId, target } = await findExtension(browser, dist);
  const unexpectedNetwork = [];
  workerClient = await target.createCDPSession();
  await workerClient.send('Runtime.enable');
  workerClient.on('Runtime.exceptionThrown', (event) => {
    const details = event.exceptionDetails;
    workerIssues.push(details.exception?.description ?? details.text ?? 'Unknown service-worker exception');
  });
  workerClient.on('Runtime.consoleAPICalled', (event) => {
    if (event.type !== 'error') return;
    workerIssues.push(event.args.map((argument) => argument.value ?? argument.description ?? '').join(' '));
  });
  await workerClient.send('Fetch.enable', {
    patterns: [
      { urlPattern: 'http://*', requestStage: 'Request' },
      { urlPattern: 'https://*', requestStage: 'Request' },
    ],
  });
  workerClient.on('Fetch.requestPaused', (event) => {
    unexpectedNetwork.push(event.request.url);
    void workerClient.send('Fetch.failRequest', {
      requestId: event.requestId,
      errorReason: 'BlockedByClient',
    }).catch(() => {});
  });

  const page = await browser.newPage();
  const pageIssues = [];
  page.on('pageerror', (error) => pageIssues.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageIssues.push(`console: ${message.text()}`);
  });
  await page.goto(`chrome-extension://${extId}${DIAGNOSTICS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT_MS,
  });
  await page.waitForSelector('[data-testid="agent-diagnostics-page"]', { timeout: TIMEOUT_MS });
  await verifyRawCaptureLifecycle(page);

  for (const [index, scenarioId] of requested.entries()) {
    process.stderr.write(`Running Scenario Lab fixture ${index + 1}/${requested.length}: ${scenarioId}\n`);
    await selectTab(page, 'Scenario Lab');
    try {
      await page.waitForFunction(
        () => document.querySelector('[data-testid="agent-diagnostics-run-scenario"]')?.disabled === false,
        { timeout: TIMEOUT_MS },
      );
    } catch (error) {
      throw new Error(`Scenario Lab control did not become ready: ${JSON.stringify(await readDiagnosticsState(page, pageIssues, workerIssues))}`, {
        cause: error,
      });
    }
    await page.select('[data-testid="agent-diagnostics-scenario-id"]', scenarioId);
    await clickSelector(page, '[data-testid="agent-diagnostics-run-scenario"]');
    try {
      await waitForScenarioCompletion(page, index + 1);
    } catch (error) {
      throw new Error(`Scenario Lab fixture ${scenarioId} did not complete: ${JSON.stringify(await readDiagnosticsState(page, pageIssues, workerIssues))}`, {
        cause: error,
      });
    }
  }

  const artifact = await exportArtifact(page);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.roots.length, requested.length);
  assert.equal(artifact.integrity.rootCount, requested.length);
  assert.equal(artifact.events.at(-1)?.kind, 'root_terminal');
  for (const [index, scenarioId] of requested.entries()) {
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
  assert.equal(unexpectedNetwork.length, 0, `Scenario Lab attempted network access: ${unexpectedNetwork.join(', ')}`);
  assert.deepEqual(pageIssues, []);
  assert.deepEqual(workerIssues, []);
  assert.equal(JSON.stringify(artifact).includes('SCENARIO_PRIVATE'), false);
  assert.equal(artifact.events.some((event) => event.kind === 'tool_write_outcome'), false);

  const terminalStates = artifact.roots.map((entry) => entry.terminalState);
  assert.equal(terminalStates.filter((state) => state === 'cancelled').length,
    requested.filter((id) => id === 'cancel-during-compaction' || id === 'organize-cancel-during-apply').length);
  process.stderr.write(`Scenario Lab runtime passed (${artifact.roots.length} roots, ${artifact.events.length} events, zero network requests).\n`);
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
} finally {
  await workerClient?.detach().catch(() => {});
  const browserProcess = browser?.process();
  await Promise.race([
    browser?.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (browserProcess && !browserProcess.killed) browserProcess.kill('SIGKILL');
  rmSync(tempRoot, { recursive: true, force: true });
}

function requestedScenarios(args) {
  if (args.length === 0) return SCENARIOS;
  if (args.length !== 2 || args[0] !== '--scenario' || !SCENARIOS.includes(args[1])) {
    throw new Error(`Use --scenario <${SCENARIOS.join('|')}> or omit it to run all fixtures.`);
  }
  return [args[1]];
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
}

function buildDevelopmentExtension(outDir) {
  const pnpmExecPath = process.env.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const args = pnpmExecPath ? [pnpmExecPath, 'build'] : ['pnpm', 'build'];
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      GSM_DEV: 'true',
      GSM_RELEASE: 'false',
      GSM_DIST_DIR: outDir,
    },
    encoding: 'utf8',
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  assert.equal(result.status, 0, 'Scenario Lab development build failed.');
}

async function findExtension(browser, extensionPath) {
  const deadline = Date.now() + 20_000;
  const expectedPath = realpathSync(extensionPath);
  let lastState = 'extension discovery returned no data';
  while (Date.now() < deadline) {
    const extensions = await browser.extensions().catch(() => null);
    const extension = [...(extensions?.values() ?? [])].find((entry) =>
      entry.enabled && canonicalPath(entry.path) === expectedPath,
    );
    const target = extension && browser.targets().find((entry) =>
      entry.type() === 'service_worker' && entry.url().startsWith(`chrome-extension://${extension.id}/`),
    );
    const worker = await target?.worker().catch(() => null);
    if (extension && worker) return { extId: extension.id, target };
    lastState = JSON.stringify({
      expectedPath,
      extensions: [...(extensions?.values() ?? [])].map((entry) => ({
        id: entry.id,
        enabled: entry.enabled,
        path: entry.path,
        canonicalPath: canonicalPath(entry.path),
      })),
      targets: browser.targets()
        .filter((entry) => entry.url().startsWith('chrome-extension://'))
        .map((entry) => ({ type: entry.type(), url: entry.url() })),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Scenario Lab MV3 service worker did not become ready. Last state: ${lastState}`);
}

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

async function clickSelector(page, selector) {
  await page.evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Missing clickable diagnostics control: ${targetSelector}`);
    }
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${minimumRoots} retained Scenario Lab operation(s).`);
}

async function selectTab(page, label) {
  await page.evaluate((tabLabel) => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((element) => element.textContent === tabLabel);
    if (!(tab instanceof HTMLButtonElement)) throw new Error(`Missing diagnostics tab: ${tabLabel}`);
    tab.click();
  }, label);
  await page.waitForFunction(
    (tabLabel) => [...document.querySelectorAll('[role="tab"]')]
      .some((element) => element.textContent === tabLabel && element.getAttribute('aria-selected') === 'true'),
    { timeout: TIMEOUT_MS },
    label,
  );
}

async function readDiagnosticsState(page, pageIssues, serviceWorkerIssues) {
  const pageState = await page.evaluate(() => ({
    diagnosticsStatus: document.querySelector('[data-testid="agent-diagnostics-status"]')?.textContent?.trim() ?? null,
    scenarioStatus: document.querySelector('[data-testid="agent-diagnostics-scenario-status"]')?.textContent?.trim() ?? null,
    runButtonDisabled: document.querySelector('[data-testid="agent-diagnostics-run-scenario"]')?.disabled ?? null,
    activeTab: [...document.querySelectorAll('[role="tab"]')]
      .find((element) => element.getAttribute('aria-selected') === 'true')?.textContent?.trim() ?? null,
    retainedRunCount: document.querySelectorAll('[data-testid="agent-diagnostics-runs"] > li').length,
  })).catch((error) => ({ pageEvaluationError: error instanceof Error ? error.message : String(error) }));
  return {
    ...pageState,
    pageIssues: [...pageIssues],
    serviceWorkerIssues: [...serviceWorkerIssues],
  };
}

async function exportArtifact(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const requestId = `runtime-export-${crypto.randomUUID()}`;
    const chunks = [];
    const port = chrome.runtime.connect({ name: 'bgsm-agent-dev-evidence-v1' });
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('Timed out exporting Scenario Lab trace artifact.'));
    }, 30_000);
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        reject(new Error(chrome.runtime.lastError.message));
      }
    });
    port.onMessage.addListener((message) => {
      if (message?.type === 'ready') {
        port.postMessage({
          version: 1,
          requestId,
          type: 'export',
          scope: { kind: 'all_retained', id: null },
          cursor: null,
          maxBytes: 256 * 1024,
        });
        return;
      }
      if (message?.requestId !== requestId) return;
      if (message.type === 'evidence_error') {
        clearTimeout(timer);
        port.disconnect();
        reject(new Error(`Scenario Lab export failed: ${message.code}`));
        return;
      }
      if (message.type !== 'export_chunk') return;
      chunks[message.chunkIndex] = message.jsonChunk;
      if (!message.done) return;
      clearTimeout(timer);
      port.disconnect();
      try {
        resolve(JSON.parse(chunks.join('')));
      } catch (error) {
        reject(error);
      }
    });
  }));
}
