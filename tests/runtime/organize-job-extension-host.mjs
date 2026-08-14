#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRuntimeReleaseDistIdentity,
  publishRuntimeEvidence,
  readRuntimeReleaseDistIdentity,
  serializeRuntimeEvidence,
} from '../../scripts/agent-runtime-evidence-contract.mjs';
import {
  assertFailClosedNetworkIsolation,
  launchExtensionBrowser,
} from './puppeteer-runtime.mjs';
import {
  discoverExtension,
  hookPageDiagnostics,
  openExtensionPage as openPackagedExtensionPage,
  openHttpFixturePage,
} from './extension-runtime-targets.mjs';
import { createServiceWorkerReplacementController } from './service-worker-replacement.mjs';

const DIST = path.resolve(process.cwd(), process.env.GSM_DIST_DIR ?? 'dist');
const OPTIONS_PATH = '/src/options/index.html';
const ROW_COUNT = 501;
const TIMEOUT_MS = 30_000;
const SETUP_TIMEOUT_MS = 45_000;
const RUN_WORKER_RECOVERY = process.env.GSM_RUNTIME_WORKER_RECOVERY === '1';
const RUN_EVIDENCE_SELF_TEST = process.env.GSM_ORGANIZE_EVIDENCE_SELF_TEST === '1';
const WORKER_RECOVERY_TIMEOUT_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 3_000;
const MAX_DIAGNOSTIC_COUNT = 1_000_000;
const MAX_DIAGNOSTIC_PROVIDER_FAILURE_KINDS = 16;
const ORGANIZE_RUNTIME_STAGES = new Set([
  'initialization',
  'launch_fail_closed_browser',
  'discover_packaged_extension',
  'install_exact_provider_gate',
  'configure_production_github',
  'configure_production_github_field',
  'configure_production_github_select',
  'configure_production_github_type',
  'configure_production_github_ready',
  'configure_production_github_click',
  'configure_production_github_settled',
  'configure_production_github_identity',
  'install_exact_provider_runtime',
  'open_production_page_a',
  'wait_production_page_a',
  'wait_production_page_a_entry',
  'wait_production_page_a_fab',
  'wait_production_page_a_manager',
  'wait_production_page_a_interception',
  'wait_production_page_a_content_script_missing',
  'wait_production_page_a_owner_identity_mismatch',
  'wait_production_page_a_panel_disabled',
  'wait_production_page_a_entry_unknown',
  'wait_production_page_b_entry',
  'wait_production_page_b_fab',
  'wait_production_page_b_manager',
  'wait_production_page_b_interception',
  'wait_production_page_b_content_script_missing',
  'wait_production_page_b_owner_identity_mismatch',
  'wait_production_page_b_panel_disabled',
  'wait_production_page_b_entry_unknown',
  'production_full_sync',
  'production_full_sync_wait_button',
  'production_full_sync_open_menu',
  'production_full_sync_confirm',
  'production_full_sync_settled',
  'probe_without_acceptance',
  'configure_saved_provider',
  'missing_provider_capability',
  'establish_provider_capability',
  'transient_provider_probe',
  'production_next_admission',
  'production_next_admission_page_b',
  'production_next_admission_drawers',
  'production_next_admission_drawer_a',
  'production_next_admission_drawer_b',
  'production_next_admission_preflight',
  'production_next_admission_preflight_actor',
  'production_next_admission_preflight_observer',
  'production_next_admission_preflight_storage',
  'production_next_admission_ui',
  'production_next_admission_budget',
  'mount_two_content_pages',
  'mount_two_content_pages_drawers',
  'mount_two_content_pages_drawer_a',
  'mount_two_content_pages_drawer_b',
  'mount_two_content_pages_catalog_page_b_foreground',
  'mount_two_content_pages_catalog_page_b_navigation',
  'mount_two_content_pages_catalog_page_b_entry',
  'mount_two_content_pages_catalog_page_b_drawer',
  'mount_two_content_pages_catalog_selection',
  'trusted_origin_deletion',
  'trusted_origin_deletion_terminal_precheck',
  'trusted_origin_deletion_replacement_create',
  'trusted_origin_deletion_replacement_create_authority_snapshot',
  'trusted_origin_deletion_replacement_create_click',
  'trusted_origin_deletion_replacement_create_new_current',
  'trusted_origin_deletion_replacement_create_controller_settle',
  'trusted_origin_deletion_replacement_create_catalog_origin_presence',
  'trusted_origin_deletion_replacement_create_close',
  'trusted_origin_deletion_page_b_refresh',
  'trusted_origin_deletion_page_b_catalog',
  'trusted_origin_deletion_origin_reselect',
  'trusted_origin_deletion_drafts',
  'trusted_origin_deletion_trusted_delete',
  'trusted_origin_deletion_trusted_delete_catalog_open',
  'trusted_origin_deletion_trusted_delete_exact_row_delete_hit',
  'trusted_origin_deletion_trusted_delete_confirmation_ready',
  'trusted_origin_deletion_trusted_delete_confirm_hit',
  'trusted_origin_deletion_trusted_delete_committed_menu_close',
  'trusted_origin_deletion_invalidation_convergence',
  'trusted_origin_deletion_invalidation_convergence_composer_drafts',
  'trusted_origin_deletion_invalidation_convergence_transcript_retry',
  'trusted_origin_deletion_invalidation_convergence_terminal_projection',
  'trusted_origin_deletion_invalidation_convergence_catalog_open_page_a',
  'trusted_origin_deletion_invalidation_convergence_catalog_open_page_b',
  'trusted_origin_deletion_invalidation_convergence_catalog_projection',
  'trusted_origin_deletion_invalidation_convergence_catalog_close',
  'trusted_origin_deletion_durable_authority',
  'trusted_origin_deletion_port_invalidation',
  'trusted_origin_deletion_port_invalidation_assert',
  'trusted_origin_deletion_terminal_evidence',
  'trusted_origin_deletion_dismiss',
  'trusted_origin_deletion_dismiss_content_convergence',
  'trusted_origin_deletion_dismiss_convergence',
  'trusted_origin_deletion_dismiss_evidence',
  'worker_recovery_start',
  'worker_recovery_stall',
  'worker_recovery_pause_before_expiry',
  'worker_recovery_pause_after_expiry',
  'worker_recovery_detach_port',
  'worker_recovery_pause_after_detach',
  'worker_recovery_replacement',
  'worker_recovery_replacement_pause_wakeups',
  'worker_recovery_replacement_preinstall_entry',
  'worker_recovery_replacement_preinstall_stalled_count',
  'worker_recovery_replacement_preinstall_stopped_interruption',
  'worker_recovery_replacement_resume_wakeups',
  'worker_recovery_replacement_retire_client',
  'worker_recovery_replacement_post_replace',
  'worker_recovery_reconnect',
  'worker_recovery_settle',
  'worker_recovery_cleanup',
  'trusted_origin_deletion_invalidation_convergence_catalog_open',
  'trusted_origin_deletion_invalidation_convergence_catalog_projection',
  'trusted_origin_deletion_invalidation_convergence_catalog_close',
  'trusted_origin_deletion_durable_authority',
  'runtime_complete',
  'publish_bounded_evidence',
]);
const CLEANUP_FAILURE_ORDER = Object.freeze([
  'replacement_controller',
  'provider_stall_release',
  'provider_health',
  'diagnostics_detach',
  'page_policy_close',
  'provider_gate_close',
  'browser_close',
  'page_close',
  'temporary_state_remove',
  'network_gates_open',
  'cleanup_state_incomplete',
]);
const GITHUB_CREDENTIAL = 'github_pat_runtime_organize_only';
const ORIGIN_DRAFT = 'runtime-organize-origin-draft-a';
const OBSERVER_DRAFT = 'runtime-organize-origin-draft-b';
const PAGE_A_URL = 'https://github.com/runtime-user?tab=stars&runtime=organize-a';
const PAGE_B_URL = 'https://github.com/runtime-user?tab=stars&runtime=organize-b';
const PRIVATE_MARKERS = Object.freeze([
  GITHUB_CREDENTIAL,
  'runtime-provider-key',
  'transient-runtime-key',
  'runtime-key-without-acceptance',
  ORIGIN_DRAFT,
  'must-not-leave-extension',
  'runtime-hidden-policy',
  OBSERVER_DRAFT,
]);

let browser;
let provider;
let profile;
let contentPageA;
let contentPageB;
let runtimePassedMessage;
let recoveryReplacementController;
let runtimeStage = 'initialization';
let primaryRuntimeStage = 'initialization';
let replacementFailureCode = 'none';
let runtimeCompleted = false;
const cleanupFailureKinds = new Set();
const pageIssues = [];
const pagePolicies = new Set();
const pageDiagnostics = new Set();
const cleanup = {
  networkGatesClosed: false,
  diagnosticsDetached: false,
  pagesClosed: false,
  browserClosed: false,
  temporaryStateRemoved: false,
};
const facts = {
  configuration: {},
  corruption: {},
  start: {},
  budget: {},
  detach: {},
  ownership: {},
  deletion: {},
  draftRecovery: {},
  nextAdmission: {},
  dismiss: {},
  provider: {},
};
let recoveryFacts = null;

if (isDirectExecution()) {
  if (RUN_EVIDENCE_SELF_TEST) {
    await runEvidenceSelfTest();
  } else {
    try {
      await runRuntime();
    } catch {
      console.error(JSON.stringify(buildCurrentOrganizeFailureDiagnostic()));
      process.exitCode = 1;
    }
  }
}

