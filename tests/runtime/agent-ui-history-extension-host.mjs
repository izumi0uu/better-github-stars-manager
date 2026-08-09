#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertRuntimeReleaseDistIdentity,
  MAX_RUNTIME_EVIDENCE_BYTES,
  publishRuntimeEvidence,
  readRuntimeReleaseDistIdentity,
  serializeRuntimeEvidence,
} from '../../scripts/agent-runtime-evidence-contract.mjs';
import {
  assertFailClosedNetworkIsolation,
  launchExtensionBrowser,
} from './puppeteer-runtime.mjs';
import {
  assertControlledProviderHealthy,
  closeControlledResponsesProvider,
  createControlledResponsesProvider,
  installControlledProvider,
} from './controlled-responses-provider.mjs';
import {
  discoverExtension,
  hookPageDiagnostics,
  openExtensionPage,
  openHttpFixturePage,
} from './extension-runtime-targets.mjs';

const DIST = path.resolve(process.cwd(), process.env.GSM_DIST_DIR ?? 'dist');
const OPTIONS_PATH = '/src/options/index.html';
const PROVIDER_ORIGIN = 'https://api.openai.com';
const PROVIDER_BASE_URL = `${PROVIDER_ORIGIN}/v1`;
const MODEL = 'runtime-ui-history-model';
const GITHUB_CREDENTIAL = 'github_pat_runtime_ui_history_only';
const PROVIDER_CREDENTIAL = 'runtime-ui-history-provider-key';
const PAGE_A_URL = 'https://github.com/runtime-user?tab=stars&runtime=phase7c-a';
const PAGE_B_URL = 'https://github.com/runtime-user?tab=stars&runtime=phase7c-b';
const HELD_LABEL = 'phase7c-held';
const SUBMITTED_PROMPT_CANARY = 'runtime-ui-history-submitted-prompt-canary';
const PROVIDER_RESPONSE_CANARY = 'runtime-ui-history-provider-response-canary';
const NEVER_SUBMITTED_CANARY = 'runtime-ui-history-never-submitted-canary';
const REJECTED_INPUT_CANARY = 'runtime-ui-history-rejected-input-canary';
const RETRY_PROMPT_CANARY = 'runtime-ui-history-retry-prompt-canary';
const RETRY_RESPONSE_CANARY = 'runtime-ui-history-retry-response-canary';
const PRIVATE_MARKERS = Object.freeze([
  GITHUB_CREDENTIAL,
  PROVIDER_CREDENTIAL,
  SUBMITTED_PROMPT_CANARY,
  PROVIDER_RESPONSE_CANARY,
  NEVER_SUBMITTED_CANARY,
  REJECTED_INPUT_CANARY,
  RETRY_PROMPT_CANARY,
  RETRY_RESPONSE_CANARY,
]);
const HISTORY_TURNS = 50;
const SETUP_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 90_000;
const HISTORY_TIMEOUT_MS = 45_000;
const RUN_EVIDENCE_SELF_TEST = process.env.GSM_UI_HISTORY_EVIDENCE_SELF_TEST === '1';
const AGENT_STORES = Object.freeze(['agentSessions', 'agentAttempts', 'agentAttemptRecoveries', 'agentMessages']);

let profile;
const pageIssues = [];
const runtime = {
  stage: 'manifest',
  stages: [],
  mode: 'setup',
  configStep: 'not-started',
  historyOrdinal: 0,
  networkIsolation: false,
  monitorInstalled: false,
  pagePoliciesClosed: false,
  diagnosticsDetached: false,
  pagesClosed: false,
  browserClosed: false,
  profileRemoved: false,
  cleanupFailures: 0,
  conflictErrorFingerprint: null,
  facts: Object.create(null),
};
const optionsPolicy = createPagePolicy(null);
const pageAPolicy = createPagePolicy('a');
const pageBPolicy = createPagePolicy('b');
let browser;
let worker;
let provider;
let optionsPage;
let pageA;
let pageB;
let optionsDiagnostics;
let pageADiagnostics;
let pageBDiagnostics;
let primaryFailure;
let primaryDiagnostic;
let teardownFailure;
let releaseDist;

if (RUN_EVIDENCE_SELF_TEST) {
  await runEvidenceSelfTest();
} else {
  await main();
}

async function main() {
  profile = mkdtempSync(path.join(os.tmpdir(), 'bgsm-agent-ui-history-'));
  try {
    await run();
  } catch (error) {
    primaryFailure = error;
    primaryDiagnostic = await boundedDiagnostic(error);
  }
  try {
    await teardown();
  } catch (error) {
    teardownFailure = error;
  }

  if (primaryFailure || teardownFailure) {
    const diagnostic = {
      ...(primaryDiagnostic ?? await boundedDiagnostic(teardownFailure)),
      cleanupFailures: runtime.cleanupFailures,
    };
    console.error(serializeBoundedDiagnostic(diagnostic));
    process.exitCode = 1;
    return;
  }

  try {
    publishEvidence(buildEvidence());
  } catch (error) {
    const diagnostic = await boundedDiagnostic(error);
    console.error(serializeBoundedDiagnostic(diagnostic));
    process.exitCode = 1;
  }
}

