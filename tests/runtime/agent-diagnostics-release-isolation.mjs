#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchExtensionBrowser } from './puppeteer-runtime.mjs';

const root = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'bgsm-agent-diagnostics-isolation-'));
const devDir = path.join(tempRoot, 'development');
const releaseDir = path.join(tempRoot, 'release');
const releaseZip = path.join(tempRoot, 'release.zip');
const releaseProfile = path.join(tempRoot, 'release-profile');
const diagnosticsPath = '/src/dev-agent/index.html';
const extensionPagePath = '/src/options/index.html';
const devTraceDatabase = 'bgsm-agent-dev-traces-v1';
const devPorts = [
  'bgsm-agent-dev-evidence-v1',
  'bgsm-agent-dev-control-v1',
];
const markers = [
  ...devPorts,
  devTraceDatabase,
  'src/dev-agent/index.html',
  'overflow-then-success',
  'arm_raw_capture',
  'raw_capture_event',
  'toolNameTruncated',
  'One-shot raw capture',
  'bgsm-diagnostics-v1',
  'Agent-readable report',
  'Standalone read-only artifact viewer',
  'Provider Debug',
  '__bgsm/diagnostics/provider',
  'bgsm-provider-monitor-v2',
  'bgsm_provider_diagnostics_monitor_v1',
  'provider_stream_activity',
  'start_provider_monitor',
  'provider_monitor_status',
  'Start monitoring',
  'Local Agent bridge',
  'bgsm-agent-artifact-worker-v1',
  'SCENARIO_PRIVATE_CURRENT_PROMPT_CANARY',
];
let browser;

