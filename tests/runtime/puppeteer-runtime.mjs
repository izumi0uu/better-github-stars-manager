import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import {
  FIREFOX_GECKO_ID,
  FIREFOX_TEST_UUID,
} from '../../scripts/build-firefox-extension.mjs';

const execFileAsync = promisify(execFile);

export const FAIL_CLOSED_NETWORK_ARGUMENTS = Object.freeze([
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--no-pings',
]);

export const RUNTIME_TARGETS = Object.freeze(['chrome', 'edge', 'firefox']);
export const PUPPETEER_DRIVERS = Object.freeze(['default', 'firefox_140']);

export function normalizePuppeteerDriver(driver = 'default') {
  if (!PUPPETEER_DRIVERS.includes(driver)) {
    throw new TypeError(`Unsupported Puppeteer driver: ${String(driver)}.`);
  }
  return driver;
}

async function loadPuppeteerDriver(driver) {
  return driver === 'firefox_140'
    ? (await import('puppeteer-firefox-140')).default
    : puppeteer;
}

export function normalizeRuntimeTarget(target = 'chrome') {
  if (!RUNTIME_TARGETS.includes(target)) {
    throw new TypeError(`Unsupported runtime target: ${String(target)}.`);
  }
  return target;
}

export function classifyEdgeBrowserIdentity(input = {}) {
  const observedIdentity = [input.product, input.userAgent, input.reportedVersion]
    .map((value) => typeof value === 'string' ? value.slice(0, 512) : '');
  const commandLineObserved = Array.isArray(input.commandLineArguments);
  const commandLineArguments = commandLineObserved
    ? input.commandLineArguments.filter((value) => typeof value === 'string').slice(0, 256)
    : [];
  const userAgentOverridden = commandLineArguments.some((argument) => (
    argument === '--user-agent' || argument.startsWith('--user-agent=')
  ));
  const executableVerified = typeof input.executableSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(input.executableSha256);
  const edgeVersion = firstMatchingVersion(/\bEdg\/([0-9]+(?:\.[0-9]+)*)/u, observedIdentity);
  if (edgeVersion && executableVerified && commandLineObserved && !userAgentOverridden) {
    return Object.freeze({
      name: 'Microsoft Edge',
      version: edgeVersion,
      releaseProofEligible: true,
    });
  }

  const chromiumVersion = firstMatchingVersion(
    /\b(?:Chrome|Chromium)\/([0-9]+(?:\.[0-9]+)*)/u,
    observedIdentity,
  );
  return Object.freeze({
    name: 'Non-Edge Chromium (test-only local mode)',
    version: edgeVersion ?? chromiumVersion ?? 'unknown',
    releaseProofEligible: false,
  });
}

export async function readEdgeBrowserIdentity(browser, options = {}) {
  if (!browser || typeof browser.target !== 'function' || typeof browser.version !== 'function') {
    throw new TypeError('Edge browser identity requires a Puppeteer browser.');
  }
  const client = await browser.target().createCDPSession();
  try {
    const [versionMetadata, reportedVersion, commandLine] = await Promise.all([
      client.send('Browser.getVersion'),
      browser.version(),
      client.send('Browser.getBrowserCommandLine'),
    ]);
    return classifyEdgeBrowserIdentity({
      product: versionMetadata?.product,
      userAgent: versionMetadata?.userAgent,
      reportedVersion,
      commandLineArguments: commandLine?.arguments,
      executableSha256: options.executableSha256,
    });
  } finally {
    await client.detach();
  }
}

export async function sha256Executable(executablePath) {
  const resolvedPath = realpathSync(executablePath);
  if (!statSync(resolvedPath).isFile()) {
    throw new Error(`Executable path is not a regular file: ${executablePath}`);
  }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(resolvedPath)) digest.update(chunk);
  return digest.digest('hex');
}
function firstMatchingVersion(pattern, candidates) {
  for (const candidate of candidates) {
    const match = pattern.exec(candidate);
    if (match) return match[1];
  }
  return null;
}

function resolveHeadlessMode(target) {
  const raw = process.env.PUPPETEER_HEADLESS?.trim().toLowerCase();
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  if (raw === 'new') return target === 'firefox' ? true : 'new';
  return process.env.CI ? (target === 'firefox' ? true : 'new') : false;
}