async function run() {
  if (!existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('A packaged extension manifest is required before the Phase 7C host can start.');
  }
  releaseDist = readRuntimeReleaseDistIdentity(DIST);
  await stage('launch', async () => {
    browser = await launchExtensionBrowser({
      dist: DIST,
      userDataDir: profile,
      protocolTimeout: TURN_TIMEOUT_MS,
      failClosedNetwork: true,
    });
    await assertFailClosedNetworkIsolation(browser);
    runtime.networkIsolation = true;
  });

  const extension = await stage('extension', () => discoverExtension(browser, {
    dist: DIST,
    timeoutMs: SETUP_TIMEOUT_MS,
  }));
  worker = extension.worker;
  provider = createControlledResponsesProvider({
    providerOrigin: PROVIDER_ORIGIN,
    handler: controlledProviderHandler,
    httpFixtureHandler: githubWorkerFixture,
  });
  await stage('gates', async () => {
    await installControlledProvider(extension.target, provider);
    await installWorkerPortMonitor(worker, {
      submitted: SUBMITTED_PROMPT_CANARY,
      rejected: REJECTED_INPUT_CANARY,
      neverSubmitted: NEVER_SUBMITTED_CANARY,
    });
    runtime.monitorInstalled = true;
  });

  await stage('configuration', async () => {
    runtime.configStep = 'open-options';
    optionsPage = await openExtensionPage(
      browser,
      extension.extensionId,
      OPTIONS_PATH,
      'phase7c-options',
      { timeoutMs: SETUP_TIMEOUT_MS, failClosedHttp: optionsPolicy },
    );
    runtime.configStep = 'options-open';
    optionsDiagnostics = hookPageDiagnostics(optionsPage, 'phase7c-options', { issues: pageIssues });
    await waitForOptionsReady(optionsPage);
    runtime.configStep = 'options-ready';
    await saveGitHubToken(optionsPage);
    reconcileExpectedTokenProbeRequestFailure();
    runtime.configStep = 'github-saved';
    await saveProvider(optionsPage);
    runtime.configStep = 'provider-saved';
    await seedRuntimeRepository(optionsPage);
    assert.deepEqual(await readSafeConfig(optionsPage), {
      username: 'runtime-user',
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: PROVIDER_BASE_URL,
      model: MODEL,
      hasKey: true,
      capabilityReady: true,
    });
  });

  await stage('open-pages', async () => {
    [pageA, pageB] = await Promise.all([
      openHttpFixturePage(browser, PAGE_A_URL, 'phase7c-page-a', {
        timeoutMs: SETUP_TIMEOUT_MS,
        rootSelector: 'main',
        failClosedHttp: pageAPolicy,
      }),
      openHttpFixturePage(browser, PAGE_B_URL, 'phase7c-page-b', {
        timeoutMs: SETUP_TIMEOUT_MS,
        rootSelector: 'main',
        failClosedHttp: pageBPolicy,
      }),
    ]);
    pageADiagnostics = hookPageDiagnostics(pageA, 'phase7c-page-a', { issues: pageIssues });
    pageBDiagnostics = hookPageDiagnostics(pageB, 'phase7c-page-b', { issues: pageIssues });
    assert.equal(pageA.url(), PAGE_A_URL);
    assert.equal(pageB.url(), PAGE_B_URL);
    assert.equal(await pageA.title(), 'Runtime Stars A');
    assert.equal(await pageB.title(), 'Runtime Stars B');
    await Promise.all([waitForAgentEntry(pageA), waitForAgentEntry(pageB)]);
  });

  await stage('atomic', async () => {
    runtime.configStep = 'atomic-click';
    await Promise.all([
      clickShadow(pageA, '[data-coach-target="agent"]'),
      clickShadow(pageB, '[data-coach-target="agent"]'),
    ]);
    runtime.configStep = 'atomic-ready';
    await Promise.all([waitForAgentReady(pageA), waitForAgentReady(pageB)]);
    runtime.configStep = 'atomic-menu-open';
    const [catalogA, catalogB] = await Promise.all([
      inspectCurrentSession(pageA),
      inspectCurrentSession(pageB),
    ]);
    assert.equal(typeof catalogA.sessionId, 'string');
    assert.equal(catalogA.sessionId, catalogB.sessionId);
    assert.equal(catalogA.sessionItemCount, 1);
    assert.equal(catalogB.sessionItemCount, 1);
    runtime.configStep = 'atomic-authority';
    const authority = await readAuthority(optionsPage, catalogA.sessionId, PRIVATE_MARKERS);
    assert.equal(authority.sessionCount, 1);
    assert.equal(authority.knownSessionCount, 1);
    runtime.configStep = 'atomic-assert';
    assert.equal(authority.attemptCount, 0);
    assert.equal(authority.messageCount, 0);
    runtime.facts.atomic = { sessionRows: 1, sameSession: true };
    runtime.initialSessionId = catalogA.sessionId;
  });

  await stage('page-local', async () => {
    runtime.configStep = 'page-local-create';
    await clickShadow(pageA, 'aside[role="dialog"] > div:first-child button[aria-label="Start new conversation"]');
    runtime.configStep = 'page-local-catalog';
    await waitUntil(async () => (await readCappedSessionIds(optionsPage)).length === 2,
      SETUP_TIMEOUT_MS, 'Page A did not create one additional durable conversation.');
    await waitUntil(async () => (await readUi(pageA)).sessionToggleEnabled,
      SETUP_TIMEOUT_MS, 'Page A did not settle its local conversation selection.');
    runtime.configStep = 'page-local-inspect';
    const [createdA, localB] = await Promise.all([
      inspectCurrentSession(pageA),
      inspectCurrentSession(pageB),
    ]);
    assert.notEqual(createdA.sessionId, runtime.initialSessionId);
    assert.equal(localB.sessionId, runtime.initialSessionId);
    const createdAuthority = await readAuthority(
      optionsPage,
      createdA.sessionId,
      PRIVATE_MARKERS,
      [runtime.initialSessionId, createdA.sessionId],
    );
    assert.equal(createdAuthority.knownSessionCount, 2);
    runtime.facts.pageLocal = {
      sessionRows: 2,
      pageAPickedNew: true,
      pageBStayedLocal: true,
    };
    runtime.configStep = 'page-local-switch-open';
    await clickShadow(pageA, '[data-testid="agent-session-toggle"]');
    await waitUntil(async () => (await readUi(pageA)).sessionMenuOpen,
      SETUP_TIMEOUT_MS, 'Page A session menu did not open.');
    runtime.configStep = 'page-local-switch-settle';
    await clickSessionItem(pageA, runtime.initialSessionId);
    runtime.configStep = 'page-local-switch-clicked';
    await waitUntil(async () => !(await readUi(pageA)).sessionMenuOpen,
      SETUP_TIMEOUT_MS, 'Page A session menu did not close after its production switch.');
    runtime.configStep = 'page-local-switch-closed';
    await waitUntil(async () => (await readUi(pageA)).sessionToggleEnabled,
      SETUP_TIMEOUT_MS, 'Page A did not settle its production session switch.');
    runtime.configStep = 'page-local-switch-inspect';
    const [restoredA, stableB] = await Promise.all([
      inspectCurrentSession(pageA),
      inspectCurrentSession(pageB),
    ]);
    assert.equal(restoredA.sessionId, runtime.initialSessionId);
    assert.equal(stableB.sessionId, runtime.initialSessionId);
    runtime.activeSessionId = runtime.initialSessionId;
  });
  await stage('never-submitted', async () => {
    if (!(await readUi(pageA)).drawer) {
      await clickShadow(pageA, '[data-coach-target="agent"]');
      await waitForAgentReady(pageA);
    }
    runtime.configStep = 'composer-open';
    runtime.configStep = 'composer-first';
    await fillShadowComposer(pageA, NEVER_SUBMITTED_CANARY);
    runtime.configStep = 'composer-second';
    await fillShadowComposer(pageA, SUBMITTED_PROMPT_CANARY);
    runtime.configStep = 'composer-ready';
  });

  await stage('conflict', async () => {
    runtime.mode = 'held';
    const providerBefore = provider.capture.length;
    runtime.configStep = providerBefore === 2 ? 'conflict-provider-before-two' : 'conflict-provider-before-other';
    await submitShadowComposer(pageA);
    await waitUntil(() => provider.capture.length === providerBefore + 1,
      TURN_TIMEOUT_MS, 'Controlled Provider did not capture the first scenario request.');
    runtime.configStep = provider.capture.at(-1)?.held === true
      ? 'conflict-capture-held'
      : 'conflict-capture-unheld';
    assert.equal(provider.capture.at(-1)?.held, true);
    await waitForProviderHold(provider, HELD_LABEL, TURN_TIMEOUT_MS);
    runtime.configStep = 'conflict-held';
    const heldProviderCount = provider.capture.length;
    runtime.configStep = 'conflict-authority';
    const heldAuthority = await readAuthority(optionsPage, runtime.activeSessionId, PRIVATE_MARKERS);
    assert.equal(heldAuthority.attemptCount, 1);
    assert.equal(heldAuthority.messageCount, 0);
    const monitorBefore = await readWorkerPortMonitor(worker);
    runtime.configStep = 'conflict-secondary';

    await fillShadowComposer(pageB, REJECTED_INPUT_CANARY);
    await submitShadowComposer(pageB);
    await waitUntil(async () => {
      const [monitor, ui] = await Promise.all([readWorkerPortMonitor(worker), readUi(pageB)]);
      return monitor.starts > monitorBefore.starts || ui.providerError;
    }, SETUP_TIMEOUT_MS, 'Competing page produced neither a Port start nor a typed error.');
    const rejectedMonitor = await readWorkerPortMonitor(worker);
    const rejectedPortKind = rejectedMonitor.resumeOnlySubmittedStarts > monitorBefore.resumeOnlySubmittedStarts
      ? 'conflict-rejected-resume-winner'
      : rejectedMonitor.standardRejectedStarts > monitorBefore.standardRejectedStarts
        ? 'conflict-rejected-standard'
        : rejectedMonitor.starts > monitorBefore.starts
          ? 'conflict-rejected-other-start'
          : 'conflict-rejected-local-error';
    runtime.configStep = rejectedPortKind;
    await waitUntil(async () => (await readUi(pageB)).providerError,
      TURN_TIMEOUT_MS, 'Competing page did not render a Provider error card.');
    const finalRejectedMonitor = await readWorkerPortMonitor(worker);
    const finalRejectedPortKind = finalRejectedMonitor.resumeOnlySubmittedStarts > monitorBefore.resumeOnlySubmittedStarts
      ? 'conflict-final-resume-winner'
      : 'conflict-final-no-resume';
    const rejectedUi = await readUi(pageB, {
      expectedInput: REJECTED_INPUT_CANARY,
      rejectedMarker: REJECTED_INPUT_CANARY,
    });
    runtime.conflictErrorFingerprint = rejectedUi.publicErrorFingerprint;
    runtime.configStep = rejectedUi.conflictTextExact
      ? rejectedUi.inputExact
        ? 'conflict-rejected-ready'
        : 'conflict-rejected-input-missing'
      : rejectedUi.conflictTextContains
        ? 'conflict-rejected-prefixed'
        : rejectedUi.conflictTextIdentity
          ? 'conflict-rejected-identity'
          : rejectedUi.conflictTextGeneric
            ? 'conflict-rejected-generic'
            : rejectedUi.conflictTextOther === 'conflict-rejected-other'
              ? finalRejectedPortKind === 'conflict-final-resume-winner'
                ? 'conflict-final-resume-copy-other'
                : rejectedPortKind === 'conflict-rejected-standard'
                  ? 'conflict-final-standard-no-resume-copy-other'
                  : rejectedUi.conflictTextOther
              : rejectedUi.conflictTextOther;
    assert.equal(rejectedUi.conflictTextExact, true);
    assert.equal(rejectedUi.inputExact, true);
    assert.equal(rejectedUi.rejectedMessageOccurrences, 0);

    const conflictAuthority = await readAuthority(optionsPage, runtime.activeSessionId, PRIVATE_MARKERS);
    await waitUntil(async () => (
      (await readWorkerPortMonitor(worker)).resumeOnlySubmittedStarts
        === monitorBefore.resumeOnlySubmittedStarts + 1
    ), SETUP_TIMEOUT_MS, 'Competing page did not subscribe to the winning attempt.');
    runtime.configStep = 'conflict-resume-observed';
    const monitorAfter = await readWorkerPortMonitor(worker);
    assert.equal(heldProviderCount, providerBefore + 1);
    assert.equal(provider.capture.length, heldProviderCount);
    runtime.configStep = 'conflict-provider-asserted';
    assert.equal(conflictAuthority.knownSessionCount, heldAuthority.knownSessionCount);
    assert.equal(conflictAuthority.attemptCount, heldAuthority.attemptCount);
    assert.equal(conflictAuthority.messageCount, heldAuthority.messageCount);
    assert.equal(conflictAuthority.canaryOccurrences.rejected, 0);
    runtime.configStep = 'conflict-authority-asserted';
    assert.equal(monitorAfter.starts, monitorBefore.starts + 2);
    runtime.configStep = 'conflict-starts-asserted';
    assert.equal(
      monitorAfter.resumeOnlySubmittedStarts,
      monitorBefore.resumeOnlySubmittedStarts + 1,
    );
    runtime.configStep = 'conflict-resume-asserted';
    assert.equal(monitorAfter.resumeOnlyRejectedStarts, 0);
    runtime.configStep = 'conflict-resume-rejected-asserted';
    assert.equal(
      monitorAfter.standardRejectedStarts,
      monitorBefore.standardRejectedStarts + 1,
    );
    runtime.configStep = 'conflict-standard-rejected-asserted';
    assert.equal(
      monitorAfter.resumeOnlyNeverSubmittedStarts,
      monitorBefore.resumeOnlyNeverSubmittedStarts,
    );
    runtime.configStep = 'conflict-resume-never-asserted';
    assert.equal(
      monitorAfter.standardSubmittedStarts,
      monitorBefore.standardSubmittedStarts,
    );
    runtime.configStep = 'conflict-standard-submitted-asserted';

    runtime.facts.conflict = {
      typed: true,
      exactPublicText: true,
      domRollback: true,
      inputRetainedBefore: true,
      inputRetainedAfter: false,
      composerEnabledAfter: false,
      sessionDelta: 0,
      attemptDelta: 0,
      providerDelta: 0,
      messageDelta: 0,
    };
    runtime.facts.subscription = {
      resumeOnlyWinnerStarts: 1,
      resumeOnlyRejectedStarts: 0,
      providerDelta: 0,
      providerRequests: 1,
      sessionRows: 1,
      attemptRows: 1,
      committedRows: 0,
      terminalPages: 0,
    };

    await provider.releaseHeldResponse(HELD_LABEL);
    runtime.configStep = 'conflict-response-released';
    await waitUntil(async () => {
      const [a, b] = await Promise.all([
        readUi(pageA, {
          messageMarker: PROVIDER_RESPONSE_CANARY,
          winnerMarker: SUBMITTED_PROMPT_CANARY,
          rejectedMarker: REJECTED_INPUT_CANARY,
        }),
        readUi(pageB, {
          expectedInput: REJECTED_INPUT_CANARY,
          messageMarker: PROVIDER_RESPONSE_CANARY,
          winnerMarker: SUBMITTED_PROMPT_CANARY,
          rejectedMarker: REJECTED_INPUT_CANARY,
        }),
      ]);
      return a.messageMarkerOccurrences === 1
        && b.messageMarkerOccurrences === 1
        && a.winnerMessageOccurrences === 1
        && b.winnerMessageOccurrences === 1
        && a.rejectedMessageOccurrences === 0
        && b.rejectedMessageOccurrences === 0
        && b.inputExact
        && b.composerEnabled
        && b.providerError
        && b.conflictTextExact
        && !a.running
        && !b.running;
    }, TURN_TIMEOUT_MS, 'Both pages did not converge with usable exact rejected input after winner commit.');
    runtime.configStep = 'conflict-winner-converged';
    const terminalAuthority = await readAuthority(optionsPage, runtime.activeSessionId, PRIVATE_MARKERS);
    assert.equal(terminalAuthority.sessionCount, 1);
    runtime.configStep = 'conflict-terminal-session-count';
    assert.equal(terminalAuthority.knownSessionCount, 1);
    runtime.configStep = 'conflict-terminal-known-count';
    assert.equal(terminalAuthority.attemptCount, 1);
    runtime.configStep = 'conflict-terminal-attempt-count';
    assert.equal(terminalAuthority.stateCounts.committed, 1);
    runtime.configStep = 'conflict-terminal-committed-count';
    assert.equal(terminalAuthority.messageCount, 2);
    runtime.configStep = 'conflict-terminal-message-count';
    assert.equal(terminalAuthority.roleCounts.user, 1);
    runtime.configStep = 'conflict-terminal-user-role-count';
    assert.equal(terminalAuthority.roleCounts.assistant, 1);
    runtime.configStep = 'conflict-terminal-assistant-role-count';
    assert.equal(terminalAuthority.canaryOccurrences.submitted, 2);
    assert.equal(terminalAuthority.canaryOccurrences.providerResponse, 1);
    assert.equal(terminalAuthority.canaryOccurrences.rejected, 0);
    assert.equal(terminalAuthority.canaryOccurrences.neverSubmitted, 0);
    runtime.configStep = 'conflict-terminal-canary-count';
    runtime.facts.conflict.inputRetainedAfter = true;
    runtime.facts.conflict.composerEnabledAfter = true;
    runtime.facts.subscription.committedRows = 1;
    runtime.facts.subscription.terminalPages = 2;
    runtime.facts.canaryAfterConflict = terminalAuthority.canaryOccurrences;
  });

  await stage('retry', async () => {
    runtime.mode = 'retry-failure';
    const requestBefore = provider.capture.length;
    const attemptBefore = (await readAuthority(optionsPage, runtime.activeSessionId, PRIVATE_MARKERS)).attemptCount;
    await fillShadowComposer(pageA, RETRY_PROMPT_CANARY);
    await submitShadowComposer(pageA);
    await waitUntil(async () => {
      const ui = await readUi(pageA);
      if (!ui.durableRetry) return false;
      const authority = await readAuthority(optionsPage, runtime.activeSessionId, PRIVATE_MARKERS);
      return authority.stateCounts.retryable === 1;
    }, TURN_TIMEOUT_MS, 'A real retryable Provider failure did not reach the durable Retry UI.');
    assert.equal(provider.capture.length, requestBefore + 1);
    assert.equal(provider.capture.at(-1)?.httpStatus, 503);
    const afterFailure = await readAuthority(optionsPage, runtime.activeSessionId, PRIVATE_MARKERS);
    assert.equal(afterFailure.attemptCount, attemptBefore + 1);

    runtime.mode = 'retry-success';
    const retryRequestBefore = provider.capture.length;
    const retryAttemptBefore = afterFailure.attemptCount;
    await clickShadow(pageA, [
      '[data-testid="agent-durable-retry-button"]:not([disabled])',
      '[data-testid="agent-provider-error-card"] button:not([disabled])',
    ].join(', '));
    await waitUntil(async () => {
      const ui = await readUi(pageA, { messageMarker: RETRY_RESPONSE_CANARY });
      return ui.messageMarkerOccurrences === 1 && !ui.running && !ui.durableRetry;
    }, TURN_TIMEOUT_MS, 'Durable Retry did not commit through the production UI.');
    const afterRetry = await readAuthority(optionsPage, runtime.activeSessionId, PRIVATE_MARKERS);
    const retryCaptures = provider.capture.slice(retryRequestBefore);
    assert.equal(provider.capture.length, retryRequestBefore + 1);
    assert.equal(afterRetry.attemptCount, retryAttemptBefore + 1);
    assert.equal(afterRetry.terminalReasonCounts.retried, 1);
    assert.equal(afterRetry.stateCounts.committed, 2);
    assert.equal(afterRetry.nonNoneWriteSettlements, 0);
    assert.equal(retryCaptures.filter((entry) => entry.toolNames?.selected !== null).length, 0);
    runtime.facts.retry = {
      httpStatus: 503,
      requestDelta: 1,
      attemptDelta: 1,
      sourceRetried: 1,
      committed: 1,
      writeSettlementsNone: 2,
      selectedTools: 0,
    };
  });

  await stage('history', async () => {
    runtime.mode = 'history';
    const providerBefore = provider.capture.length;
    for (let ordinal = 1; ordinal <= HISTORY_TURNS; ordinal += 1) {
      runtime.historyOrdinal = ordinal;
      const prompt = historyPrompt(ordinal);
      const response = historyResponse(ordinal);
      await fillShadowComposer(pageA, prompt);
      await submitShadowComposer(pageA);
      await waitUntil(async () => {
        const ui = await readUi(pageA, { messageMarker: response });
        const ready = ui.messageMarkerOccurrences === 1 && !ui.running;
        runtime.configStep = `history-turn-${ordinal}-${ready
          ? 'ready'
          : ui.messageMarkerOccurrences === 1
            ? 'marker-running'
            : ui.running
              ? 'waiting'
              : 'settled-missing'}`;
        return ready;
      }, HISTORY_TIMEOUT_MS, 'A lightweight history turn did not commit through the production UI.');
    }
    runtime.configStep = 'history-turns-complete';
    assert.equal(provider.capture.length, providerBefore + HISTORY_TURNS);
    const authority = await readAuthority(optionsPage, runtime.activeSessionId, PRIVATE_MARKERS);
    assert.equal(authority.messageCount, 104);
    assert.deepEqual(authority.roleCounts, { user: 52, assistant: 52, other: 0 });
    assert.equal(authority.firstSequence, 1);
    assert.equal(authority.lastSequence, 104);
    assert.equal(authority.sequenceGaps, 0);
    assert.equal(authority.duplicateIds, 0);
    assert.equal(authority.nonNoneWriteSettlements, 0);
    runtime.configStep = 'history-authority-asserted';

    const expectedFull = [
      SUBMITTED_PROMPT_CANARY,
      PROVIDER_RESPONSE_CANARY,
      RETRY_PROMPT_CANARY,
      RETRY_RESPONSE_CANARY,
      ...Array.from({ length: HISTORY_TURNS }, (_, index) => [
        historyPrompt(index + 1),
        historyResponse(index + 1),
      ]).flat(),
    ];
    const expectedRecent = expectedFull.slice(-100);
    runtime.configStep = 'history-reload-started';
    await pageADiagnostics?.cleanup();
    await pageA.keyboard.press('Escape');
    await waitUntil(async () => !(await readUi(pageA)).drawer,
      SETUP_TIMEOUT_MS, 'Production Agent drawer did not close before reload.');
    runtime.configStep = 'history-reload-drawer-closed';
    await pageAPolicy.close?.();
    await pageA.close();
    pageA = await openHttpFixturePage(browser, PAGE_A_URL, 'phase7c-page-a-reload', {
      timeoutMs: SETUP_TIMEOUT_MS,
      rootSelector: 'main',
      failClosedHttp: pageAPolicy,
    });
    pageADiagnostics = hookPageDiagnostics(pageA, 'phase7c-page-a-reload', { issues: pageIssues });
    runtime.configStep = 'history-reload-loaded';
    assert.equal(pageA.url(), PAGE_A_URL);
    await waitForAgentEntry(pageA);
    runtime.configStep = 'history-manager-ready';
    await clickShadow(pageA, '[data-coach-target="agent"]');
    await waitForAgentReady(pageA);
    runtime.configStep = 'history-agent-ready';
    await waitUntil(async () => {
      const [ui, order] = await Promise.all([readUi(pageA), readHistoryOrder(pageA, expectedRecent)]);
      return ui.userMessages === 50
        && ui.assistantMessages === 50
        && ui.loadEarlier
        && order.exactOrder
        && order.occurrenceOnce;
    }, TURN_TIMEOUT_MS, 'Reload did not hydrate the exact latest 50 prompt/response pairs.');
    runtime.configStep = 'history-recent-hydrated';
    const recent = await readHistoryOrder(pageA, expectedRecent);
    assert.equal(recent.rowCount, 100);
    assert.equal(recent.exactOrder, true);
    assert.equal(recent.occurrenceOnce, true);
    await clickShadow(pageA, '[data-testid="agent-load-earlier-messages"]');
    runtime.configStep = 'history-load-earlier-clicked';
    await waitUntil(async () => {
      const [ui, order] = await Promise.all([readUi(pageA), readHistoryOrder(pageA, expectedFull)]);
      return ui.userMessages === 52
        && ui.assistantMessages === 52
        && !ui.loadEarlier
        && order.exactOrder
        && order.occurrenceOnce;
    }, TURN_TIMEOUT_MS, 'Load earlier did not render the exact full canonical order.');
    runtime.configStep = 'history-full-hydrated';
    const loaded = await readHistoryOrder(pageA, expectedFull);
    assert.equal(loaded.rowCount, 104);
    assert.equal(loaded.exactOrder, true);
    assert.equal(loaded.occurrenceOnce, true);
    runtime.facts.history = {
      lightweightTurns: HISTORY_TURNS,
      canonicalRows: authority.messageCount,
      userRows: authority.roleCounts.user,
      assistantRows: authority.roleCounts.assistant,
      recentRows: recent.rowCount,
      loadedRows: loaded.rowCount,
      recentExactOrder: recent.exactOrder,
      fullExactOrder: loaded.exactOrder,
      occurrenceOnce: loaded.occurrenceOnce,
      firstSequence: authority.firstSequence,
      lastSequence: authority.lastSequence,
      gaps: authority.sequenceGaps,
      duplicateIds: authority.duplicateIds,
      finalCursorNull: !(await readUi(pageA)).loadEarlier,
    };
    runtime.facts.finalAuthority = authority;
  });

  await stage('containment', async () => {
    runtime.configStep = 'containment-provider-start';
    await assertControlledProviderHealthy(provider);
    runtime.configStep = 'containment-provider-healthy';
    assert.equal(provider.unexpectedRequests.length, 0);
    assert.equal(provider.failures.length, 0);
    assert.equal(Object.values(provider.overflow).some(Boolean), false);
    runtime.configStep = 'containment-provider-asserted';
    for (const policy of [optionsPolicy, pageAPolicy, pageBPolicy]) {
      assert.equal(policy.unexpectedRequests.length, 0);
      assert.equal(policy.overflow, false);
      assert.equal(policy.interceptionFailure, false);
    }
    runtime.configStep = 'containment-page-policies';
    assert.equal(pageIssues.length, 0);
    runtime.configStep = 'containment-page-diagnostics';
    const monitor = await readWorkerPortMonitor(worker);
    runtime.configStep = `containment-resume-total-${Math.min(monitor.resumeOnlySubmittedStarts, 9)}`;
    assert.equal(monitor.resumeOnlySubmittedStarts, 1);
    assert.equal(monitor.resumeOnlyRejectedStarts, 0);
    assert.equal(monitor.standardRejectedStarts, 1);
    assert.equal(monitor.resumeOnlyNeverSubmittedStarts, 0);
    assert.equal(monitor.standardNeverSubmittedStarts, 0);
    runtime.configStep = 'containment-monitor-asserted';
    runtime.facts.monitor = monitor;
    runtime.facts.providerScenarioStart = 2;
  });
}

