import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

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

function resolveHeadlessMode() {
  const raw = process.env.PUPPETEER_HEADLESS?.trim().toLowerCase();
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  if (raw === 'new') return 'new';
  return process.env.CI ? 'new' : false;
}

export async function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    if (!existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      throw new Error(
        `PUPPETEER_EXECUTABLE_PATH does not exist: ${process.env.PUPPETEER_EXECUTABLE_PATH}`,
      );
    }
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const executablePath = await puppeteer.executablePath();
  if (!existsSync(executablePath)) {
    throw new Error(
      `Puppeteer browser not installed at ${executablePath}. Run "pnpm exec puppeteer browsers install chrome" or set PUPPETEER_EXECUTABLE_PATH.`,
    );
  }

  return executablePath;
}

export async function launchExtensionBrowser({
  dist,
  userDataDir,
  protocolTimeout,
  failClosedNetwork = false,
}) {
  const executablePath = await resolveExecutablePath();
  const args = [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (failClosedNetwork) args.push(...FAIL_CLOSED_NETWORK_ARGUMENTS);

  if (process.env.CI) {
    args.push('--disable-dev-shm-usage', '--no-sandbox');
  }

  return puppeteer.launch({
    headless: resolveHeadlessMode(),
    enableExtensions: true,
    executablePath,
    userDataDir,
    ...(protocolTimeout === undefined ? {} : { protocolTimeout }),
    args,
  });
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
