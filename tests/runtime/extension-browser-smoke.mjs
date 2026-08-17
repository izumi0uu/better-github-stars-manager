#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FIREFOX_DIST_DIR,
  FIREFOX_GECKO_ID,
} from '../../scripts/build-firefox-extension.mjs';
import { FIREFOX_RUNTIME_SCENARIO_IDS } from '../../scripts/agent-runtime-release-evidence.mjs';
import {
  launchExtensionBrowser,
  openFirefoxExtensionPage,
  prepareFirefox140ExtensionPage,
  normalizeRuntimeTarget,
  resolveExecutablePath,
  readEdgeBrowserIdentity,
  sha256Executable,
} from './puppeteer-runtime.mjs';
import {
  discoverExtension,
  extensionOrigin,
  openExtensionPage as openRuntimeExtensionPage,
} from './extension-runtime-targets.mjs';
import { buildResponsesSse as buildControlledResponsesSse } from './controlled-responses-provider.mjs';

const OPTIONS_PATH = '/src/options/index.html';
const POPUP_PATH = '/src/popup/index.html';
const INVALID_TOKEN = 'github_pat_invalid_extension_browser_smoke';
const STARS_URL = 'https://github.com/smoke-user?tab=stars';
const REPO_URL = 'https://github.com/smoke-user/smoke-repo';
const DOM_POLLING_MS = 100;
const FIREFOX_BACKGROUND_FETCH_BRIDGE = '__gsmFirefoxBackgroundFetch';
const FIREFOX_BACKGROUND_GUARD_STATE = '__gsmFirefoxBackgroundGuard';
const FIREFOX_GUARDED_ORIGINS = Object.freeze([
  'https://api.github.com/',
  'https://api.openai.com/',
  'https://api.anthropic.com/',
  'https://openrouter.ai/',
]);

export const CHROMIUM_FULL_PRODUCT_SCENARIO_IDS = Object.freeze([
  'popup-options-navigation',
  'classic-pat-rejection',
  'cubby-provider-disclosure',
  'stars-owner-gating',
  'stars-manager-full-product-controls',
  'watch-radar-discovery',
  'turbo-navigation-idempotence',
  'repository-tag-chip',
  'watch-stored-projection',
  'watch-repository-detail-responsive',
  'stars-surface-recovery',
  'watch-credential-recovery',
]);

export { FIREFOX_RUNTIME_SCENARIO_IDS };

let DIST;
let STORE_RATING_SMOKE;
let profile;
let failures;
let pageIssues;
let backgroundGitHubApiGuard = null;
let backgroundStartupHealthChecks;
let browser;
let runtimeTarget;
let activeExtensionRuntime;
let extensionPageOpener = null;
let prepareLegacyFirefoxPage = false;