async function stage(name, operation) {
  runtime.stage = name;
  const value = await operation();
  runtime.stages.push(name);
  return value;
}
async function controlledProviderHandler(request) {
  assert.equal(request.protocol, 'responses');
  if (request.toolName === 'bgsm_connection_probe') {
    runtime.configStep = 'provider-handler-connection';
    return toolCall('runtime-ui-history-probe', 'bgsm_connection_probe', { nonce: 'bgsm' }, 'connection-probe');
  }
  if (request.latestToolResult?.name === 'bgsm_connection_probe') {
    runtime.configStep = 'provider-handler-connection-complete';
    return textCompletion('runtime provider ready', 'connection-probe-complete');
  }
  if (runtime.mode === 'held') {
    runtime.configStep = 'provider-handler-held';
    return { ...textCompletion(PROVIDER_RESPONSE_CANARY, 'held-turn'), hold: HELD_LABEL };
  }
  if (runtime.mode === 'retry-failure') {
    return { ...textCompletion('', 'retry-http-503'), httpStatus: 503 };
  }
  if (runtime.mode === 'retry-success') {
    return textCompletion(RETRY_RESPONSE_CANARY, 'retry-success');
  }
  if (runtime.mode === 'history') {
    return textCompletion(historyResponse(runtime.historyOrdinal), 'history-turn');
  }
  runtime.configStep = 'provider-handler-unscripted';
  throw new Error('Controlled Provider received an unscripted request.');
}

function textCompletion(content, kind) {
  return { kind, completion: { content } };
}

function toolCall(id, name, argumentsValue, kind) {
  return { kind, completion: { toolCall: { id, name, arguments: JSON.stringify(argumentsValue) } } };
}

function historyPrompt(ordinal) {
  return `runtime lightweight history prompt ${String(ordinal).padStart(2, '0')}`;
}

function historyResponse(ordinal) {
  return `runtime lightweight history response ${String(ordinal).padStart(2, '0')}`;
}

function githubWorkerFixture({ route, method }) {
  const json = (body, kind, status = 200, headers = {}) => ({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
    kind,
  });
  const routes = {
    'GET github-user': json(
      { login: 'runtime-user', avatar_url: null, name: 'Runtime User' },
      'github-token-user',
      200,
      { 'x-oauth-scopes': 'public_repo, gist' },
    ),
    'GET github-starred': json([], 'github-token-stars'),
    'POST github-gists': json({ id: 'runtime-probe-gist' }, 'github-token-gist-create', 201),
    'DELETE github-probe-gist': {
      status: 204,
      contentType: 'application/json',
      body: '',
      kind: 'github-token-gist-delete',
    },
  };
  return routes[`${method} ${route}`] ?? null;
}

