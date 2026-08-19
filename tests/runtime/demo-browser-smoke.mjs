#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { resolveExecutablePath } from './puppeteer-runtime.mjs';

const DIST = path.resolve(process.cwd(), process.env.GSM_DEMO_DIST_DIR ?? 'dist-demo');
const ENTRY = path.join(DIST, 'index.html');
const DEMO_CANARY = 'bgsm-public-demo-fixture-v1';
const CSP = "default-src 'self'; base-uri 'self'; connect-src 'none'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'none'";
const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

if (!existsSync(ENTRY)) {
  console.error(`No ${path.relative(process.cwd(), ENTRY)} found. Run "pnpm build:demo" first.`);
  process.exit(1);
}

const server = createServer((request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relativePath = requestUrl.pathname === '/'
      ? 'index.html'
      : decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    const file = path.resolve(DIST, relativePath);
    if (!file.startsWith(`${DIST}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'Content-Type': MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    response.end(readFileSync(file));
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Demo smoke server did not expose a TCP port.');
const origin = `http://127.0.0.1:${address.port}`;
const profile = mkdtempSync(path.join(os.tmpdir(), 'bgsm-demo-smoke-'));
const externalRequests = [];
const pageIssues = [];
const mainFrameUrls = [];
let browser;

function step(message) {
  console.log(`\n${message}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

try {
  browser = await puppeteer.launch({
    executablePath: await resolveExecutablePath(),
    headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
    userDataDir: profile,
    protocolTimeout: 90_000,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pings',
      ...(process.env.CI ? ['--disable-dev-shm-usage', '--no-sandbox'] : []),
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (/^https?:/u.test(url) && new URL(url).origin !== origin) {
      externalRequests.push(url);
      void request.abort('blockedbyclient');
      return;
    }
    void request.continue();
  });
  page.on('pageerror', (error) => pageIssues.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageIssues.push(`console: ${message.text()}`);
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) mainFrameUrls.push(frame.url());
  });

  step('1) Built entry renders the isolated interactive workspace');
  const response = await page.goto(`${origin}/#gsm-tag=extension-only`, { waitUntil: 'networkidle0', timeout: 45_000 });
  assert.equal(response?.status(), 200);
  assert.match(response?.headers()['content-security-policy'] ?? '', /connect-src 'none'/u);
  await waitForStars(page);
  const entry = await page.evaluate((canary) => ({
    build: document.querySelector('[data-demo-build]')?.getAttribute('data-demo-build') ?? null,
    notice: document.querySelector('[data-testid="demo-notice"]')?.textContent ?? '',
    featurePreviews: document.querySelectorAll('[data-demo-view="previews"], [data-testid="feature-preview-gallery"]').length,
    starsSurface: document.querySelector('#gsm-stars-surface-tab')?.getAttribute('aria-selected'),
    watchBadge: document.querySelector('[data-watch-unread-badge]')?.textContent?.trim() ?? null,
    radarBadge: document.querySelector('[data-radar-unseen-badge]')?.textContent?.trim() ?? null,
    extensionControls: document.querySelectorAll('[data-coach-target="sync"], [data-coach-target="auto-tags"], [data-coach-target="agent"], [data-coach-target="hide-panel"]').length,
    credentialInputs: document.querySelectorAll('input[type="password"], input[name*="token" i], textarea[name*="token" i], input[name*="key" i]').length,
    hasCanary: document.documentElement.innerHTML.includes(canary),
    hash: window.location.hash,
  }), DEMO_CANARY);
  assert.deepEqual(entry, {
    build: DEMO_CANARY,
    notice: assertStringIncludes(entry.notice, 'Not connected to GitHub'),
    featurePreviews: 0,
    starsSurface: 'true',
    watchBadge: '12',
    radarBadge: '9',
    extensionControls: 0,
    credentialInputs: 0,
    hasCanary: true,
    hash: '#gsm-tag=extension-only',
  });
  ok('standalone shell ignored extension-only hash state, rendered synthetic badges, and excluded extension controls');

  step('2) Stars search, filters, sort, annotations, resource blocking, and unstar stay local');
  const starsSearch = 'input[placeholder^="Search name"]';
  await setInput(page, starsSearch, 'aurora-workshop/beacon-kit');
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-layout-row-grid]')]
      .filter((row) => row.textContent?.trim());
    return rows.length === 1 && rows[0]?.textContent?.includes('aurora-workshop/beacon-kit');
  }, { timeout: 10_000 });
  await clickStarRow(page, 'aurora-workshop/beacon-kit');
  await page.waitForSelector('.drawer-enter textarea', { timeout: 10_000 });
  await setInput(page, '.drawer-enter input[placeholder^="Add a tag"]', 'DemoTag');
  await clickEnabledButtonByText(page, '.drawer-enter', 'Add');
  await page.waitForFunction(() => document.querySelector('.drawer-enter')?.textContent?.includes('DemoTag'), { timeout: 10_000 });
  await setInput(page, '.drawer-enter textarea', 'Browser smoke note');
  await clickEnabledButtonByText(page, '.drawer-enter', 'Save');
  await page.waitForFunction(() => document.querySelector('.drawer-enter textarea')?.value === 'Browser smoke note', { timeout: 10_000 });
  const urlBeforeBlockedLink = page.url();
  const blocked = await page.evaluate(() => {
    const link = [...(document.querySelector('.drawer-enter')?.querySelectorAll('a') ?? [])]
      .find((candidate) => candidate.textContent?.includes('aurora-workshop/beacon-kit'));
    if (!(link instanceof HTMLAnchorElement)) return false;
    link.click();
    return true;
  });
  assert.equal(blocked, true);
  await page.waitForFunction(() => document.body.textContent?.includes('intentionally disabled'), { timeout: 10_000 });
  assert.equal(page.url(), urlBeforeBlockedLink);
  await clickButtonByTitle(page, '.drawer-enter', 'Close (Esc)');
  const favoriteBefore = await readRowFavorite(page, 'aurora-workshop/beacon-kit');
  assert.equal(favoriteBefore, false);
  await clickRowFavorite(page, 'aurora-workshop/beacon-kit');
  await page.waitForFunction((name) => {
    const row = [...document.querySelectorAll('[data-layout-row-grid]')].find((candidate) => candidate.textContent?.includes(name));
    return row?.querySelector('.gsm-favorite-action')?.getAttribute('data-active') === 'true';
  }, { timeout: 10_000 }, 'aurora-workshop/beacon-kit');
  await setInput(page, starsSearch, '');
  await page.waitForFunction(() => document.querySelectorAll('[data-layout-row-grid]').length > 8, { timeout: 10_000 });
  const rowsBeforeFavoriteFilter = await visibleStarRowCount(page);
  await clickCheckboxByLabel(page, 'Favorites');
  await page.waitForFunction((before) => {
    const count = [...document.querySelectorAll('[data-layout-row-grid]')].filter((row) => row.textContent?.trim()).length;
    return count > 0 && count < before;
  }, { timeout: 10_000 }, rowsBeforeFavoriteFilter);
  await clickCheckboxByLabel(page, 'Favorites');
  await clickCheckboxByLabel(page, 'My public repositories');
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-layout-row-grid]')]
      .filter((row) => row.textContent?.trim());
    return rows.length > 0 && rows.every((row) => row.textContent?.includes('demo-scout/'));
  }, { timeout: 10_000 });
  await clickCheckboxByLabel(page, 'My public repositories');
  await page.waitForFunction(() => document.querySelectorAll('[data-layout-row-grid]').length > 8, { timeout: 10_000 });
  const firstBeforeSort = await firstVisibleRepository(page);
  await page.evaluate(() => {
    const button = document.querySelector('.lucide-arrow-down-wide-narrow')?.closest('button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('Sort direction action was unavailable.');
    button.click();
  });
  await page.waitForFunction((before) => {
    const row = [...document.querySelectorAll('[data-layout-row-grid]')].find((candidate) => candidate.textContent?.trim());
    return !!row && !row.textContent?.includes(before);
  }, { timeout: 10_000 }, firstBeforeSort);
  await setInput(page, starsSearch, 'aurora-workshop/beacon-kit');
  await page.waitForFunction(() => document.querySelectorAll('[data-layout-row-grid]').length === 1, { timeout: 10_000 });
  await page.click('button[aria-label="Unstar aurora-workshop/beacon-kit"]');
  await clickEnabledButtonByText(page, 'body', 'Confirm');
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-layout-row-grid]')]
    .some((row) => row.textContent?.includes('aurora-workshop/beacon-kit')), { timeout: 10_000 });
  await setInput(page, starsSearch, '');
  ok('search, owned/favorite filters, sort, tag, note, favorite, blocked link, and unstar behavior completed in memory');

  step('3) Watch collapse, unread/all, read, and done mutations stay coherent');
  await page.click('#gsm-watch-surface-tab');
  await page.waitForSelector('[data-watch-thread-row="1001"]', { timeout: 10_000 });
  await clickPressedChoice(page, '[data-surface="watch"]', 'All');
  await page.waitForFunction(() => (
    document.querySelector('[data-watch-history-sentinel]')?.textContent?.includes('15 threads')
    && document.querySelectorAll('[data-watch-thread-row]').length > 0
  ), { timeout: 10_000 });
  await page.click('button[aria-label="Collapse aurora-workshop/atlas-notes"]');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Expand aurora-workshop/atlas-notes"]'), { timeout: 10_000 });
  await page.click('button[aria-label="Expand aurora-workshop/atlas-notes"]');
  await page.click('[data-watch-thread="1001"]');
  await page.waitForFunction(() => document.querySelector('[data-watch-thread="1001"]')?.getAttribute('aria-expanded') === 'true', { timeout: 10_000 });
  await clickEnabledButtonByText(page, '[data-watch-thread-row="1001"]', 'Mark as read');
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-watch-thread-row="1001"]');
    return !!row && !row.querySelector('[title="Unread at the time of this snapshot"]')
      && document.querySelector('[data-watch-unread-badge]')?.textContent?.trim() === '11';
  }, { timeout: 10_000 });
  await clickEnabledButtonByText(page, '[data-watch-thread-row="1001"]', 'Mark as done');
  await page.waitForFunction(() => !document.querySelector('[data-watch-thread-row="1001"]'), { timeout: 10_000 });
  ok('Watch exposed all 15 threads across four repositories and committed collapse/read/done changes');

  step('4) Following and For You mutations update badges and Stars');
  await page.click('#gsm-radar-surface-tab');
  await page.waitForSelector('[data-radar-row="demo-radar-01"]', { timeout: 10_000 });
  await page.evaluate(() => document.querySelector('[data-radar-row="demo-radar-01"]')?.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  ));
  await page.waitForFunction(() => document.querySelector('[data-radar-row="demo-radar-01"]')?.getAttribute('data-radar-unseen') === 'false'
    && document.querySelector('[data-radar-unseen-badge]')?.textContent?.trim() === '8', { timeout: 10_000 });
  await page.click('[data-radar-row="demo-radar-01"] [data-radar-dismiss]');
  await page.waitForFunction(() => !document.querySelector('[data-radar-row="demo-radar-01"]'), { timeout: 10_000 });
  await clickPressedChoice(page, '[role="group"][aria-label="Following view"]', 'Projects');
  await page.waitForFunction(() => [...document.querySelectorAll('[role="group"][aria-label="Following view"] button')]
    .some((button) => button.textContent?.trim() === 'Projects' && button.getAttribute('aria-pressed') === 'true'), { timeout: 10_000 });
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[data-radar-discover-switcher] [role="tab"]')]
      .find((candidate) => candidate.textContent?.includes('For You'));
    if (!(tab instanceof HTMLButtonElement)) throw new Error('For You tab was unavailable.');
    tab.click();
  });
  await page.waitForSelector('[data-recommendation-row="blue-oak/outline-canvas"]', { timeout: 10_000 });
  await page.click('button[aria-label="Never recommend blue-oak/outline-canvas again"]');
  await page.waitForFunction(() => !document.querySelector('[data-recommendation-row="blue-oak/outline-canvas"]')
    && !!document.querySelector('[data-radar-ignored-section]'), { timeout: 10_000 });
  await scrollAndClick(page, '[data-radar-ignored-section] > button');
  await scrollAndClick(page, 'button[aria-label="Recommend blue-oak/outline-canvas again"]');
  await page.waitForSelector('[data-recommendation-row="blue-oak/outline-canvas"]', { timeout: 10_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-recommendation-row="blue-oak/outline-canvas"] [data-recommendation-action="favorite"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, { timeout: 10_000 });
  await scrollAndClick(page, '[data-recommendation-row="blue-oak/outline-canvas"] [data-recommendation-action="favorite"]');
  await page.waitForFunction(() => document.querySelector('[data-recommendation-row="blue-oak/outline-canvas"] [data-recommendation-action="favorite"]')?.getAttribute('data-active') === 'true', { timeout: 10_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-recommendation-row="daylight-code/route-sketch"] [data-recommendation-action="tag"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, { timeout: 10_000 });
  await scrollAndClick(page, '[data-recommendation-row="daylight-code/route-sketch"] [data-recommendation-action="tag"]');
  const recommendationTagComposer = '[data-recommendation-tag-composer="daylight-code/route-sketch"]';
  await page.waitForSelector(recommendationTagComposer, { timeout: 10_000 });
  await setInput(page, `${recommendationTagComposer} input[aria-label="Add tag"]`, 'Discovery');
  await clickEnabledButtonByText(page, recommendationTagComposer, 'Add tag');
  await page.waitForFunction(() => !document.querySelector('[data-recommendation-row="daylight-code/route-sketch"]'), { timeout: 10_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Star cloud-harbor/metric-garden on GitHub"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, { timeout: 10_000 });
  await scrollAndClick(page, 'button[aria-label="Star cloud-harbor/metric-garden on GitHub"]');
  await page.waitForFunction(() => !document.querySelector('[data-recommendation-row="cloud-harbor/metric-garden"]'), { timeout: 10_000 });
  await page.click('#gsm-stars-surface-tab');
  await setInput(page, starsSearch, 'cloud-harbor/metric-garden');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-layout-row-grid]')]
    .some((row) => row.textContent?.includes('cloud-harbor/metric-garden')), { timeout: 10_000 });
  ok('Following seen/dismiss and For You favorite/tag/ignore/restore/star mutations reprojected from canonical state');

  step('5) Both locales and themes remain coherent without Feature Previews');
  await page.evaluate(() => {
    const themeButton = document.querySelector('[data-toolbar-right] button');
    if (!(themeButton instanceof HTMLButtonElement)) throw new Error('Theme toggle was unavailable.');
    themeButton.click();
    const chinese = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '中文');
    if (!(chinese instanceof HTMLButtonElement)) throw new Error('Chinese locale toggle was unavailable.');
    chinese.click();
  });
  await page.waitForFunction(() => document.querySelector('[data-demo-theme]')?.getAttribute('data-demo-theme') === 'dark'
    && document.querySelector('[data-testid="demo-shell"]')?.getAttribute('data-demo-locale') === 'zh-CN', { timeout: 10_000 });
  const presentation = await page.evaluate(() => ({
    featurePreviews: document.querySelectorAll('[data-demo-view="previews"], [data-testid="feature-preview-gallery"]').length,
    interactiveHidden: document.querySelector('#demo-interactive-panel')?.hidden ?? false,
    theme: document.querySelector('[data-demo-theme]')?.getAttribute('data-demo-theme'),
    locale: document.querySelector('[data-testid="demo-shell"]')?.getAttribute('data-demo-locale'),
  }));
  assert.deepEqual(presentation, {
    featurePreviews: 0,
    interactiveHidden: false,
    theme: 'dark',
    locale: 'zh-CN',
  });
  ok('Chinese/dark presentation rendered while the removed Feature Previews surface stayed absent');

  step('6) Reset twice and reload restore the exact public baseline');
  await confirmReset(page);
  await waitForBaseline(page);
  await setInput(page, starsSearch, 'cloud-harbor/metric-garden');
  await page.waitForFunction(() => document.querySelectorAll('[data-layout-row-grid]').length === 0, { timeout: 10_000 });
  await setInput(page, starsSearch, 'aurora-workshop/beacon-kit');
  await page.waitForFunction(() => document.querySelectorAll('[data-layout-row-grid]').length === 1, { timeout: 10_000 });
  assert.equal(await readRowFavorite(page, 'aurora-workshop/beacon-kit'), false);
  await setInput(page, starsSearch, '');
  await confirmReset(page);
  await waitForBaseline(page);
  await setInput(page, starsSearch, 'mutated query');
  await page.reload({ waitUntil: 'networkidle0', timeout: 45_000 });
  await waitForBaseline(page);
  ok('repeated reset and reload restored locale/theme/search/data badges and canonical rows');

  step('7) Narrow viewport remains contained');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.reload({ waitUntil: 'networkidle0', timeout: 45_000 });
  await waitForBaseline(page);
  const narrow = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    interactiveHost: document.querySelectorAll('[data-testid="demo-interactive-host"]').length,
    featurePreviews: document.querySelectorAll('[data-demo-view="previews"], [data-testid="feature-preview-gallery"]').length,
    brokenImages: [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).length,
  }));
  assert.equal(narrow.scrollWidth <= narrow.innerWidth, true, `document overflowed horizontally: ${JSON.stringify(narrow)}`);
  assert.equal(narrow.interactiveHost, 1);
  assert.equal(narrow.featurePreviews, 0);
  assert.equal(narrow.brokenImages, 0);
  ok('mobile interactive shell had no document overflow, removed preview surface, or broken local assets');

  assert.deepEqual(externalRequests, [], `Demo attempted external requests:\n${externalRequests.join('\n')}`);
  assert.deepEqual(
    mainFrameUrls.filter((url) => url && !url.startsWith(origin) && url !== 'about:blank'),
    [],
    `Demo escaped its static origin: ${mainFrameUrls.join(', ')}`,
  );
  assert.deepEqual(pageIssues, [], `Demo emitted browser errors:\n${pageIssues.join('\n')}`);
  console.log('\n✅ Built Demo browser smoke passed with zero external requests.');
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
}