function step(message) {
  console.log(`\n${message}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

function recordPageIssue(label, issue) {
  if (pageIssues.length >= 24) return;
  pageIssues.push(`[${label}] ${String(issue).slice(0, 500)}`);
}

export async function runExtensionBrowserSmoke(options = {}) {
  if (browser || profile) throw new Error('Extension browser smoke is already running.');
  runtimeTarget = normalizeRuntimeTarget(options.target ?? 'chrome');
  prepareLegacyFirefoxPage = runtimeTarget === 'firefox' && options.puppeteerDriver === 'firefox_140';
  DIST = path.resolve(
    options.dist
      ?? process.env.GSM_DIST_DIR
      ?? (runtimeTarget === 'firefox'
        ? FIREFOX_DIST_DIR
        : runtimeTarget === 'edge' ? 'dist-edge' : 'dist'),
  );
  STORE_RATING_SMOKE = runtimeTarget === 'chrome' && process.env.GSM_STORE_TARGET === 'chrome';
  failures = [];
  pageIssues = [];
  activeExtensionRuntime = null;
  backgroundStartupHealthChecks = 0;
  let extensionId = null;
  let browserVersion = null;
  let edgeBrowserIdentity = null;
  let edgeExecutableSha256 = null;

  if (!existsSync(path.join(DIST, 'manifest.json'))) {
    const missingDist = DIST;
    const missingTarget = runtimeTarget;
    cleanupSmokeState();
    throw new Error(`No ${path.basename(missingDist)}/manifest.json found at ${missingDist}. Build the ${missingTarget} extension first.`);
  }
  let executablePath;
  try {
    executablePath = await resolveExecutablePath({
      target: runtimeTarget,
      executablePath: options.executablePath,
      puppeteerDriver: options.puppeteerDriver,
    });
    if (runtimeTarget === 'edge') edgeExecutableSha256 = await sha256Executable(executablePath);
    profile = mkdtempSync(path.join(os.tmpdir(), `gsm-${runtimeTarget}-extension-smoke-`));
  } catch (error) {
    cleanupSmokeState();
    throw error;
  }

  try {
    browser = await launchExtensionBrowser({
      target: runtimeTarget,
      dist: DIST,
      executablePath,
      userDataDir: profile,
      protocolTimeout: 90_000,
      // Firefox BiDi cannot observe event-page replacement, so lost test guards must still fail closed.
      failClosedNetwork: runtimeTarget === 'firefox',
      puppeteerDriver: options.puppeteerDriver,
    });
    if (runtimeTarget === 'edge') {
      edgeBrowserIdentity = await readEdgeBrowserIdentity(browser, {
        executableSha256: edgeExecutableSha256,
      });
      if (
        edgeBrowserIdentity.releaseProofEligible !== true
        && options.allowNonEdgeExecutableForLocalTest !== true
      ) {
        throw new Error(
          'EDGE_EXECUTABLE did not satisfy Microsoft Edge release identity proof: require Edg/<version>, a hashed executable, and no --user-agent override. Set EDGE_EXECUTABLE to Microsoft Edge. Non-Edge Chromium is available only through the explicit allowNonEdgeExecutableForLocalTest mode and never produces release proof.',
        );
      }
    }
    // Firefox BiDi cannot navigate directly to moz-extension:// pages.
    extensionPageOpener = runtimeTarget === 'firefox'
      ? (url, { timeoutMs }) => openFirefoxExtensionPage(browser, {
          executablePath,
          userDataDir: profile,
          url,
          timeoutMs,
          preparePage: prepareLegacyFirefoxPage ? prepareFirefox140ExtensionPage : null,
          reuseExistingPage: !prepareLegacyFirefoxPage,
        })
      : null;
    const reportedBrowserVersion = await browser.version();
    browserVersion = runtimeTarget === 'firefox'
      ? reportedBrowserVersion.replace(/^firefox\//iu, 'Firefox/')
      : runtimeTarget === 'edge'
        ? `${edgeBrowserIdentity.name}/${edgeBrowserIdentity.version}`
        : reportedBrowserVersion;
    extensionId = await detectExtensionId(browser);
    // Firefox BiDi does not expose the event page before getBackgroundPage resolves,
    // so startup is a semantic health check and error counts cover only attached intervals.
    if (runtimeTarget === 'firefox') {
      const startupStatus = await activeExtensionRuntime.controlPage.evaluate(
        () => chrome.runtime.sendMessage({ type: 'getStatus' }),
      );
      assert.equal(startupStatus?.ok, true, 'Firefox background did not pass its initial semantic health check.');
      backgroundStartupHealthChecks += 1;
    }
    await installBackgroundGitHubApiGuard(browser, extensionId);
    ok(`extension loaded: ${extensionId}`);
    ok(`browser reported: ${browserVersion}`);

    step('1) Popup no-token path opens Options');
    const popup = await openExtensionPage(extensionId, POPUP_PATH, 'popup');
    await waitForPopupNoTokenState(popup);

    const openedOptions = runtimeTarget === 'firefox'
      ? null
      : waitForExtensionPage(`${OPTIONS_PATH}`);
    if (runtimeTarget === 'firefox') await interceptFirefoxOpenOptionsRequest(popup);
    await clickButtonByText(popup, /^添加 Classic PAT$/);
    let optionsFromPopup;
    if (runtimeTarget === 'firefox') {
      await waitForFirefoxOpenOptionsRequest(popup);
      optionsFromPopup = await openExtensionPage(extensionId, OPTIONS_PATH, 'options-from-popup');
    } else {
      optionsFromPopup = await openedOptions;
    }
    await optionsFromPopup.waitForSelector('textarea', { timeout: 10_000 });
    await waitForBodyText(optionsFromPopup, 'GitHub Classic PAT');
    await assertOptionsDefaultChineseAndUseEnglish(optionsFromPopup);
    await assertScheduledRefreshAlarms(optionsFromPopup, false);
    ok('Watch and Radar periodic alarms were installed; ineligible recommendation alarm stayed absent');
    ok('popup and Options defaulted to Chinese, then Options switched to English for the remaining smoke flow');

    step('2) Options rejects invalid token without persisting auth');
    await interceptGitHubApi(optionsFromPopup, invalidTokenApiResponse);
    await assertInvalidTokenApiStub(optionsFromPopup);
    await saveToken(optionsFromPopup, INVALID_TOKEN);
    await waitForBodyText(
      optionsFromPopup,
      'GitHub rejected this Classic PAT.',
      8_000,
    );
    await assertNoAuthenticatedBanner(optionsFromPopup);
    ok('invalid token was rejected and no authenticated banner appeared');

    step('3) Cubby disclosure is explicit and gates Provider traffic');
    await assertAgentDisclosureInfo(optionsFromPopup);
    ok('Options required explicit data-sharing acceptance before Cubby testing');
    if (runtimeTarget === 'firefox') await optionsFromPopup.close().catch(() => {});

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
    await seedConfig(extensionId, {
      username: 'smoke-user',
      tokenEncrypted: 'smoke-ciphertext',
      tokenCryptoMeta: { iv: 'smoke-iv', salt: 'smoke-salt' },
      starsPanelDefaultEnabled: true,
      watchCredentialSource: null,
      githubCredentialStatus: 'ready',
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

    if (!STORE_RATING_SMOKE) {
      step('5b) Manager toolbar keeps one row across responsive widths');
      await assertToolbarResponsiveLayout(ownStars);
      ok('toolbar kept one row, compressed search/sort controls, synchronized action labels, and a circular compact account trigger');
    }

    step('6) Discover switches from Following to deterministic For You recommendations');
    const seededWatch = await seedWatchAndRadarFixture(extensionId);
    await assertScheduledRefreshAlarms(
      runtimeTarget === 'firefox' ? activeExtensionRuntime.controlPage : optionsFromPopup,
      true,
    );
    await ownStars.bringToFront();
    await ownStars.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForManagerRoot(ownStars);
    await assertManagerSurfaceBadges(ownStars, { watch: '2', radar: '1' });
    ok('Watch and Radar badges rendered from lightweight stored counts before either surface opened');
    await ownStars.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await assertRadarSourceFilters(ownStars);
    await assertForYouRecommendations(ownStars);
    ok('Following/For You, source filters, recommendation evidence, and search isolation responded');
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

    await waitForBackgroundIdle(
      runtimeTarget === 'firefox' ? activeExtensionRuntime.controlPage : optionsFromPopup,
    );
    if (runtimeTarget !== 'firefox') await optionsFromPopup.close();
    resetBackgroundGitHubApiCalls(browser, extensionId);
    const subjectDetailFixture = installBackgroundWatchSubjectDetailFixture(extensionId);

    step('9) Watch renders the bounded stored snapshot without GitHub API calls');
    assert.deepEqual(seededWatch, {
      databaseVersion: 5,
      hasMainToken: true,
      hasNotificationsToken: true,
      allThreadCount: 3,
      allGroupCount: 2,
      customThreadOutsideNativeScopeVisible: true,
      notificationOutsideLiveStarsVisible: false,
      radarActivityCount: 1,
      radarUnseenCount: 1,
      watchBadgeCount: 2,
      radarBadgeCount: 1,
      recommendationCount: 1,
      recommendationExcludedFromStars: true,
    });
    await ownStars.bringToFront();
    await ownStars.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForManagerRoot(ownStars);
    await waitForStarsRows(ownStars, 'seeded Stars fixture');
    await assertRepositoryAvatarLayout(ownStars);
    ok('repository avatars rendered after deep virtual-list scrolling, and layout edit persisted an explicit opt-out');
    await waitForBackgroundIdle(popup);
    await delay(500);
    await waitForBackgroundIdle(popup);
    resetBackgroundGitHubApiCalls(browser, extensionId);
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
      unknownFallbackHref: 'https://github.com/smoke-user/custom-repo',
      notificationOutsideLiveStarsVisible: false,
      statusKind: 'stale',
      listEndTone: 'info',
      listEndText: 'End of current window · older threads may exist',
    });

    await clickWatchFilter(ownStars, 'All');
    const allSnapshot = await readWatchSnapshot(ownStars);
    assert.equal(allSnapshot.unreadPressed, false);
    assert.equal(allSnapshot.allPressed, true);
    assert.equal(allSnapshot.readTitleVisible, true);
    assert.equal(allSnapshot.notificationOutsideLiveStarsVisible, false);
    ok('Unread/All changed the stored projection, Custom threads bypassed native scope, and unknown subjects fell back safely');
    await openWatchSubjectDetail(ownStars, 'Unread issue thread');
    await assertWatchSubjectDetail(ownStars, subjectDetailFixture);
    ok('Watch Issue details loaded on demand through the main credential');
    subjectDetailFixture.setMode('forbidden');
    await openWatchSubjectDetail(ownStars, 'Read pull request thread', 'error');
    await interceptFirefoxBackgroundOpenOptionsRequest();
    const detailRecoveryOptionsOpened = runtimeTarget === 'firefox'
      ? null
      : waitForExtensionPage(`${OPTIONS_PATH}`);
    await assertWatchSubjectPermissionRecovery(ownStars);
    await waitForFirefoxBackgroundOpenOptionsRequest('github');
    if (runtimeTarget !== 'firefox') {
      const detailRecoveryOptions = await detailRecoveryOptionsOpened;
      await assertGitHubOptionsIntent(detailRecoveryOptions);
      await detailRecoveryOptions.close();
    }
    ok('Watch permission failure offered focused GitHub authorization recovery while preserving row actions');

    step('10) Watch repository headers open local detail and remain coherent responsively');
    await openWatchRepositoryDetail(ownStars, 'smoke-user/smoke-repo');
    await assertWatchRepositoryDetail(ownStars, 'smoke-user/smoke-repo');
    await assertWatchLayout(ownStars, 'desktop');

    await closeWatchRepositoryDetail(ownStars);
    await ownStars.setViewport({ width: 360, height: 740, deviceScaleFactor: 1 });
    await waitForStableLayout(ownStars);
    await assertWatchLayout(ownStars, 'narrow');
    ok('Watch detail and responsive layout verified');

    step('11) Returning from Watch or Following restores the Stars repository list');
    await ownStars.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await assertStarsRowsAfterSurfaceReturn(ownStars, 'watch');
    await assertStarsRowsAfterSurfaceReturn(ownStars, 'radar');
    ok('Stars rows rendered after returning from both Watch and Following');

    if (STORE_RATING_SMOKE) {
      step('11b) Store rating prompt waits through onboarding, recovery, and active work');
      await seedConfig(extensionId, {
        onboardingStage: 'coach',
        seenOnboarding: false,
        storeRatingPrompt: {
          version: 1,
          status: 'tracking',
          activeLocalDays: ['2026-08-13', '2026-08-14', '2026-08-15'],
          meaningfulActionCount: 2,
          exposureCount: 0,
          snoozeUntil: null,
        },
      });
      await refreshManagerStatusFromStorage(extensionId);
      await waitForManagerRoot(ownStars);
      await assertStoreRatingSuppressedDuringOnboarding(ownStars);
      await finishStoreRatingOnboarding(ownStars);
      await waitForStarsRows(ownStars, 'store-rating fixture');

      const storeRatingSync = installBackgroundStoreRatingSyncFixture(extensionId);
      try {
        await assertStoreRatingSuppressedByVisibleError(ownStars, storeRatingSync);
        await assertStoreRatingPrompt(ownStars, extensionId, storeRatingSync);
      } finally {
        storeRatingSync.restore();
      }
      await assertStoreRatingOptions(extensionId);
      ok('prompt stayed suppressed through onboarding, recovery, and active work; keyboard dismissal restored the favorite control and Options showed the store link without a reminder toggle');
    }

    step('12) Watch recovery opens focused GitHub authorization without clearing the Classic PAT');
    await markManagerMount(ownStars);
    const disconnected = await clearWatchNotificationsCredential(extensionId);
    assert.deepEqual(disconnected, {
      mainCredentialPreserved: true,
      watchNotificationsDisabled: true,
      watchChangeDelivered: true,
    });
    await openWatchSurface(ownStars, 'Open options');
    await assertWatchSetupState(ownStars);
    await interceptFirefoxBackgroundOpenOptionsRequest();
    const openedWatchOptions = runtimeTarget === 'firefox'
      ? null
      : waitForExtensionPage(`${OPTIONS_PATH}`);
    await clickWatchRecoveryOptions(ownStars);
    await waitForFirefoxBackgroundOpenOptionsRequest('watch');
    const watchOptions = runtimeTarget === 'firefox'
      ? activeExtensionRuntime.controlPage
      : await openedWatchOptions;
    if (runtimeTarget !== 'firefox') await assertWatchOptionsIntent(watchOptions);
    assert.deepEqual(await readWatchCredentialState(watchOptions), {
      watchNotificationsEnabled: false,
      hasNotificationsToken: false,
    });
    await assertNoBackgroundGitHubApiCalls(browser, extensionId);
    ok('Watch recovery focused the single Classic PAT authorization flow and kept the credential intact');

    if (runtimeTarget === 'firefox') {
      await assertFirefoxRuntimeParity(watchOptions, extensionId, ownStars);
      ok('Firefox messaging, ports, Cubby refusal and live turn, full-library Organize, and background event-page recovery remained operational');
    }
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
    await closeBackgroundGitHubApiGuard();
    await browser?.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }

  const result = Object.freeze({
    browserTarget: runtimeTarget,
    realBrowser: true,
    browserVersion,
    ...(runtimeTarget === 'edge' ? {
      executable: Object.freeze({ algorithm: 'sha256', sha256: edgeExecutableSha256 }),
      browserIdentity: edgeBrowserIdentity,
    } : { executablePath }),
    extensionId,
    background: Object.freeze({
      kind: runtimeTarget === 'firefox' ? 'event_page' : 'service_worker',
      module: true,
    }),
    scenarioIds: runtimeTarget === 'firefox'
      ? FIREFOX_RUNTIME_SCENARIO_IDS
      : runtimeTarget === 'edge' ? CHROMIUM_FULL_PRODUCT_SCENARIO_IDS : Object.freeze([]),
    diagnostics: Object.freeze({
      observedPageErrors: pageIssues.filter((issue) => !issue.includes('[background')).length,
      observedBackgroundErrors: pageIssues.filter((issue) => issue.includes('[background')).length,
      observedUncaughtErrors: pageIssues.length,
      backgroundObservation: runtimeTarget === 'firefox'
        ? 'post_startup_guarded_intervals'
        : 'post_guard_install',
      startupHealthChecks: backgroundStartupHealthChecks,
    }),
  });
  const failureMessage = failures.length
    ? `Extension browser smoke failed:\n${failures.join('\n')}`
    : null;
  const passedTarget = runtimeTarget;
  cleanupSmokeState();
  if (failureMessage) throw new Error(failureMessage);
  const passedBrowser = passedTarget === 'firefox'
    ? 'Firefox extension'
    : passedTarget === 'edge' ? 'Edge extension' : 'Extension';
  console.log(`\n${passedBrowser} browser smoke passed.`);
  return result;
}

function cleanupSmokeState() {
  DIST = undefined;
  STORE_RATING_SMOKE = undefined;
  profile = undefined;
  failures = undefined;
  pageIssues = undefined;
  backgroundStartupHealthChecks = undefined;
  browser = undefined;
  runtimeTarget = undefined;
  activeExtensionRuntime = undefined;
  backgroundGitHubApiGuard = null;
  extensionPageOpener = null;
  prepareLegacyFirefoxPage = false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExtensionBrowserSmoke({
    target: process.env.GSM_RUNTIME_TARGET ?? 'chrome',
  }).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}

async function detectExtensionId(browserInstance) {
  activeExtensionRuntime = await discoverExtension(browserInstance, {
    target: runtimeTarget,
    dist: DIST,
    timeoutMs: 20_000,
    openPage: extensionPageOpener,
  });
  return activeExtensionRuntime.extensionId;
}

async function openExtensionPage(extId, pagePath, label) {
  return openRuntimeExtensionPage(browser, extId, pagePath, label, {
    target: runtimeTarget,
    timeoutMs: 30_000,
    readyTimeoutMs: 10_000,
    beforeNavigation: async (page) => {
      await useDeterministicMotion(page);
      hookPageDiagnostics(page, label);
    },
    openPage: extensionPageOpener,
  });
}


// Observe the product's API call without depending on headless Firefox window management.
async function interceptFirefoxOpenOptionsRequest(page) {
  await page.evaluate(() => {
    globalThis.__gsmFirefoxOpenOptionsRequests = 0;
    chrome.runtime.openOptionsPage = async () => {
      globalThis.__gsmFirefoxOpenOptionsRequests += 1;
    };
  });
}

async function waitForFirefoxOpenOptionsRequest(page, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const calls = await page.evaluate(() => globalThis.__gsmFirefoxOpenOptionsRequests ?? 0);
    if (calls === 1) return;
    await delay(50);
  }
  throw new Error('Firefox popup did not request the Options page before timeout.');
}

async function interceptFirefoxBackgroundOpenOptionsRequest() {
  if (runtimeTarget !== 'firefox') return;
  await activeExtensionRuntime.controlPage.evaluate(async () => {
    const backgroundPage = await chrome.runtime.getBackgroundPage();
    if (!backgroundPage) throw new Error('Firefox background page is unavailable.');
    backgroundPage.__gsmFirefoxOpenOptionsRequest = { calls: 0, section: null };
    backgroundPage.chrome.runtime.openOptionsPage = async () => {
      const values = await backgroundPage.chrome.storage.session.get('gsm_options_intent');
      const intent = values.gsm_options_intent;
      backgroundPage.__gsmFirefoxOpenOptionsRequest = {
        calls: backgroundPage.__gsmFirefoxOpenOptionsRequest.calls + 1,
        section: intent?.section ?? null,
      };
    };
  });
}

async function waitForFirefoxBackgroundOpenOptionsRequest(expectedSection, timeoutMs = 10_000) {
  if (runtimeTarget !== 'firefox') return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await activeExtensionRuntime.controlPage.evaluate(async () => {
      const backgroundPage = await chrome.runtime.getBackgroundPage();
      return backgroundPage?.__gsmFirefoxOpenOptionsRequest ?? { calls: 0, section: null };
    });
    if (state.calls > 1) throw new Error(`Firefox background requested Options ${state.calls} times.`);
    if (state.calls === 1) {
      if (state.section !== expectedSection) {
        throw new Error(`Firefox background requested Options section ${String(state.section)}; expected ${expectedSection}.`);
      }
      return;
    }
    await delay(50);
  }
  throw new Error(`Firefox background did not request the ${expectedSection} Options intent before timeout.`);
}

async function assertScheduledRefreshAlarms(page, expectRecommendationAlarm) {
  const expectedPeriodic = [
    { name: 'bgsm-radar-auto-refresh', periodInMinutes: 60 },
    { name: 'bgsm-watch-inbox-auto-refresh', periodInMinutes: 1 },
    { name: 'bgsm-watch-scope-auto-refresh', periodInMinutes: 60 },
  ];
  const recommendationAlarm = 'bgsm-recommendations-daily-refresh';
  try {
    await page.waitForFunction(
      async ({ periodic, recommendation, expectedRecommendation }) => {
        const alarms = await chrome.alarms.getAll();
        const periodicReady = periodic.every((schedule) => alarms.some((alarm) => (
          alarm.name === schedule.name && alarm.periodInMinutes === schedule.periodInMinutes
        )));
        const recommendationReady = alarms.some((alarm) => (
          alarm.name === recommendation
          && (alarm.periodInMinutes === undefined || alarm.periodInMinutes === null)
          && new Date(alarm.scheduledTime).getHours() === 8
        ));
        return periodicReady && recommendationReady === expectedRecommendation;
      },
      { polling: DOM_POLLING_MS, timeout: 10_000 },
      {
        periodic: expectedPeriodic,
        recommendation: recommendationAlarm,
        expectedRecommendation: expectRecommendationAlarm,
      },
    );
  } catch (error) {
    let alarmState;
    try {
      alarmState = JSON.stringify(await page.evaluate(async () => chrome.alarms.getAll()));
    } catch (diagnosticError) {
      alarmState = `unavailable (${formatError(diagnosticError)})`;
    }
    throw await pageWaitError(
      page,
      `scheduled refresh alarms were not installed: ${alarmState}`,
      error,
    );
  }
  const actual = await page.evaluate(async (recommendation) => (await chrome.alarms.getAll())
    .filter((alarm) => alarm.name.startsWith('bgsm-') && (alarm.name.includes('auto-refresh') || alarm.name === recommendation))
    .map((alarm) => ({
      name: alarm.name,
      periodInMinutes: alarm.periodInMinutes ?? null,
      localHour: alarm.name === recommendation ? new Date(alarm.scheduledTime).getHours() : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name)), recommendationAlarm);
  const expected = [
    { name: 'bgsm-radar-auto-refresh', periodInMinutes: 60, localHour: null },
    ...(expectRecommendationAlarm
      ? [{ name: recommendationAlarm, periodInMinutes: null, localHour: 8 }]
      : []),
    { name: 'bgsm-watch-inbox-auto-refresh', periodInMinutes: 1, localHour: null },
    { name: 'bgsm-watch-scope-auto-refresh', periodInMinutes: 60, localHour: null },
  ];
  assert.deepEqual(actual, expected);
}


async function waitForExtensionPage(pagePath) {
  const prefix = `${extensionOrigin(activeExtensionRuntime.extensionId, runtimeTarget)}/`;
  let page;
  if (runtimeTarget === 'firefox') {
    const deadline = Date.now() + 10_000;
    while (!page && Date.now() < deadline) {
      const pages = await browser.pages();
      for (const candidate of pages) {
        const actualUrl = await candidate.evaluate(() => location.href).catch(() => null);
        if (actualUrl?.startsWith(prefix) && actualUrl.endsWith(pagePath)) {
          page = candidate;
          break;
        }
      }
      if (!page) await delay(50);
    }
    if (!page) throw new Error(`extension page did not open before timeout: ${pagePath}`);
  } else {
    const target = await browser.waitForTarget(
      (candidate) => candidate.url().startsWith(prefix) && candidate.url().endsWith(pagePath),
      { timeout: 10_000 },
    );
    page = await target.page();
    if (!page) throw new Error(`extension page opened without page handle: ${pagePath}`);
  }
  if (prepareLegacyFirefoxPage) prepareFirefox140ExtensionPage(page);
  await useDeterministicMotion(page);
  hookPageDiagnostics(page, pagePath);
  return page;
}

async function useDeterministicMotion(page) {
  if (page.isClosed()) return;
  try {
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]);
  } catch (error) {
    const message = formatError(error);
    if (page.isClosed() || /Target closed|Session closed/i.test(message)) return;
    if (runtimeTarget === 'firefox' && /unsupported|not supported/i.test(message)) return;
    throw error;
  }
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


async function refreshManagerStatusFromStorage(extId) {
  const page = await openExtensionPage(extId, OPTIONS_PATH, 'refresh-manager-status');
  try {
    await page.evaluate(async () => {
      const key = 'gsm_github_credentials';
      const current = await chrome.storage.local.get(key);
      const credentials = current[key];
      if (!credentials?.tokenEncrypted) {
        throw new Error('main credential was unavailable while refreshing manager status');
      }
      await chrome.storage.local.set({
        [key]: {
          ...credentials,
          storeRatingSmokeRefresh: Date.now(),
        },
      });
      await chrome.storage.local.set({ [key]: credentials });
    });
  } finally {
    await page.close();
  }
}

async function seedWatchAndRadarFixture(extId) {
  const page = await openExtensionPage(extId, OPTIONS_PATH, 'seed-watch');
  const seeded = await page.evaluate(async () => {
    const APP_SECRET = 'better-github-stars-manager/v1/static-derivation-secret';
    const DB_NAME = 'better-github-stars-manager';
    const DEXIE_VERSION = 5;
    const IDB_VERSION = DEXIE_VERSION * 10;
    const CONFIG_KEY = 'gsm_config';
    const CREDENTIALS_KEY = 'gsm_github_credentials';
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

    const mainCredential = await encrypt(
      'github_pat_runtime_smoke_main',
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
    const current = await chrome.storage.local.get(CONFIG_KEY);
    const credentials = {
      version: 1,
      tokenEncrypted: mainCredential.cipher,
      tokenCryptoMeta: mainCredential.meta,
      githubCredentialStatus: 'ready',
      watchNotificationsEnabled: true,
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
    if (!initialStatus?.data?.hasMainToken || !initialStatus.data?.hasNotificationsToken) {
      throw new Error(`seeded Watch status did not expose both credentials: ${JSON.stringify(initialStatus.data ?? null)}`);
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
      'recommendations',
      'recommendationState',
    ];
    for (const storeName of requiredStores) {
      if (!database.objectStoreNames.contains(storeName)) {
        database.close();
        throw new Error(`Dexie v5 is missing required store ${storeName}`);
      }
    }

    const star = (fullName, description, language, count, avatarUrl, starredAt = '2026-07-01T09:00:00.000Z') => ({
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
      owner_avatar_url: avatarUrl,
      starred_at: starredAt,
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
    const recommendations = transaction.objectStore('recommendations');
    const recommendationState = transaction.objectStore('recommendationState');
    stars.clear();
    repositories.clear();
    threads.clear();
    state.clear();
    radarActivities.clear();
    radarState.clear();
    recommendations.clear();
    recommendationState.clear();
    const avatarUrl = 'https://avatars.githubusercontent.com/u/1?v=4';
    const brokenAvatarUrl = 'https://avatars.githubusercontent.com/u/broken?v=4';
    stars.put(star(
      'smoke-user/smoke-repo',
      'Primary repository detail loaded from the live local Star row.',
      'TypeScript',
      3210,
      avatarUrl,
    ));
    stars.put(star(
      'smoke-user/custom-repo',
      'Live Star with a Custom notification absent from native watched membership.',
      'Rust',
      87,
      avatarUrl,
    ));
    for (let index = 0; index < 240; index++) {
      stars.put(star(
        `virtual-owner-${String(index).padStart(3, '0')}/repository`,
        `Virtualized Stars row ${index}`,
        index % 2 === 0 ? 'TypeScript' : 'Rust',
        1000 - index,
        avatarUrl,
      ));
    }
    stars.put(star(
      'fallback/missing-avatar',
      'Repository without avatar metadata.',
      'TypeScript',
      1,
      undefined,
      '2026-07-03T09:00:00.000Z',
    ));
    stars.put(star(
      'fallback/broken-avatar',
      'Repository whose avatar request fails.',
      'TypeScript',
      2,
      brokenAvatarUrl,
      '2026-07-02T09:00:00.000Z',
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
      repository: 'smoke-user/custom-repo',
      title: 'Future event thread',
      type: 'FutureEvent',
      unread: true,
      updatedAt: '2026-08-05T11:30:00.000Z',
      subjectHtmlUrl: null,
    }));
    threads.put(thread({
      id: '1001',
      repository: 'smoke-user/not-starred',
      title: 'OUTSIDE LIVE STARS MUST NOT RENDER',
      type: 'Issue',
      unread: true,
      updatedAt: '2026-08-05T13:30:00.000Z',
      subjectHtmlUrl: 'https://github.com/smoke-user/not-starred/issues/1',
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
        newerThan: '2026-08-05T12:00:00.000Z',
        historyBefore: '2026-08-05T12:05:00.000Z',
        historyNextPage: 11,
        historyExhausted: false,
        historyErrorCode: null,
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
      repositoryTopics: ['browser-extension', 'typescript'],
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
    recommendations.put({
      id: 'candidate/recommended-tool',
      accountLogin: 'smoke-user',
      repositoryKey: 'candidate/recommended-tool',
      repositoryFullName: 'candidate/recommended-tool',
      repositoryHtmlUrl: 'https://github.com/candidate/recommended-tool',
      description: 'Deterministic public recommendation for the For You browser smoke.',
      language: 'TypeScript',
      stargazerCount: 9876,
      topics: ['runtime-smoke', 'developer-tools'],
      owner: 'candidate',
      name: 'recommended-tool',
      pushedAt: '2026-08-05T11:00:00.000Z',
      createdAt: '2025-01-02T03:04:05.000Z',
      fork: false,
      archived: false,
      score: 84,
      reason: {
        kind: 'topic',
        value: 'runtime-smoke',
        seedRepositoryKey: 'smoke-user/smoke-repo',
        seedRepositoryFullName: 'smoke-user/smoke-repo',
      },
      fetchedAt: radarFetchedAt,
    });
    recommendationState.put({
      id: 'singleton',
      accountLogin: 'smoke-user',
      lastAttemptAt: radarFetchedAt,
      lastSuccessfulAt: radarFetchedAt,
      errorCode: null,
      nextAllowedAt: null,
      candidateCount: 1,
      seedCount: 2,
      queryCount: 1,
      rateLimitRemaining: 29,
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
    const surfaceBadges = await chrome.runtime.sendMessage({ type: 'queryManagerSurfaceBadges' });
    if (
      !surfaceBadges?.ok
      || surfaceBadges.data?.watchUnreadCount !== 2
      || surfaceBadges.data?.radarUnseenCount !== 1
    ) {
      throw new Error(surfaceBadges?.error ?? `seeded badge summary was unavailable: ${JSON.stringify(surfaceBadges?.data ?? null)}`);
    }
    const recommendationQuery = await chrome.runtime.sendMessage({ type: 'queryRecommendations' });
    if (
      !recommendationQuery?.ok
      || recommendationQuery.data?.recommendations?.[0]?.repositoryKey !== 'candidate/recommended-tool'
    ) {
      throw new Error(recommendationQuery?.error ?? `seeded recommendations were unavailable: ${JSON.stringify(recommendationQuery?.data ?? null)}`);
    }
    const storedStars = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onsuccess = () => {
        const opened = request.result;
        const read = opened.transaction('stars', 'readonly').objectStore('stars').get('candidate/recommended-tool');
        read.onsuccess = () => { opened.close(); resolve(read.result); };
        read.onerror = () => { opened.close(); reject(read.error); };
      };
      request.onerror = () => reject(request.error);
    });
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
      hasMainToken: allInbox.data.status.hasMainToken,
      watchBadgeCount: surfaceBadges.data.watchUnreadCount,
      radarBadgeCount: surfaceBadges.data.radarUnseenCount,
      hasNotificationsToken: allInbox.data.status.hasNotificationsToken,
      allThreadCount: allInbox.data.totalCount,
      allGroupCount: allInbox.data.groups.length,
      customThreadOutsideNativeScopeVisible: allInbox.data.threads.some((item) => item.id === '1008'),
      notificationOutsideLiveStarsVisible: allInbox.data.threads.some((item) => item.id === '1001'),
      radarActivityCount: radarQuery.data.activities.length,
      radarUnseenCount: radarQuery.data.unseenCount,
      recommendationCount: recommendationQuery.data.recommendations.length,
      recommendationExcludedFromStars: storedStars === undefined,
    };
  });
  await page.close();
  return seeded;
}

async function clearWatchNotificationsCredential(extId) {
  const page = await openExtensionPage(extId, OPTIONS_PATH, 'clear-watch-credential');
  const result = await page.evaluate(async () => {
    const CONFIG_KEY = 'gsm_config';
    const CREDENTIALS_KEY = 'gsm_github_credentials';
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
      watchNotificationsDisabled:
        afterCredentials.watchNotificationsEnabled === false &&
        afterConfig.watchNotificationsEnabled === false,
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
  guard.handle = async (request) => {
    const url = new URL(request.url);
    const subjectRoutes = new Set([
      'https://api.github.com/repos/smoke-user/smoke-repo/issues/17',
      'https://api.github.com/repos/smoke-user/smoke-repo/issues/9',
    ]);
    if (request.method !== 'GET' || !subjectRoutes.has(url.href)) return false;
    requestedUrls.push({
      url: url.href,
      authorization: request.headers.Authorization ?? request.headers.authorization ?? null,
      accept: request.headers.Accept ?? request.headers.accept ?? null,
      apiVersion: request.headers['X-GitHub-Api-Version'] ?? request.headers['x-github-api-version'] ?? null,
    });
    if (mode === 'forbidden') {
      await request.respond(403, JSON.stringify({ message: 'forbidden' }));
      return true;
    }
    await request.respond(200, JSON.stringify({
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
    }));
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

function installBackgroundStoreRatingSyncFixture(extId) {
  const guard = backgroundGitHubApiGuard;
  assert.ok(guard, `GitHub API guard was not installed for ${extId}`);
  const previousHandle = guard.handle;
  const queued = [];
  let waiter = null;

  guard.handle = async (guardRequest) => {
    const url = new URL(guardRequest.url);
    const isIncrementalStarsRequest = guardRequest.method === 'GET'
      && url.origin === 'https://api.github.com'
      && url.pathname === '/user/starred'
      && url.searchParams.get('per_page') === '100'
      && url.searchParams.get('page') === '1';
    if (!isIncrementalStarsRequest) {
      return previousHandle ? previousHandle(guardRequest) : false;
    }

    const request = {
      async failInvalidResponse() {
        await guardRequest.respond(400, JSON.stringify({ message: 'store-rating smoke sync failure' }));
      },
    };
    if (waiter) {
      const current = waiter;
      waiter = null;
      current.resolve(request);
    } else {
      queued.push(request);
    }
    return true;
  };

  return {
    async waitForRequest(timeoutMs = 10_000) {
      const next = queued.shift();
      if (next) return next;
      assert.equal(waiter, null, 'store-rating sync fixture already has a pending waiter');
      const { promise, resolve, reject } = Promise.withResolvers();
      let timeout;
      const pendingWaiter = {
        resolve(request) {
          clearTimeout(timeout);
          resolve(request);
        },
      };
      timeout = setTimeout(() => {
        if (waiter === pendingWaiter) waiter = null;
        reject(new Error('store-rating sync did not reach the deferred GitHub request'));
      }, timeoutMs);
      waiter = pendingWaiter;
      return promise;
    },
    restore() {
      guard.handle = previousHandle;
    }
  };
}

async function installBackgroundGitHubApiGuard(browserInstance, extId) {
  const guard = {
    browser: browserInstance,
    targetListener: null,
    clients: new Set(),
    pageInterceptors: new Set(),
    attachedTargets: new WeakSet(),
    unexpectedUrls: [],
    handle: null,
    firefoxControlPage: null,
  };
  backgroundGitHubApiGuard = guard;

  if (runtimeTarget === 'firefox') {
    const controlPage = activeExtensionRuntime?.controlPage;
    if (!controlPage || controlPage.isClosed()) {
      throw new Error('Firefox extension control page was unavailable.');
    }
    guard.firefoxControlPage = controlPage;
    await controlPage.exposeFunction(FIREFOX_BACKGROUND_FETCH_BRIDGE, async (candidate) => {
      const response = { value: null };
      const request = createFirefoxGuardRequest(candidate, response);
      await handleGuardedBackgroundRequest(guard, request);
      return response.value ?? { action: 'fail' };
    });
    await installFirefoxBackgroundGuard(controlPage);
    return;
  }

  const attach = async (target) => {
    if (guard.attachedTargets.has(target)) return;
    const prefix = `${extensionOrigin(extId, runtimeTarget)}/`;
    if (!target.url().startsWith(prefix) || target.type() !== 'service_worker') return;
    guard.attachedTargets.add(target);
    const client = await target.createCDPSession();
    guard.clients.add(client);
    await client.send('Fetch.enable', {
      patterns: [{ urlPattern: 'https://api.github.com/*', requestStage: 'Request' }],
    });
    client.on('Fetch.requestPaused', (event) => {
      const request = createCdpGuardRequest(client, event);
      void handleGuardedBackgroundRequest(guard, request)
        .catch((error) => recordPageIssue('background-network-guard', formatError(error)));
    });
  };
  guard.targetListener = (target) => {
    void attach(target).catch((error) => {
      recordPageIssue('background-network-guard', formatError(error));
    });
  };
  browserInstance.on('targetcreated', guard.targetListener);
  await Promise.all(browserInstance.targets().map(attach));
}

async function assertNoBackgroundGitHubApiCalls(browserInstance, extId) {
  await delay(100);
  const guard = backgroundGitHubApiGuard;
  assert.equal(guard?.browser, browserInstance, `GitHub API guard was not installed for ${extId}`);
  assert.deepEqual(
    guard.unexpectedUrls,
    [],
    `background unexpectedly requested guarded URLs: ${guard.unexpectedUrls.join(', ')}`,
  );
  if (runtimeTarget !== 'firefox') await closeBackgroundGitHubApiGuard();
}

async function closeBackgroundGitHubApiGuard() {
  const guard = backgroundGitHubApiGuard;
  if (!guard) return;
  if (guard.targetListener) guard.browser.off('targetcreated', guard.targetListener);
  await Promise.all([...guard.clients].map((client) => client.detach().catch(() => {})));
  await Promise.all([...guard.pageInterceptors].map(async ({ page, onRequest }) => {
    page.off('request', onRequest);
    if (!page.isClosed()) await page.setRequestInterception(false).catch(() => {});
  }));
  if (guard.firefoxControlPage && !guard.firefoxControlPage.isClosed()) {
    const diagnostics = await removeFirefoxBackgroundGuard(guard.firefoxControlPage).catch((error) => [{
      kind: 'teardown',
      message: formatError(error),
    }]);
    for (const diagnostic of diagnostics) {
      recordPageIssue('background-event-page', `${diagnostic.kind}: ${diagnostic.message}`);
    }
    if (typeof guard.firefoxControlPage.removeExposedFunction === 'function') {
      await guard.firefoxControlPage
        .removeExposedFunction(FIREFOX_BACKGROUND_FETCH_BRIDGE)
        .catch(() => {});
    }
  }
  backgroundGitHubApiGuard = null;
}

async function handleGuardedBackgroundRequest(guard, request) {
  if (await guard.handle?.(request)) return;
  guard.unexpectedUrls.push(request.url);
  await request.fail();
}

function createCdpGuardRequest(client, event) {
  return {
    url: event.request.url,
    method: event.request.method,
    headers: event.request.headers ?? {},
    async respond(status, body) {
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: status,
        responseHeaders: [
          { name: 'content-type', value: 'application/json; charset=utf-8' },
          { name: 'content-length', value: String(Buffer.byteLength(body)) },
        ],
        body: Buffer.from(body).toString('base64'),
      });
    },
    fail() {
      return client.send('Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: 'BlockedByClient',
      });
    },
  };
}

function createFirefoxGuardRequest(candidate, response) {
  const url = typeof candidate?.url === 'string' ? candidate.url : 'invalid-firefox-request';
  const method = typeof candidate?.method === 'string' ? candidate.method : 'GET';
  const headers = candidate?.headers && typeof candidate.headers === 'object'
    ? Object.fromEntries(Object.entries(candidate.headers).filter((entry) => (
        typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )))
    : {};
  const postData = typeof candidate?.postData === 'string' ? candidate.postData : '';
  const settle = (value) => {
    if (response.value !== null) throw new Error('Firefox background request was already handled.');
    response.value = value;
  };
  return {
    url,
    method,
    headers,
    postData,
    async respond(status, body, responseHeaders = { 'content-type': 'application/json; charset=utf-8' }) {
      const headersValid = responseHeaders
        && typeof responseHeaders === 'object'
        && !Array.isArray(responseHeaders)
        && Object.entries(responseHeaders).every(([name, value]) => (
          typeof name === 'string' && typeof value === 'string'
        ));
      if (
        !Number.isSafeInteger(status)
        || status < 100
        || status > 599
        || typeof body !== 'string'
        || !headersValid
      ) {
        throw new Error('Firefox background response fixture is invalid.');
      }
      settle({ action: 'respond', status, body, headers: responseHeaders });
    },
    async fail() {
      settle({ action: 'fail' });
    },
  };
}

async function installFirefoxBackgroundGuard(controlPage) {
  await controlPage.evaluate(async ({ bridgeName, stateName, guardedOrigins }) => {
    const background = await chrome.runtime.getBackgroundPage();
    if (!background || background[stateName]) {
      throw new Error('Firefox background guard state is unavailable or already installed.');
    }
    const bridge = globalThis[bridgeName];
    if (typeof bridge !== 'function') throw new Error('Firefox background guard bridge is unavailable.');
    const originalFetch = background.fetch;
    const diagnostics = [];
    const record = (kind, value) => {
      if (diagnostics.length >= 24) return;
      diagnostics.push({ kind, message: String(value ?? '').slice(0, 500) });
    };
    const onError = (event) => record('error', event.error?.message ?? event.message ?? 'unknown');
    const onUnhandledRejection = (event) => record(
      'unhandledrejection',
      event.reason instanceof Error ? event.reason.message : event.reason,
    );
    const guardedFetch = async (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL
        ? String(input)
        : input?.url;
      const url = new URL(rawUrl, background.location.href).href;
      if (!guardedOrigins.some((origin) => url.startsWith(origin))) {
        return Reflect.apply(originalFetch, background, [input, init]);
      }
      const rawHeaders = init?.headers ?? input?.headers;
      const headers = Object.fromEntries(new Headers(rawHeaders).entries());
      const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      const result = await bridge({
        url,
        method,
        headers,
        postData: typeof init?.body === 'string' ? init.body : '',
      });
      if (result?.action === 'respond') {
        return new background.Response(result.body, {
          status: result.status,
          headers: result.headers ?? { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      throw new background.TypeError('Failed to fetch');
    };
    background.addEventListener('error', onError);
    background.addEventListener('unhandledrejection', onUnhandledRejection);
    background.fetch = guardedFetch;
    background[stateName] = {
      diagnostics,
      guardedFetch,
      onError,
      onUnhandledRejection,
      originalFetch,
    };
  }, {
    bridgeName: FIREFOX_BACKGROUND_FETCH_BRIDGE,
    stateName: FIREFOX_BACKGROUND_GUARD_STATE,
    guardedOrigins: FIREFOX_GUARDED_ORIGINS,
  });
}

async function removeFirefoxBackgroundGuard(controlPage) {
  return controlPage.evaluate(async (stateName) => {
    const background = await chrome.runtime.getBackgroundPage();
    const state = background?.[stateName];
    if (!state) return [];
    if (background.fetch === state.guardedFetch) background.fetch = state.originalFetch;
    background.removeEventListener('error', state.onError);
    background.removeEventListener('unhandledrejection', state.onUnhandledRejection);
    delete background[stateName];
    return state.diagnostics;
  }, FIREFOX_BACKGROUND_GUARD_STATE);
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

function createFirefoxAgentProviderFixture(guard) {
  const providerUrl = 'https://api.openai.com/v1/responses';
  const captures = [];
  const previousHandle = guard.handle;
  let sequence = 0;

  const handle = async (request) => {
    if (request.url !== providerUrl) return previousHandle ? previousHandle(request) : false;
    if (request.method !== 'POST') throw new Error(`Unexpected Firefox Provider method: ${request.method}.`);
    const body = JSON.parse(request.postData || '{}');
    const input = Array.isArray(body.input) ? body.input : [];
    const priorToolNames = input
      .filter((entry) => entry?.type === 'function_call')
      .map((entry) => entry.name)
      .filter((name) => typeof name === 'string');
    const hasToolResult = input.some((entry) => entry?.type === 'function_call_output');
    const user = [...input].reverse().find((entry) => entry?.role === 'user');
    const userText = Array.isArray(user?.content)
      ? user.content
        .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
      : '';
    const toolName = body.tool_choice?.type === 'function' ? body.tool_choice.name : null;
    let kind;
    let completion;
    let batchStart = null;
    let batchEnd = null;

    if (toolName === 'bgsm_connection_probe') {
      kind = 'firefox-provider-probe';
      completion = {
        toolCall: {
          id: 'call-firefox-runtime-probe',
          name: toolName,
          arguments: JSON.stringify({ nonce: 'bgsm' }),
        },
      };
    } else if (hasToolResult && priorToolNames.includes('bgsm_connection_probe')) {
      kind = 'firefox-provider-probe-ack';
      completion = { content: 'Firefox runtime provider ready.' };
    } else if (toolName === 'submit_semantic_tag_batch_proposal') {
      const payload = JSON.parse(userText || '{}');
      const batch = payload.batch;
      if (!batch || !Array.isArray(batch.repositories) || batch.repositories.length === 0) {
        throw new Error('Firefox Organize Provider request did not contain a repository batch.');
      }
      const rows = batch.repositories.map((repository) => ({
        frozenIndex: repository.frozenIndex,
        repositoryId: repository.repositoryId,
        sourceFingerprint: repository.sourceFingerprint,
        classifications: [{
          kind: 'unchanged',
          evidence: 'Synthetic Firefox full-library runtime classification.',
        }],
      }));
      batchStart = rows[0].frozenIndex;
      batchEnd = rows.at(-1).frozenIndex + 1;
      kind = 'firefox-organize-batch';
      completion = {
        toolCall: {
          id: `call-firefox-organize-${sequence + 1}`,
          name: toolName,
          arguments: JSON.stringify({
            version: 1,
            runId: batch.runId,
            generation: batch.generation,
            scopeFingerprint: batch.scopeFingerprint,
            rows,
          }),
        },
      };
    } else if (toolName === null) {
      kind = 'firefox-cubby-turn';
      completion = { content: 'Firefox Cubby runtime turn complete.' };
    } else {
      throw new Error(`Unexpected Firefox Provider tool selection: ${String(toolName)}.`);
    }

    sequence += 1;
    captures.push(Object.freeze({
      ordinal: sequence,
      kind,
      authorizationPresent: Object.keys(request.headers)
        .some((name) => name.toLowerCase() === 'authorization'),
      batchStart,
      batchEnd,
    }));
    await request.respond(
      200,
      buildControlledResponsesSse(completion, sequence),
      { 'content-type': 'text/event-stream' },
    );
    return true;
  };

  guard.handle = handle;
  return Object.freeze({
    captures,
    restore() {
      if (guard.handle === handle) guard.handle = previousHandle;
    },
  });
}

async function clickTrustedDocumentButtonByText(page, label) {
  const handle = await page.evaluateHandle((expected) => [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === expected) ?? null, label);
  const button = handle.asElement();
  if (!button) {
    await handle.dispose();
    throw new Error(`Could not find trusted button labelled ${label}.`);
  }
  try {
    await button.click();
  } finally {
    await button.dispose();
  }
}

async function grantFirefoxAgentDataPermission(page) {
  await page.evaluate(async () => {
    const key = 'gsm_config';
    const current = (await chrome.storage.local.get(key))[key] ?? {};
    await chrome.storage.local.set({ [key]: { ...current, agentDataDisclosureAcceptance: null } });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  } catch (error) {
    if (!/Navigation timeout/iu.test(formatError(error))) throw error;
  }
  await page.waitForSelector('[data-testid="agent-data-disclosure"]', { timeout: 10_000 });
  await clickTrustedDocumentButtonByText(page, 'Accept data sharing');
  await page.waitForFunction(
    async () => {
      const key = 'gsm_config';
      const [granted, stored] = await Promise.all([
        chrome.permissions.contains({ data_collection: ['personalCommunications'] }),
        chrome.storage.local.get(key),
      ]);
      const acceptance = stored[key]?.agentDataDisclosureAcceptance;
      return granted
        && acceptance?.provider === 'openai'
        && acceptance?.origin === 'https://api.openai.com';
    },
    { polling: DOM_POLLING_MS, timeout: 20_000 },
  );
}

async function configureFirefoxSavedProvider(page) {
  const apiKey = 'runtime-firefox-provider-key';
  await page.$eval('#agent-api-key', (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, apiKey);
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === 'Save & test' && !button.disabled),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  await clickTrustedDocumentButtonByText(page, 'Save & test');
  await page.waitForFunction(
    async () => {
      const config = (await chrome.storage.local.get('gsm_config')).gsm_config;
      return typeof config?.agentProvider?.apiKeyEncrypted === 'string'
        && config.agentProvider.apiKeyEncrypted.length > 0
        && config.agentProvider.capability?.namedToolRoundTrip === true;
    },
    { polling: DOM_POLLING_MS, timeout: 30_000 },
  );
  const config = await page.evaluate(async () => (
    await chrome.storage.local.get('gsm_config')
  ).gsm_config);
  assert.equal(JSON.stringify(config).includes(apiKey), false, 'Firefox Provider key was stored in plaintext.');
  assert.equal(config.agentProvider.capability.contextCapability.source, 'builtin-official');
}

async function assertFirefoxCubbyTurn(page) {
  const responseMarker = 'Firefox Cubby runtime turn complete.';
  await page.bringToFront();
  await page.waitForFunction(
    () => !!document.getElementById('gsm-manager-host') || !!document.getElementById('gsm-fab'),
    { polling: DOM_POLLING_MS, timeout: 20_000 },
  );
  const hasManager = await page.evaluate(() => !!document.getElementById('gsm-manager-host'));
  if (!hasManager) await clickFab(page);
  await waitForManagerRoot(page);
  await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    root?.querySelector('#gsm-stars-surface-tab')?.click();
  });
  await page.waitForFunction(
    () => !!document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('[data-coach-target="agent"]'),
    { polling: DOM_POLLING_MS, timeout: 20_000 },
  );
  await clickShadowButton(page, '[data-coach-target="agent"]');
  await page.waitForFunction(
    () => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot;
      const textarea = root?.querySelector('aside[role="dialog"] textarea');
      return textarea instanceof HTMLTextAreaElement && !textarea.disabled;
    },
    { polling: DOM_POLLING_MS, timeout: 20_000 },
  );
  await page.evaluate((prompt) => {
    const textarea = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('aside[role="dialog"] textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Firefox Cubby composer is unavailable.');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, prompt);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'Reply with a short confirmation and do not use tools.');
  await page.waitForFunction(
    () => {
      const button = document.getElementById('gsm-manager-host')?.shadowRoot
        ?.querySelector('aside[role="dialog"] button[type="submit"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  await clickShadowButton(page, 'aside[role="dialog"] button[type="submit"]');
  await page.waitForFunction(
    (marker) => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot;
      const drawer = root?.querySelector('aside[role="dialog"]');
      const completed = [...(drawer?.querySelectorAll('[data-role="assistant"]') ?? [])]
        .some((message) => message.textContent?.includes(marker));
      return completed || !!root?.querySelector('[data-testid="agent-provider-error-card"]');
    },
    { polling: DOM_POLLING_MS, timeout: 45_000 },
    responseMarker,
  );
  const result = await page.evaluate((marker) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const drawer = root?.querySelector('aside[role="dialog"]');
    const assistantRows = [...(drawer?.querySelectorAll('[data-role="assistant"]') ?? [])];
    return {
      markerCount: assistantRows.filter((row) => row.textContent?.includes(marker)).length,
      providerError: !!root?.querySelector('[data-testid="agent-provider-error-card"]'),
      running: drawer?.getAttribute('data-agent-active') === 'true',
      userMessages: drawer?.querySelectorAll('[data-role="user"]').length ?? 0,
    };
  }, responseMarker);
  assert.deepEqual(result, {
    markerCount: 1,
    providerError: false,
    running: false,
    userMessages: 1,
  });
}

async function runFirefoxFullLibraryOrganize(page) {
  return page.evaluate(async (timeoutMs) => {
    const sessionResponse = await chrome.runtime.sendMessage({ type: 'createAgentSession' });
    const sessionId = sessionResponse?.data?.session?.id;
    if (!sessionResponse?.ok || typeof sessionId !== 'string') {
      throw new Error(`Firefox Organize could not create a session: ${JSON.stringify(sessionResponse)}.`);
    }
    const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
    const messages = [];
    const deliveries = [];
    port.onMessage.addListener((delivery) => {
      if (delivery?.type !== 'bgsmOrganizeJobRunDelivery' || !delivery.message) {
        messages.push({ type: 'invalid-firefox-organize-delivery' });
        return;
      }
      deliveries.push({
        connectionEpochId: delivery.connectionEpochId,
        deliverySequence: delivery.deliverySequence,
      });
      messages.push(delivery.message);
    });
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = [...messages].reverse().find(predicate);
        if (match) return match;
        const failure = [...messages].reverse().find((message) => (
          message.type === 'bgsmOrganizeJobRunError'
          || (message.type === 'bgsmOrganizeJobRunEvent' && message.event?.state === 'failed')
        ));
        if (failure) throw new Error(`Firefox Organize failed: ${JSON.stringify(failure)}.`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(messages.slice(-8))}.`);
    };
    const controllerId = `controller:v1:firefox-runtime-${crypto.randomUUID()}`;
    const requestId = `firefox-runtime-${crypto.randomUUID()}`;
    const taskInstruction = 'Organize the complete Firefox runtime library.';
    try {
      port.postMessage({
        type: 'requestBgsmOrganizeJobPreflight',
        controllerId,
        sessionId,
        requestId,
        taskInstruction,
      });
      const preflight = await waitFor(
        (message) => message.type === 'bgsmOrganizeJobRunPreflightResult' && message.requestId === requestId,
        'Firefox Organize preflight',
      );
      port.postMessage({
        type: 'startBgsmOrganizeJob',
        controllerId,
        sessionId,
        requestId,
        preflightToken: preflight.preflightToken,
        taskInstruction,
      });
      const started = await waitFor(
        (message) => message.type === 'bgsmOrganizeJobRunSnapshot',
        'Firefox Organize start',
      );
      const terminal = await waitFor(
        (message) => message.type === 'bgsmOrganizeJobRunEvent'
          && message.event?.type === 'run_terminal'
          && message.event?.state === 'completed',
        'Firefox Organize completion',
      );
      const snapshots = messages.filter((message) => message.type === 'bgsmOrganizeJobRunSnapshot');
      return {
        count: preflight.count,
        frozenCount: started.snapshot?.frozenScope?.count ?? null,
        terminalState: terminal.event.state,
        generationCount: new Set(snapshots.map((message) => message.snapshot?.generation)).size,
        deliveryCount: deliveries.length,
        orderedDeliveries: deliveries.every((delivery, index) => delivery.deliverySequence === index),
        invalidDeliveries: messages.filter((message) => message.type === 'invalid-firefox-organize-delivery').length,
      };
    } finally {
      port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
      port.disconnect();
    }
  }, 120_000);
}