function createPagePolicy(pageLabel) {
  return {
    unexpectedRequests: [],
    expectedRequests: [],
    overflow: false,
    interceptionFailure: false,
    close: null,
    handler: pageLabel === null ? githubWorkerFixture : (descriptor) => {
      const { method, route, resourceType } = descriptor;
      if (method === 'GET' && route === 'github-web' && resourceType === 'document') {
        return {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: { 'cache-control': 'no-store' },
          body: `<!doctype html>
<html>
<head><title>Runtime Stars ${pageLabel.toUpperCase()}</title><link rel="icon" href="data:,"></head>
<body>
  <main data-pjax-container>
    <h1>Stars</h1>
    <div id="user-starred-repos">
      <article><a href="/runtime-user/runtime-repo">runtime-user/runtime-repo</a></article>
    </div>
  </main>
</body>
</html>`,
        };
      }
      return githubWorkerFixture(descriptor);
    },
  };
}

async function waitForOptionsReady(page) {
  await page.waitForFunction(() => {
    const refresh = document.querySelector('[data-testid="agent-storage-panel"] button');
    return !!document.querySelector('#agent-provider') && !!refresh && !refresh.disabled;
  }, { timeout: SETUP_TIMEOUT_MS });
}

async function saveGitHubToken(page) {
  runtime.configStep = 'github-field';
  await page.waitForSelector('textarea[placeholder="github_pat_..."]:not([disabled])', {
    visible: true,
    timeout: SETUP_TIMEOUT_MS,
  });
  runtime.configStep = 'github-type';
  await page.evaluate(() => {
    const element = document.querySelector('textarea[placeholder="github_pat_..."]');
    if (!(element instanceof HTMLTextAreaElement)) throw new Error('GitHub credential field is unavailable.');
    element.focus();
    element.select();
  });
  await page.keyboard.type(GITHUB_CREDENTIAL);
  await page.waitForFunction(
    (credential) => (
      document.querySelector('textarea[placeholder="github_pat_..."]')?.value === credential
      && [...document.querySelectorAll('button')].some((button) => (
        /^Save & verify$/i.test(button.textContent?.trim() ?? '') && !button.disabled
      ))
    ),
    { timeout: SETUP_TIMEOUT_MS },
    GITHUB_CREDENTIAL,
  );
  runtime.configStep = 'github-click';
  await clickTextTrusted(page, 'button', /^Save & verify$/i);
  runtime.configStep = 'github-wait';
  await waitUntil(

    () => page.evaluate(() => [...document.querySelectorAll('a')]
      .some((anchor) => anchor.getAttribute('href') === 'https://github.com/runtime-user?tab=stars')),
    SETUP_TIMEOUT_MS,
    'GitHub identity was not confirmed through production Options.',
  );
}

function reconcileExpectedTokenProbeRequestFailure() {
  const expectedCleanup = optionsPolicy.expectedRequests.some((request) => (
    request.method === 'DELETE'
    && request.route === 'github-probe-gist'
    && request.status === 204
  ));
  assert.equal(expectedCleanup, true);
  assert.equal(optionsPolicy.interceptionFailure, false);
  for (let index = pageIssues.length - 1; index >= 0; index -= 1) {
    const issue = pageIssues[index];
    if (
      issue.label === 'phase7c-options'
      && issue.kind === 'request-failed'
      && issue.value === 'DELETE github-probe-gist'
    ) pageIssues.splice(index, 1);
  }
}

async function saveProvider(page) {
  runtime.configStep = 'provider-menu';
  await clickTextTrusted(page, '#agent-provider', /.+/);
  runtime.configStep = 'provider-options';
  await page.waitForSelector('[role="option"]', { visible: true, timeout: SETUP_TIMEOUT_MS });
  await clickTextTrusted(page, '[role="option"]', /^Custom AI service$/i);
  await page.evaluate(() => {
    for (const content of document.querySelectorAll('[role="listbox"][data-state="closed"]')) {
      const animationName = getComputedStyle(content).animationName.split(',')[0]?.trim() ?? '';
      content.dispatchEvent(new AnimationEvent('animationend', { animationName, bubbles: true }));
    }
  });
  runtime.configStep = 'provider-fields';
  runtime.configStep = 'provider-menu-unlock';
  await waitUntil(() => page.evaluate(() => getComputedStyle(document.body).pointerEvents !== 'none'),
    SETUP_TIMEOUT_MS, 'Provider menu did not release its pointer lock.');
  runtime.configStep = 'provider-fields';
  await clickTextTrusted(page, '[data-testid="agent-advanced-settings"] > summary', /.+/);
  runtime.configStep = 'provider-base-ready';
  await page.waitForSelector('#agent-base-url', { visible: true, timeout: SETUP_TIMEOUT_MS });
  runtime.configStep = 'provider-base';
  await typeValue(page, '#agent-base-url', PROVIDER_BASE_URL);
  runtime.configStep = 'provider-protocol';
  await clickTextTrusted(page, 'button', /^Responses API$/i);
  runtime.configStep = 'provider-declared-window';
  await typeValue(page, '#agent-provider-context-window', '32768');
  runtime.configStep = 'provider-working-window';
  await typeValue(page, '#agent-working-context-window', '32768');
  runtime.configStep = 'provider-model';
  await typeValue(page, '#agent-model', MODEL);
  runtime.configStep = 'provider-key';
  await typeValue(page, '#agent-api-key', PROVIDER_CREDENTIAL);
  runtime.configStep = 'provider-permission';
  const permission = { origins: [`${PROVIDER_ORIGIN}/*`] };
  if (!await page.evaluate((details) => chrome.permissions.contains(details), permission)) {
    await clickTextTrusted(page, 'button', /allow access/i);
    await waitUntil(() => page.evaluate((details) => chrome.permissions.contains(details), permission),
      SETUP_TIMEOUT_MS, 'Provider host access was not granted.');
  }
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => (
    /^Save & test$/i.test(button.textContent?.trim() ?? '') && !button.disabled
  )), { timeout: SETUP_TIMEOUT_MS });
  await clickTextTrusted(page, 'button', /^Save & test$/i);
  runtime.configStep = 'provider-save';
  await waitUntil(
    () => page.evaluate(() => [...document.querySelectorAll('[role="status"], [role="alert"], .gsm-status-note')]
      .some((node) => node.textContent?.includes('Saved · Connected'))),
    SETUP_TIMEOUT_MS,
    'Provider connection was not saved through production Options.',
  );
}

async function seedRuntimeRepository(page) {
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('better-github-stars-manager');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('runtime-star-db-open-failed'));
    });
    try {
      const now = '2026-08-09T00:00:00.000Z';
      const transaction = db.transaction(['stars', 'tags'], 'readwrite');
      transaction.objectStore('stars').put({
        full_name: 'runtime-user/runtime-repo',
        html_url: 'https://github.com/runtime-user/runtime-repo',
        description: 'Deterministic packaged Phase 7C repository',
        language: 'TypeScript',
        stargazers_count: 7,
        topics: ['runtime'],
        pushed_at: now,
        created_at: now,
        fork: false,
        archived: false,
        starred_at: now,
        tombstone: false,
        synced_at: now,
      });
      transaction.objectStore('tags').put({
        full_name: 'runtime-user/runtime-repo',
        manualTags: [],
        autoTags: [],
        dismissedAutoTags: [],
        manualTagsMtime: now,
        autoTagsMtime: now,
        dismissedAutoTagsMtime: now,
        notes: '',
        mtime: now,
      });
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(new Error('runtime-star-db-write-failed'));
        transaction.onabort = () => reject(new Error('runtime-star-db-write-aborted'));
      });
    } finally {
      db.close();
    }
  });
}

async function readSafeConfig(page) {
  return page.evaluate(async () => {
    const config = (await chrome.storage.local.get('gsm_config')).gsm_config;
    const agent = config?.agentProvider;
    return {
      username: config?.username ?? null,
      provider: agent?.provider ?? null,
      protocol: agent?.protocol ?? null,
      baseUrl: agent?.baseUrl ?? null,
      model: agent?.model ?? null,
      hasKey: !!agent?.apiKeyEncrypted,
      capabilityReady: agent?.capability?.namedToolRoundTrip === true,
    };
  });
}

async function typeValue(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: SETUP_TIMEOUT_MS });
  await page.evaluate((target, nextValue) => {
    const element = document.querySelector(target);
    if (!(element instanceof HTMLInputElement)) throw new Error('Options input is unavailable.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Native input value setter is unavailable.');
    setter.call(element, nextValue);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: null,
    }));
  }, selector, value);
  await page.waitForFunction((target, expected) => {
    const element = document.querySelector(target);
    return element instanceof HTMLInputElement
      && !element.disabled
      && element.getClientRects().length > 0
      && element.value === expected;
  }, { polling: 50, timeout: SETUP_TIMEOUT_MS }, selector, value);
  const observation = await page.evaluate((target, expected) => {
    const element = document.querySelector(target);
    return {
      present: element instanceof HTMLInputElement,
      enabled: element instanceof HTMLInputElement && !element.disabled,
      visible: element instanceof HTMLInputElement && element.getClientRects().length > 0,
      exact: element instanceof HTMLInputElement && element.value === expected,
    };
  }, selector, value);
  assert.deepEqual(observation, { present: true, enabled: true, visible: true, exact: true });
}

async function clickTextTrusted(page, selector, matcher) {
  const point = await page.evaluate(({ target, source, flags }) => {
    const expression = new RegExp(source, flags);
    const element = [...document.querySelectorAll(target)].find((candidate) => {
      const text = candidate.textContent?.trim() ?? '';
      const disabled = candidate instanceof HTMLButtonElement && candidate.disabled;
      const rect = candidate.getBoundingClientRect();
      return expression.test(text) && !disabled && rect.width > 0 && rect.height > 0;
    });
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { target: selector, source: matcher.source, flags: matcher.flags });
  if (!point) throw new Error('Trusted text target was unavailable.');
  await page.mouse.click(point.x, point.y);
}

async function waitForManager(page) {
  await page.waitForFunction(() => !!document.getElementById('gsm-manager-host')
    ?.shadowRoot?.getElementById('gsm-manager-root'), { timeout: SETUP_TIMEOUT_MS });
}

async function shadowElement(page, selector) {
  const handle = await page.evaluateHandle((target) => document.getElementById('gsm-manager-host')
    ?.shadowRoot?.querySelector(target) ?? null, selector);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new Error('Production ShadowRoot control was unavailable.');
  }
  return element;
}

async function clickShadow(page, selector) {
  const element = await shadowElement(page, selector);
  try {
    await element.focus();
    const focused = await element.evaluate((node) => node.getRootNode().activeElement === node);
    assert.equal(focused, true);
    await page.keyboard.press('Enter');
  } finally {
    await element.dispose();
  }
}

async function waitForAgentEntry(page) {
  await page.waitForFunction(() => (
    !!document.getElementById('gsm-manager-host')
    || !!document.getElementById('gsm-fab')
  ), { timeout: SETUP_TIMEOUT_MS });
  const hasManager = await page.evaluate(() => !!document.getElementById('gsm-manager-host'));
  if (hasManager) return;
  const handle = await page.evaluateHandle(() => (
    document.getElementById('gsm-fab')?.shadowRoot?.querySelector('button') ?? null
  ));
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new Error('Production reload FAB button was unavailable.');
  }
  try {
    await element.click();
  } finally {
    await element.dispose();
  }
  await waitForManager(page);
}

