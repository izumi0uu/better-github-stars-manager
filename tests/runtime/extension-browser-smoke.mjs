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
const WATCH_DESKTOP_SCREENSHOT = '/tmp/github-stars-watch-desktop.png';
const WATCH_NARROW_SCREENSHOT = '/tmp/github-stars-watch-narrow.png';
const WATCH_SETUP_PRIMARY_SCREENSHOT = '/tmp/github-stars-watch-setup-primary.png';
const WATCH_SUBJECT_DETAIL_SCREENSHOT = '/tmp/github-stars-watch-subject-detail.png';
const WATCH_SUBJECT_PERMISSION_SCREENSHOT = '/tmp/github-stars-watch-subject-permission.png';
const WATCH_SETUP_FALLBACK_SCREENSHOT = '/tmp/github-stars-watch-setup-fallback.png';
const DOM_POLLING_MS = 100;
const RADAR_SOURCES_SCREENSHOT = '/tmp/github-stars-radar-sources.png';
const RADAR_UNSEEN_SCREENSHOT = '/tmp/github-stars-radar-unseen.png';

if (!existsSync(path.join(DIST, 'manifest.json'))) {
  console.error(`No dist/manifest.json found at ${DIST}. Run "pnpm build" first.`);
  process.exit(1);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'gsm-extension-smoke-'));
const failures = [];
const pageIssues = [];
let backgroundGitHubApiGuard = null;

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
  await installBackgroundGitHubApiGuard(browser, extId);
  ok(`extension loaded: ${extId}`);

  step('1) Popup no-token path opens Options');
  const popup = await openExtensionPage(extId, POPUP_PATH, 'popup');
  await waitForPopupNoTokenState(popup);

  const openedOptions = waitForExtensionPage(`${OPTIONS_PATH}`);
  await clickButtonByText(popup, /^Add PAT$/i);
  const optionsFromPopup = await openedOptions;
  await optionsFromPopup.waitForSelector('textarea', { timeout: 10_000 });
  await waitForBodyText(optionsFromPopup, 'GitHub connection');
  await assertScheduledRefreshAlarms(optionsFromPopup);
  ok('Watch and Radar periodic alarms were installed with the expected periods');
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
  await useDeterministicMotion(noTokenStars);
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
    tokenCryptoMeta: { iv: 'smoke-iv', salt: 'smoke-salt' },
    starsPanelDefaultEnabled: true,
    watchCredentialSource: null,
  });
  const ownStars = await browser.newPage();
  await useDeterministicMotion(ownStars);
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

  step('6) Radar source filters and persisted seen state stay synchronized');
  const seededWatch = await seedWatchAndRadarFixture(extId);
  await ownStars.bringToFront();
  await ownStars.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForManagerRoot(ownStars);
  await ownStars.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await assertRadarSourceFilters(ownStars);
  await ownStars.screenshot({ path: RADAR_SOURCES_SCREENSHOT });
  ok(`Radar seen state, Following/Me, and Feed/Projects controls responded (${RADAR_SOURCES_SCREENSHOT})`);

  step('7) Turbo-style navigation does not duplicate extension hosts');
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

  step('8) Repo page fixture gets tag-chip host only on repo-shaped path');
  const repoPage = await browser.newPage();
  await useDeterministicMotion(repoPage);
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

  await waitForBackgroundIdle(optionsFromPopup);
  await optionsFromPopup.close();
  resetBackgroundGitHubApiCalls(browser, extId);
  const subjectDetailFixture = installBackgroundWatchSubjectDetailFixture(extId);

  step('9) Watch renders the bounded stored snapshot without GitHub API calls');
  assert.deepEqual(seededWatch, {
    databaseVersion: 5,
    credentialSource: 'dedicated',
    hasMainToken: true,
    hasNotificationsToken: true,
    allThreadCount: 3,
    allGroupCount: 2,
    outOfScopeVisible: false,
    radarActivityCount: 1,
    radarUnseenCount: 1,
  });
  await ownStars.bringToFront();
  await ownStars.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForManagerRoot(ownStars);
  await waitForStarsRows(ownStars, 'seeded Stars fixture');
  await ownStars.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await openWatchSurface(ownStars, 'Unread issue thread');
  const unreadSnapshot = await readWatchSnapshot(ownStars);
  assert.deepEqual(unreadSnapshot, {
    unreadPressed: true,
    allPressed: false,
    unreadTitleVisible: true,
    readTitleVisible: false,
    unknownTitleVisible: true,
    unknownTypeVisible: true,
    unknownFallbackHref: 'https://github.com/smoke-user/secondary-repo',
    outOfScopeVisible: false,
    statusKind: 'stale',
    listEndTone: 'info',
    listEndText: 'End of current window · older threads may exist',
  });

  await clickWatchFilter(ownStars, 'All');
  const allSnapshot = await readWatchSnapshot(ownStars);
  assert.equal(allSnapshot.unreadPressed, false);
  assert.equal(allSnapshot.allPressed, true);
  assert.equal(allSnapshot.readTitleVisible, true);
  assert.equal(allSnapshot.outOfScopeVisible, false);
  ok('Unread/All changed the stored projection and unknown subjects fell back safely');
  await openWatchSubjectDetail(ownStars, 'Unread issue thread');
  await assertWatchSubjectDetail(ownStars, subjectDetailFixture);
  await ownStars.screenshot({ path: WATCH_SUBJECT_DETAIL_SCREENSHOT });
  ok(`Watch Issue details loaded on demand through the main credential (${WATCH_SUBJECT_DETAIL_SCREENSHOT})`);
  subjectDetailFixture.setMode('forbidden');
  await openWatchSubjectDetail(ownStars, 'Read pull request thread', 'error');
  await ownStars.screenshot({ path: WATCH_SUBJECT_PERMISSION_SCREENSHOT });
  const detailRecoveryOptionsOpened = waitForExtensionPage(`${OPTIONS_PATH}`);
  await assertWatchSubjectPermissionRecovery(ownStars);
  const detailRecoveryOptions = await detailRecoveryOptionsOpened;
  await assertGitHubOptionsIntent(detailRecoveryOptions);
  await detailRecoveryOptions.close();
  ok(`Watch permission failure offered focused GitHub authorization recovery while preserving row actions (${WATCH_SUBJECT_PERMISSION_SCREENSHOT})`);

  step('10) Watch repository headers open local detail and remain coherent responsively');
  await openWatchRepositoryDetail(ownStars, 'smoke-user/smoke-repo');
  await assertWatchRepositoryDetail(ownStars, 'smoke-user/smoke-repo');
  await assertWatchLayout(ownStars, 'desktop');
  await ownStars.screenshot({ path: WATCH_DESKTOP_SCREENSHOT });

  await closeWatchRepositoryDetail(ownStars);
  await ownStars.setViewport({ width: 360, height: 740, deviceScaleFactor: 1 });
  await waitForStableLayout(ownStars);
  await assertWatchLayout(ownStars, 'narrow');
  await ownStars.screenshot({ path: WATCH_NARROW_SCREENSHOT });
  ok(`Watch detail and responsive layout verified (${WATCH_DESKTOP_SCREENSHOT}, ${WATCH_NARROW_SCREENSHOT})`);

  step('11) Returning from Watch or Following restores the Stars repository list');
  await ownStars.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await assertStarsRowsAfterSurfaceReturn(ownStars, 'watch');
  await assertStarsRowsAfterSurfaceReturn(ownStars, 'radar');
  ok('Stars rows rendered after returning from both Watch and Following');

  step('12) Watch recovery opens focused setup, reuses a capable main credential, then reveals fallback on 403');
  await markManagerMount(ownStars);
  const disconnected = await clearWatchNotificationsCredential(extId);
  assert.deepEqual(disconnected, {
    mainCredentialPreserved: true,
    watchCredentialCleared: true,
    watchSourceCleared: true,
    watchChangeDelivered: true,
  });
  await openWatchSurface(ownStars, 'Open options');
  await assertWatchSetupState(ownStars);
  const openedWatchOptions = waitForExtensionPage(`${OPTIONS_PATH}`);
  await clickWatchRecoveryOptions(ownStars);
  const watchOptions = await openedWatchOptions;
  await assertWatchOptionsIntent(watchOptions);
  await watchOptions.screenshot({ path: WATCH_SETUP_PRIMARY_SCREENSHOT });
  const watchCapabilityFixture = await interceptWatchCapabilityFixture(watchOptions);
  await assertWatchDedicatedFieldCollapsed(watchOptions);
  await enableWatchWithMainCredential(watchOptions);
  assertWatchCapabilityRequests(watchCapabilityFixture.snapshot(), 'capable');
  assert.deepEqual(await readWatchCredentialState(watchOptions), {
    configSource: 'main',
    credentialRecordSource: 'main',
    statusSource: 'main',
    hasNotificationsToken: true,
    dedicatedCipherPresent: false,
    dedicatedMetaPresent: false,
  });
  ok('Watch recovery opened focused setup, selected main, and retained no dedicated cipher');

  const disconnectedMain = await clearWatchNotificationsCredential(extId);
  assert.deepEqual(disconnectedMain, {
    mainCredentialPreserved: true,
    watchCredentialCleared: true,
    watchSourceCleared: true,
    watchChangeDelivered: true,
  });
  await watchOptions.close();
  const fallbackOptions = await openExtensionPage(extId, OPTIONS_PATH, 'watch-fallback');
  const fallbackCapabilityFixture = await interceptWatchCapabilityFixture(fallbackOptions);
  fallbackCapabilityFixture.setMode('forbidden');
  await openWatchSurface(ownStars, 'Open options');
  await assertWatchSetupState(ownStars);
  await clickWatchRecoveryOptions(ownStars, fallbackOptions);
  await assertWatchOptionsIntent(fallbackOptions);
  await assertWatchDedicatedFieldCollapsed(fallbackOptions);
  await enableWatchWithMainCredential(fallbackOptions, { expectFallback: true });
  await assertWatchFallbackState(fallbackOptions);
  assertWatchCapabilityRequests(fallbackCapabilityFixture.snapshot(), 'forbidden');
  assert.deepEqual(await readWatchCredentialState(fallbackOptions), {
    configSource: null,
    credentialRecordSource: null,
    statusSource: null,
    hasNotificationsToken: false,
    dedicatedCipherPresent: false,
    dedicatedMetaPresent: false,
  });
  await fallbackOptions.screenshot({ path: WATCH_SETUP_FALLBACK_SCREENSHOT });
  await assertNoBackgroundGitHubApiCalls(browser, extId);
  ok('Watch recovery revealed the classic-token fallback after a fixture-only forbidden probe');
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
  await useDeterministicMotion(page);
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