function assertStringIncludes(value, expected) {
  assert.equal(typeof value, 'string');
  assert.match(value, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  return value;
}

async function waitForStars(page) {
  await page.waitForFunction(() => document.querySelector('#gsm-stars-surface-tab')?.getAttribute('aria-selected') === 'true'
    && document.querySelectorAll('[data-layout-row-grid]').length > 0
    && document.querySelector('[data-watch-unread-badge]')?.textContent?.trim() === '12'
    && document.querySelector('[data-radar-unseen-badge]')?.textContent?.trim() === '9', { timeout: 20_000 });
}

async function waitForBaseline(page) {
  await page.waitForFunction(() => document.querySelector('#gsm-stars-surface-tab')?.getAttribute('aria-selected') === 'true'
    && document.querySelector('[data-demo-theme]')?.getAttribute('data-demo-theme') === 'light'
    && document.querySelector('[data-testid="demo-shell"]')?.getAttribute('data-demo-locale') === 'en'
    && document.querySelector('input[placeholder^="Search name"]')?.value === ''
    && document.querySelector('[data-watch-unread-badge]')?.textContent?.trim() === '12'
    && document.querySelector('[data-radar-unseen-badge]')?.textContent?.trim() === '9'
    && document.querySelectorAll('[data-layout-row-grid]').length > 0, { timeout: 20_000 });
}

async function setInput(page, selector, value) {
  const changed = await page.evaluate((target, next) => {
    const input = document.querySelector(target);
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(input, next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, selector, value);
  assert.equal(changed, true, `Input ${selector} was unavailable.`);
}

async function clickEnabledButtonByText(page, scopeSelector, text) {
  const clicked = await page.evaluate((scopeTarget, expected) => {
    const scope = document.querySelector(scopeTarget);
    const button = [...(scope?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === expected && !candidate.disabled && candidate.getClientRects().length > 0);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.scrollIntoView({ block: 'nearest' });
    button.click();
    return true;
  }, scopeSelector, text);
  assert.equal(clicked, true, `Enabled ${text} button was unavailable in ${scopeSelector}.`);
}

async function clickButtonByTitle(page, scopeSelector, title) {
  const clicked = await page.evaluate((scopeTarget, expected) => {
    const scope = document.querySelector(scopeTarget);
    const button = [...(scope?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.title === expected && !candidate.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }, scopeSelector, title);
  assert.equal(clicked, true, `${title} button was unavailable in ${scopeSelector}.`);
}

async function clickStarRow(page, fullName) {
  const clicked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[data-layout-row-grid]')]
      .find((candidate) => candidate.textContent?.includes(name));
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  }, fullName);
  assert.equal(clicked, true, `Stars row ${fullName} was unavailable.`);
}

async function readRowFavorite(page, fullName) {
  return page.evaluate((name) => {
    const row = [...document.querySelectorAll('[data-layout-row-grid]')]
      .find((candidate) => candidate.textContent?.includes(name));
    return row?.querySelector('.gsm-favorite-action')?.getAttribute('data-active') === 'true';
  }, fullName);
}

async function clickRowFavorite(page, fullName) {
  const clicked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[data-layout-row-grid]')]
      .find((candidate) => candidate.textContent?.includes(name));
    const button = row?.querySelector('.gsm-favorite-action');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }, fullName);
  assert.equal(clicked, true, `Favorite action for ${fullName} was unavailable.`);
}

async function visibleStarRowCount(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-layout-row-grid]')]
    .filter((row) => row.textContent?.trim()).length);
}