async function fillShadowComposer(page, value) {
  const element = await shadowElement(page, 'aside[role="dialog"] textarea');
  runtime.configStep = 'composer-field';
  try {
    await element.focus();
    const focused = await element.evaluate((node) => node.getRootNode().activeElement === node);
    assert.equal(focused, true);
    runtime.configStep = 'composer-focused';
    const selected = await element.evaluate((node) => {
      node.select();
      return node.selectionStart === 0 && node.selectionEnd === node.value.length;
    });
    assert.equal(selected, true);
    runtime.configStep = 'composer-selected';
    await page.keyboard.press('Backspace');
    runtime.configStep = 'composer-cleared';
    await page.keyboard.type(value);
    runtime.configStep = 'composer-typed';
  } finally {
    await element.dispose();
  }
  await waitUntil(async () => (await readUi(page, { expectedInput: value })).inputExact,
    SETUP_TIMEOUT_MS, 'Trusted composer input did not reach the exact value.');
}

async function submitShadowComposer(page) {
  const element = await shadowElement(page, 'aside[role="dialog"] button[type="submit"]');
  try {
    const buttonEnabled = await element.evaluate((node) => node instanceof HTMLButtonElement && !node.disabled);
    assert.equal(buttonEnabled, true);
    await element.focus();
    const focused = await element.evaluate((node) => node.getRootNode().activeElement === node);
    assert.equal(focused, true);
    await page.keyboard.press('Enter');
  } finally {
    await element.dispose();
  }
}

async function clickSessionItem(page, sessionId) {
  const handle = await page.evaluateHandle((expected) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const row = [...(root?.querySelectorAll('[data-testid="agent-session-item"]') ?? [])]
      .find((candidate) => candidate.getAttribute('data-session-id') === expected);
    return row?.querySelector('button:not([disabled])') ?? null;
  }, sessionId);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new Error('Requested production session item was unavailable.');
  }
  try {
    await element.focus();
    const focused = await element.evaluate((node) => node.getRootNode().activeElement === node);
    assert.equal(focused, true);
    await page.keyboard.press('Enter');
  } finally {
    await element.dispose();
  }
}

async function waitForAgentReady(page) {
  await waitUntil(async () => {
    const ui = await readUi(page);
    return ui.drawer && ui.composerEnabled && ui.sessionToggleEnabled;
  }, SETUP_TIMEOUT_MS, 'Production Agent drawer did not finish durable hydration.');
}

async function inspectCurrentSession(page) {
  await clickShadow(page, '[data-testid="agent-session-toggle"]');
  await waitUntil(async () => (await readUi(page)).sessionMenuOpen,
    SETUP_TIMEOUT_MS, 'Production session menu did not open for inspection.');
  const ui = await readUi(page);
  assert.equal(typeof ui.currentSessionId, 'string');
  const toggle = await shadowElement(page, '[data-testid="agent-session-toggle"]');
  try {
    await toggle.focus();
    const focused = await toggle.evaluate((node) => node.getRootNode().activeElement === node);
    assert.equal(focused, true);
    await page.keyboard.press('Enter');
  } finally {
    await toggle.dispose();
  }
  await waitUntil(async () => !(await readUi(page)).sessionMenuOpen,
    SETUP_TIMEOUT_MS, 'Production session menu did not close after inspection.');
  return { sessionId: ui.currentSessionId, sessionItemCount: ui.sessionItemCount };
}

async function readUi(page, {
  expectedInput = null,
  messageMarker = null,
  winnerMarker = null,
  rejectedMarker = null,
} = {}) {
  return page.evaluate(({ expected, marker, winner, rejected }) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const drawer = root?.querySelector('aside[role="dialog"]');
    const textarea = drawer?.querySelector('textarea');
    const current = root?.querySelector('[data-testid="agent-session-item"] [aria-current="true"]')
      ?.closest('[data-session-id]');
    const userMessages = [...(drawer?.querySelectorAll('[data-role="user"]') ?? [])];
    const assistantMessages = [...(drawer?.querySelectorAll('[data-role="assistant"]') ?? [])]
      .filter((node) => !node.querySelector('[data-testid="agent-streaming-status"]'));
    const messages = [...userMessages, ...assistantMessages];
    const occurrences = (value) => value === null
      ? 0
      : messages.reduce((count, node) => count + ((node.textContent ?? '').split(value).length - 1), 0);
    const errorCard = root?.querySelector('[data-testid="agent-provider-error-card"]');
    const publicError = errorCard?.querySelector('p.font-medium')?.textContent?.trim() ?? '';
    const publicErrorFingerprint = {
      length: publicError.length,
      hash: [...publicError].reduce(
        (hash, character) => Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0,
        2166136261,
      ).toString(16).padStart(8, '0'),
    };
    return {
      mounted: !!root,
      drawer: !!drawer && drawer.getAttribute('aria-hidden') !== 'true',
      composerEnabled: textarea instanceof HTMLTextAreaElement && !textarea.disabled,
      sessionToggleEnabled: !!root?.querySelector('[data-testid="agent-session-toggle"]:not([disabled])'),
      inputExact: expected === null || (textarea instanceof HTMLTextAreaElement && textarea.value === expected),
      currentSessionId: current?.getAttribute('data-session-id') ?? null,
      sessionItemCount: root?.querySelectorAll('[data-testid="agent-session-item"]').length ?? 0,
      sessionMenuOpen: !!root?.querySelector('[data-testid="agent-session-list"]'),
      providerError: !!errorCard,
      publicErrorFingerprint,
      conflictTextExact: publicError === 'Another Cubby turn is already active for this conversation.',
      conflictTextContains: publicError.includes('Another Cubby turn is already active for this conversation.'),
      conflictTextIdentity: publicError === 'Cubby turnAttemptId was reused with conflicting launch data.',
      conflictTextGeneric: publicError === "Cubby couldn't complete this request"
        || publicError.startsWith('Something went wrong:'),
      conflictTextOther: publicError.length === 0
        ? 'conflict-rejected-empty'
        : publicError.includes('active')
          ? 'conflict-rejected-active-other'
          : publicError.includes('confirm') || publicError.includes('recover') || publicError.includes('restart')
            ? 'conflict-rejected-recovery-other'
            : publicError.includes('conversation') || publicError.includes('session')
              ? 'conflict-rejected-session-other'
              : publicError.includes('turn')
                ? 'conflict-rejected-turn-other'
                : publicError.includes('Cubby')
                  ? 'conflict-rejected-cubby-other'
                  : publicError.includes('Agent')
                    ? 'conflict-rejected-agent-other'
                    : publicError.includes('request') || publicError.includes('failed') || publicError.includes('error')
                      ? 'conflict-rejected-request-other'
                      : publicError.includes('state') || publicError.includes('changed')
                        ? 'conflict-rejected-state-other'
                        : 'conflict-rejected-other',
      durableRetry: !!root?.querySelector([
        '[data-testid="agent-durable-retry-button"]:not([disabled])',
        '[data-testid="agent-provider-error-card"] button:not([disabled])',
      ].join(', ')),
      loadEarlier: !!root?.querySelector('[data-testid="agent-load-earlier-messages"]'),
      running: drawer?.getAttribute('data-agent-active') === 'true',
      userMessages: userMessages.length,
      assistantMessages: assistantMessages.length,
      messageMarkerOccurrences: occurrences(marker),
      winnerMessageOccurrences: occurrences(winner),
      rejectedMessageOccurrences: occurrences(rejected),
    };
  }, {
    expected: expectedInput,
    marker: messageMarker,
    winner: winnerMarker,
    rejected: rejectedMarker,
  });
}
async function readHistoryOrder(page, expectedRows) {
  return page.evaluate((expected) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const drawer = root?.querySelector('aside[role="dialog"]');
    const rows = [...(drawer?.querySelectorAll('[data-role="user"], [data-role="assistant"]') ?? [])]
      .filter((node) => !node.querySelector('[data-testid="agent-streaming-status"]'))
      .map((node) => node.textContent?.trim() ?? '');
    const exactOrder = rows.length === expected.length
      && rows.every((value, index) => value === expected[index]);
    const occurrenceOnce = expected.every((value) => rows.filter((row) => row === value).length === 1);
    return { rowCount: rows.length, exactOrder, occurrenceOnce };
  }, expectedRows);
}

async function readCappedSessionIds(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('better-github-stars-manager');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('agent-db-open-failed'));
    });
    try {
      const transaction = db.transaction(['agentSessions'], 'readonly');
      const rows = await new Promise((resolve, reject) => {
        const request = transaction.objectStore('agentSessions').getAll(null, 5);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('agent-db-read-failed'));
      });
      if (!Array.isArray(rows) || rows.length > 4) throw new Error('agent-db-session-row-cap-reached');
      return rows.map(({ id }) => id).filter((id) => typeof id === 'string').sort();
    } finally {
      db.close();
    }
  });
}