async function runRuntime() {
if (!existsSync(path.join(DIST, 'manifest.json'))) {
  throw new Error('A packaged extension manifest is required before the Organize runtime host can start.');
}

profile = mkdtempSync(path.join(os.tmpdir(), 'bgsm-organize-job-host-'));


try {
  runtimeStage = 'launch_fail_closed_browser';
  browser = await launchExtensionBrowser({
    dist: DIST,
    userDataDir: profile,
    protocolTimeout: WORKER_RECOVERY_TIMEOUT_MS,
    failClosedNetwork: true,
  });
  await assertFailClosedNetworkIsolation(browser);
  runtimeStage = 'discover_packaged_extension';
  const { extensionId: extId, target } = await discoverExtension(browser, {
    dist: DIST,
    timeoutMs: TIMEOUT_MS,
  });
  runtimeStage = 'install_exact_provider_gate';
  provider = await installControlledProvider(target);
  runtimeStage = 'install_exact_provider_runtime';
  await provider.activeClientState.client.send('Runtime.enable');
  const optionsPolicy = createPagePolicy('options');
  pagePolicies.add(optionsPolicy);
  const page = await openPackagedExtensionPage(
    browser,
    extId,
    OPTIONS_PATH,
    'organize-options',
    { timeoutMs: SETUP_TIMEOUT_MS, rootSelector: '#root', failClosedHttp: optionsPolicy },
  );
  const optionsDiagnostics = hookPageDiagnostics(page, 'organize-options', { issues: pageIssues });
  pageDiagnostics.add(optionsDiagnostics);
  await waitForOptionsReady(page);
  await page.evaluate(installOrganizeJobRunDeliveryCollector);
  await page.evaluate(installAgentSessionRuntimeFactory);
  await page.evaluate(installCorruptOrganizeJobSeeder);

  runtimeStage = 'configure_production_github';
  await saveGitHubToken(page);
  assert.equal(optionsPolicy.expectedRequests.some((request) => (
    request.method === 'DELETE'
    && request.route === 'github-probe-gist'
    && request.status === 204
  )), true);
  assert.equal(optionsPolicy.interceptionFailure, false);
  for (let index = pageIssues.length - 1; index >= 0; index -= 1) {
    const issue = pageIssues[index];
    if (issue.label === 'organize-options'
      && issue.kind === 'request-failed'
      && issue.value === 'DELETE github-probe-gist') pageIssues.splice(index, 1);
  }
  runtimeStage = 'probe_without_acceptance';
  const beforeUnaccepted = provider.capture.length;
  const unaccepted = await page.evaluate(testConnectionWithoutAcceptance);
  assert.equal(unaccepted.ok, true);
  assert.equal(provider.capture.length > beforeUnaccepted, true);
  runtimeStage = 'configure_saved_provider';
  await configureSavedProvider(page, provider);
  runtimeStage = 'open_production_page_a';
  contentPageA = await openOrganizeContentPage(browser, PAGE_A_URL, 'organize-page-a');
  await contentPageA.bringToFront();
  runtimeStage = 'wait_production_page_a';
  try {
    await waitForStarsManager(contentPageA, 'wait_production_page_a');
  } catch (error) {
    if ([...pagePolicies].some((policy) => (
      policy.label === 'organize-page-a' && policy.interceptionFailure === true
    ))) {
      runtimeStage = 'wait_production_page_a_interception';
    } else {
      runtimeStage = `wait_production_page_a_${await classifyContentEntry(contentPageA, extId)}`;
    }
    throw error;
  }
  runtimeStage = 'production_full_sync';
  await runTrustedFullSync(contentPageA, page, ROW_COUNT);
  await dismissOnboardingTourIfVisible(contentPageA);

  runtimeStage = 'production_next_admission_page_b';
  contentPageB = await openOrganizeContentPage(browser, PAGE_B_URL, 'organize-page-b-admission');
  await contentPageB.bringToFront();
  try {
    await waitForStarsManager(contentPageB, 'wait_production_page_b');
  } catch (error) {
    if ([...pagePolicies].some((policy) => (
      policy.label === 'organize-page-b-admission' && policy.interceptionFailure === true
    ))) {
      runtimeStage = 'wait_production_page_b_interception';
    } else {
      runtimeStage = `wait_production_page_b_${await classifyContentEntry(contentPageB, extId)}`;
    }
    throw error;
  }
  await dismissOnboardingTourIfVisible(contentPageB);
  runtimeStage = 'missing_provider_capability';
  const beforeCapability = provider.capture.length;
  const capabilityDenied = await page.evaluate(runMissingCapabilityScenario, { timeoutMs: TIMEOUT_MS });
  assert.equal(capabilityDenied.terminalReason, 'provider_error');
  assert.equal(provider.capture.length, beforeCapability);
  runtimeStage = 'establish_provider_capability';
  const savedCapability = await establishSavedProviderCapability(page, provider);
  assert.equal(savedCapability.source, 'builtin-official');
  assert.equal(savedCapability.contextWindow, 1_050_000);
  assert.equal(savedCapability.maxOutputTokens, 128_000);
  runtimeStage = 'transient_provider_probe';

  console.log('\n1) Transient typed key stays diagnostic-only');
  const beforeTransient = provider.capture.length;
  const transient = await page.evaluate(testTransientTypedKey);
  assert.equal(transient.ok, true);
  assert.equal(transient.savedCredentialUnchanged, true);
  assert.equal(transient.savedCapabilityUnchanged, true);
  facts.configuration = {
    transientProbeRequests: provider.capture.length - beforeTransient,
    savedCredentialUnchanged: transient.savedCredentialUnchanged,
    savedCapabilityReady: transient.savedCapabilityUnchanged,
  };
  console.log('  ✓ transient key completed a real probe without changing saved credential/capability authority');

  console.log('\n2) An invalid analysis checkpoint is discarded instead of restored forever');
  const corruptRestore = await page.evaluate(runCorruptActiveRestoreScenario, {
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(corruptRestore.discarded, true);
  facts.corruption.activeCheckpointDiscarded = true;
  assert.equal(corruptRestore.jobExists, false);
  assert.equal(corruptRestore.noActiveDeliveryKind, 'authoritative_snapshot');
  assert.equal(corruptRestore.noActiveDurableRevision, null);
  assert.equal(Number.isSafeInteger(corruptRestore.errorSequence), true);
  assert.equal(Number.isSafeInteger(corruptRestore.noActiveSequence), true);
  assert.equal(corruptRestore.errorSequence < corruptRestore.noActiveSequence, true);
  console.log('  ✓ invalid Analysis artifacts released the durable slot and returned terminal no-active authority');

  console.log('\n3) A new Start replaces a same-owner blocked job without restoring it first');
  provider.analyzerMode = 'unchanged';
  const corruptReplacement = await page.evaluate(runCorruptBlockedReplacementScenario, {
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(corruptReplacement.error, null);
  assert.equal(corruptReplacement.oldJobExists, false);
  assert.equal(corruptReplacement.jobCount, 1);
  facts.corruption.blockedCheckpointReplaced = true;
  console.log('  ✓ blocked durable authority was cancelled directly before the new run started');

  console.log('\n4) Replaying the same durable preflight Start is idempotent');
  provider.analyzerMode = 'actionable-all';
  const repeatedStart = await page.evaluate(runRepeatedPreflightStartScenario, {
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(repeatedStart.error, null);
  assert.equal(repeatedStart.sameRun, true);
  assert.equal(repeatedStart.jobCount, 1);
  facts.corruption.duplicateStartIdempotent = true;
  console.log('  ✓ duplicate Start replayed the same run without creating a second durable job');

  console.log('\n5) Full scope, exact RunBudget exhaustion, and automatic continuation');
  provider.analyzerMode = 'unchanged';
  const beforePreflight = provider.capture.length;
  runtimeStage = 'production_next_admission_drawers';
  runtimeStage = 'production_next_admission_drawer_a';
  await contentPageA.bringToFront();
  await openAgentDrawer(contentPageA);
  runtimeStage = 'production_next_admission_drawer_b';
  await contentPageB.bringToFront();
  await openAgentDrawer(contentPageB);
  runtimeStage = 'production_next_admission_preflight';
  let preflightOnly;
  try {
    preflightOnly = await page.evaluate(runPreflightOnlyScenario, {
      rowCount: ROW_COUNT,
      timeoutMs: TIMEOUT_MS,
      expectedPriorTerminalJobId: repeatedStart.terminalJobId,
    });
  } catch (error) {
    const progress = await page.evaluate(() => globalThis.__runtimePreflightProgress ?? 'actor');
    runtimeStage = {
      actor: 'production_next_admission_preflight_actor',
      observer: 'production_next_admission_preflight_observer',
      storage: 'production_next_admission_preflight_storage',
    }[progress] ?? 'production_next_admission_preflight';
    throw error;
  }
  assert.equal(preflightOnly.count, ROW_COUNT);
  assert.equal(preflightOnly.priorTerminalFound, true);
  assert.equal(preflightOnly.priorTerminalReplaced, true);
  assert.equal(preflightOnly.admittedJobCount, 1);
  runtimeStage = 'production_next_admission_ui';
  const productionAdmission = await runProductionNextAdmissionScenario({
    pageA: contentPageA,
    pageB: contentPageB,
  });
  assert.equal(provider.capture.length, beforePreflight);
  facts.nextAdmission = {
    actorPages: productionAdmission.actorPages,
    observerPages: productionAdmission.observerPages,
    noJobProjectionPages: productionAdmission.noJobProjectionPages,
    oldTerminalRows: preflightOnly.oldTerminalRows,
    oldApplyRows: preflightOnly.oldApplyRows,
    newPreflightRows: productionAdmission.newPreflightRows,
    providerRequestDelta: provider.capture.length - beforePreflight,
    pagesConverged: productionAdmission.pagesConverged,
  };
  facts.start = { preflightRows: preflightOnly.count, admittedRows: preflightOnly.admittedJobCount };
  runtimeStage = 'production_next_admission_budget';
  const organize = await page.evaluate(runOrganizeBudgetContinuationScenario, {
    rowCount: ROW_COUNT,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(organize.count, ROW_COUNT);
  assert.equal(organize.snapshotBounded, true);
  assert.deepEqual(organize.budget, {
    wallDeadlineMs: 300_000,
    maxConsumedFrozenPositions: 500,
    maxAnalyzerBatches: 20,
    maxProviderAttempts: 24,
    maxSerializedOutboundRequestBytes: 8_388_608,
    maxRequestedOutputTokens: 32_000,
  });
  assert.equal(organize.exhaustionReason, 'requested_output_tokens');
  assert.equal(organize.exhaustedUsage.consumedFrozenPositions, 175);
  assert.equal(organize.exhaustedUsage.analyzerBatches, 7);
  assert.equal(organize.exhaustedUsage.providerAttempts, 7);
  assert.equal(organize.exhaustedUsage.requestedOutputTokens, 28_672);
  assert.equal(organize.continuationCount, 2);
  assert.equal(organize.continuationGeneration > organize.parentGeneration, true);
  facts.budget = {
    frozenRows: organize.count,
    providerAttemptsBeforeContinuation: organize.exhaustedUsage.providerAttempts,
    continuationCount: organize.continuationCount,
    completed: organize.continuationTerminalState === 'completed',
  };
  assert.equal(organize.continuationTerminalState, 'completed');
  assert.equal(organize.disconnected, true);
  assert.equal(organize.deliveryMetadata[0]?.deliverySequence, 0);
  assert.equal(organize.deliveryMetadata.every((delivery, index) => delivery.deliverySequence === index), true);
  assert.equal(new Set(organize.deliveryMetadata.map((delivery) => delivery.connectionEpochId)).size, 1);
  console.log('  ✓ requested-token budget stopped before attempt 8 and automatic continuations completed all rows');

  console.log('\n6) Closing the panel does not stop durable Analysis');
  provider.analyzerMode = 'unchanged';
  provider.stallNextAnalyzer = true;
  const active = await page.evaluate(beginActiveProviderReadScenario, { timeoutMs: TIMEOUT_MS });
  await waitUntil(() => typeof provider.releaseStall === 'function', TIMEOUT_MS);
  const activeDisconnect = await page.evaluate(disconnectActiveProviderReadScenario);
  assert.equal(activeDisconnect.detached, true);
  await provider.releaseStall();
  provider.releaseStall = null;
  const retainedNoChange = await page.evaluate(dismissRetainedTerminalOrganizeJob, {
    jobId: active.jobId,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(retainedNoChange.status, 'completed');
  assert.equal(retainedNoChange.apply, null);
  const activeCompletion = await page.evaluate(waitForOrganizeJobRemoval, {
    jobId: active.jobId,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(activeCompletion.removed, true);
  facts.detach = { detachedWhileActive: true, terminalRetainedUntilDismiss: true };
  console.log('  ✓ the Port detached immediately; the no-change result stayed durable until global Dismiss');

  console.log('\n7) Two real pages converge through observer rejection, owner loss, takeover, terminal retention, and Dismiss');
  const observerPolicy = createPagePolicy('organize-observer-options');
  pagePolicies.add(observerPolicy);
  const observerPage = await openPackagedExtensionPage(
    browser,
    extId,
    OPTIONS_PATH,
    'organize-observer-options',
    { timeoutMs: TIMEOUT_MS, rootSelector: '#root', failClosedHttp: observerPolicy },
  );
  const observerDiagnostics = hookPageDiagnostics(observerPage, 'organize-observer-options', { issues: pageIssues });
  pageDiagnostics.add(observerDiagnostics);
  await waitForOptionsReady(observerPage);
  await Promise.all([
    page.evaluate(installOrganizeJobRunDeliveryCollector),
    observerPage.evaluate(installOrganizeJobRunDeliveryCollector),
    page.evaluate(installTwoPageOwnershipRuntimeHarness),
    observerPage.evaluate(installTwoPageOwnershipRuntimeHarness),
    observerPage.evaluate(installAgentSessionRuntimeFactory),
  ]);
  provider.analyzerMode = 'actionable-all';
  provider.actionTag = 'runtime-full-library';
  provider.stallNextAnalyzer = true;
  const ownershipCaptureStart = provider.capture.length;
  const ownerStart = await page.evaluate(beginTwoPageOwnershipScenario, {
    rowCount: ROW_COUNT,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(ownerStart.count, ROW_COUNT);
  await contentPageA.close();
  contentPageA = await openOrganizeContentPage(browser, PAGE_A_URL, 'organize-page-a-origin');
  await waitForStarsManager(contentPageA);
  await waitUntil(() => typeof provider.releaseStall === 'function', TIMEOUT_MS);
  await refreshProductionContentPage(contentPageB, 'mount_two_content_pages_catalog_page_b');
  runtimeStage = 'mount_two_content_pages_drawers';
  runtimeStage = 'mount_two_content_pages_drawer_a';
  await contentPageA.bringToFront();
  await openAgentDrawer(contentPageA);
  runtimeStage = 'mount_two_content_pages_drawer_b';
  await contentPageB.bringToFront();
  await openAgentDrawer(contentPageB);
  runtimeStage = 'mount_two_content_pages_catalog_selection';
  try {
    await Promise.all([
      selectSessionThroughUi(contentPageA, ownerStart.pageSessionId),
      selectSessionThroughUi(contentPageB, ownerStart.pageSessionId),
    ]);
  } catch (error) {
    const catalogDiagnostics = await Promise.all([contentPageA, contentPageB].map(async (candidate) => (
      candidate.evaluate((expected) => {
        const root = document.getElementById('gsm-manager-host')?.shadowRoot;
        const rows = [...(root?.querySelectorAll('[data-testid="agent-session-item"]') ?? [])];
        const list = root?.querySelector('[data-testid="agent-session-list"]');
        const toggle = root?.querySelector('[data-testid="agent-session-toggle"]');
        return {
          menuOpen: list?.getAttribute('data-state') === 'open',
          rowCount: rows.length,
          targetPresent: rows.some((row) => row.getAttribute('data-session-id') === expected),
          currentCount: rows.filter((row) => row.querySelector('[aria-current="true"]')).length,
          toggleDisabled: toggle instanceof HTMLButtonElement && toggle.disabled,
        };
      }, ownerStart.pageSessionId).catch(() => null)
    )));
    console.error(JSON.stringify({ diagnostic: 'catalog_selection', catalogDiagnostics }));
    throw error;
  }
  const originSelections = await Promise.all([
    readOrganizeContentUi(contentPageA),
    readOrganizeContentUi(contentPageB),
  ]);
  assert.equal(originSelections.every((projection) => projection.currentSessionId === ownerStart.pageSessionId), true);
  const observer = await observerPage.evaluate(joinTwoPageOwnershipScenario, {
    expectedJobId: ownerStart.presentation.jobId,
    timeoutMs: TIMEOUT_MS,
  });
  const refreshedOwner = await page.evaluate(refreshTwoPageOwnershipProjection, {
    expectedJobId: ownerStart.presentation.jobId,
    expectedRevision: observer.presentation.revision,
    expectedRole: 'owner',
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(ownerStart.role, 'owner');
  assert.equal(ownerStart.outerControllerId, ownerStart.pageControllerId);
  assert.equal(ownerStart.outerSessionId, ownerStart.pageSessionId);
  assert.equal(observer.role, 'observer');
  assert.equal(refreshedOwner.role, 'owner');
  assert.deepEqual(observer.presentation, refreshedOwner.presentation);
  assert.equal(observer.outerControllerId, observer.pageControllerId);
  assert.equal(observer.outerSessionId, observer.pageSessionId);
  assert.equal(observer.presentation.originAgentSessionId, ownerStart.pageSessionId);
  assert.equal(observer.rejection.reason, 'not_owner');
  assert.equal(observer.rejection.requestId, 'runtime-observer-stop');
  assert.deepEqual(observer.durableAfterRejection, observer.durableBeforeRejection);

  const blockedDeletion = await observerPage.evaluate(deleteOwnershipOriginConversation, {
    sessionId: ownerStart.pageSessionId,
  });
  assert.equal(blockedDeletion.response.ok, false);
  assert.equal(blockedDeletion.response.code, 'agent_session_deletion_blocked');
  const blockedDeletionEvidence = await observerPage.evaluate(
    readTwoPageOwnershipTerminalEvidence,
    ownerStart.presentation.jobId,
  );
  assert.equal(blockedDeletionEvidence.sessionExists, true);
  assert.equal(blockedDeletionEvidence.job.revision, observer.durableAfterRejection.revision);
  assert.equal(blockedDeletionEvidence.job.status, 'analyzing');
  assert.equal(blockedDeletion.invalidationCount, 0);

  const ownerDisconnect = await page.evaluate(disconnectTwoPageOwnershipPort);
  assert.equal(ownerDisconnect.disconnected, true);
  const ownerLost = await observerPage.evaluate(waitForTwoPageOwnershipRole, {
    expectedJobId: ownerStart.presentation.jobId,
    expectedRole: 'owner_lost',
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(ownerLost.presentation.controllerId, ownerStart.pageControllerId);
  assert.equal(ownerLost.presentation.sessionId, ownerStart.pageSessionId);
  const providerCaptureCountBeforeTakeover = provider.capture.length;
  const takeover = await observerPage.evaluate(takeControlOfTwoPageOwnership, {
    expectedJobId: ownerStart.presentation.jobId,
    expectedRevision: ownerLost.presentation.revision,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(takeover.role, 'owner');
  assert.equal(takeover.presentation.controllerId, observer.pageControllerId);
  assert.equal(takeover.presentation.sessionId, observer.pageSessionId);
  assert.equal(takeover.presentation.originAgentSessionId, ownerStart.pageSessionId);
  assert.equal(takeover.presentation.revision, ownerLost.presentation.revision + 1);
  assert.equal(takeover.loser.requestId, 'runtime-take-control-concurrent');
  assert.ok(
    ['not_owner', 'owner_connected', 'revision_conflict'].includes(takeover.loser.reason),
    `Unexpected concurrent takeover reason: ${JSON.stringify(takeover.loser)}`,
  );
  assert.equal(takeover.durable.controllerId, observer.pageControllerId);
  assert.equal(takeover.durable.sessionId, observer.pageSessionId);
  assert.equal(takeover.durable.originAgentSessionId, ownerStart.pageSessionId);
  assert.equal(takeover.durable.revision, takeover.presentation.revision);
  assert.equal(provider.capture.length - providerCaptureCountBeforeTakeover, 0);
  const capturesDuringTakeover = provider.capture.slice(ownershipCaptureStart).filter((entry) => (
    entry.kind === 'analyzer' || entry.kind === 'analyzer-stall'
  ));
  assert.equal(capturesDuringTakeover.length, 1);
  assert.equal(capturesDuringTakeover[0]?.kind, 'analyzer-stall');

  const formerOwner = await page.evaluate(reconnectTwoPageOwnershipPort, {
    expectedJobId: ownerStart.presentation.jobId,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(formerOwner.role, 'observer');
  assert.equal(formerOwner.outerControllerId, ownerStart.pageControllerId);
  assert.equal(formerOwner.outerSessionId, ownerStart.pageSessionId);
  assert.equal(formerOwner.presentation.controllerId, observer.pageControllerId);
  assert.equal(formerOwner.presentation.sessionId, observer.pageSessionId);
  assert.equal(provider.capture.length - providerCaptureCountBeforeTakeover, 0);
  const takeoverProviderRequestDelta = provider.capture.length - providerCaptureCountBeforeTakeover;
  assert.equal(await page.evaluate(countOwnershipDeletionInvalidations, ownerStart.pageSessionId), 0);

  await provider.releaseStall();
  provider.releaseStall = null;
  const review = await observerPage.evaluate(waitForTwoPageOwnershipReview, {
    expectedJobId: ownerStart.presentation.jobId,
    timeoutMs: TIMEOUT_MS,
  });
  const formerOwnerReview = await page.evaluate(waitForTwoPageOwnershipRole, {
    expectedJobId: ownerStart.presentation.jobId,
    expectedRole: 'observer',
    expectedStatus: 'review',
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(review.role, 'owner');
  assert.equal(formerOwnerReview.presentation.revision, review.presentation.revision);
  assert.equal(review.durable.controllerId, observer.pageControllerId);
  assert.equal(review.durable.sessionId, observer.pageSessionId);
  assert.equal(review.durable.originAgentSessionId, ownerStart.pageSessionId);
  assert.equal(await observerPage.evaluate(countOwnershipDeletionInvalidations, ownerStart.pageSessionId), 0);
  assert.equal(review.durable.generation > ownerStart.presentation.generation, true);
  const ownershipCaptures = provider.capture.slice(ownershipCaptureStart).filter((entry) => (
    entry.kind === 'analyzer' || entry.kind === 'analyzer-stall'
  ));
  const captureRanges = ownershipCaptures.map((entry) => `${entry.batchStart}:${entry.batchEnd}`);
  assert.equal(ownershipCaptures.length, Math.ceil(ROW_COUNT / 25));
  assert.equal(new Set(captureRanges).size, ownershipCaptures.length);
  assert.equal(new Set(ownershipCaptures.map((entry) => entry.generation)).size > 1, true);

  const completedByOwner = await observerPage.evaluate(completeTwoPageOwnershipApply, {
    expectedJobId: ownerStart.presentation.jobId,
    timeoutMs: TIMEOUT_MS,
  });
  const completedByFormerOwner = await page.evaluate(waitForTwoPageOwnershipTerminal, {
    expectedJobId: ownerStart.presentation.jobId,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(completedByOwner.role, null);
  assert.equal(completedByFormerOwner.role, null);
  assert.equal(completedByOwner.presentation.jobId, ownerStart.presentation.jobId);
  assert.equal(completedByFormerOwner.presentation.revision, completedByOwner.presentation.revision);
  assert.deepEqual(completedByOwner.presentation, completedByFormerOwner.presentation);
  assert.equal(completedByOwner.presentation.originAgentSessionId, ownerStart.pageSessionId);
  assert.equal(completedByFormerOwner.outerControllerId, ownerStart.pageControllerId);
  assert.equal(completedByOwner.outerControllerId, observer.pageControllerId);
  assert.equal(completedByOwner.reviewTotal, ROW_COUNT);
  assert.equal(completedByOwner.firstReviewPageRows, 100);
  assert.equal(completedByOwner.selectedRepositories, ROW_COUNT);
  assert.equal(completedByOwner.selectedActions, ROW_COUNT);
  assert.deepEqual(completedByOwner.settledProgress, [100, 200, 300, 400, 500, 501]);
  assert.deepEqual(completedByOwner.receiptCounts, {
    total: ROW_COUNT,
    changed: ROW_COUNT,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  });
  assert.equal(completedByOwner.deliveryMetadata[0]?.deliverySequence, 0);
  assert.equal(
    completedByOwner.deliveryMetadata.every((delivery, index) => delivery.deliverySequence === index),
    true,
  );
  assert.equal(completedByOwner.deliveryMetadata.some((delivery) => delivery.durableRevision !== null), true);

  const [ownerReceipt, observerReceipt] = await Promise.all([
    page.evaluate(requestTwoPageOwnershipReceipt, {
      presentation: completedByOwner.presentation,
      timeoutMs: TIMEOUT_MS,
    }),
    observerPage.evaluate(requestTwoPageOwnershipReceipt, {
      presentation: completedByOwner.presentation,
      timeoutMs: TIMEOUT_MS,
    }),
  ]);
  assert.deepEqual(ownerReceipt.rows, observerReceipt.rows);
  assert.equal(ownerReceipt.rows.length, 100);
  assert.equal(ownerReceipt.nextRowOffset, 100);

  runtimeStage = 'trusted_origin_deletion';
  const uiOutcome = await runOriginDeletionInvalidationScenario({
    pageA: contentPageA,
    pageB: contentPageB,
    authorityPage: page,
    originSessionId: ownerStart.pageSessionId,
    terminalJobId: completedByOwner.presentation.jobId,
    applyId: completedByOwner.presentation.apply.applyId,
    rowCount: ROW_COUNT,
  });
  runtimeStage = 'trusted_origin_deletion_port_invalidation';
  const [ownerInvalidation, observerInvalidation] = await Promise.all([
    page.evaluate(waitForOwnershipDeletionInvalidation, {
      deletedSessionId: ownerStart.pageSessionId,
      timeoutMs: TIMEOUT_MS,
    }),
    observerPage.evaluate(waitForOwnershipDeletionInvalidation, {
      deletedSessionId: ownerStart.pageSessionId,
      timeoutMs: TIMEOUT_MS,
    }),
  ]);
  runtimeStage = 'trusted_origin_deletion_port_invalidation_assert';
  assert.equal(ownerInvalidation.invalidationDelivery.deliveryKind, 'live');
  assert.equal(observerInvalidation.invalidationDelivery.deliveryKind, 'live');

  runtimeStage = 'trusted_origin_deletion_terminal_evidence';
  const [ownerEvidence, observerEvidence] = await Promise.all([
    page.evaluate(readTwoPageOwnershipTerminalEvidence, completedByOwner.presentation.jobId),
    observerPage.evaluate(readTwoPageOwnershipTerminalEvidence, completedByOwner.presentation.jobId),
  ]);
  assert.deepEqual(ownerEvidence, observerEvidence);
  assert.equal(ownerEvidence.sessionExists, false);
  assert.equal(ownerEvidence.job.status, 'completed');
  assert.equal(ownerEvidence.job.originAgentSessionId, ownerStart.pageSessionId);
  assert.equal(ownerEvidence.apply.jobId, completedByOwner.presentation.jobId);
  assert.equal(ownerEvidence.applyRowCount, ROW_COUNT);

  runtimeStage = 'trusted_origin_deletion_dismiss';
  await clickDismissThroughUi(contentPageB);
  runtimeStage = 'trusted_origin_deletion_dismiss_content_convergence';
  await Promise.all([
    waitForContentTerminalDismissed(contentPageA),
    waitForContentTerminalDismissed(contentPageB),
  ]);
  runtimeStage = 'trusted_origin_deletion_dismiss_convergence';
  const [dismissed, formerOwnerNoJob] = await Promise.all([
    observerPage.evaluate(waitForTwoPageOwnershipNoJob, { timeoutMs: TIMEOUT_MS }),
    page.evaluate(waitForTwoPageOwnershipNoJob, { timeoutMs: TIMEOUT_MS }),
  ]);
  assert.equal(dismissed.presentation, null);
  assert.equal(formerOwnerNoJob.presentation, null);
  runtimeStage = 'trusted_origin_deletion_dismiss_evidence';
  const dismissedEvidence = await observerPage.evaluate(
    readTwoPageOwnershipTerminalEvidence,
    completedByOwner.presentation.jobId,
  );
  assert.equal(dismissedEvidence.job, null);
  assert.equal(dismissedEvidence.apply, null);
  assert.equal(dismissedEvidence.applyRowCount, 0);

  facts.ownership = {
    rawPages: 2,
    ownerPages: 1,
    observerPages: 1,
    ownerLostPages: 1,
    explicitTakeoverPages: 1,
    formerOwnerObserverPages: 1,
    ownerObserverConverged: true,
    ownerLossRequiredExplicitTakeover: true,
    takeoverProviderRequestDelta,
    terminalProjectionPages: 2,
    terminalPagesConverged: true,
  };
  facts.deletion = uiOutcome.deletion;
  facts.draftRecovery = uiOutcome.draftRecovery;
  facts.dismiss = {
    actorPages: 1,
    convergedPages: 2,
    dismissedTerminalRows: 0,
    dismissedApplyRows: 0,
    pagesConverged: true,
  };
  await Promise.all([
    page.evaluate(disconnectTwoPageOwnershipPort),
    observerPage.evaluate(disconnectTwoPageOwnershipPort),
  ]);
  await observerPage.close();
  console.log('  ✓ raw ownership and trusted production UI converged through takeover, deletion, draft recovery, retained receipt, and Dismiss');

  console.log('\n8) Custom-host denial is fail-closed before provider network');
  const beforeDenied = provider.capture.length;
  const denied = await page.evaluate(testDeniedCustomHost);
  const afterDenied = provider.capture.length;
  assert.equal(denied.ok, false);
  assert.equal(denied.permissionDenied, true);
  assert.equal(afterDenied, beforeDenied);
  facts.provider.customHostDeniedFetches = afterDenied - beforeDenied;
  console.log('  ✓ missing optional host permission caused zero provider fetches');

  if (RUN_WORKER_RECOVERY) {
    runtimeStage = 'worker_recovery_start';
    console.log('\n9) A real Chrome alarm resumes Analysis after MV3 worker termination');
    provider.analyzerMode = 'actionable-all';
    provider.actionTag = 'runtime-worker-recovery';
    provider.stallNextAnalyzer = true;
    const recoveryCaptureStart = provider.capture.length;
    const recoveryInterruptionStart = provider.expectedInterruptions.length;
    runtimeStage = 'worker_recovery_stall';
    const recoveryStart = await page.evaluate(beginWorkerRecoveryScenario, {
      rowCount: ROW_COUNT,
      timeoutMs: TIMEOUT_MS,
    });
    await waitUntil(() => typeof provider.releaseStall === 'function', TIMEOUT_MS);
    const interruptedClientState = provider.activeClientState;
    assert.ok(interruptedClientState);
    runtimeStage = 'worker_recovery_replacement';
    recoveryReplacementController = await createServiceWorkerReplacementController({
      page,
      extensionId: extId,
      timeoutMs: WORKER_RECOVERY_TIMEOUT_MS,
      replacementMode: 'paused_target_auto_attached',
      pauseRecoveryWakeups: () => withRuntimeStage(
        'worker_recovery_replacement_pause_wakeups',
        () => page.evaluate(pauseWorkerRecoveryWakeups),
      ),
      resumeRecoveryWakeups: () => withRuntimeStage(
        'worker_recovery_replacement_resume_wakeups',
        () => page.evaluate(resumeWorkerRecoveryWakeups),
      ),
      preinstallAutoAttachedClient: (client) => withRuntimeStage(
        'worker_recovery_replacement_preinstall_entry',
        () => preinstallAutoAttachedControlledProviderClient(provider, interruptedClientState, client),
      ),
      settleStoppedClient: () => withRuntimeStage(
        'worker_recovery_replacement_preinstall_stopped_interruption',
        () => settleStoppedControlledProviderClient(provider, interruptedClientState),
      ),
      retireReplacementClient: (clientState) => withRuntimeStage(
        'worker_recovery_replacement_retire_client',
        () => retireReplacementControlledProviderClient(clientState),
      ),
    });
    await page.evaluate(armWorkerRecoveryReconnect);
    runtimeStage = 'worker_recovery_pause_before_expiry';
    await page.evaluate(pauseWorkerRecoveryWakeups);
    const expiredLease = await page.evaluate(expireActiveAnalysisLeaseForRuntime);
    assert.equal(expiredLease.jobId, recoveryStart.jobId);
    assert.equal(expiredLease.alarmName, 'bgsm-organize-analysis-recovery');
    runtimeStage = 'worker_recovery_pause_after_expiry';
    await page.evaluate(pauseWorkerRecoveryWakeups);
    runtimeStage = 'worker_recovery_detach_port';
    const detachedRecoveryPort = await page.evaluate(detachWorkerRecoveryPortForReplacement);
    assert.deepEqual(detachedRecoveryPort, { detached: true, reconnectPending: true });
    runtimeStage = 'worker_recovery_pause_after_detach';
    await page.evaluate(pauseWorkerRecoveryWakeups);
    runtimeStage = 'worker_recovery_replacement';
    let replacementLifecycle;
    try {
      replacementLifecycle = await recoveryReplacementController.replace();
    } catch (error) {
      replacementFailureCode = classifyReplacementFailure(error);
      throw error;
    }
    runtimeStage = 'worker_recovery_replacement_post_replace';
    const replacementDiagnostics = replacementLifecycle.getRuntimeDiagnostics();
    runtimeStage = 'worker_recovery_reconnect';
    const reconnect = await page.evaluate(waitForWorkerRecoveryReconnect, {
      runId: recoveryStart.runId,
      generation: recoveryStart.generation,
      timeoutMs: WORKER_RECOVERY_TIMEOUT_MS,
    });
    await waitUntil(
      () => provider.capture
        .slice(recoveryCaptureStart)
        .filter((entry) => entry.kind === 'analyzer').length === Math.ceil(ROW_COUNT / 25),
      WORKER_RECOVERY_TIMEOUT_MS,
    );

    runtimeStage = 'worker_recovery_settle';
    const recovered = await page.evaluate(waitForRecoveredOrganizeState, {
      jobId: recoveryStart.jobId,
      expectedStatus: 'review',
      timeoutMs: TIMEOUT_MS,
    });
    const firstPageAttempts = provider.capture.slice(recoveryCaptureStart).filter((entry) => (
      (entry.kind === 'analyzer' || entry.kind === 'analyzer-stall') &&
      entry.batchStart === 0 &&
      entry.batchEnd === 25
    ));
    const recoveryAttempts = provider.capture.slice(recoveryCaptureStart).filter((entry) => (
      entry.kind === 'analyzer' || entry.kind === 'analyzer-stall'
    ));
    const uniqueRecoveryBatchCount = new Set(recoveryAttempts.map((entry) => (
      `${entry.batchStart}:${entry.batchEnd}`
    ))).size;
    assert.equal(uniqueRecoveryBatchCount, Math.ceil(ROW_COUNT / 25));
    assert.equal(recovered.status, 'review');
    assert.equal(recovered.nextFrozenIndex, ROW_COUNT);
    assert.equal(reconnect.runId, recoveryStart.runId);
    assert.equal(reconnect.generation, recoveryStart.generation);
    assert.equal(firstPageAttempts.length, 2);
    assert.deepEqual(firstPageAttempts.map((entry) => entry.kind), ['analyzer-stall', 'analyzer']);
    assert.equal(recovered.settledCount, ROW_COUNT);
    assert.equal(recovered.uniqueSettledPositionCount, ROW_COUNT);
    assert.equal(
      recovered.usage.providerAttempts,
      recoveryAttempts.filter((entry) => entry.generation === recovered.generation).length,
    );
    const settledRequestCount = provider.capture.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(provider.capture.length, settledRequestCount);
    const oldEpochId = recoveryStart.deliveryMetadata[0]?.connectionEpochId ?? null;
    const newEpochId = reconnect.deliveryMetadata[0]?.connectionEpochId ?? null;
    const scriptRelativePath = replacementLifecycle.stopped.route.replace(/^\//u, '');
    recoveryFacts = {
      replacement: {
        scenarioId: 'organize_worker_recovery',
        oldVersionId: replacementLifecycle.stopped.versionId,
        newVersionId: replacementLifecycle.replacement.versionId,
        oldTargetId: replacementLifecycle.stopped.targetId,
        newTargetId: replacementLifecycle.replacement.targetId,
        oldAttachmentId: replacementLifecycle.stopped.attachmentId,
        newAttachmentId: replacementLifecycle.replacement.attachmentId,
        scriptRelativePath,
        lifecycleMode: replacementLifecycle.lifecycle.mode,
        stopCommandOrdinal: replacementLifecycle.lifecycle.stopCommandOrdinal,
        stoppedOrdinal: replacementLifecycle.lifecycle.stoppedOrdinal,
        installCompletedOrdinal: replacementLifecycle.lifecycle.installCompletedOrdinal,
        startCommandOrdinal: replacementLifecycle.lifecycle.startCommandOrdinal,
        runningOrdinal: replacementLifecycle.lifecycle.runningOrdinal,
      },
      epochs: { oldEpochId, newEpochId },
      outcome: {
        runIdStable: reconnect.runId === recoveryStart.runId,
        generationStable: reconnect.generation === recoveryStart.generation,
        firstPageAttempts: firstPageAttempts.length,
        retriedFirstPage: firstPageAttempts.length === 2,
        settledCount: recovered.settledCount,
        uniqueSettledPositionCount: recovered.uniqueSettledPositionCount,
        providerAttemptCount: uniqueRecoveryBatchCount,
        duplicateProviderRequests: firstPageAttempts.length - 1,
        terminalStatus: recovered.status,
      },
      provider: {
        requests: recoveryAttempts.length,
        interruptions: provider.expectedInterruptions.length - recoveryInterruptionStart,
        failures: replacementDiagnostics.count,
      },
    };
    runtimeStage = 'worker_recovery_cleanup';
    await page.evaluate(disconnectWorkerRecoveryReconnect);
    console.log('  ✓ alarm and UI reconnect shared one restore, retried the interrupted first page once, and reached durable Review');
  }
  assert.equal([...pagePolicies].every((policy) => (
    policy.unexpectedRequests.length === 0
    && policy.interceptionFailure === false
    && policy.overflow === false
  )), true);
  await assertControlledProviderHealthy(provider);
  const capture = provider.capture;
  assert.ok(capture.some((entry) => entry.kind === 'probe-tool'));
  assert.ok(capture.some((entry) => entry.kind === 'probe-ack'));
  assert.equal(capture.every((entry) => entry.authorizationPresent === true), true);
  assert.equal(capture.filter((entry) => entry.kind === 'analyzer').length >= 22, true);
  assert.equal(capture.every((entry) => entry.route === 'responses'), true);
  assert.equal(capture.every((entry) => entry.hiddenPolicyPresent === false), true);
  assert.equal(provider.unexpectedRequests.length, 0);
  assert.equal(provider.interceptionFailures.length, 0);
  assert.equal(provider.overflow, false);
  assert.equal(pageIssues.length, 0);
  facts.provider = {
    requests: capture.length,
    authenticatedRequests: capture.filter((entry) => entry.authorizationPresent).length,
    githubFixtureRequests: provider.httpFixtureCapture.length,
    unexpectedRequests: provider.unexpectedRequests.length,
    failures: provider.interceptionFailures.length,
    overflow: provider.overflow,
    customHostDeniedFetches: facts.provider.customHostDeniedFetches,
  };
  runtimePassedMessage = `Organize runtime host passed (${capture.length} controlled Provider requests).`;
  runtimeCompleted = true;
} finally {
  primaryRuntimeStage = runtimeStage;
  runtimeStage = 'bounded_cleanup';
  await attemptCleanup('provider_stall_release', async () => {
    if (typeof provider?.releaseStall === 'function') {
      await withCleanupTimeout(provider.releaseStall());
      provider.releaseStall = null;
    }
  });
  await attemptCleanup('provider_health', async () => {
    await withCleanupTimeout(assertControlledProviderHealthy(provider));
  });
  let diagnosticsDetached = true;
  for (const diagnostics of pageDiagnostics) {
    const detached = await attemptCleanup('diagnostics_detach', async () => diagnostics.cleanup());
    diagnosticsDetached = detached && diagnosticsDetached;
  }
  cleanup.diagnosticsDetached = diagnosticsDetached;
  let pagePoliciesClosed = true;
  for (const policy of pagePolicies) {
    const closed = await attemptCleanup('page_policy_close', async () => {
      await withCleanupTimeout(policy.close?.());
    });
    pagePoliciesClosed = closed && pagePoliciesClosed;
  }
  const providerGateClosed = await attemptCleanup('provider_gate_close', async () => {
    await withCleanupTimeout(closeControlledProvider(provider));
  });
  await attemptCleanup('replacement_controller', async () => {
    await withCleanupTimeout(recoveryReplacementController?.close());
  });
  recoveryReplacementController = null;
  const replacementControllerClosed = cleanupFailureKinds.has('replacement_controller') === false;
  cleanup.networkGatesClosed = pagePoliciesClosed
    && [...pagePolicies].every((policy) => policy.closed === true)
    && providerGateClosed
    && replacementControllerClosed
    && [...(provider?.clientStates ?? [])].every((state) => state.retired === true);
  if (!cleanup.networkGatesClosed) cleanupFailureKinds.add('network_gates_open');
  cleanup.browserClosed = await attemptCleanup('browser_close', async () => {
    await closeOrganizeBrowser(browser);
  });
  cleanup.pagesClosed = cleanup.browserClosed;
  if (!cleanup.pagesClosed) cleanupFailureKinds.add('page_close');
  await attemptCleanup('temporary_state_remove', async () => {
    if (profile) rmSync(profile, { recursive: true, force: true });
    if (profile && existsSync(profile)) throw new Error('temporary_state_remove_failed');
  });
  cleanup.temporaryStateRemoved = !profile || !existsSync(profile);
  if (!Object.values(cleanup).every(Boolean)) cleanupFailureKinds.add('cleanup_state_incomplete');
  if (runtimeCompleted && cleanupFailureKinds.size === 0) {
    runtimeStage = 'publish_bounded_evidence';
    publishOrganizeEvidence();
  } else if (runtimeCompleted) {
    throw new Error('organize_cleanup_incomplete');
  }
}
console.log(runtimePassedMessage);
}


function createPagePolicy(label) {
  const policy = {
    unexpectedRequests: [],
    expectedRequests: [],
    overflow: false,
    interceptionFailure: false,
    close: null,
    handler: (descriptor) => {
      const { method, route, resourceType } = descriptor;
      if (label === 'options') {
        const tokenProbeFixture = githubWorkerFixture({ route, method });
        if (tokenProbeFixture) return tokenProbeFixture;
      }
      if (method === 'GET' && route === 'github-web' && resourceType === 'document') {
        const pageLabel = label.includes('page-b') ? 'B' : 'A';
        return {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: { 'cache-control': 'no-store' },
          body: `<!doctype html>
<html>
<head><title>Runtime Stars ${pageLabel}</title><link rel="icon" href="data:,"></head>
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
      return label === 'options' ? null : githubWorkerFixture(descriptor);
    },
  };
  Object.defineProperty(policy, 'label', { value: label, enumerable: false });
  return policy;
}

async function openOrganizeContentPage(activeBrowser, url, label) {
  const policy = createPagePolicy(label);
  pagePolicies.add(policy);
  const page = await openHttpFixturePage(activeBrowser, url, label, {
    timeoutMs: SETUP_TIMEOUT_MS,
    rootSelector: 'main',
    failClosedHttp: policy,
  });
  const diagnostics = hookPageDiagnostics(page, label, { issues: pageIssues });
  pageDiagnostics.add(diagnostics);
  return page;
}

function githubWorkerFixture({ route, method }) {
  const json = (body, kind, status = 200, headers = {}) => ({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
    kind,
  });
  if (method === 'GET' && route === 'github-starred') {
    const repositories = Array.from({ length: ROW_COUNT }, (_, index) => {
      const fullName = `runtime/repo-${String(index).padStart(3, '0')}`;
      return {
        starred_at: '2026-07-14T00:00:00Z',
        repo: {
          id: index + 1,
          node_id: `runtime-node-${index + 1}`,
          name: `repo-${String(index).padStart(3, '0')}`,
          full_name: fullName,
          private: false,
          owner: { login: 'runtime', id: 1, avatar_url: null, html_url: 'https://github.com/runtime' },
          html_url: `https://github.com/${fullName}`,
          description: `Runtime repository ${index}`,
          fork: false,
          created_at: '2026-07-14T00:00:00Z',
          updated_at: '2026-07-14T00:00:00Z',
          pushed_at: '2026-07-14T00:00:00Z',
          stargazers_count: index,
          watchers_count: index,
          language: index % 2 ? 'TypeScript' : 'Rust',
          forks_count: 0,
          open_issues_count: 0,
          default_branch: 'main',
          topics: ['runtime'],
          archived: false,
          disabled: false,
          visibility: 'public',
        },
      };
    });
    return json(repositories, 'github_starred');
  }
  const routes = {
    'GET github-user': json(
      { login: 'runtime-user', avatar_url: null, name: 'Runtime User' },
      'github_token_user',
      200,
      { 'x-oauth-scopes': 'public_repo, gist' },
    ),
    'GET github-watch-scope': json([], 'github_watch_scope'),
    // This host configures only the main token; dedicated notification-token coverage lives in extension-browser-smoke.mjs.
    'POST github-gists': json({ id: 'runtime-probe-gist' }, 'github_gist_create', 201),
    'DELETE github-probe-gist': {
      status: 204,
      contentType: 'application/json',
      headers: {},
      body: '',
      kind: 'github_gist_delete',
    },
  };
  return routes[`${method} ${route}`] ?? null;
}

function classifyRuntimeRoute(value) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') return 'responses';
    if (url.origin === 'https://api.github.com' && url.pathname === '/user') return 'github-user';
    if (url.origin === 'https://api.github.com' && url.pathname === '/user/starred') return 'github-starred';
    if (url.origin === 'https://api.github.com' && url.pathname === '/user/subscriptions') return 'github-watch-scope';
    if (url.origin === 'https://api.github.com' && url.pathname === '/notifications') return 'github-notifications';
    if (url.origin === 'https://api.github.com' && url.pathname === '/gists/runtime-probe-gist') return 'github-probe-gist';
    if (url.origin === 'https://api.github.com' && url.pathname === '/gists') return 'github-gists';
    if (url.origin === 'https://api.github.com' && /^\/repos\/[^/]+\/[^/]+$/u.test(url.pathname)) return 'github-repository';
  } catch {}
  return 'unexpected-http';
}

function isHttpRequestUrl(value) {
  return /^https?:\/\//iu.test(String(value));
}

function safeHttpMethod(value) {
  const method = typeof value === 'string' ? value.toUpperCase() : '';
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'OTHER';
}

function appendBounded(records, entry, control) {
  if (records.length >= 128) {
    control.overflow = true;
    return;
  }
  records.push(Object.freeze(entry));
}

function safeProviderStage(value) {
  return ['requestPaused', 'releaseStall'].includes(value) ? value : 'provider_interception';
}

function safeProviderKind(value) {
  return ['unknown', 'probe-tool', 'probe-ack', 'analyzer', 'analyzer-stall', 'unexpected-http'].includes(value)
    ? value
    : 'provider_request';
}

async function installControlledProvider(target, existingControl = null) {
  const client = await target.createCDPSession();
  return installControlledProviderClient(client, existingControl);
}

async function installControlledProviderClient(client, existingControl = null, { reuseEnabledGate = false } = {}) {
  const control = existingControl ?? {
    analyzerMode: 'unchanged',
    actionTag: 'runtime-e2e',
    stallNextAnalyzer: false,
    capture: [],
    httpFixtureCapture: [],
    unexpectedRequests: [],
    pendingInterceptions: new Set(),
    liveInterceptions: new Set(),
    interceptionFailures: [],
    expectedInterruptions: [],
    clientStates: new Set(),
    overflow: false,
  };
  // A replacement worker owns a new CDP session. Retiring the prior listeners
  // prevents duplicate Network observations from being attributed to it.
  if (control.activeClientState) control.activeClientState.retired = true;
  control.client = client;
  control.releaseStall = null;

  const clientState = {
    retired: false,
    client,
    fetchRequestIds: new Set(),
    providerNetworkRequests: new Map(),
    unmatchedNetworkByRequestKey: new Map(),
    unmatchedFetchByRequestKey: new Map(),
  };
  control.activeClientState = clientState;
  control.clientStates.add(clientState);
  if (!reuseEnabledGate) await client.send('Network.enable');
  client.on('Network.requestWillBeSent', (event) => {
    if (clientState.retired || !isHttpRequestUrl(event.request.url)) return;
    const lifecycle = getProviderNetworkLifecycle(clientState, event.requestId);
    lifecycle.request = { method: safeHttpMethod(event.request.method), route: classifyRuntimeRoute(event.request.url) };
    const requestKey = controlledProviderRequestKey(event.request);
    const record = shiftControlledProviderMatch(clientState.unmatchedFetchByRequestKey, requestKey);
    if (record) linkControlledProviderLifecycle(lifecycle, record);
    else queueControlledProviderMatch(clientState.unmatchedNetworkByRequestKey, requestKey, lifecycle);
  });
  client.on('Network.responseReceived', (event) => {
    if (clientState.retired || !isHttpRequestUrl(event.response.url)) return;
    const lifecycle = getProviderNetworkLifecycle(clientState, event.requestId);
    lifecycle.response = { status: Number.isSafeInteger(event.response.status) ? event.response.status : null };
  });
  client.on('Network.loadingFailed', (event) => {
    if (clientState.retired) return;
    const lifecycle = clientState.providerNetworkRequests.get(event.requestId);
    if (!lifecycle) return;
    lifecycle.loadingFailure = event;
    if (lifecycle.record) lifecycle.record.loadingFailure = event;
  });
  if (!reuseEnabledGate) {
    await client.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
  }
  client.on('Fetch.requestPaused', (event) => {
    if (clientState.retired) return;
    if (!isHttpRequestUrl(event.request.url)) {
      void client.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {
        appendBounded(control.interceptionFailures, { stage: 'provider_interception', kind: 'provider_request' }, control);
      });
      return;
    }
    const record = {
      clientState,
      requestId: event.requestId,
      networkId: event.networkId ?? null,
      route: classifyRuntimeRoute(event.request.url),
      method: safeHttpMethod(event.request.method),
      kind: 'unknown',
      state: 'paused',
      loadingFailure: null,
    };
    const duplicateRequestId = clientState.fetchRequestIds.has(record.requestId);
    clientState.fetchRequestIds.add(record.requestId);
    control.liveInterceptions.add(record);
    const requestKey = controlledProviderRequestKey(event.request);
    const lifecycle = shiftControlledProviderMatch(clientState.unmatchedNetworkByRequestKey, requestKey);
    if (lifecycle) linkControlledProviderLifecycle(lifecycle, record);
    else queueControlledProviderMatch(clientState.unmatchedFetchByRequestKey, requestKey, record);
    if (duplicateRequestId) {
      trackControlledProviderTask(
        control,
        record,
        Promise.reject(new Error(`Duplicate Fetch.requestPaused ID ${record.requestId}.`)),
        'requestPaused',
      );
      return;
    }
    trackControlledProviderTask(
      control,
      record,
      handleControlledProviderRequest(control, client, event, record),
      'requestPaused',
    );
  });
  return control;
}

async function preinstallAutoAttachedControlledProviderClient(control, stoppedClientState, client) {
  assert.equal(stoppedClientState, control.activeClientState);
  await installControlledProviderClient(client, control);
  return Object.freeze({
    client,
    installedClient: control.activeClientState,
    attachmentId: client.id?.() ?? 'auto-attached-cdp-session',
  });
}

function settleStoppedControlledProviderClient(control, stoppedClientState) {
  const stalled = [...control.liveInterceptions].filter((record) => (
    record.clientState === stoppedClientState
    && record.kind === 'analyzer-stall'
    && record.state === 'paused'
  ));
  runtimeStage = 'worker_recovery_replacement_preinstall_stalled_count';
  assert.equal(stalled.length, 1, 'Stopped worker must retain exactly one interrupted analyzer request.');
  runtimeStage = 'worker_recovery_replacement_preinstall_stopped_interruption';
  settleStoppedProviderInterception(control, stalled[0]);
  control.releaseStall = null;
  assert.equal(control.releaseStall, null);
}

async function retireReplacementControlledProviderClient(clientState) {
  if (!clientState || clientState.retired) return false;
  clientState.retired = true;
  return true;
}

function getProviderNetworkLifecycle(clientState, networkId) {
  let lifecycle = clientState.providerNetworkRequests.get(networkId);
  if (!lifecycle) {
    lifecycle = { request: null, response: null, loadingFailure: null, record: null };
    clientState.providerNetworkRequests.set(networkId, lifecycle);
  }
  return lifecycle;
}

function controlledProviderRequestKey(request) {
  return `${request.method ?? 'GET'} ${request.url}`;
}

function queueControlledProviderMatch(queueMap, requestKey, value) {
  const queue = queueMap.get(requestKey) ?? [];
  queue.push(value);
  queueMap.set(requestKey, queue);
}

function shiftControlledProviderMatch(queueMap, requestKey) {
  const queue = queueMap.get(requestKey);
  if (!queue?.length) return null;
  const value = queue.shift();
  if (!queue.length) queueMap.delete(requestKey);
  return value;
}

function linkControlledProviderLifecycle(lifecycle, record) {
  lifecycle.record = record;
  record.networkLifecycle = lifecycle;
  if (lifecycle.loadingFailure) record.loadingFailure = lifecycle.loadingFailure;
}

async function handleControlledProviderRequest(control, client, event, record) {
  if (record.route !== 'responses') {
    const fixture = githubWorkerFixture({ route: record.route, method: record.method });
    if (!fixture) {
      appendBounded(control.unexpectedRequests, { route: record.route, method: record.method }, control);
      record.kind = 'unexpected-http';
      await client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' });
      record.state = 'failed-closed';
      forgetLiveInterception(control, record);
      return;
    }
    record.kind = fixture.kind;
    appendBounded(control.httpFixtureCapture, {
      route: record.route,
      method: record.method,
      status: fixture.status,
    }, control);
    await fulfillControlledProviderRequest(control, client, event, record, {
      status: fixture.status,
      body: fixture.body,
      contentType: fixture.contentType,
      headers: fixture.headers,
    });
    return;
  }
  const body = JSON.parse(event.request.postData ?? '{}');
  const request = normalizeControlledProviderRequest(body, event.request.url);
  let kind = 'unknown';
  let completion;
  let analyzerBatch = null;

  if (request.toolName === 'bgsm_connection_probe') {
    kind = 'probe-tool';
    completion = {
      toolCall: {
        id: 'call-runtime-probe',
        name: request.toolName,
        arguments: JSON.stringify({ nonce: 'bgsm' }),
      },
    };
  } else if (request.hasToolResult && request.priorToolNames.includes('bgsm_connection_probe')) {
    kind = 'probe-ack';
    completion = { content: 'runtime provider ready' };
  } else if (request.toolName === 'submit_semantic_tag_batch_proposal') {
    kind = control.stallNextAnalyzer ? 'analyzer-stall' : 'analyzer';
    control.stallNextAnalyzer = false;
    const { batch } = JSON.parse(request.userText || '{}');
    analyzerBatch = batch;
    const classifications = batch.repositories.map((repository, index) => ({
      frozenIndex: repository.frozenIndex,
      repositoryId: repository.repositoryId,
      sourceFingerprint: repository.sourceFingerprint,
      classifications: (
        control.analyzerMode === 'actionable-all' ||
        (control.analyzerMode === 'actionable' && index === 0)
      )
        ? [{ kind: 'propose_new_tag', tag: control.actionTag, evidence: 'Synthetic runtime evidence.' }]
        : [{ kind: 'unchanged', evidence: 'Synthetic unchanged runtime classification.' }],
    }));
    completion = {
      toolCall: {
        id: `call-runtime-analyzer-${control.capture.length + 1}`,
        name: request.toolName,
        arguments: JSON.stringify({
          version: 1,
          runId: batch.runId,
          generation: batch.generation,
          scopeFingerprint: batch.scopeFingerprint,
          rows: classifications,
        }),
      },
    };
  } else {
    throw new Error(`Unexpected controlled provider request: ${JSON.stringify(body.tool_choice)}`);
  }

  record.kind = kind;
  appendBounded(control.capture, {
    kind,
    route: record.route,
    authorizationPresent: !!(
      event.request.headers.Authorization ?? event.request.headers.authorization
    ),
    hiddenPolicyPresent: (event.request.postData ?? '').includes('runtime-hidden-policy'),
    generation: analyzerBatch?.generation ?? null,
    batchStart: analyzerBatch?.repositories?.[0]?.frozenIndex ?? null,
    batchEnd: analyzerBatch?.repositories?.at(-1)?.frozenIndex + 1 || null,
  }, control);
  const controlledResponse = request.protocol === 'responses'
    ? { status: 200, body: buildResponsesSse(completion, control.capture.length), contentType: 'text/event-stream' }
    : { status: 200, body: buildChatCompletion(completion, body.model, control.capture.length), contentType: 'application/json' };
  const fulfill = () => fulfillControlledProviderRequest(control, client, event, record, controlledResponse);
  if (kind === 'analyzer-stall') {
    let released = false;
    control.releaseStall = () => {
      if (released) return Promise.resolve();
      released = true;
      return trackControlledProviderTask(control, record, fulfill(), 'releaseStall');
    };
    return;
  }
  await fulfill();
}

async function fulfillControlledProviderRequest(control, client, event, record, controlledResponse) {
  assert.equal(record.state, 'paused', `Cannot fulfill interception from state ${record.state}.`);
  if (record.state === 'paused' && isPreciseAbortedRequest(record.loadingFailure)) {
    settleExpectedAbortedInterception(control, record, 'aborted-before-fulfill');
    return;
  }
  try {
    await client.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: controlledResponse.status ?? 200,
      responseHeaders: [
        { name: 'content-type', value: controlledResponse.contentType },
        ...Object.entries(controlledResponse.headers ?? {}).map(([name, value]) => ({ name, value })),
      ],
      body: Buffer.from(controlledResponse.body).toString('base64'),
    });
    record.state = 'fulfilled';
    forgetLiveInterception(control, record);
  } catch (error) {
    // A stopped run can cancel fetch after requestPaused but before fulfillment; only its exact
    // Network.loadingFailed lifecycle proves that this interception ID became stale by abortion.
    if (record.state === 'paused' && isInvalidInterceptionId(error) && await waitForPreciseRequestAbort(record)) {
      settleExpectedAbortedInterception(control, record, 'aborted-during-fulfill');
      return;
    }
    throw error;
  }
}

function trackControlledProviderTask(control, record, task, phase) {
  const tracked = Promise.resolve(task)
    .catch((error) => recordControlledProviderFailure(control, record, error, phase))
    .finally(() => control.pendingInterceptions.delete(tracked));
  control.pendingInterceptions.add(tracked);
  return tracked;
}

async function recordControlledProviderFailure(control, record, error, phase) {
  record.state = 'failed';
  forgetLiveInterception(control, record);
  appendBounded(control.interceptionFailures, {
    stage: safeProviderStage(phase),
    kind: safeProviderKind(record.kind),
  }, control);
  try {
    await record.clientState.client.send('Fetch.failRequest', {
      requestId: record.requestId,
      errorReason: 'Failed',
    });
  } catch (cleanupError) {
    if (!(isInvalidInterceptionId(cleanupError, 'Fetch.failRequest') && isPreciseAbortedRequest(record.loadingFailure))) {
      appendBounded(control.interceptionFailures, {
        stage: 'fail_closed_cleanup',
        kind: safeProviderKind(record.kind),
      }, control);
    }
  }
}

function isInvalidInterceptionId(error, command = 'Fetch.fulfillRequest') {
  if (!(error instanceof Error)) return false;
  const expected = `Protocol error (${command}): Invalid InterceptionId`;
  return error.message === expected || error.message === `${expected}.`;
}

function isPreciseAbortedRequest(failure) {
  return failure?.type === 'Fetch'
    && failure.canceled === true
    && failure.errorText === 'net::ERR_ABORTED'
    && failure.blockedReason === undefined;
}


async function waitForPreciseRequestAbort(record, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isPreciseAbortedRequest(record.loadingFailure)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function settleStoppedProviderInterception(control, record) {
  assert.equal(record.state, 'paused', `Cannot interrupt interception from state ${record.state}.`);
  assert.equal(record.kind, 'analyzer-stall');
  record.state = 'interrupted';
  forgetLiveInterception(control, record);
  control.expectedInterruptions.push(Object.freeze({
    kind: 'analyzer-stall',
    lifecycle: 'stopped-target',
  }));
}

function settleExpectedAbortedInterception(control, record, lifecycle) {
  assert.equal(record.state, 'paused', `Cannot abort interception from state ${record.state}.`);
  record.state = 'aborted';
  forgetLiveInterception(control, record);
  control.expectedInterruptions.push(Object.freeze({
    kind: safeProviderKind(record.kind),
    lifecycle,
  }));
}


function forgetLiveInterception(control, record) {
  control.liveInterceptions.delete(record);
}

async function assertControlledProviderHealthy(control) {
  if (!control) return;
  while (control.pendingInterceptions.size > 0) {
    await Promise.allSettled([...control.pendingInterceptions]);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (control.pendingInterceptions.size > 0) {
    await Promise.allSettled([...control.pendingInterceptions]);
  }
  const liveFailures = [...control.liveInterceptions].map((record) => new Error(
    `Controlled provider left ${record.kind} request ${record.requestId} unresolved in state ${record.state}.`,
  ));
  const networkFailures = [...control.clientStates].flatMap((clientState) => (
    [...clientState.providerNetworkRequests.entries()].flatMap(([networkId, lifecycle]) => {
      if (!lifecycle.record) {
        return [new Error(`Provider network request ${networkId} escaped Fetch interception.`)];
      }
      if (lifecycle.response && lifecycle.record.state !== 'fulfilled') {
        return [new Error(
          `Provider network request ${networkId} received a response after settling as ${lifecycle.record.state}.`,
        )];
      }
      return [];
    })
  ));
  const failures = [...control.interceptionFailures, ...liveFailures, ...networkFailures];
  if (failures.length > 0) {
    throw new AggregateError(failures, `Controlled provider interception failed (${failures.length} failure(s)).`);
  }
}

function normalizeControlledProviderRequest(body, url) {
  const protocol = url.endsWith('/responses') ? 'responses' : 'chat';
  if (protocol === 'responses') {
    const input = Array.isArray(body.input) ? body.input : [];
    const user = [...input].reverse().find((entry) => entry?.role === 'user');
    const userText = Array.isArray(user?.content)
      ? user.content.filter((part) => part?.type === 'input_text').map((part) => part.text).join('')
      : '';
    return {
      protocol,
      toolName: body.tool_choice?.type === 'function' ? body.tool_choice.name : null,
      hasToolResult: input.some((entry) => entry?.type === 'function_call_output'),
      priorToolNames: input.filter((entry) => entry?.type === 'function_call').map((entry) => entry.name),
      offeredToolNames: (body.tools ?? []).map((tool) => tool.name),
      userText,
    };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = [...messages].reverse().find((entry) => entry?.role === 'user');
  return {
    protocol,
    toolName: body.tool_choice?.function?.name ?? null,
    hasToolResult: messages.some((message) => message?.role === 'tool'),
    priorToolNames: messages.flatMap((message) =>
      message?.tool_calls?.map((call) => call.function?.name) ?? []),
    offeredToolNames: (body.tools ?? []).map((tool) => tool.function?.name),
    userText: typeof user?.content === 'string' ? user.content : '',
  };
}

function buildChatCompletion(completion, model, sequence) {
  const message = completion.toolCall
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: completion.toolCall.id,
          type: 'function',
          function: {
            name: completion.toolCall.name,
            arguments: completion.toolCall.arguments,
          },
        }],
      }
    : { role: 'assistant', content: completion.content };
  return JSON.stringify({
    id: `chatcmpl-runtime-${sequence}`,
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: completion.toolCall ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

function buildResponsesSse(completion, sequence) {
  const responseId = `resp_runtime_${sequence}`;
  const events = [{
    type: 'response.created',
    response: { id: responseId, status: 'in_progress' },
  }];
  if (completion.toolCall) {
    const itemId = `fc_runtime_${sequence}`;
    const call = completion.toolCall;
    events.push(
      {
        type: 'response.output_item.added', response_id: responseId, output_index: 0,
        item: { id: itemId, type: 'function_call', call_id: call.id, name: call.name, arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta', response_id: responseId,
        item_id: itemId, output_index: 0, delta: call.arguments,
      },
      {
        type: 'response.function_call_arguments.done', response_id: responseId,
        item_id: itemId, output_index: 0, arguments: call.arguments,
      },
      {
        type: 'response.output_item.done', response_id: responseId, output_index: 0,
        item: {
          id: itemId, type: 'function_call', status: 'completed', call_id: call.id,
          name: call.name, arguments: call.arguments,
        },
      },
    );
  } else {
    const itemId = `msg_runtime_${sequence}`;
    const text = completion.content ?? '';
    events.push(
      {
        type: 'response.output_item.added', response_id: responseId, output_index: 0,
        item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      },
      {
        type: 'response.content_part.added', response_id: responseId, item_id: itemId,
        output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta', response_id: responseId, item_id: itemId,
        output_index: 0, content_index: 0, delta: text,
      },
      {
        type: 'response.output_text.done', response_id: responseId, item_id: itemId,
        output_index: 0, content_index: 0, text,
      },
      {
        type: 'response.content_part.done', response_id: responseId, item_id: itemId,
        output_index: 0, content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      },
      {
        type: 'response.output_item.done', response_id: responseId, output_index: 0,
        item: {
          id: itemId, type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      },
    );
  }
  events.push({
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    },
  });
  return events.map((entry) => `event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`).join('');
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for controlled runtime state.');
}

async function withRuntimeStage(stage, operation) {
  const previousStage = runtimeStage;
  runtimeStage = stage;
  try {
    const result = await operation();
    runtimeStage = previousStage;
    return result;
  } catch (error) {
    throw error;
  }
}

async function waitForOptionsReady(page) {
  await page.waitForFunction(() => {
    const refresh = document.querySelector('[data-testid="agent-storage-panel"] button');
    return !!document.querySelector('#agent-provider') && !!refresh && !refresh.disabled;
  }, { timeout: SETUP_TIMEOUT_MS });
}

async function saveGitHubToken(page) {
  runtimeStage = 'configure_production_github_field';
  await page.waitForSelector('textarea[placeholder="github_pat_..."]:not([disabled])', {
    visible: true,
    timeout: TIMEOUT_MS,
  });
  runtimeStage = 'configure_production_github_select';
  await page.evaluate(() => {
    const input = document.querySelector('textarea[placeholder="github_pat_..."]');
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('github_credential_field_unavailable');
    input.focus();
    input.select();
  });
  runtimeStage = 'configure_production_github_type';
  await page.keyboard.type(GITHUB_CREDENTIAL);
  runtimeStage = 'configure_production_github_ready';
  await page.waitForFunction((credential) => (
    document.querySelector('textarea[placeholder="github_pat_..."]')?.value === credential
    && [...document.querySelectorAll('button')].some((button) => (
      /^Save & verify$/iu.test(button.textContent?.trim() ?? '') && !button.disabled
    ))
  ), { timeout: TIMEOUT_MS }, GITHUB_CREDENTIAL);
  runtimeStage = 'configure_production_github_click';
  await clickTrustedText(page, 'button', /^Save & verify$/iu);
  runtimeStage = 'configure_production_github_settled';
  await waitUntil(() => page.evaluate(() => {
    const input = document.querySelector('textarea[placeholder="github_pat_..."]');
    const authenticated = [...document.querySelectorAll('a')].some((anchor) => (
      anchor.getAttribute('href') === 'https://github.com/runtime-user?tab=stars'
    ));
    const settledSave = [...document.querySelectorAll('button')].some((button) => (
      /^Save & verify$/iu.test(button.textContent?.trim() ?? '') && button.disabled
    ));
    return authenticated
      && input instanceof HTMLTextAreaElement
      && input.value === ''
      && settledSave;
  }), TIMEOUT_MS);
  runtimeStage = 'configure_production_github_identity';
  await waitUntil(() => page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'getUsername' });
    return response?.ok === true && response.data?.username === 'runtime-user';
  }), TIMEOUT_MS);
}

async function waitForStarsManager(page, stagePrefix = null) {
  if (stagePrefix) runtimeStage = `${stagePrefix}_entry`;
  await page.waitForFunction(() => (
    !!document.getElementById('gsm-manager-host')?.shadowRoot?.getElementById('gsm-manager-root')
    || !!document.getElementById('gsm-fab')?.shadowRoot?.querySelector('button')
  ), { timeout: SETUP_TIMEOUT_MS });
  const managerReady = await page.evaluate(() => !!document.getElementById('gsm-manager-host')
    ?.shadowRoot?.getElementById('gsm-manager-root'));
  if (managerReady) return;
  if (stagePrefix) runtimeStage = `${stagePrefix}_fab`;
  const point = await page.evaluate(() => {
    const root = document.getElementById('gsm-fab')?.shadowRoot;
    const button = root?.querySelector('button');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const hitTarget = root?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!(hitTarget === button || button.contains(hitTarget))) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (!point) throw new Error('organize_manager_entry_unavailable');
  await page.mouse.click(point.x, point.y);
  if (stagePrefix) runtimeStage = `${stagePrefix}_manager`;
  await page.waitForFunction(() => !!document.getElementById('gsm-manager-host')
    ?.shadowRoot?.getElementById('gsm-manager-root'), { timeout: SETUP_TIMEOUT_MS });
}
async function classifyContentEntry(page, extensionId) {
  const session = await page.target().createCDPSession();
  const contexts = [];
  session.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  try {
    await session.send('Runtime.enable');
    let extensionContext = null;
    for (const context of contexts) {
      if (context.auxData?.type !== 'isolated') continue;
      const probe = await session.send('Runtime.evaluate', {
        contextId: context.id,
        expression: 'globalThis.chrome?.runtime?.id ?? null',
        returnByValue: true,
      });
      if (probe.result?.value === extensionId) {
        extensionContext = context;
        break;
      }
    }
    if (!extensionContext) return 'content_script_missing';
    const response = await session.send('Runtime.evaluate', {
      contextId: extensionContext.id,
      expression: `(async () => {
        const config = (await chrome.storage.local.get('gsm_config')).gsm_config;
        return JSON.stringify({
          username: config?.username ?? null,
          panelEnabled: config?.starsPanelDefaultEnabled !== false,
          pathname: location.pathname,
          starsTab: new URLSearchParams(location.search).get('tab') === 'stars',
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const state = JSON.parse(response.result?.value ?? '{}');
    if (state.username !== 'runtime-user'
      || state.pathname !== '/runtime-user'
      || state.starsTab !== true) return 'owner_identity_mismatch';
    if (state.panelEnabled !== true) return 'panel_disabled';
    return 'entry_unknown';
  } catch {
    return 'entry_unknown';
  } finally {
    await session.detach().catch(() => {});
  }
}



async function runTrustedFullSync(page, storagePage, expectedCount) {
  runtimeStage = 'production_full_sync_wait_button';
  await waitUntil(() => page.evaluate(() => {
    const button = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('[data-coach-target="full-sync"]');
    return button instanceof HTMLButtonElement
      && !button.disabled
      && button.getClientRects().length > 0;
  }), TIMEOUT_MS);
  await dismissOnboardingTourIfVisible(page);
  await waitUntil(() => page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const button = root?.querySelector('[data-coach-target="full-sync"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    const rect = button.getBoundingClientRect();
    const hitTarget = root?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!hitTarget && (hitTarget === button || button.contains(hitTarget));
  }), TIMEOUT_MS);
  runtimeStage = 'production_full_sync_open_menu';
  await clickShadowSelectorTrusted(page, '[data-coach-target="full-sync"]');
  runtimeStage = 'production_full_sync_confirm';
  await waitUntil(() => page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const button = root?.querySelector('[data-radix-popper-content-wrapper] button');
    return button instanceof HTMLButtonElement
      && [...button.querySelectorAll('span')].some((label) => (
        /^Full Sync$/iu.test(label.textContent?.trim() ?? '')
      ))
      && !button.disabled
      && button.getClientRects().length > 0;
  }), TIMEOUT_MS);
  await clickShadowTextTrusted(
    page,
    'button',
    /^Full Sync/iu,
    '[data-radix-popper-content-wrapper]',
  );
  runtimeStage = 'production_full_sync_settled';
  await waitUntil(() => page.evaluate(() => {
    const button = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('[data-coach-target="full-sync"]');
    return button instanceof HTMLButtonElement && button.disabled;
  }), TIMEOUT_MS);
  await waitUntil(async () => {
    const uiIdle = await page.evaluate(() => {
      const button = document.getElementById('gsm-manager-host')?.shadowRoot
        ?.querySelector('[data-coach-target="full-sync"]');
      return button instanceof HTMLButtonElement
        && !button.disabled
        && button.getClientRects().length > 0;
    });
    if (!uiIdle) return false;
    return await storagePage.evaluate(hasExpectedStarCount, expectedCount);
  }, TIMEOUT_MS);
}

async function hasExpectedStarCount(expectedCount) {
  const databases = await indexedDB.databases();
  if (!databases.some((database) => database.name === 'better-github-stars-manager')) return false;
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('organize_idb_open_failed'));
  });
  if (!database.objectStoreNames.contains('stars')) {
    database.close();
    return false;
  }
  try {
    const transaction = database.transaction('stars', 'readonly');
    const actual = await new Promise((resolve, reject) => {
      const request = transaction.objectStore('stars').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('organize_idb_count_failed'));
    });
    return actual === expectedCount;
  } finally {
    database.close();
  }
}

async function dismissOnboardingTourIfVisible(page) {
  const tourVisible = await page.evaluate(() => [...(document.getElementById('gsm-manager-host')
    ?.shadowRoot?.querySelectorAll('button') ?? [])].some((button) => (
    /^Skip tour$/u.test(button.textContent?.trim() ?? '')
    && !button.disabled
    && button.getClientRects().length > 0
  )));
  if (!tourVisible) return;
  await clickShadowTextTrusted(page, 'button', /^Skip tour$/u);
  await waitUntil(() => page.evaluate(() => ![...(document.getElementById('gsm-manager-host')
    ?.shadowRoot?.querySelectorAll('button') ?? [])].some((button) => (
    /^Skip tour$/u.test(button.textContent?.trim() ?? '')
    && button.getClientRects().length > 0
  ))), TIMEOUT_MS);
}


async function clickTrustedText(page, selector, matcher) {
  const point = await page.evaluate(({ target, source, flags }) => {
    const expression = new RegExp(source, flags);
    const element = [...document.querySelectorAll(target)].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return expression.test(candidate.textContent?.trim() ?? '')
        && !(candidate instanceof HTMLButtonElement && candidate.disabled)
        && rect.width > 0
        && rect.height > 0;
    });
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!(hitTarget === element || element.contains(hitTarget))) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { target: selector, source: matcher.source, flags: matcher.flags });
  if (!point) throw new Error('organize_trusted_text_target_unavailable');
  await page.mouse.click(point.x, point.y);
}

async function shadowElement(page, selector) {
  const handle = await page.evaluateHandle((target) => document.getElementById('gsm-manager-host')
    ?.shadowRoot?.querySelector(target) ?? null, selector);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new Error('organize_shadow_target_unavailable');
  }
  return element;
}

async function clickShadowSelectorTrusted(page, selector) {
  const point = await page.evaluate((target) => {
    const element = document.getElementById('gsm-manager-host')?.shadowRoot?.querySelector(target);
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (element instanceof HTMLButtonElement && element.disabled) return null;
    const hitTarget = element.getRootNode().elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (!(hitTarget === element || element.contains(hitTarget))) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
  if (!point) throw new Error('organize_shadow_target_unavailable');
  await page.mouse.click(point.x, point.y);
}

async function clickShadowTextTrusted(page, selector, matcher, scope = null) {
  const point = await page.evaluate(({ target, source, flags, scopeSelector }) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const scopeNode = scopeSelector ? root?.querySelector(scopeSelector) : root;
    const expression = new RegExp(source, flags);
    const element = [...(scopeNode?.querySelectorAll(target) ?? [])].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return expression.test(candidate.textContent?.trim() ?? '')
        && !(candidate instanceof HTMLButtonElement && candidate.disabled)
        && rect.width > 0
        && rect.height > 0;
    });
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const hitTarget = root?.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (!(hitTarget === element || element.contains(hitTarget))) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { target: selector, source: matcher.source, flags: matcher.flags, scopeSelector: scope });
  if (!point) throw new Error('organize_shadow_text_target_unavailable');
  await page.mouse.click(point.x, point.y);
}
async function openAgentDrawer(page) {
  if (await page.evaluate(isAgentDrawerReady)) return;
  await clickShadowSelectorTrusted(page, '[data-coach-target="agent"]');
  await waitUntil(() => page.evaluate(isAgentDrawerReady), TIMEOUT_MS);
}

function isAgentDrawerReady() {
  const root = document.getElementById('gsm-manager-host')?.shadowRoot;
  const drawer = root?.querySelector('aside[role="dialog"]');
  const composer = drawer?.querySelector('textarea');
  return !!drawer && drawer.getAttribute('aria-hidden') !== 'true'
    && composer instanceof HTMLTextAreaElement && !composer.disabled;
}

async function waitForSessionCatalogTrigger(page) {
  await waitUntil(() => page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const list = root?.querySelector('[data-testid="agent-session-list"]');
    const toggle = root?.querySelector('[data-testid="agent-session-toggle"]');
    if (list || !(toggle instanceof HTMLButtonElement) || toggle.disabled) return false;
    const rect = toggle.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const hitTarget = root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hitTarget === toggle || toggle.contains(hitTarget);
  }), TIMEOUT_MS);
}

async function openSessionCatalog(page) {
  const open = await page.evaluate(() => {
    const list = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('[data-testid="agent-session-list"]');
    return list instanceof HTMLElement
      && list.getAttribute('data-state') === 'open'
      && list.getClientRects().length > 0;
  });
  if (!open) {
    await waitForSessionCatalogTrigger(page);
    await clickShadowSelectorTrusted(page, '[data-testid="agent-session-toggle"]');
  }
  await waitUntil(() => page.evaluate(() => {
    const list = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('[data-testid="agent-session-list"]');
    return list instanceof HTMLElement
      && list.getAttribute('data-state') === 'open'
      && list.getClientRects().length > 0;
  }), TIMEOUT_MS);
}

async function waitForSessionCatalogClose(page) {
  await waitUntil(() => page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const list = root?.querySelector('[data-testid="agent-session-list"]');
    const toggle = root?.querySelector('[data-testid="agent-session-toggle"]');
    return !list
      && toggle instanceof HTMLButtonElement
      && !toggle.disabled
      && toggle.getClientRects().length > 0;
  }), TIMEOUT_MS);
}

async function closeSessionCatalogIfOpen(page) {
  const open = await page.evaluate(() => {
    const list = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('[data-testid="agent-session-list"]');
    return list instanceof HTMLElement
      && list.getAttribute('data-state') === 'open'
      && list.getClientRects().length > 0;
  });
  if (!open) return;
  await page.keyboard.press('Escape');
  await waitForSessionCatalogClose(page);
}

async function readOpenSessionCatalog(page) {
  return page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const rows = [...(root?.querySelectorAll('[data-testid="agent-session-item"]') ?? [])];
    return {
      currentSessionId: rows.find((row) => !!row.querySelector('[aria-current="true"]'))?.getAttribute('data-session-id') ?? null,
      sessionIds: rows.map((row) => row.getAttribute('data-session-id')).filter((id) => typeof id === 'string').slice(0, 4),
    };
  });
}

async function waitForSessionRow(page, sessionId, requireCurrent = false) {
  await waitUntil(() => page.evaluate(({ expected, current }) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const row = [...(root?.querySelectorAll('[data-testid="agent-session-item"]') ?? [])]
      .find((candidate) => candidate.getAttribute('data-session-id') === expected);
    const button = row?.querySelector('button:not([data-testid="agent-session-delete"])');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    if (current && button.getAttribute('aria-current') !== 'true') return false;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const hitTarget = root?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!hitTarget && (hitTarget === button || button.contains(hitTarget));
  }, { expected: sessionId, current: requireCurrent }), TIMEOUT_MS);
}

async function clickSessionRowTrusted(page, sessionId, requireCurrent = false) {
  const point = await page.evaluate(({ expected, current }) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const row = [...(root?.querySelectorAll('[data-testid="agent-session-item"]') ?? [])]
      .find((candidate) => candidate.getAttribute('data-session-id') === expected);
    const button = row?.querySelector('button:not([data-testid="agent-session-delete"])');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    if (current && button.getAttribute('aria-current') !== 'true') return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const hitTarget = root?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!(hitTarget === button || button.contains(hitTarget))) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { expected: sessionId, current: requireCurrent });
  if (!point) throw new Error('organize_session_item_unavailable');
  await page.mouse.click(point.x, point.y);
}

async function inspectSessionCatalog(page) {
  let closed = false;
  try {
    await openSessionCatalog(page);
    let catalog;
    await waitUntil(async () => {
      catalog = await readOpenSessionCatalog(page);
      return typeof catalog.currentSessionId === 'string';
    }, TIMEOUT_MS);
    await waitForSessionRow(page, catalog.currentSessionId, true);
    await clickSessionRowTrusted(page, catalog.currentSessionId, true);
    await waitForSessionCatalogClose(page);
    closed = true;
    return catalog;
  } finally {
    if (!closed) await closeSessionCatalogIfOpen(page);
  }
}

async function selectSessionThroughUi(page, sessionId) {
  let closed = false;
  try {
    await openSessionCatalog(page);
    await waitForSessionRow(page, sessionId);
    await clickSessionRowTrusted(page, sessionId);
    await waitForSessionCatalogClose(page);

    await openSessionCatalog(page);
    await waitForSessionRow(page, sessionId, true);
    await clickSessionRowTrusted(page, sessionId, true);
    await waitForSessionCatalogClose(page);
    closed = true;
  } finally {
    if (!closed) await closeSessionCatalogIfOpen(page);
  }
}

async function readOrganizePanelState(page, expectedDraft = null) {
  return page.evaluate((expected) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const drawer = root?.querySelector('aside[role="dialog"]');
    const composer = drawer?.querySelector('textarea');
    const receiptCards = [...(drawer?.querySelectorAll('[data-testid="organize-job-receipt-card"]') ?? [])];
    return {
      composerEnabled: composer instanceof HTMLTextAreaElement && !composer.disabled,
      draftExact: expected === null || (composer instanceof HTMLTextAreaElement && composer.value === expected),
      transcriptRows: drawer?.querySelectorAll('[data-role="user"], [data-role="assistant"]').length ?? 0,
      retryCards: drawer?.querySelectorAll('[data-testid="agent-durable-retry-button"], [data-testid="agent-provider-error-card"]').length ?? 0,
      terminalCards: receiptCards.length,
      originDeletedCopy: receiptCards.filter((card) => (
        card.textContent?.includes('Started from a conversation that has been deleted.')
      )).length,
    };
  }, expectedDraft);
}


async function readOrganizeContentUi(page, expectedDraft = null) {
  const catalog = await inspectSessionCatalog(page);
  const state = await readOrganizePanelState(page, expectedDraft);
  return { ...catalog, ...state };
}

async function typeTrustedDraft(page, value) {
  const composer = await shadowElement(page, 'aside[role="dialog"] textarea');
  try {
    await composer.focus();
    await page.keyboard.down('Meta');
    await page.keyboard.press('A');
    await page.keyboard.up('Meta');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value);
  } finally {
    await composer.dispose();
  }
  await waitUntil(() => page.evaluate((expected) => {
    const composer = document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelector('aside[role="dialog"] textarea');
    return composer instanceof HTMLTextAreaElement
      && !composer.disabled
      && composer.value === expected;
  }, value), TIMEOUT_MS);
}

async function readAuthoritativeSessionIds(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('better-github-stars-manager');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('organize_idb_open_failed'));
    });
    try {
      const transaction = database.transaction('agentSessions', 'readonly');
      const keys = await new Promise((resolve, reject) => {
        const request = transaction.objectStore('agentSessions').getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('organize_idb_read_failed'));
      });
      return keys.filter((key) => typeof key === 'string').sort();
    } finally {
      database.close();
    }
  });
}

async function createReplacementSessionThroughUi(page, authorityPage, originSessionId) {
  runtimeStage = 'trusted_origin_deletion_replacement_create_authority_snapshot';
  const sessionIdsBefore = await readAuthoritativeSessionIds(authorityPage);
  assert.equal(sessionIdsBefore.includes(originSessionId), true);

  runtimeStage = 'trusted_origin_deletion_replacement_create_click';
  await page.bringToFront();
  await clickShadowSelectorTrusted(
    page,
    'aside[role="dialog"] > div:first-child button[aria-label="Start new conversation"]',
  );
  let closed = false;
  try {
    runtimeStage = 'trusted_origin_deletion_replacement_create_new_current';
    let replacementId = null;
    await waitUntil(async () => {
      const sessionIdsAfter = await readAuthoritativeSessionIds(authorityPage);
      const priorIds = new Set(sessionIdsBefore);
      const addedIds = sessionIdsAfter.filter((sessionId) => !priorIds.has(sessionId));
      if (sessionIdsAfter.length !== sessionIdsBefore.length + 1 || addedIds.length !== 1) return false;
      replacementId = addedIds[0];
      return true;
    }, TIMEOUT_MS);

    runtimeStage = 'trusted_origin_deletion_replacement_create_controller_settle';
    await waitUntil(() => page.evaluate(() => {
      const toggle = document.getElementById('gsm-manager-host')?.shadowRoot
        ?.querySelector('[data-testid="agent-session-toggle"]');
      return toggle instanceof HTMLButtonElement
        && !toggle.disabled
        && toggle.getClientRects().length > 0;
    }), TIMEOUT_MS);

    runtimeStage = 'trusted_origin_deletion_replacement_create_catalog_origin_presence';
    await openSessionCatalog(page);
    await waitUntil(() => page.evaluate(({ origin, replacement }) => {
      const root = document.getElementById('gsm-manager-host')?.shadowRoot;
      const rows = [...(root?.querySelectorAll('[data-testid="agent-session-item"]') ?? [])];
      const currentId = rows.find((row) => !!row.querySelector('[aria-current="true"]'))
        ?.getAttribute('data-session-id') ?? null;
      return currentId === replacement
        && rows.some((row) => row.getAttribute('data-session-id') === origin);
    }, { origin: originSessionId, replacement: replacementId }), TIMEOUT_MS);

    runtimeStage = 'trusted_origin_deletion_replacement_create_close';
    await closeSessionCatalogIfOpen(page);
    closed = true;
    return replacementId;
  } finally {
    if (!closed) await closeSessionCatalogIfOpen(page);
  }
}

async function refreshProductionContentPage(page, stagePrefix = null) {
  if (stagePrefix) runtimeStage = `${stagePrefix}_foreground`;
  await page.bringToFront();
  if (stagePrefix) runtimeStage = `${stagePrefix}_navigation`;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  if (stagePrefix) runtimeStage = `${stagePrefix}_entry`;
  await waitForStarsManager(page);
  if (stagePrefix) runtimeStage = `${stagePrefix}_drawer`;
  await openAgentDrawer(page);
}


async function readProductionAdmissionUi(page) {
  return page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const drawer = root?.querySelector('aside[role="dialog"]');
    const workbench = drawer?.querySelector('[data-testid="organize-job-workbench"]');
    const enabledActions = [...(workbench?.querySelectorAll('button') ?? [])].filter((button) => (
      button instanceof HTMLButtonElement
      && !button.disabled
      && button.getClientRects().length > 0
    )).length;
    return {
      hasWorkbench: !!workbench,
      controlNotices: workbench?.querySelectorAll('[data-testid="organize-job-control-notice"]').length ?? 0,
      enabledActions,
      terminalCards: workbench?.querySelectorAll('[data-testid="organize-job-receipt-card"]').length ?? 0,
    };
  });
}

async function runProductionNextAdmissionScenario({ pageA, pageB }) {
  let projections = null;
  await waitUntil(async () => {
    projections = await Promise.all([
      readProductionAdmissionUi(pageA),
      readProductionAdmissionUi(pageB),
    ]);
    return projections.every((projection) => (
      !projection.hasWorkbench
      && projection.controlNotices === 0
      && projection.enabledActions === 0
      && projection.terminalCards === 0
    ));
  }, TIMEOUT_MS);
  return {
    actorPages: 1,
    observerPages: 1,
    noJobProjectionPages: projections.filter((projection) => !projection.hasWorkbench).length,
    newPreflightRows: 1,
    pagesConverged: projections.every((projection) => !projection.hasWorkbench),
  };
}

async function deleteSessionThroughUi(page, sessionId) {
  runtimeStage = 'trusted_origin_deletion_trusted_delete_catalog_open';
  await page.bringToFront();
  await openSessionCatalog(page);

  runtimeStage = 'trusted_origin_deletion_trusted_delete_exact_row_delete_hit';
  await waitUntil(() => page.evaluate((expected) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const row = [...(root?.querySelectorAll('[data-testid="agent-session-item"]') ?? [])]
      .find((candidate) => candidate.getAttribute('data-session-id') === expected);
    const current = row?.querySelector('button[aria-current="true"]');
    const button = row?.querySelector('[data-testid="agent-session-delete"]');
    if (!(current instanceof HTMLButtonElement)
      || !(button instanceof HTMLButtonElement)
      || button.disabled) return false;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const hitTarget = root?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!hitTarget && (hitTarget === button || button.contains(hitTarget));
  }, sessionId), TIMEOUT_MS);
  const point = await page.evaluate((expected) => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const row = [...(root?.querySelectorAll('[data-testid="agent-session-item"]') ?? [])]
      .find((candidate) => candidate.getAttribute('data-session-id') === expected);
    const button = row?.querySelector('[data-testid="agent-session-delete"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const hitTarget = root?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!(hitTarget === button || button.contains(hitTarget))) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, sessionId);
  if (!point) throw new Error('organize_session_delete_unavailable');
  await page.mouse.click(point.x, point.y);

  runtimeStage = 'trusted_origin_deletion_trusted_delete_confirmation_ready';
  await waitUntil(() => page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const confirmation = root?.querySelector('[data-testid="agent-session-delete-confirm"]');
    const button = [...(confirmation?.querySelectorAll('button') ?? [])]
      .find((candidate) => /^Delete$/u.test(candidate.textContent?.trim() ?? ''));
    if (!(confirmation instanceof HTMLElement)
      || confirmation.getClientRects().length === 0
      || !(button instanceof HTMLButtonElement)
      || button.disabled) return false;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const hitTarget = root?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!hitTarget && (hitTarget === button || button.contains(hitTarget));
  }), TIMEOUT_MS);

  runtimeStage = 'trusted_origin_deletion_trusted_delete_confirm_hit';
  await clickShadowTextTrusted(
    page,
    'button',
    /^Delete$/u,
    '[data-testid="agent-session-delete-confirm"]',
  );

  runtimeStage = 'trusted_origin_deletion_trusted_delete_committed_menu_close';
  await waitForSessionCatalogClose(page);
}

async function readOriginDeletionAuthority(page, { originSessionId, replacementSessionId, jobId, applyId }) {
  return page.evaluate(async (identity) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('better-github-stars-manager');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('organize_idb_open_failed'));
    });
    const read = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('organize_idb_read_failed'));
    });
    try {
      const transaction = database.transaction([
        'agentSessions',
        'agentAttempts',
        'agentAttemptRecoveries',
        'agentMessages',
        'organizeJobs',
        'organizeApplies',
        'organizeApplyRows',
      ], 'readonly');
      const range = IDBKeyRange.only(identity.originSessionId);
      const [origin, replacement, attempts, recoveries, messages, job, apply, applyRows] = await Promise.all([
        read(transaction.objectStore('agentSessions').get(identity.originSessionId)),
        read(transaction.objectStore('agentSessions').get(identity.replacementSessionId)),
        read(transaction.objectStore('agentAttempts').index('sessionId').count(range)),
        read(transaction.objectStore('agentAttemptRecoveries').index('sessionId').count(range)),
        read(transaction.objectStore('agentMessages').index('sessionId').count(range)),
        read(transaction.objectStore('organizeJobs').get(identity.jobId)),
        read(transaction.objectStore('organizeApplies').get(identity.applyId)),
        read(transaction.objectStore('organizeApplyRows').index('applyId').count(identity.applyId)),
      ]);
      return {
        originRows: origin ? 1 : 0,
        replacementRows: replacement ? 1 : 0,
        attemptRows: attempts,
        recoveryRows: recoveries,
        messageRows: messages,
        terminalRows: job?.status === 'completed' && job.originAgentSessionId === identity.originSessionId ? 1 : 0,
        applyRows: apply?.jobId === identity.jobId ? applyRows : 0,
      };
    } finally {
      database.close();
    }
  }, { originSessionId, replacementSessionId, jobId, applyId });
}

async function runOriginDeletionInvalidationScenario({
  pageA,
  pageB,
  authorityPage,
  originSessionId,
  terminalJobId,
  applyId,
  rowCount,
}) {
  runtimeStage = 'trusted_origin_deletion_terminal_precheck';
  const terminalBefore = await Promise.all([
    readOrganizeContentUi(pageA),
    readOrganizeContentUi(pageB),
  ]);
  assert.equal(terminalBefore.every((state) => state.currentSessionId === originSessionId), true);
  assert.equal(terminalBefore.reduce((count, state) => count + state.terminalCards, 0), 2);
  runtimeStage = 'trusted_origin_deletion_replacement_create';
  const replacementSessionId = await createReplacementSessionThroughUi(
    pageA,
    authorityPage,
    originSessionId,
  );
  runtimeStage = 'trusted_origin_deletion_page_b_refresh';
  await refreshProductionContentPage(pageB);
  runtimeStage = 'trusted_origin_deletion_page_b_catalog';
  const refreshedPageBCatalog = await inspectSessionCatalog(pageB);
  assert.equal(refreshedPageBCatalog.sessionIds.includes(replacementSessionId), true);
  runtimeStage = 'trusted_origin_deletion_origin_reselect';
  await Promise.all([
    selectSessionThroughUi(pageA, originSessionId),
    selectSessionThroughUi(pageB, originSessionId),
  ]);
  assert.equal((await inspectSessionCatalog(pageB)).currentSessionId, originSessionId);
  runtimeStage = 'trusted_origin_deletion_drafts';
  await Promise.all([
    typeTrustedDraft(pageA, ORIGIN_DRAFT),
    typeTrustedDraft(pageB, OBSERVER_DRAFT),
  ]);
  runtimeStage = 'trusted_origin_deletion_trusted_delete';
  await deleteSessionThroughUi(pageA, originSessionId);
  runtimeStage = 'trusted_origin_deletion_invalidation_convergence_composer_drafts';
  let panelStates = null;
  await waitUntil(async () => {
    panelStates = await Promise.all([
      readOrganizePanelState(pageA, ORIGIN_DRAFT),
      readOrganizePanelState(pageB, OBSERVER_DRAFT),
    ]);
    return panelStates.every((state) => state.composerEnabled && state.draftExact);
  }, TIMEOUT_MS);

  runtimeStage = 'trusted_origin_deletion_invalidation_convergence_transcript_retry';
  await waitUntil(async () => {
    panelStates = await Promise.all([
      readOrganizePanelState(pageA, ORIGIN_DRAFT),
      readOrganizePanelState(pageB, OBSERVER_DRAFT),
    ]);
    return panelStates.every((state) => state.transcriptRows === 0 && state.retryCards === 0);
  }, TIMEOUT_MS);

  runtimeStage = 'trusted_origin_deletion_invalidation_convergence_terminal_projection';
  await waitUntil(async () => {
    panelStates = await Promise.all([
      readOrganizePanelState(pageA, ORIGIN_DRAFT),
      readOrganizePanelState(pageB, OBSERVER_DRAFT),
    ]);
    return panelStates.every((state) => state.terminalCards === 1 && state.originDeletedCopy === 1);
  }, TIMEOUT_MS);

  runtimeStage = 'trusted_origin_deletion_invalidation_convergence_catalog_open_page_a';
  await pageA.bringToFront();
  await openSessionCatalog(pageA);
  runtimeStage = 'trusted_origin_deletion_invalidation_convergence_catalog_open_page_b';
  await pageB.bringToFront();
  await openSessionCatalog(pageB);
  try {
    runtimeStage = 'trusted_origin_deletion_invalidation_convergence_catalog_projection';
    await waitUntil(async () => {
      const projections = await Promise.all([pageA, pageB].map((targetPage) => targetPage.evaluate(
        ({ replacement, origin }) => {
          const root = document.getElementById('gsm-manager-host')?.shadowRoot;
          const rows = [...(root?.querySelectorAll('[data-testid="agent-session-item"]') ?? [])];
          const currentId = rows.find((row) => !!row.querySelector('[aria-current="true"]'))
            ?.getAttribute('data-session-id') ?? null;
          return {
            replacementCurrent: currentId === replacement,
            originAbsent: !rows.some((row) => row.getAttribute('data-session-id') === origin),
          };
        },
        { replacement: replacementSessionId, origin: originSessionId },
      )));
      return projections.every((projection) => projection.replacementCurrent && projection.originAbsent);
    }, TIMEOUT_MS);
    runtimeStage = 'trusted_origin_deletion_invalidation_convergence_catalog_close';
  } finally {
    await pageA.bringToFront();
    await closeSessionCatalogIfOpen(pageA);
    await pageB.bringToFront();
    await closeSessionCatalogIfOpen(pageB);
  }
  runtimeStage = 'trusted_origin_deletion_durable_authority';
  assert.equal(new URL(authorityPage.url()).protocol, 'chrome-extension:');
  const authority = await readOriginDeletionAuthority(authorityPage, {
    originSessionId,
    replacementSessionId,
    jobId: terminalJobId,
    applyId,
  });
  assert.deepEqual(authority, {
    originRows: 0,
    replacementRows: 1,
    attemptRows: 0,
    recoveryRows: 0,
    messageRows: 0,
    terminalRows: 1,
    applyRows: rowCount,
  });
  return {
    deletion: {
      nonterminalDeletionBlocked: true,
      deletionUiActors: 1,
      originDeletedAfterCommit: true,
      terminalEvidenceRetained: true,
      originProvenanceRetained: true,
      deletedPagesInvalidated: true,
      deletedOriginInCatalog: 0,
      terminalCards: 2,
      originDeletedCopyPages: 2,
      retainedTerminalRows: authority.terminalRows,
      retainedApplyRows: authority.applyRows,
    },
    draftRecovery: {
      contentPages: 2,
      originSessionPagesBefore: 2,
      replacementSessionsCreated: 1,
      invalidationPages: 2,
      draftsPreserved: 2,
      replacementSessionPages: 2,
      composerEnabledPages: 2,
      deletedOriginTranscriptRows: 0,
      deletedOriginRetryCards: 0,
      replacementSessionSelected: true,
      unsentDraftPreservedExactly: true,
    },
  };
}

async function clickDismissThroughUi(page) {
  await page.bringToFront();
  await waitUntil(() => page.evaluate(() => {
    const root = document.getElementById('gsm-manager-host')?.shadowRoot;
    const card = root?.querySelector('[data-testid="organize-job-receipt-card"]');
    const button = [...(card?.querySelectorAll('button') ?? [])].find((candidate) => (
      /^Dismiss$/u.test(candidate.textContent?.trim() ?? '')
    ));
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const hitTarget = root?.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hitTarget === button || button.contains(hitTarget);
  }), TIMEOUT_MS);
  await clickShadowTextTrusted(
    page,
    'button',
    /^Dismiss$/u,
    '[data-testid="organize-job-receipt-card"]',
  );
}

async function waitForContentTerminalDismissed(page) {
  await waitUntil(() => page.evaluate(() => (
    document.getElementById('gsm-manager-host')?.shadowRoot
      ?.querySelectorAll('[data-testid="organize-job-receipt-card"]').length === 0
  )), TIMEOUT_MS);
}

async function configureSavedProvider(page) {
  const field = await page.$('#agent-api-key');
  assert.ok(field);
  try {
    await field.focus();
    await page.keyboard.down('Meta');
    await page.keyboard.press('A');
    await page.keyboard.up('Meta');
    await page.keyboard.type('runtime-provider-key');
  } finally {
    await field.dispose();
  }
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) =>
    /^Save & test$/i.test(button.textContent.trim()) && !button.disabled,
  ));
  await clickButton(page, /^Save & test$/i);
  await pollPageConfig(page, (config) => !!config?.agentProvider?.apiKeyEncrypted);
  await pollPageConfig(page, (config) => config?.agentProvider?.capability?.namedToolRoundTrip === true);
  await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('gsm_config');
    const config = stored.gsm_config;
    await chrome.storage.local.set({
      gsm_config: {
        ...config,
        agentProvider: {
          ...config.agentProvider,
          capability: null,
        },
      },
    });
  });
  await pollPageConfig(page, (config) => config?.agentProvider?.capability === null);
}

async function establishSavedProviderCapability(page) {
  await clickButton(page, /^Test connection$/i);
  await pollPageConfig(page, (config) => config?.agentProvider?.capability?.namedToolRoundTrip === true);
  return page.evaluate(async () => {
    const stored = await chrome.storage.local.get('gsm_config');
    return stored.gsm_config?.agentProvider?.capability?.contextCapability ?? null;
  });
}

async function testConnectionWithoutAcceptance() {
  return chrome.runtime.sendMessage({
    type: 'testAgentProviderConnection',
    provider: 'openai',
    baseUrl: null,
    model: 'gpt-5-mini',
    apiKey: 'runtime-key-without-acceptance',
  });
}

async function runMissingCapabilityScenario({ timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-capability-denied-${crypto.randomUUID()}`;
  const sessionId = await globalThis.__createAgentSessionForRuntime();
  const waitFor = async (predicate) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Missing-capability scenario timed out: ${JSON.stringify(messages.slice(-4))}`);
  };
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId: 'runtime-capability-denied-preflight',
    taskInstruction: 'This must stop before provider access.',
  });
  const preflight = await waitFor((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    requestId: preflight.requestId,
    preflightToken: preflight.preflightToken,
    taskInstruction: 'This must stop before provider access.',
  });
  const terminal = await waitFor((message) =>
    message.type === 'bgsmOrganizeJobRunEvent' && message.event.type === 'run_terminal');
  const cancelled = await waitFor((message) => (
    message.type === 'bgsmOrganizeJobState'
    && message.presentation?.status === 'cancelled'
    && message.role === null
  ));
  messages.length = 0;
  port.postMessage({
    type: 'dismissBgsmTerminalOrganizeJob',
    controllerId,
    sessionId,
    jobId: cancelled.presentation.jobId,
    expectedRevision: cancelled.presentation.revision,
  });
  await waitFor((message) => (
    message.type === 'bgsmOrganizeJobState'
    && message.presentation === null
    && message.role === null
  ));
  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return { terminalReason: terminal.event.reason, deliveryMetadata };
}

function installAgentSessionRuntimeFactory() {
  globalThis.__createAgentSessionForRuntime = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'createAgentSession' });
    const sessionId = response?.data?.session?.id;
    if (!response?.ok || typeof sessionId !== 'string') {
      throw new Error(`Failed to create runtime Agent session: ${JSON.stringify(response)}`);
    }
    return sessionId;
  };
}

function installOrganizeJobRunDeliveryCollector() {
  globalThis.__recordBgsmOrganizeJobDelivery = (delivery, messages, metadata) => {
    if (!delivery || delivery.type !== 'bgsmOrganizeJobRunDelivery' || !delivery.message) {
      messages.push({ type: 'runtimeInvalidOrganizeJobRunDelivery' });
      return;
    }
    metadata.push({
      connectionEpochId: delivery.connectionEpochId,
      deliverySequence: delivery.deliverySequence,
      deliveryKind: delivery.deliveryKind,
      durableRevision: delivery.durableRevision,
      messageType: delivery.message.type,
      eventType: delivery.message.event?.type ?? null,
    });
    messages.push(delivery.message);
  };
}

function installCorruptOrganizeJobSeeder() {
  const openDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const readRequest = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  globalThis.__seedCorruptOrganizeJob = async ({ controllerId, sessionId, suffix }) => {
    const database = await openDatabase();
    const jobId = `organize-job:v1:runtime-corrupt-${suffix}`;
    const now = Date.now();
    try {
      const transaction = database.transaction(
        ['organizeJobs', 'organizeItems', 'organizeTaxonomies'],
        'readwrite',
      );
      transaction.objectStore('organizeJobs').add({
        jobId,
        activeSlot: 'organize-tags',
        controllerId,
        sessionId,
        originAgentSessionId: sessionId,
        runId: `run:v1:runtime-corrupt-${suffix}`,
        generation: 1,
        proposalId: `proposal:v1:runtime-corrupt-${suffix}`,
        frozenScope: {
          kind: 'all_live_stars',
          label: 'All starred repositories',
          filterSnapshot: 'All live stars',
          repositoryIds: ['runtime/repo-000', 'runtime/repo-001'],
          capturedAt: now,
          fingerprint: `fs:${'A'.repeat(43)}`,
        },
        taskInstruction: 'This corrupt checkpoint must never be resumed.',
        budget: {
          wallDeadlineMs: 300_000,
          maxConsumedFrozenPositions: 500,
          maxAnalyzerBatches: 20,
          maxProviderAttempts: 24,
          maxSerializedOutboundRequestBytes: 8_388_608,
          maxRequestedOutputTokens: 32_000,
        },
        usage: {
          firstAnalyzerRequestAt: null,
          consumedFrozenPositions: 0,
          analyzerBatches: 0,
          providerAttempts: 0,
          serializedOutboundRequestBytes: 0,
          requestedOutputTokens: 0,
        },
        nextFrozenIndex: 0,
        analysisPendingRanges: [],
        providerBinding: null,
        status: 'analysis_blocked',
        revision: 1,
        itemCount: 1,
        applyId: null,
        pauseRequested: false,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        cancelledAt: null,
      });
      transaction.objectStore('organizeItems').add({
        id: `${jobId}\u00000`,
        jobId,
        position: 0,
        fullName: 'runtime/repo-000',
        analysisState: 'failed',
        proposedActions: [],
        approvedActions: [],
        proposedAdditions: [],
        sourceFingerprint: null,
        selected: false,
        retryCount: 0,
        failure: 'provider_failed',
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        analyzedAt: now,
      });
      transaction.objectStore('organizeTaxonomies').add({
        jobId,
        fingerprint: `tf:v1:${'B'.repeat(43)}`,
        snapshot: { taxonomy: { entries: [] }, policyTaxonomy: { entries: [] } },
        createdAt: now,
      });
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
    return { jobId, revision: 1 };
  };
  const readScoped = async (stores, operation) => {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(stores, 'readonly');
      return await operation(transaction, readRequest);
    } finally {
      database.close();
    }
  };
  globalThis.__readOrganizeJob = (jobId) => readScoped('organizeJobs', (transaction, read) => (
    read(transaction.objectStore('organizeJobs').get(jobId))
  ));
  globalThis.__readActiveOrganizeJob = () => readScoped('organizeJobs', (transaction, read) => (
    read(transaction.objectStore('organizeJobs').index('activeSlot').get('organize-tags'))
  ));
  globalThis.__countOrganizeJobsByStatus = (status) => readScoped('organizeJobs', (transaction, read) => (
    read(transaction.objectStore('organizeJobs').index('status').count(status))
  ));
  globalThis.__countOrganizeItems = (jobId) => readScoped('organizeItems', (transaction, read) => (
    read(transaction.objectStore('organizeItems').index('jobId').count(jobId))
  ));
  globalThis.__readOrganizeApply = (applyId) => readScoped('organizeApplies', (transaction, read) => (
    read(transaction.objectStore('organizeApplies').get(applyId))
  ));
  globalThis.__countOrganizeApplyRows = (applyId) => readScoped('organizeApplyRows', (transaction, read) => (
    read(transaction.objectStore('organizeApplyRows').index('applyId').count(applyId))
  ));
}

async function pollPageConfig(page, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const config = await page.evaluate(async () =>
      (await chrome.storage.local.get('gsm_config')).gsm_config,
    );
    if (predicate(config)) return config;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Cubby config state.');
}

async function clickButton(page, matcher) {
  const found = await page.evaluate(({ source, flags }) => {
    const pattern = new RegExp(source, flags);
    const button = [...document.querySelectorAll('button')].find((entry) =>
      pattern.test(entry.textContent.trim()) && !entry.disabled,
    );
    button?.click();
    return !!button;
  }, { source: matcher.source, flags: matcher.flags });
  assert.equal(found, true, `button not found: ${matcher}`);
}

async function testTransientTypedKey() {
  const key = 'gsm_config';
  const before = (await chrome.storage.local.get(key))[key];
  const response = await chrome.runtime.sendMessage({
    type: 'testAgentProviderConnection',
    provider: 'openai',
    baseUrl: null,
    model: before.agentProvider.model,
    apiKey: 'transient-runtime-key',
  });
  const after = (await chrome.storage.local.get(key))[key];
  return {
    ok: response.ok,
    savedCredentialUnchanged:
      before.agentProvider.apiKeyEncrypted === after.agentProvider.apiKeyEncrypted &&
      before.agentProvider.credentialRevision === after.agentProvider.credentialRevision,
    savedCapabilityUnchanged:
      JSON.stringify(before.agentProvider.capability) === JSON.stringify(after.agentProvider.capability),
  };
}

async function runCorruptActiveRestoreScenario({ timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-corrupt-restore-${crypto.randomUUID()}`;
  const sessionId = await globalThis.__createAgentSessionForRuntime();
  const seeded = await globalThis.__seedCorruptOrganizeJob({
    controllerId,
    sessionId,
    suffix: crypto.randomUUID(),
  });
  port.postMessage({ type: 'requestBgsmActiveOrganizeJob', controllerId, sessionId });
  const deadline = Date.now() + timeoutMs;
  let failure = null;
  let noActive = null;
  while (Date.now() < deadline) {
    failure = messages.find((message) => message.type === 'bgsmOrganizeJobRunError') ?? null;
    noActive = messages.find((message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation === null &&
      message.role === null
    )) ?? null;
    if (failure && noActive) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!failure || !noActive) {
    throw new Error(`Corrupt restore did not settle: ${JSON.stringify(messages.slice(-6))}`);
  }
  const errorDelivery = deliveryMetadata.find((delivery) => (
    delivery.messageType === 'bgsmOrganizeJobRunError'
  ));
  const noActiveDelivery = deliveryMetadata.find((delivery) => (
    delivery.messageType === 'bgsmOrganizeJobState' &&
    delivery.deliveryKind === 'authoritative_snapshot' &&
    delivery.durableRevision === null
  ));
  const job = await globalThis.__readOrganizeJob(seeded.jobId);
  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return {
    discarded: typeof failure.message === 'string' && /discarded/iu.test(failure.message),
    jobExists: !!job,
    finalRevision: job?.revision ?? null,
    errorSequence: errorDelivery?.deliverySequence ?? null,
    noActiveSequence: noActiveDelivery?.deliverySequence ?? null,
    noActiveDeliveryKind: noActiveDelivery?.deliveryKind ?? null,
    noActiveDurableRevision: noActiveDelivery?.durableRevision ?? null,
  };
}

async function runCorruptBlockedReplacementScenario({ timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-corrupt-replace-${crypto.randomUUID()}`;
  const sessionId = await globalThis.__createAgentSessionForRuntime();
  const requestId = `runtime-corrupt-replace-${crypto.randomUUID()}`;
  const taskInstruction = 'Replace the blocked checkpoint and organize the complete library.';
  const seeded = await globalThis.__seedCorruptOrganizeJob({
    controllerId,
    sessionId,
    suffix: crypto.randomUUID(),
  });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Corrupt replacement timed out: ${JSON.stringify(messages.slice(-6))}`);
  };
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId,
    taskInstruction,
  });
  const preflight = await waitFor((message) => (
    message.type === 'bgsmOrganizeJobRunPreflightResult' && message.requestId === requestId
  ));
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    requestId,
    preflightToken: preflight.preflightToken,
    taskInstruction,
  });
  const outcome = await waitFor((message) => (
    message.type === 'bgsmOrganizeJobRunError' && message.requestId === requestId
  ) || message.type === 'bgsmOrganizeJobRunSnapshot');
  const oldJob = await globalThis.__readOrganizeJob(seeded.jobId);
  const activeJob = await globalThis.__readActiveOrganizeJob();
  if (outcome.type === 'bgsmOrganizeJobRunSnapshot') {
    port.postMessage({
      type: 'stopBgsmOrganizeJob',
      controllerId,
      sessionId,
      runId: outcome.snapshot.runId,
      generation: outcome.snapshot.generation,
      requestId: 'runtime-stop-cleanup',
    });
    await waitFor((message) => (
      message.type === 'bgsmOrganizeJobRunResult' && message.runId === outcome.snapshot.runId
    ));
  }
  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return {
    error: outcome.type === 'bgsmOrganizeJobRunError' ? 'organize_error' : null,
    oldJobExists: !!oldJob,
    jobCount: activeJob ? 1 : 0,
  };
}

async function runRepeatedPreflightStartScenario({ timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-repeated-start-${crypto.randomUUID()}`;
  const sessionId = await globalThis.__createAgentSessionForRuntime();
  const requestId = `runtime-repeated-start-${crypto.randomUUID()}`;
  const taskInstruction = 'Organize this durable scope exactly once.';
  const jobCountBefore = await globalThis.__countOrganizeJobsByStatus('cancelled');
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const active = await globalThis.__readActiveOrganizeJob();
    throw new Error(`${label} timed out with ${messages.length} deliveries and ${active ? 1 : 0} active job.`);
  };

  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId,
    taskInstruction,
  });
  const preflight = await waitFor((message) => (
    message.type === 'bgsmOrganizeJobRunPreflightResult' &&
    message.requestId === requestId
  ), 'Repeated-start preflight');
  const startMessage = {
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    requestId,
    preflightToken: preflight.preflightToken,
    taskInstruction,
  };
  port.postMessage(startMessage);
  const first = await waitFor(
    (message) => message.type === 'bgsmOrganizeJobRunSnapshot',
    'Repeated-start first snapshot',
  );
  const firstState = await waitFor((message) => (
    message.type === 'bgsmOrganizeJobState' &&
    message.presentation?.runId === first.snapshot.runId &&
    message.role === 'owner'
  ), 'Repeated-start durable owner state');
  const authoritativeBeforeReplay = deliveryMetadata.filter((delivery) => (
    delivery.messageType === 'bgsmOrganizeJobRunSnapshot' &&
    delivery.deliveryKind === 'authoritative_snapshot'
  )).length;

  const replayMessageStart = messages.length;
  port.postMessage(startMessage);
  const replay = await waitFor((message) => (
    messages.indexOf(message) >= replayMessageStart &&
    message.type === 'bgsmOrganizeJobRunError' &&
    message.requestId === requestId
  ) || (
    messages.indexOf(message) >= replayMessageStart &&
    message.type === 'bgsmOrganizeJobRunSnapshot' &&
    deliveryMetadata.filter((delivery) => (
      delivery.messageType === 'bgsmOrganizeJobRunSnapshot' &&
      delivery.deliveryKind === 'authoritative_snapshot'
    )).length > authoritativeBeforeReplay
  ), 'Repeated-start replay');

  const jobCount = (await globalThis.__readOrganizeJob(firstState.presentation.jobId)) ? 1 : 0;
  port.postMessage({
    type: 'stopBgsmOrganizeJob',
    controllerId,
    sessionId,
    runId: first.snapshot.runId,
    generation: first.snapshot.generation,
    requestId: 'runtime-stop-first-run',
  });
  await waitFor((message) => (
    message.type === 'bgsmOrganizeJobRunResult' &&
    message.runId === first.snapshot.runId
  ), 'Repeated-start stop result');
  const terminal = await waitFor((message) => (
    message.type === 'bgsmOrganizeJobState' &&
    message.presentation?.jobId === firstState.presentation.jobId &&
    message.presentation.status === 'cancelled' &&
    message.role === null
  ), 'Repeated-start cancelled terminal state');
  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return {
    error: replay.type === 'bgsmOrganizeJobRunError' ? 'organize_error' : null,
    sameRun: replay.type === 'bgsmOrganizeJobRunSnapshot' &&
      replay.snapshot.runId === first.snapshot.runId &&
      replay.snapshot.generation === first.snapshot.generation,
    jobCount,
    terminalJobId: terminal.presentation.jobId,
    terminalRevision: terminal.presentation.revision,
  };
}

async function runOrganizeBudgetContinuationScenario({ rowCount, timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  port.onDisconnect.addListener(() => messages.push({
    type: 'runtimePortDisconnected',
    hadRuntimeError: !!chrome.runtime.lastError,
  }));
  const controllerId = `controller:v1:runtime-preflight-${crypto.randomUUID()}`;
  const sessionId = await globalThis.__createAgentSessionForRuntime();
  const waitFor = async (predicate) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const counts = Object.fromEntries(Object.entries(messages.reduce((result, message) => {
      const key = message.event?.type ?? message.type;
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {})));
    throw new Error(`Timed out; counts: ${JSON.stringify(counts)}; last: ${JSON.stringify(messages.slice(-5).map((message) => ({
      type: message.type, eventType: message.event?.type ?? null,
      state: message.event?.state ?? message.snapshot?.state ?? null,
      reason: message.event?.reason ?? null,
    })))}`);
  };
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight', controllerId, sessionId,
    requestId: 'runtime-preflight',
    taskInstruction: 'Organize the complete runtime scope.',
  });
  const result = await waitFor((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
  if (result.count !== rowCount) throw new Error(`Expected ${rowCount}, got ${result.count}`);
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    requestId: result.requestId,
    preflightToken: result.preflightToken,
    taskInstruction: 'Organize the complete runtime scope.',
  });
  const started = await waitFor((message) => message.type === 'bgsmOrganizeJobRunSnapshot');
  const scope = started.snapshot?.frozenScope;
  if (!scope || scope.count !== rowCount) {
    throw new Error(`Unexpected start snapshot: ${JSON.stringify(started)}`);
  }
  const snapshotBounded = !('repositoryIds' in scope) && !('filterSnapshot' in scope);
  const exhausted = await waitFor((message) =>
    message.type === 'bgsmOrganizeJobRunEvent' &&
    message.event.type === 'budget_exhausted' &&
    message.event.runId === started.snapshot.runId,
  );
  let continuation = started;
  let continuationTerminal = null;
  let continuationCount = 0;
  while (!continuationTerminal) {
    const parent = continuation.snapshot;
    const child = await waitFor((message) =>
      message.type === 'bgsmOrganizeJobRunSnapshot' &&
      message.snapshot.generation > parent.generation &&
      message.snapshot.state === 'prepared',
    );
    continuationCount += 1;
    continuation = child;
    const outcome = await waitFor((message) =>
      message.type === 'bgsmOrganizeJobRunEvent' &&
      message.event.runId === child.snapshot.runId &&
      (message.event.type === 'budget_exhausted' || message.event.type === 'run_terminal'),
    );
    if (outcome.event.type === 'budget_exhausted') {
      continue;
    } else {
      continuationTerminal = outcome;
    }
  }

  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return {
    count: result.count,
    snapshotBounded,
    budget: started.snapshot.budget,
    exhaustionReason: exhausted.event.reason,
    exhaustedUsage: exhausted.event.usage,
    parentGeneration: started.snapshot.generation,
    continuationGeneration: continuation.snapshot.generation,
    continuationCount,
    continuationTerminalState: continuationTerminal.event.state,
    disconnected: true,
    deliveryMetadata,
  };
}

async function runPreflightOnlyScenario({ rowCount, timeoutMs, expectedPriorTerminalJobId }) {
  globalThis.__runtimePreflightProgress = 'actor';
  const actorPort = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const observerPort = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const actorMessages = [];
  const observerMessages = [];
  const actorControllerId = `controller:v1:runtime-preflight-actor-${crypto.randomUUID()}`;
  const observerControllerId = `controller:v1:runtime-preflight-observer-${crypto.randomUUID()}`;
  const actorSessionId = await globalThis.__createAgentSessionForRuntime();
  const observerSessionId = await globalThis.__createAgentSessionForRuntime();
  actorPort.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, actorMessages, []);
  });
  observerPort.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, observerMessages, []);
  });
  const waitFor = async (messages, predicate) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('next_admission_convergence_timeout');
  };
  observerPort.postMessage({
    type: 'requestBgsmActiveOrganizeJob',
    controllerId: observerControllerId,
    sessionId: observerSessionId,
  });
  await waitFor(observerMessages, (message) => (
    message.type === 'bgsmOrganizeJobState'
    && message.presentation?.jobId === expectedPriorTerminalJobId
    && message.presentation.status === 'cancelled'
    && message.role === null
  ));
  const priorTerminal = await globalThis.__readOrganizeJob(expectedPriorTerminalJobId);
  const priorApplyRows = priorTerminal?.applyId
    ? await globalThis.__countOrganizeApplyRows(priorTerminal.applyId)
    : 0;
  const requestId = `runtime-preflight-only-${crypto.randomUUID()}`;
  actorPort.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId: actorControllerId,
    sessionId: actorSessionId,
    requestId,
    taskInstruction: 'Prepare the complete runtime scope.',
  });
  const preflight = await waitFor(actorMessages, (message) => (
    message.type === 'bgsmOrganizeJobRunPreflightResult' && message.requestId === requestId
  ));
  globalThis.__runtimePreflightProgress = 'observer';
  if (preflight.count !== rowCount) throw new Error('next_admission_scope_mismatch');
  await waitFor(observerMessages, (message) => (
    message.type === 'bgsmOrganizeJobState'
    && message.presentation === null
    && message.role === null
  ));
  globalThis.__runtimePreflightProgress = 'storage';
  const preflightRowCount = await globalThis.__countOrganizeJobsByStatus('preflight_ready');
  if (preflightRowCount !== 1) throw new Error('next_admission_authority_mismatch');
  const oldTerminalRows = (await globalThis.__readOrganizeJob(expectedPriorTerminalJobId)) ? 1 : 0;
  const oldApplyRows = priorTerminal?.applyId
    ? await globalThis.__countOrganizeApplyRows(priorTerminal.applyId)
    : priorApplyRows;
  actorPort.postMessage({
    type: 'cancelBgsmOrganizeJobPreflight',
    controllerId: actorControllerId,
    sessionId: actorSessionId,
    requestId,
  });
  const cancellationDeadline = Date.now() + timeoutMs;
  let preflightRowsAfterCancellation = preflightRowCount;
  while (Date.now() < cancellationDeadline) {
    preflightRowsAfterCancellation = await globalThis.__countOrganizeJobsByStatus('preflight_ready');
    if (preflightRowsAfterCancellation === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (preflightRowsAfterCancellation !== 0) throw new Error('next_admission_cancel_timeout');
  actorPort.disconnect();
  observerPort.disconnect();
  return {
    count: preflight.count,
    priorTerminalFound: priorTerminal?.status === 'cancelled',
    priorTerminalReplaced: oldTerminalRows === 0,
    admittedJobCount: preflightRowCount,
    rawActorPorts: 1,
    rawObserverPorts: 1,
    oldTerminalRows,
    oldApplyRows,
    newPreflightRows: preflightRowCount,
  };
}

function installTwoPageOwnershipRuntimeHarness() {
  const openDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const readRequest = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const summarize = (state) => state.messages.slice(-10).map((message) => ({
    type: message.type,
    requestId: message.requestId ?? null,
    reason: message.reason ?? null,
    outerControllerId: message.controllerId ?? null,
    outerSessionId: message.sessionId ?? null,
    role: message.role ?? null,
    jobId: message.presentation?.jobId ?? null,
    revision: message.presentation?.revision ?? null,
    status: message.presentation?.status ?? message.snapshot?.state ?? null,
    runId: message.presentation?.runId ?? message.snapshot?.runId ?? message.runId ?? null,
    generation: message.presentation?.generation ?? message.snapshot?.generation ?? message.generation ?? null,
  }));
  globalThis.__runtimeOwnershipWaitFor = async (state, predicate, timeoutMs, label, startIndex = 0) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...state.messages.slice(startIndex)].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${label} timed out on ${state.label}: ${JSON.stringify(summarize(state))}`);
  };
  globalThis.__runtimeOwnershipReadJob = async (jobId) => {
    const database = await openDatabase();
    try {
      return await readRequest(database.transaction('organizeJobs', 'readonly').objectStore('organizeJobs').get(jobId));
    } finally {
      database.close();
    }
  };
  globalThis.__runtimeOwnershipReadTerminalEvidence = async (jobId) => {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        ['agentSessions', 'organizeJobs', 'organizeApplies', 'organizeApplyRows'],
        'readonly',
      );
      const job = await readRequest(transaction.objectStore('organizeJobs').get(jobId));
      const session = job?.originAgentSessionId
        ? await readRequest(transaction.objectStore('agentSessions').get(job.originAgentSessionId))
        : null;
      const apply = job?.applyId
        ? await readRequest(transaction.objectStore('organizeApplies').get(job.applyId))
        : null;
      const applyRowCount = apply
        ? await readRequest(transaction.objectStore('organizeApplyRows').index('applyId').count(apply.applyId))
        : 0;
      return {
        sessionExists: !!session,
        job: job ?? null,
        apply: apply ?? null,
        applyRowCount,
      };
    } finally {
      database.close();
    }
  };
}

async function beginTwoPageOwnershipScenario({ rowCount, timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const state = {
    label: 'page-a',
    port,
    messages: [],
    deliveryMetadata: [],
    controllerId: `controller:v1:runtime-page-a-${crypto.randomUUID()}`,
    sessionId: await globalThis.__createAgentSessionForRuntime(),
  };
  globalThis.__runtimeTwoPageOwnership = state;
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, state.messages, state.deliveryMetadata);
  });
  const requestId = `runtime-page-a-preflight-${crypto.randomUUID()}`;
  const taskInstruction = 'Propose one synthetic tag for every repository in the complete local library.';
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
    requestId,
    taskInstruction,
  });
  const preflight = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => message.type === 'bgsmOrganizeJobRunPreflightResult' && message.requestId === requestId,
    timeoutMs,
    'Page A preflight',
  );
  if (preflight.count !== rowCount) {
    throw new Error(`Page A preflight expected ${rowCount} rows, received ${preflight.count}.`);
  }
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
    requestId,
    preflightToken: preflight.preflightToken,
    taskInstruction,
  });
  const projection = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.status === 'analyzing' &&
      message.role === 'owner'
    ),
    timeoutMs,
    'Page A durable analyzing owner projection',
  );
  const durable = await globalThis.__runtimeOwnershipReadJob(projection.presentation.jobId);
  return {
    count: preflight.count,
    pageControllerId: state.controllerId,
    pageSessionId: state.sessionId,
    outerControllerId: projection.controllerId,
    outerSessionId: projection.sessionId,
    role: projection.role,
    presentation: projection.presentation,
    durable,
  };
}

async function joinTwoPageOwnershipScenario({ expectedJobId, timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const state = {
    label: 'page-b',
    port,
    messages: [],
    deliveryMetadata: [],
    controllerId: `controller:v1:runtime-page-b-${crypto.randomUUID()}`,
    sessionId: await globalThis.__createAgentSessionForRuntime(),
  };
  globalThis.__runtimeTwoPageOwnership = state;
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, state.messages, state.deliveryMetadata);
  });
  port.postMessage({
    type: 'requestBgsmActiveOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
  });
  const projection = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.jobId === expectedJobId &&
      message.role === 'observer'
    ),
    timeoutMs,
    'Page B observer projection',
  );
  const durableBeforeRejection = await globalThis.__runtimeOwnershipReadJob(expectedJobId);
  port.postMessage({
    type: 'stopBgsmOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
    runId: projection.presentation.runId,
    generation: projection.presentation.generation,
    requestId: 'runtime-observer-stop',
  });
  const rejection = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobRunError' &&
      message.requestId === 'runtime-observer-stop'
    ),
    timeoutMs,
    'Page B observer mutation rejection',
  );
  const durableAfterRejection = await globalThis.__runtimeOwnershipReadJob(expectedJobId);
  return {
    pageControllerId: state.controllerId,
    pageSessionId: state.sessionId,
    outerControllerId: projection.controllerId,
    outerSessionId: projection.sessionId,
    role: projection.role,
    presentation: projection.presentation,
    rejection,
    durableBeforeRejection,
    durableAfterRejection,
  };
}

async function refreshTwoPageOwnershipProjection({
  expectedJobId,
  expectedRevision,
  expectedRole,
  timeoutMs,
}) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state?.port) throw new Error('Two-page ownership Port is unavailable for refresh.');
  const startIndex = state.messages.length;
  state.port.postMessage({
    type: 'requestBgsmActiveOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
  });
  const projection = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.jobId === expectedJobId &&
      message.presentation.revision === expectedRevision &&
      message.role === expectedRole
    ),
    timeoutMs,
    `Refreshed ${expectedRole} projection at revision ${expectedRevision}`,
    startIndex,
  );
  return { role: projection.role, presentation: projection.presentation };
}