function assertFirefoxProviderCoverage(captures, organize, captureStart) {
  const newCaptures = captures.slice(captureStart);
  const ordinary = newCaptures.filter((entry) => entry.kind === 'firefox-cubby-turn');
  const batches = newCaptures.filter((entry) => entry.kind === 'firefox-organize-batch');
  assert.equal(ordinary.length, 1);
  assert.equal(organize.count >= 200, true, 'Firefox full-library Organize fixture was not library-sized.');
  assert.equal(organize.frozenCount, organize.count);
  assert.equal(organize.terminalState, 'completed');
  assert.equal(organize.generationCount > 0, true);
  assert.equal(organize.deliveryCount > 0, true);
  assert.equal(organize.orderedDeliveries, true);
  assert.equal(organize.invalidDeliveries, 0);
  assert.equal(batches.length, Math.ceil(organize.count / 25));
  let nextFrozenIndex = 0;
  for (const batch of batches) {
    assert.equal(batch.batchStart, nextFrozenIndex);
    assert.equal(batch.batchEnd > batch.batchStart, true);
    nextFrozenIndex = batch.batchEnd;
  }
  assert.equal(nextFrozenIndex, organize.count);
  assert.equal(newCaptures.every((entry) => entry.authorizationPresent), true);
}

async function assertFirefoxRuntimeParity(page, extId, starsPage) {
  assert.equal(extId, FIREFOX_GECKO_ID);
  assert.equal(activeExtensionRuntime?.backgroundKind, 'event_page');
  const expectedOrigin = `${extensionOrigin(extId, 'firefox')}/`;
  const expectedBackgroundUrl = `${expectedOrigin}_generated_background_page.html`;
  const actualPageUrl = await page.evaluate(() => location.href);
  assert.equal(
    actualPageUrl.startsWith(expectedOrigin),
    true,
    'Firefox extension page did not use the fixed moz-extension UUID.',
  );
  const guard = backgroundGitHubApiGuard;
  assert.ok(guard?.firefoxControlPage, 'Firefox background network guard was unavailable.');
  const guardedRequestCount = guard.unexpectedUrls.length;

  const permissionState = await page.evaluate(async () => {
    const backgroundPage = await chrome.runtime.getBackgroundPage();
    return {
      personalCommunications: await chrome.permissions.contains({
        data_collection: ['personalCommunications'],
      }),
      runtimeId: chrome.runtime.id,
      backgroundUrl: backgroundPage?.location.href ?? null,
    };
  });
  assert.deepEqual(permissionState, {
    personalCommunications: false,
    runtimeId: FIREFOX_GECKO_ID,
    backgroundUrl: expectedBackgroundUrl,
  });

  const probe = await page.evaluate(async () => {
    const key = 'gsm_config';
    const current = (await chrome.storage.local.get(key))[key] ?? {};
    await chrome.storage.local.set({
      [key]: {
        ...current,
        agentDataDisclosureAcceptance: {
          version: 2,
          provider: 'openai',
          origin: 'https://api.openai.com',
          acceptedAt: 1,
        },
      },
    });
    const provider = await chrome.runtime.sendMessage({
      type: 'testAgentProviderConnection',
      provider: 'openai',
      protocol: null,
      baseUrl: null,
      model: 'gpt-5.4',
      declaredContextWindow: null,
      workingContextWindow: null,
      apiKey: 'runtime-no-network-key',
    });
    const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
    return {
      providerOk: provider?.ok === true,
      providerCode: provider?.code ?? null,
      providerError: provider?.ok === false && typeof provider.error === 'string',
      statusOk: status?.ok === true,
    };
  });
  assert.deepEqual(probe, {
    providerOk: false,
    providerCode: 'AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED',
    providerError: true,
    statusOk: true,
  });
  assert.equal(
    guard.unexpectedUrls.length,
    guardedRequestCount,
    'Cubby permission refusal reached the Provider network.',
  );

  const provider = createFirefoxAgentProviderFixture(guard);
  try {
    const permissionPage = await openExtensionPage(extId, OPTIONS_PATH, 'options-agent-permission');
    try {
      await grantFirefoxAgentDataPermission(permissionPage);
      await configureFirefoxSavedProvider(permissionPage);
    } finally {
      await permissionPage.close().catch(() => {});
    }
    const captureStart = provider.captures.length;
    await assertFirefoxCubbyTurn(starsPage);
    const organize = await runFirefoxFullLibraryOrganize(page);
    assertFirefoxProviderCoverage(provider.captures, organize, captureStart);
    assert.equal(
      guard.unexpectedUrls.length,
      guardedRequestCount,
      'Firefox Cubby or Organize escaped the controlled Provider fixture.',
    );
  } finally {
    provider.restore();
  }

  const portResult = await page.evaluate(() => new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'bgsm-agent' });
    let connected = true;
    const timeout = setTimeout(() => {
      port.disconnect();
      resolve({ connected, disconnectedCleanly: true });
    }, 100);
    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
      connected = connected && chrome.runtime.lastError === undefined;
      resolve({ connected, disconnectedCleanly: true });
    });
  }));
  assert.deepEqual(portResult, { connected: true, disconnectedCleanly: true });

  const issueCountBeforeTeardown = pageIssues.length;
  await closeBackgroundGitHubApiGuard();
  assert.equal(
    pageIssues.length,
    issueCountBeforeTeardown,
    'Firefox background emitted an uncaught error before event-page teardown.',
  );
  await page.evaluate(async () => {
    const backgroundPage = await chrome.runtime.getBackgroundPage();
    backgroundPage.close();
  });
  await page.waitForFunction(
    async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
        return response?.ok === true;
      } catch {
        return false;
      }
    },
    { polling: DOM_POLLING_MS, timeout: 20_000 },
  );
  backgroundStartupHealthChecks += 1;
  const recovered = await page.evaluate(async () => {
    const backgroundPage = await chrome.runtime.getBackgroundPage();
    const issues = [];
    const onError = (event) => issues.push(`error:${event.error?.message ?? event.message ?? 'unknown'}`);
    const onUnhandledRejection = (event) => issues.push(
      `unhandledrejection:${event.reason instanceof Error ? event.reason.message : String(event.reason)}`,
    );
    backgroundPage.addEventListener('error', onError);
    backgroundPage.addEventListener('unhandledrejection', onUnhandledRejection);
    const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    backgroundPage.removeEventListener('error', onError);
    backgroundPage.removeEventListener('unhandledrejection', onUnhandledRejection);
    return {
      backgroundUrl: backgroundPage.location.href,
      statusOk: status?.ok === true,
      issues,
    };
  });
  assert.deepEqual(recovered, {
    backgroundUrl: expectedBackgroundUrl,
    statusOk: true,
    issues: [],
  });
}
function settleInterceptAction(action) {
  void Promise.resolve(action).catch((error) => {
    const message = formatError(error);
    if (/no such request|request is already handled|Invalid InterceptionId/iu.test(message)) return;
    recordPageIssue('request-interception', message);
  });
}