async function assertScheduledRefreshAlarms(page) {
  const expected = [
    { name: 'bgsm-radar-auto-refresh-v1', periodInMinutes: 60 },
    { name: 'bgsm-watch-inbox-auto-refresh-v1', periodInMinutes: 1 },
    { name: 'bgsm-watch-scope-auto-refresh-v1', periodInMinutes: 60 },
  ];
  try {
    await page.waitForFunction(
      async (schedules) => {
        const alarms = await chrome.alarms.getAll();
        return schedules.every((schedule) => alarms.some((alarm) => (
          alarm.name === schedule.name && alarm.periodInMinutes === schedule.periodInMinutes
        )));
      },
      { polling: DOM_POLLING_MS, timeout: 10_000 },
      expected,
    );
  } catch (error) {
    throw await pageWaitError(page, 'scheduled refresh alarms were not installed', error);
  }
  const actual = await page.evaluate(async () => (await chrome.alarms.getAll())
    .filter((alarm) => alarm.name.startsWith('bgsm-') && alarm.name.includes('auto-refresh'))
    .map((alarm) => ({ name: alarm.name, periodInMinutes: alarm.periodInMinutes }))
    .sort((left, right) => left.name.localeCompare(right.name)));
  assert.deepEqual(actual, expected);
}

async function waitForExtensionPage(pagePath) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.url().startsWith('chrome-extension://') && candidate.url().endsWith(pagePath),
    { timeout: 10_000 },
  );
  const page = await target.page();
  if (!page) throw new Error(`extension page opened without page handle: ${pagePath}`);
  await useDeterministicMotion(page);
  hookPageDiagnostics(page, pagePath);
  return page;
}