async function deleteOwnershipOriginConversation({ sessionId, expectedCommitted = false, timeoutMs = 0 }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state) throw new Error('Two-page ownership state is unavailable for conversation deletion.');
  const startIndex = state.messages.length;
  const response = await chrome.runtime.sendMessage({ type: 'deleteAgentSession', sessionId });
  if (!expectedCommitted) {
    return {
      response,
      invalidationCount: state.messages.slice(startIndex).filter((message) => (
        message.type === 'bgsmAgentSessionDeleted' && message.deletedSessionId === sessionId
      )).length,
    };
  }
  const invalidation = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => message.type === 'bgsmAgentSessionDeleted' && message.deletedSessionId === sessionId,
    timeoutMs,
    'Post-commit Agent session deletion invalidation',
    startIndex,
  );
  const messageIndex = state.messages.indexOf(invalidation);
  return {
    response,
    invalidation,
    invalidationDelivery: state.deliveryMetadata[messageIndex],
  };
}

async function disconnectTwoPageOwnershipPort() {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state?.port) return { disconnected: false };
  state.port.disconnect();
  state.port = null;
  return { disconnected: true };
}

async function waitForTwoPageOwnershipRole({ expectedJobId, expectedRole, expectedStatus, timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state) throw new Error('Two-page ownership state is unavailable while waiting for a role.');
  const projection = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.jobId === expectedJobId &&
      message.role === expectedRole &&
      (expectedStatus === undefined || message.presentation.status === expectedStatus)
    ),
    timeoutMs,
    `${expectedRole} projection${expectedStatus ? ` in ${expectedStatus}` : ''}`,
  );
  return {
    outerControllerId: projection.controllerId,
    outerSessionId: projection.sessionId,
    role: projection.role,
    presentation: projection.presentation,
  };
}