try {
  build(devDir, { GSM_DEV: 'true', GSM_RELEASE: 'false' });
  assert.ok(existsSync(path.join(devDir, 'src', 'dev-agent', 'index.html')),
    'Development build must contain the dedicated Agent diagnostics page.');
  const devBundle = readInspectableSurface(devDir);
  for (const marker of markers) {
    assert.ok(devBundle.includes(marker), `Development bundle is missing diagnostics marker: ${marker}`);
  }

  build(releaseDir, { GSM_DEV: 'false', GSM_RELEASE: 'true' });
  assert.equal(existsSync(path.join(releaseDir, 'src', 'dev-agent', 'index.html')), false,
    'Release build must not contain the Agent diagnostics page.');
  const releaseBundle = readInspectableSurface(releaseDir);
  for (const marker of markers) {
    assert.equal(releaseBundle.includes(marker), false, `Release bundle leaked diagnostics marker: ${marker}`);
  }

  const devManifest = readManifest(devDir);
  const releaseManifest = readManifest(releaseDir);
  assertManifestIsolation(devManifest, releaseManifest);

  createZip(releaseDir, releaseZip);
  const zipSurface = readZipSurface(releaseZip);
  for (const marker of markers) {
    assert.equal(zipSurface.includes(marker), false, `Release ZIP leaked diagnostics marker: ${marker}`);
  }

  browser = await launchExtensionBrowser({ dist: releaseDir, userDataDir: releaseProfile });
  const extensionId = await findExtensionId(browser, releaseDir);
  await assertDiagnosticsPageUnavailable(browser, extensionId);
  await assertDiagnosticsRuntimeUnavailable(browser, extensionId);
  console.log('Agent diagnostics development/release isolation passed.');
} finally {
  const browserProcess = browser?.process();
  await Promise.race([
    browser?.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (browserProcess && !browserProcess.killed) browserProcess.kill('SIGKILL');
  rmSync(tempRoot, { recursive: true, force: true });
}

function build(outDir, envOverrides) {
  const pnpmExecPath = process.env.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const args = pnpmExecPath ? [pnpmExecPath, 'build'] : ['pnpm', 'build'];
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...envOverrides,
      GSM_DIST_DIR: outDir,
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  assert.equal(result.status, 0, 'Diagnostics isolation build failed.');
}

function readInspectableSurface(dir) {
  const files = [];
  visit(dir, files);
  return files
    .filter(isInspectableFile)
    .map((file) => `${path.relative(dir, file)}\n${readFileSync(file, 'utf8')}`)
    .join('\n');
}

function readManifest(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

function assertManifestIsolation(devManifest, releaseManifest) {
  for (const key of ['permissions', 'host_permissions', 'optional_host_permissions']) {
    assert.deepEqual(
      sortedStrings(releaseManifest[key]),
      sortedStrings(devManifest[key]),
      `Diagnostics must not add manifest ${key}.`,
    );
  }
  assert.deepEqual(sortedStrings(releaseManifest.permissions), ['alarms', 'storage']);
  assert.equal('externally_connectable' in releaseManifest, false,
    'Release manifest must not expose externally_connectable.');
  assert.equal(JSON.stringify(releaseManifest).includes('src/dev-agent'), false,
    'Release manifest must not expose diagnostics resources.');

  const listenerMatches = [
    ...(releaseManifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? []),
    ...(releaseManifest.web_accessible_resources ?? []).flatMap((entry) => entry.matches ?? []),
  ];
  assert.equal(listenerMatches.some(isLocalhostPattern), false,
    'Release manifest must not register a localhost content/resource listener.');
}

function createZip(sourceDir, zipPath) {
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceDir, stdio: 'inherit' });
}

function readZipSurface(zipPath) {
  const entries = execFileSync('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).split(/\r?\n/u).filter(Boolean);
  const contents = entries
    .filter((entry) => !entry.endsWith('/') && isInspectableFile(entry))
    .map((entry) => execFileSync('unzip', ['-p', zipPath, entry], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }));
  return `${entries.join('\n')}\n${contents.join('\n')}`;
}

async function findExtensionId(extensionBrowser, extensionPath) {
  const deadline = Date.now() + 20_000;
  const expectedPath = realpathSync(extensionPath);
  let lastState = 'extension discovery returned no data';
  while (Date.now() < deadline) {
    const extensions = await extensionBrowser.extensions().catch(() => null);
    const extension = [...(extensions?.values() ?? [])].find((entry) =>
      entry.enabled && canonicalPath(entry.path) === expectedPath,
    );
    const target = extension && extensionBrowser.targets().find((entry) =>
      entry.type() === 'service_worker' && entry.url().startsWith(`chrome-extension://${extension.id}/`),
    );
    const worker = await target?.worker().catch(() => null);
    if (extension && worker) return extension.id;
    lastState = JSON.stringify({
      expectedPath,
      extensions: [...(extensions?.values() ?? [])].map((entry) => ({
        id: entry.id,
        enabled: entry.enabled,
        path: entry.path,
      })),
      targets: extensionBrowser.targets()
        .filter((entry) => entry.url().startsWith('chrome-extension://'))
        .map((entry) => ({ type: entry.type(), url: entry.url() })),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Release MV3 service worker did not become ready. Last state: ${lastState}`);
}

async function assertDiagnosticsPageUnavailable(extensionBrowser, extensionId) {
  const page = await extensionBrowser.newPage();
  const expectedUrl = `chrome-extension://${extensionId}${diagnosticsPath}`;
  let navigationError = null;
  let response = null;
  try {
    response = await page.goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  } catch (error) {
    navigationError = error;
  }
  assert.ok(
    navigationError || !response || !response.ok(),
    'Release diagnostics URL unexpectedly loaded.',
  );
  assert.equal(await page.$('[data-testid="agent-diagnostics-page"]'), null,
    'Release diagnostics DOM unexpectedly exists.');
  await page.close();
}

async function assertDiagnosticsRuntimeUnavailable(extensionBrowser, extensionId) {
  const page = await extensionBrowser.newPage();
  await page.goto(`chrome-extension://${extensionId}${extensionPagePath}`, {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });
  const probes = await page.evaluate(async (portNames) => Promise.all(portNames.map((name) =>
    new Promise((resolve) => {
      const messages = [];
      const port = chrome.runtime.connect({ name });
      const timer = setTimeout(() => {
        port.disconnect();
        resolve({ name, disconnected: false, messages });
      }, 2_000);
      port.onMessage.addListener((message) => messages.push(message));
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        resolve({ name, disconnected: true, messages });
      });
    }))), devPorts);
  for (const probe of probes) {
    assert.equal(probe.disconnected, true, `Release diagnostics Port remained connected: ${probe.name}`);
    assert.deepEqual(probe.messages, [], `Release diagnostics Port responded: ${probe.name}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  const databaseNames = await page.evaluate(async () => {
    if (typeof indexedDB.databases !== 'function') {
      throw new Error('Runtime does not support indexedDB.databases().');
    }
    return (await indexedDB.databases()).map((database) => database.name ?? null);
  });
  assert.equal(databaseNames.includes(devTraceDatabase), false,
    'Release runtime opened the development trace database.');
  await page.close();
}

function sortedStrings(value) {
  return Array.isArray(value) ? [...value].sort() : [];
}

function isLocalhostPattern(value) {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//u.test(value);
}

function isInspectableFile(file) {
  return /\.(?:css|html|js|json|map|txt)$/u.test(file);
}

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function visit(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(next, files);
    else if (entry.isFile()) files.push(next);
  }
}