async function useDeterministicMotion(page) {
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
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

async function seedWatchAndRadarFixture(extId) {
  const page = await openExtensionPage(extId, OPTIONS_PATH, 'seed-watch');
  const seeded = await page.evaluate(async () => {
    const APP_SECRET = 'better-github-stars-manager/v1/static-derivation-secret';
    const DB_NAME = 'better-github-stars-manager';
    const DEXIE_VERSION = 5;
    const IDB_VERSION = DEXIE_VERSION * 10;
    const CONFIG_KEY = 'gsm_config';
    const CREDENTIALS_KEY = 'gsm_github_credentials_v1';
    const fetchedAt = '2026-08-05T12:35:00.000Z';
    const radarFetchedAt = new Date().toISOString();
    const radarActivityAt = new Date(Date.now() - 60_000).toISOString();

    const b64encode = (value) => {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    const encrypt = async (plaintext, saltBytes, ivBytes) => {
      const encoder = new TextEncoder();
      const salt = new Uint8Array(saltBytes);
      const iv = new Uint8Array(ivBytes);
      const base = await crypto.subtle.importKey(
        'raw',
        encoder.encode(APP_SECRET),
        'PBKDF2',
        false,
        ['deriveKey'],
      );
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 150_000, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt'],
      );
      const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(plaintext),
      );
      return {
        cipher: b64encode(cipher),
        meta: { salt: b64encode(salt), iv: b64encode(iv) },
      };
    };
    const openDatabase = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      let unexpectedUpgrade = false;
      request.onupgradeneeded = () => {
        unexpectedUpgrade = true;
        request.transaction?.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(unexpectedUpgrade
        ? 'the extension did not initialize its Dexie v5 schema before Watch fixture setup'
        : `failed to open extension IndexedDB: ${request.error?.message ?? 'unknown error'}`));
      request.onblocked = () => reject(new Error('extension IndexedDB v5 fixture open was blocked'));
    });
    const transactionDone = (transaction) => new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Watch fixture transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Watch fixture transaction aborted'));
    });

    const [mainCredential, watchCredential] = await Promise.all([
      encrypt(
        'github_pat_runtime_smoke_main',
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      ),
      encrypt(
        'ghp_runtime_smoke_notifications',
        [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31],
        [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
      ),
    ]);
    const current = await chrome.storage.local.get(CONFIG_KEY);
    const credentials = {
      version: 1,
      tokenEncrypted: mainCredential.cipher,
      tokenCryptoMeta: mainCredential.meta,
      watchNotificationsTokenEncrypted: watchCredential.cipher,
      watchNotificationsTokenCryptoMeta: watchCredential.meta,
      watchCredentialSource: 'dedicated',
      username: 'smoke-user',
      avatarUrl: null,
      displayName: null,
    };
    await chrome.storage.local.set({
      [CONFIG_KEY]: {
        ...(current[CONFIG_KEY] ?? {}),
        ...credentials,
        locale: 'en',
        theme: 'light',
        onboardingStage: 'done',
        seenOnboarding: true,
        autoTagAgentPromptSeen: true,
        starsPanelDefaultEnabled: true,
      },
      [CREDENTIALS_KEY]: credentials,
    });

    // This message serializes account reconciliation before account-bound rows
    // are written, so a delayed cleanup cannot erase the new fixture.
    const initialStatus = await chrome.runtime.sendMessage({ type: 'getWatchStatus' });
    if (!initialStatus?.ok) {
      throw new Error(initialStatus?.error ?? 'Watch status did not accept seeded credentials');
    }
    if (initialStatus.data?.credentialSource !== 'dedicated') {
      throw new Error(`seeded Watch status selected ${String(initialStatus.data?.credentialSource)}`);
    }

    const database = await openDatabase();
    if (database.version !== IDB_VERSION) {
      database.close();
      throw new Error(`expected Dexie v${DEXIE_VERSION} (IndexedDB ${IDB_VERSION}), got ${database.version}`);
    }
    const requiredStores = [
      'stars',
      'watchRepositories',
      'watchNotificationThreads',
      'watchState',
      'radarActivities',
      'radarState',
    ];
    for (const storeName of requiredStores) {
      if (!database.objectStoreNames.contains(storeName)) {
        database.close();
        throw new Error(`Dexie v5 is missing required store ${storeName}`);
      }
    }

    const star = (fullName, description, language, count) => ({
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
      description,
      language,
      stargazers_count: count,
      topics: ['runtime-smoke'],
      pushed_at: '2026-08-04T08:00:00.000Z',
      created_at: '2024-01-02T03:04:05.000Z',
      fork: false,
      archived: false,
      starred_at: '2026-07-01T09:00:00.000Z',
      tombstone: false,
      synced_at: fetchedAt,
    });
    const thread = ({ id, repository, title, type, unread, updatedAt, subjectHtmlUrl }) => ({
      id,
      repositoryFullName: repository,
      repositoryHtmlUrl: `https://github.com/${repository}`,
      reason: unread ? 'subscribed' : 'comment',
      subjectType: type,
      subjectTitle: title,
      subjectApiUrl: type === 'Issue'
        ? `https://api.github.com/repos/${repository}/issues/17`
        : type === 'PullRequest'
          ? `https://api.github.com/repos/${repository}/pulls/9`
          : null,
      subjectHtmlUrl,
      unread,
      updatedAt,
      lastReadAt: unread ? null : '2026-08-05T10:45:00.000Z',
      fetchedAt,
    });
    const transaction = database.transaction(requiredStores, 'readwrite');
    const stars = transaction.objectStore('stars');
    const repositories = transaction.objectStore('watchRepositories');
    const threads = transaction.objectStore('watchNotificationThreads');
    const state = transaction.objectStore('watchState');
    const radarActivities = transaction.objectStore('radarActivities');
    const radarState = transaction.objectStore('radarState');
    stars.clear();
    repositories.clear();
    threads.clear();
    state.clear();
    radarActivities.clear();
    radarState.clear();
    stars.put(star(
      'smoke-user/smoke-repo',
      'Primary repository detail loaded from the live local Star row.',
      'TypeScript',
      3210,
    ));
    stars.put(star(
      'smoke-user/secondary-repo',
      'Secondary watched repository used by the unknown-subject fixture.',
      'Rust',
      87,
    ));
    stars.put(star(
      'smoke-user/out-of-scope',
      'Live star intentionally excluded from the watched-repository scope.',
      'Go',
      14,
    ));
    repositories.put({ full_name: 'smoke-user/smoke-repo' });
    repositories.put({ full_name: 'smoke-user/secondary-repo' });
    threads.put(thread({
      id: '1017',
      repository: 'smoke-user/smoke-repo',
      title: 'Unread issue thread',
      type: 'Issue',
      unread: true,
      updatedAt: '2026-08-05T12:30:00.000Z',
      subjectHtmlUrl: 'https://github.com/smoke-user/smoke-repo/issues/17',
    }));
    threads.put(thread({
      id: '1009',
      repository: 'smoke-user/smoke-repo',
      title: 'Read pull request thread',
      type: 'PullRequest',
      unread: false,
      updatedAt: '2026-08-05T10:30:00.000Z',
      subjectHtmlUrl: 'https://github.com/smoke-user/smoke-repo/pull/9',
    }));
    threads.put(thread({
      id: '1008',
      repository: 'smoke-user/secondary-repo',
      title: 'Future event thread',
      type: 'FutureEvent',
      unread: true,
      updatedAt: '2026-08-05T11:30:00.000Z',
      subjectHtmlUrl: null,
    }));
    threads.put(thread({
      id: '1001',
      repository: 'smoke-user/out-of-scope',
      title: 'OUT OF SCOPE MUST NOT RENDER',
      type: 'Issue',
      unread: true,
      updatedAt: '2026-08-05T13:30:00.000Z',
      subjectHtmlUrl: 'https://github.com/smoke-user/out-of-scope/issues/1',
    }));
    state.put({
      id: 'singleton',
      accountLogin: 'smoke-user',
      scope: {
        lastAttemptAt: '2026-08-05T12:34:00.000Z',
        lastSuccessfulAt: '2026-08-05T12:00:00.000Z',
        errorCode: 'network_error',
        repositoryCount: 2,
      },
      inbox: {
        lastAttemptAt: '2026-08-05T12:35:00.000Z',
        lastSuccessfulAt: '2026-08-05T12:05:00.000Z',
        errorCode: 'github_unavailable',
        lastModified: 'Wed, 05 Aug 2026 12:05:00 GMT',
        nextAllowedAt: null,
        candidateCount: 4,
        matchedCount: 3,
        truncated: true,
      },
    });
    radarActivities.put({
      id: 'runtime-radar-unseen',
      accountLogin: 'smoke-user',
      actorLogin: 'octo-friend',
      actorAvatarUrl: null,
      repositoryKey: 'example/radar-repo',
      repositoryFullName: 'example/radar-repo',
      repositoryDisplayName: 'example/radar-repo',
      repositoryHtmlUrl: 'https://github.com/example/radar-repo',
      repositoryDescription: 'Public repository activity used by the Radar seen-state smoke.',
      repositoryLanguage: 'TypeScript',
      repositoryLanguageColor: '#3178c6',
      repositoryStargazerCount: 42,
      viewerHadStarred: false,
      starredAt: radarActivityAt,
      dismissedAt: null,
      seenAt: null,
    });
    radarState.put({
      id: 'singleton',
      accountLogin: 'smoke-user',
      lastAttemptAt: radarFetchedAt,
      lastSuccessfulAt: radarFetchedAt,
      errorCode: null,
      nextAllowedAt: null,
      activityCount: 1,
      followingCount: 1,
      scannedFollowingCount: 1,
      batchCount: 1,
      partialReasons: [],
      rateLimitRemaining: 4_000,
      rateLimitResetAt: null,
    });
    await transactionDone(transaction);
    const databaseVersion = database.version / 10;
    database.close();

    // Direct fixture writes bypass the background publication boundary. Touch
    // the authoritative same-account credential record after commit so an
    // already-open Manager exercises its real credential invalidation path.
    const finalizedCredentials = {
      ...credentials,
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    };
    const finalized = await chrome.storage.local.get(CONFIG_KEY);
    await chrome.storage.local.set({
      [CONFIG_KEY]: {
        ...(finalized[CONFIG_KEY] ?? {}),
        ...finalizedCredentials,
      },
      [CREDENTIALS_KEY]: finalizedCredentials,
    });
    const resetTags = await chrome.runtime.sendMessage({ type: 'deleteAllTags' });
    if (!resetTags?.ok) throw new Error(resetTags?.error ?? 'failed to publish seeded Stars fixture');
    const radarQuery = await chrome.runtime.sendMessage({ type: 'queryRadar' });
    if (
      !radarQuery?.ok
      || radarQuery.data?.activities?.[0]?.id !== 'runtime-radar-unseen'
      || radarQuery.data?.unseenCount !== 1
    ) {
      throw new Error(radarQuery?.error ?? `seeded Radar query was unavailable: ${JSON.stringify(radarQuery?.data ?? null)}`);
    }


    const allInbox = await chrome.runtime.sendMessage({
      type: 'queryWatchInbox',
      unreadOnly: false,
    });
    if (!allInbox?.ok) throw new Error(allInbox?.error ?? 'seeded Watch inbox query failed');
    const repositoryDetail = await chrome.runtime.sendMessage({
      type: 'getWatchRepositoryDetail',
      fullName: 'smoke-user/smoke-repo',
    });
    if (
      !repositoryDetail?.ok ||
      repositoryDetail.data?.star?.full_name !== 'smoke-user/smoke-repo'
    ) {
      throw new Error(repositoryDetail?.error ?? 'seeded Watch repository detail was unavailable');
    }
    return {
      databaseVersion,
      credentialSource: allInbox.data.status.credentialSource,
      hasMainToken: allInbox.data.status.hasMainToken,
      hasNotificationsToken: allInbox.data.status.hasNotificationsToken,
      allThreadCount: allInbox.data.totalCount,
      allGroupCount: allInbox.data.groups.length,
      outOfScopeVisible: allInbox.data.threads.some((item) => item.id === '1001'),
      radarActivityCount: radarQuery.data.activities.length,
      radarUnseenCount: radarQuery.data.unseenCount,
    };
  });
  await page.close();
  return seeded;
}

