#!/usr/bin/env node
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { launchExtensionBrowser } from '../tests/runtime/puppeteer-runtime.mjs';

const root = process.cwd();
const dist = path.join(root, 'dist');
const output = path.join(root, 'public/store/screenshots');
const profile = mkdtempSync(path.join(os.tmpdir(), 'bgsm-store-shots-'));

if (process.env.GSM_SKIP_SCREENSHOT_BUILD !== 'true') {
  execFileSync('corepack', ['pnpm', 'build'], { cwd: root, stdio: 'inherit' });
}
if (!existsSync(path.join(dist, 'manifest.json'))) {
  throw new Error('dist/manifest.json is missing; build the extension before capturing screenshots.');
}

mkdirSync(output, { recursive: true });
copyFileSync(
  path.join(root, 'store-assets/screenshots/screenshot-main-stars.png'),
  path.join(output, 'screenshot-main-stars.png'),
);
copyFileSync(
  path.join(root, 'store-assets/screenshots/screenshot-detail-panel.png'),
  path.join(output, 'screenshot-detail-panel.png'),
);

let browser;
try {
  browser = await launchExtensionBrowser({
    dist,
    userDataDir: profile,
    protocolTimeout: 120_000,
  });
  const extensionId = await detectExtensionId(browser);
  await captureDisclosure(browser, extensionId, {
    theme: 'light',
    width: 1280,
    height: 800,
    filename: 'screenshot-agent-disclosure-light-1280x800.png',
  });
  await captureDisclosure(browser, extensionId, {
    theme: 'dark',
    width: 640,
    height: 400,
    filename: 'screenshot-agent-disclosure-dark-640x400.png',
  });
  console.log(`Captured real extension screenshots in ${path.relative(root, output)}`);
} finally {
  await browser?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}

async function detectExtensionId(browser) {
  const target = await browser.waitForTarget((candidate) => {
    const url = candidate.url();
    return candidate.type() === 'service_worker' && url.startsWith('chrome-extension://');
  }, { timeout: 20_000 }).catch(() => null);
  if (!target) {
    throw new Error('The unpacked extension service worker did not become available for screenshot capture.');
  }
  return new URL(target.url()).host;
}

async function captureDisclosure(browser, extensionId, shot) {
  const page = await browser.newPage();
  await page.setViewport({ width: shot.width, height: shot.height, deviceScaleFactor: 1 });
  const url = `chrome-extension://${extensionId}/src/options/index.html`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate(async (theme) => {
    await chrome.storage.local.set({
      gsm_config: {
        agentProvider: {
          provider: 'openai',
          baseUrl: null,
          model: 'gpt-5.4',
          apiKeyEncrypted: null,
          apiKeyCryptoMeta: null,
          credentialScope: null,
          credentialRevision: null,
          capability: null,
        },
        agentDataDisclosureAcceptance: null,
        theme,
        locale: 'en',
      },
    });
  }, shot.theme);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[data-testid="agent-data-disclosure"]', { timeout: 10_000 });
  const disclosure = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="agent-data-disclosure"]');
    panel?.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -72);
    return {
      categoryCount: panel?.querySelectorAll('[data-disclosure-category]').length ?? 0,
      collapsed: panel?.querySelector('details')?.open === false,
      originVisible: panel?.textContent?.includes('https://api.openai.com') ?? false,
      passwordValues: [...document.querySelectorAll('input[type="password"]')]
        .map((input) => input.value),
    };
  });
  assert.equal(disclosure.categoryCount, 4);
  assert.equal(disclosure.collapsed, true);
  assert.equal(disclosure.originVisible, true);
  assert.deepEqual(disclosure.passwordValues, ['']);
  await page.screenshot({ path: path.join(output, shot.filename) });
  await page.close();
}
