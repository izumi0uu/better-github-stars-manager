#!/usr/bin/env node
/** Real Chrome (MV3) end-to-end verification via Puppeteer. */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deleteSyncGists } from '../ops/gist-sync-admin.mjs';
import { launchExtensionBrowser } from '../../runtime/puppeteer-runtime.mjs';

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('❌ Set GH_TOKEN env var (do NOT pass it on the command line):');
  console.error('   GH_TOKEN=<pat> node tests/manual/e2e/verify-chrome.mjs');
  process.exit(1);
}

const DIST = path.resolve(process.cwd(), 'dist');
if (!existsSync(path.join(DIST, 'manifest.json'))) {
  console.error(`❌ No dist/manifest.json found at ${DIST}. Run "pnpm build" first.`);
  process.exit(1);
}

const STARS_URL = `https://github.com/${process.env.GH_USER ?? 'YOUR_USERNAME'}?tab=stars`;
const RESET_GIST = process.env.GSM_RESET_GIST === '1';
const USER_DATA_DIR =
  process.env.GSM_USER_DATA_DIR ||
  mkdtempSync(path.join(os.tmpdir(), 'gsm-e2e-profile-'));
const STEP = (n, s) => console.log(`${n}) ${s}`);

function panelRootHandleScript() {
  const host = document.getElementById('gsm-manager-host');
  return host?.shadowRoot?.getElementById('gsm-manager-root') ?? null;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`\n❌ ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

function parseCounterScript() {
  const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
  if (!root) return null;

  const statusText =
    root.querySelector('div.border-t span.tabular-nums')?.textContent?.trim() ?? '';
  const localizedMatch =
    statusText.match(/(\d+)\s*(?:shown|已显示)\s*\/\s*(\d+)\s*(?:total|总计)/i) ??
    statusText.match(/(\d+)\D+\/\D+(\d+)/);
  if (localizedMatch) {
    return { filtered: localizedMatch[1], total: localizedMatch[2] };
  }

  const allNumbers = [...statusText.matchAll(/\d+/g)].map((m) => m[0]);
  if (allNumbers.length >= 2) {
    return { filtered: allNumbers[0], total: allNumbers[1] };
  }

  return null;
}

const browser = await launchExtensionBrowser({ dist: DIST, userDataDir: USER_DATA_DIR });

try {
  console.log(`   using Chrome profile: ${USER_DATA_DIR}`);
  if (RESET_GIST) {
    STEP(0, 'Resetting remote sync gist(s) …');
    const removed = await deleteSyncGists(TOKEN, { log: (line) => console.log(line) });
    console.log(`   ✓ removed ${removed.length} sync gist(s)`);
  }

  STEP(1, 'Locating extension options page …');
  const page = await browser.newPage();
  const targets = await browser.waitForTarget(
    (t) => t.url().startsWith('chrome-extension://'),
    { timeout: 10_000 },
  ).catch(() => null);
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker',
    { timeout: 10_000 },
  ).catch(() => null);
  const extId = (swTarget?.url() || targets?.url() || '').match(/chrome-extension:\/\/([a-z]+)/i)?.[1];
  assert(extId, 'could not determine extension ID — extension failed to load');
  console.log(`   ✓ extension id = ${extId}`);

  STEP(2, 'Opening Options page and saving PAT …');
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`   [options console.error] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.error(`   [options pageerror] ${e.message}`));
  await page.goto(`chrome-extension://${extId}/src/options/index.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('textarea', { timeout: 10_000 });
  await page.type('textarea', TOKEN);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const save = btns.find((b) => /save|verify/i.test(b.textContent || ''));
    if (!save) throw new Error('no Save button found');
    save.click();
  });

  await page.waitForFunction(
    () => document.body.innerText.includes('Authenticated as @'),
    { timeout: 20_000 },
  );
  const optsText = await page.evaluate(() => document.body.innerText);
  const userMatch = optsText.match(/Authenticated as @(\S+)/);
  assert(userMatch, 'Options page did not confirm authentication');
  console.log(`   ✓ token saved & verified — authenticated as @${userMatch[1]}`);

  STEP(3, `Opening ${STARS_URL} …`);
  const stars = await browser.newPage();
  stars.on('console', (m) => {
    if (m.type() === 'error') console.error(`   [stars console.error] ${m.text()}`);
  });
  stars.on('pageerror', (e) => console.error(`   [stars pageerror] ${e.message}`));
  await stars.goto(STARS_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  STEP(4, 'Waiting for injected stars overlay inside shadow root …');
  await stars.waitForFunction(
    panelRootHandleScript,
    { timeout: 20_000 },
  );
  console.log('   ✓ ManagerPanel injected into stars page');

  STEP(5, 'Waiting for star rows to render after auto-sync …');
  await stars.waitForFunction(
    () => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      if (!root) return false;
      const links = root.querySelectorAll('a[href^="https://github.com/"][href*="/"][target="_blank"]');
      return links.length > 0;
    },
    { timeout: 60_000 },
  );
  const rowCount = await stars.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const links = root.querySelectorAll('a[href^="https://github.com/"][href*="/"][target="_blank"]');
    return links.length;
  });
  assert(rowCount > 0, 'no star rows rendered in the panel');
  console.log(`   ✓ ${rowCount} star row(s) visible in the panel (virtual viewport)`);

  const sampleNames = await stars.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const links = [...root.querySelectorAll('a[href^="https://github.com/"][href*="/"][target="_blank"]')];
    return links.slice(0, 5).map((a) => a.textContent.trim());
  });

  STEP(6, 'Reading the panel header counter …');
  await stars.waitForFunction(
    parseCounterScript,
    { timeout: 20_000 },
  );
  const counter = await stars.evaluate(parseCounterScript);
  assert(counter, 'could not find the panel counter after first sync');
  console.log(`   ✓ header shows ${counter.filtered} / ${counter.total} (filtered / grandTotal)`);

  console.log('\n✅ CHROME END-TO-END VERIFIED:');
  console.log('   extension loaded → PAT saved via real Options page → stars page opened →');
  console.log('   ManagerPanel injected → auto-sync ran → star rows rendered from real API.');
  console.log(`   grandTotal=${counter.total} | visible rows in viewport=${rowCount}`);
  console.log('\n   Sample rendered rows:');
  for (const name of sampleNames) {
    console.log(`     • ${name}`);
  }
} catch (e) {
  console.error(`\n❌ verification failed: ${e instanceof Error ? e.message : String(e)}`);
  try {
    const pages = await browser.pages();
    for (const p of pages) {
      const url = p.url();
      const text = await p.evaluate(() => document.body?.innerText?.slice(0, 300)).catch(() => null);
      if (text) console.error(`   [page ${url}]: ${text.replace(/\n/g, ' ').slice(0, 200)}`);
      const panelDebug = await p.evaluate(() => {
        const host = document.getElementById('gsm-manager-host');
        const root = host?.shadowRoot?.getElementById('gsm-manager-root');
        return {
          hasHost: !!host,
          hasShadowRoot: !!host?.shadowRoot,
          hasPanelRoot: !!root,
        };
      }).catch(() => null);
      if (panelDebug) console.error(`   [panel ${url}]: ${JSON.stringify(panelDebug)}`);
    }
  } catch {}
  process.exit(1);
} finally {
  await browser.close();
}
