#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchExtensionBrowser } from './puppeteer-runtime.mjs';

const DIST = path.resolve(process.cwd(), 'dist');
const OPTIONS_PATH = '/src/options/index.html';
const POPUP_PATH = '/src/popup/index.html';
const INVALID_TOKEN = 'github_pat_invalid_extension_browser_smoke';
const STARS_URL = 'https://github.com/smoke-user?tab=stars';
const REPO_URL = 'https://github.com/smoke-user/smoke-repo';

if (!existsSync(path.join(DIST, 'manifest.json'))) {
  console.error(`No dist/manifest.json found at ${DIST}. Run "pnpm build" first.`);
  process.exit(1);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'gsm-extension-smoke-'));
const failures = [];
const pageIssues = [];

function step(message) {
  console.log(`\n${message}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

function recordPageIssue(label, issue) {
  pageIssues.push(`[${label}] ${issue}`);
}

let browser;
try {
  browser = await launchExtensionBrowser({ dist: DIST, userDataDir: profile });
  const extId = await detectExtensionId(browser);
  ok(`extension loaded: ${extId}`);

  step('1) Popup no-token path opens Options');
  const popup = await openExtensionPage(extId, POPUP_PATH, 'popup');
  await waitForBodyText(popup, 'No token configured');
  await waitForButtonByText(popup, /^Add PAT$/i);

  const openedOptions = waitForExtensionPage(`${OPTIONS_PATH}`);
  await clickButtonByText(popup, /^Add PAT$/i);
  const optionsFromPopup = await openedOptions;
  await optionsFromPopup.waitForSelector('textarea', { timeout: 10_000 });
  await waitForBodyText(optionsFromPopup, 'GitHub Token');
  ok('popup rendered no-token state and Add PAT opened Options');

  step('2) Options rejects invalid token without persisting auth');
  await interceptGitHubApi(optionsFromPopup, invalidTokenApiResponse);
  await assertInvalidTokenApiStub(optionsFromPopup);
  await withTimeout(
    async () => {
      await saveToken(optionsFromPopup, INVALID_TOKEN);
      await waitForBodyText(
        optionsFromPopup,
        'GitHub rejected this token. Check that you copied the whole value.',
        8_000,
      );
    },
    15_000,
    async () => `invalid-token UI did not complete. Page text:\n${await pageText(optionsFromPopup)}`,
  );
  await assertNoAuthenticatedBanner(optionsFromPopup);
  ok('invalid token was rejected and no authenticated banner appeared');

  step('3) Stars page fixture does not inject panel without owner proof');
  const noTokenStars = await browser.newPage();
  hookPageDiagnostics(noTokenStars, 'stars-no-token');
  await interceptGitHubPages(noTokenStars);
  await noTokenStars.goto(STARS_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await noTokenStars.waitForSelector('main', { timeout: 10_000 });
  await expectNoManager(noTokenStars);
  ok('stars fixture loaded and manager stayed absent without token/user identity');

  step('4) Stars page injects panel and toggles FAB when local config has matching owner');
  await seedConfig(extId, {
    username: 'smoke-user',
    tokenEncrypted: 'smoke-ciphertext',
    tokenCryptoMeta: null,
    starsPanelDefaultEnabled: true,
  });
  const ownStars = await browser.newPage();
  hookPageDiagnostics(ownStars, 'stars-own');
  await interceptGitHubPages(ownStars);
  await ownStars.goto(STARS_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForManagerRoot(ownStars);
  await assertScrollLocked(ownStars);
  await clickShadowButton(ownStars, '[data-coach-target="hide-panel"]');
  await waitForFab(ownStars);
  await clickFab(ownStars);
  await waitForManagerRoot(ownStars);
  ok('manager injected for own stars page, hide shows FAB, FAB restores panel');

  step('5) Turbo-style navigation does not duplicate extension hosts');
  await ownStars.evaluate(() => {
    history.pushState({}, '', '/smoke-user?tab=stars&smoke=turbo');
    document.dispatchEvent(new Event('turbo:load'));
    document.dispatchEvent(new Event('turbo:render'));
  });
  await ownStars.waitForFunction(() => document.querySelectorAll('#gsm-manager-host').length === 1, { timeout: 10_000 });
  const counts = await ownStars.evaluate(() => ({
    panels: document.querySelectorAll('#gsm-manager-host').length,
    fabs: document.querySelectorAll('#gsm-fab').length,
  }));
  assert.deepEqual(counts, { panels: 1, fabs: 0 });
  ok('turbo events kept a single manager host and no duplicate FAB');

  step('6) Repo page fixture gets tag-chip host only on repo-shaped path');
  const repoPage = await browser.newPage();
  hookPageDiagnostics(repoPage, 'repo');
  await interceptGitHubPages(repoPage);
  await repoPage.goto(REPO_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await repoPage.waitForSelector('strong[itemprop="name"]', { timeout: 10_000 });
  await repoPage.waitForFunction(() => {
    const name = document.querySelector('strong[itemprop="name"]');
    let cursor = name?.nextElementSibling;
    while (cursor) {
      if (cursor.shadowRoot) return true;
      cursor = cursor.nextElementSibling;
    }
    return false;
  }, { timeout: 10_000 });
  ok('repo fixture received a shadow-root tag chip');

  if (pageIssues.length) {
    failures.push(`unexpected browser diagnostics:\n${pageIssues.join('\n')}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await browser?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nExtension browser smoke failed:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log('\nExtension browser smoke passed.');

async function detectExtensionId(browser) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const extensions = await browser.extensions().catch(() => null);
    const installed = extensions?.values().next().value;
    if (installed?.id) return installed.id;

    const target = browser.targets().find((candidate) => {
      return (candidate.type() === 'service_worker' || candidate.type() === 'page') &&
        candidate.url().startsWith('chrome-extension://');
    });
    const extId = target?.url().match(/chrome-extension:\/\/([a-z]+)/i)?.[1];
    if (extId) return extId;
    await delay(500);
  }
  throw new Error('could not determine extension ID after waiting for MV3 extension load');
}