async function interceptGitHubApi(page, handler) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('https://api.github.com/')) {
      settleInterceptAction(request.continue());
      return;
    }
    settleInterceptAction(handler(request));
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


async function assertWatchOptionsIntent(page) {
  if (runtimeTarget !== 'firefox') await page.bringToFront();
  await page.waitForFunction(
    () => document.activeElement?.id === 'github-connection-heading',
    { polling: DOM_POLLING_MS, timeout: 20_000 },
  );
  const state = await page.evaluate(() => ({
    focusedHeading: document.activeElement?.id === 'github-connection-heading',
    mainTokenInputPresent: !!document.querySelector('textarea[placeholder="github_pat_..."]'),
    redundantWatchSectionPresent: !!document.querySelector('[data-testid="watch-inbox-settings"]'),
  }));
  assert.deepEqual(state, {
    focusedHeading: true,
    mainTokenInputPresent: true,
    redundantWatchSectionPresent: false,
  });
}

async function assertGitHubOptionsIntent(page) {
  if (runtimeTarget !== 'firefox') await page.bringToFront();
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


async function readWatchCredentialState(page) {
  return page.evaluate(async () => {
    const [stored, response] = await Promise.all([
      chrome.storage.local.get('gsm_github_credentials'),
      chrome.runtime.sendMessage({ type: 'getWatchStatus' }),
    ]);
    return {
      watchNotificationsEnabled:
        stored.gsm_github_credentials?.watchNotificationsEnabled === true,
      hasNotificationsToken: response?.data?.hasNotificationsToken === true,
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
    acceptanceButtonVisible: [...document.querySelectorAll('button')]
      .some((candidate) => candidate.textContent?.trim() === 'Accept data sharing'),
  }));
  assert.deepEqual(initial, {
    categoryCount: 4,
    collapsed: true,
    originVisible: true,
    acceptanceButtonVisible: true,
  });

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
  assert.equal(disabledWithoutAcceptance, true);

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
      settleInterceptAction(request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: starsPageHtml(),
      }));
      return;
    }
    if (url === REPO_URL) {
      settleInterceptAction(request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: repoPageHtml(),
      }));
      return;
    }
    if (url === 'https://github.com/candidate.png?size=64') {
      settleInterceptAction(request.respond({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#24292f"/></svg>',
      }));
      return;
    }
    if (url === 'https://avatars.githubusercontent.com/u/1?v=4') {
      settleInterceptAction(request.respond({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#0969da"/></svg>',
      }));
      return;
    }
    if (url === 'https://avatars.githubusercontent.com/u/broken?v=4') {
      settleInterceptAction(request.respond({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#cf222e"/></svg>',
      }));
      return;
    }
    if (url.startsWith('https://github.com/')) {
      settleInterceptAction(request.respond({ status: 204, body: '' }));
      return;
    }
    settleInterceptAction(request.continue());
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
        const bodyText = document.body?.innerText ?? '';
        const hasNoTokenText = bodyText.includes('应用需要 GitHub Classic PAT 鉴权。');
        const hasConnectButton = [...document.querySelectorAll('button')]
          .some((node) => (node.textContent || '').trim() === '添加 Classic PAT');
        return hasNoTokenText && hasConnectButton;
      },
      { polling: DOM_POLLING_MS, timeout },
    );
  } catch (error) {
    throw await pageWaitError(page, 'popup did not render the default Chinese no-token state', error);
  }
}
async function assertOptionsDefaultChineseAndUseEnglish(page) {
  try {
    await page.waitForFunction(
      () => {
        const buttons = [...document.querySelectorAll('button')];
        const chinese = buttons.find((node) => (node.textContent || '').trim() === '中文');
        return chinese?.getAttribute('aria-pressed') === 'true'
          && (document.body?.innerText ?? '').includes('4. 偏好设置');
      },
      { polling: DOM_POLLING_MS, timeout: 10_000 },
    );
  } catch (error) {
    throw await pageWaitError(page, 'Options did not render with Chinese selected by default', error);
  }

  await clickButtonByText(page, /^EN$/);
  try {
    await page.waitForFunction(
      () => {
        const buttons = [...document.querySelectorAll('button')];
        const english = buttons.find((node) => (node.textContent || '').trim() === 'EN');
        return english?.getAttribute('aria-pressed') === 'true'
          && (document.body?.innerText ?? '').includes('4. Preferences');
      },
      { polling: DOM_POLLING_MS, timeout: 10_000 },
    );
  } catch (error) {
    throw await pageWaitError(page, 'Options did not persist the English smoke-test override', error);
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

async function assertManagerSurfaceBadges(page, expected) {
  try {
    await page.waitForFunction(
      (counts) => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
        return root?.querySelector('#gsm-stars-surface-tab')?.getAttribute('aria-selected') === 'true'
          && root.querySelector('[data-watch-unread-badge]')?.textContent?.trim() === counts.watch
          && root.querySelector('[data-radar-unseen-badge]')?.textContent?.trim() === counts.radar;
      },
      { polling: DOM_POLLING_MS, timeout: 10_000 },
      expected,
    );
  } catch (error) {
    const state = await page.evaluate(() => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      return {
        active: root?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
        watch: root?.querySelector('[data-watch-unread-badge]')?.textContent?.trim() ?? null,
        radar: root?.querySelector('[data-radar-unseen-badge]')?.textContent?.trim() ?? null,
      };
    });
    throw await pageWaitError(page, `surface badges did not render before entry: ${JSON.stringify(state)}`, error);
  }
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

async function assertStoreRatingPromptAbsent(page, reason, settleMs = 350) {
  await delay(settleMs);
  const present = await page.evaluate(() => {
    const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
    return !!shadow?.querySelector('[role="dialog"][aria-labelledby="gsm-store-rating-title"]');
  });
  assert.equal(present, false, `rating prompt opened during ${reason}`);
}

async function shadowElementHandle(page, selector, label) {
  const handle = await page.evaluateHandle((targetSelector) => (
    document.getElementById('gsm-manager-host')?.shadowRoot?.querySelector(targetSelector) ?? null
  ), selector);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new Error(`${label} was unavailable`);
  }
  return element;
}


