#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import pkg from '../../../package.json' with { type: 'json' };
import { resolveFirefoxExecutable } from '../../runtime/firefox-extension-smoke.mjs';

const root = process.cwd();
const firefoxDist = path.join(root, 'dist-firefox');
const firefoxArtifact = path.join(
  root,
  'artifacts/firefox',
  `better-github-stars-manager-firefox-${pkg.version}.zip`,
);
const firefoxChecksum = `${firefoxArtifact}.sha256`;
const FIREFOX_OPTIONS_PATH = '/src/options/index.html';
const FIREFOX_E2E_PROBE_KEY = 'firefoxE2eProbe';
const FIREFOX_EXTENSION_ID = 'better-github-stars-manager@example.com';
const FIREFOX_EXTENSION_UUID = '11111111-2222-4333-8444-555555555555';

function step(number, message) {
  console.log(`${number}) ${message}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    env: {
      ...process.env,
      CI: 'true',
      ...options.env,
    },
  });
}

function isCliEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function runOutput(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: 'true',
      ...options.env,
    },
  }).trim();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listZipEntries(zipPath) {
  return runOutput('unzip', ['-Z1', zipPath])
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isStoreOnlyArtifactEntry(entry) {
  return (
    entry === '.DS_Store' ||
    entry.endsWith('/.DS_Store') ||
    entry === 'poster' ||
    entry.startsWith('poster/') ||
    entry === 'store' ||
    entry.startsWith('store/')
  );
}

function hookPageDiagnostics(page, label, errors) {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`[${label} console.error] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    errors.push(`[${label} pageerror] ${error.message}`);
  });
}

async function openFirefoxExtensionPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5_000 }).catch((error) => {
    if (!/Navigation timeout/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
  });
}

async function verifyFirefoxOptionsUiRoundtrip(firefoxExecutable) {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'gsm-firefox-e2e-'));
  let browser = null;

  try {
    browser = await puppeteer.launch({
      browser: 'firefox',
      executablePath: firefoxExecutable,
      headless: process.env.FIREFOX_E2E_HEADLESS !== 'false',
      userDataDir: profileDir,
      args: ['-no-remote'],
      extraPrefsFirefox: {
        'extensions.webextensions.uuids': JSON.stringify({
          [FIREFOX_EXTENSION_ID]: FIREFOX_EXTENSION_UUID,
        }),
      },
    });

    const extensionId = await browser.installExtension(firefoxDist);
    assert(extensionId === FIREFOX_EXTENSION_ID, `Firefox installed unexpected extension id: ${extensionId}`);

    const optionsUrl = `moz-extension://${FIREFOX_EXTENSION_UUID}${FIREFOX_OPTIONS_PATH}`;
    const errors = [];
    const page = await browser.newPage();
    hookPageDiagnostics(page, 'firefox options', errors);

    await openFirefoxExtensionPage(page, optionsUrl);
    await page.waitForSelector('textarea', { timeout: 20_000 });

    const result = await page.evaluate(async (probeKey) => {
      const probeValue = {
        ok: true,
        target: 'firefox',
        source: 'verify-firefox',
      };
      await browser.storage.local.set({ [probeKey]: probeValue });
      const stored = await browser.storage.local.get(probeKey);
      return {
        href: location.href,
        origin: location.origin,
        title: document.title,
        hasBrowserStorage: typeof browser?.storage?.local?.get === 'function',
        hasTokenTextarea: Boolean(document.querySelector('textarea')),
        bodyText: document.body.innerText,
        stored,
      };
    }, FIREFOX_E2E_PROBE_KEY);

    assert(result.href === optionsUrl, `Firefox Options page opened unexpected URL: ${result.href}`);
    assert(result.title.includes('Options'), `Firefox Options page title did not render: ${result.title}`);
    assert(result.bodyText.includes('GitHub Token'), 'Firefox Options page did not render GitHub Token copy');
    assert(result.hasBrowserStorage, 'Firefox Options page did not expose browser.storage.local');
    assert(result.hasTokenTextarea, 'Firefox Options page did not render the token textarea');
    assert(
      result.stored?.[FIREFOX_E2E_PROBE_KEY]?.ok === true &&
        result.stored?.[FIREFOX_E2E_PROBE_KEY]?.target === 'firefox',
      'Firefox browser.storage.local roundtrip failed',
    );
    assert(errors.length === 0, `Firefox Options page reported errors:\n${errors.join('\n')}`);

    console.log(`   ✓ installed extension id ${extensionId}`);
    console.log(`   ✓ opened ${result.href}`);
    console.log('   ✓ Options page rendered and browser.storage.local roundtrip passed');
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    rmSync(profileDir, { recursive: true, force: true });
  }
}

async function main() {
  step(1, 'Resolving local Firefox executable ...');
  const firefoxExecutable = resolveFirefoxExecutable();
  assert(firefoxExecutable, 'Firefox executable not found. Install with "brew install --cask firefox".');
  const firefoxVersion = runOutput(firefoxExecutable, ['--version']);
  console.log(`   ✓ ${firefoxVersion} at ${firefoxExecutable}`);

  step(2, 'Building and packaging Firefox extension with web-ext ...');
  run('pnpm', ['package:firefox']);
  assert(existsSync(firefoxArtifact), `Missing Firefox artifact: ${path.relative(root, firefoxArtifact)}`);
  assert(existsSync(firefoxChecksum), `Missing Firefox checksum: ${path.relative(root, firefoxChecksum)}`);
  console.log(`   ✓ ${path.relative(root, firefoxArtifact)}`);

  step(3, 'Checking Firefox output manifest contract ...');
  run('pnpm', ['check:firefox-output']);

  step(4, 'Linting Firefox output with web-ext ...');
  run('pnpm', ['lint:firefox']);

  step(5, 'Verifying Firefox artifact checksum ...');
  run('shasum', ['-a', '256', '-c', path.basename(firefoxChecksum)], {
    cwd: path.dirname(firefoxChecksum),
  });

  step(6, 'Checking Firefox artifact excludes store-only files ...');
  const excludedEntries = listZipEntries(firefoxArtifact).filter(isStoreOnlyArtifactEntry);
  assert(excludedEntries.length === 0, `Firefox artifact includes excluded entries:\n${excludedEntries.join('\n')}`);
  console.log('   ✓ no poster/store/.DS_Store entries in artifact');

  step(7, 'Launching Firefox with dist-firefox through web-ext ...');
  run('pnpm', ['test:smoke:firefox'], {
    env: {
      FIREFOX_SMOKE_REQUIRE_BROWSER: 'true',
    },
  });

  step(8, 'Opening Firefox Options UI and verifying browser storage roundtrip ...');
  await verifyFirefoxOptionsUiRoundtrip(firefoxExecutable);

  console.log('\n✅ FIREFOX END-TO-END VERIFIED:');
  console.log('   build:firefox → web-ext package → output contract → web-ext lint →');
  console.log('   checksum/exclusion checks → real Firefox launch with dist-firefox →');
  console.log('   real moz-extension Options UI render + browser.storage.local roundtrip.');
}

if (isCliEntry()) {
  main().catch((error) => {
    console.error(`\n❌ Firefox e2e verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