async function takeControlOfTwoPageOwnership({ expectedJobId, expectedRevision, timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state?.port) throw new Error('Page B ownership Port is unavailable for Take control.');
  const ownerLost = [...state.messages].reverse().find((message) => (
    message.type === 'bgsmOrganizeJobState' &&
    message.presentation?.jobId === expectedJobId &&
    message.presentation.revision === expectedRevision &&
    message.role === 'owner_lost'
  ));
  if (!ownerLost) {
    throw new Error(`Page B has no owner_lost revision ${expectedRevision} projection.`);
  }
  const startIndex = state.messages.length;
  const base = {
    type: 'takeControlBgsmOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
    runId: ownerLost.presentation.runId,
    generation: ownerLost.presentation.generation,
    jobId: expectedJobId,
    expectedRevision,
  };
  state.port.postMessage({ ...base, requestId: 'runtime-take-control-winner' });
  state.port.postMessage({ ...base, requestId: 'runtime-take-control-concurrent' });
  const projection = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.jobId === expectedJobId &&
      message.presentation.revision > expectedRevision &&
      message.role === 'owner'
    ),
    timeoutMs,
    'Page B successful Take control projection',
    startIndex,
  );
  const loser = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobRunError' &&
      message.requestId === 'runtime-take-control-concurrent'
    ),
    timeoutMs,
    'Concurrent Take control rejection',
    startIndex,
  );
  return {
    role: projection.role,
    presentation: projection.presentation,
    loser,
    durable: await globalThis.__runtimeOwnershipReadJob(expectedJobId),
  };
}