async function clearWatchNotificationsCredential(extId) {
  const page = await openExtensionPage(extId, OPTIONS_PATH, 'clear-watch-credential');
  const result = await page.evaluate(async () => {
    const CONFIG_KEY = 'gsm_config';
    const CREDENTIALS_KEY = 'gsm_github_credentials_v1';
    const current = await chrome.storage.local.get([CONFIG_KEY, CREDENTIALS_KEY]);
    const beforeConfig = current[CONFIG_KEY] ?? {};
    const beforeCredentials = current[CREDENTIALS_KEY] ?? {};
    let listener;
    const changed = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(false);
      }, 5_000);
      listener = (message) => {
        if (message?.type !== 'watchChanged') return;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(true);
      };
      chrome.runtime.onMessage.addListener(listener);
    });
    const response = await chrome.runtime.sendMessage({ type: 'disconnectWatchInbox' });
    if (!response?.ok) {
      chrome.runtime.onMessage.removeListener(listener);
      throw new Error(response?.error ?? 'Watch disconnect failed');
    }
    const watchChangeDelivered = await changed;
    const stored = await chrome.storage.local.get([CONFIG_KEY, CREDENTIALS_KEY]);
    const afterConfig = stored[CONFIG_KEY] ?? {};
    const afterCredentials = stored[CREDENTIALS_KEY] ?? {};
    return {
      mainCredentialPreserved:
        afterCredentials.tokenEncrypted === beforeCredentials.tokenEncrypted &&
        JSON.stringify(afterCredentials.tokenCryptoMeta ?? null) ===
          JSON.stringify(beforeCredentials.tokenCryptoMeta ?? null) &&
        afterCredentials.username === beforeCredentials.username &&
        afterConfig.tokenEncrypted === beforeConfig.tokenEncrypted &&
        afterConfig.username === beforeConfig.username,
      watchCredentialCleared:
        afterCredentials.watchNotificationsTokenEncrypted === null &&
        afterCredentials.watchNotificationsTokenCryptoMeta === null &&
        afterConfig.watchNotificationsTokenEncrypted === null &&
        afterConfig.watchNotificationsTokenCryptoMeta === null,
      watchSourceCleared:
        (afterCredentials.watchCredentialSource ?? null) === null &&
        (afterConfig.watchCredentialSource ?? null) === null,
      watchChangeDelivered,
    };
  });
  await page.close();
  return result;
}

function installBackgroundWatchSubjectDetailFixture(extId) {
  const guard = backgroundGitHubApiGuard;
  assert.ok(guard, `GitHub API guard was not installed for ${extId}`);
  let mode = 'success';
  const requestedUrls = [];
  guard.handle = async (client, event) => {
    const url = new URL(event.request.url);
    const subjectRoutes = new Set([
      'https://api.github.com/repos/smoke-user/smoke-repo/issues/17',
      'https://api.github.com/repos/smoke-user/smoke-repo/issues/9',
    ]);
    if (event.request.method !== 'GET' || !subjectRoutes.has(url.href)) return false;
    requestedUrls.push({
      url: url.href,
      authorization: event.request.headers.Authorization ?? event.request.headers.authorization ?? null,
      accept: event.request.headers.Accept ?? event.request.headers.accept ?? null,
      apiVersion: event.request.headers['X-GitHub-Api-Version'] ?? event.request.headers['x-github-api-version'] ?? null,
    });
    if (mode === 'forbidden') {
      const body = JSON.stringify({ message: 'forbidden' });
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 403,
        responseHeaders: [
          { name: 'content-type', value: 'application/json; charset=utf-8' },
          { name: 'content-length', value: String(Buffer.byteLength(body)) },
        ],
        body: Buffer.from(body).toString('base64'),
      });
      return true;
    }
    const body = JSON.stringify({
      number: 17,
      title: 'Unread issue thread',
      state: 'open',
      state_reason: null,
      html_url: 'https://github.com/smoke-user/smoke-repo/issues/17',
      repository_url: 'https://api.github.com/repos/smoke-user/smoke-repo',
      user: {
        login: 'smoke-user',
        avatar_url: 'https://avatars.githubusercontent.com/u/1',
        html_url: 'https://github.com/smoke-user',
      },
      created_at: '2026-08-01T10:00:00.000Z',
      updated_at: '2026-08-05T12:30:00.000Z',
      labels: [{ name: 'runtime-detail', color: '1f6feb' }],
      assignees: [],
      milestone: null,
      comments: 2,
      body: '**Runtime** Issue detail loaded only after this thread was expanded.\n\n![blocked](https://attacker.example/image.png)',
    });
    await client.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'content-type', value: 'application/json; charset=utf-8' },
        { name: 'content-length', value: String(Buffer.byteLength(body)) },
      ],
      body: Buffer.from(body).toString('base64'),
    });
    return true;
  };
  return {
    requestedUrls,
    setMode(nextMode) {
      assert.ok(nextMode === 'success' || nextMode === 'forbidden');
      mode = nextMode;
    },
  };
}

async function installBackgroundGitHubApiGuard(browser, extId) {
  const unexpectedUrls = [];
  const clients = new Set();
  const attach = async (target) => {
    if (
      target.type() !== 'service_worker' ||
      !target.url().startsWith(`chrome-extension://${extId}/`)
    ) return;
    const client = await target.createCDPSession();
    clients.add(client);
    await client.send('Fetch.enable', {
      patterns: [{ urlPattern: 'https://api.github.com/*', requestStage: 'Request' }],
    });
    client.on('Fetch.requestPaused', (event) => {
      void (async () => {
        if (await backgroundGitHubApiGuard?.handle?.(client, event)) return;
        unexpectedUrls.push(event.request.url);
        await client.send('Fetch.failRequest', {
          requestId: event.requestId,
          errorReason: 'BlockedByClient',
        });
      })().catch((error) => recordPageIssue('background-network-guard', formatError(error)));
    });
  };
  const targetListener = (target) => {
    void attach(target).catch((error) => {
      recordPageIssue('background-network-guard', formatError(error));
    });
  };
  browser.on('targetcreated', targetListener);
  await Promise.all(browser.targets().map(attach));
  backgroundGitHubApiGuard = { browser, targetListener, clients, unexpectedUrls, handle: null };
}

async function assertNoBackgroundGitHubApiCalls(browser, extId) {
  await delay(100);
  const guard = backgroundGitHubApiGuard;
  assert.equal(guard?.browser, browser, `GitHub API guard was not installed for ${extId}`);
  assert.deepEqual(
    guard.unexpectedUrls,
    [],
    `background unexpectedly requested GitHub API URLs: ${guard.unexpectedUrls.join(', ')}`,
  );
  browser.off('targetcreated', guard.targetListener);
  await Promise.all([...guard.clients].map((client) => client.detach().catch(() => {})));
  backgroundGitHubApiGuard = null;
}

async function waitForBackgroundIdle(page) {
  await page.waitForFunction(
    async () => {
      const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
      return response?.ok && response.data?.inFlight === false;
    },
    { polling: DOM_POLLING_MS, timeout: 30_000 },
  );
}

function resetBackgroundGitHubApiCalls(browser, extId) {
  const guard = backgroundGitHubApiGuard;
  assert.equal(guard?.browser, browser, `GitHub API guard was not installed for ${extId}`);
  guard.unexpectedUrls.length = 0;
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

async function interceptWatchCapabilityFixture(page) {
  let mode = 'capable';
  const requests = [];
  const unexpectedRequests = [];
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'https://api.github.com') {
      void request.continue().catch(() => {});
      return;
    }
    void (async () => {
      const pathWithQuery = `${url.pathname}${url.search}`;
      const authorizationPresent = typeof request.headers().authorization === 'string';
      if (request.method() !== 'GET' || (url.pathname !== '/user' && url.pathname !== '/notifications')) {
        unexpectedRequests.push({ method: request.method(), pathWithQuery });
        await request.abort('blockedbyclient');
        return;
      }
      if (url.pathname === '/user' && url.search === '') {
        requests.push({ method: 'GET', path: '/user', authorizationPresent });
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ login: 'smoke-user', id: 1 }),
        });
        return;
      }
      if (
        url.pathname === '/notifications' &&
        url.searchParams.get('all') === 'true' &&
        url.searchParams.get('per_page') === '1' &&
        [...url.searchParams.keys()].length === 2
      ) {
        requests.push({ method: 'GET', path: pathWithQuery, authorizationPresent });
        await delay(250);
        await request.respond({
          status: mode === 'forbidden' ? 403 : 200,
          contentType: 'application/json',
          headers: { 'x-oauth-scopes': mode === 'forbidden' ? '' : 'notifications' },
          body: JSON.stringify(mode === 'forbidden' ? { message: 'forbidden' } : []),
        });
        return;
      }
      unexpectedRequests.push({ method: request.method(), pathWithQuery });
      await request.abort('blockedbyclient');
    })().catch((error) => {
      recordPageIssue('watch-capability-fixture', formatError(error));
      void request.abort('failed').catch(() => {});
    });
  });
  return {
    setMode(nextMode) {
      assert.ok(nextMode === 'capable' || nextMode === 'forbidden');
      mode = nextMode;
      requests.length = 0;
      unexpectedRequests.length = 0;
    },
    snapshot() {
      return {
        mode,
        requests: [...requests],
        unexpectedRequests: [...unexpectedRequests],
      };
    },
  };
}