async function assertStoreRatingSuppressedDuringOnboarding(page) {
  await page.bringToFront();
  const deadline = Date.now() + 10_000;
  let config = null;
  while (Date.now() < deadline) {
    config = await readStoredConfig(page.browser());
    if (config?.onboardingStage === 'coach' && config.seenOnboarding === false) break;
    await delay(DOM_POLLING_MS);
  }
  assert.equal(config?.onboardingStage, 'coach', 'onboarding fixture did not reach the coach stage');
  assert.equal(config?.seenOnboarding, false, 'onboarding fixture was already marked complete');
  await page.waitForFunction(
    () => !!document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('.gsm-favorite-action:not([disabled])'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const favoriteBefore = await page.evaluate(() => (
    document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('.gsm-favorite-action:not([disabled])')?.getAttribute('data-active') ?? null
  ));
  assert.notEqual(favoriteBefore, null, 'favorite action during onboarding was unavailable');
  const favoriteClicked = await page.evaluate(() => {
    const button = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('.gsm-favorite-action:not([disabled])');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  assert.equal(favoriteClicked, true, 'favorite action during onboarding could not be triggered');
  await page.waitForFunction(
    (before) => {
      const button = document.getElementById('gsm-manager-host')?.shadowRoot
        ?.querySelector('.gsm-favorite-action:not([disabled])');
      return !!button && button.isConnected
        && button.getAttribute('data-active') !== before;
    },
    { polling: DOM_POLLING_MS, timeout: 5_000 },
    favoriteBefore,
  );
  const prompt = (await readStoredConfig(page.browser()))?.storeRatingPrompt ?? null;
  assert.equal(prompt?.meaningfulActionCount, 2, 'onboarding favorite incorrectly qualified the rating prompt');
  await assertStoreRatingPromptAbsent(page, 'onboarding');
}

async function finishStoreRatingOnboarding(page) {
  await page.waitForFunction(
    () => [...(document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelectorAll('button') ?? [])]
      .some((button) => button.textContent?.trim() === 'Skip tour'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const skipped = await page.evaluate(() => {
    const button = [...(document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === 'Skip tour');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  assert.equal(skipped, true, 'onboarding Skip tour action could not be triggered');
  const deadline = Date.now() + 10_000;
  let config = null;
  while (Date.now() < deadline) {
    config = await readStoredConfig(page.browser());
    if (config?.onboardingStage === 'done' && config.seenOnboarding === true) break;
    await delay(DOM_POLLING_MS);
  }
  assert.equal(config?.onboardingStage, 'done', 'Skip tour did not persist completed onboarding');
  assert.equal(config?.seenOnboarding, true, 'Skip tour did not persist the onboarding completion marker');
  await page.waitForFunction(
    () => !document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('[data-coach-step-target]'),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
}



async function assertStoreRatingSuppressedByVisibleError(page, syncFixture) {
  const syncButton = await shadowElementHandle(
    page,
    'button[data-coach-target="sync"]:not([disabled])',
    'incremental Sync action',
  );
  await syncButton.click();
  await syncButton.dispose();
  const request = await syncFixture.waitForRequest();
  await page.waitForFunction(
    () => document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('button[data-coach-target="sync"]')?.hasAttribute('disabled') === true,
    { polling: DOM_POLLING_MS, timeout: 5_000 },
  );
  await assertStoreRatingPromptAbsent(page, 'active sync before recovery');
  await request.failInvalidResponse();
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
        const recovery = [...(shadow?.querySelectorAll('.gsm-helper-text') ?? [])]
          .find((node) => node.querySelector('button[aria-label="Close"]'));
        return !!recovery && !!recovery.textContent?.trim();
      },
      { polling: DOM_POLLING_MS, timeout: 10_000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => {
      const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
      const root = shadow?.getElementById('gsm-manager-root');
      return {
        text: root?.textContent?.slice(-500) ?? null,
        helpers: [...(shadow?.querySelectorAll('.gsm-helper-text') ?? [])]
          .map((node) => node.textContent?.trim() ?? ''),
        syncDisabled: root?.querySelector('button[data-coach-target="sync"]')?.hasAttribute('disabled') ?? null,
      };
    });
    throw new Error(`visible sync recovery did not render: ${JSON.stringify(state)}`, { cause: error });
  }
  const recoveryText = await page.evaluate(() => {
    const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
    return [...(shadow?.querySelectorAll('.gsm-helper-text') ?? [])]
      .find((node) => node.querySelector('button[aria-label="Close"]'))
      ?.textContent?.trim() ?? '';
  });
  assert.match(recoveryText, /GitHub|400/u, 'visible recovery did not describe the failed sync');
  await assertStoreRatingPromptAbsent(page, 'visible sync error before a qualifying action');
  const promptAfterFailure = (await readStoredConfig(page.browser()))?.storeRatingPrompt ?? null;
  assert.equal(promptAfterFailure?.meaningfulActionCount, 2, 'failed sync incorrectly qualified the rating prompt');
}

async function waitForStoreRatingPrompt(page, extId) {
  try {
    await page.waitForFunction(
      () => !!document.getElementById('gsm-manager-host')?.shadowRoot
        ?.querySelector('[role="dialog"][aria-labelledby="gsm-store-rating-title"]'),
      { polling: DOM_POLLING_MS, timeout: 10_000 },
    );
  } catch (error) {
    const manager = await page.evaluate(() => {
      const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
      const root = shadow?.getElementById('gsm-manager-root');
      return {
        activeTab: root?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
        favoriteActive: root?.querySelector('.gsm-favorite-action')?.getAttribute('data-active') ?? null,
        promptPresent: !!shadow?.querySelector('[role="dialog"][aria-labelledby="gsm-store-rating-title"]'),
      };
    });
    const diagnosticPage = await openExtensionPage(extId, OPTIONS_PATH, 'store-rating-diagnostic');
    const durable = await diagnosticPage.evaluate(async () => {
      const config = (await chrome.storage.local.get('gsm_config')).gsm_config ?? null;
      const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
      const status = response?.data ?? response ?? null;
      return {
        status: status ? {
          hasToken: status.hasToken ?? null,
          onboardingStage: status.onboardingStage ?? null,
          progressPhase: status.progress?.phase ?? null,
          inFlight: status.inFlight ?? null,
          activeBackfillId: status.activeBackfillId ?? null,
          organizeJobActive: status.organizeJobActive ?? null,
        } : null,
        configOnboardingStage: config?.onboardingStage ?? null,
        prompt: config?.storeRatingPrompt ? {
          status: config.storeRatingPrompt.status ?? null,
          activeDays: config.storeRatingPrompt.activeLocalDays?.length ?? null,
          meaningfulActions: config.storeRatingPrompt.meaningfulActionCount ?? null,
          exposures: config.storeRatingPrompt.exposureCount ?? null,
        } : null,
      };
    });
    await diagnosticPage.close();
    throw new Error(`rating prompt did not open: ${JSON.stringify({ manager, durable })}`, { cause: error });
  }
}

async function storeRatingFocusedControl(page) {
  return page.evaluate(() => {
    const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
    const active = shadow?.activeElement;
    if (active instanceof HTMLAnchorElement) return 'rate';
    if (!(active instanceof HTMLButtonElement)) return null;
    if (active.getAttribute('aria-label') === 'Close') return 'close';
    if (active.textContent?.trim() === 'Never remind me') return 'never';
    if (active.textContent?.trim() === 'Later') return 'later';
    return null;
  });
}

async function waitForStoredStoreRatingSnooze(browserInstance, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let prompt = null;
  while (Date.now() < deadline) {
    prompt = (await readStoredConfig(browserInstance))?.storeRatingPrompt ?? null;
    if (prompt?.status === 'snoozed' && prompt.exposureCount === 1 && prompt.snoozeUntil) return prompt;
    await delay(DOM_POLLING_MS);
  }
  throw new Error(`Escape did not persist Later snooze state: ${JSON.stringify(prompt)}`);
}

async function waitForStoredStoreRatingActionCount(browserInstance, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let prompt = null;
  while (Date.now() < deadline) {
    prompt = (await readStoredConfig(browserInstance))?.storeRatingPrompt ?? null;
    if (prompt?.meaningfulActionCount === expected) return prompt;
    await delay(DOM_POLLING_MS);
  }
  throw new Error(`favorite did not persist rating action count ${expected}: ${JSON.stringify(prompt)}`);
}


async function assertStoreRatingPrompt(page, extId, syncFixture) {
  await page.bringToFront();
  await assertStoreRatingPromptAbsent(page, 'visible recovery before the qualifying favorite');
  const detailOpened = await page.evaluate(() => {
    const row = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('[data-layout-row-grid]');
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  });
  assert.equal(detailOpened, true, 'repository detail could not block the prompt during qualification');
  await page.waitForFunction(
    () => !!document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('.drawer-anim.drawer-enter'),
    { polling: DOM_POLLING_MS, timeout: 5_000 },
  );

  const favoriteBefore = await page.evaluate(() => (
    document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('.gsm-favorite-action:not([disabled])')?.getAttribute('data-active') ?? null
  ));
  assert.notEqual(favoriteBefore, null, 'favorite action that qualifies the prompt was unavailable');
  const favoriteClicked = await page.evaluate(() => {
    const button = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('.gsm-favorite-action:not([disabled])');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  assert.equal(favoriteClicked, true, 'favorite action could not qualify the prompt');
  await page.waitForFunction(
    (before) => document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('.gsm-favorite-action:not([disabled])')?.getAttribute('data-active') !== before,
    { polling: DOM_POLLING_MS, timeout: 5_000 },
    favoriteBefore,
  );
  await waitForStoredStoreRatingActionCount(page.browser(), 3);
  await assertStoreRatingPromptAbsent(page, 'open repository detail after the qualifying favorite');

  const recoveryRequestPending = syncFixture.waitForRequest();
  const recoverySyncClicked = await page.evaluate(() => {
    const button = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('button[data-coach-target="sync"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });
  assert.equal(recoverySyncClicked, true, 'sync action could not restore a visible recovery state');
  const recoveryRequest = await recoveryRequestPending;
  await recoveryRequest.failInvalidResponse();
  await page.waitForFunction(
    () => [...(document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelectorAll('.gsm-helper-text') ?? [])]
      .some((node) => node.querySelector('button[aria-label="Close"]')),
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  const detailClosed = await page.evaluate(() => {
    const button = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('.drawer-anim.drawer-enter button[title="Close (Esc)"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  assert.equal(detailClosed, true, 'repository detail could not release the eligible prompt');
  await page.waitForFunction(
    () => !document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('.drawer-anim.drawer-enter'),
    { polling: DOM_POLLING_MS, timeout: 5_000 },
  );
  await assertStoreRatingPromptAbsent(page, 'visible sync error after the qualifying favorite');

  const backgroundWorkPage = await openExtensionPage(extId, OPTIONS_PATH, 'store-rating-active-work');
  await backgroundWorkPage.evaluate(() => {
    void chrome.runtime.sendMessage({ type: 'syncIncremental' }).catch(() => {});
  });
  const blockedRequest = await syncFixture.waitForRequest();
  await backgroundWorkPage.waitForFunction(
    async () => {
      const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
      return response?.ok
        && response.data?.inFlight === true
        && response.data?.progress?.phase === 'incremental';
    },
    { polling: DOM_POLLING_MS, timeout: 5_000 },
  );

  await page.bringToFront();
  const closeRecovery = await shadowElementHandle(
    page,
    '.gsm-helper-text button[aria-label="Close"]',
    'sync error recovery close action',
  );
  await closeRecovery.evaluate((button) => button.click());
  await closeRecovery.dispose();
  await page.waitForFunction(
    () => ![...(document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelectorAll('.gsm-helper-text') ?? [])]
      .some((node) => node.querySelector('button[aria-label="Close"]')),
    { polling: DOM_POLLING_MS, timeout: 5_000 },
  );
  const favorite = await shadowElementHandle(
    page,
    '.gsm-favorite-action:not([disabled])',
    'favorite action that qualified the prompt',
  );
  await favorite.focus();
  await backgroundWorkPage.waitForFunction(
    async () => {
      const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
      return response?.ok && response.data?.inFlight === true;
    },
    { polling: DOM_POLLING_MS, timeout: 5_000 },
  );
  await assertStoreRatingPromptAbsent(page, 'authoritative background work after the qualifying favorite');

  await blockedRequest.failInvalidResponse();
  await backgroundWorkPage.waitForFunction(
    async () => {
      const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
      return response?.ok
        && response.data?.inFlight === false
        && response.data?.progress?.phase === 'idle';
    },
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
  await backgroundWorkPage.close();
  await waitForStoreRatingPrompt(page, extId);

  const rendered = await page.evaluate(() => {
    const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
    const dialog = shadow?.querySelector('[role="dialog"][aria-labelledby="gsm-store-rating-title"]');
    const link = dialog?.querySelector('a[href]');
    const image = dialog?.querySelector('picture img');
    const source = dialog?.querySelector('picture source');
    const rect = dialog?.getBoundingClientRect();
    return {
      ariaModal: dialog?.getAttribute('aria-modal') ?? null,
      title: shadow?.getElementById('gsm-store-rating-title')?.textContent?.trim() ?? null,
      heartCount: dialog?.querySelectorAll('[data-heart-index]').length ?? 0,
      storeLinkCount: dialog?.querySelectorAll('a').length ?? 0,
      href: link instanceof HTMLAnchorElement ? link.href : null,
      focused: shadow?.activeElement === link,
      gifSource: image?.getAttribute('src') ?? null,
      reducedMotionSource: source?.getAttribute('srcset') ?? null,
      rightGap: rect ? innerWidth - rect.right : null,
      bottomGap: rect ? innerHeight - rect.bottom : null,
      insideViewport: !!rect && rect.left >= 0 && rect.top >= 0
        && rect.right <= innerWidth && rect.bottom <= innerHeight,
    };
  });
  assert.deepEqual(rendered, {
    ariaModal: 'true',
    title: 'Enjoying Better GitHub Stars Manager?',
    heartCount: 5,
    storeLinkCount: 1,
    href: 'https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa/reviews',
    focused: true,
    gifSource: rendered.gifSource,
    reducedMotionSource: rendered.reducedMotionSource,
    rightGap: rendered.rightGap,
    bottomGap: rendered.bottomGap,
    insideViewport: true,
  });
  assert.match(rendered.gifSource ?? '', /index-agent-working.*\.gif/u);
  assert.match(rendered.reducedMotionSource ?? '', /(?:index-agent-static.*\.png|^data:image\/png)/u);
  assert.equal(typeof rendered.rightGap === 'number' && rendered.rightGap >= 8 && rendered.rightGap <= 32, true);
  assert.equal(typeof rendered.bottomGap === 'number' && rendered.bottomGap >= 8 && rendered.bottomGap <= 32, true);

  const thirdHeart = await page.evaluate(() => {
    const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
    const heart = shadow?.querySelector('[data-heart-index="3"]');
    const rect = heart?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  });
  assert.ok(thirdHeart, 'third rating heart was not measurable');
  await page.mouse.move(thirdHeart.x, thirdHeart.y);
  await page.waitForFunction(() => {
    const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
    const hearts = [...(shadow?.querySelectorAll('[data-heart-index]') ?? [])];
    return hearts.filter((heart) => heart.getAttribute('data-active') === 'true').length === 3;
  }, { polling: DOM_POLLING_MS, timeout: 5_000 });

  const fifthHeart = await page.evaluate(() => {
    const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
    const heart = shadow?.querySelector('[data-heart-index="5"]');
    const rect = heart?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  });
  assert.ok(fifthHeart, 'fifth rating heart was not measurable');
  await page.mouse.move(fifthHeart.x, fifthHeart.y);
  await page.waitForFunction(() => {
    const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
    const hearts = [...(shadow?.querySelectorAll('[data-heart-index]') ?? [])];
    return hearts.every((heart) => heart.getAttribute('data-active') === 'true');
  }, { polling: DOM_POLLING_MS, timeout: 5_000 });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  if (process.env.GSM_STORE_RATING_SCREENSHOT) {
    await page.screenshot({ path: path.resolve(process.env.GSM_STORE_RATING_SCREENSHOT) });
  }

  assert.equal(await storeRatingFocusedControl(page), 'rate', 'real focus did not enter the rating dialog');
  await page.keyboard.press('Tab');
  assert.equal(await storeRatingFocusedControl(page), 'never', 'Tab left the rating dialog after its store link');
  await page.keyboard.press('Tab');
  assert.equal(await storeRatingFocusedControl(page), 'later', 'Tab left the rating dialog before Later');
  await page.keyboard.press('Tab');
  assert.equal(await storeRatingFocusedControl(page), 'close', 'Tab did not wrap from Later to the dialog close action');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  assert.equal(await storeRatingFocusedControl(page), 'later', 'Shift+Tab did not wrap from the dialog close action to Later');
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('[role="dialog"][aria-labelledby="gsm-store-rating-title"]'),
    { polling: DOM_POLLING_MS, timeout: 5_000 },
  );
  const focusRestored = await page.evaluate((favoriteButton) => {
    const shadow = document.getElementById('gsm-manager-host')?.shadowRoot;
    return favoriteButton.isConnected && shadow?.activeElement === favoriteButton;
  }, favorite);
  assert.equal(focusRestored, true, 'Escape did not return focus to the favorite control that initiated the prompt');
  await favorite.dispose();

  const snoozed = await waitForStoredStoreRatingSnooze(page.browser());
  assert.equal(snoozed.meaningfulActionCount, 3);
  assert.equal(Date.parse(snoozed.snoozeUntil) > Date.now(), true, 'Escape did not persist a future Later snooze');
}

async function assertStoreRatingOptions(extId) {
  const page = await openExtensionPage(extId, OPTIONS_PATH, 'store-rating-options');
  try {
    await page.waitForSelector('[data-testid="store-rating-settings"]', { timeout: 10_000 });
    await page.waitForFunction(() => {
      const settings = document.querySelector('[data-testid="store-rating-settings"]');
      return settings?.querySelector('a') instanceof HTMLAnchorElement
        && settings.querySelector('#store-rating-reminder') === null;
    }, { polling: DOM_POLLING_MS, timeout: 10_000 });
    const initial = await page.evaluate(async () => {
      const settings = document.querySelector('[data-testid="store-rating-settings"]');
      const link = settings?.querySelector('a');
      const stored = await chrome.storage.local.get('gsm_config');
      const prompt = stored.gsm_config?.storeRatingPrompt ?? null;
      return {
        href: link instanceof HTMLAnchorElement ? link.href : null,
        status: prompt?.status ?? null,
        exposureCount: prompt?.exposureCount ?? null,
        hasRatingValue: !!prompt && Object.hasOwn(prompt, 'rating'),
      };
    });
    assert.deepEqual(initial, {
      href: 'https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa/reviews',
      status: 'snoozed',
      exposureCount: 1,
      hasRatingValue: false,
    });

    await page.evaluate(() => {
      const settings = document.querySelector('[data-testid="store-rating-settings"]');
      const link = settings?.querySelector('a');
      if (link instanceof HTMLAnchorElement) {
        link.addEventListener('click', (event) => event.preventDefault());
        link.click();
      }
    });
    await page.waitForFunction(async () => {
      const prompt = (await chrome.storage.local.get('gsm_config')).gsm_config?.storeRatingPrompt;
      return prompt?.status === 'store_opened';
    }, { polling: DOM_POLLING_MS, timeout: 5_000 });
    const opened = await page.evaluate(async () => {
      const prompt = (await chrome.storage.local.get('gsm_config')).gsm_config?.storeRatingPrompt;
      return { status: prompt?.status ?? null, exposureCount: prompt?.exposureCount ?? null };
    });
    assert.deepEqual(opened, { status: 'store_opened', exposureCount: 1 });
  } finally {
    await page.close();
  }
}
async function assertRepositoryAvatarLayout(page) {
  const errorDispatched = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const broken = root?.querySelector('[data-repository-avatar][src*="/broken"]');
    if (!(broken instanceof HTMLImageElement)) return false;
    broken.dispatchEvent(new Event('error'));
    return true;
  });
  assert.equal(errorDispatched, true, 'Broken avatar fixture was unavailable');
  await page.waitForFunction(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const fallbackInitials = [...(root?.querySelectorAll('[data-repository-avatar-fallback]') ?? [])]
      .map((fallback) => fallback.textContent?.trim());
    const broken = root?.querySelector('[data-repository-avatar][src*="/broken"]');
    return (root?.querySelectorAll('[data-repository-avatar-slot]').length ?? 0) >= 3
      && fallbackInitials.includes('B')
      && fallbackInitials.includes('M')
      && broken instanceof HTMLImageElement
      && broken.hidden;
  }, { polling: DOM_POLLING_MS, timeout: 10_000 });

  const defaultAvatarState = await readRepositoryAvatarState(page);
  assert.equal(defaultAvatarState.slots > 0, true);
  assert.equal(defaultAvatarState.fallbacks, defaultAvatarState.slots);
  assert.equal(defaultAvatarState.initials.includes('B'), true);
  assert.equal(defaultAvatarState.initials.includes('M'), true);
  assert.equal(defaultAvatarState.colors.length > 1, true);
  assert.equal(defaultAvatarState.computedBackgrounds.length > 1, true);
  assert.equal(defaultAvatarState.brokenHidden, true);
  assert.equal(defaultAvatarState.loading, 'lazy');
  assert.equal(defaultAvatarState.decoding, 'async');

  const deepAvatarState = await scrollStarsToBottomAndReadAvatarState(page);
  assert.equal(deepAvatarState.scrollTop > 0, true);
  assert.equal(deepAvatarState.slots > 0, true);
  assert.equal(deepAvatarState.fallbacks, deepAvatarState.slots);
  assert.equal(deepAvatarState.images, deepAvatarState.slots);
  assert.equal(deepAvatarState.loading, 'lazy');
  assert.equal(deepAvatarState.decoding, 'async');
  assert.equal(deepAvatarState.deepRowVisible, true);

  const editClicked = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const button = root?.querySelector('[data-layout-edit-trigger]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  assert.equal(editClicked, true, 'Edit custom layout button was unavailable');

  await page.waitForFunction(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    return root?.querySelector('.gsm-edit-chrome-wrap')?.getAttribute('aria-hidden') === 'false';
  }, { polling: DOM_POLLING_MS, timeout: 10_000 });

  await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const columns = [...(root?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Columns');
    if (!(columns instanceof HTMLButtonElement)) throw new Error('Columns button was unavailable');
    columns.click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    return root?.querySelector('[role="menu"]')?.textContent?.includes('Show repository avatar') === true;
  }, { polling: DOM_POLLING_MS, timeout: 10_000 });

  const avatarToggleChecked = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const avatarToggle = [...(root?.querySelectorAll('[role="menuitemcheckbox"]') ?? [])]
      .find((button) => button.textContent?.trim() === 'Show repository avatar');
    if (!(avatarToggle instanceof HTMLButtonElement)) throw new Error('Repository avatar toggle was unavailable');
    const checked = avatarToggle.getAttribute('aria-checked');
    avatarToggle.click();
    return checked;
  });
  assert.equal(avatarToggleChecked, 'true');
  await page.waitForFunction(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    return root?.querySelectorAll('[data-repository-avatar-slot]').length === 0;
  }, { polling: DOM_POLLING_MS, timeout: 10_000 });
  const disabledAvatarState = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    return {
      slots: root?.querySelectorAll('[data-repository-avatar-slot]').length ?? 0,
      images: root?.querySelectorAll('[data-repository-avatar]').length ?? 0,
    };
  });
  assert.deepEqual(disabledAvatarState, { slots: 0, images: 0 });

  const layoutWarnings = [];
  const onLayoutConsole = (message) => {
    if (message.type() === 'warn' && message.text().includes('failed to persist layout preference')) {
      layoutWarnings.push(message.text());
    }
  };
  page.on('console', onLayoutConsole);
  const saveState = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const save = [...(root?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Save');
    if (!(save instanceof HTMLButtonElement)) return { present: false, disabled: null };
    const disabled = save.disabled;
    save.click();
    return { present: true, disabled };
  });
  assert.deepEqual(saveState, { present: true, disabled: false });
  try {
    await page.waitForFunction(() => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      return root?.querySelector('.gsm-edit-chrome-wrap')?.getAttribute('aria-hidden') === 'true';
    }, { polling: DOM_POLLING_MS, timeout: 10_000 });
  } catch (error) {
    const state = await page.evaluate(async () => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      const locks = typeof navigator.locks?.query === 'function' ? await navigator.locks.query() : null;
      const editChrome = root?.querySelector('.gsm-edit-chrome-wrap');
      return {
        editingLayout: editChrome?.getAttribute('aria-hidden') === 'false',
        locks,
      };
    });
    const stored = await readStoredConfig(page.browser());
    page.off('console', onLayoutConsole);
    throw new Error(
      `Layout save did not complete: ${JSON.stringify({
        ...state,
        storedRepositoryAvatar: stored?.customColumnLayout?.showRepositoryAvatar ?? null,
        warnings: layoutWarnings,
      })}: ${formatError(error)}`,
    );
  }
  page.off('console', onLayoutConsole);
  const persisted = await waitForStoredRepositoryAvatar(page.browser(), false);
  assert.equal(persisted.customColumnLayout.showRepositoryAvatar, false);
}

async function readRepositoryAvatarState(page) {
  return page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const images = [...(root?.querySelectorAll('[data-repository-avatar]') ?? [])];
    const fallbacks = [...(root?.querySelectorAll('[data-repository-avatar-fallback]') ?? [])];
    const slots = [...(root?.querySelectorAll('[data-repository-avatar-slot]') ?? [])];
    const broken = images.find((image) => image.getAttribute('src')?.includes('/broken'));
    return {
      slots: slots.length,
      fallbacks: fallbacks.length,
      images: images.length,
      initials: fallbacks.map((fallback) => fallback.textContent?.trim() ?? ''),
      colors: [...new Set(slots.map((slot) => slot.getAttribute('data-avatar-color')))],
      computedBackgrounds: [...new Set(fallbacks.map((fallback) => getComputedStyle(fallback).backgroundColor))],
      brokenHidden: broken instanceof HTMLImageElement && broken.hidden,
      loading: images[0]?.getAttribute('loading') ?? null,
      decoding: images[0]?.getAttribute('decoding') ?? null,
    };
  });
}

async function scrollStarsToBottomAndReadAvatarState(page) {
  const scrollSet = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const scroller = root?.querySelector('[data-surface="stars"].no-scrollbar');
    if (!(scroller instanceof HTMLElement)) return false;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  });
  assert.equal(scrollSet, true, 'Stars scroller was unavailable');
  await page.waitForFunction(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    return root?.textContent?.includes('virtual-owner-239/repository') === true;
  }, { polling: DOM_POLLING_MS, timeout: 10_000 });
  return page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const scroller = root?.querySelector('[data-surface="stars"].no-scrollbar');
    const images = [...(root?.querySelectorAll('[data-repository-avatar]') ?? [])];
    return {
      scrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : 0,
      slots: root?.querySelectorAll('[data-repository-avatar-slot]').length ?? 0,
      fallbacks: root?.querySelectorAll('[data-repository-avatar-fallback]').length ?? 0,
      images: images.length,
      loading: images[0]?.getAttribute('loading') ?? null,
      decoding: images[0]?.getAttribute('decoding') ?? null,
      deepRowVisible: root?.textContent?.includes('virtual-owner-239/repository') === true,
    };
  });
}