async function readAuthority(page, sessionId, markers, knownSessionIds = [sessionId]) {
  return page.evaluate(async ({ requestedSessionId, exactSessionIds, canaries, storeNames }) => {
    const caps = {
      sessions: 4,
      sessionBytes: 256 * 1024,
      attempts: 128,
      attemptBytes: 1024 * 1024,
      recoveries: 64,
      recoveryBytes: 1024 * 1024,
      messages: 256,
      messageBytes: 2 * 1024 * 1024,
    };
    const uniqueSessionIds = [...new Set(exactSessionIds)];
    if (
      uniqueSessionIds.length === 0
      || uniqueSessionIds.length > caps.sessions
      || !uniqueSessionIds.includes(requestedSessionId)
    ) throw new Error('agent-db-session-key-cap-reached');
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('better-github-stars-manager');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('agent-db-open-failed'));
    });
    const requestValue = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('agent-db-read-failed'));
    });
    const encoder = new TextEncoder();
    const serializedBytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;
    const readCappedIndex = (index, range, rowCap, byteCap) => new Promise((resolve, reject) => {
      const rows = [];
      let bytes = 0;
      const request = index.openCursor(range);
      request.onerror = () => reject(new Error('agent-db-index-read-failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve({ rows, bytes });
          return;
        }
        if (rows.length >= rowCap) {
          reject(new Error('agent-db-read-row-cap-reached'));
          return;
        }
        let rowBytes;
        try {
          rowBytes = serializedBytes(cursor.value);
        } catch {
          reject(new Error('agent-db-row-size-unavailable'));
          return;
        }
        if (bytes + rowBytes > byteCap) {
          reject(new Error('agent-db-read-byte-cap-reached'));
          return;
        }
        bytes += rowBytes;
        rows.push(cursor.value);
        cursor.continue();
      };
    });
    const occurrenceCount = (value, marker) => {
      if (typeof value !== 'string' || marker.length === 0) return 0;
      let count = 0;
      let offset = 0;
      while (offset < value.length) {
        const index = value.indexOf(marker, offset);
        if (index === -1) return count;
        count += 1;
        offset = index + marker.length;
      }
      return count;
    };
    const db = await open();
    try {
      const transaction = db.transaction(storeNames, 'readonly');
      const transactionDone = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(new Error('agent-db-transaction-failed'));
        transaction.onabort = () => reject(new Error('agent-db-transaction-aborted'));
      });
      const sessionStore = transaction.objectStore('agentSessions');
      const attemptIndex = transaction.objectStore('agentAttempts').index('sessionId');
      const recoveryIndex = transaction.objectStore('agentAttemptRecoveries').index('sessionId');
      const messageIndex = transaction.objectStore('agentMessages').index('sessionId');
      const range = IDBKeyRange.only(requestedSessionId);
      const [sessions, attemptScan, recoveryScan, messageScan] = await Promise.all([
        Promise.all(uniqueSessionIds.map((id) => requestValue(sessionStore.get(id)))),
        readCappedIndex(attemptIndex, range, caps.attempts, caps.attemptBytes),
        readCappedIndex(recoveryIndex, range, caps.recoveries, caps.recoveryBytes),
        readCappedIndex(messageIndex, range, caps.messages, caps.messageBytes),
      ]);
      await transactionDone;
      if (sessions.reduce((bytes, row) => bytes + serializedBytes(row), 0) > caps.sessionBytes) {
        throw new Error('agent-db-session-byte-cap-reached');
      }
      const attempts = attemptScan.rows;
      const recoveries = recoveryScan.rows;
      const messages = messageScan.rows;
      const session = sessions[uniqueSessionIds.indexOf(requestedSessionId)];
      const sequences = messages.map((row) => row.sequence).sort((a, b) => a - b);
      const ids = messages.map((row) => row.id);
      const stateNames = ['running', 'stop_pending', 'retryable', 'committed', 'state_uncertain', 'terminal_non_retryable'];
      const reasonNames = ['retried', 'superseded', 'dismissed', 'abandoned'];
      const canaryOccurrences = {
        secrets: 0,
        submitted: 0,
        providerResponse: 0,
        neverSubmitted: 0,
        rejected: 0,
      };
      const markerMap = [
        ['secrets', canaries[0]],
        ['secrets', canaries[1]],
        ['submitted', canaries[2]],
        ['providerResponse', canaries[3]],
        ['neverSubmitted', canaries[4]],
        ['rejected', canaries[5]],
      ];
      const sensitiveTexts = [
        ...messages.map((row) => row.content),
        ...attempts.map((row) => row.admittedLaunch?.prompt),
      ];
      for (const value of sensitiveTexts) {
        for (const [key, marker] of markerMap) canaryOccurrences[key] += occurrenceCount(value, marker);
      }
      return {
        knownSessionCount: sessions.filter(Boolean).length,
        sessionCount: session ? 1 : 0,
        attemptCount: attempts.length,
        recoveryCount: recoveries.length,
        messageCount: messages.length,
        firstSequence: sequences[0] ?? null,
        lastSequence: sequences.at(-1) ?? null,
        sequenceGaps: sequences.reduce((count, sequence, index) => (
          index === 0 || sequence === sequences[index - 1] + 1 ? count : count + 1
        ), 0),
        duplicateIds: ids.length - new Set(ids).size,
        roleCounts: {
          user: messages.filter((row) => row.role === 'user').length,
          assistant: messages.filter((row) => row.role === 'agent').length,
          other: messages.filter((row) => row.role !== 'user' && row.role !== 'agent').length,
        },
        stateCounts: Object.fromEntries(stateNames.map((state) => [state, attempts.filter((row) => row.state === state).length])),
        terminalReasonCounts: Object.fromEntries(reasonNames.map((reason) => [reason, attempts.filter((row) => row.terminalReason === reason).length])),
        nonNoneWriteSettlements: attempts.filter((row) => row.writeSettlement !== null && row.writeSettlement !== 'none').length,
        canaryOccurrences,
      };
    } finally {
      db.close();
    }
  }, {
    requestedSessionId: sessionId,
    exactSessionIds: knownSessionIds,
    canaries: markers,
    storeNames: AGENT_STORES,
  });
}

async function installWorkerPortMonitor(worker, markers) {
  await worker.evaluate((canaries) => {
    if (globalThis.__phase7cPortMonitor) throw new Error('phase7c-monitor-already-installed');
    const state = {
      connections: 0,
      starts: 0,
      stops: 0,
      resumeOnlySubmittedStarts: 0,
      resumeOnlyRejectedStarts: 0,
      resumeOnlyNeverSubmittedStarts: 0,
      standardSubmittedStarts: 0,
      standardRejectedStarts: 0,
      standardNeverSubmittedStarts: 0,
      ports: new Set(),
    };
    const onConnect = (port) => {
      if (port.name !== 'bgsm-agent') return;
      state.connections += 1;
      state.ports.add(port);
      const onMessage = (message) => {
        if (message?.type === 'stopBgsmAgentTurn') {
          state.stops += 1;
          return;
        }
        if (message?.type !== 'startBgsmAgentTurn') return;
        state.starts += 1;
        const prompt = typeof message.prompt === 'string' ? message.prompt : '';
        const resumeOnly = message.resumeOnly === true;
        if (prompt === canaries.submitted) {
          if (resumeOnly) state.resumeOnlySubmittedStarts += 1;
          else state.standardSubmittedStarts += 1;
        }
        if (prompt === canaries.rejected) {
          if (resumeOnly) state.resumeOnlyRejectedStarts += 1;
          else state.standardRejectedStarts += 1;
        }
        if (prompt === canaries.neverSubmitted) {
          if (resumeOnly) state.resumeOnlyNeverSubmittedStarts += 1;
          else state.standardNeverSubmittedStarts += 1;
        }
      };
      const onDisconnect = () => {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        state.ports.delete(port);
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
    };
    chrome.runtime.onConnect.addListener(onConnect);
    globalThis.__phase7cPortMonitor = {
      snapshot() {
        return {
          connections: state.connections,
          starts: state.starts,
          stops: state.stops,
          resumeOnlySubmittedStarts: state.resumeOnlySubmittedStarts,
          resumeOnlyRejectedStarts: state.resumeOnlyRejectedStarts,
          resumeOnlyNeverSubmittedStarts: state.resumeOnlyNeverSubmittedStarts,
          standardSubmittedStarts: state.standardSubmittedStarts,
          standardRejectedStarts: state.standardRejectedStarts,
          standardNeverSubmittedStarts: state.standardNeverSubmittedStarts,
          connectedPorts: state.ports.size,
        };
      },
      disconnectAll() {
        for (const port of [...state.ports]) {
          try {
            port.disconnect();
          } finally {
            state.ports.delete(port);
          }
        }
      },
      dispose() {
        chrome.runtime.onConnect.removeListener(onConnect);
        delete globalThis.__phase7cPortMonitor;
      },
    };
  }, markers);
}

async function readWorkerPortMonitor(worker) {
  return worker.evaluate(() => globalThis.__phase7cPortMonitor?.snapshot?.() ?? null);
}

async function waitForProviderHold(control, label, timeoutMs) {
  await waitUntil(() => control.hasHeldResponse(label), timeoutMs, 'Controlled Provider response was not held.');
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function buildEvidence() {
  const scenarioCaptures = provider.capture.slice(2);
  assert.equal(runtime.facts.detachWithoutStop, true);
  return createUiHistoryEvidence({
    releaseDist,
    scenarios: {
      atomic: runtime.facts.atomic,
      pageLocal: runtime.facts.pageLocal,
      subscription: runtime.facts.subscription,
      conflict: runtime.facts.conflict,
      retry: runtime.facts.retry,
      history: runtime.facts.history,
    },
    providerFacts: {
      requests: provider.capture.length,
      connectionRequests: 2,
      scenarioRequests: scenarioCaptures.length,
      http503Responses: provider.capture.filter((entry) => entry.httpStatus === 503).length,
      selectedScenarioTools: scenarioCaptures.filter((entry) => entry.toolNames?.selected !== null).length,
      authenticatedRequests: provider.capture.filter((entry) => entry.authorizationPresent === true).length,
      failures: provider.failures.length,
      interruptions: provider.interruptions.length,
    },
    networkFacts: {
      browserFailClosed: runtime.networkIsolation,
      workerFixtures: new Set(provider.httpFixtureCapture.map((entry) => (
        `${entry.method}\0${entry.route}\0${entry.status}\0${entry.kind}`
      ))).size,
      workerUnexpected: provider.unexpectedRequests.length,
      pageExpected: optionsPolicy.expectedRequests.length + pageAPolicy.expectedRequests.length + pageBPolicy.expectedRequests.length,
      pageUnexpected: optionsPolicy.unexpectedRequests.length + pageAPolicy.unexpectedRequests.length + pageBPolicy.unexpectedRequests.length,
      pageIssues: pageIssues.length,
      overflow: Object.values(provider.overflow).some(Boolean)
        || optionsPolicy.overflow || pageAPolicy.overflow || pageBPolicy.overflow,
    },
    canaryFacts: {
      secretDurableOccurrences: runtime.facts.finalAuthority.canaryOccurrences.secrets,
      secretEvidenceOccurrences: 0,
      submittedDurableOccurrences: runtime.facts.finalAuthority.canaryOccurrences.submitted,
      submittedProviderAssociations: 1,
      providerResponseDurableOccurrences: runtime.facts.finalAuthority.canaryOccurrences.providerResponse,
      neverSubmittedDurableOccurrences: runtime.facts.finalAuthority.canaryOccurrences.neverSubmitted,
      neverSubmittedProviderOccurrences: 0,
      rejectedDurableOccurrences: runtime.facts.finalAuthority.canaryOccurrences.rejected,
      rejectedProviderOccurrences: 0,
    },
    containment: {
      networkFailClosed: runtime.networkIsolation,
      unexpectedNetworkRequests: provider.unexpectedRequests.length
        + optionsPolicy.unexpectedRequests.length
        + pageAPolicy.unexpectedRequests.length
        + pageBPolicy.unexpectedRequests.length,
      rawCredentialOccurrences: 0,
      privatePayloadOccurrences: 0,
      overflow: Object.values(provider.overflow).some(Boolean)
        || optionsPolicy.overflow || pageAPolicy.overflow || pageBPolicy.overflow,
    },
    cleanup: {
      networkGatesClosed: !runtime.monitorInstalled
        && provider.closed === true
        && runtime.pagePoliciesClosed,
      diagnosticsDetached: runtime.diagnosticsDetached,
      pagesClosed: runtime.pagesClosed,
      browserClosed: runtime.browserClosed,
      temporaryStateRemoved: runtime.profileRemoved,
    },
  });
}

function createUiHistoryEvidence({
  releaseDist: identity,
  scenarios,
  providerFacts,
  networkFacts,
  canaryFacts,
  containment,
  cleanup,
}) {
  return {
    schemaVersion: 1,
    status: 'passed',
    proofScope: 'packaged_ui_history',
    productionDistExercised: true,
    releaseDist: identity,
    uiHistory: {
      scenarios,
      provider: providerFacts,
      network: networkFacts,
      canary: canaryFacts,
    },
    containment,
    cleanup,
    evidenceBytes: 0,
  };
}

function validateUiHistoryEvidence(value) {
  assertExactKeys(value, ['schemaVersion', 'status', 'proofScope', 'productionDistExercised', 'releaseDist', 'uiHistory', 'containment', 'cleanup', 'evidenceBytes']);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.status, 'passed');
  assert.equal(value.proofScope, 'packaged_ui_history');
  assert.equal(value.productionDistExercised, true);
  assertRuntimeReleaseDistIdentity(value.releaseDist);
  assertExactKeys(value.uiHistory, ['scenarios', 'provider', 'network', 'canary']);
  assertExactKeys(value.uiHistory.scenarios, ['atomic', 'pageLocal', 'subscription', 'conflict', 'retry', 'history']);
  assertExactKeys(value.uiHistory.scenarios.atomic, ['sessionRows', 'sameSession']);
  assertExactKeys(value.uiHistory.scenarios.pageLocal, ['sessionRows', 'pageAPickedNew', 'pageBStayedLocal']);
  assertExactKeys(value.uiHistory.scenarios.subscription, ['resumeOnlyWinnerStarts', 'resumeOnlyRejectedStarts', 'providerDelta', 'providerRequests', 'sessionRows', 'attemptRows', 'committedRows', 'terminalPages']);
  assertExactKeys(value.uiHistory.scenarios.conflict, ['typed', 'exactPublicText', 'domRollback', 'inputRetainedBefore', 'inputRetainedAfter', 'composerEnabledAfter', 'sessionDelta', 'attemptDelta', 'providerDelta', 'messageDelta']);
  assertExactKeys(value.uiHistory.scenarios.retry, ['httpStatus', 'requestDelta', 'attemptDelta', 'sourceRetried', 'committed', 'writeSettlementsNone', 'selectedTools']);
  assertExactKeys(value.uiHistory.scenarios.history, ['lightweightTurns', 'canonicalRows', 'userRows', 'assistantRows', 'recentRows', 'loadedRows', 'recentExactOrder', 'fullExactOrder', 'occurrenceOnce', 'firstSequence', 'lastSequence', 'gaps', 'duplicateIds', 'finalCursorNull']);
  assertExactKeys(value.uiHistory.provider, ['requests', 'connectionRequests', 'scenarioRequests', 'http503Responses', 'selectedScenarioTools', 'authenticatedRequests', 'failures', 'interruptions']);
  assertExactKeys(value.uiHistory.network, ['browserFailClosed', 'workerFixtures', 'workerUnexpected', 'pageExpected', 'pageUnexpected', 'pageIssues', 'overflow']);
  assertExactKeys(value.uiHistory.canary, ['secretDurableOccurrences', 'secretEvidenceOccurrences', 'submittedDurableOccurrences', 'submittedProviderAssociations', 'providerResponseDurableOccurrences', 'neverSubmittedDurableOccurrences', 'neverSubmittedProviderOccurrences', 'rejectedDurableOccurrences', 'rejectedProviderOccurrences']);
  assertExactKeys(value.containment, ['networkFailClosed', 'unexpectedNetworkRequests', 'rawCredentialOccurrences', 'privatePayloadOccurrences', 'overflow']);
  assertExactKeys(value.cleanup, ['networkGatesClosed', 'diagnosticsDetached', 'pagesClosed', 'browserClosed', 'temporaryStateRemoved']);

  const { scenarios, provider: providerFacts, network, canary } = value.uiHistory;
  assert.equal(network.workerUnexpected, 0);
  assert.equal(network.pageUnexpected, 0);
  assert.equal(network.pageIssues, 0);
  assert.equal(network.overflow, false);
  assert.equal(providerFacts.failures, 0);
  assert.equal(providerFacts.selectedScenarioTools, 0);
  assert.equal(providerFacts.http503Responses, 1);
  assert.equal(providerFacts.interruptions, 0);
  assert.equal(providerFacts.authenticatedRequests, providerFacts.requests);
  assert.deepEqual(scenarios.atomic, { sessionRows: 1, sameSession: true });
  assert.deepEqual(scenarios.pageLocal, {
    sessionRows: 2,
    pageAPickedNew: true,
    pageBStayedLocal: true,
  });
  assert.deepEqual(scenarios.subscription, {
    resumeOnlyWinnerStarts: 1,
    resumeOnlyRejectedStarts: 0,
    providerDelta: 0,
    providerRequests: 1,
    sessionRows: 1,
    attemptRows: 1,
    committedRows: 1,
    terminalPages: 2,
  });
  assert.equal(scenarios.conflict.inputRetainedBefore, true);
  assert.equal(scenarios.conflict.sessionDelta, 0);
  assert.equal(scenarios.conflict.attemptDelta, 0);
  assert.equal(scenarios.conflict.providerDelta, 0);
  assert.equal(scenarios.conflict.messageDelta, 0);
  assert.deepEqual(scenarios.retry, {
    httpStatus: 503,
    requestDelta: 1,
    attemptDelta: 1,
    sourceRetried: 1,
    committed: 1,
    writeSettlementsNone: 2,
    selectedTools: 0,
  });
  assert.equal(scenarios.history.lightweightTurns, 50);
  assert.equal(scenarios.history.canonicalRows, 104);
  assert.equal(scenarios.history.userRows, 52);
  assert.equal(scenarios.history.assistantRows, 52);
  assert.equal(scenarios.history.recentRows, 100);
  assert.equal(scenarios.history.loadedRows, 104);
  assert.equal(scenarios.history.firstSequence, 1);
  assert.equal(scenarios.history.lastSequence, 104);
  assert.equal(scenarios.history.gaps, 0);
  assert.equal(scenarios.history.duplicateIds, 0);
  assert.equal(scenarios.conflict.typed, true);
  assert.equal(scenarios.conflict.exactPublicText, true);
  assert.equal(scenarios.conflict.domRollback, true);
  assert.equal(scenarios.conflict.inputRetainedAfter, true);
  assert.equal(scenarios.conflict.composerEnabledAfter, true);
  assert.equal(scenarios.history.recentExactOrder, true);
  assert.equal(scenarios.history.fullExactOrder, true);
  assert.equal(scenarios.history.occurrenceOnce, true);
  assert.equal(scenarios.history.finalCursorNull, true);
  assert.equal(canary.secretDurableOccurrences, 0);
  assert.equal(canary.secretEvidenceOccurrences, 0);
  assert.equal(canary.submittedDurableOccurrences, 2);
  assert.equal(canary.submittedProviderAssociations, 1);
  assert.equal(canary.providerResponseDurableOccurrences, 1);
  assert.equal(canary.neverSubmittedDurableOccurrences, 0);
  assert.equal(canary.neverSubmittedProviderOccurrences, 0);
  assert.equal(canary.rejectedDurableOccurrences, 0);
  assert.equal(canary.rejectedProviderOccurrences, 0);
  assert.deepEqual(value.containment, {
    networkFailClosed: true,
    unexpectedNetworkRequests: 0,
    rawCredentialOccurrences: 0,
    privatePayloadOccurrences: 0,
    overflow: false,
  });
  assert.equal(Object.values(value.cleanup).every((entry) => entry === true), true);
  assert.equal(Number.isSafeInteger(value.evidenceBytes)
    && value.evidenceBytes > 0
    && value.evidenceBytes <= MAX_RUNTIME_EVIDENCE_BYTES, true);
}

function assertExactKeys(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value), keys);
}