async function reconnectTwoPageOwnershipPort({ expectedJobId, timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state || state.port) throw new Error('Page A must be disconnected before reconnecting.');
  const startIndex = state.messages.length;
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  state.port = port;
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, state.messages, state.deliveryMetadata);
  });
  port.postMessage({
    type: 'requestBgsmActiveOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
  });
  const projection = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.jobId === expectedJobId &&
      message.role === 'observer'
    ),
    timeoutMs,
    'Reconnected Page A observer projection',
    startIndex,
  );
  return {
    outerControllerId: projection.controllerId,
    outerSessionId: projection.sessionId,
    role: projection.role,
    presentation: projection.presentation,
  };
}

function countOwnershipDeletionInvalidations(deletedSessionId) {
  const state = globalThis.__runtimeTwoPageOwnership;
  return state?.messages.filter((message) => (
    message.type === 'bgsmAgentSessionDeleted' && message.deletedSessionId === deletedSessionId
  )).length ?? 0;
}

async function waitForTwoPageOwnershipReview({ expectedJobId, timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state) throw new Error('Page B ownership state is unavailable for Review.');
  const projection = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.jobId === expectedJobId &&
      message.presentation.status === 'review' &&
      message.role === 'owner'
    ),
    timeoutMs,
    'Page B owner Review projection',
  );
  return {
    role: projection.role,
    presentation: projection.presentation,
    durable: await globalThis.__runtimeOwnershipReadJob(expectedJobId),
  };
}