async function readStoredConfig(browserInstance) {
  if (runtimeTarget === 'firefox') {
    const controlPage = activeExtensionRuntime?.controlPage;
    if (!controlPage || controlPage.isClosed()) {
      throw new Error('Firefox extension control page was unavailable');
    }
    return controlPage.evaluate(async () => {
      const stored = await chrome.storage.local.get('gsm_config');
      return stored.gsm_config ?? null;
    });
  }

  const target = browserInstance.targets().find((candidate) => (
    candidate.type() === 'service_worker' && candidate.url().startsWith('chrome-extension://')
  ));
  if (!target) throw new Error('extension service worker target was unavailable');
  const worker = await target.worker();
  if (!worker) throw new Error('extension service worker was unavailable');
  return worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('gsm_config');
    return stored.gsm_config ?? null;
  });
}

async function waitForStoredRepositoryAvatar(browserInstance, visible, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let config = null;
  while (Date.now() < deadline) {
    config = await readStoredConfig(browserInstance);
    if (config?.customColumnLayout?.showRepositoryAvatar === visible) return config;
    await delay(DOM_POLLING_MS);
  }
  throw new Error(`repository avatar preference was not persisted as ${visible}: ${JSON.stringify(config)}`);
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
      finePointerHover: matchMedia('(hover: hover) and (pointer: fine)').matches,
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
  if (hoverProbe.finePointerHover) {
    assert.notEqual(
      hoveredStyle.backgroundColor,
      hoverProbe.backgroundColor,
      'Radar row hover did not change the immediate row background',
    );
  } else {
    assert.equal(
      hoveredStyle.backgroundColor,
      hoverProbe.backgroundColor,
      'Radar row applied a hover background in a runtime without fine-pointer hover',
    );
  }
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

async function assertForYouRecommendations(page) {
  const initialStarsCount = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    return root?.querySelectorAll('[data-row-key]').length ?? 0;
  });
  const clicked = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const tab = [...(root?.querySelectorAll('[data-radar-discover-switcher] [role="tab"]') ?? [])]
      .find((candidate) => candidate.textContent?.includes('For You'));
    tab?.click();
    return !!tab;
  });
  assert.equal(clicked, true, 'For You Discover tab was not clickable');
  await page.waitForFunction(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const surface = root?.querySelector('[data-radar-discover-view="for-you"]');
    return surface?.textContent?.includes('candidate/recommended-tool') &&
      surface.textContent.includes('runtime-smoke') &&
      !surface.textContent.includes('Not in your stars') &&
      surface.textContent.includes('Because you starred smoke-user/smoke-repo');
  }, { polling: DOM_POLLING_MS, timeout: 20_000 });
  const state = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const surface = root?.querySelector('[data-radar-discover-view="for-you"]');
    const row = surface?.querySelector('[data-recommendation-row="candidate/recommended-tool"]');
    const tab = [...(root?.querySelectorAll('[data-radar-discover-switcher] [role="tab"]') ?? [])]
      .find((candidate) => candidate.textContent?.includes('For You'));
    return {
      selected: tab?.getAttribute('aria-selected') === 'true',
      newBatchLabel: surface?.querySelector('button[aria-label="New batch"]')?.textContent?.trim() ?? null,
      repositoryHref: row?.querySelector('a')?.href ?? null,
      trendingHref: surface?.querySelector('a[href="https://github.com/trending"]')?.href ?? null,
      starButtonLabel: row?.querySelector('button')?.textContent?.trim() ?? null,
      ownerAvatarSrc: row?.querySelector('img')?.getAttribute('src') ?? null,
      annotationActionPresent: /favorite|add tag|note/i.test(row?.textContent ?? ''),
    };
  });
  assert.deepEqual(state, {
    newBatchLabel: 'New batch',
    selected: true,
    repositoryHref: 'https://github.com/candidate/recommended-tool',
    trendingHref: 'https://github.com/trending',
    starButtonLabel: 'Star',
    ownerAvatarSrc: 'https://github.com/candidate.png?size=64',
    annotationActionPresent: false,
  });
  const search = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const input = root?.querySelector('[data-radar-discover-view="for-you"] input[aria-label="Search recommendations"]');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'no-match');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  assert.equal(search, true, 'For You search input was unavailable');
  await page.waitForFunction(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    const surface = root?.querySelector('[data-radar-discover-view="for-you"]');
    return !surface?.querySelector('[data-recommendation-row]') && surface?.textContent?.includes('No recommendations match');
  }, { polling: DOM_POLLING_MS, timeout: 10_000 });
  const finalStarsCount = await page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
    return root?.querySelectorAll('[data-row-key]').length ?? 0;
  });
  assert.equal(finalStarsCount, initialStarsCount, 'For You candidates changed the local Stars row count');
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
    const state = await page.evaluate(() => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      const button = root?.querySelector('#gsm-watch-surface-tab');
      return {
        rootPresent: !!root,
        watchPresent: !!button,
        watchDisabled: button instanceof HTMLButtonElement ? button.disabled : null,
        editingLayout: root?.textContent?.includes('Editing layout') ?? null,
        buttons: [...(root?.querySelectorAll('button') ?? [])]
          .map((candidate) => candidate.textContent?.trim() ?? '')
          .filter(Boolean)
          .slice(0, 20),
      };
    });
    throw await pageWaitError(
      page,
      `Watch Manager surface switch did not become interactive: ${JSON.stringify(state)}`,
      error,
    );
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
      .find((candidate) => candidate.href === 'https://github.com/smoke-user/custom-repo');
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
      notificationOutsideLiveStarsVisible: text.includes('OUTSIDE LIVE STARS MUST NOT RENDER'),
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
    state.text.includes('The GitHub Classic PAT needs the repo scope and access to this repository.'),
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