async function firstVisibleRepository(page) {
  const fullName = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-layout-row-grid]')]
      .find((candidate) => candidate.textContent?.trim());
    return row?.querySelector('[data-row-col="repository"]')?.textContent?.trim() ?? null;
  });
  assert.ok(fullName, 'No visible repository row was available.');
  return fullName;
}

async function clickCheckboxByLabel(page, label) {
  const clicked = await page.evaluate((expected) => {
    const checkbox = [...document.querySelectorAll('[role="checkbox"]')]
      .find((candidate) => candidate.parentElement?.textContent?.includes(expected));
    if (!(checkbox instanceof HTMLButtonElement)) return false;
    checkbox.click();
    return true;
  }, label);
  assert.equal(clicked, true, `${label} checkbox was unavailable.`);
}

async function clickPressedChoice(page, scopeSelector, label) {
  const clicked = await page.evaluate((scopeTarget, expected) => {
    const scope = document.querySelector(scopeTarget);
    const button = [...(scope?.querySelectorAll('button') ?? [])]

      .find((candidate) => candidate.textContent?.trim() === expected && !candidate.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }, scopeSelector, label);
  assert.equal(clicked, true, `${label} choice was unavailable in ${scopeSelector}.`);
}
async function scrollAndClick(page, selector) {
  const clicked = await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!(element instanceof HTMLElement)) return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    element.scrollIntoView({ block: 'center' });
    element.click();
    return true;
  }, selector);
  assert.equal(clicked, true, `${selector} was unavailable.`);
}

async function confirmReset(page) {
  await page.click('[data-testid="demo-reset"]');
  await page.waitForSelector('[data-testid="demo-reset-confirmation"]', { timeout: 10_000 });
  await page.click('[data-testid="demo-reset-confirm"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="demo-reset-confirmation"]'), { timeout: 10_000 });
}