async function completeTwoPageOwnershipApply({ expectedJobId, timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state?.port) throw new Error('Page B ownership Port is unavailable for Apply.');
  const review = [...state.messages].reverse().find((message) => (
    message.type === 'bgsmOrganizeJobState' &&
    message.presentation?.jobId === expectedJobId &&
    message.presentation.status === 'review' &&
    message.role === 'owner'
  ));
  if (!review) throw new Error('Page B has no owner Review projection to Apply.');
  const reviewRequestId = `runtime-ownership-review-${crypto.randomUUID()}`;
  state.port.postMessage({
    type: 'requestBgsmOrganizeReviewPage',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
    runId: review.presentation.runId,
    generation: review.presentation.generation,
    requestId: reviewRequestId,
    jobId: expectedJobId,
    rowOffset: 0,
    limit: 100,
  });
  const reviewPage = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => message.type === 'bgsmOrganizeReviewPage' && message.requestId === reviewRequestId,
    timeoutMs,
    'Page B first Review page',
  );
  const applyRequestId = `runtime-ownership-apply-${crypto.randomUUID()}`;
  state.port.postMessage({
    type: 'applyBgsmOrganizeSelection',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
    runId: review.presentation.runId,
    generation: review.presentation.generation,
    requestId: applyRequestId,
    jobId: expectedJobId,
    expectedRevision: reviewPage.revision,
  });
  const completed = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.jobId === expectedJobId &&
      message.presentation.status === 'completed' &&
      message.role === null
    ),
    timeoutMs,
    'Page B terminal completion projection',
  );
  const apply = completed.presentation.apply;
  if (!apply) throw new Error('Terminal ownership projection did not retain Apply evidence.');
  const settledProgress = [...new Set(state.messages
    .filter((message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.jobId === expectedJobId &&
      (message.presentation.apply?.settled ?? 0) > 0
    ))
    .map((message) => message.presentation.apply.settled))];
  return {
    outerControllerId: completed.controllerId,
    outerSessionId: completed.sessionId,
    role: completed.role,
    presentation: completed.presentation,
    reviewTotal: reviewPage.totalRows,
    firstReviewPageRows: reviewPage.rows.length,
    selectedRepositories: reviewPage.selectedRepositories,
    selectedActions: reviewPage.selectedActions,
    settledProgress,
    receiptCounts: {
      total: apply.total,
      changed: apply.changed,
      unchanged: apply.unchanged,
      skipped: apply.skipped,
      failed: apply.failed,
    },
    deliveryMetadata: [...state.deliveryMetadata],
  };
}

