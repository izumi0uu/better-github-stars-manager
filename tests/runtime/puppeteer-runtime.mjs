import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
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

export const RUNTIME_TARGETS = Object.freeze(['chrome', 'firefox']);
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
  const configuredPath = executablePath ?? (
    normalizedTarget === 'firefox'
      ? process.env.FIREFOX_EXECUTABLE
      : process.env.PUPPETEER_EXECUTABLE_PATH
  );
  if (configuredPath) {
    if (!existsSync(configuredPath)) {
      throw new Error(
        `${normalizedTarget === 'firefox' ? 'FIREFOX_EXECUTABLE' : 'PUPPETEER_EXECUTABLE_PATH'} does not exist: ${configuredPath}`,
      );
    }
    return configuredPath;
  }

  const driver = await loadPuppeteerDriver(normalizedDriver);
  const executable = await driver.executablePath({ browser: normalizedTarget });
  if (!existsSync(executable)) {
    const installCommand = normalizedDriver === 'firefox_140'
      ? 'pnpm exec puppeteer browsers install firefox@stable_140.0.4'
      : normalizedTarget === 'firefox'
        ? 'pnpm exec puppeteer browsers install firefox'
        : 'pnpm exec puppeteer browsers install chrome';
    throw new Error(
      `Puppeteer ${normalizedTarget} browser not installed at ${executable}. Run "${installCommand}" or set ${normalizedTarget === 'firefox' ? 'FIREFOX_EXECUTABLE' : 'PUPPETEER_EXECUTABLE_PATH'}.`,
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

export async function openFirefox140ExtensionPage(browser, {
  executablePath,
  userDataDir,
  url,
  timeoutMs = 20_000,
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

  const pagesBefore = new Map();
  for (const page of await browser.pages()) {
    pagesBefore.set(page, await page.evaluate(() => location.href).catch(() => null));
  }
  try {
    await execFileAsync(executablePath, ['--profile', userDataDir, '--new-tab', url], {
      timeout: timeoutMs,
    });
  } catch (error) {
    throw new Error('Firefox 140 could not request an extension tab from the running profile.', {
      cause: error,
    });
  }
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const page of await browser.pages()) {
      const actualUrl = await page.evaluate(() => location.href).catch(() => null);
      if (actualUrl === url && (!pagesBefore.has(page) || pagesBefore.get(page) !== url)) {
        return prepareFirefox140ExtensionPage(page);
      }
    }
    await delay(50);
  }
  throw new Error('Firefox 140 did not expose the requested extension tab before timeout.');
}

export function prepareFirefox140ExtensionPage(page) {
  page.waitForFunction = async (pageFunction, options = {}, ...args) => {
    const timeoutMs = options.timeout ?? 30_000;
    const pollMs = typeof options.polling === 'number' ? options.polling : 100;
    const deadline = Date.now() + timeoutMs;
    do {
      if (await page.evaluate(pageFunction, ...args).catch(() => false)) return;
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