export async function resolveExecutablePath({ target = 'chrome', executablePath, puppeteerDriver = 'default' } = {}) {
  const normalizedTarget = normalizeRuntimeTarget(target);
  const normalizedDriver = normalizePuppeteerDriver(puppeteerDriver);
  if (normalizedTarget !== 'firefox' && normalizedDriver !== 'default') {
    throw new TypeError('The Firefox 140 Puppeteer driver can only launch Firefox.');
  }
  const configuredExecutable = executablePath != null
    ? { path: executablePath, source: 'executablePath' }
    : normalizedTarget === 'firefox'
      ? normalizedDriver === 'firefox_140' && process.env.FIREFOX_140_EXECUTABLE != null
        ? { path: process.env.FIREFOX_140_EXECUTABLE, source: 'FIREFOX_140_EXECUTABLE' }
        : process.env.FIREFOX_EXECUTABLE != null
          ? { path: process.env.FIREFOX_EXECUTABLE, source: 'FIREFOX_EXECUTABLE' }
          : null
      : normalizedTarget === 'edge'
        ? process.env.EDGE_EXECUTABLE != null
          ? { path: process.env.EDGE_EXECUTABLE, source: 'EDGE_EXECUTABLE' }
          : null
        : process.env.PUPPETEER_EXECUTABLE_PATH != null
          ? { path: process.env.PUPPETEER_EXECUTABLE_PATH, source: 'PUPPETEER_EXECUTABLE_PATH' }
          : null;
  if (configuredExecutable?.path) {
    if (!existsSync(configuredExecutable.path)) {
      throw new Error(
        `${configuredExecutable.source} does not exist: ${configuredExecutable.path}`,
      );
    }
    return configuredExecutable.path;
  }
  if (normalizedTarget === 'firefox') {
    const environmentName = normalizedDriver === 'firefox_140'
      ? 'FIREFOX_140_EXECUTABLE'
      : 'FIREFOX_EXECUTABLE';
    const installCommand = normalizedDriver === 'firefox_140'
      ? "pnpm exec puppeteer browsers install firefox@stable_140.0.4 --format '{{path}}'"
      : "pnpm exec puppeteer browsers install firefox --format '{{path}}'";
    throw new Error(
      `Firefox verification requires explicit executablePath or ${environmentName}. Resolve it with "${installCommand}".`,
    );
  }
  if (normalizedTarget === 'edge') {
    throw new Error(
      'Microsoft Edge verification requires explicit executablePath or EDGE_EXECUTABLE. Install Microsoft Edge, then set EDGE_EXECUTABLE to its full executable path (for example, "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" on macOS).',
    );
  }


  const driver = await loadPuppeteerDriver(normalizedDriver);
  const executable = await driver.executablePath({ browser: normalizedTarget });
  if (!existsSync(executable)) {
    throw new Error(
      `Puppeteer chrome browser not installed at ${executable}. Run "pnpm exec puppeteer browsers install chrome" or set PUPPETEER_EXECUTABLE_PATH.`,
    );
  }
  return executable;
}

export async function launchExtensionBrowser(input = {}) {
  const target = normalizeRuntimeTarget(input.target ?? 'chrome');
  const puppeteerDriver = normalizePuppeteerDriver(input.puppeteerDriver);
  const executablePath = await resolveExecutablePath({
    target,
    executablePath: input.executablePath,
    puppeteerDriver,
  });
  const options = buildExtensionBrowserLaunchOptions({ ...input, target, executablePath });
  const driver = await loadPuppeteerDriver(puppeteerDriver);
  const browser = await driver.launch(options);
  if (target === 'firefox') {
    try {
      if (typeof browser.installExtension !== 'function') {
        throw new Error('Puppeteer Firefox does not expose temporary extension installation.');
      }
      const installedId = await browser.installExtension(input.dist);
      if (installedId !== FIREFOX_GECKO_ID) {
        throw new Error(`Firefox installed unexpected Gecko extension ID: ${String(installedId)}.`);
      }
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
    return browser;
  }
  if (!input.deferExtensionInstall) return browser;
  try {
    await assertDeferredExtensionInstallReady(browser);
    return browser;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function openFirefoxExtensionPage(browser, {
  executablePath,
  userDataDir,
  url,
  timeoutMs = 20_000,
  preparePage = null,
  reuseExistingPage = false,
}) {
  if (!browser || typeof browser.pages !== 'function') {
    throw new TypeError('Firefox browser must expose its open pages.');
  }
  for (const [label, value] of Object.entries({ executablePath, userDataDir, url })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`${label} must be a non-empty string.`);
    }
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be positive.');
  }
  if (preparePage !== null && typeof preparePage !== 'function') {
    throw new TypeError('preparePage must be a function when provided.');
  }
  if (typeof reuseExistingPage !== 'boolean') {
    throw new TypeError('reuseExistingPage must be a boolean.');
  }

  const pagesBefore = new Map();
  for (const page of await browser.pages()) {
    pagesBefore.set(page, await page.evaluate(() => location.href).catch(() => null));
  }
  if (reuseExistingPage) {
    for (const [page, actualUrl] of pagesBefore) {
      if (actualUrl !== url) continue;
      return preparePage ? preparePage(page) : page;
    }
  }

  const deadline = Date.now() + timeoutMs;
  const firstObservationMs = Math.max(1, Math.floor(timeoutMs / 2));
  let successfulRequest = false;
  let lastRequestError;

  const findRequestedPage = async () => {
    for (const page of await browser.pages()) {
      const actualUrl = await page.evaluate(() => location.href).catch(() => null);
      if (actualUrl === url && (
        !pagesBefore.has(page)
        || pagesBefore.get(page) !== url
      )) return page;
    }
    return null;
  };

  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt += 1) {
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      await execFileAsync(executablePath, ['--profile', userDataDir, '--new-tab', url], {
        timeout: Math.min(5_000, remainingMs),
      });
      successfulRequest = true;
    } catch (error) {
      lastRequestError = error;
      continue;
    }

    const observationDeadline = attempt === 0
      ? Math.min(deadline, Date.now() + firstObservationMs)
      : deadline;
    while (Date.now() < observationDeadline) {
      const page = await findRequestedPage();
      if (page) return preparePage ? preparePage(page) : page;
      await delay(50);
    }
  }

  if (!successfulRequest && lastRequestError) {
    throw new Error('Firefox could not request an extension tab from the running profile.', {
      cause: lastRequestError,
    });
  }
  throw new Error('Firefox did not expose the requested extension tab after two requests.');
}