function assertWatchCapabilityRequests(snapshot, expectedMode) {
  assert.equal(snapshot.mode, expectedMode);
  assert.deepEqual(snapshot.unexpectedRequests, []);
  assert.deepEqual(snapshot.requests.map(({ method, path, authorizationPresent }) => ({
    method,
    path,
    authorizationPresent,
  })), [
    { method: 'GET', path: '/user', authorizationPresent: true },
    {
      method: 'GET',
      path: '/notifications?all=true&per_page=1',
      authorizationPresent: true,
    },
  ]);
}

async function assertWatchDedicatedFieldCollapsed(page) {
  await page.waitForSelector('[data-testid="watch-inbox-settings"]', { timeout: 10_000 });
  const state = await page.evaluate(() => {
    const settings = document.querySelector('[data-testid="watch-inbox-settings"]');
    const form = settings?.querySelector('[data-testid="watch-dedicated-form"]');
    const enable = settings?.querySelector('[data-testid="watch-setup-enable"]');
    const visible = (element) => {
      if (!element || element instanceof HTMLElement && (element.hidden || element.getAttribute('aria-hidden') === 'true')) {
        return false;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return {
      settingsPresent: !!settings,
      dedicatedFormPresent: !!form,
      dedicatedFormVisible: visible(form),
      setupVisible: visible(enable),
    };
  });
  assert.equal(state.settingsPresent, true);
  assert.equal(state.dedicatedFormVisible, false, 'classic Watch field was visible before capability setup');
  assert.equal(state.setupVisible, true, 'Watch setup CTA was not available');
}

async function assertWatchOptionsIntent(page) {
  await page.bringToFront();
  await page.waitForFunction(() => {
    const heading = document.querySelector('[data-testid="watch-inbox-settings"] #watch-inbox-heading');
    const enable = document.querySelector('[data-testid="watch-inbox-settings"] [data-testid="watch-setup-enable"]');
    const active = document.activeElement;
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return !!heading && active === heading && visible(enable);
  }, { polling: DOM_POLLING_MS, timeout: 20_000 });
  const state = await page.evaluate(() => ({
    focusedHeading: document.activeElement?.id === 'watch-inbox-heading',
    dedicatedFormPresent: !!document.querySelector(
      '[data-testid="watch-inbox-settings"] [data-testid="watch-dedicated-form"]',
    ),
  }));
  assert.equal(state.focusedHeading, true, 'Watch Options intent did not focus #watch-inbox-heading');
  assert.equal(state.dedicatedFormPresent, false, 'primary Watch setup unexpectedly rendered dedicated form');
}

async function assertGitHubOptionsIntent(page) {
  await page.bringToFront();
  await page.waitForFunction(
    () => document.activeElement?.id === 'github-connection-heading',
    { polling: DOM_POLLING_MS, timeout: 20_000 },
  );
  const state = await page.evaluate(() => ({
    focusedHeading: document.activeElement?.id === 'github-connection-heading',
    tokenInputPresent: !!document.querySelector('textarea[placeholder="github_pat_..."]'),
  }));
  assert.equal(state.focusedHeading, true, 'GitHub Options intent did not focus #github-connection-heading');
  assert.equal(state.tokenInputPresent, true, 'main GitHub token input was not available');
}

async function clickWatchRecoveryOptions(page) {
  const clicked = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const section = root?.querySelector('section[aria-label="Watched stars inbox"]');
    const button = [...(section?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === 'Open options');
    button?.click();
    return !!button;
  });
  assert.equal(clicked, true, 'Watch setup CTA did not open Options');
}

async function enableWatchWithMainCredential(page, options = {}) {
  const expectFallback = options.expectFallback === true;
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="watch-setup-enable"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, { polling: DOM_POLLING_MS, timeout: 20_000 });
  const clicked = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="watch-setup-enable"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });
  assert.equal(clicked, true, 'Watch setup CTA was not clickable');
  await page.waitForFunction(() => {
    const notice = document.querySelector('[data-testid="watch-main-checking"]');
    if (!notice) return false;
    const style = getComputedStyle(notice);
    const rect = notice.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }, { polling: DOM_POLLING_MS, timeout: 5_000 });
  if (expectFallback) {
    await page.waitForFunction(() => {
      const form = document.querySelector('[data-testid="watch-dedicated-form"]');
      if (!form) return false;
      const style = getComputedStyle(form);
      const rect = form.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }, { polling: DOM_POLLING_MS, timeout: 20_000 });
    return;
  }
  await page.waitForSelector('[data-testid="watch-credential-source"]', { timeout: 20_000 });
}

async function assertWatchFallbackState(page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('[data-testid="watch-dedicated-form"]');
    const setup = document.querySelector('[data-testid="watch-setup-enable"]');
    const checking = document.querySelector('[data-testid="watch-main-checking"]');
    return !!form && setup instanceof HTMLButtonElement && !setup.disabled && !checking;
  }, { polling: DOM_POLLING_MS, timeout: 20_000 });
  const state = await page.evaluate(() => {
    const form = document.querySelector('[data-testid="watch-dedicated-form"]');
    const input = document.querySelector('#watch-notifications-token');
    const connect = form?.querySelector('[data-testid="watch-token-connect"]');
    const text = document.querySelector('[data-testid="watch-inbox-settings"]')?.textContent?.toLowerCase() ?? '';
    const style = form ? getComputedStyle(form) : null;
    const rect = form?.getBoundingClientRect();
    return {
      formVisible: !!form && style?.display !== 'none' && style?.visibility !== 'hidden' &&
        (rect?.width ?? 0) > 0 && (rect?.height ?? 0) > 0,
      inputPresent: !!input,
      connectPresent: !!connect,
      safeCopyPresent: ['stars', 'tags', 'gist', 'sync'].every((term) => text.includes(term)),
    };
  });
  assert.deepEqual(state, {
    formVisible: true,
    inputPresent: true,
    connectPresent: true,
    safeCopyPresent: true,
  });
}

async function readWatchCredentialState(page) {
  return page.evaluate(async () => {
    const [stored, response] = await Promise.all([
      chrome.storage.local.get(['gsm_config', 'gsm_github_credentials_v1']),
      chrome.runtime.sendMessage({ type: 'getWatchStatus' }),
    ]);
    const config = stored.gsm_config ?? {};
    const credentials = stored.gsm_github_credentials_v1 ?? {};
    const status = response?.data ?? {};
    return {
      configSource: config.watchCredentialSource ?? null,
      credentialRecordSource: credentials.watchCredentialSource ?? config.watchCredentialSource ?? null,
      statusSource: status.credentialSource ?? null,
      hasNotificationsToken: status.hasNotificationsToken === true,
      dedicatedCipherPresent: typeof credentials.watchNotificationsTokenEncrypted === 'string' &&
        credentials.watchNotificationsTokenEncrypted.length > 0,
      dedicatedMetaPresent: !!credentials.watchNotificationsTokenCryptoMeta,
    };
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

async function waitForStarsRows(page, label) {
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        const rows = [...(root?.querySelectorAll('[data-layout-row-grid]') ?? [])];
        return root?.querySelector('#gsm-stars-surface-tab')?.getAttribute('aria-selected') === 'true' &&
          rows.length > 0 && rows.some((row) => row.textContent?.trim());
      },
      { polling: DOM_POLLING_MS, timeout: 10_000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      const scroller = root?.querySelector('[data-surface="stars"].no-scrollbar');
      const shell = root?.querySelector('.gsm-layout-table-shell');
      return {
        active: root?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
        rows: root?.querySelectorAll('[data-layout-row-grid]').length ?? -1,
        headers: root?.querySelectorAll('[data-table-head] [data-header-col]').length ?? -1,
        shellHeight: shell?.getBoundingClientRect().height ?? -1,
        scrollerHeight: scroller?.clientHeight ?? -1,
        text: root?.textContent?.slice(-300) ?? null,
      };
    });
    throw await pageWaitError(page, `${label} did not render repository rows: ${JSON.stringify(state)}`, error);
  }
}

async function assertStarsRowsAfterSurfaceReturn(page, source) {
  const sourceTabId = `#gsm-${source}-surface-tab`;
  const sourceActivated = await page.evaluate((selector) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const button = root?.querySelector(selector);
    button?.click();
    return !!button;
  }, sourceTabId);
  assert.equal(sourceActivated, true, `could not activate ${source} before returning to Stars`);
  await page.waitForFunction(
    (selector) => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      return root?.querySelector(selector)?.getAttribute('aria-selected') === 'true';
    },
    { polling: DOM_POLLING_MS, timeout: 10_000 },
    sourceTabId,
  );

  const starsActivated = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const button = root?.querySelector('#gsm-stars-surface-tab');
    button?.click();
    return !!button;
  });
  assert.equal(starsActivated, true, `could not return to Stars from ${source}`);
  await waitForStarsRows(page, `Stars after returning from ${source}`);
}