function publishEvidence(evidence, { silent = false } = {}) {
  const directory = process.env.GSM_RUNTIME_EVIDENCE_DIR;
  const options = {
    validateEvidence: validateUiHistoryEvidence,
    privateMarkers: PRIVATE_MARKERS,
  };
  if (directory) {
    publishRuntimeEvidence({
      directory,
      filename: 'agent-ui-history.schema-v1.json',
      evidence,
      ...options,
    });
  } else {
    serializeRuntimeEvidence(evidence, options);
  }
  if (!silent) {
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      proofScope: evidence.proofScope,
      providerRequests: evidence.uiHistory.provider.requests,
      canonicalRows: evidence.uiHistory.scenarios.history.canonicalRows,
      unexpectedNetworkRequests: evidence.containment.unexpectedNetworkRequests,
      evidenceBytes: evidence.evidenceBytes,
    })}\n`);
  }
}
async function runEvidenceSelfTest() {
  const identity = {
    packageInput: { algorithm: 'sha256', fileCount: 4, sha256: 'a'.repeat(64) },
    manifest: {
      relativePath: 'manifest.json',
      bytes: 128,
      sha256: 'b'.repeat(64),
      manifestVersion: 3,
      extensionVersion: '1.0.8',
    },
    loader: { relativePath: 'service-worker-loader.js', bytes: 32, sha256: 'c'.repeat(64) },
    worker: { relativePath: 'assets/service-worker.js', bytes: 642_979, sha256: 'd'.repeat(64) },
  };
  const evidence = createUiHistoryEvidence({
    releaseDist: identity,
    scenarios: {
      atomic: { sessionRows: 1, sameSession: true },
      pageLocal: { sessionRows: 2, pageAPickedNew: true, pageBStayedLocal: true },
      subscription: {
        resumeOnlyWinnerStarts: 1,
        resumeOnlyRejectedStarts: 0,
        providerDelta: 0,
        providerRequests: 1,
        sessionRows: 1,
        attemptRows: 1,
        committedRows: 1,
        terminalPages: 2,
      },
      conflict: {
        typed: true,
        exactPublicText: true,
        domRollback: true,
        inputRetainedBefore: true,
        inputRetainedAfter: true,
        composerEnabledAfter: true,
        sessionDelta: 0,
        attemptDelta: 0,
        providerDelta: 0,
        messageDelta: 0,
      },
      retry: {
        httpStatus: 503,
        requestDelta: 1,
        attemptDelta: 1,
        sourceRetried: 1,
        committed: 1,
        writeSettlementsNone: 2,
        selectedTools: 0,
      },
      history: {
        lightweightTurns: 50,
        canonicalRows: 104,
        userRows: 52,
        assistantRows: 52,
        recentRows: 100,
        loadedRows: 104,
        recentExactOrder: true,
        fullExactOrder: true,
        occurrenceOnce: true,
        firstSequence: 1,
        lastSequence: 104,
        gaps: 0,
        duplicateIds: 0,
        finalCursorNull: true,
      },
    },
    providerFacts: {
      requests: 55,
      connectionRequests: 2,
      scenarioRequests: 53,
      http503Responses: 1,
      selectedScenarioTools: 0,
      authenticatedRequests: 55,
      failures: 0,
      interruptions: 0,
    },
    networkFacts: {
      browserFailClosed: true,
      workerFixtures: 55,
      workerUnexpected: 0,
      pageExpected: 3,
      pageUnexpected: 0,
      pageIssues: 0,
      overflow: false,
    },
    canaryFacts: {
      secretDurableOccurrences: 0,
      secretEvidenceOccurrences: 0,
      submittedDurableOccurrences: 2,
      submittedProviderAssociations: 1,
      providerResponseDurableOccurrences: 1,
      neverSubmittedDurableOccurrences: 0,
      neverSubmittedProviderOccurrences: 0,
      rejectedDurableOccurrences: 0,
      rejectedProviderOccurrences: 0,
    },
    containment: {
      networkFailClosed: true,
      unexpectedNetworkRequests: 0,
      rawCredentialOccurrences: 0,
      privatePayloadOccurrences: 0,
      overflow: false,
    },
    cleanup: {
      networkGatesClosed: true,
      diagnosticsDetached: true,
      pagesClosed: true,
      browserClosed: true,
      temporaryStateRemoved: true,
    },
  });
  serializeRuntimeEvidence(evidence, {
    validateEvidence: validateUiHistoryEvidence,
    privateMarkers: PRIVATE_MARKERS,
  });
  assert.throws(() => serializeRuntimeEvidence({ ...evidence, uiHistory: { ...evidence.uiHistory, unexpected: true } }, {
    validateEvidence: validateUiHistoryEvidence,
    privateMarkers: PRIVATE_MARKERS,
  }));
  publishEvidence(evidence, { silent: true });
}


function privateEvidenceExcluded(value) {
  const serialized = JSON.stringify(value) ?? '';
  if (PRIVATE_MARKERS.some((marker) => serialized.includes(marker))) return false;
  if (/https?:\/\//i.test(serialized)) return false;
  const forbiddenKeys = new Set(['error', 'url', 'urls', 'header', 'headers', 'body', 'dom', 'prompt', 'prompts', 'transcript', 'credentials']);
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return true;
    if (Array.isArray(candidate)) return candidate.every(visit);
    return Object.entries(candidate).every(([key, nested]) => !forbiddenKeys.has(key.toLowerCase()) && visit(nested));
  };
  return visit(value);
}


function boundedDiagnosticFallback() {
  return {
    schemaVersion: 1,
    status: 'failed',
    proofScope: 'packaged_ui_history',
    stage: 'unknown',
    code: 'diagnostic_rejected',
    configStep: 'unknown',
    providerRequests: 0,
    providerFailures: 0,
    workerUnexpected: 0,
    pageUnexpected: 0,
    pageIssueCount: 0,
    pageIssueKinds: [],
    conflictErrorFingerprint: null,
    cleanupFailures: runtime.cleanupFailures,
  };
}

function safeConfigStep(value) {
  if (/^history-turn-(?:[1-9]|[1-4][0-9]|50)-(?:waiting|marker-running|settled-missing|ready)$/.test(value)) return value;
  if (/^containment-resume-total-[0-9]$/.test(value)) return value;
  return [
    'history-turns-complete', 'history-authority-asserted', 'history-reload-started',
    'history-reload-loaded', 'history-manager-ready', 'history-agent-ready',
    'history-recent-hydrated', 'history-load-earlier-clicked', 'history-full-hydrated',
    'history-reload-drawer-closed',
    'containment-provider-start', 'containment-provider-healthy',
    'containment-provider-asserted', 'containment-page-policies',
    'containment-page-diagnostics', 'containment-monitor-read',
    'containment-monitor-asserted',
    'teardown-release-held', 'teardown-page', 'teardown-port-detach',
    'teardown-unexpected-stop', 'teardown-monitor-unavailable', 'teardown-monitor',
    'teardown-diagnostic', 'teardown-page-policy', 'teardown-provider',
    'teardown-port-disconnect',
    'teardown-browser', 'teardown-profile',
    'not-started', 'open-options', 'options-open', 'options-ready', 'github-field',
    'github-type', 'github-click', 'github-wait', 'github-saved', 'provider-menu',
    'provider-options', 'provider-fields', 'provider-base-ready', 'provider-menu-unlock',
    'provider-base', 'provider-protocol', 'provider-declared-window', 'provider-working-window',
    'provider-model', 'provider-key', 'provider-permission', 'provider-save', 'provider-saved',
    'atomic-click', 'atomic-ready', 'atomic-ui', 'atomic-authority', 'atomic-menu-open',
    'atomic-menu-close', 'atomic-assert', 'page-local-create', 'page-local-catalog',
    'page-local-inspect', 'page-local-switch-open', 'page-local-switch-settle',
    'page-local-switch-clicked', 'page-local-switch-closed', 'page-local-switch-inspect',
    'composer-open', 'composer-first', 'composer-second', 'composer-ready',
    'composer-field', 'composer-focused', 'composer-selected', 'composer-cleared', 'composer-typed',
    'conflict-error-none', 'conflict-error-none-authentication', 'conflict-error-none-configuration',
    'conflict-error-cannot-read', 'conflict-error-not-function', 'conflict-error-invalid',
    'conflict-error-message-session', 'conflict-error-message-scope', 'conflict-error-message-provider',
    'conflict-error-message-configuration', 'conflict-error-message-transaction',
    'conflict-error-message-clone',
    'conflict-error-none-provider', 'conflict-error-none-other', 'conflict-error-other',
    'submit-field', 'submit-enabled', 'submit-focused', 'submit-event', 'submit-click-only',
    'submit-entered', 'submit-react-cleared', 'submit-react-missed', 'conflict-submit', 'conflict-port',
    'conflict-standard-port', 'conflict-resume-port', 'conflict-running', 'conflict-no-attempt',
    'conflict-settled-early', 'conflict-error-not-found', 'conflict-error-revision',
    'conflict-error-active', 'conflict-error-attempt', 'conflict-error-lease', 'conflict-error-corrupt',
    'conflict-resume-observed',
    'conflict-provider-asserted', 'conflict-authority-asserted', 'conflict-starts-asserted',
    'conflict-resume-asserted', 'conflict-resume-rejected-asserted',
    'conflict-standard-rejected-asserted',
    'conflict-resume-never-asserted', 'conflict-standard-submitted-asserted',
    'conflict-response-released', 'conflict-winner-converged',
    'conflict-terminal-session-count', 'conflict-terminal-known-count',
    'conflict-terminal-attempt-count', 'conflict-terminal-committed-count',
    'conflict-terminal-message-count', 'conflict-terminal-role-count',
    'conflict-terminal-user-role-count', 'conflict-terminal-assistant-role-count',
    'conflict-terminal-canary-count',
    'conflict-error-quota', 'conflict-error-capacity', 'conflict-error-artifact',
    'conflict-error-state-lost', 'conflict-error-coverage', 'conflict-error-epoch',
    'conflict-error-preflight-revision', 'conflict-error-scope-candidate',
    'conflict-held', 'conflict-authority', 'conflict-secondary',
    'conflict-capture-held', 'conflict-capture-unheld',
    'provider-handler', 'provider-handler-connection', 'provider-handler-connection-complete',
    'provider-handler-held', 'provider-handler-unscripted',
    'conflict-final-resume-winner', 'conflict-final-no-resume',
    'conflict-final-resume-copy-other', 'conflict-final-standard-no-resume-copy-other',
    'conflict-provider-before-two', 'conflict-provider-before-other',
    'conflict-rejected-submitted', 'conflict-rejected-ready',
    'conflict-rejected-input-missing', 'conflict-rejected-prefixed',
    'conflict-rejected-identity', 'conflict-rejected-generic',
    'conflict-rejected-empty', 'conflict-rejected-active-other', 'conflict-rejected-recovery-other',
    'conflict-rejected-session-other', 'conflict-rejected-turn-other', 'conflict-rejected-cubby-other',
    'conflict-rejected-agent-other', 'conflict-rejected-request-other',
    'conflict-rejected-state-other', 'conflict-rejected-other',
    'conflict-rejected-resume-winner', 'conflict-rejected-standard',
    'conflict-rejected-other-start', 'conflict-rejected-local-error',
    'conflict-rejected-resume-copy-other', 'conflict-rejected-standard-copy-other',
  ].includes(value) ? value : 'unknown';
}

async function boundedDiagnostic(error) {
  const stageNames = new Set([
    'manifest', 'launch', 'extension', 'gates', 'configuration', 'open-pages', 'atomic',
    'page-local', 'never-submitted', 'conflict', 'retry', 'history', 'containment', 'teardown',
  ]);
  return {
    schemaVersion: 1,
    status: 'failed',
    proofScope: 'packaged_ui_history',
    stage: stageNames.has(runtime.stage) ? runtime.stage : 'unknown',
    code: failureCode(error),
    configStep: safeConfigStep(runtime.configStep),
    providerRequests: provider?.capture?.length ?? 0,
    providerFailures: provider?.failures?.length ?? 0,
    workerUnexpected: provider?.unexpectedRequests?.length ?? 0,
    pageUnexpected: optionsPolicy.unexpectedRequests.length + pageAPolicy.unexpectedRequests.length + pageBPolicy.unexpectedRequests.length,
    pageIssueCount: pageIssues.length,
    pageIssueKinds: pageIssues.map(({ label, kind, value }) => (
      `${label}:${kind}${value ? `:${value}` : ''}`
    )),
    conflictErrorFingerprint: runtime.conflictErrorFingerprint,
    cleanupFailures: runtime.cleanupFailures,
  };
}
function serializeBoundedDiagnostic(value) {
  const expectedKeys = [
    'schemaVersion', 'status', 'proofScope', 'stage', 'code', 'configStep',
    'providerRequests', 'providerFailures', 'workerUnexpected', 'pageUnexpected',
    'pageIssueCount', 'pageIssueKinds', 'conflictErrorFingerprint', 'cleanupFailures',
  ];
  const exactKeys = value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expectedKeys].sort().join('\0');
  let candidate = exactKeys && privateEvidenceExcluded(value) ? value : boundedDiagnosticFallback();
  let serialized = JSON.stringify(candidate);
  if (Buffer.byteLength(serialized) === 0 || Buffer.byteLength(serialized) > MAX_RUNTIME_EVIDENCE_BYTES) {
    candidate = boundedDiagnosticFallback();
    serialized = JSON.stringify(candidate);
  }
  return serialized;
}

function failureCode(error) {
  if (error?.name === 'AssertionError') return 'assertion';
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error?.name === 'TypeError') return 'type';
  if (error?.name === 'RangeError') return 'range';
  return 'runtime';
}

async function teardown() {
  runtime.stage = 'teardown';
  const failures = [];
  const attempt = async (name, operation) => {
    try {
      await operation();
      return true;
    } catch {
      failures.push(name);
      return false;
    }
  };

  if (provider?.heldInterceptions?.size > 0) {
    for (const label of [...provider.heldInterceptions.keys()]) {
      await attempt('release-held', () => provider.releaseHeldResponse(label));
    }
  }
  for (const page of [pageA, pageB]) {
    if (!page || page.isClosed?.()) continue;
    await attempt('page', async () => {
      if (!(await readUi(page)).drawer) return;
      await page.keyboard.press('Escape');
      await waitUntil(async () => !(await readUi(page)).drawer,
        SETUP_TIMEOUT_MS, 'Production Agent drawer did not close during teardown.');
    });
  }
  const monitorBeforeDetach = runtime.monitorInstalled && worker
    ? await readWorkerPortMonitor(worker).catch(() => null)
    : null;
  for (const page of [pageA, pageB, optionsPage]) {
    if (page && !page.isClosed?.()) {
      await attempt('page', async () => {
        if (page === pageA || page === pageB) {
          await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: SETUP_TIMEOUT_MS });
        }
        await page.close();
      });
    }
  }
  runtime.pagesClosed = [pageA, pageB, optionsPage].every((page) => !page || page.isClosed?.());
  if (runtime.monitorInstalled && worker && monitorBeforeDetach) {
    await attempt('port-disconnect', () => worker.evaluate(() => (
      globalThis.__phase7cPortMonitor?.disconnectAll?.()
    )));
    await attempt('port-detach', () => waitUntil(async () => (
      (await readWorkerPortMonitor(worker)).connectedPorts === 0
    ), 5_000, 'Agent ports did not detach after page close.'));
    const monitorAfterDetach = await readWorkerPortMonitor(worker).catch(() => null);
    if (!monitorAfterDetach || monitorAfterDetach.stops !== monitorBeforeDetach.stops) failures.push('unexpected-stop');
    else runtime.facts.detachWithoutStop = true;
    await attempt('monitor', () => worker.evaluate(() => globalThis.__phase7cPortMonitor?.dispose?.()));
    runtime.monitorInstalled = false;
  } else if (runtime.monitorInstalled) {
    failures.push('monitor-unavailable');
    if (worker) await attempt('monitor', () => worker.evaluate(() => globalThis.__phase7cPortMonitor?.dispose?.()));
    runtime.monitorInstalled = false;
  }
  let diagnosticsDetached = true;
  for (const diagnostic of [pageADiagnostics, pageBDiagnostics, optionsDiagnostics]) {
    diagnosticsDetached = await attempt('diagnostic', async () => diagnostic?.cleanup?.())
      && diagnosticsDetached;
  }
  runtime.diagnosticsDetached = diagnosticsDetached;
  let pagePoliciesClosed = true;
  for (const policy of [pageAPolicy, pageBPolicy, optionsPolicy]) {
    pagePoliciesClosed = await attempt('page-policy', async () => policy.close?.())
      && pagePoliciesClosed;
  }
  runtime.pagePoliciesClosed = pagePoliciesClosed
    && [pageAPolicy, pageBPolicy, optionsPolicy].every((policy) => policy.closed === true);
  if (provider) await attempt('provider', () => closeControlledResponsesProvider(provider));
  if (browser) await attempt('browser', () => browser.close());
  runtime.browserClosed = !browser || !browser.connected;
  await attempt('profile', async () => rmSync(profile, { recursive: true, force: true }));
  runtime.profileRemoved = !existsSync(profile);
  runtime.cleanupFailures = Math.min(failures.length, 99);
  if (failures.length > 0) runtime.configStep = `teardown-${failures[0]}`;
  runtime.stages.push('teardown');
  if (failures.length > 0) throw new Error('Phase 7C teardown failed.');
}