async function waitForTwoPageOwnershipTerminal({ expectedJobId, timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state) throw new Error('Ownership state is unavailable for terminal convergence.');
  const terminal = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation?.jobId === expectedJobId &&
      ['completed', 'cancelled'].includes(message.presentation.status) &&
      message.role === null
    ),
    timeoutMs,
    'Global terminal projection',
  );
  return {
    outerControllerId: terminal.controllerId,
    outerSessionId: terminal.sessionId,
    role: terminal.role,
    presentation: terminal.presentation,
  };
}

async function waitForOwnershipDeletionInvalidation({ deletedSessionId, timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state) throw new Error('Ownership state is unavailable for session invalidation.');
  const invalidation = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmAgentSessionDeleted' && message.deletedSessionId === deletedSessionId
    ),
    timeoutMs,
    'Post-commit session deletion invalidation',
  );
  const messageIndex = state.messages.indexOf(invalidation);
  return {
    invalidation,
    invalidationDelivery: state.deliveryMetadata[messageIndex],
  };
}

async function readTwoPageOwnershipTerminalEvidence(jobId) {
  return globalThis.__runtimeOwnershipReadTerminalEvidence(jobId);
}

async function requestTwoPageOwnershipReceipt({ presentation, timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state?.port) throw new Error('Ownership Port is unavailable for terminal receipt paging.');
  if (!presentation.apply) throw new Error('Terminal presentation has no Apply receipt identity.');
  const requestId = `runtime-terminal-receipt-${crypto.randomUUID()}`;
  state.port.postMessage({
    type: 'requestBgsmOrganizeReceiptPage',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
    runId: presentation.runId,
    generation: presentation.generation,
    requestId,
    jobId: presentation.jobId,
    applyId: presentation.apply.applyId,
    rowOffset: 0,
    limit: 100,
    filter: 'all',
  });
  return globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => message.type === 'bgsmOrganizeReceiptPage' && message.requestId === requestId,
    timeoutMs,
    'Terminal receipt page',
  );
}

async function dismissTwoPageOwnershipTerminal({ jobId, expectedRevision, timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state?.port) throw new Error('Page B ownership Port is unavailable for terminal Dismiss.');
  const startIndex = state.messages.length;
  state.port.postMessage({
    type: 'dismissBgsmTerminalOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
    jobId,
    expectedRevision,
  });
  const noJob = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation === null &&
      message.role === null
    ),
    timeoutMs,
    'Page B no-job projection after Dismiss',
    startIndex,
  );
  return {
    outerControllerId: noJob.controllerId,
    outerSessionId: noJob.sessionId,
    role: noJob.role,
    presentation: noJob.presentation,
  };
}

async function waitForTwoPageOwnershipNoJob({ timeoutMs }) {
  const state = globalThis.__runtimeTwoPageOwnership;
  if (!state) throw new Error('Ownership state is unavailable for no-job convergence.');
  const noJob = await globalThis.__runtimeOwnershipWaitFor(
    state,
    (message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation === null &&
      message.role === null
    ),
    timeoutMs,
    'Global no-job projection',
  );
  return {
    outerControllerId: noJob.controllerId,
    outerSessionId: noJob.sessionId,
    role: noJob.role,
    presentation: noJob.presentation,
  };
}




async function beginWorkerRecoveryScenario({ rowCount, timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const metadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, metadata);
  });
  const controllerId = `controller:v1:runtime-worker-recovery-${crypto.randomUUID()}`;
  const sessionId = await globalThis.__createAgentSessionForRuntime();
  const waitFor = async (predicate) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Worker-recovery start timed out: ${JSON.stringify(messages.slice(-5))}`);
  };
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId: 'runtime-worker-recovery-preflight',
    taskInstruction: 'Recover this complete runtime scope after worker termination.',
  });
  const preflight = await waitFor((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
  if (preflight.count !== rowCount) throw new Error(`Expected ${rowCount}, got ${preflight.count}`);
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    requestId: preflight.requestId,
    preflightToken: preflight.preflightToken,
    taskInstruction: 'Recover this complete runtime scope after worker termination.',
  });
  const snapshot = await waitFor((message) => message.type === 'bgsmOrganizeJobRunSnapshot');
  const durable = await waitFor((message) => (
    message.type === 'bgsmOrganizeJobState' && message.presentation?.status === 'analyzing'
  ));
  globalThis.__runtimeWorkerRecoveryReconnect = {
    port,
    controllerId,
    sessionId,
    reconnectMessages: [],
    reconnectDeliveryMetadata: [],
    reconnectAttempts: 0,
    reconnectArmed: false,
    reconnectStopped: false,
    reconnectPaused: false,
    reconnectPending: false,
    reconnectConnecting: false,
    requestReconnect: null,
    pausedAlarmScheduledTime: null,
  };
  return {
    jobId: durable.presentation.jobId,
    controllerId,
    sessionId,
    runId: snapshot.snapshot.runId,
    generation: snapshot.snapshot.generation,
    deliveryMetadata: metadata,
  };
}

function armWorkerRecoveryReconnect() {
  const state = globalThis.__runtimeWorkerRecoveryReconnect;
  if (!state) throw new Error('Worker recovery reconnect state is unavailable.');
  if (state.reconnectArmed) return { armed: true };
  state.reconnectArmed = true;

  const connect = () => {
    if (state.reconnectStopped || state.reconnectConnecting) return;
    state.reconnectConnecting = true;
    const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
    state.port = port;
    state.reconnectAttempts += 1;
    port.onMessage.addListener((delivery) => {
      globalThis.__recordBgsmOrganizeJobDelivery(
        delivery,
        state.reconnectMessages,
        state.reconnectDeliveryMetadata,
      );
    });
    port.onDisconnect.addListener(() => {
      if (state.port === port) state.reconnectConnecting = false;
      if (!state.reconnectStopped) setTimeout(state.requestReconnect, 25);
    });
    port.postMessage({
      type: 'requestBgsmActiveOrganizeJob',
      controllerId: state.controllerId,
      sessionId: state.sessionId,
    });
  };
  state.requestReconnect = () => {
    if (state.reconnectStopped || state.reconnectConnecting) return;
    if (state.reconnectPaused) {
      state.reconnectPending = true;
      return;
    }
    state.reconnectPending = false;
    connect();
  };

  state.port.onDisconnect.addListener(() => {
    if (!state.reconnectStopped) setTimeout(state.requestReconnect, 0);
  });
  return { armed: true };
}

async function pauseWorkerRecoveryWakeups() {
  const state = globalThis.__runtimeWorkerRecoveryReconnect;
  if (!state?.reconnectArmed) throw new Error('Worker recovery reconnect is not armed.');
  state.reconnectPaused = true;
  const alarmName = 'bgsm-organize-analysis-recovery';
  const deadline = Date.now() + 2_000;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const alarm = await chrome.alarms.get(alarmName);
    if (alarm) {
      state.pausedAlarmScheduledTime = alarm.scheduledTime ?? state.pausedAlarmScheduledTime;
      await chrome.alarms.clear(alarmName);
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= 250) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Worker recovery alarm did not remain quiescent.');
}

async function detachWorkerRecoveryPortForReplacement() {
  const state = globalThis.__runtimeWorkerRecoveryReconnect;
  if (!state?.reconnectArmed || !state.reconnectPaused || !state.port) {
    throw new Error('Worker recovery Port is not paused and armed for replacement.');
  }
  const port = state.port;
  port.postMessage({
    type: 'disconnectBgsmOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  port.disconnect();
  if (state.port === port) state.port = null;
  state.reconnectConnecting = false;
  state.reconnectPending = true;
  return { detached: true, reconnectPending: true };
}

async function resumeWorkerRecoveryWakeups() {
  const state = globalThis.__runtimeWorkerRecoveryReconnect;
  if (!state?.reconnectArmed) throw new Error('Worker recovery reconnect is not armed.');
  await chrome.alarms.create('bgsm-organize-analysis-recovery', {
    when: Math.max(Date.now() + 25, state.pausedAlarmScheduledTime ?? 0),
  });
  state.reconnectPaused = false;
  queueMicrotask(state.requestReconnect);
}

async function waitForWorkerRecoveryReconnect({
  runId,
  generation,
  timeoutMs,
}) {
  const state = globalThis.__runtimeWorkerRecoveryReconnect;
  if (!state) throw new Error('Worker recovery reconnect state is unavailable.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = state.reconnectMessages.find((message) => message.type === 'bgsmOrganizeJobRunError');
    if (error) throw new Error(`Worker recovery reconnect failed: ${error.message}`);
    const snapshot = [...state.reconnectMessages].reverse().find((message) => (
      message.type === 'bgsmOrganizeJobRunSnapshot'
      && message.snapshot?.runId === runId
      && message.snapshot?.generation === generation
    ));
    if (snapshot) {
      return {
        runId: snapshot.snapshot.runId,
        generation: snapshot.snapshot.generation,
        state: snapshot.snapshot.state,
        reconnectAttempts: state.reconnectAttempts,
        deliveryMetadata: state.reconnectDeliveryMetadata,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Worker recovery reconnect timed out after ${state.reconnectAttempts} attempts: `
    + JSON.stringify(state.reconnectMessages.slice(-6)),
  );
}

async function disconnectWorkerRecoveryReconnect() {
  const state = globalThis.__runtimeWorkerRecoveryReconnect;
  if (!state) return { disconnected: false };
  state.reconnectStopped = true;
  try {
    state.port.postMessage({
      type: 'disconnectBgsmOrganizeJob',
      controllerId: state.controllerId,
      sessionId: state.sessionId,
    });
  } catch {
    // The worker may have already closed the reconnect port.
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    state.port.disconnect();
  } catch {
    // The port can be disconnected by worker recovery concurrently.
  }
  delete globalThis.__runtimeWorkerRecoveryReconnect;
  return { disconnected: true };
}

async function expireActiveAnalysisLeaseForRuntime() {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const transaction = database.transaction(['organizeJobs', 'organizeItems'], 'readwrite');
    const jobsStore = transaction.objectStore('organizeJobs');
    const itemsStore = transaction.objectStore('organizeItems');
    const requestValue = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const job = await requestValue(jobsStore.index('activeSlot').get('organize-tags'));
    if (job?.status !== 'analyzing') throw new Error('Active durable analysis job is unavailable.');
    const items = await requestValue(itemsStore.index('jobId').getAll(IDBKeyRange.only(job.jobId), 502));
    if (items.length > 501) throw new Error('Organize recovery item cap exceeded.');
    const leased = items.filter((item) => (
      item.jobId === job.jobId && item.analysisState === 'leased'
    ));
    if (leased.length === 0) throw new Error('Active durable analysis lease is unavailable.');
    for (const item of leased) itemsStore.put({ ...item, leaseExpiresAt: 0 });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const alarmName = 'bgsm-organize-analysis-recovery';
    await chrome.alarms.create(alarmName, { when: Date.now() + 1_000 });
    const alarm = await chrome.alarms.get(alarmName);
    if (!alarm) throw new Error('Organize analysis recovery alarm is unavailable.');
    return {
      jobId: job.jobId,
      leasedPositions: leased.map((item) => item.position),
      alarmName: alarm.name,
      scheduledTime: alarm.scheduledTime,
    };
  } finally {
    database.close();
  }
}

async function waitForRecoveredOrganizeState({ jobId, expectedStatus, timeoutMs }) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const transaction = database.transaction(['organizeJobs', 'organizeItems'], 'readonly');
      const read = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [job, items] = await Promise.all([
        read(transaction.objectStore('organizeJobs').get(jobId)),
        read(transaction.objectStore('organizeItems').index('jobId').getAll(IDBKeyRange.only(jobId), 502)),
      ]);
      if (items.length > 501) throw new Error('Organize recovery item cap exceeded.');
      if (job?.status === expectedStatus) {
        const settled = items.filter((item) => (
          item.jobId === jobId
          && item.analysisState !== 'pending'
          && item.analysisState !== 'leased'
        ));
        return {
          status: job.status,
          runId: job.runId,
          generation: job.generation,
          nextFrozenIndex: job.nextFrozenIndex,
          revision: job.revision,
          usage: job.usage,
          settledCount: settled.length,
          uniqueSettledPositionCount: new Set(settled.map((item) => item.position)).size,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Recovered organize job ${jobId} did not reach ${expectedStatus}.`);
  } finally {
    database.close();
  }
}

async function waitForOrganizeJobRemoval({ jobId, timeoutMs }) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const transaction = database.transaction('organizeJobs', 'readonly');
      const request = transaction.objectStore('organizeJobs').get(jobId);
      const job = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!job) return { removed: true };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Organize job ${jobId} did not release its durable slot.`);
  } finally {
    database.close();
  }
}

async function dismissRetainedTerminalOrganizeJob({ jobId, timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, []);
  });
  const controllerId = `controller:v1:runtime-terminal-dismiss-${crypto.randomUUID()}`;
  const sessionId = await globalThis.__createAgentSessionForRuntime();
  const waitFor = async (predicate, startIndex = 0) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages.slice(startIndex)].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Retained terminal Dismiss timed out: ${JSON.stringify(messages.slice(-6).map((message) => ({
      type: message.type,
      jobId: message.presentation?.jobId ?? null,
      status: message.presentation?.status ?? null,
      role: message.role ?? null,
    })))}`);
  };
  port.postMessage({ type: 'requestBgsmActiveOrganizeJob', controllerId, sessionId });
  const terminal = await waitFor((message) => (
    message.type === 'bgsmOrganizeJobState'
    && message.presentation?.jobId === jobId
    && ['completed', 'cancelled'].includes(message.presentation.status)
    && message.role === null
  ));
  const dismissStart = messages.length;
  port.postMessage({
    type: 'dismissBgsmTerminalOrganizeJob',
    controllerId,
    sessionId,
    jobId,
    expectedRevision: terminal.presentation.revision,
  });
  await waitFor((message) => (
    message.type === 'bgsmOrganizeJobState'
    && message.presentation === null
    && message.role === null
  ), dismissStart);
  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return { status: terminal.presentation.status, apply: terminal.presentation.apply };
}

async function beginActiveProviderReadScenario({ timeoutMs }) {
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-active-disconnect-${crypto.randomUUID()}`;
  const sessionId = await globalThis.__createAgentSessionForRuntime();
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId: 'runtime-active-disconnect-preflight',
    taskInstruction: 'Complete this durable analysis after the panel disconnects.',
  });
  const deadline = Date.now() + timeoutMs;
  let preflight = null;
  while (Date.now() < deadline) {
    preflight = messages.find((message) => message.type === 'bgsmOrganizeJobRunPreflightResult');
    if (preflight) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!preflight) throw new Error(`Active disconnect preflight timed out: ${JSON.stringify(messages)}`);
  port.postMessage({
    type: 'startBgsmOrganizeJob',
    controllerId,
    sessionId,
    requestId: preflight.requestId,
    preflightToken: preflight.preflightToken,
    taskInstruction: 'Complete this durable analysis after the panel disconnects.',
  });
  let analyzing = null;
  while (Date.now() < deadline) {
    analyzing = [...messages].reverse().find((message) => (
      message.type === 'bgsmOrganizeJobRunSnapshot' &&
      message.snapshot?.state === 'analyzing'
    ));
    if (analyzing) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!analyzing) throw new Error(`Active analysis snapshot timed out: ${JSON.stringify(messages.slice(-5))}`);
  let durable = null;
  while (Date.now() < deadline) {
    const candidate = await globalThis.__readActiveOrganizeJob();
    if (
      candidate?.controllerId === controllerId
      && candidate.sessionId === sessionId
      && candidate.status === 'analyzing'
    ) {
      durable = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!durable) throw new Error('Durable analysis record timed out.');
  globalThis.__runtimeActiveProviderRead = {
    port,
    messages,
    deliveryMetadata,
    controllerId,
    sessionId,
  };
  return { jobId: durable.jobId };
}