async function assertToolbarResponsiveLayout(page) {
  const originalViewport = page.viewport() ?? { width: 800, height: 600, deviceScaleFactor: 1 };
  const widths = [1440, 1309, 1280, 1024, 900, 768, 640, 480];
  const samples = [];

  for (const width of widths) {
    await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
    await waitForStableLayout(page);
    samples.push(await page.evaluate(() => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root');
      const toolbar = root?.querySelector('[data-toolbar-root]');
      const row = root?.querySelector('[data-toolbar-row]');
      const left = root?.querySelector('[data-toolbar-left]');
      const right = root?.querySelector('[data-toolbar-right]');
      const search = root?.querySelector('[data-toolbar-search]');
      const sort = left?.querySelector('button[role="combobox"]');
      const account = root?.querySelector('[data-toolbar-account]');
      const labelSelectors = [
        '[data-toolbar-action-label="sync"]',
        '[data-toolbar-action-label="auto-tags"]',
        '[data-toolbar-action-label="agent"]',
        '[data-toolbar-action-label="gist"]',
      ];
      const rowRect = row?.getBoundingClientRect();
      const leftRect = left?.getBoundingClientRect();
      const rightRect = right?.getBoundingClientRect();
      const accountRect = account?.getBoundingClientRect();
      const controls = [...(row?.querySelectorAll('button, a, input, [role="combobox"]') ?? [])]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return getComputedStyle(element).display !== 'none' && rect.width > 0 && rect.height > 0;
        });
      const rowVerticalCenters = controls.map((element) => {
        const rect = element.getBoundingClientRect();
        return Math.round(rect.top + rect.height / 2);
      });
      const labelVisible = labelSelectors
        .map((selector) => root?.querySelector(selector))
        .filter((element) => element && getComputedStyle(element.parentElement ?? element).display !== 'none')
        .map((element) => getComputedStyle(element).display !== 'none');

      return {
        viewportWidth: innerWidth,
        toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : -1,
        rowHeight: rowRect?.height ?? -1,
        rowCenterCount: new Set(rowVerticalCenters).size,
        leftRightOverlap: leftRect && rightRect ? leftRect.right - rightRect.left : -1,
        searchWidth: search?.getBoundingClientRect().width ?? -1,
        sortWidth: sort?.getBoundingClientRect().width ?? -1,
        labelVisible,
        accountWidth: accountRect?.width ?? -1,
        accountHeight: accountRect?.height ?? -1,
        accountBorderRadius: account ? Number.parseFloat(getComputedStyle(account).borderRadius) : -1,
      };
    }));
  }

  for (const sample of samples) {
    assert.equal(sample.toolbarOverflow <= 1, true, `${sample.viewportWidth}px toolbar overflowed horizontally: ${JSON.stringify(sample)}`);
    assert.equal(sample.rowHeight <= 53, true, `${sample.viewportWidth}px toolbar wrapped to another row`);
    assert.equal(sample.rowCenterCount, 1, `${sample.viewportWidth}px toolbar controls did not share one row`);
    assert.equal(sample.leftRightOverlap <= 1, true, `${sample.viewportWidth}px toolbar zones overlapped`);
    assert.equal(sample.searchWidth >= 72, true, `${sample.viewportWidth}px search collapsed below its usable minimum`);
    assert.equal(sample.sortWidth >= (sample.viewportWidth <= 640 ? 80 : 120), true, `${sample.viewportWidth}px sort collapsed below its usable minimum`);
    assert.equal(new Set(sample.labelVisible).size <= 1, true, `${sample.viewportWidth}px visible toolbar action labels hid inconsistently: ${JSON.stringify(sample.labelVisible)}`);
    if (sample.viewportWidth <= 1280) {
      assert.equal(sample.labelVisible.every((visible) => !visible), true);
    } else {
      assert.equal(sample.labelVisible.every(Boolean), true);
    }
    if (sample.viewportWidth <= 1024) {
      assert.equal(Math.abs(sample.accountWidth - sample.accountHeight) <= 1, true, `${sample.viewportWidth}px account trigger was not square`);
      assert.equal(sample.accountBorderRadius >= sample.accountWidth / 2 - 1, true, `${sample.viewportWidth}px account trigger was not circular`);
    }
  }

  const desktop = samples.find((sample) => sample.viewportWidth === 1440);
  assert.ok(desktop, 'desktop toolbar sample was missing');
  assert.equal(desktop.searchWidth >= 240, true, `desktop search remained too short: ${JSON.stringify(desktop)}`);
  assert.equal(desktop.searchWidth > desktop.sortWidth, true, 'desktop search was not wider than the sort control');
  const laptop = samples.find((sample) => sample.viewportWidth === 1309);
  assert.ok(laptop, '14-inch laptop toolbar sample was missing');
  assert.equal(laptop.searchWidth <= 241, true, `14-inch search remained too wide: ${JSON.stringify(laptop)}`);
  assert.equal(laptop.sortWidth <= 141, true, `14-inch sort remained too wide: ${JSON.stringify(laptop)}`);

  const searchWidths = new Set(samples.map((sample) => Math.round(sample.searchWidth)));
  const sortWidths = new Set(samples.map((sample) => Math.round(sample.sortWidth)));
  assert.equal(searchWidths.size > 1, true, 'search width did not respond to viewport changes');
  assert.equal(sortWidths.size > 1, true, 'sort width did not respond to viewport changes');
  await page.setViewport(originalViewport);
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
  const mascotAssetPrefix = `${extensionOrigin(activeExtensionRuntime.extensionId, runtimeTarget)}/assets/index-agent-atlas-`;
  assert.equal(
    mascot.assetUrl?.startsWith(mascotAssetPrefix) === true && mascot.assetUrl.endsWith('.png'),
    true,
  );
  assert.equal(mascot.bytes > 0, true);
  await page.waitForFunction(
    () => {
      const button = document
        .getElementById('gsm-manager-host')
        ?.shadowRoot
        ?.querySelector('button[aria-label="Suggested actions"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    { polling: DOM_POLLING_MS, timeout: 10_000 },
  );
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
  const onConsole = (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const location = message.location();
    if (label === OPTIONS_PATH && text.includes('api.github.com') && text.includes('401')) return;
    if (label === OPTIONS_PATH && text.includes('Failed to load resource') && text.includes('401')) return;
    if (
      (label === OPTIONS_PATH || label === 'watch-fallback')
      && text.includes('Failed to load resource')
      && text.includes('403')
      && location.url === 'https://api.github.com/notifications?all=true&per_page=1'
    ) return;
    recordPageIssue(label, `console.error: ${text}${location.url ? ` (${location.url})` : ''}`);
  };
  const onRequestFailed = (request) => {
    const url = request.url();
    if (
      url.startsWith('chrome-extension://')
      || url.startsWith('moz-extension://')
      || url.startsWith('https://github.com/')
      || url.startsWith('https://api.github.com/')
    ) {
      recordPageIssue(label, `request failed: ${url} ${request.failure()?.errorText ?? ''}`);
    }
  };
  const onPageError = (error) => {
    recordPageIssue(label, `page error: ${formatError(error)}`);
  };
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);
  page.on('pageerror', onPageError);
  return {
    cleanup() {
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
      page.off('pageerror', onPageError);
    },
  };
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
