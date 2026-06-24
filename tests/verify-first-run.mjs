#!/usr/bin/env node
import puppeteer from 'puppeteer';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteSyncGists } from './gist-sync-admin.mjs';

const DIST = path.resolve(process.cwd(), 'dist');
const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RESET_GIST = process.env.GSM_RESET_GIST === '1';
const OPTIONS_PATH = '/src/options/index.html';
const INVALID_TOKEN =
  process.env.GH_TOKEN_INVALID ||
  'github_pat_invalid_test_value_for_first_run_matrix';

const args = new Set(process.argv.slice(2));
const selectedArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--scenario='));
const selectedNames = selectedArg
  ? new Set(
      selectedArg
        .slice('--scenario='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )
  : null;

if (args.has('--help')) {
  console.log(`Usage:
  pnpm build
  GH_TOKEN=... GH_USER=... pnpm test:verify-first-run

Optional env:
  GH_TOKEN_NO_STARS=...   token that can read /user but lacks Stars:Read
  GH_TOKEN_NO_GISTS=...   token that can read /user but lacks Gists:ReadWrite
  GH_TOKEN_INVALID=...    override the fake invalid token used in the rejection test
  GSM_RESET_GIST=1        delete existing sync gists before the valid-token scenario

Optional args:
  --scenario=no-token,invalid-token,valid-token
`);
  process.exit(0);
}

if (!existsSync(path.join(DIST, 'manifest.json'))) {
  console.error(`❌ No dist/manifest.json found at ${DIST}. Run "pnpm build" first.`);
  process.exit(1);
}

const summaries = [];
const starsUser = await resolveGitHubUser();

const scenarios = [
  {
    id: 'no-token',
    title: 'first visit without a token shows onboarding and opens Options',
    needsStarsUser: true,
    run: async ({ browser, extId, starsUrl }) => {
      const stars = await openStars(browser, starsUrl);
      await waitForManagerRoot(stars);
      await waitForText(stars, 'Welcome to Better GitHub Stars Manager');
      await waitForText(stars, 'To manage your stars, add a GitHub token first:');
      await waitForText(stars, 'Open Options');

      const optionsTargetPromise = browser.waitForTarget(
        (target) => target.url() === `chrome-extension://${extId}${OPTIONS_PATH}`,
        { timeout: 10_000 },
      );

      await clickButtonByText(stars, /^Open Options$/i);
      const optionsTarget = await optionsTargetPromise;
      const optionsPage = await optionsTarget.page();
      if (!optionsPage) throw new Error('Options page target opened but no page handle was available');
      await optionsPage.waitForSelector('textarea', { timeout: 10_000 });
    },
  },
  {
    id: 'invalid-token',
    title: 'invalid token is rejected and first-run remains blocked',
    needsStarsUser: true,
    run: async ({ browser, extId, starsUrl }) => {
      const page = await openOptions(browser, extId);
      await saveToken(page, INVALID_TOKEN);
      await waitForText(page, 'GitHub rejected this token. Check that you copied the whole value.');
      await expectNoAuthenticatedBanner(page);

      const stars = await openStars(browser, starsUrl);
      await waitForManagerRoot(stars);
      await waitForText(stars, 'To manage your stars, add a GitHub token first:');
    },
  },
  {
    id: 'no-stars-token',
    title: 'token without Stars permission is explained clearly',
    needsStarsUser: true,
    token: process.env.GH_TOKEN_NO_STARS || null,
    run: async ({ browser, extId, starsUrl, token }) => {
      const page = await openOptions(browser, extId);
      await saveToken(page, token);
      await waitForText(page, 'Public Repositories (read)');
      await expectNoAuthenticatedBanner(page);

      const stars = await openStars(browser, starsUrl);
      await waitForManagerRoot(stars);
      await waitForText(stars, 'To manage your stars, add a GitHub token first:');
    },
  },
  {
    id: 'no-gists-token',
    title: 'token without Gists permission is explained clearly',
    needsStarsUser: true,
    token: process.env.GH_TOKEN_NO_GISTS || null,
    run: async ({ browser, extId, starsUrl, token }) => {
      const page = await openOptions(browser, extId);
      await saveToken(page, token);
      await waitForText(page, 'Gists (read/write)');
      await expectNoAuthenticatedBanner(page);

      const stars = await openStars(browser, starsUrl);
      await waitForManagerRoot(stars);
      await waitForText(stars, 'To manage your stars, add a GitHub token first:');
    },
  },
  {
    id: 'valid-token',
    title: 'valid token reaches the stars page and first sync renders rows',
    needsStarsUser: true,
    token: process.env.GH_TOKEN || null,
    run: async ({ browser, extId, starsUrl, token }) => {
      if (RESET_GIST) {
        const removed = await deleteSyncGists(token, {
          log: (line) => console.log(`   ${line}`),
        });
        console.log(`   reset ${removed.length} sync gist(s) before the happy-path run`);
      }

      const page = await openOptions(browser, extId);
      await saveToken(page, token);
      await waitForText(page, 'Authenticated as @');
      await waitForText(page, 'Token verified. Logged in as');

      const stars = await openStars(browser, starsUrl);
      await waitForManagerRoot(stars);
      const rowCount = await waitForRows(stars);
      const counter = await readCounter(stars);

      if (!counter) throw new Error('could not find the header counter after first sync');
      console.log(`   rows in viewport: ${rowCount}`);
      console.log(`   header counter: ${counter.filtered}/${counter.total}`);
    },
  },
];

if (args.has('--list')) {
  for (const scenario of scenarios) {
    console.log(scenario.id);
  }
  process.exit(0);
}

for (const scenario of scenarios) {
  if (selectedNames && !selectedNames.has(scenario.id)) continue;

  if (scenario.needsStarsUser && !starsUser) {
    summaries.push({
      id: scenario.id,
      status: 'skipped',
      reason:
        'Could not determine GH_USER. Set GH_USER, GH_TOKEN, GH_TOKEN_NO_STARS, or GH_TOKEN_NO_GISTS.',
    });
    continue;
  }

  if ('token' in scenario && !scenario.token) {
    summaries.push({
      id: scenario.id,
      status: 'skipped',
      reason: `Missing required env for ${scenario.id}`,
    });
    continue;
  }

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), `gsm-${scenario.id}-`));
  let browser = null;

  console.log(`\n=== ${scenario.id} ===`);
  console.log(`Target: ${scenario.title}`);
  console.log(`Profile: ${userDataDir}`);

  try {
    browser = await launchBrowser(userDataDir);
    const extId = await detectExtensionId(browser);
    const starsUrl = `https://github.com/${starsUser}?tab=stars`;

    await scenario.run({
      browser,
      extId,
      starsUrl,
      token: scenario.token,
    });

    summaries.push({ id: scenario.id, status: 'passed' });
    console.log(`✅ ${scenario.id} passed`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summaries.push({ id: scenario.id, status: 'failed', reason: message });
    console.error(`❌ ${scenario.id} failed: ${message}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

console.log('\nSummary:');
for (const item of summaries) {
  const tail = item.reason ? ` — ${item.reason}` : '';
  console.log(` - ${item.id}: ${item.status}${tail}`);
}

const failed = summaries.filter((item) => item.status === 'failed');
if (failed.length > 0) process.exit(1);

async function resolveGitHubUser() {
  if (process.env.GH_USER) return process.env.GH_USER;

  for (const token of [
    process.env.GH_TOKEN,
    process.env.GH_TOKEN_NO_STARS,
    process.env.GH_TOKEN_NO_GISTS,
  ]) {
    if (!token) continue;
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.login) return body.login;
    } catch {}
  }

  return null;
}

async function launchBrowser(userDataDir) {
  return puppeteer.launch({
    headless: false,
    executablePath: CHROME_PATH,
    userDataDir,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

async function detectExtensionId(browser) {
  const target =
    (await browser.waitForTarget(
      (t) =>
        t.type() === 'service_worker' &&
        t.url().startsWith('chrome-extension://'),
      { timeout: 10_000 },
    ).catch(() => null)) ||
    (await browser.waitForTarget(
      (t) => t.url().startsWith('chrome-extension://'),
      { timeout: 10_000 },
    ).catch(() => null));

  const extId = target?.url().match(/chrome-extension:\/\/([a-z]+)/i)?.[1];
  if (!extId) throw new Error('could not determine extension ID');
  return extId;
}

async function openOptions(browser, extId) {
  const page = await browser.newPage();
  hookPageDiagnostics(page, 'options');
  await page.goto(`chrome-extension://${extId}${OPTIONS_PATH}`, {
    waitUntil: 'networkidle0',
  });
  await page.waitForSelector('textarea', { timeout: 10_000 });
  return page;
}

