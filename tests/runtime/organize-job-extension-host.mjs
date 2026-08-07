#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchExtensionBrowser } from './puppeteer-runtime.mjs';

const DIST = path.resolve(process.cwd(), process.env.GSM_DIST_DIR ?? 'dist');
const OPTIONS_PATH = '/src/options/index.html';
const ROW_COUNT = 501;
const TIMEOUT_MS = 30_000;
const RUN_WORKER_RECOVERY = process.env.GSM_RUNTIME_WORKER_RECOVERY === '1';
const WORKER_RECOVERY_TIMEOUT_MS = 90_000;

if (!existsSync(path.join(DIST, 'manifest.json'))) {
  throw new Error(`No production extension at ${DIST}; run pnpm build first.`);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'bgsm-organize-job-host-'));
let browser;
let provider;
let runtimePassedMessage;

try {
  browser = await launchExtensionBrowser({ dist: DIST, userDataDir: profile });
  const { extId, target } = await findExtension(browser);
  const worker = await target.worker();
  worker?.on('console', (message) => {
    if (message.type() === 'error') console.error(`[service-worker] ${message.text()}`);
  });
  const page = await openExtensionPage(browser, extId);
  await page.evaluate(installOrganizeJobRunDeliveryCollector);
  await page.evaluate(installAgentSessionRuntimeFactory);
  await page.evaluate(installCorruptOrganizeJobSeeder);

  provider = await installControlledProvider(target);
  await seedRepositories(page, ROW_COUNT);
  const beforeUnaccepted = provider.capture.length;
  const unaccepted = await page.evaluate(testConnectionWithoutAcceptance);
  assert.equal(unaccepted.ok, true);
  assert.equal(provider.capture.length > beforeUnaccepted, true);
  await configureSavedProvider(page, provider);
  const beforeCapability = provider.capture.length;
  const capabilityDenied = await page.evaluate(runMissingCapabilityScenario, { timeoutMs: TIMEOUT_MS });
  assert.equal(capabilityDenied.terminalReason, 'provider_error');
  assert.equal(provider.capture.length, beforeCapability);
  const savedCapability = await establishSavedProviderCapability(page, provider);
  assert.equal(savedCapability.source, 'builtin-official');
  assert.equal(savedCapability.contextWindow, 1_050_000);
  assert.equal(savedCapability.maxOutputTokens, 128_000);

  console.log('\n1) Transient typed key stays diagnostic-only');
  const transient = await page.evaluate(testTransientTypedKey);
  assert.equal(transient.ok, true);
  assert.equal(transient.savedCredentialUnchanged, true);
  assert.equal(transient.savedCapabilityUnchanged, true);
  console.log('  ✓ transient key completed a real probe without changing saved credential/capability authority');

  console.log('\n2) An invalid analysis checkpoint is discarded instead of restored forever');
  const corruptRestore = await page.evaluate(runCorruptActiveRestoreScenario, {
    timeoutMs: TIMEOUT_MS,
  });
  assert.match(corruptRestore.error, /discarded/i);
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
  console.log('  ✓ blocked durable authority was cancelled directly before the new run started');

  console.log('\n4) Replaying the same durable preflight Start is idempotent');
  provider.analyzerMode = 'actionable-all';
  const repeatedStart = await page.evaluate(runRepeatedPreflightStartScenario, {
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(repeatedStart.error, null);
  assert.equal(repeatedStart.sameRun, true);
  assert.equal(repeatedStart.jobCount, 1);
  console.log('  ✓ duplicate Start replayed the same run without creating a second durable job');

  console.log('\n5) Full scope, exact RunBudget exhaustion, and automatic continuation');
  provider.analyzerMode = 'unchanged';
  const beforePreflight = provider.capture.length;
  const preflightOnly = await page.evaluate(runPreflightOnlyScenario, {
    rowCount: ROW_COUNT,
    timeoutMs: TIMEOUT_MS,
    expectedPriorTerminalJobId: repeatedStart.terminalJobId,
  });
  assert.equal(preflightOnly.count, ROW_COUNT);
  assert.equal(preflightOnly.priorTerminalFound, true);
  assert.equal(preflightOnly.priorTerminalReplaced, true);
  assert.equal(preflightOnly.admittedJobCount, 1);
  assert.equal(provider.capture.length, beforePreflight);
  let organize;
  try {
    organize = await page.evaluate(runOrganizeBudgetContinuationScenario, {
      rowCount: ROW_COUNT,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (error) {
    console.error('Controlled provider capture before failure:', provider.capture);
    throw error;
  }
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
  console.log('  ✓ the Port detached immediately; the no-change result stayed durable until global Dismiss');

  console.log('\n7) Two real pages converge through observer rejection, owner loss, takeover, terminal retention, and Dismiss');
  const observerPage = await openExtensionPage(browser, extId);
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
  await waitUntil(() => typeof provider.releaseStall === 'function', TIMEOUT_MS);
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

  const deletion = await observerPage.evaluate(deleteOwnershipOriginConversation, {
    sessionId: ownerStart.pageSessionId,
    expectedCommitted: true,
    timeoutMs: TIMEOUT_MS,
  });
  const formerOwnerInvalidation = await page.evaluate(waitForOwnershipDeletionInvalidation, {
    deletedSessionId: ownerStart.pageSessionId,
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(deletion.response.ok, true);
  assert.equal(deletion.response.data.deleted, true);
  assert.equal(deletion.invalidation.deletedSessionId, ownerStart.pageSessionId);
  assert.equal(deletion.invalidation.controllerId, observer.pageControllerId);
  assert.equal(deletion.invalidation.sessionId, observer.pageSessionId);
  assert.equal(deletion.invalidationDelivery.deliveryKind, 'live');
  assert.equal(deletion.invalidationDelivery.durableRevision, null);
  assert.equal(formerOwnerInvalidation.invalidation.deletedSessionId, ownerStart.pageSessionId);
  assert.equal(formerOwnerInvalidation.invalidation.controllerId, ownerStart.pageControllerId);
  assert.equal(formerOwnerInvalidation.invalidation.sessionId, ownerStart.pageSessionId);
  assert.equal(formerOwnerInvalidation.invalidationDelivery.deliveryKind, 'live');
  assert.equal(formerOwnerInvalidation.invalidationDelivery.durableRevision, null);

  const [ownerEvidence, observerEvidence] = await Promise.all([
    page.evaluate(readTwoPageOwnershipTerminalEvidence, completedByOwner.presentation.jobId),
    observerPage.evaluate(readTwoPageOwnershipTerminalEvidence, completedByOwner.presentation.jobId),
  ]);
  assert.deepEqual(ownerEvidence, observerEvidence);
  assert.equal(ownerEvidence.sessionExists, false);
  assert.equal(ownerEvidence.job.status, 'completed');
  assert.equal(ownerEvidence.job.originAgentSessionId, ownerStart.pageSessionId);
  assert.equal(ownerEvidence.job.controllerId, observer.pageControllerId);
  assert.equal(ownerEvidence.apply.jobId, completedByOwner.presentation.jobId);
  assert.equal(ownerEvidence.applyRowCount, ROW_COUNT);
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

  const dismissed = await observerPage.evaluate(dismissTwoPageOwnershipTerminal, {
    jobId: completedByOwner.presentation.jobId,
    expectedRevision: completedByOwner.presentation.revision,
    timeoutMs: TIMEOUT_MS,
  });
  const formerOwnerNoJob = await page.evaluate(waitForTwoPageOwnershipNoJob, {
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(dismissed.presentation, null);
  assert.equal(dismissed.role, null);
  assert.equal(formerOwnerNoJob.presentation, null);
  assert.equal(formerOwnerNoJob.role, null);
  assert.equal(dismissed.outerControllerId, observer.pageControllerId);
  assert.equal(formerOwnerNoJob.outerControllerId, ownerStart.pageControllerId);
  const dismissedEvidence = await observerPage.evaluate(
    readTwoPageOwnershipTerminalEvidence,
    completedByOwner.presentation.jobId,
  );
  assert.equal(dismissedEvidence.job, null);
  assert.equal(dismissedEvidence.apply, null);
  assert.equal(dismissedEvidence.applyRowCount, 0);
  await Promise.all([
    page.evaluate(disconnectTwoPageOwnershipPort),
    observerPage.evaluate(disconnectTwoPageOwnershipPort),
  ]);
  await observerPage.close();
  console.log('  ✓ two page-addressed Ports proved observer rejection, explicit takeover without replay, immutable terminal provenance, post-commit deletion, global receipt access, and Dismiss convergence');

  console.log('\n8) Custom-host denial is fail-closed before provider network');
  const beforeDenied = provider.capture.length;
  const denied = await page.evaluate(testDeniedCustomHost);
  const afterDenied = provider.capture.length;
  assert.equal(denied.ok, false);
  assert.match(denied.error, /host permission|access|allow this ai service/i);
  assert.equal(afterDenied, beforeDenied);
  console.log('  ✓ missing optional host permission caused zero provider fetches');

  if (RUN_WORKER_RECOVERY) {
    console.log('\n9) A real Chrome alarm resumes Analysis after MV3 worker termination');
    provider.analyzerMode = 'actionable-all';
    provider.actionTag = 'runtime-worker-recovery';
    provider.stallNextAnalyzer = true;
    const recoveryCaptureStart = provider.capture.length;
    const recoveryStart = await page.evaluate(beginWorkerRecoveryScenario, {
      rowCount: ROW_COUNT,
      timeoutMs: TIMEOUT_MS,
    });
    await waitUntil(() => typeof provider.releaseStall === 'function', TIMEOUT_MS);
    const interruptedClientState = provider.activeClientState;
    assert.ok(interruptedClientState);
    const expiredLease = await page.evaluate(expireActiveAnalysisLeaseForRuntime);
    assert.equal(expiredLease.jobId, recoveryStart.jobId);
    assert.equal(expiredLease.alarmName, 'bgsm-organize-analysis-recovery-v1');
    await page.evaluate(armWorkerRecoveryReconnect);

    const browserClient = await browser.target().createCDPSession();
    const replacementErrors = [];
    const serviceWorkerClient = await page.target().createCDPSession();
    const workerVersions = new Map();
    const workerVersionTransitions = new Map();
    serviceWorkerClient.on('ServiceWorker.workerVersionUpdated', (event) => {
      for (const version of event.versions) {
        workerVersions.set(version.versionId, version);
        const transitions = workerVersionTransitions.get(version.versionId) ?? [];
        transitions.push(version);
        workerVersionTransitions.set(version.versionId, transitions);
      }
    });
    await serviceWorkerClient.send('ServiceWorker.enable');
    await waitUntil(
      () => [...workerVersions.values()].some((version) => (
        version.scriptURL?.startsWith(`chrome-extension://${extId}/`) &&
        version.runningStatus === 'running'
      )),
      TIMEOUT_MS,
    );
    const activeWorkerVersion = [...workerVersions.values()].find((version) => (
      version.scriptURL?.startsWith(`chrome-extension://${extId}/`) &&
      version.runningStatus === 'running'
    ));
    assert.ok(activeWorkerVersion?.versionId);
    let replacementAttached = false;
    let replacementFailure = null;
    const replacementReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Replacement MV3 service worker did not start.')),
        WORKER_RECOVERY_TIMEOUT_MS,
      );
      browserClient.on('Target.attachedToTarget', (event) => {
        if (
          replacementAttached ||
          event.targetInfo.type !== 'service_worker' ||
          !event.targetInfo.url.startsWith(`chrome-extension://${extId}/`)
        ) return;
        replacementAttached = true;
        void (async () => {
          const replacementClient = browserClient.connection().session(event.sessionId);
          if (!replacementClient) throw new Error('Replacement service worker CDP session is unavailable.');
          await installControlledProviderClient(replacementClient, provider);
          await replacementClient.send('Runtime.enable');
          replacementClient.on('Runtime.consoleAPICalled', (message) => {
            if (message.type === 'error') {
              replacementErrors.push(message.args.map((argument) => argument.value).join(' '));
              console.error('[replacement-service-worker]', ...message.args.map((argument) => argument.value));
            }
          });
          await replacementClient.send('Runtime.runIfWaitingForDebugger');
          clearTimeout(timeout);
          resolve(event.targetInfo);
        })().catch((error) => {
          replacementFailure = error;
          clearTimeout(timeout);
          reject(error);
        });
      });
    });
    await browserClient.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [
        { type: 'service_worker', exclude: false },
        { exclude: true },
      ],
    });
    await serviceWorkerClient.send('ServiceWorker.stopWorker', {
      versionId: activeWorkerVersion.versionId,
    });
    await waitUntil(
      () => workerVersionTransitions.get(activeWorkerVersion.versionId)?.some((version) => (
        version.runningStatus === 'stopped'
      )) === true,
      TIMEOUT_MS,
    );
    const stoppedWorkerVersion = workerVersionTransitions
      .get(activeWorkerVersion.versionId)
      ?.find((version) => version.runningStatus === 'stopped');
    await replacementReady;
    settleStalledInterceptionAfterWorkerTermination(provider, {
      interruptedClientState,
      stoppedWorkerVersion,
      expectedVersionId: activeWorkerVersion.versionId,
    });
    if (replacementFailure) throw replacementFailure;
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
    await browserClient.send('Target.setAutoAttach', {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

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
    assert.deepEqual(replacementErrors, []);
    await page.evaluate(disconnectWorkerRecoveryReconnect);
    await page.close();
    console.log('  ✓ alarm and UI reconnect shared one restore, retried the interrupted first page once, and reached durable Review');
  }

  await assertControlledProviderHealthy(provider);
  const capture = provider.capture;
  assert.ok(capture.some((entry) => entry.kind === 'probe-tool'));
  assert.ok(capture.some((entry) => entry.kind === 'probe-ack'));
  assert.ok(capture.some((entry) => entry.authorization === 'Bearer transient-runtime-key'));
  assert.equal(capture.filter((entry) => entry.kind === 'analyzer').length >= 22, true);
  assert.equal(capture.every((entry) => entry.url === 'https://api.openai.com/v1/responses'), true);
  assert.equal(capture.every((entry) => entry.containsHiddenPolicy === false), true);
  runtimePassedMessage = `\nOrganizeJobRun extension-host runtime passed (${capture.length} intercepted Responses requests, zero live traffic).`;
} finally {
  let controlledProviderError = null;
  try {
    await assertControlledProviderHealthy(provider);
  } catch (error) {
    controlledProviderError = error;
  }
  const browserProcess = browser?.process();
  await Promise.race([
    browser?.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  try {
    await assertControlledProviderHealthy(provider);
  } catch (error) {
    controlledProviderError = error;
  }
  if (browserProcess && !browserProcess.killed) browserProcess.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
  if (controlledProviderError) throw controlledProviderError;
}
console.log(runtimePassedMessage);

async function findExtension(browser) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const extensions = await browser.extensions().catch(() => null);
    const extension = [...(extensions?.values() ?? [])].find((entry) =>
      entry.enabled && path.resolve(entry.path) === DIST,
    );
    const target = extension && browser.targets().find((entry) =>
      entry.type() === 'service_worker' && entry.url().startsWith(`chrome-extension://${extension.id}/`),
    );
    const worker = await target?.worker().catch(() => null);
    if (extension && worker) return { extId: extension.id, target };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('MV3 service worker did not become ready.');
}

async function openExtensionPage(browser, extId) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}${OPTIONS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForSelector('#agent-api-key', { timeout: 10_000 });
  return page;
}

async function installControlledProvider(target, existingControl = null) {
  const client = await target.createCDPSession();
  return installControlledProviderClient(client, existingControl);
}

async function installControlledProviderClient(client, existingControl = null) {
  const control = existingControl ?? {
    analyzerMode: 'unchanged',
    actionTag: 'runtime-e2e',
    stallNextAnalyzer: false,
    capture: [],
    pendingInterceptions: new Set(),
    liveInterceptions: new Set(),
    interceptionFailures: [],
    expectedAbortedInterceptions: [],
    clientStates: new Set(),
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
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', (event) => {
    if (clientState.retired) return;
    if (!event.request.url.startsWith('https://api.openai.com/')) return;
    const lifecycle = getProviderNetworkLifecycle(clientState, event.requestId);
    lifecycle.request = event;
    const requestKey = controlledProviderRequestKey(event.request);
    const record = shiftControlledProviderMatch(clientState.unmatchedFetchByRequestKey, requestKey);
    if (record) linkControlledProviderLifecycle(lifecycle, record);
    else queueControlledProviderMatch(clientState.unmatchedNetworkByRequestKey, requestKey, lifecycle);
  });
  client.on('Network.responseReceived', (event) => {
    if (clientState.retired) return;
    if (!event.response.url.startsWith('https://api.openai.com/')) return;
    const lifecycle = getProviderNetworkLifecycle(clientState, event.requestId);
    lifecycle.response = event;
  });
  client.on('Network.loadingFailed', (event) => {
    if (clientState.retired) return;
    const lifecycle = clientState.providerNetworkRequests.get(event.requestId);
    if (!lifecycle) return;
    lifecycle.loadingFailure = event;
    if (lifecycle.record) lifecycle.record.loadingFailure = event;
  });
  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: 'https://api.openai.com/*', requestStage: 'Request' }],
  });
  client.on('Fetch.requestPaused', (event) => {
    if (clientState.retired) return;
    const record = {
      clientState,
      requestId: event.requestId,
      networkId: event.networkId ?? null,
      url: event.request.url,
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
  const authorization = event.request.headers.Authorization ?? event.request.headers.authorization ?? null;
  control.capture.push({
    kind,
    url: event.request.url,
    authorization,
    containsHiddenPolicy: (event.request.postData ?? '').includes('runtime-hidden-policy'),
    runId: analyzerBatch?.runId ?? null,
    generation: analyzerBatch?.generation ?? null,
    batchStart: analyzerBatch?.repositories?.[0]?.frozenIndex ?? null,
    batchEnd: analyzerBatch?.repositories?.at(-1)?.frozenIndex + 1 || null,
  });
  const controlledResponse = request.protocol === 'responses'
    ? { body: buildResponsesSse(completion, control.capture.length), contentType: 'text/event-stream' }
    : { body: buildChatCompletion(completion, body.model, control.capture.length), contentType: 'application/json' };
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
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: controlledResponse.contentType }],
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
  control.interceptionFailures.push(new Error(
    `Controlled provider ${phase} failed for ${record.kind} ${record.url} (${record.requestId}).`,
    { cause: error },
  ));
  try {
    await record.clientState.client.send('Fetch.failRequest', {
      requestId: record.requestId,
      errorReason: 'Failed',
    });
  } catch (cleanupError) {
    if (!(isInvalidInterceptionId(cleanupError, 'Fetch.failRequest') && isPreciseAbortedRequest(record.loadingFailure))) {
      control.interceptionFailures.push(new Error(
        `Controlled provider fail-closed cleanup failed for ${record.url} (${record.requestId}).`,
        { cause: cleanupError },
      ));
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

async function waitForPreciseRequestAbort(record) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (isPreciseAbortedRequest(record.loadingFailure)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function settleExpectedAbortedInterception(control, record, lifecycle) {
  assert.equal(record.state, 'paused', `Cannot abort interception from state ${record.state}.`);
  record.state = 'aborted';
  forgetLiveInterception(control, record);
  control.expectedAbortedInterceptions.push({
    requestId: record.requestId,
    networkId: record.networkId,
    kind: record.kind,
    lifecycle,
  });
}

// Replacement attachment alone is not termination evidence. Remove the stalled
// request only after Chrome reports the exact originating worker version stopped.
function settleStalledInterceptionAfterWorkerTermination(control, {
  interruptedClientState,
  stoppedWorkerVersion,
  expectedVersionId,
}) {
  assert.ok(stoppedWorkerVersion, `Worker ${expectedVersionId} did not report a stopped lifecycle.`);
  assert.equal(stoppedWorkerVersion.versionId, expectedVersionId);
  assert.equal(stoppedWorkerVersion.runningStatus, 'stopped');
  assert.equal(interruptedClientState.retired, true, 'Stopped worker client state was not retired.');
  assert.notEqual(
    control.activeClientState,
    interruptedClientState,
    'Stopped worker client remains the active interception authority.',
  );
  const stalled = [...control.liveInterceptions].filter((record) => (
    record.clientState === interruptedClientState &&
    record.kind === 'analyzer-stall' &&
    record.state === 'paused'
  ));
  assert.equal(
    stalled.length,
    1,
    `Expected exactly one stalled interception for stopped worker ${expectedVersionId}, found ${stalled.length}.`,
  );
  settleExpectedAbortedInterception(control, stalled[0], {
    kind: 'service-worker-terminated',
    versionId: expectedVersionId,
  });
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
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for controlled runtime state.');
}

async function seedRepositories(page, count) {
  await page.evaluate(async (rowCount) => {
    const request = indexedDB.open('better-github-stars-manager');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['stars', 'tags', 'tagMeta'], 'readwrite');
    const stars = tx.objectStore('stars');
    const tags = tx.objectStore('tags');
    stars.clear();
    tags.clear();
    tx.objectStore('tagMeta').clear();
    tx.objectStore('tagMeta').put({
      name: 'runtime-hidden-policy',
      dimension: null,
      color: null,
      mtime: '2026-07-14T00:00:00.000Z',
      excluded: true,
    });
    const now = '2026-07-14T00:00:00.000Z';
    for (let index = 0; index < rowCount; index += 1) {
      const id = `runtime/repo-${String(index).padStart(3, '0')}`;
      stars.put({
        full_name: id,
        html_url: `https://github.com/${id}`,
        description: `Runtime repository ${index}`,
        language: index % 2 ? 'TypeScript' : 'Rust',
        stargazers_count: index,
        topics: ['runtime'],
        pushed_at: now,
        created_at: now,
        fork: false,
        archived: false,
        starred_at: now,
        tombstone: false,
        synced_at: now,
      });
      tags.put({
        full_name: id,
        manualTags: [],
        autoTags: ['runtime-hidden-policy'],
        dismissedAutoTags: [],
        manualTagsMtime: now,
        autoTagsMtime: now,
        dismissedAutoTagsMtime: now,
        notes: '',
        mtime: now,
      });
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    await chrome.runtime.sendMessage({ type: 'getStatus' });
  }, count);
}

async function configureSavedProvider(page, provider) {
  await page.$eval('#agent-api-key', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'runtime-provider-key');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
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

async function establishSavedProviderCapability(page, provider) {
  await clickButton(page, /^Test connection$/i);
  try {
    await pollPageConfig(page, (config) => config?.agentProvider?.capability?.namedToolRoundTrip === true);
  } catch (error) {
    const [body, capture] = await Promise.all([
      page.evaluate(() => document.body.innerText),
      Promise.resolve(provider.capture),
    ]);
    throw new Error(`Provider capability probe failed: ${JSON.stringify({ body, capture })}`, { cause: error });
  }
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
          fingerprint: `fs:v1:${'A'.repeat(43)}`,
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
  globalThis.__readOrganizeJobs = async () => {
    const database = await openDatabase();
    try {
      const transaction = database.transaction('organizeJobs', 'readonly');
      const request = transaction.objectStore('organizeJobs').getAll();
      return await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  };
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
  const jobs = await globalThis.__readOrganizeJobs();
  port.postMessage({ type: 'disconnectBgsmOrganizeJob', controllerId, sessionId });
  port.disconnect();
  return {
    error: failure.message,
    jobExists: jobs.some((job) => job.jobId === seeded.jobId),
    finalRevision: jobs.find((job) => job.jobId === seeded.jobId)?.revision ?? null,
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
  const jobs = await globalThis.__readOrganizeJobs();
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
    error: outcome.type === 'bgsmOrganizeJobRunError' ? outcome.message : null,
    oldJobExists: jobs.some((job) => job.jobId === seeded.jobId),
    jobCount: jobs.length,
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
  const jobCountBefore = (await globalThis.__readOrganizeJobs()).length;
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = [...messages].reverse().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const durableJobs = await globalThis.__readOrganizeJobs();
    throw new Error(`${label} timed out: ${JSON.stringify({
      messages: messages.slice(-2).map((message) => ({
        type: message.type,
        status: message.presentation?.status ?? message.snapshot?.state ?? null,
        role: message.role ?? null,
        revision: message.presentation?.revision ?? null,
        reason: message.reason ?? message.event?.reason ?? null,
      })),
      durableJobs: durableJobs.map((job) => ({
        jobId: job.jobId,
        status: job.status,
        revision: job.revision,
      })),
    })}`);
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

  const jobCount = (await globalThis.__readOrganizeJobs())
    .filter((job) => job.jobId === firstState.presentation.jobId).length;
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
    error: replay.type === 'bgsmOrganizeJobRunError' ? replay.message : null,
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
    error: chrome.runtime.lastError?.message ?? null,
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
  const port = chrome.runtime.connect({ name: 'bgsm-agent-organize-job' });
  const messages = [];
  const deliveryMetadata = [];
  port.onMessage.addListener((delivery) => {
    globalThis.__recordBgsmOrganizeJobDelivery(delivery, messages, deliveryMetadata);
  });
  const controllerId = `controller:v1:runtime-preflight-only-${crypto.randomUUID()}`;
  const sessionId = await globalThis.__createAgentSessionForRuntime();
  const requestId = `runtime-preflight-only-${crypto.randomUUID()}`;
  const priorJobs = await globalThis.__readOrganizeJobs();
  const priorTerminal = priorJobs.find((job) => job.jobId === expectedPriorTerminalJobId) ?? null;
  port.postMessage({
    type: 'requestBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId,
    taskInstruction: 'Prepare the complete runtime scope.',
  });
  const deadline = Date.now() + timeoutMs;
  let preflight = null;
  while (Date.now() < deadline) {
    preflight = messages.find((message) => (
      message.type === 'bgsmOrganizeJobRunPreflightResult' && message.requestId === requestId
    ));
    if (preflight) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!preflight) throw new Error(`Preflight-only scenario timed out: ${JSON.stringify(messages)}`);
  if (preflight.count !== rowCount) throw new Error(`Expected ${rowCount}, got ${preflight.count}`);
  const admittedJobs = await globalThis.__readOrganizeJobs();
  const replacement = admittedJobs.find((job) => (
    job.controllerId === controllerId &&
    job.sessionId === sessionId &&
    job.status === 'preflight_ready'
  ));
  if (!replacement) {
    throw new Error(`Replacement preflight was not durable: ${JSON.stringify(admittedJobs)}`);
  }
  const cancelStartIndex = messages.length;
  port.postMessage({
    type: 'cancelBgsmOrganizeJobPreflight',
    controllerId,
    sessionId,
    requestId,
  });
  let noJob = null;
  while (Date.now() < deadline) {
    noJob = [...messages.slice(cancelStartIndex)].reverse().find((message) => (
      message.type === 'bgsmOrganizeJobState' &&
      message.presentation === null &&
      message.role === null
    )) ?? null;
    if (noJob) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!noJob) throw new Error(`Preflight cancellation did not converge: ${JSON.stringify(messages.slice(-12).map((message) => ({
    type: message.type,
    status: message.presentation?.status ?? message.snapshot?.state ?? null,
    role: message.role ?? null,
    reason: message.reason ?? null,
    requestId: message.requestId ?? null,
    message: message.message ?? null,
  })))}`);
  port.disconnect();
  return {
    count: preflight.count,
    priorTerminalFound: priorTerminal?.status === 'cancelled',
    priorTerminalReplaced: !admittedJobs.some((job) => job.jobId === expectedPriorTerminalJobId),
    admittedJobCount: admittedJobs.length,
    replacementJobId: replacement.jobId,
    deliveryMetadata,
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
      const applyRows = apply
        ? await readRequest(transaction.objectStore('organizeApplyRows').index('applyId').getAll(apply.applyId))
        : [];
      return {
        sessionExists: !!session,
        job: job ?? null,
        apply: apply ?? null,
        applyRowCount: applyRows.length,
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
  };
  return {
    jobId: durable.presentation.jobId,
    controllerId,
    sessionId,
    runId: snapshot.snapshot.runId,
    generation: snapshot.snapshot.generation,
  };
}

function armWorkerRecoveryReconnect() {
  const state = globalThis.__runtimeWorkerRecoveryReconnect;
  if (!state) throw new Error('Worker recovery reconnect state is unavailable.');
  if (state.reconnectArmed) return { armed: true };
  state.reconnectArmed = true;

  const connect = () => {
    if (state.reconnectStopped) return;
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
      if (!state.reconnectStopped) setTimeout(connect, 25);
    });
    port.postMessage({
      type: 'requestBgsmActiveOrganizeJob',
      controllerId: state.controllerId,
      sessionId: state.sessionId,
    });
  };

  state.port.onDisconnect.addListener(() => {
    if (!state.reconnectStopped) setTimeout(connect, 0);
  });
  return { armed: true };
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
    const jobs = await requestValue(jobsStore.getAll());
    const job = jobs.find((candidate) => candidate.status === 'analyzing');
    if (!job) throw new Error('Active durable analysis job is unavailable.');
    const items = await requestValue(itemsStore.getAll());
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
    const alarmName = 'bgsm-organize-analysis-recovery-v1';
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
        read(transaction.objectStore('organizeItems').getAll()),
      ]);
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
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let durable = null;
  try {
    while (Date.now() < deadline) {
      const transaction = database.transaction('organizeJobs', 'readonly');
      const request = transaction.objectStore('organizeJobs').getAll();
      const jobs = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      durable = jobs.find((job) => (
        job.controllerId === controllerId &&
        job.sessionId === sessionId &&
        job.status === 'analyzing'
      ));
      if (durable) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    database.close();
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
  return chrome.runtime.sendMessage({
    type: 'testAgentProviderConnection',
    provider: 'custom-openai-compatible',
    baseUrl: 'https://runtime-denied.invalid/v1',
    model: 'runtime-model',
    apiKey: 'must-not-leave-extension',
  });
}