async function disconnectActiveProviderReadScenario() {
  const state = globalThis.__runtimeActiveProviderRead;
  if (!state) throw new Error('Active provider-read state is unavailable.');
  state.port.postMessage({
    type: 'disconnectBgsmOrganizeJob',
    controllerId: state.controllerId,
    sessionId: state.sessionId,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  state.port.disconnect();
  delete globalThis.__runtimeActiveProviderRead;
  return { detached: true, deliveryMetadata: state.deliveryMetadata };
}

async function testDeniedCustomHost() {
  const response = await chrome.runtime.sendMessage({
    type: 'testAgentProviderConnection',
    provider: 'custom-openai-compatible',
    baseUrl: 'https://runtime-denied.invalid/v1',
    model: 'runtime-model',
    apiKey: 'must-not-leave-extension',
  });
  return {
    ok: response?.ok === true,
    permissionDenied: response?.ok === false && typeof response?.error === 'string'
      && /host permission|access|allow this ai service/iu.test(response.error),
  };
}
async function closeControlledProvider(control) {
  if (!control) return;
  const failures = [];
  for (const clientState of control.clientStates) {
    if (clientState.retired) continue;
    const failureBaseline = failures.length;
    for (const command of ['Fetch.disable', 'Network.disable']) {
      try {
        await clientState.client.send(command);
      } catch (error) {
        if (clientState.client.detached !== true && !isAlreadyDetachedProviderClient(error)) failures.push(error);
      }
    }
    try {
      await clientState.client.detach();
    } catch (error) {
      if (clientState.client.detached !== true && !isAlreadyDetachedProviderClient(error)) failures.push(error);
    }
    if (failures.length === failureBaseline) clientState.retired = true;
  }
  if (failures.length > 0) throw new AggregateError(failures, 'controlled_provider_close_failed');
}

function isAlreadyDetachedProviderClient(error) {
  return error instanceof Error && /(?:^|: )(?:Session closed\. Most likely the [A-Za-z0-9_-]+ has been closed\.|Session already detached\. Most likely the [A-Za-z0-9_-]+ has been closed\.|Target closed\.?|Session with given id not found\.|No session with given id\.?)$/u.test(error.message);
}


async function closeOrganizeBrowser(activeBrowser) {
  if (!activeBrowser) return;
  const browserProcess = activeBrowser.process?.();
  let gracefullyClosed = false;
  await Promise.race([
    activeBrowser.close().then(() => { gracefullyClosed = true; }),
    new Promise((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
  ]);
  if (gracefullyClosed || activeBrowser.connected === false) return;
  if (!browserProcess || browserProcess.killed || !browserProcess.kill('SIGKILL')) {
    throw new Error('browser_close_failed');
  }
  await Promise.race([
    new Promise((resolve) => browserProcess.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
  ]);
  if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
    throw new Error('browser_close_failed');
  }
}

async function withCleanupTimeout(operation) {
  if (!operation) return;
  await Promise.race([
    operation,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup_timeout')), CLEANUP_TIMEOUT_MS)),
  ]);
}

async function attemptCleanup(kind, operation) {
  try {
    await operation();
    return true;
  } catch {
    cleanupFailureKinds.add(kind);
    return false;
  }
}

function buildCurrentOrganizeFailureDiagnostic() {
  const stage = runtimeStage === 'publish_bounded_evidence'
    ? runtimeStage
    : runtimeCompleted
      ? 'runtime_complete'
      : primaryRuntimeStage;
  return buildOrganizeFailureDiagnostic({
    recovery: RUN_WORKER_RECOVERY,
    primaryStage: stage,
    cleanupFailures: [...cleanupFailureKinds],
    cleanup,
    providerFailures: provider?.interceptionFailures?.length ?? 0,
    providerFailureKinds: provider?.interceptionFailures ?? [],
    replacementFailureCode,
    unexpectedNetworkRequests: (provider?.unexpectedRequests?.length ?? 0)
      + [...pagePolicies].reduce((count, policy) => count + policy.unexpectedRequests.length, 0),
    pageIssues: pageIssues.length,
    unexpectedRequestKinds: [
      ...(provider?.unexpectedRequests ?? []),
      ...[...pagePolicies].flatMap((policy) => policy.unexpectedRequests),
    ],
    pageIssueKinds: pageIssues,
    overflow: provider?.overflow === true || [...pagePolicies].some((policy) => policy.overflow === true),
  });
}

export function buildOrganizeFailureDiagnostic({
  recovery = false,
  primaryStage,
  cleanupFailures = [],
  cleanup: cleanupFacts = {},
  providerFailures = 0,
  providerFailureKinds = [],
  replacementFailureCode: replacementCode = 'none',
  unexpectedNetworkRequests = 0,
  pageIssues: pageIssueCount = 0,
  unexpectedRequestKinds = [],
  pageIssueKinds = [],
  overflow = false,
} = {}) {
  const stage = ORGANIZE_RUNTIME_STAGES.has(primaryStage) ? primaryStage : 'initialization';
  const failureSet = new Set(Array.isArray(cleanupFailures) ? cleanupFailures : []);
  const boundedCleanupFailures = CLEANUP_FAILURE_ORDER.filter((kind) => failureSet.has(kind));
  return {
    schemaVersion: 1,
    status: 'failed',
    proofScope: recovery ? 'packaged_organize_recovery' : 'packaged_organize_job',
    primaryStage: stage,
    primaryCode: stage === 'runtime_complete' ? 'none' : `${stage}_failed`,
    replacementFailureCode: safeReplacementFailureCode(replacementCode),
    cleanupCode: boundedCleanupFailures.length === 0 ? 'none' : 'cleanup_incomplete',
    cleanupFailures: boundedCleanupFailures,
    providerFailures: boundedDiagnosticCount(providerFailures),
    providerFailureKinds: boundedProviderFailureKinds(providerFailureKinds),
    unexpectedNetworkRequests: boundedDiagnosticCount(unexpectedNetworkRequests),
    pageIssues: boundedDiagnosticCount(pageIssueCount),
    unexpectedRequestKinds: boundedUnexpectedRequestKinds(unexpectedRequestKinds),
    pageIssueKinds: boundedPageIssueKinds(pageIssueKinds),
    overflow: overflow === true,
    cleanup: {
      networkGatesClosed: cleanupFacts.networkGatesClosed === true,
      diagnosticsDetached: cleanupFacts.diagnosticsDetached === true,
      pagesClosed: cleanupFacts.pagesClosed === true,
      browserClosed: cleanupFacts.browserClosed === true,
      temporaryStateRemoved: cleanupFacts.temporaryStateRemoved === true,
    },
  };
}

function boundedProviderFailureKinds(records) {
  const result = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (result.length >= MAX_DIAGNOSTIC_PROVIDER_FAILURE_KINDS) break;
    result.push({
      stage: safeProviderFailureDiagnosticStage(record?.stage),
      kind: safeProviderKind(record?.kind),
    });
  }
  return result;
}

function safeProviderFailureDiagnosticStage(value) {
  return ['requestPaused', 'releaseStall', 'provider_interception', 'fail_closed_cleanup'].includes(value)
    ? value
    : 'provider_interception';
}


function classifyReplacementFailure(error) {
  const message = error instanceof Error ? error.message : '';
  const known = new Map([
    ['Worker replacement controller is closed.', 'controller_closed'],
    ['A worker replacement is already in progress.', 'replacement_in_progress'],
    ['Exactly one running service-worker version is required before replacement.', 'running_version_cardinality'],
    ['The exact old service-worker identity did not report a current stopped transition.', 'stopped_transition_timeout'],
    ['Stopped target provider preinstallation returned invalid evidence.', 'preinstall_evidence_invalid'],
    ['Stopped target restarted before provider installation completed.', 'stopped_target_restarted'],
    ['Stopped target identity or status changed before provider installation completed.', 'stopped_target_changed'],
    ['The preinstalled stopped target did not report a post-start transition.', 'post_start_transition_timeout'],
    ['Multiple matching extension service workers are running.', 'multiple_workers_running'],
    ['Chrome started an uninstrumented replacement target.', 'uninstrumented_target'],
    ['The preinstalled replacement worker did not reach running state.', 'running_transition_timeout'],
    ['Service-worker script identity is outside the packaged extension.', 'script_identity_outside'],
    ['Service-worker script route is invalid.', 'script_route_invalid'],
  ]);
  if (known.has(message)) return known.get(message);
  if (/^(?:stopped target attachment|service-worker (?:version|registration|target)) ID is invalid\.$/u.test(message)) {
    return 'identity_invalid';
  }
  return 'replacement_unknown';
}

function safeReplacementFailureCode(value) {
  return [
    'none',
    'controller_closed',
    'replacement_in_progress',
    'running_version_cardinality',
    'stopped_transition_timeout',
    'preinstall_evidence_invalid',
    'stopped_target_restarted',
    'stopped_target_changed',
    'post_start_transition_timeout',
    'multiple_workers_running',
    'uninstrumented_target',
    'running_transition_timeout',
    'script_identity_outside',
    'script_route_invalid',
    'identity_invalid',
    'replacement_unknown',
  ].includes(value) ? value : 'replacement_unknown';
}
function boundedDiagnosticCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_DIAGNOSTIC_COUNT) : 0;
}

function boundedUnexpectedRequestKinds(records) {
  const allowedRoutes = new Set([
    'responses',
    'github-user',
    'github-starred',
    'github-watch-scope',
    'github-notifications',
    'github-probe-gist',
    'github-gists',
    'github-repository',
    'unexpected-http',
  ]);
  const kinds = [];
  for (const record of Array.isArray(records) ? records : []) {
    const method = safeHttpMethod(record?.method);
    const route = allowedRoutes.has(record?.route) ? record.route : 'unexpected-http';
    const kind = `${method}_${route}`;
    if (!kinds.includes(kind)) kinds.push(kind);
    if (kinds.length === 24) break;
  }
  return kinds;
}

function boundedPageIssueKinds(records) {
  const allowed = new Set(['console-error', 'page-error', 'request-failed']);
  const kinds = [];
  for (const record of Array.isArray(records) ? records : []) {
    const kind = allowed.has(record?.kind) ? record.kind : 'page-issue';
    if (!kinds.includes(kind)) kinds.push(kind);
    if (kinds.length === 24) break;
  }
  return kinds;
}

function isDirectExecution() {
  return typeof process.argv[1] === 'string'
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function buildOrganizeEvidence(releaseDist) {
  const containment = {
    networkFailClosed: true,
    unexpectedNetworkRequests: (provider?.unexpectedRequests.length ?? 0)
      + [...pagePolicies].reduce((count, policy) => count + policy.unexpectedRequests.length, 0),
    rawCredentialOccurrences: 0,
    privatePayloadOccurrences: 0,
    overflow: provider?.overflow === true || [...pagePolicies].some((policy) => policy.overflow === true),
  };
  if (RUN_WORKER_RECOVERY) {
    return {
      schemaVersion: 1,
      status: 'passed',
      proofScope: 'packaged_organize_recovery',
      productionDistExercised: true,
      releaseDist,
      organizeRecovery: recoveryFacts,
      containment,
      cleanup: { ...cleanup },
      evidenceBytes: 0,
    };
  }
  return {
    schemaVersion: 1,
    status: 'passed',
    proofScope: 'packaged_organize_job',
    productionDistExercised: true,
    releaseDist,
    organize: {
      configuration: facts.configuration,
      corruption: facts.corruption,
      start: facts.start,
      budget: facts.budget,
      detach: facts.detach,
      ownership: facts.ownership,
      deletion: facts.deletion,
      draftRecovery: facts.draftRecovery,
      nextAdmission: facts.nextAdmission,
      dismiss: facts.dismiss,
      provider: facts.provider,
    },
    containment,
    cleanup: { ...cleanup },
    evidenceBytes: 0,
  };
}

function publishOrganizeEvidence(evidenceOverride = null, releaseDistOverride = null) {
  const releaseDist = releaseDistOverride ?? readRuntimeReleaseDistIdentity(DIST);
  const evidence = evidenceOverride ?? buildOrganizeEvidence(releaseDist);
  const validateEvidence = RUN_WORKER_RECOVERY ? validateOrganizeRecoveryEvidence : validateOrganizeEvidence;
  serializeRuntimeEvidence(evidence, { validateEvidence, privateMarkers: PRIVATE_MARKERS });
  const directory = process.env.GSM_RUNTIME_EVIDENCE_DIR;
  if (directory) {
    publishRuntimeEvidence({
      directory,
      filename: RUN_WORKER_RECOVERY
        ? 'organize-job-recovery.schema.json'
        : 'organize-job.schema.json',
      evidence,
      validateEvidence,
      privateMarkers: PRIVATE_MARKERS,
    });
  }
}

function validateCommonEvidence(value, scope, factsKey) {
  assertExactKeys(value, [
    'schemaVersion',
    'status',
    'proofScope',
    'productionDistExercised',
    'releaseDist',
    factsKey,
    'containment',
    'cleanup',
    'evidenceBytes',
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.status, 'passed');
  assert.equal(value.proofScope, scope);
  assert.equal(value.productionDistExercised, true);
  assertRuntimeReleaseDistIdentity(value.releaseDist);
  assertExactKeys(value.containment, [
    'networkFailClosed',
    'unexpectedNetworkRequests',
    'rawCredentialOccurrences',
    'privatePayloadOccurrences',
    'overflow',
  ]);
  assert.deepEqual(value.containment, {
    networkFailClosed: true,
    unexpectedNetworkRequests: 0,
    rawCredentialOccurrences: 0,
    privatePayloadOccurrences: 0,
    overflow: false,
  });
  assertExactKeys(value.cleanup, [
    'networkGatesClosed',
    'diagnosticsDetached',
    'pagesClosed',
    'browserClosed',
    'temporaryStateRemoved',
  ]);
  assert.equal(Object.values(value.cleanup).every((entry) => entry === true), true);
  assert.equal(Number.isSafeInteger(value.evidenceBytes) && value.evidenceBytes > 0, true);
}

function validateOrganizeEvidence(value) {
  validateCommonEvidence(value, 'packaged_organize_job', 'organize');
  const organize = value.organize;
  assertExactKeys(organize, [
    'configuration', 'corruption', 'start', 'budget', 'detach', 'ownership',
    'deletion', 'draftRecovery', 'nextAdmission', 'dismiss', 'provider',
  ]);
  assertExactKeys(organize.configuration, ['transientProbeRequests', 'savedCredentialUnchanged', 'savedCapabilityReady']);
  assert.deepEqual(organize.configuration, { transientProbeRequests: 2, savedCredentialUnchanged: true, savedCapabilityReady: true });
  assertExactKeys(organize.corruption, ['activeCheckpointDiscarded', 'blockedCheckpointReplaced', 'duplicateStartIdempotent']);
  assert.equal(Object.values(organize.corruption).every((entry) => entry === true), true);
  assertExactKeys(organize.start, ['preflightRows', 'admittedRows']);
  assert.deepEqual(organize.start, { preflightRows: 501, admittedRows: 1 });
  assertExactKeys(organize.budget, ['frozenRows', 'providerAttemptsBeforeContinuation', 'continuationCount', 'completed']);
  assert.deepEqual(organize.budget, { frozenRows: 501, providerAttemptsBeforeContinuation: 7, continuationCount: 2, completed: true });
  assertExactKeys(organize.detach, ['detachedWhileActive', 'terminalRetainedUntilDismiss']);
  assert.equal(Object.values(organize.detach).every((entry) => entry === true), true);
  assertExactKeys(organize.ownership, [
    'rawPages', 'ownerPages', 'observerPages', 'ownerLostPages', 'explicitTakeoverPages',
    'formerOwnerObserverPages', 'ownerObserverConverged', 'ownerLossRequiredExplicitTakeover',
    'takeoverProviderRequestDelta', 'terminalProjectionPages', 'terminalPagesConverged',
  ]);
  assert.deepEqual(organize.ownership, {
    rawPages: 2,
    ownerPages: 1,
    observerPages: 1,
    ownerLostPages: 1,
    explicitTakeoverPages: 1,
    formerOwnerObserverPages: 1,
    ownerObserverConverged: true,
    ownerLossRequiredExplicitTakeover: true,
    takeoverProviderRequestDelta: 0,
    terminalProjectionPages: 2,
    terminalPagesConverged: true,
  });
  assertExactKeys(organize.deletion, [
    'nonterminalDeletionBlocked', 'deletionUiActors', 'originDeletedAfterCommit',
    'terminalEvidenceRetained', 'originProvenanceRetained', 'deletedPagesInvalidated',
    'deletedOriginInCatalog', 'terminalCards', 'originDeletedCopyPages',
    'retainedTerminalRows', 'retainedApplyRows',
  ]);
  assert.deepEqual(organize.deletion, {
    nonterminalDeletionBlocked: true,
    deletionUiActors: 1,
    originDeletedAfterCommit: true,
    terminalEvidenceRetained: true,
    originProvenanceRetained: true,
    deletedPagesInvalidated: true,
    deletedOriginInCatalog: 0,
    terminalCards: 2,
    originDeletedCopyPages: 2,
    retainedTerminalRows: 1,
    retainedApplyRows: 501,
  });
  assertExactKeys(organize.draftRecovery, [
    'contentPages', 'originSessionPagesBefore', 'replacementSessionsCreated', 'invalidationPages',
    'draftsPreserved', 'replacementSessionPages', 'composerEnabledPages',
    'deletedOriginTranscriptRows', 'deletedOriginRetryCards',
    'replacementSessionSelected', 'unsentDraftPreservedExactly',
  ]);
  assert.deepEqual(organize.draftRecovery, {
    contentPages: 2,
    originSessionPagesBefore: 2,
    replacementSessionsCreated: 1,
    invalidationPages: 2,
    draftsPreserved: 2,
    replacementSessionPages: 2,
    composerEnabledPages: 2,
    deletedOriginTranscriptRows: 0,
    deletedOriginRetryCards: 0,
    replacementSessionSelected: true,
    unsentDraftPreservedExactly: true,
  });
  assertExactKeys(organize.nextAdmission, [
    'actorPages', 'observerPages', 'noJobProjectionPages', 'oldTerminalRows',
    'oldApplyRows', 'newPreflightRows', 'providerRequestDelta', 'pagesConverged',
  ]);
  assert.deepEqual(organize.nextAdmission, {
    actorPages: 1,
    observerPages: 1,
    noJobProjectionPages: 2,
    oldTerminalRows: 0,
    oldApplyRows: 0,
    newPreflightRows: 1,
    providerRequestDelta: 0,
    pagesConverged: true,
  });
  assertExactKeys(organize.dismiss, ['actorPages', 'convergedPages', 'dismissedTerminalRows', 'dismissedApplyRows', 'pagesConverged']);
  assert.deepEqual(organize.dismiss, { actorPages: 1, convergedPages: 2, dismissedTerminalRows: 0, dismissedApplyRows: 0, pagesConverged: true });
  assertExactKeys(organize.provider, [
    'requests', 'authenticatedRequests', 'githubFixtureRequests', 'unexpectedRequests',
    'failures', 'overflow', 'customHostDeniedFetches',
  ]);
  assert.equal(Number.isSafeInteger(organize.provider.requests) && organize.provider.requests > 0, true);
  assert.equal(organize.provider.authenticatedRequests, organize.provider.requests);
  assert.equal(Number.isSafeInteger(organize.provider.githubFixtureRequests) && organize.provider.githubFixtureRequests > 0, true);
  assert.equal(organize.provider.unexpectedRequests, 0);
  assert.equal(organize.provider.failures, 0);
  assert.equal(organize.provider.overflow, false);
  assert.equal(organize.provider.customHostDeniedFetches, 0);
}

function validateOrganizeRecoveryEvidence(value) {
  validateCommonEvidence(value, 'packaged_organize_recovery', 'organizeRecovery');
  const recovery = value.organizeRecovery;
  assertExactKeys(recovery, ['replacement', 'epochs', 'outcome', 'provider']);
  assertExactKeys(recovery.replacement, [
    'scenarioId', 'oldVersionId', 'newVersionId', 'oldTargetId', 'newTargetId',
    'oldAttachmentId', 'newAttachmentId', 'scriptRelativePath', 'lifecycleMode',
    'stopCommandOrdinal', 'stoppedOrdinal', 'installCompletedOrdinal',
    'startCommandOrdinal', 'runningOrdinal',
  ]);
  for (const field of [
    'scenarioId', 'oldVersionId', 'newVersionId', 'oldTargetId', 'newTargetId',
    'oldAttachmentId', 'newAttachmentId', 'lifecycleMode',
  ]) {
    assert.match(recovery.replacement[field], /^[A-Za-z0-9._:/-]{1,160}$/u);
  }
  assert.match(recovery.replacement.scriptRelativePath, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,160}\.js$/u);
  assert.equal(recovery.replacement.scenarioId, 'organize_worker_recovery');
  assert.equal(recovery.replacement.lifecycleMode, 'paused_target_auto_attached');
  assert.equal(recovery.replacement.oldVersionId, recovery.replacement.newVersionId);
  assert.equal(recovery.replacement.oldTargetId, recovery.replacement.newTargetId);
  assert.equal(recovery.replacement.oldAttachmentId, recovery.replacement.newAttachmentId);
  assert.equal(recovery.replacement.stopCommandOrdinal < recovery.replacement.stoppedOrdinal, true);
  assert.equal(recovery.replacement.stoppedOrdinal <= recovery.replacement.installCompletedOrdinal, true);
  assert.equal(recovery.replacement.installCompletedOrdinal <= recovery.replacement.startCommandOrdinal, true);
  assert.equal(recovery.replacement.startCommandOrdinal < recovery.replacement.runningOrdinal, true);
  assertExactKeys(recovery.epochs, ['oldEpochId', 'newEpochId']);
  assert.match(recovery.epochs.oldEpochId, /^[A-Za-z0-9._:/-]{1,160}$/u);
  assert.match(recovery.epochs.newEpochId, /^[A-Za-z0-9._:/-]{1,160}$/u);
  assert.notEqual(recovery.epochs.oldEpochId, recovery.epochs.newEpochId);
  assertExactKeys(recovery.outcome, [
    'runIdStable', 'generationStable', 'firstPageAttempts', 'retriedFirstPage',
    'settledCount', 'uniqueSettledPositionCount', 'providerAttemptCount',
    'duplicateProviderRequests', 'terminalStatus',
  ]);
  assert.deepEqual(recovery.outcome, {
    runIdStable: true,
    generationStable: true,
    firstPageAttempts: 2,
    retriedFirstPage: true,
    settledCount: 501,
    uniqueSettledPositionCount: 501,
    providerAttemptCount: 21,
    duplicateProviderRequests: 1,
    terminalStatus: 'review',
  });
  assertExactKeys(recovery.provider, ['requests', 'interruptions', 'failures']);
  assert.deepEqual(recovery.provider, { requests: 22, interruptions: 1, failures: 0 });
}

function assertExactKeys(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value), keys);
}

async function runEvidenceSelfTest() {
  let asynchronousPolls = 0;
  await waitUntil(async () => {
    asynchronousPolls += 1;
    await Promise.resolve();
    return asynchronousPolls === 3;
  }, 250);
  assert.equal(asynchronousPolls, 3);
  await assert.rejects(
    () => waitUntil(async () => false, 25),
    /Timed out waiting for controlled runtime state\./u,
  );
  const releaseDist = {
    packageInput: { algorithm: 'sha256', fileCount: 4, sha256: 'a'.repeat(64) },
    manifest: { relativePath: 'manifest.json', bytes: 100, sha256: 'b'.repeat(64), manifestVersion: 3, extensionVersion: '1.0.8' },
    loader: { relativePath: 'service-worker-loader.js', bytes: 50, sha256: 'c'.repeat(64) },
    worker: { relativePath: 'assets/service-worker.js', bytes: 500, sha256: 'd'.repeat(64) },
  };
  Object.assign(cleanup, {
    networkGatesClosed: true,
    diagnosticsDetached: true,
    pagesClosed: true,
    browserClosed: true,
    temporaryStateRemoved: true,
  });
  const common = {
    schemaVersion: 1,
    status: 'passed',
    productionDistExercised: true,
    releaseDist,
    containment: {
      networkFailClosed: true,
      unexpectedNetworkRequests: 0,
      rawCredentialOccurrences: 0,
      privatePayloadOccurrences: 0,
      overflow: false,
    },
    cleanup: { ...cleanup },
    evidenceBytes: 0,
  };
  const normal = {
    schemaVersion: common.schemaVersion,
    status: common.status,
    proofScope: 'packaged_organize_job',
    productionDistExercised: common.productionDistExercised,
    releaseDist,
    organize: {
      configuration: { transientProbeRequests: 2, savedCredentialUnchanged: true, savedCapabilityReady: true },
      corruption: { activeCheckpointDiscarded: true, blockedCheckpointReplaced: true, duplicateStartIdempotent: true },
      start: { preflightRows: 501, admittedRows: 1 },
      budget: { frozenRows: 501, providerAttemptsBeforeContinuation: 7, continuationCount: 2, completed: true },
      detach: { detachedWhileActive: true, terminalRetainedUntilDismiss: true },
      ownership: { rawPages: 2, ownerPages: 1, observerPages: 1, ownerLostPages: 1, explicitTakeoverPages: 1, formerOwnerObserverPages: 1, ownerObserverConverged: true, ownerLossRequiredExplicitTakeover: true, takeoverProviderRequestDelta: 0, terminalProjectionPages: 2, terminalPagesConverged: true },
      deletion: { nonterminalDeletionBlocked: true, deletionUiActors: 1, originDeletedAfterCommit: true, terminalEvidenceRetained: true, originProvenanceRetained: true, deletedPagesInvalidated: true, deletedOriginInCatalog: 0, terminalCards: 2, originDeletedCopyPages: 2, retainedTerminalRows: 1, retainedApplyRows: 501 },
      draftRecovery: { contentPages: 2, originSessionPagesBefore: 2, replacementSessionsCreated: 1, invalidationPages: 2, draftsPreserved: 2, replacementSessionPages: 2, composerEnabledPages: 2, deletedOriginTranscriptRows: 0, deletedOriginRetryCards: 0, replacementSessionSelected: true, unsentDraftPreservedExactly: true },
      nextAdmission: { actorPages: 1, observerPages: 1, noJobProjectionPages: 2, oldTerminalRows: 0, oldApplyRows: 0, newPreflightRows: 1, providerRequestDelta: 0, pagesConverged: true },
      dismiss: { actorPages: 1, convergedPages: 2, dismissedTerminalRows: 0, dismissedApplyRows: 0, pagesConverged: true },
      provider: { requests: 48, authenticatedRequests: 48, githubFixtureRequests: 4, unexpectedRequests: 0, failures: 0, overflow: false, customHostDeniedFetches: 0 },
    },
    containment: common.containment,
    cleanup: common.cleanup,
    evidenceBytes: 0,
  };
  const replacement = { scenarioId: 'organize_worker_recovery', oldVersionId: 'version', newVersionId: 'version', oldTargetId: 'target', newTargetId: 'target', oldAttachmentId: 'attachment', newAttachmentId: 'attachment', scriptRelativePath: 'assets/service-worker.js', lifecycleMode: 'paused_target_auto_attached', stopCommandOrdinal: 1, stoppedOrdinal: 2, installCompletedOrdinal: 2, startCommandOrdinal: 2, runningOrdinal: 3 };
  const recovery = {
    schemaVersion: common.schemaVersion,
    status: common.status,
    proofScope: 'packaged_organize_recovery',
    productionDistExercised: common.productionDistExercised,
    releaseDist,
    organizeRecovery: {
      replacement,
      epochs: { oldEpochId: 'old-epoch', newEpochId: 'new-epoch' },
      outcome: { runIdStable: true, generationStable: true, firstPageAttempts: 2, retriedFirstPage: true, settledCount: 501, uniqueSettledPositionCount: 501, providerAttemptCount: 21, duplicateProviderRequests: 1, terminalStatus: 'review' },
      provider: { requests: 22, interruptions: 1, failures: 0 },
    },
    containment: common.containment,
    cleanup: common.cleanup,
    evidenceBytes: 0,
  };
  const evidence = RUN_WORKER_RECOVERY ? recovery : normal;
  const validator = RUN_WORKER_RECOVERY ? validateOrganizeRecoveryEvidence : validateOrganizeEvidence;
  serializeRuntimeEvidence(evidence, { validateEvidence: validator, privateMarkers: PRIVATE_MARKERS });
  assert.throws(() => serializeRuntimeEvidence({ ...evidence, unexpected: true }, {
    validateEvidence: validator,
    privateMarkers: PRIVATE_MARKERS,
  }));
  publishOrganizeEvidence(evidence, releaseDist);
}