export function prepareFirefox140ExtensionPage(page) {
  page.waitForFunction = async (pageFunction, options = {}, ...args) => {
    const timeoutMs = options.timeout ?? 30_000;
    const pollMs = typeof options.polling === 'number' ? options.polling : 100;
    const deadline = Date.now() + timeoutMs;
    do {
      if (await page.evaluate(pageFunction, ...args)) return;
      await delay(pollMs);
    } while (Date.now() < deadline);
    throw new Error(`Waiting failed: ${timeoutMs}ms exceeded`);
  };
  return page;
}

export function buildExtensionBrowserLaunchOptions({
  target = 'chrome',
  dist,
  userDataDir,
  protocolTimeout,
  failClosedNetwork = false,
  deferExtensionInstall = false,
  executablePath,
}) {
  const normalizedTarget = normalizeRuntimeTarget(target);
  if (typeof dist !== 'string' || dist.length === 0) {
    throw new TypeError('Extension dist path is required.');
  }
  const isFirefox = normalizedTarget === 'firefox';
  const args = isFirefox ? [] : [
    ...(deferExtensionInstall ? [] : [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ]),
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (failClosedNetwork && !isFirefox) args.push(...FAIL_CLOSED_NETWORK_ARGUMENTS);
  if (process.env.CI && !isFirefox) args.push('--disable-dev-shm-usage', '--no-sandbox');

  return {
    ...(isFirefox ? { browser: 'firefox' } : {}),
    headless: resolveHeadlessMode(normalizedTarget),
    enableExtensions: true,
    ...(isFirefox ? {
      extraPrefsFirefox: {
        'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_GECKO_ID]: FIREFOX_TEST_UUID }),
        'xpinstall.signatures.required': false,
        'extensions.webextOptionalPermissionPrompts': false,
        'ui.prefersReducedMotion': 1,
        ...(failClosedNetwork ? {
          'network.proxy.type': 1,
          'network.proxy.http': '127.0.0.1',
          'network.proxy.http_port': 9,
          'network.proxy.ssl': '127.0.0.1',
          'network.proxy.ssl_port': 9,
          'network.proxy.no_proxies_on': '',
          'network.proxy.allow_hijacking_localhost': true,
          'network.dns.disablePrefetch': true,
          'network.prefetch-next': false,
        } : {}),
      },
    } : {}),
    ...(deferExtensionInstall && !isFirefox ? { pipe: true } : {}),
    executablePath,
    userDataDir,
    ...(protocolTimeout === undefined ? {} : { protocolTimeout }),
    args,
  };
}

async function assertDeferredExtensionInstallReady(browser) {
  if (!browser || typeof browser.installExtension !== 'function' || typeof browser.target !== 'function') {
    throw new Error('Deferred extension installation is unavailable.');
  }
  const client = await browser.target().createCDPSession();
  try {
    const commandLine = await client.send('Browser.getBrowserCommandLine');
    const argumentsList = Array.isArray(commandLine?.arguments) ? commandLine.arguments : [];
    if (
      !argumentsList.includes('--remote-debugging-pipe')
      || !argumentsList.includes('--enable-unsafe-extension-debugging')
    ) {
      throw new Error('Deferred extension installation requires pipe and extension debugging support.');
    }
  } finally {
    await client.detach();
  }
}

export async function assertFailClosedNetworkIsolation(browser) {
  if (!browser || typeof browser.target !== 'function') {
    throw new TypeError('browser must expose a Puppeteer browser target.');
  }
  const client = await browser.target().createCDPSession();
  try {
    const commandLine = await client.send('Browser.getBrowserCommandLine');
    const argumentsList = Array.isArray(commandLine?.arguments) ? commandLine.arguments : [];
    for (const expected of FAIL_CLOSED_NETWORK_ARGUMENTS) {
      if (!argumentsList.includes(expected)) {
        throw new Error('Browser fail-closed network isolation argument is missing.');
      }
    }
  } finally {
    await client.detach();
  }
}
