#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchExtensionBrowser } from './puppeteer-runtime.mjs';

const DIST = path.resolve(process.cwd(), process.env.GSM_DIST_DIR ?? 'dist');
const OPTIONS_PATH = '/src/options/index.html';
const POPUP_PATH = '/src/popup/index.html';
const INVALID_TOKEN = 'github_pat_invalid_extension_browser_smoke';
const STARS_URL = 'https://github.com/smoke-user?tab=stars';
const REPO_URL = 'https://github.com/smoke-user/smoke-repo';
const DOM_POLLING_MS = 100;

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
  await waitForPopupNoTokenState(popup);

  const openedOptions = waitForExtensionPage(`${OPTIONS_PATH}`);
  await clickButtonByText(popup, /^Add PAT$/i);
  const optionsFromPopup = await openedOptions;
  await optionsFromPopup.waitForSelector('textarea', { timeout: 10_000 });
  await waitForBodyText(optionsFromPopup, 'GitHub Token');
  ok('popup rendered no-token state and Add PAT opened Options');

  step('2) Options rejects invalid token without persisting auth');
  await interceptGitHubApi(optionsFromPopup, invalidTokenApiResponse);
  await assertInvalidTokenApiStub(optionsFromPopup);
  await saveToken(optionsFromPopup, INVALID_TOKEN);
  await waitForBodyText(
    optionsFromPopup,
    'GitHub rejected this token. Check that you copied the whole value.',
    8_000,
  );
  await assertNoAuthenticatedBanner(optionsFromPopup);
  ok('invalid token was rejected and no authenticated banner appeared');

  step('3) Cubby disclosure is collapsed and does not gate Test');
  await assertAgentDisclosureInfo(optionsFromPopup);
  ok('real Options kept disclosure collapsed while allowing Test without acceptance');

  step('4) Stars page fixture does not inject panel without owner proof');
  const noTokenStars = await browser.newPage();
  hookPageDiagnostics(noTokenStars, 'stars-no-token');
  await interceptGitHubPages(noTokenStars);
  await noTokenStars.goto(STARS_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await noTokenStars.waitForSelector('main', { timeout: 10_000 });
  await expectNoManager(noTokenStars);
  ok('stars fixture loaded and manager stayed absent without token/user identity');

  step('5) Stars page injects panel and toggles FAB when local config has matching owner');
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
  await assertAgentAndAutoTagsRemainSeparate(ownStars);
  await assertAutoTagAgentFirstClickChoice(ownStars);
  await assertAgentDrawerA11y(ownStars);
  await assertScrollLocked(ownStars);
  await clickShadowButton(ownStars, '[data-coach-target="hide-panel"]');
  await waitForFab(ownStars);
  await clickFab(ownStars);
  await waitForManagerRoot(ownStars);
  ok('manager injected, first Auto Tags click offered Cubby, drawer opened accessibly, and panel toggle worked');

  step('6) Turbo-style navigation does not duplicate extension hosts');
  await ownStars.evaluate(() => {
    history.pushState({}, '', '/smoke-user?tab=stars&smoke=turbo');
    document.dispatchEvent(new Event('turbo:load'));
    document.dispatchEvent(new Event('turbo:render'));
  });
  await ownStars.waitForFunction(
    () => document.querySelectorAll('#gsm-manager-host').length === 1,
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const counts = await ownStars.evaluate(() => ({
    panels: document.querySelectorAll('#gsm-manager-host').length,
    fabs: document.querySelectorAll('#gsm-fab').length,
  }));
  assert.deepEqual(counts, { panels: 1, fabs: 0 });
  ok('turbo events kept a single manager host and no duplicate FAB');

  step('7) Repo page fixture gets tag-chip host only on repo-shaped path');
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
  }, { polling: DOM_POLLING_MS, timeout: 10_000 });
  ok('repo fixture received a shadow-root tag chip');

  if (pageIssues.length) {
    failures.push(`unexpected browser diagnostics:\n${pageIssues.join('\n')}`);
  }
} catch (error) {
  const errorText = error instanceof Error ? error.stack ?? error.message : String(error);
  const browserState = browser
    ? await captureDiagnostic(
        () => describeBrowserState(browser),
        'browser diagnostic capture',
        5_000,
      )
    : 'browser was not launched';
  const issueText = pageIssues.length
    ? `\nPage issues:\n${pageIssues.join('\n')}`
    : '';
  failures.push(`${errorText}\n\nBrowser state at failure:\n${browserState}${issueText}`);
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
  let lastState = 'extension discovery returned no data';
  while (Date.now() < deadline) {
    const extensions = await browser.extensions().catch(() => null);
    const installed = [...(extensions?.values() ?? [])].find((extension) =>
      extension.enabled && path.resolve(extension.path) === DIST,
    );
    const workerTarget = installed
      ? browser.targets().find((candidate) =>
          candidate.type() === 'service_worker' &&
          candidate.url().startsWith(`chrome-extension://${installed.id}/`),
        )
      : null;

    if (installed && workerTarget) {
      try {
        const worker = await workerTarget.worker();
        const runtimeId = await worker?.evaluate(() => chrome.runtime.id);
        if (runtimeId === installed.id) return installed.id;
        lastState = `service worker returned unexpected runtime ID: ${String(runtimeId)}`;
      } catch (error) {
        lastState = `service worker was present but not executable: ${formatError(error)}`;
      }
    } else {
      lastState = JSON.stringify({
        extensions: [...(extensions?.values() ?? [])].map((extension) => ({
          id: extension.id,
          name: extension.name,
          path: extension.path,
          enabled: extension.enabled,
        })),
        extensionTargets: browser.targets()
          .filter((candidate) => candidate.url().startsWith('chrome-extension://'))
          .map((candidate) => ({ type: candidate.type(), url: candidate.url() })),
      });
    }
    await delay(250);
  }
  throw new Error(
    `current dist extension did not become ready after waiting for MV3 service worker load. Last state: ${lastState}`,
  );
}