async function saveToken(page, token) {
  await page.click('textarea', { clickCount: 3 }).catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.type('textarea', token);
  await clickButtonByText(page, /save|verify/i);
}

async function openStars(browser, url) {
  const page = await browser.newPage();
  hookPageDiagnostics(page, 'stars');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return page;
}

async function waitForManagerRoot(page) {
  await page.waitForSelector('#gsm-manager-root', { timeout: 20_000 });
}

async function waitForRows(page) {
  await page.waitForFunction(
    () => {
      const root = document.getElementById('gsm-manager-root');
      if (!root) return false;
      const links = root.querySelectorAll(
        'a[href^="https://github.com/"][href*="/"][target="_blank"]',
      );
      return links.length > 0;
    },
    { timeout: 60_000 },
  );

  return page.evaluate(() => {
    const root = document.getElementById('gsm-manager-root');
    const links = root?.querySelectorAll(
      'a[href^="https://github.com/"][href*="/"][target="_blank"]',
    );
    return links?.length ?? 0;
  });
}

async function readCounter(page) {
  return page.evaluate(() => {
    const root = document.getElementById('gsm-manager-root');
    const match = root?.innerText?.match(/(\d+)\s*\/\s*(\d+)/);
    return match ? { filtered: match[1], total: match[2] } : null;
  });
}

async function waitForText(page, text, timeout = 20_000) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    { timeout },
    text,
  );
}

async function clickButtonByText(page, matcher) {
  const matched = await page.evaluate((source) => {
    const regex = new RegExp(source.pattern, source.flags);
    const button = [...document.querySelectorAll('button')].find((node) =>
      regex.test((node.textContent || '').trim()),
    );
    if (!button) return null;
    button.click();
    return (button.textContent || '').trim();
  }, { pattern: matcher.source, flags: matcher.flags });

  if (!matched) {
    throw new Error(`could not find button matching ${matcher}`);
  }
}

async function expectNoAuthenticatedBanner(page) {
  const text = await page.evaluate(() => document.body.innerText);
  if (text.includes('Authenticated as @')) {
    throw new Error('token unexpectedly persisted after a rejected validation');
  }
}

function hookPageDiagnostics(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.error(`   [${label} console.error] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    console.error(`   [${label} pageerror] ${error.message}`);
  });
}