async function assertRadarSourceFilters(page) {
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        const button = root?.querySelector('#gsm-radar-surface-tab');
        return !!button && !button.disabled;
      },
      { polling: DOM_POLLING_MS, timeout: 20_000 },
    );
  } catch (error) {
    throw await pageWaitError(page, 'Radar Manager surface switch did not become interactive', error);
  }

  const activated = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const button = root?.querySelector('#gsm-radar-surface-tab');
    button?.click();
    return !!button;
  });
  assert.equal(activated, true, 'could not activate the Radar Manager surface');

  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        const panel = root?.querySelector('[aria-labelledby="gsm-radar-surface-tab"]');
        const following = root?.querySelector('button[aria-label="Stars from people you follow"]');
        const self = root?.querySelector('button[aria-label="Your own stars"]');
        return !!panel && !!following && !!self;
      },
      { polling: DOM_POLLING_MS, timeout: 20_000 },
    );
  } catch (error) {
    throw await pageWaitError(page, 'Radar source controls did not finish rendering', error);
  }

  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        const row = root?.querySelector('[data-radar-row="runtime-radar-unseen"]');
        const badge = root?.querySelector('[data-radar-unseen-badge]');
        return row?.getAttribute('data-radar-unseen') === 'true'
          && badge?.textContent?.trim() === '1';
      },
      { polling: DOM_POLLING_MS, timeout: 20_000 },
    );
  } catch (error) {
    throw await pageWaitError(page, 'Radar unseen activity and surface badge did not render', error);
  }
  const surfaceBadgeStyles = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const watchBadge = root?.querySelector('#gsm-watch-surface-tab > span[aria-hidden="true"]');
    const followingBadge = root?.querySelector('[data-radar-unseen-badge]');
    if (!(watchBadge instanceof HTMLElement) || !(followingBadge instanceof HTMLElement)) return null;
    const readStyle = (badge) => {
      const style = getComputedStyle(badge);
      return {
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        borderWidth: style.borderWidth,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        height: style.height,
        minWidth: style.minWidth,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
      };
    };
    return {
      following: readStyle(followingBadge),
      watch: readStyle(watchBadge),
    };
  });
  assert.ok(surfaceBadgeStyles, 'could not compare Watch and Following count badges');
  assert.deepEqual(
    surfaceBadgeStyles.following,
    surfaceBadgeStyles.watch,
    'Following count badge did not match the Watch count badge',
  );
  const hoverProbe = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const row = root?.querySelector('[data-radar-row="runtime-radar-unseen"]');
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    return {
      x: rect.left + Math.min(180, Math.max(12, rect.width / 2)),
      y: rect.top + rect.height / 2,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
    };
  });
  assert.ok(hoverProbe, 'could not locate Radar row for hover probe');
  await page.mouse.move(hoverProbe.x, hoverProbe.y);
  await delay(60);
  const hoveredStyle = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const row = root?.querySelector('[data-radar-row="runtime-radar-unseen"]');
    if (!row) return null;
    const style = getComputedStyle(row);
    return { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow };
  });
  assert.ok(hoveredStyle, 'could not read Radar row hover style');
  assert.equal(hoverProbe.boxShadow, 'none', 'Radar row rendered a pre-hover inset edge');
  assert.equal(hoveredStyle.boxShadow, 'none', 'Radar row rendered a hover inset edge');
  assert.notEqual(
    hoveredStyle.backgroundColor,
    hoverProbe.backgroundColor,
    'Radar row hover did not change the immediate row background',
  );
  await page.screenshot({ path: RADAR_UNSEEN_SCREENSHOT });
  const unseen = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const tab = root?.querySelector('#gsm-radar-surface-tab');
    const row = root?.querySelector('[data-radar-row="runtime-radar-unseen"]');
    return {
      tabLabel: tab?.getAttribute('aria-label') ?? null,
      rowState: row?.getAttribute('data-radar-unseen') ?? null,
      unseenCopyVisible: row?.textContent?.includes('Unseen activity') ?? false,
    };
  });
  assert.deepEqual(unseen, {
    tabLabel: 'Following, 1 unseen activity',
    rowState: 'true',
    unseenCopyVisible: true,
  });

  const seenIntentDispatched = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const row = root?.querySelector('[data-radar-row="runtime-radar-unseen"]');
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return !!row;
  });
  assert.equal(seenIntentDispatched, true, 'could not dispatch Radar seen intent');
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        const row = root?.querySelector('[data-radar-row="runtime-radar-unseen"]');
        return row?.getAttribute('data-radar-unseen') === 'false'
          && !root?.querySelector('[data-radar-unseen-badge]');
      },
      { polling: DOM_POLLING_MS, timeout: 20_000 },
    );
  } catch (error) {
    throw await pageWaitError(page, 'Radar seen intent did not clear the row and surface badge', error);
  }

  const initial = await readRadarControls(page);
  assert.deepEqual(initial, {
    followingPressed: 'true',
    selfPressed: 'false',
    feedPressed: 'true',
    projectsPressed: 'false',
    legacyThirtyRowCopyVisible: false,
  });

  await clickRadarControl(page, 'button[aria-label="Your own stars"]');
  await waitForRadarPressed(page, 'button[aria-label="Your own stars"]', 'true');
  await clickRadarControl(page, 'button[aria-label="Stars from people you follow"]');
  await waitForRadarPressed(page, 'button[aria-label="Stars from people you follow"]', 'false');
  const selfOnly = await readRadarControls(page);
  assert.equal(selfOnly.followingPressed, 'false');
  assert.equal(selfOnly.selfPressed, 'true');

  await clickRadarControl(page, '[role="group"][aria-label="Following view"] button:last-child');
  await waitForRadarPressed(page, '[role="group"][aria-label="Following view"] button:last-child', 'true');
  await delay(250);
  const projects = await readRadarControls(page);
  assert.deepEqual(projects, {
    followingPressed: 'false',
    selfPressed: 'true',
    feedPressed: 'false',
    projectsPressed: 'true',
    legacyThirtyRowCopyVisible: false,
  });
}

async function readRadarControls(page) {
  return page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const following = root?.querySelector('button[aria-label="Stars from people you follow"]');
    const self = root?.querySelector('button[aria-label="Your own stars"]');
    const view = root?.querySelector('[role="group"][aria-label="Following view"]');
    const viewButtons = [...(view?.querySelectorAll('button') ?? [])];
    return {
      followingPressed: following?.getAttribute('aria-pressed') ?? null,
      selfPressed: self?.getAttribute('aria-pressed') ?? null,
      feedPressed: viewButtons[0]?.getAttribute('aria-pressed') ?? null,
      projectsPressed: viewButtons[1]?.getAttribute('aria-pressed') ?? null,
      legacyThirtyRowCopyVisible: root?.textContent?.includes('up to 30 activities') ?? false,
    };
  });
}

async function clickRadarControl(page, selector) {
  const clicked = await page.evaluate((targetSelector) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const button = root?.querySelector(targetSelector);
    button?.click();
    return !!button;
  }, selector);
  assert.equal(clicked, true, `could not activate Radar control ${selector}`);
}

async function waitForRadarPressed(page, selector, expected) {
  await page.waitForFunction(
    (targetSelector, pressed) => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      return root?.querySelector(targetSelector)?.getAttribute('aria-pressed') === pressed;
    },
    { polling: DOM_POLLING_MS, timeout: 10_000 },
    selector,
    expected,
  );
}

async function markManagerMount(page) {
  const marked = await page.evaluate(() => {
    const host = document.getElementById('gsm-manager-host');
    if (!host?.shadowRoot?.getElementById('gsm-manager-root')) return false;
    host.dataset.watchSmokeMount = 'preserved';
    return true;
  });
  assert.equal(marked, true, 'could not mark the mounted Manager before Watch disconnect');
}

async function openWatchSurface(page, expectedText) {
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        const button = root?.querySelector('#gsm-watch-surface-tab');
        return !!button && !button.disabled;
      },
      { polling: DOM_POLLING_MS, timeout: 20_000 },
    );
  } catch (error) {
    throw await pageWaitError(page, 'Watch Manager surface switch did not become interactive', error);
  }
  const clicked = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const button = root?.querySelector('#gsm-watch-surface-tab');
    button?.click();
    return !!button;
  });
  assert.equal(clicked, true, 'could not activate the Watch Manager surface');
  try {
    await page.waitForFunction(
      (text) => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        const section = root?.querySelector('section[aria-label="Watched stars inbox"]');
        const watchButton = [...(root?.querySelectorAll('button') ?? [])]
          .find((candidate) => candidate.textContent?.trim().startsWith('Watch'));
        return !!section && watchButton?.getAttribute('aria-selected') === 'true' &&
          !section.textContent?.includes('Loading') && section.textContent?.includes(text);
      },
      { polling: DOM_POLLING_MS, timeout: 20_000 },
      expectedText,
    );
  } catch (error) {
    throw await pageWaitError(page, 'Watch surface did not finish rendering', error);
  }
}