async function openExtensionPage(extId, pagePath, label) {
  const page = await browser.newPage();
  hookPageDiagnostics(page, label);
  const expectedUrl = `chrome-extension://${extId}${pagePath}`;
  await page.goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  try {
    await page.waitForFunction(
      (url) => location.href === url && document.readyState !== 'loading' && !!document.getElementById('root'),
      { polling: DOM_POLLING_MS, timeout: 10_000 },
      expectedUrl,
    );
  } catch (error) {
    throw await pageWaitError(page, `extension document did not become ready at ${expectedUrl}`, error);
  }
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

async function assertAgentDisclosureInfo(page) {
  await page.waitForSelector('[data-testid="agent-data-disclosure"]', { timeout: 10_000 });
  const initial = await page.evaluate(() => ({
    categoryCount: document.querySelectorAll('[data-disclosure-category]').length,
    collapsed: document.querySelector('[data-testid="agent-data-disclosure"] details')?.open === false,
    originVisible: document.querySelector('[data-testid="agent-data-disclosure"]')
      ?.textContent?.includes('https://api.openai.com') ?? false,
  }));
  assert.deepEqual(initial, { categoryCount: 4, collapsed: true, originVisible: true });

  await page.$eval('#agent-api-key', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'transient-smoke-key');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const disabledWithoutAcceptance = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Test connection'));
    return button?.disabled ?? null;
  });
  assert.equal(disabledWithoutAcceptance, false);

  const acceptance = await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('gsm_config');
    return stored.gsm_config?.agentDataDisclosureAcceptance ?? null;
  });
  assert.equal(acceptance, null);
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
  const textarea = await page.waitForSelector('textarea:not([disabled])', {
    visible: true,
    timeout: 10_000,
  });
  assert.ok(textarea, 'GitHub token textarea did not become editable');
  await textarea.evaluate((element) => {
    element.focus();
    element.select();
  });
  await page.keyboard.type(token);
  try {
    await page.waitForFunction(
      (expected) => document.querySelector('textarea')?.value === expected,
      { polling: DOM_POLLING_MS, timeout: 5_000 },
      token,
    );
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((button) =>
        /^Save & verify$/i.test((button.textContent || '').trim()) && !button.disabled,
      ),
      { polling: DOM_POLLING_MS, timeout: 5_000 },
    );
  } catch (error) {
    throw await pageWaitError(page, 'GitHub token input did not enable Save & verify', error);
  }
  await clickButtonByText(page, /^Save & verify$/i);
}