async function openExtensionPage(extId, pagePath, label) {
  const page = await browser.newPage();
  hookPageDiagnostics(page, label);
  await page.goto(`chrome-extension://${extId}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return page;
}

async function waitForExtensionPage(pagePath) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.url().startsWith('chrome-extension://') && candidate.url().endsWith(pagePath),
    { timeout: 10_000 },
  );
  const page = await target.page();
  if (!page) throw new Error(`extension page opened without page handle: ${pagePath}`);
  hookPageDiagnostics(page, pagePath);
  return page;
}

async function seedConfig(extId, patch) {
  const page = await openExtensionPage(extId, OPTIONS_PATH, 'seed-config');
  await page.evaluate(async (nextPatch) => {
    const key = 'gsm_config';
    const current = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: { ...(current[key] ?? {}), ...nextPatch } });
  }, patch);
  await page.close();
}

async function interceptGitHubApi(page, handler) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('https://api.github.com/')) {
      request.continue();
      return;
    }
    void handler(request);
  });
}

async function invalidTokenApiResponse(request) {
  await request.respond({
    status: 401,
    contentType: 'application/json',
    headers: { 'x-oauth-scopes': '' },
    body: JSON.stringify({ message: 'Bad credentials' }),
  });
}

async function assertInvalidTokenApiStub(page) {
  const status = await page.evaluate(async () => {
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: 'Bearer smoke-stub-check' },
    });
    return response.status;
  });
  assert.equal(status, 401, 'GitHub API interception did not return the expected local 401');
}

async function interceptGitHubPages(page) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('https://github.com/smoke-user?') || url === 'https://github.com/smoke-user') {
      void request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: starsPageHtml(),
      });
      return;
    }
    if (url === REPO_URL) {
      void request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: repoPageHtml(),
      });
      return;
    }
    if (url.startsWith('https://github.com/')) {
      void request.respond({ status: 204, body: '' });
      return;
    }
    request.continue();
  });
}

function starsPageHtml() {
  return `<!doctype html>
<html>
<head><title>smoke-user stars</title></head>
<body>
  <main data-pjax-container>
    <h1>Stars</h1>
    <div id="user-starred-repos">
      <article><a href="/smoke-user/smoke-repo">smoke-user/smoke-repo</a></article>
    </div>
  </main>
</body>
</html>`;
}

function repoPageHtml() {
  return `<!doctype html>
<html>
<head><title>smoke-repo</title></head>
<body>
  <main>
    <span itemprop="author"><a href="/smoke-user">smoke-user</a></span>
    <strong itemprop="name"><a data-pjax href="/smoke-user/smoke-repo">smoke-repo</a></strong>
    <span id="repo-header-actions"></span>
  </main>
</body>
</html>`;
}

async function saveToken(page, token) {
  await page.click('textarea', { clickCount: 3 }).catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.type('textarea', token);
  await clickButtonByText(page, /save|verify/i);
}

async function waitForBodyText(page, text, timeout = 20_000) {
  await page.waitForFunction((expected) => document.body.innerText.includes(expected), { timeout }, text);
}

async function waitForButtonByText(page, matcher, timeout = 20_000) {
  await page.waitForFunction(
    (source) => {
      const regex = new RegExp(source.pattern, source.flags);
      return [...document.querySelectorAll('button')].some((node) => regex.test((node.textContent || '').trim()));
    },
    { timeout },
    { pattern: matcher.source, flags: matcher.flags },
  );
}

async function clickButtonByText(page, matcher) {
  const matched = await page.evaluate((source) => {
    const regex = new RegExp(source.pattern, source.flags);
    const button = [...document.querySelectorAll('button')].find((node) => regex.test((node.textContent || '').trim()));
    if (!button) return null;
    button.click();
    return (button.textContent || '').trim();
  }, { pattern: matcher.source, flags: matcher.flags });
  if (!matched) throw new Error(`could not find button matching ${matcher}`);
}

async function pageText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function assertNoAuthenticatedBanner(page) {
  const text = await pageText(page);
  assert.equal(text.includes('Authenticated as @'), false, 'token unexpectedly persisted after rejected validation');
}

async function withTimeout(task, timeoutMs, describeFailure) {
  let timeout;
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timeout = setTimeout(async () => {
          let detail;
          try {
            detail = await describeFailure();
          } catch (err) {
            detail = `timed out after ${timeoutMs}ms (diagnostic capture failed: ${err instanceof Error ? err.message : String(err)})`;
          }
          reject(new Error(detail));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function expectNoManager(page) {
  await delay(1000);
  const present = await page.evaluate(() => !!document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root'));
  assert.equal(present, false, 'manager unexpectedly injected without owner proof');
}

async function waitForManagerRoot(page) {
  await page.waitForFunction(
    () => !!document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root'),
    { timeout: 20_000 },
  );
}

async function assertScrollLocked(page) {
  const overflow = await page.evaluate(() => ({
    html: document.documentElement.style.overflow,
    body: document.body.style.overflow,
  }));
  assert.deepEqual(overflow, { html: 'hidden', body: 'hidden' });
}

async function clickShadowButton(page, selector) {
  const clicked = await page.evaluate((targetSelector) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const button = root?.querySelector(targetSelector);
    button?.click();
    return !!button;
  }, selector);
  assert.equal(clicked, true, `could not click shadow button matching ${selector}`);
}

async function waitForFab(page) {
  await page.waitForFunction(() => !!document.getElementById('gsm-fab')?.shadowRoot?.querySelector('button'), { timeout: 10_000 });
  const hasPanel = await page.evaluate(() => !!document.getElementById('gsm-manager-host'));
  assert.equal(hasPanel, false, 'panel host should be removed while FAB is visible');
}

async function clickFab(page) {
  const clicked = await page.evaluate(() => {
    const button = document.getElementById('gsm-fab')?.shadowRoot?.querySelector('button');
    button?.click();
    return !!button;
  });
  assert.equal(clicked, true, 'could not click FAB');
}

function hookPageDiagnostics(page, label) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (label === OPTIONS_PATH && text.includes('api.github.com') && text.includes('401')) return;
    if (label === OPTIONS_PATH && text.includes('Failed to load resource') && text.includes('401')) return;
    recordPageIssue(label, `console.error: ${text}`);
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (url.startsWith('https://github.com/') || url.startsWith('https://api.github.com/')) {
      recordPageIssue(label, `request failed: ${url} ${request.failure()?.errorText ?? ''}`);
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