async function clickWatchFilter(page, label) {
  const clicked = await page.evaluate((filterLabel) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const group = root?.querySelector('[role="group"][aria-label="Inbox thread filter"]');
    const button = [...(group?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === filterLabel);
    button?.click();
    return !!button;
  }, label);
  assert.equal(clicked, true, `could not activate Watch filter ${label}`);
  try {
    await page.waitForFunction(
      (filterLabel) => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        const group = root?.querySelector('[role="group"][aria-label="Inbox thread filter"]');
        const button = [...(group?.querySelectorAll('button') ?? [])]
          .find((candidate) => candidate.textContent?.trim() === filterLabel);
        return button?.getAttribute('aria-pressed') === 'true' && (
          filterLabel !== 'All' || root?.textContent?.includes('Read pull request thread')
        );
      },
      { polling: DOM_POLLING_MS, timeout: 10_000 },
      label,
    );
  } catch (error) {
    throw await pageWaitError(page, `Watch filter ${label} did not settle`, error);
  }
}

async function readWatchSnapshot(page) {
  return page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const section = root?.querySelector('section[aria-label="Watched stars inbox"]');
    const text = section?.textContent ?? '';
    const filterGroup = root?.querySelector('[role="group"][aria-label="Inbox thread filter"]');
    const buttonPressed = (label) => [...(filterGroup?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === label)
      ?.getAttribute('aria-pressed') === 'true';
    const unknownRegion = section?.querySelector('[data-watch-thread-row="1008"] [role="region"]');
    const unknownLink = [...(unknownRegion?.querySelectorAll('a') ?? [])]
      .find((candidate) => candidate.href === 'https://github.com/smoke-user/secondary-repo');
    const status = root?.querySelector('[data-watch-status]');
    const listEnd = section?.querySelector('[data-surface-list-end="timeline"]');
    return {
      unreadPressed: buttonPressed('Unread'),
      allPressed: buttonPressed('All'),
      unreadTitleVisible: text.includes('Unread issue thread'),
      readTitleVisible: text.includes('Read pull request thread'),
      unknownTitleVisible: text.includes('Future event thread'),
      unknownTypeVisible: text.includes('FutureEvent'),
      unknownFallbackHref: unknownLink?.href ?? null,
      outOfScopeVisible: text.includes('OUT OF SCOPE MUST NOT RENDER'),
      statusKind: status?.getAttribute('data-watch-status') ?? null,
      listEndTone: listEnd?.getAttribute('data-surface-list-end-tone') ?? null,
      listEndText: listEnd?.textContent?.trim() ?? null,
    };
  });
}

async function openWatchSubjectDetail(page, title, terminalState = 'success') {
  const clicked = await page.evaluate((subjectTitle) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const disclosure = [...(root?.querySelectorAll('button[data-watch-thread]') ?? [])]
      .find((candidate) => candidate.getAttribute('aria-label') === `Notification details: ${subjectTitle}`);
    disclosure?.click();
    return !!disclosure;
  }, title);
  assert.equal(clicked, true, `could not expand Watch subject ${title}`);
  try {
    await page.waitForFunction(
      (expectedState) => !!document
        .getElementById('gsm-manager-host')
        ?.shadowRoot
        ?.querySelector(`[data-watch-subject-detail="${expectedState}"]`),
      { polling: DOM_POLLING_MS, timeout: 10_000 },
      terminalState,
    );
  } catch (error) {
    const state = await page.evaluate(() => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      const row = root?.querySelector('[data-watch-thread-row="1017"]');
      return {
        row: row?.textContent ?? null,
        detailState: row?.querySelector('[data-watch-subject-detail]')?.getAttribute('data-watch-subject-detail') ?? null,
        detailText: row?.querySelector('[data-watch-subject-detail]')?.textContent ?? null,
      };
    });
    throw new Error(`Watch subject detail did not reach ${terminalState}: ${JSON.stringify(state)}; requests=${JSON.stringify(backgroundGitHubApiGuard?.unexpectedUrls)}; ${formatError(error)}`);
  }
}

async function assertWatchSubjectDetail(page, fixture) {
  const detail = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const slot = root?.querySelector('[data-watch-subject-detail="success"]');
    const details = slot?.closest('[role="region"]');
    return {
      text: slot?.textContent ?? '',
      markReadEnabled: [...(details?.querySelectorAll('button') ?? [])]
        .some((button) => button.textContent?.trim() === 'Mark as read' && !button.disabled),
      openHref: [...(details?.querySelectorAll('a') ?? [])]
        .find((link) => link.textContent?.includes('Open Issue in GitHub'))?.href ?? null,
    };
  });
  assert.equal(detail.text.includes('runtime-detail'), true);
  assert.equal(detail.text.includes('2 comments'), true);
  assert.equal(detail.text.includes('Runtime Issue detail loaded only after this thread was expanded.'), true);
  assert.equal(detail.markReadEnabled, true);
  assert.equal(detail.openHref, 'https://github.com/smoke-user/smoke-repo/issues/17');
  assert.deepEqual(fixture.requestedUrls, [{
    url: 'https://api.github.com/repos/smoke-user/smoke-repo/issues/17',
    authorization: 'Bearer github_pat_runtime_smoke_main',
    accept: 'application/vnd.github.raw+json',
    apiVersion: '2026-03-10',
  }]);
}
async function assertWatchSubjectPermissionRecovery(page) {
  const state = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const slot = root?.querySelector('[data-watch-subject-detail="error"]');
    const details = slot?.closest('[role="region"]');
    const button = (label) => [...(slot?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === label);
    const openOptions = button('Open options');
    const state = {
      text: slot?.textContent ?? '',
      optionsPresent: !!openOptions,
      retryPresent: !!button('Retry'),
      markDoneEnabled: [...(details?.querySelectorAll('button') ?? [])]
        .some((candidate) => candidate.textContent?.trim() === 'Mark as done' && !candidate.disabled),
      openHref: [...(details?.querySelectorAll('a') ?? [])]
        .find((link) => link.textContent?.includes('Open Pull Request in GitHub'))?.href ?? null,
    };
    openOptions?.click();
    return state;
  });
  assert.equal(
    state.text.includes('The main GitHub token needs Issues: read'),
    true,
    `unexpected Watch permission detail state: ${JSON.stringify(state)}`,
  );
  assert.equal(state.optionsPresent, true);
  assert.equal(state.retryPresent, true);
  assert.equal(state.markDoneEnabled, true);
  assert.equal(state.openHref, 'https://github.com/smoke-user/smoke-repo/pull/9');
}

async function openWatchRepositoryDetail(page, fullName) {
  const clicked = await page.evaluate((repository) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const section = root?.querySelector('section[aria-label="Watched stars inbox"]');
    const button = [...(section?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === repository);
    button?.click();
    return !!button;
  }, fullName);
  assert.equal(clicked, true, `could not select Watch repository ${fullName}`);
  try {
    await page.waitForFunction(
      (repository) => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        const drawer = root?.querySelector('.drawer-anim.drawer-enter');
        const link = [...(drawer?.querySelectorAll('a') ?? [])]
          .find((candidate) => candidate.textContent?.trim() === repository);
        return !!link && !!drawer?.querySelector('textarea') && drawer.getBoundingClientRect().width >= 339;
      },
      { polling: DOM_POLLING_MS, timeout: 10_000 },
      fullName,
    );
  } catch (error) {
    const drawerState = await page.evaluate(() => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      const drawer = root?.querySelector('.drawer-anim');
      return {
        className: drawer?.className ?? null,
        width: drawer?.getBoundingClientRect().width ?? null,
        text: drawer?.textContent?.slice(0, 500) ?? null,
        textareaCount: drawer?.querySelectorAll('textarea').length ?? 0,
      };
    }).catch(() => null);
    const waitError = await pageWaitError(page, `Watch detail did not open for ${fullName}`, error);
    throw new Error(`${waitError.message}\nDrawer state: ${JSON.stringify(drawerState)}`);
  }
}

