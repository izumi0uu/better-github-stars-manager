import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

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

export async function launchExtensionBrowser({ dist, userDataDir }) {
  const executablePath = await resolveExecutablePath();
  const args = [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (process.env.CI) {
    args.push('--disable-dev-shm-usage', '--no-sandbox');
  }

  return puppeteer.launch({
    headless: resolveHeadlessMode(),
    enableExtensions: true,
    executablePath,
    userDataDir,
    args,
  });
}