async function waitForBodyText(page, text, timeout = 20_000) {
  try {
    await page.waitForFunction(
      (expected) => document.body?.innerText.includes(expected),
      { polling: DOM_POLLING_MS, timeout },
      text,
    );
  } catch (error) {
    throw await pageWaitError(page, `body did not contain ${JSON.stringify(text)}`, error);
  }
}

async function waitForPopupNoTokenState(page, timeout = 20_000) {
  try {
    await page.waitForFunction(
      () => {
        const hasNoTokenText = document.body?.innerText.includes('No token configured');
        const hasAddPatButton = [...document.querySelectorAll('button')]
          .some((node) => /^Add PAT$/i.test((node.textContent || '').trim()));
        return hasNoTokenText && hasAddPatButton;
      },
      { polling: DOM_POLLING_MS, timeout },
    );
  } catch (error) {
    throw await pageWaitError(page, 'popup did not render the no-token text and Add PAT button together', error);
  }
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

async function expectNoManager(page) {
  await delay(1000);
  const present = await page.evaluate(() => !!document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root'));
  assert.equal(present, false, 'manager unexpectedly injected without owner proof');
}

async function waitForManagerRoot(page) {
  await page.waitForFunction(
    () => !!document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root'),
    { polling: DOM_POLLING_MS, timeout: 20_000 },
  );
}

async function assertScrollLocked(page) {
  const overflow = await page.evaluate(() => ({
    html: document.documentElement.style.overflow,
    body: document.body.style.overflow,
  }));
  assert.deepEqual(overflow, { html: 'hidden', body: 'hidden' });
}

async function assertAgentAndAutoTagsRemainSeparate(page) {
  const result = await page.evaluate(async () => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const autoTags = root?.querySelector('[data-coach-target="auto-tags"]');
    const agent = root?.querySelector('[data-coach-target="agent"]');
    const mascot = agent?.querySelector('[data-testid="agent-mascot-icon"]');
    const mascotStyle = mascot ? getComputedStyle(mascot) : null;
    const mascotUrl = mascot?.getAttribute('src') ?? null;
    const mascotResponse = mascotUrl ? await fetch(mascotUrl) : null;
    return {
      autoTagsText: autoTags?.textContent?.trim() ?? null,
      agentText: agent?.textContent?.trim() ?? null,
      nested: !!(autoTags?.contains(agent) || agent?.contains(autoTags)),
      retryPresent: /Retry failed only/i.test(root?.textContent ?? ''),
      mascotAriaHidden: mascot?.getAttribute('aria-hidden') ?? null,
      mascotWidth: mascotStyle?.width ?? null,
      mascotHeight: mascotStyle?.height ?? null,
      mascotImageRendering: mascotStyle?.imageRendering ?? null,
      mascotAnimationName: mascotStyle?.animationName ?? null,
      mascotResourceOk: mascotResponse?.ok ?? false,
    };
  });
  assert.equal(result.autoTagsText, 'Auto Tags');
  assert.equal(result.agentText, 'Cubby');
  assert.equal(result.nested, false);
  assert.equal(result.retryPresent, false);
  assert.deepEqual({
    ariaHidden: result.mascotAriaHidden,
    width: result.mascotWidth,
    height: result.mascotHeight,
    imageRendering: result.mascotImageRendering,
    animationName: result.mascotAnimationName,
    resourceOk: result.mascotResourceOk,
  }, {
    ariaHidden: 'true',
    width: '20px',
    height: '20px',
    imageRendering: 'pixelated',
    animationName: 'none',
    resourceOk: true,
  });
}

async function assertAutoTagAgentFirstClickChoice(page) {
  await clickShadowButton(page, '[data-coach-target="auto-tags"]');
  await page.waitForFunction(
    () => !!document
      .getElementById('gsm-manager-host')
      ?.shadowRoot
      ?.querySelector('[data-testid="auto-tag-agent-prompt"] [role="dialog"]'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const initial = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const prompt = root?.querySelector('[data-testid="auto-tag-agent-prompt"]');
    return {
      titleVisible: prompt?.textContent?.includes('Try Cubby for smarter tagging?') ?? false,
      yesVisible: prompt?.textContent?.includes('Yes, open Cubby') ?? false,
      noVisible: prompt?.textContent?.includes('No, use Auto Tags') ?? false,
      focusedText: root?.activeElement?.textContent?.trim() ?? null,
    };
  });
  assert.deepEqual(initial, {
    titleVisible: true,
    yesVisible: true,
    noVisible: true,
    focusedText: 'Yes, open Cubby',
  });

  const choseLocal = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const button = [...(root?.querySelectorAll('[data-testid="auto-tag-agent-prompt"] button') ?? [])]
      .find((candidate) => candidate.textContent?.includes('No, use Auto Tags'));
    button?.click();
    return !!button;
  });
  assert.equal(choseLocal, true);
  await page.waitForFunction(
    () => !document
      .getElementById('gsm-manager-host')
      ?.shadowRoot
      ?.querySelector('[data-testid="auto-tag-agent-prompt"]'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const agentDrawerOpened = await page.evaluate(() => !!document
    .getElementById('gsm-manager-host')
    ?.shadowRoot
    ?.querySelector('#gsm-agent-dialog-title'));
  assert.equal(agentDrawerOpened, false, 'choosing local Auto Tags should not open Cubby');
}

async function assertAgentDrawerA11y(page) {
  await clickShadowButton(page, '[data-coach-target="agent"]');
  await page.waitForFunction(
    () => !!document
      .getElementById('gsm-manager-host')
      ?.shadowRoot
      ?.querySelector('[role="dialog"][aria-modal="true"]'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const state = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const dialog = root?.querySelector('[role="dialog"]');
    return {
      labelledBy: dialog?.getAttribute('aria-labelledby') ?? null,
      title: root?.getElementById('gsm-agent-dialog-title')?.textContent?.trim() ?? null,
      focusedLabel: root?.activeElement?.getAttribute('aria-label') ?? null,
      setupVisible: !!root?.querySelector('[data-testid="agent-setup-gate"]'),
      composerVisible: !!root?.querySelector('textarea'),
    };
  });
  assert.deepEqual(state, {
    labelledBy: 'gsm-agent-dialog-title',
    title: 'Cubby',
    focusedLabel: 'Close Cubby',
    setupVisible: false,
    composerVisible: true,
  });
  const mascot = await page.evaluate(async () => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const element = root?.querySelector('[data-testid="agent-mascot"]');
    const style = element ? getComputedStyle(element) : null;
    const assetUrl = style?.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/u)?.[1] ?? null;
    const response = assetUrl ? await fetch(assetUrl) : null;
    const bytes = response?.ok ? (await response.blob()).size : 0;
    return {
      ariaHidden: element?.getAttribute('aria-hidden') ?? null,
      state: element?.getAttribute('data-state') ?? null,
      width: style?.width ?? null,
      height: style?.height ?? null,
      backgroundSize: style?.backgroundSize ?? null,
      imageRendering: style?.imageRendering ?? null,
      animationName: style?.animationName ?? null,
      animationTimingFunction: style?.animationTimingFunction ?? null,
      assetUrl,
      resourceOk: response?.ok ?? false,
      bytes,
    };
  });
  assert.deepEqual({
    ariaHidden: mascot.ariaHidden,
    state: mascot.state,
    width: mascot.width,
    height: mascot.height,
    backgroundSize: mascot.backgroundSize,
    imageRendering: mascot.imageRendering,
    animationName: mascot.animationName,
    resourceOk: mascot.resourceOk,
  }, {
    ariaHidden: 'true',
    state: 'idle',
    width: '32px',
    height: '32px',
    backgroundSize: '256px 288px',
    imageRendering: 'pixelated',
    animationName: 'gsm-agent-mascot-cycle',
    resourceOk: true,
  });
  assert.match(mascot.animationTimingFunction ?? '', /^steps\(8(?:, end)?\)$/u);
  assert.match(mascot.assetUrl ?? '', /^chrome-extension:\/\/[^/]+\/assets\/index-agent-atlas-[^/]+\.png$/u);
  assert.equal(mascot.bytes > 0, true);
  await clickShadowButton(page, 'button[aria-label="Prompt suggestions"]');
  await page.waitForFunction(
    () => !!document
      .getElementById('gsm-manager-host')
      ?.shadowRoot
      ?.querySelector('[role="group"][aria-label="Suggested prompts"]'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const functionLabels = await page.evaluate(() => [...(
    document
      .getElementById('gsm-manager-host')
      ?.shadowRoot
      ?.querySelectorAll('[role="group"][aria-label="Suggested prompts"] button') ?? []
  )].map((item) => item.querySelector('span > span')?.textContent?.trim() ?? ''));
  assert.deepEqual(functionLabels, [
    'Summarize current scope',
    'Find similar tools',
    'Organize full library',
    'Review tag names',
  ]);
  await clickShadowButton(page, 'button[aria-label="Prompt suggestions"]');
  await page.waitForFunction(
    () => !document
      .getElementById('gsm-manager-host')
      ?.shadowRoot
      ?.querySelector('[role="group"][aria-label="Suggested prompts"]'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const originalViewport = page.viewport() ?? { width: 800, height: 600, deviceScaleFactor: 1 };
  await page.setViewport({ width: 360, height: 720, deviceScaleFactor: 1 });
  const narrow = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const dialog = root?.querySelector('[role="dialog"]');
    const close = root?.querySelector('button[aria-label="Close Cubby"]');
    const dialogRect = dialog?.getBoundingClientRect();
    const closeRect = close?.getBoundingClientRect();
    return {
      dialogLeft: dialogRect?.left ?? -1,
      dialogRight: dialogRect?.right ?? -1,
      dialogWidth: dialogRect?.width ?? -1,
      dialogOverflow: dialog ? dialog.scrollWidth - dialog.clientWidth : -1,
      closeRight: closeRect?.right ?? -1,
      viewportWidth: innerWidth,
    };
  });
  assert.equal(narrow.dialogLeft >= 0, true);
  assert.equal(narrow.dialogRight <= narrow.viewportWidth, true);
  assert.equal(narrow.dialogWidth <= narrow.viewportWidth, true);
  assert.equal(narrow.dialogOverflow <= 1, true);
  assert.equal(narrow.closeRight <= narrow.viewportWidth, true);
  await page.setViewport(originalViewport);
  await clickShadowButton(page, 'button[aria-label="Close Cubby"]');
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
  await page.waitForFunction(
    () => !!document.getElementById('gsm-fab')?.shadowRoot?.querySelector('button'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
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
    const location = message.location();
    recordPageIssue(label, `console.error: ${text}${location.url ? ` (${location.url})` : ''}`);
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (
      url.startsWith('chrome-extension://') ||
      url.startsWith('https://github.com/') ||
      url.startsWith('https://api.github.com/')
    ) {
      recordPageIssue(label, `request failed: ${url} ${request.failure()?.errorText ?? ''}`);
    }
  });
  page.on('pageerror', (error) => {
    recordPageIssue(label, `page error: ${formatError(error)}`);
  });
}

async function pageWaitError(page, message, cause) {
  const state = await captureDiagnostic(
    () => describePageState(page),
    'page diagnostic capture',
    3_000,
  );
  return new Error(`${message}: ${formatError(cause)}\nPage state:\n${state}`);
}

async function describeBrowserState(browser) {
  const pages = await browser.pages();
  const pageStates = await Promise.all(pages.map(async (page, index) => {
    const state = await describePageState(page).catch((error) =>
      `page diagnostic capture failed: ${formatError(error)}`,
    );
    return `page[${index}]:\n${state}`;
  }));
  const targets = browser.targets().map((target) => ({
    type: target.type(),
    url: target.url(),
  }));
  return `${pageStates.join('\n')}\ntargets: ${JSON.stringify(targets, null, 2)}`;
}

async function describePageState(page) {
  if (page.isClosed()) return 'closed=true';
  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    bodyText: (document.body?.innerText ?? '').slice(0, 4_000),
    rootHtml: (document.getElementById('root')?.innerHTML ?? '').slice(0, 4_000),
    buttons: [...document.querySelectorAll('button')].map((button) => ({
      text: (button.textContent || '').trim(),
      disabled: button.disabled,
      ariaLabel: button.getAttribute('aria-label'),
    })),
    textareas: [...document.querySelectorAll('textarea')].map((textarea) => ({
      disabled: textarea.disabled,
      valueLength: textarea.value.length,
      placeholder: textarea.placeholder,
    })),
    scripts: [...document.scripts].map((script) => script.src || '<inline>'),
  }));
  return JSON.stringify(state, null, 2);
}

function formatError(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function captureDiagnostic(task, label, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(task)
        .catch((error) => `${label} failed: ${formatError(error)}`),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(`${label} timed out after ${timeoutMs}ms`), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