async function assertWatchRepositoryDetail(page, fullName) {
  const detail = await page.evaluate((repository) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const drawer = root?.querySelector('.drawer-anim.drawer-enter');
    const link = [...(drawer?.querySelectorAll('a') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === repository);
    return {
      width: drawer?.getBoundingClientRect().width ?? 0,
      href: link?.href ?? null,
      descriptionVisible: drawer?.textContent?.includes(
        'Primary repository detail loaded from the live local Star row.',
      ) ?? false,
      languageVisible: drawer?.textContent?.includes('TypeScript') ?? false,
      notesPlaceholder: drawer?.querySelector('textarea')?.getAttribute('placeholder') ?? null,
      closeButtonVisible: !!drawer?.querySelector('button[title="Close (Esc)"]'),
    };
  }, fullName);
  assert.equal(detail.width >= 339 && detail.width <= 341, true, 'Watch detail drawer width was not stable');
  assert.deepEqual({ ...detail, width: 340 }, {
    width: 340,
    href: `https://github.com/${fullName}`,
    descriptionVisible: true,
    languageVisible: true,
    notesPlaceholder: 'Why did you star this repo?',
    closeButtonVisible: true,
  });
}

async function closeWatchRepositoryDetail(page) {
  const clicked = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const button = root?.querySelector('.drawer-anim.drawer-enter button[title="Close (Esc)"]');
    button?.click();
    return !!button;
  });
  assert.equal(clicked, true, 'could not close Watch repository detail');
  await page.waitForFunction(
    () => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      const drawer = root?.querySelector('.drawer-anim');
      return !!drawer && drawer.classList.contains('drawer-exit') && drawer.getBoundingClientRect().width <= 1;
    },
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
}

async function waitForStableLayout(page) {
  await delay(DOM_POLLING_MS);
  await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    root?.getBoundingClientRect();
  });
}

async function assertWatchLayout(page, label) {
  await waitForStableLayout(page);
  const layout = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const section = root?.querySelector('section[aria-label="Watched stars inbox"]');
    const scrollPane = section?.parentElement;
    const headerRow = section?.querySelector(
      '[data-surface-command-bar="watch"] [data-surface-work-canvas="watch"]',
    );
    const rootRect = root?.getBoundingClientRect();
    const sectionRect = section?.getBoundingClientRect();
    const headerChildren = [...(headerRow?.children ?? [])]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
    const overlappingHeaderPairs = headerChildren.flatMap((left, leftIndex) =>
      headerChildren.slice(leftIndex + 1).filter((right) => (
        Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 &&
        Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1
      )).map(() => leftIndex),
    ).length;
    const controlsOutsideSection = [...(section?.querySelectorAll('button, a') ?? [])]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.visibility === 'hidden' || style.display === 'none' || rect.width === 0 || rect.height === 0) {
          return false;
        }
        return !sectionRect || rect.left < sectionRect.left - 1 || rect.right > sectionRect.right + 1;
      }).length;
    return {
      viewportWidth: innerWidth,
      rootLeft: rootRect?.left ?? -1,
      rootRight: rootRect?.right ?? -1,
      rootOverflow: root ? root.scrollWidth - root.clientWidth : -1,
      scrollPaneOverflow: scrollPane ? scrollPane.scrollWidth - scrollPane.clientWidth : -1,
      sectionOverflow: section ? section.scrollWidth - section.clientWidth : -1,
      sectionLeft: sectionRect?.left ?? -1,
      sectionRight: sectionRect?.right ?? -1,
      headerChildren: headerChildren.length,
      overlappingHeaderPairs,
      controlsOutsideSection,
    };
  });
  assert.equal(layout.rootLeft >= 0, true, `${label} Manager extended left of the viewport`);
  assert.equal(layout.rootRight <= layout.viewportWidth + 1, true, `${label} Manager extended right of the viewport`);
  assert.equal(layout.rootOverflow <= 1, true, `${label} Manager has horizontal overflow`);
  assert.equal(layout.scrollPaneOverflow <= 1, true, `${label} Watch scroll pane has horizontal overflow`);
  assert.equal(layout.sectionOverflow <= 1, true, `${label} Watch section has horizontal overflow`);
  assert.equal(layout.sectionLeft >= -1, true, `${label} Watch section extended left of its viewport`);
  assert.equal(layout.sectionRight <= layout.viewportWidth + 1, true, `${label} Watch section extended right of its viewport`);
  assert.equal(layout.headerChildren >= 3, true, `${label} Watch query controls were incomplete`);
  assert.equal(layout.overlappingHeaderPairs, 0, `${label} Watch header controls overlapped`);
  assert.equal(layout.controlsOutsideSection, 0, `${label} Watch controls were clipped outside the section`);
}

async function assertWatchSetupState(page) {
  try {
    await page.waitForFunction(
      () => {
        const host = document.getElementById('gsm-manager-host');
        const root = host?.shadowRoot?.getElementById('gsm-manager-root');
        const section = root?.querySelector('section[aria-label="Watched stars inbox"]');
        return document.querySelectorAll('#gsm-manager-host').length === 1 &&
          !!root && !!section &&
          [...(section?.querySelectorAll('button') ?? [])]
            .some((candidate) => candidate.textContent?.trim() === 'Open options');
      },
      { polling: DOM_POLLING_MS, timeout: 20_000 },
    );
  } catch (error) {
    throw await pageWaitError(page, 'Watch setup recovery state did not render', error);
  }
  const state = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const buttons = [...(root?.querySelectorAll('#gsm-stars-surface-tab, #gsm-watch-surface-tab, #gsm-radar-surface-tab') ?? [])];
    return {
      managerMounted: !!root,
      managerMountPreserved: root?.getRootNode()?.host?.dataset?.watchSmokeMount === 'preserved',
      starsControlPresent: buttons.some((candidate) => candidate.textContent?.trim() === 'Stars'),
      watchPressed: buttons.some((candidate) => (
        candidate.textContent?.trim().startsWith('Watch') && candidate.getAttribute('aria-selected') === 'true'
      )),
    };
  });
  assert.deepEqual(state, {
    managerMounted: true,
    managerMountPreserved: true,
    starsControlPresent: true,
    watchPressed: true,
  });
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
      titleVisible: prompt?.textContent?.includes('Let Cubby look first?') ?? false,
      yesVisible: prompt?.textContent?.includes('Ask Cubby') ?? false,
      noVisible: prompt?.textContent?.includes('Use Auto Tags') ?? false,
      mascotState: prompt?.querySelector('[data-testid="agent-mascot"]')?.getAttribute('data-state') ?? null,
      focusedText: root?.activeElement?.textContent?.trim() ?? null,
    };
  });
  assert.deepEqual(initial, {
    titleVisible: true,
    yesVisible: true,
    noVisible: true,
    mascotState: 'compacting',
    focusedText: 'Ask Cubby',
  });

  const choseLocal = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const button = [...(root?.querySelectorAll('[data-testid="auto-tag-agent-prompt"] button') ?? [])]
      .find((candidate) => candidate.textContent?.includes('Use Auto Tags'));
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
    animationName: 'none',
    resourceOk: true,
  });
  assert.match(mascot.assetUrl ?? '', /^chrome-extension:\/\/[^/]+\/assets\/index-agent-atlas-[^/]+\.png$/u);
  assert.equal(mascot.bytes > 0, true);
  await clickShadowButton(page, 'button[aria-label="Suggested actions"]');
  await page.waitForFunction(
    () => !!document
      .getElementById('gsm-manager-host')
      ?.shadowRoot
      ?.querySelector('[role="group"][aria-label="Choose an action"]'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const functionLabels = await page.evaluate(() => [...(
    document
      .getElementById('gsm-manager-host')
      ?.shadowRoot
      ?.querySelectorAll('[role="group"][aria-label="Choose an action"] button') ?? []
  )].map((item) => item.querySelector('span > span')?.textContent?.trim() ?? ''));
  assert.deepEqual(functionLabels, [
    'Summarize this view',
    'Compare similar repositories',
    'Organize full library',
    'Clean up tags',
  ]);
  await clickShadowButton(page, 'button[aria-label="Suggested actions"]');
  await page.waitForFunction(
    () => !document
      .getElementById('gsm-manager-host')
      ?.shadowRoot
      ?.querySelector('[role="group"][aria-label="Choose an action"]'),
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
    const location = message.location();
    if (label === OPTIONS_PATH && text.includes('api.github.com') && text.includes('401')) return;
    if (label === OPTIONS_PATH && text.includes('Failed to load resource') && text.includes('401')) return;
    if (
      (label === OPTIONS_PATH || label === 'watch-fallback') &&
      text.includes('Failed to load resource') &&
      text.includes('403') &&
      location.url === 'https://api.github.com/notifications?all=true&per_page=1'
    ) return;
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
