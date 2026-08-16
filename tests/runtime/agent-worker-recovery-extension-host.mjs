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
  enableControlledProviderRuntime,
  handoffStoppedControlledProviderClient,
  retireControlledProviderClient,
} from './controlled-responses-provider.mjs';
import {
  discoverExtension,
  hookPageDiagnostics,
  openExtensionPage,
} from './extension-runtime-targets.mjs';
import { createServiceWorkerReplacementController } from './service-worker-replacement.mjs';

const DIST = path.resolve(process.cwd(), process.env.GSM_DIST_DIR ?? 'dist');
const OPTIONS_PATH = '/src/options/index.html';
const PROVIDER_ORIGIN = 'https://api.openai.com';
const PROVIDER_BASE_URL = `${PROVIDER_ORIGIN}/v1`;
const MODEL = 'runtime-worker-recovery-model';
const GITHUB_CREDENTIAL = 'github_pat_runtime_worker_recovery';
const PROVIDER_CREDENTIAL = 'runtime-worker-recovery-key';
const REPOSITORY = 'runtime-user/runtime-worker-recovery';
const COMMITTED_SESSION = 'runtime-worker-committed-session';
const COMMITTED_ATTEMPT = 'runtime-worker-committed-attempt';
const READONLY_ATTEMPT = 'runtime-worker-readonly-attempt';
const UNCERTAIN_SESSION = 'runtime-worker-uncertain-session';
const UNCERTAIN_ATTEMPT = 'runtime-worker-uncertain-attempt';
const FRESH_ATTEMPT = 'runtime-worker-fresh-attempt';
const PROMPT_CANARY = 'runtime-worker-prompt-canary-7b';
const ARTIFACT_CANARY = 'runtime-worker-artifact-canary-7b';
const TOOL_RESULT_CANARY = 'runtime-worker-tool-result-canary-7b';
const TRANSCRIPT_CANARY = 'runtime-worker-transcript-canary-7b';
const READONLY_READER_CALL_ID = 'readonly-reader-0';
const SOURCE_CALL_ID = `${ARTIFACT_CANARY}-${TOOL_RESULT_CANARY}`;
const SETUP_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 90_000;
const REPLACEMENT_TIMEOUT_MS = 45_000;

const profile = mkdtempSync(path.join(os.tmpdir(), 'bgsm-agent-worker-recovery-'));
const pageIssues = [];
const pageHttpPolicy = {
  unexpectedRequests: [],
  expectedRequests: [],
  handler: optionsGithubFixture,
  overflow: false,
  interceptionFailure: false,
  close: null,
};
const scenario = createScenarioState();
let browser;
let page;
let provider;
let providerHandle;
let replacementController;
let pageDiagnostics;
let failure;
let failureDiagnostic;
let teardownFailure;

try {
  await run();
} catch (error) {
  failure = error;
  failureDiagnostic = await boundedDiagnostics(error);
}
try {
  await teardown();
} catch (error) {
  teardownFailure = error;
}
if (failure || teardownFailure) {
  const diagnostic = failureDiagnostic ?? await boundedDiagnostics(teardownFailure);
  assertNoPrivateEvidence(diagnostic);
  console.error(JSON.stringify(diagnostic));
  process.exitCode = 1;
} else {
  if (process.env.GSM_RUNTIME_EVIDENCE_DIR) {
    try {
      publishRuntimeEvidence({
        directory: process.env.GSM_RUNTIME_EVIDENCE_DIR,
        filename: 'agent-worker-recovery.schema.json',
        evidence: buildWorkerRecoveryEvidence(),
        validateEvidence: validateWorkerRecoveryEvidence,
        privateMarkers: sensitiveEvidenceMarkers(),
      });
    } catch (error) {
      console.error(JSON.stringify({
        status: 'failed',
        proofScope: 'packaged_worker_recovery',
        code: runtimeEvidenceFailureCode(error),
      }));
      process.exitCode = 1;
    }
  }
  if (process.exitCode !== 1) {
    console.log(JSON.stringify({
      status: 'passed',
      proofScope: 'background_authority',
      scenarios: ['committed_replay', 'statically_read_only_resume', 'state_uncertain_abandonment'],
      providerRequests: provider.capture.length,
      interruptedRequests: provider.interruptions.length,
    }));
  }
}

async function run() {
  scenario.semanticStage = 'setup_manifest';
  if (!existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('A packaged extension manifest is required before the 7B runtime host can start.');
  }
  scenario.semanticStage = 'setup_launch_browser';
  browser = await launchExtensionBrowser({
    dist: DIST,
    userDataDir: profile,
    protocolTimeout: TURN_TIMEOUT_MS,
    failClosedNetwork: true,
  });
  scenario.semanticStage = 'setup_network_isolation';
  await assertFailClosedNetworkIsolation(browser);
  scenario.networkIsolationVerified = true;
  scenario.semanticStage = 'setup_discover_extension';
  const extension = await discoverExtension(browser, { dist: DIST, timeoutMs: SETUP_TIMEOUT_MS });
  scenario.semanticStage = 'setup_create_provider';
  provider = createControlledResponsesProvider({
    providerOrigin: PROVIDER_ORIGIN,
    handler: controlledProviderHandler,
    httpFixtureHandler: repositoryWorkerFixture,
  });
  scenario.semanticStage = 'setup_install_provider';
  providerHandle = await installControlledProvider(extension.target, provider);
  scenario.semanticStage = 'setup_enable_runtime';
  await enableControlledProviderRuntime(provider, providerHandle);
  scenario.semanticStage = 'setup_open_options';
  page = await openExtensionPage(
    browser,
    extension.extensionId,
    OPTIONS_PATH,
    'agent-worker-recovery-options',
    { timeoutMs: SETUP_TIMEOUT_MS, failClosedHttp: pageHttpPolicy },
  );
  scenario.semanticStage = 'setup_hook_page';
  pageDiagnostics = hookPageDiagnostics(page, 'agent-worker-recovery-options', { issues: pageIssues });
  scenario.semanticStage = 'setup_wait_options';
  await waitForOptionsReady(page);
  scenario.semanticStage = 'setup_save_github';
  await saveGitHubToken(page);
  reconcileExpectedNotificationProbeDiagnostic();
  scenario.semanticStage = 'setup_save_provider';
  await saveProvider(page);
  scenario.semanticStage = 'setup_install_port';
  await page.evaluate(installRawProductionPortController);
  scenario.semanticStage = 'setup_seed_repository';
  await page.evaluate(seedRepositoryFixture, { repository: REPOSITORY });

  scenario.semanticStage = 'setup_replacement_controller';
  replacementController = await createServiceWorkerReplacementController({
    browser,
    page,
    extensionId: extension.extensionId,
    timeoutMs: REPLACEMENT_TIMEOUT_MS,
    preinstallStoppedClient() {
      const preinstalled = handoffStoppedControlledProviderClient(provider, providerHandle);
      providerHandle = preinstalled.installedClient;
      return preinstalled;
    },
    async retireReplacementClient(handle) {
      const retired = await retireControlledProviderClient(provider, handle);
      if (retired && providerHandle === handle) providerHandle = null;
      return retired;
    },
    pauseRecoveryWakeups() {
      return page.evaluate(() => globalThis.__workerRecovery.pauseRecoveryWakeups());
    },
    resumeRecoveryWakeups() {
      return page.evaluate(() => globalThis.__workerRecovery.resumeRecoveryWakeups());
    },
  });

  await proveCommittedReplay();
  await proveReadOnlyResume();
  await proveStateUncertainAndAbandonment();
  assert.equal(scenario.runtimeDiagnostics.length, 3);
  scenario.semanticStage = 'containment_provider_health';

  await assertControlledProviderHealthy(provider);
  assert.equal(provider.unexpectedRequests.length, 0);
  assert.equal(provider.failures.length, 0);
  assert.equal(Object.values(provider.overflow).some(Boolean), false);
  assert.equal(pageHttpPolicy.unexpectedRequests.length, 0);
  assert.equal(pageHttpPolicy.overflow, false);
  assert.equal(pageHttpPolicy.interceptionFailure, false);
  assertNoPrivateEvidence({
    captures: provider.capture,
    fixtures: provider.httpFixtureCapture,
    interruptions: provider.interruptions,
    pageIssues,
    replacements: scenario.replacements,
  });
}

async function proveCommittedReplay() {
  scenario.mode = 'precondition';
  scenario.phase = 'precondition-start';
  const countersBefore = snapshotScenarioCounters();
  const created = await rpc(page, { type: 'createAgentSession', sessionId: COMMITTED_SESSION });
  const launch = {
    turnAttemptId: COMMITTED_ATTEMPT,
    sessionId: COMMITTED_SESSION,
    baseRevision: created.session.revision,
    prompt: `Inspect the public files in ${REPOSITORY}.`,
    candidateContract: { kind: 'selected_repository', selectedRepositoryIdHint: REPOSITORY },
  };
  await portStart(page, 'committed', launch);
  scenario.semanticStage = 'committed_wait_terminal';
  const firstTerminal = await portWaitTerminal(page, 'committed', TURN_TIMEOUT_MS);
  assertTerminalAckFacts(firstTerminal, launch, 1);
  scenario.lastTerminal = Object.freeze({
    kind: firstTerminal.error ? 'error' : 'result',
    reason: typeof firstTerminal.result?.reason === 'string' ? firstTerminal.result.reason : null,
    code: typeof firstTerminal.error?.code === 'string' ? firstTerminal.error.code : null,
    commitPresent: firstTerminal.result?.commit != null,
    acknowledgementCount: Number.isSafeInteger(firstTerminal.acknowledgementCount) ? firstTerminal.acknowledgementCount : null,
  });
  scenario.semanticStage = 'committed_assert_terminal';
  assert.equal(firstTerminal.result.reason, 'final_answer');
  assert.equal(firstTerminal.result.commit?.idempotent, false);
  scenario.semanticStage = 'committed_read_authority';
  const before = await page.evaluate(readBoundedAuthority, {
    sessionId: COMMITTED_SESSION,
    attemptId: COMMITTED_ATTEMPT,
    repository: REPOSITORY,
  });
  scenario.lastAuthority = Object.freeze({
    sessionRevision: Number.isSafeInteger(before.session.revision) ? before.session.revision : null,
    attemptState: before.attempt.state,
    receiptPresent: before.attempt.receiptPresent,
    leasePresent: before.attempt.leasePresent,
  });
  scenario.semanticStage = 'committed_assert_authority';
  assert.equal(before.attempt.state, 'committed');
  assert.equal(before.attempt.receiptPresent, true);
  assert.equal(before.attempt.recoveryClass, 'write_capable_or_unknown');
  assertNoRecoveryResidue(before.attempt);
  const providerBefore = provider.capture.length;
  const toolResultsBefore = countToolResults(provider.capture);

  scenario.semanticStage = 'committed_arm_recovery';
  await page.evaluate(armPortRecovery, { id: 'committed', recoveryMode: 'committed' });
  scenario.semanticStage = 'committed_replace_entry';
  const replacement = await replacementController.replace();
  providerHandle = replacement.installedClient;
  scenario.replacements.push(replacement);
  const replay = await portWaitRecovery(page, 'committed', TURN_TIMEOUT_MS);
  assertTerminalAckFacts(replay, launch, 2);
  const after = await page.evaluate(readBoundedAuthority, {
    sessionId: COMMITTED_SESSION,
    attemptId: COMMITTED_ATTEMPT,
    repository: REPOSITORY,
  });
  assert.equal(replay.result.reason, 'final_answer');
  assert.equal(replay.result.commit?.idempotent, true);
  assert.equal(provider.capture.length, providerBefore);
  assert.equal(countToolResults(provider.capture), toolResultsBefore);
  assert.equal(after.session.revision, before.session.revision);
  assert.equal(after.messageCount, before.messageCount);
  assert.equal(after.attempt.receiptDigest, before.attempt.receiptDigest);
  assert.equal(after.manualTagCount, before.manualTagCount);
  assertNoRecoveryResidue(after.attempt);
  assertDistinctEpochEvidence(replay, replacement);
  sampleRuntimeDiagnostics('committed_replay', replacement);
  const authorityDelta = {
    observableRevisionDelta: after.session.revision - created.session.revision,
    observableWriteDelta: after.manualTagCount - before.manualTagCount,
    terminalReceiptCount: after.attempt.receiptPresent ? 1 : 0,
    recoveryRowResidue: after.attempt.recoveryRowCount,
  };
  recordScenarioCounters('committed_replay', countersBefore, authorityDelta);
}

async function proveReadOnlyResume() {
  scenario.mode = 'readonly';
  scenario.phase = 'readonly-start';
  const countersBefore = snapshotScenarioCounters();
  scenario.readonly = { artifactId: null, cursor: null, ref: null, pageCount: 0 };
  const loaded = await rpc(page, { type: 'loadAgentSession', sessionId: COMMITTED_SESSION });
  const launch = {
    turnAttemptId: READONLY_ATTEMPT,
    sessionId: COMMITTED_SESSION,
    baseRevision: loaded.session.revision,
    prompt: `Read the oversized repository file for ${REPOSITORY} completely. ${PROMPT_CANARY}`,
    candidateContract: { kind: 'selected_repository', selectedRepositoryIdHint: REPOSITORY },
  };
  await portStart(page, 'readonly', launch);
  scenario.semanticStage = 'readonly_wait_hold';
  await waitUntil(() => provider.hasHeldResponse('readonly-interrupt'), TURN_TIMEOUT_MS, 'Read-only turn did not reach its persisted cursor interruption.');
  scenario.semanticStage = 'readonly_read_pending';
  const pending = await page.evaluate(readBoundedAuthority, {
    sessionId: COMMITTED_SESSION,
    attemptId: READONLY_ATTEMPT,
    repository: REPOSITORY,
    expectedCursor: scenario.readonly.cursor,
    promptCanary: PROMPT_CANARY,
    transcriptCanary: TRANSCRIPT_CANARY,
    artifactCanary: ARTIFACT_CANARY,
    toolResultCanary: TOOL_RESULT_CANARY,
    sourceCallId: SOURCE_CALL_ID,
    readerCallId: READONLY_READER_CALL_ID,
  });
  scenario.semanticStage = 'readonly_pending_authority';
  scenario.lastAuthority = Object.freeze({
    sessionRevision: pending.session.revision,
    attemptState: pending.attempt.state,
    recoveryClass: pending.attempt.recoveryClass,
    recoveryProjectedReaderAssistantCount: pending.attempt.recoveryProjectedReaderAssistantCount,
    recoveryProjectedReaderToolCount: pending.attempt.recoveryProjectedReaderToolCount,
    continuationPresent: pending.attempt.continuationPresent,
    leasePresent: pending.attempt.leasePresent,
    recoveryRowCount: pending.attempt.recoveryRowCount,
    pendingCoverageCount: pending.attempt.pendingCoverageCount,
    completeCoverageCount: pending.attempt.completeCoverageCount,
    expectedCursorMatches: pending.attempt.expectedCursorMatches,
    boundedProjectionComplete: pending.attempt.boundedProjectionComplete,
    recoveryPromptCanaryPresent: pending.attempt.recoveryPromptCanaryPresent,
    recoveryTranscriptCanaryPresent: pending.attempt.recoveryTranscriptCanaryPresent,
    recoveryCursorPresent: pending.attempt.recoveryCursorPresent,
    canonicalPromptCanaryPresent: pending.attempt.canonicalPromptCanaryPresent,
    canonicalTranscriptCanaryPresent: pending.attempt.canonicalTranscriptCanaryPresent,
    artifactCanaryPresent: pending.attempt.artifactCanaryPresent,
    toolResultCanaryPresent: pending.attempt.toolResultCanaryPresent,
    recoveryProjectedReaderPairCount: pending.attempt.recoveryProjectedReaderPairCount,
    recoveryCanonicalSourcePairCount: pending.attempt.recoveryCanonicalSourcePairCount,
    recoveryCanonicalReaderPairCount: pending.attempt.recoveryCanonicalReaderPairCount,
  });
  scenario.semanticStage = 'readonly_assert_state_continuation';
  assert.equal(pending.attempt.state, 'running');
  assert.equal(pending.attempt.recoveryClass, 'statically_read_only');
  assert.equal(pending.attempt.continuationPresent, true);
  assert.equal(pending.attempt.leasePresent, true);
  assert.equal(typeof scenario.readonly.cursor, 'string');
  assert.equal(pending.attempt.recoveryRowCount, 1);
  scenario.semanticStage = 'readonly_assert_coverage';
  assert.equal(pending.attempt.coverageTotalCount, 1);
  assert.equal(pending.attempt.pendingCoverageCount, 1);
  assert.equal(pending.attempt.completeCoverageCount, 0);
  assert.equal(pending.attempt.expectedCursorMatches, true);
  assert.equal(pending.attempt.expectedBytes > pending.attempt.bytesDelivered, true);
  assert.equal(pending.attempt.bytesDelivered > 0, true);
  scenario.semanticStage = 'readonly_assert_integrity';
  assert.equal(pending.attempt.hasProgressToken, true);
  assert.equal(pending.attempt.hasCursorChainDigest, true);
  assert.equal(pending.attempt.hasArtifactDigest, true);
  assert.equal(pending.attempt.artifactMetadataCount, 1);
  assert.equal(pending.attempt.readyArtifactCount, 1);
  scenario.semanticStage = 'readonly_assert_canaries';
  assert.equal(pending.attempt.recoveryPromptCanaryPresent, true);
  assert.equal(pending.attempt.recoveryTranscriptCanaryPresent, false);
  assert.equal(pending.attempt.recoveryCursorPresent, true);
  assert.equal(pending.attempt.canonicalPromptCanaryPresent, false);
  assert.equal(pending.attempt.canonicalTranscriptCanaryPresent, false);
  assert.equal(pending.attempt.artifactCanaryPresent, true);
  assert.equal(pending.attempt.toolResultCanaryPresent, true);
  scenario.semanticStage = 'readonly_assert_projection';
  assert.equal(pending.attempt.recoveryProjectedMessageCount <= 32, true);
  assert.equal(pending.attempt.recoveryCanonicalMessageCount <= 32, true);
  assert.equal(pending.attempt.boundedProjectionComplete, true);
  assert.equal(pending.attempt.recoveryProjectedReaderPairCount, 1);
  assert.equal(pending.attempt.recoveryCanonicalSourcePairCount, 1);
  assert.equal(pending.attempt.recoveryCanonicalReaderPairCount, 0);
  scenario.durableRecovery.beforeReplacement = Object.freeze({
    recoveryRows: pending.attempt.recoveryRowCount,
    pendingCoverage: pending.attempt.pendingCoverageCount,
    completeCoverage: pending.attempt.completeCoverageCount,
    cursorAuthority: pending.attempt.expectedCursorMatches && pending.attempt.recoveryCursorPresent,
    continuationPresent: pending.attempt.continuationPresent,
    leasePresent: pending.attempt.leasePresent,
    canonicalPromptResidue: pending.attempt.canonicalPromptCanaryPresent,
    recoveryAuthorityPresent: pending.attempt.recoveryPromptCanaryPresent
      && pending.attempt.recoveryCursorPresent
      && pending.attempt.artifactCanaryPresent
      && pending.attempt.toolResultCanaryPresent,
    provisionalTranscriptResidue: pending.attempt.recoveryTranscriptCanaryPresent
      || pending.attempt.canonicalTranscriptCanaryPresent,
  });
  const providerBefore = provider.capture.length;
  const sessionRevisionBefore = pending.session.revision;

  scenario.semanticStage = 'readonly_arm';
  await page.evaluate(armPortRecovery, { id: 'readonly', recoveryMode: 'readonly' });
  scenario.semanticStage = 'readonly_replace_entry';
  const replacement = await replacementController.replace();
  providerHandle = replacement.installedClient;
  scenario.replacements.push(replacement);
  const recovered = await portWaitRecovery(page, 'readonly', TURN_TIMEOUT_MS);
  assertTerminalAckFacts(recovered, launch, 1);
  const terminal = await page.evaluate(readBoundedAuthority, {
    sessionId: COMMITTED_SESSION,
    attemptId: READONLY_ATTEMPT,
    repository: REPOSITORY,
    promptCanary: PROMPT_CANARY,
    transcriptCanary: TRANSCRIPT_CANARY,
    artifactCanary: ARTIFACT_CANARY,
    toolResultCanary: TOOL_RESULT_CANARY,
    sourceCallId: SOURCE_CALL_ID,
    readerCallId: READONLY_READER_CALL_ID,
  });
  assert.equal(recovered.result.reason, 'final_answer');
  assert.equal(recovered.result.commit?.idempotent, false);
  assert.equal(terminal.session.revision, sessionRevisionBefore + 1);
  assert.equal(terminal.attempt.state, 'committed');
  assert.equal(terminal.attempt.receiptPresent, true);
  assert.equal(terminal.attempt.continuationPresent, false);
  assert.equal(terminal.attempt.leasePresent, false);
  assert.equal(scenario.readonly.pageCount >= 2, true);
  assert.equal(provider.capture.length > providerBefore, true);
  assert.equal(terminal.attempt.recoveryRowCount, 0);
  assert.equal(terminal.attempt.pendingCoverageCount, 0);
  assert.equal(terminal.attempt.completeCoverageCount, 1);
  assert.equal(terminal.attempt.artifactMetadataCount, 1);
  assert.equal(terminal.attempt.readyArtifactCount, 1);
  assert.equal(terminal.attempt.artifactCanaryPresent, true);
  assert.equal(terminal.attempt.toolResultCanaryPresent, true);
  assert.equal(terminal.attempt.recoveryTranscriptCanaryPresent, false);
  assert.equal(terminal.attempt.canonicalTranscriptCanaryPresent, false);
  assert.equal(terminal.attempt.canonicalSourceRowCount, 1);
  assert.equal(terminal.attempt.canonicalFinalRowCount, 1);
  assert.equal(terminal.attempt.canonicalSourcePairCount, 1);
  assert.equal(terminal.attempt.boundedProjectionComplete, true);
  scenario.durableRecovery.afterCommit = Object.freeze({
    recoveryRows: terminal.attempt.recoveryRowCount,
    pendingCoverage: terminal.attempt.pendingCoverageCount,
    completeCoverage: terminal.attempt.completeCoverageCount,
    continuationPresent: terminal.attempt.continuationPresent,
    leasePresent: terminal.attempt.leasePresent,
    receiptPresent: terminal.attempt.receiptPresent,
    canonicalSourceRows: terminal.attempt.canonicalSourceRowCount,
    canonicalFinalRows: terminal.attempt.canonicalFinalRowCount,
    canonicalSourcePairs: terminal.attempt.canonicalSourcePairCount,
    provisionalTranscriptResidue: terminal.attempt.recoveryTranscriptCanaryPresent
      || terminal.attempt.canonicalTranscriptCanaryPresent,
  });
  assert.equal(provider.interruptions.filter((entry) => entry.kind === 'readonly-held').length, 1);
  assertDistinctEpochEvidence(recovered, replacement);
  sampleRuntimeDiagnostics('statically_read_only_resume', replacement);
  recordScenarioCounters('statically_read_only_resume', countersBefore, {
    observableRevisionDelta: terminal.session.revision - sessionRevisionBefore,
    observableWriteDelta: terminal.manualTagCount - pending.manualTagCount,
    terminalReceiptCount: terminal.attempt.receiptPresent ? 1 : 0,
    recoveryRowResidue: terminal.attempt.recoveryRowCount,
  });
}
async function proveStateUncertainAndAbandonment() {
  scenario.mode = 'uncertain';
  scenario.phase = 'uncertain-start';
  const countersBefore = snapshotScenarioCounters();
  const created = await rpc(page, { type: 'createAgentSession', sessionId: UNCERTAIN_SESSION });
  const launch = {
    turnAttemptId: UNCERTAIN_ATTEMPT,
    sessionId: UNCERTAIN_SESSION,
    baseRevision: created.session.revision,
    prompt: 'Assign a recovery marker tag.',
    candidateContract: { kind: 'selected_repository', selectedRepositoryIdHint: REPOSITORY },
  };
  await portStart(page, 'uncertain', launch);
  scenario.semanticStage = 'uncertain_wait_hold';
  await waitUntil(() => provider.hasHeldResponse('write-interrupt'), TURN_TIMEOUT_MS, 'Write-capable turn did not reach its interruption hold.');
  scenario.semanticStage = 'uncertain_read_running_authority';
  const before = await page.evaluate(readBoundedAuthority, {
    sessionId: UNCERTAIN_SESSION,
    attemptId: UNCERTAIN_ATTEMPT,
    repository: REPOSITORY,
  });
  scenario.semanticStage = 'uncertain_assert_running_authority';
  assert.equal(before.attempt.state, 'running');
  assert.equal(before.attempt.recoveryClass, 'write_capable_or_unknown');
  const providerBefore = provider.capture.length;
  const toolResultsBefore = countToolResults(provider.capture);
  const tagCountBefore = before.manualTagCount;

  scenario.semanticStage = 'uncertain_arm';
  await page.evaluate(armPortRecovery, { id: 'uncertain', recoveryMode: 'uncertain' });
  scenario.semanticStage = 'uncertain_replace_entry';
  const replacement = await replacementController.replace();
  providerHandle = replacement.installedClient;
  scenario.replacements.push(replacement);
  scenario.semanticStage = 'uncertain_wait_inspection';
  const inspection = await portWaitRecovery(page, 'uncertain', TURN_TIMEOUT_MS);
  scenario.semanticStage = 'uncertain_assert_transport';
  assertNoTerminalAckFacts(inspection);
  assert.equal(inspection.inspectionPresent, false);
  scenario.semanticStage = 'uncertain_read_fenced_authority';
  const uncertain = await page.evaluate(readBoundedAuthority, {
    sessionId: UNCERTAIN_SESSION,
    attemptId: UNCERTAIN_ATTEMPT,
    repository: REPOSITORY,
  });
  scenario.lastAuthority = Object.freeze({
    sessionRevision: uncertain.session.revision,
    attemptState: uncertain.attempt.state,
    terminalReason: uncertain.attempt.terminalReason,
    recoveryClass: uncertain.attempt.recoveryClass,
    writeSettlement: uncertain.attempt.writeSettlement,
    leasePresent: uncertain.attempt.leasePresent,
    receiptPresent: uncertain.attempt.receiptPresent,
    continuationPresent: uncertain.attempt.continuationPresent,
    launchDigestPresent: uncertain.attempt.launchDigestPresent,
  });
  scenario.semanticStage = 'uncertain_assert_fenced_authority';
  assert.equal(uncertain.attempt.state, 'state_uncertain');
  assert.equal(uncertain.attempt.terminalReason, 'attempt_state_lost');
  assert.equal(uncertain.attempt.recoveryClass, 'write_capable_or_unknown');
  assert.equal(uncertain.attempt.writeSettlement, 'unsafe');
  assert.equal(uncertain.attempt.leasePresent, false);
  assert.equal(uncertain.attempt.receiptPresent, false);
  assert.equal(uncertain.attempt.receiptDigest, null);
  assert.equal(uncertain.attempt.continuationPresent, false);
  assert.equal(uncertain.attempt.launchDigestPresent, true);
  assert.equal(uncertain.attempt.recoveryRowCount, 0);
  assert.equal(uncertain.attempt.coverageTotalCount, 0);
  assert.equal(uncertain.attempt.pendingCoverageCount, 0);
  assert.equal(uncertain.attempt.completeCoverageCount, 0);
  assert.equal(uncertain.attempt.artifactMetadataCount, 0);
  assert.equal(uncertain.attempt.boundedProjectionComplete, true);
  assert.equal(provider.capture.length, providerBefore);
  assert.equal(countToolResults(provider.capture), toolResultsBefore);
  assert.equal(uncertain.manualTagCount, tagCountBefore);
  scenario.durableRecovery.stateUncertain = Object.freeze({
    state: uncertain.attempt.state,
    terminalReason: uncertain.attempt.terminalReason,
    writeSettlement: uncertain.attempt.writeSettlement,
    automaticProviderRequests: provider.capture.length - providerBefore,
    automaticToolResults: countToolResults(provider.capture) - toolResultsBefore,
    writeDelta: uncertain.manualTagCount - tagCountBefore,
    receiptCount: uncertain.attempt.receiptPresent ? 1 : 0,
    recoveryRows: uncertain.attempt.recoveryRowCount,
    continuationPresent: uncertain.attempt.continuationPresent,
    leasePresent: uncertain.attempt.leasePresent,
  });
  assertDistinctEpochEvidence(inspection, replacement);

  scenario.semanticStage = 'uncertain_abandon';
  assert.equal(await rpc(page, {
    type: 'abandonAgentSessionUncertainAttempt',
    sessionId: UNCERTAIN_SESSION,
    turnAttemptId: UNCERTAIN_ATTEMPT,
  }), true);
  const abandoned = await page.evaluate(readBoundedAuthority, {
    sessionId: UNCERTAIN_SESSION,
    attemptId: UNCERTAIN_ATTEMPT,
    repository: REPOSITORY,
  });
  assert.equal(abandoned.attempt.state, 'terminal_non_retryable');
  assert.equal(abandoned.attempt.terminalReason, 'abandoned');
  assert.equal(abandoned.attempt.writeSettlement, 'unsafe');
  assert.equal(abandoned.attempt.receiptPresent, false);
  assert.equal(abandoned.attempt.leasePresent, false);
  assert.equal(abandoned.attempt.launchDigestPresent, true);
  assert.equal(abandoned.attempt.continuationPresent, false);
  assert.equal(abandoned.attempt.recoveryRowCount, 0);
  assert.equal(abandoned.attempt.coverageTotalCount, 0);
  assert.equal(abandoned.attempt.pendingCoverageCount, 0);
  assert.equal(abandoned.attempt.completeCoverageCount, 0);
  assert.equal(abandoned.attempt.artifactMetadataCount, 0);
  assert.equal(abandoned.attempt.boundedProjectionComplete, true);

  scenario.mode = 'fresh';
  scenario.phase = 'fresh-start';
  const freshLaunch = { ...launch, turnAttemptId: FRESH_ATTEMPT, prompt: 'Confirm a fresh turn can start after abandonment.' };
  scenario.semanticStage = 'fresh_start';
  await portStart(page, 'fresh', freshLaunch);
  scenario.semanticStage = 'fresh_wait_terminal';
  const fresh = await portWaitTerminal(page, 'fresh', TURN_TIMEOUT_MS);
  scenario.semanticStage = 'fresh_assert_terminal_ack';
  assertTerminalAckFacts(fresh, freshLaunch, 1);
  assert.equal(fresh.result.reason, 'final_answer');
  assert.equal(fresh.result.commit?.idempotent, false);
  scenario.semanticStage = 'fresh_read_authority';
  const freshAuthority = await page.evaluate(readBoundedAuthority, {
    sessionId: UNCERTAIN_SESSION,
    attemptId: FRESH_ATTEMPT,
    repository: REPOSITORY,
  });
  scenario.lastAuthority = Object.freeze({
    sessionRevision: freshAuthority.session.revision,
    attemptState: freshAuthority.attempt.state,
    terminalReason: freshAuthority.attempt.terminalReason,
    recoveryClass: freshAuthority.attempt.recoveryClass,
    writeSettlement: freshAuthority.attempt.writeSettlement,
    leasePresent: freshAuthority.attempt.leasePresent,
    receiptPresent: freshAuthority.attempt.receiptPresent,
    continuationPresent: freshAuthority.attempt.continuationPresent,
    launchDigestPresent: freshAuthority.attempt.launchDigestPresent,
  });
  scenario.semanticStage = 'fresh_assert_authority';
  assert.equal(freshAuthority.attempt.state, 'committed');
  assert.equal(freshAuthority.session.revision, 1);
  scenario.durableRecovery.afterAbandonment = Object.freeze({
    state: abandoned.attempt.state,
    terminalReason: abandoned.attempt.terminalReason,
    writeSettlement: abandoned.attempt.writeSettlement,
    receiptCount: abandoned.attempt.receiptPresent ? 1 : 0,
    recoveryRows: abandoned.attempt.recoveryRowCount,
    continuationPresent: abandoned.attempt.continuationPresent,
    leasePresent: abandoned.attempt.leasePresent,
    freshTurnState: freshAuthority.attempt.state,
    freshRevisionDelta: freshAuthority.session.revision - created.session.revision,
    freshReceiptCount: freshAuthority.attempt.receiptPresent ? 1 : 0,
  });
  sampleRuntimeDiagnostics('state_uncertain_abandonment', replacement);
  recordScenarioCounters('state_uncertain_abandonment', countersBefore, {
    observableRevisionDelta: freshAuthority.session.revision - created.session.revision,
    observableWriteDelta: freshAuthority.manualTagCount - tagCountBefore,
    terminalReceiptCount: (uncertain.attempt.receiptPresent ? 1 : 0) + (freshAuthority.attempt.receiptPresent ? 1 : 0),
    recoveryRowResidue: uncertain.attempt.recoveryRowCount + freshAuthority.attempt.recoveryRowCount,
  });
}

async function controlledProviderHandler(request) {
  assert.equal(request.protocol, 'responses');
  const observedResultId = request.latestToolResult?.callId;
  if (typeof observedResultId === 'string') scenario.operations.observedToolResultIds.add(observedResultId);
  scenario.lastProviderRequest = Object.freeze({
    offeredToolCount: request.offeredToolNames.length,
    assignRepoTagsOffered: request.offeredToolNames.includes('assign_repo_tags'),
    latestToolCallName: request.latestToolCall?.name ?? null,
    latestToolResultName: request.latestToolResult?.name ?? null,
    latestToolResultStatus: request.latestToolResult?.status ?? null,
    latestToolResultHasArtifact: typeof request.latestToolResult?.artifactId === 'string',
    latestToolResultHasCursor: typeof request.latestToolResult?.nextCursor === 'string',
  });
  if (request.toolName === 'bgsm_connection_probe') {
    return toolCall('worker-probe', 'bgsm_connection_probe', { nonce: 'bgsm' }, 'connection-probe');
  }
  if (request.latestToolResult?.name === 'bgsm_connection_probe') {
    return textCompletion('runtime provider ready', 'connection-probe-complete');
  }
  if (request.offeredToolNames.length === 0) {
    return textCompletion('Continue the exact pending operation.', 'ordinary-context-summary');
  }
  if (scenario.mode === 'precondition') return handlePrecondition(request);
  if (scenario.mode === 'readonly') return handleReadOnly(request);
  if (scenario.mode === 'uncertain') {
    assert.equal(scenario.phase, 'uncertain-start');
    assert.equal(request.offeredToolNames.includes('assign_repo_tags'), true);
    scenario.phase = 'uncertain-held';
    return {
      ...toolCall('write-interrupted-call', 'assign_repo_tags', {
        full_name: REPOSITORY,
        tags: ['runtime-worker-recovery'],
      }, 'write-held'),
      hold: 'write-interrupt',
    };
  }
  if (scenario.mode === 'fresh') {
    scenario.phase = 'fresh-final';
    return textCompletion('Fresh admission succeeded.', 'fresh-final');
  }
  throw new Error('Controlled Provider received a request outside an active scenario.');
}

function handlePrecondition(request) {
  if (scenario.phase === 'precondition-start') {
    assert.equal(request.offeredToolNames.includes('list_repository_files'), true);
    scenario.phase = 'precondition-result';
    return toolCall('repository-list-call', 'list_repository_files', {
      repository: REPOSITORY,
    }, 'repository-list');
  }
  assert.equal(scenario.phase, 'precondition-result');
  assert.equal(request.latestToolResult?.name, 'list_repository_files');
  assert.equal(request.latestToolResult?.status, 'complete');
  scenario.phase = 'precondition-final';
  return textCompletion('Repository files inspected.', 'precondition-final');
}

function handleReadOnly(request) {
  const state = scenario.readonly;
  if (scenario.phase === 'readonly-start') {
    assert.equal(request.offeredToolNames.includes('list_repository_files'), true);
    scenario.phase = 'readonly-source';
    return toolCall('readonly-list-call', 'list_repository_files', { repository: REPOSITORY }, 'readonly-list');
  }
  if (scenario.phase === 'readonly-source') {
    assert.equal(request.latestToolResult?.name, 'list_repository_files');
    assert.equal(request.latestToolResult?.status, 'complete');
    state.ref = 'a'.repeat(40);
    scenario.phase = 'readonly-file';
    return toolCall(SOURCE_CALL_ID, 'read_repository_file', {
      repository: REPOSITORY,
      path: 'README.md',
      ref: state.ref,
    }, 'readonly-file', {
      input_tokens: 27_009,
      output_tokens: 10,
      total_tokens: 27_019,
    });
  }
  if (scenario.phase === 'readonly-file') {
    assert.equal(request.latestToolResult?.name, 'read_repository_file');
    assert.equal(request.latestToolResult?.status, 'artifact_available');
    assert.equal(typeof request.latestToolResult?.artifactId, 'string');
    state.artifactId = request.latestToolResult.artifactId;
    scenario.phase = 'readonly-first-page';
    return toolCall(READONLY_READER_CALL_ID, 'read_agent_artifact', { artifactId: state.artifactId }, 'readonly-page');
  }
  if (scenario.phase === 'readonly-first-page') {
    assert.equal(request.latestToolResult?.name, 'read_agent_artifact');
    assert.equal(typeof request.latestToolResult?.nextCursor, 'string');
    state.cursor = request.latestToolResult.nextCursor;
    state.pageCount += 1;
    scenario.phase = 'readonly-resume';
    return { ...textCompletion(`held before replacement ${TRANSCRIPT_CANARY}`, 'readonly-held'), hold: 'readonly-interrupt' };
  }
  if (scenario.phase === 'readonly-resume') {
    assert.equal(typeof state.cursor, 'string');
    scenario.phase = 'readonly-page-result';
    return toolCall(`readonly-reader-${state.pageCount}`, 'read_agent_artifact', {
      artifactId: state.artifactId,
      cursor: state.cursor,
    }, 'readonly-resumed-page');
  }
  if (scenario.phase === 'readonly-page-result') {
    assert.equal(request.latestToolCall?.name, 'read_agent_artifact');
    assert.equal(request.latestToolCall?.arguments?.cursor, state.cursor);
    assert.equal(request.latestToolResult?.name, 'read_agent_artifact');
    state.cursor = request.latestToolResult.nextCursor;
    state.pageCount += 1;
    if (state.cursor === null) {
      scenario.phase = 'readonly-final';
      return textCompletion('Read-only cursor recovery completed.', 'readonly-final');
    }
    return toolCall(`readonly-reader-${state.pageCount}`, 'read_agent_artifact', {
      artifactId: state.artifactId,
      cursor: state.cursor,
    }, 'readonly-resumed-page');
  }
  throw new Error('Controlled Provider reached an invalid read-only phase.');
}

function repositoryWorkerFixture({ route, method }) {
  const json = (body, kind) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body), kind });
  if (method !== 'GET') return null;
  if (route === 'github-starred') return json([], 'github-token-stars');
  if (route === 'github-repository') {
    return json({
      full_name: REPOSITORY,
      private: false,
      archived: false,
      visibility: 'public',
      default_branch: 'main',
    }, 'repository-metadata');
  }
  if (route === 'github-contents-file') {
    const content = `${ARTIFACT_CANARY}:${TOOL_RESULT_CANARY}:`.padEnd(200 * 1024, 'r');
    return json({
      type: 'file',
      path: 'README.md',
      sha: 'b'.repeat(40),
      encoding: 'base64',
      size: Buffer.byteLength(content),
      content: Buffer.from(content).toString('base64'),
    }, 'repository-file');
  }
  if (route === 'github-branch-ref') {
    return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'a'.repeat(40) } }, 'repository-branch-ref');
  }
  if (route === 'github-contents') {
    return json([{ name: 'README.md', path: 'README.md', type: 'file', size: 12, sha: 'b'.repeat(40) }], 'repository-contents');
  }
  return null;
}

function optionsGithubFixture({ route, method }) {
  const json = (body, kind, status = 200, headers = {}) => ({
    status, contentType: 'application/json', headers, body: JSON.stringify(body), kind,
  });
  const routes = {
    'GET github-user': json({ login: 'runtime-user', avatar_url: null, name: 'Runtime User' }, 'github-user', 200, { 'x-oauth-scopes': 'public_repo, gist' }),
    'GET github-starred': json([], 'github-starred'),
    'GET github-watch-scope': json([], 'github-watch-scope'),
    'GET github-notifications': json(
      { message: 'Resource not accessible by personal access token' },
      'github-notifications-forbidden',
      403,
    ),
    'POST github-gists': json({ id: 'runtime-probe-gist' }, 'github-gist-create', 201),
    'DELETE github-probe-gist': { status: 204, contentType: 'application/json', body: '', kind: 'github-gist-delete' },
  };
  return routes[`${method} ${route}`] ?? null;
}
function reconcileExpectedNotificationProbeDiagnostic() {
  assert.equal(pageHttpPolicy.expectedRequests.some((request) => (
    request.method === 'GET'
    && request.route === 'github-notifications'
    && request.status === 403
  )), true);
  const consoleIndex = pageIssues.findIndex((issue) => issue.kind === 'console-error');
  assert.notEqual(consoleIndex, -1);
  pageIssues.splice(consoleIndex, 1);
}
async function acceptAgentDataDisclosure(targetPage, expectedProvider, expectedOrigin) {
  await clickTextTrusted(targetPage, /^Accept data sharing$/i);
  await waitUntil(
    () => targetPage.evaluate(async ({ provider, origin }) => {
      const config = (await chrome.storage.local.get('gsm_config')).gsm_config;
      return config?.agentDataDisclosureAcceptance?.version === 2
        && config.agentDataDisclosureAcceptance.provider === provider
        && config.agentDataDisclosureAcceptance.origin === origin;
    }, { provider: expectedProvider, origin: expectedOrigin }),
    SETUP_TIMEOUT_MS,
    'Agent data disclosure acceptance was not persisted.',
  );
}



function toolCall(id, name, argumentsValue, kind, usage = undefined) {
  scenario.operations.scriptedToolCalls += 1;
  return { kind, completion: { toolCall: { id, name, arguments: JSON.stringify(argumentsValue) }, ...(usage ? { usage } : {}) } };
}

function textCompletion(content, kind, usage = undefined) {
  return { kind, completion: { content, ...(usage ? { usage } : {}) } };
}

function createScenarioState() {
  return {
    mode: 'setup',
    phase: 'setup',
    readonly: null,
    replacements: [],
    productEpochs: [],
    runtimeDiagnostics: [],
    counters: [],
    durableRecovery: {
      beforeReplacement: null,
      afterCommit: null,
      stateUncertain: null,
      afterAbandonment: null,
    },
    networkIsolationVerified: false,
    cleanup: {
      networkGatesClosed: false,
      diagnosticsDetached: false,
      pagesClosed: false,
      browserClosed: false,
      temporaryStateRemoved: false,
    },
    lastProviderRequest: null,
    semanticStage: 'setup',
    lastTerminal: null,
    lastAuthority: null,
    operations: {
      scriptedToolCalls: 0,
      observedToolResultIds: new Set(),
    },
  };
}

function countToolResults(captures) {
  return captures.filter((entry) => entry.latestToolResult !== null).length;
}

function snapshotScenarioCounters() {
  return {
    providerRequests: provider.capture.length,
    scriptedToolCalls: scenario.operations.scriptedToolCalls,
    scriptedToolResults: scenario.operations.observedToolResultIds.size,
    interruptions: provider.interruptions.length,
    replacements: scenario.replacements.length,
  };
}

function recordScenarioCounters(name, before, authority) {
  const after = snapshotScenarioCounters();
  scenario.counters.push(Object.freeze({
    name,
    providerRequests: after.providerRequests - before.providerRequests,
    scriptedToolCalls: after.scriptedToolCalls - before.scriptedToolCalls,
    scriptedToolResults: after.scriptedToolResults - before.scriptedToolResults,
    interruptions: after.interruptions - before.interruptions,
    replacements: after.replacements - before.replacements,
    observableRevisionDelta: authority.observableRevisionDelta,
    observableWriteDelta: authority.observableWriteDelta,
    terminalReceiptCount: authority.terminalReceiptCount,
    recoveryRowResidue: authority.recoveryRowResidue,
  }));
}
function sampleRuntimeDiagnostics(name, replacement) {
  assert.equal(typeof replacement.getRuntimeDiagnostics, 'function');
  const diagnostics = replacement.getRuntimeDiagnostics();
  assert.equal(Number.isSafeInteger(diagnostics.count), true);
  assert.equal(diagnostics.count >= 0 && diagnostics.count <= 16, true);
  assert.equal(typeof diagnostics.overflow, 'boolean');
  assert.equal(diagnostics.count, 0);
  assert.equal(diagnostics.overflow, false);
  scenario.runtimeDiagnostics.push(Object.freeze({
    scenario: name,
    count: diagnostics.count,
    overflow: diagnostics.overflow,
  }));
}
function assertNoRecoveryResidue(attempt) {
  assert.equal(attempt.leasePresent, false);
  assert.equal(attempt.continuationPresent, false);
  assert.equal(attempt.recoveryRowCount, 0);
  assert.equal(attempt.coverageTotalCount, 0);
  assert.equal(attempt.pendingCoverageCount, 0);
  assert.equal(attempt.completeCoverageCount, 0);
  assert.equal(attempt.artifactMetadataCount, 0);
}



function assertTerminalAckFacts(value, launch, acknowledgementCount) {
  assert.equal(value.terminalDeliverySeen, true);
  assert.equal(value.ackRequestPosted, true);
  assert.equal(value.ackConfirmationSeen, true);
  assert.equal(value.terminalEpochMatches, true);
  assert.equal(value.activePortIdentity, true);
  assert.equal(value.acknowledgementCount, acknowledgementCount);
  const appliedRevision = value.result?.commit?.appliedRevision ?? null;
  assert.deepEqual(value.ackRequest, {
    type: 'ackBgsmAgentTurnResult',
    executionEpochId: value.epochs.at(-1),
    turnAttemptId: launch.turnAttemptId,
    sessionId: launch.sessionId,
    baseRevision: launch.baseRevision,
    disposition: appliedRevision === null ? 'no_transition' : 'applied',
    appliedRevision,
  });
}

function assertNoTerminalAckFacts(value) {
  assert.equal(value.result, null);
  assert.equal(value.error, null);
  assert.equal(value.terminalDeliverySeen, false);
  assert.equal(value.ackRequestPosted, false);
  assert.equal(value.ackRequest, null);
  assert.equal(value.ackConfirmationSeen, false);
  assert.equal(value.acknowledgementCount, 0);
}

function assertDistinctEpochEvidence(result, replacement) {
  const epochs = [...new Set(result.epochs)];
  assert.equal(epochs.length >= 2, true);
  assert.notEqual(epochs[0], epochs.at(-1));
  if (replacement.lifecycle.mode === 'stopped_target_preinstalled') {
    assert.equal(replacement.stopped.attachmentId, replacement.replacement.attachmentId);
    assert.equal(replacement.stopped.targetId, replacement.replacement.targetId);
    assert.equal(replacement.stopped.versionId, replacement.replacement.versionId);
  } else {
    assert.notEqual(replacement.stopped.attachmentId, replacement.replacement.attachmentId);
  }
  assert.equal(replacement.stopped.route, replacement.replacement.route);
  scenario.productEpochs.push(Object.freeze({ oldEpochId: epochs[0], newEpochId: epochs.at(-1) }));
}

async function portStart(targetPage, id, launch) {
  await targetPage.evaluate(({ turnId, turnLaunch }) => globalThis.__workerRecovery.start(turnId, turnLaunch), {
    turnId: id,
    turnLaunch: launch,
  });
}

async function portWaitTerminal(targetPage, id, timeoutMs) {
  return targetPage.evaluate(({ turnId, timeout }) => globalThis.__workerRecovery.waitTerminal(turnId, timeout), {
    turnId: id,
    timeout: timeoutMs,
  });
}

async function portWaitRecovery(targetPage, id, timeoutMs) {
  return targetPage.evaluate(({ turnId, timeout }) => globalThis.__workerRecovery.waitRecovery(turnId, timeout), {
    turnId: id,
    timeout: timeoutMs,
  });
}

function armPortRecovery({ id, recoveryMode }) {
  return globalThis.__workerRecovery.arm(id, recoveryMode);
}

function installRawProductionPortController() {
  if (globalThis.__workerRecovery) return;
  const turns = new Map();
  const lifelines = new Set();
  let recoveryWakeupsPaused = false;
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const safeTerminal = (state) => ({
    result: state.result,
    error: state.error,
    epochs: [...state.epochs],
    acknowledgementCount: state.acknowledgementCount,
    terminalDeliverySeen: state.terminalDeliverySeen,
    ackRequestPosted: state.ackRequestPosted,
    ackRequest: state.ackRequest,
    ackConfirmationSeen: state.ackConfirmationSeen,
    disconnectSeen: state.disconnectSeen,
    terminalEpochMatches: state.terminalEpochMatches,
    activePortIdentity: state.activePortIdentity,
    inspectionPresent: state.inspectionPresent,
  });
  const withTimeout = (promise, timeout) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Production Port controller timed out.')), timeout); }),
    ]).finally(() => clearTimeout(timer));
  };
  const scheduleRecovery = (state) => {
    if (
      !state.recoveryMode
      || !state.recoveryPending
      || state.recoveryStarted
      || recoveryWakeupsPaused
    ) return;
    state.recoveryPending = false;
    state.recoveryStarted = true;
    queueMicrotask(() => recover(state));
  };
  const sameDeliveryIdentity = (payload, launch) => payload?.turnAttemptId === launch.turnAttemptId
    && payload?.sessionId === launch.sessionId
    && payload?.baseRevision === launch.baseRevision;
  const rejectProtocol = (state, message) => {
    const error = new Error(message);
    state.terminal.reject(error);
    state.recovery.reject(error);
  };
  const sendRpc = async (request) => {
    let lastError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage(request);
        if (!response?.ok) throw new Error('Production Agent RPC failed.');
        return response.data;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError;
  };
  const connect = (state, { start, resumeOnly = false } = {}) => {
    const port = chrome.runtime.connect({ name: 'bgsm-agent' });
    state.port = port;
    let epoch = null;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    port.onMessage.addListener((message) => {
      if (state.port !== port || !message || typeof message !== 'object') return;
      if (message.type === 'bgsmAgentTurnHello') {
        epoch = message.executionEpochId;
        if (!state.epochs.includes(epoch)) state.epochs.push(epoch);
        resolveReady();
        if (start) port.postMessage({ type: 'startBgsmAgentTurn', executionEpochId: epoch, ...state.launch, ...(resumeOnly ? { resumeOnly: true } : {}) });
        return;
      }
      if (message.type === 'bgsmAgentTurnEvent') return;
      if (message.type === 'bgsmAgentTurnResult' || message.type === 'bgsmAgentTurnError') {
        const terminalPayload = message.type === 'bgsmAgentTurnResult' ? message.result : message.error;
        if (!sameDeliveryIdentity(terminalPayload, state.launch) || state.epochs.at(-1) !== epoch) {
          rejectProtocol(state, 'Production Port terminal identity mismatch.');
          return;
        }
        state.terminalDeliverySeen = true;
        state.terminalEpochMatches = true;
        state.activePortIdentity = state.port === port;
        state.result = message.type === 'bgsmAgentTurnResult' ? message.result : null;
        state.error = message.type === 'bgsmAgentTurnError' ? message.error : null;
        const appliedRevision = state.result?.commit?.appliedRevision ?? null;
        const ackRequest = Object.freeze({
          type: 'ackBgsmAgentTurnResult',
          executionEpochId: epoch,
          turnAttemptId: state.launch.turnAttemptId,
          sessionId: state.launch.sessionId,
          baseRevision: state.launch.baseRevision,
          disposition: appliedRevision === null ? 'no_transition' : 'applied',
          appliedRevision,
        });
        state.ackRequest = ackRequest;
        state.ackRequestPosted = true;
        port.postMessage(ackRequest);
        return;
      }
      if (message.type === 'bgsmAgentTurnAck') {
        const ackRequest = state.ackRequest;
        if (
          !ackRequest
          || !sameDeliveryIdentity(message, state.launch)
          || message.disposition !== ackRequest.disposition
          || message.appliedRevision !== ackRequest.appliedRevision
          || state.epochs.at(-1) !== epoch
        ) {
          rejectProtocol(state, 'Production Port acknowledgement identity mismatch.');
          return;
        }
        state.ackConfirmationSeen = true;
        state.activePortIdentity = state.port === port;
        state.acknowledgementCount += 1;
        lifelines.add(port);
        state.terminal.resolve(safeTerminal(state));
        if (state.recoveryStarted) state.recovery.resolve(safeTerminal(state));
      }
    });
    port.onDisconnect.addListener(() => {
      state.disconnectSeen = true;
      state.activePortIdentity = state.port === port;
      lifelines.delete(port);
      if (state.port === port) state.port = null;
      if (state.recoveryMode && !state.recoveryStarted) {
        state.recoveryPending = true;
        scheduleRecovery(state);
      }
    });
    return ready;
  };
  const recover = async (state) => {
    try {
      const wakeReady = connect(state, { start: false });
      const inspectionRequest = sendRpc({
        type: 'inspectActiveAgentSessionTurn',
        sessionId: state.launch.sessionId,
      });
      await wakeReady;
      const wakePort = state.port;
      const inspected = await inspectionRequest;
      state.inspectionPresent = inspected !== null;
      if (state.port === wakePort) state.port = null;
      try { wakePort?.disconnect(); } catch {}
      if (state.recoveryMode === 'uncertain') {
        state.recovery.resolve(safeTerminal(state));
        return;
      }
      if (state.recoveryMode === 'readonly' && !inspected) throw new Error('Read-only recovery inspection returned no authority.');
      await connect(state, { start: true, resumeOnly: state.recoveryMode === 'readonly' });
    } catch (error) {
      state.recovery.reject(error);
    }
  };
  globalThis.__workerRecovery = {
    pauseRecoveryWakeups() {
      recoveryWakeupsPaused = true;
    },
    resumeRecoveryWakeups() {
      recoveryWakeupsPaused = false;
      for (const state of turns.values()) scheduleRecovery(state);
    },
    start(id, launch) {
      if (turns.has(id)) throw new Error('Duplicate production Port turn ID.');
      const state = {
        launch,
        port: null,
        result: null,
        error: null,
        epochs: [],
        acknowledgementCount: 0,
        terminalDeliverySeen: false,
        ackRequestPosted: false,
        ackRequest: null,
        ackConfirmationSeen: false,
        disconnectSeen: false,
        terminalEpochMatches: false,
        activePortIdentity: false,
        inspectionPresent: false,
        recoveryMode: null,
        recoveryStarted: false,
        recoveryPending: false,
        terminal: deferred(),
        recovery: deferred(),
      };
      turns.set(id, state);
      connect(state, { start: true });
    },
    arm(id, recoveryMode) {
      const state = turns.get(id);
      if (!state) throw new Error('Unknown production Port turn.');
      state.recoveryMode = recoveryMode;
      return state.port ? Promise.resolve() : connect(state, { start: false });
    },
    waitTerminal(id, timeout) {
      const state = turns.get(id);
      if (!state) throw new Error('Unknown production Port turn.');
      return withTimeout(state.terminal.promise, timeout);
    },
    waitRecovery(id, timeout) {
      const state = turns.get(id);
      if (!state) throw new Error('Unknown production Port turn.');
      return withTimeout(state.recovery.promise, timeout);
    },
    diagnostics() {
      return [...turns.entries()].map(([id, state]) => ({
        id,
        epochCount: state.epochs.length,
        recoveryMode: state.recoveryMode,
        recoveryStarted: state.recoveryStarted,
        recoveryPending: state.recoveryPending,
        portPresent: state.port !== null,
        terminalDeliverySeen: state.terminalDeliverySeen,
        ackRequestPosted: state.ackRequestPosted,
        ackConfirmationSeen: state.ackConfirmationSeen,
        disconnectSeen: state.disconnectSeen,
        terminalEpochMatches: state.terminalEpochMatches,
        activePortIdentity: state.activePortIdentity,
      }));
    },
    close() {
      for (const port of lifelines) {
        try { port.disconnect(); } catch {}
      }
      lifelines.clear();
    },
  };
}

async function readBoundedAuthority({
  sessionId,
  attemptId,
  repository,
  expectedCursor = null,
  promptCanary = null,
  transcriptCanary = null,
  artifactCanary = null,
  toolResultCanary = null,
  sourceCallId = null,
  readerCallId = null,
}) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const stores = ['agentSessions', 'agentAttempts', 'agentAttemptRecoveries', 'agentMessages', 'agentArtifacts', 'tags'];
    const tx = db.transaction(stores, 'readonly');
    const result = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const boundedIndexRows = (index, key, limit) => new Promise((resolve, reject) => {
      const rows = [];
      const request = index.openCursor(IDBKeyRange.only(key));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= limit) {
          resolve(rows);
          return;
        }
        rows.push(cursor.value);
        cursor.continue();
      };
    });
    const attemptKey = [sessionId, attemptId];
    const attemptIndex = tx.objectStore('agentAttempts').index('[sessionId+turnAttemptId]');
    const recoveryIndex = tx.objectStore('agentAttemptRecoveries').index('[sessionId+turnAttemptId]');
    const messageIndex = tx.objectStore('agentMessages').index('[sessionId+turnAttemptId]');
    const artifactIndex = tx.objectStore('agentArtifacts').index('turnAttemptId');
    const [session, attempt, recovery, recoveryCount, canonicalMessageCount, canonicalMessages, artifactCount, artifacts, tags] = await Promise.all([
      result(tx.objectStore('agentSessions').get(sessionId)),
      result(attemptIndex.get(attemptKey)),
      result(recoveryIndex.get(attemptKey)),
      result(recoveryIndex.count(attemptKey)),
      result(messageIndex.count(attemptKey)),
      boundedIndexRows(messageIndex, attemptKey, 16),
      result(artifactIndex.count(attemptId)),
      boundedIndexRows(artifactIndex, attemptId, 2),
      result(tx.objectStore('tags').get(repository)),
    ]);
    if (!session || !attempt) throw new Error('Expected durable Agent authority row is missing.');
    const scopedArtifacts = artifacts.filter((row) => row.sessionId === sessionId && row.turnAttemptId === attemptId);
    const coverage = Array.isArray(attempt.artifactCoverage) ? attempt.artifactCoverage : [];
    const pendingCoverage = coverage.filter((row) => row.state === 'pending');
    const hasDigest = (value) => typeof value === 'string' && value.length >= 16 && value.length <= 256;
    const projectedMessages = Array.isArray(recovery?.projectedMessages) ? recovery.projectedMessages : [];
    const recoveryCanonicalMessages = Array.isArray(recovery?.canonicalRawMessages) ? recovery.canonicalRawMessages : [];
    const countToolPairSides = (messages, callId) => {
      if (callId === null) return Object.freeze({ assistantCount: 0, toolCount: 0, pairCount: 0 });
      const assistantCount = messages.filter((row) => row?.role === 'agent'
        && Array.isArray(row.toolCalls)
        && row.toolCalls.some((call) => call?.id === callId)).length;
      const toolCount = messages.filter((row) => row?.role === 'tool' && row.toolCallId === callId).length;
      return Object.freeze({ assistantCount, toolCount, pairCount: assistantCount === toolCount ? assistantCount : -1 });
    };
    const projectedReader = countToolPairSides(projectedMessages, readerCallId);
    const canonicalSource = countToolPairSides(recoveryCanonicalMessages, sourceCallId);
    const canonicalReader = countToolPairSides(recoveryCanonicalMessages, readerCallId);
    const committedCanonicalSource = countToolPairSides(canonicalMessages, sourceCallId);
    const recoveryText = recovery ? JSON.stringify(recovery) : '';
    const canonicalText = JSON.stringify(canonicalMessages);
    const artifactMetadataText = JSON.stringify(scopedArtifacts);
    return {
      session: { revision: session.revision },
      messageCount: canonicalMessageCount,
      manualTagCount: Array.isArray(tags?.manualTags) ? tags.manualTags.length : 0,
      attempt: {
        state: attempt.state,
        terminalReason: attempt.terminalReason,
        recoveryClass: attempt.recoveryClass,
        writeSettlement: attempt.writeSettlement,
        leasePresent: attempt.lease !== null,
        receiptPresent: attempt.receipt !== null,
        receiptDigest: attempt.receipt?.digest ?? null,
        continuationPresent: attempt.artifactContinuationControl !== null,
        launchDigestPresent: typeof attempt.admittedLaunchDigest === 'string',
        recoveryRowCount: recoveryCount,
        coverageTotalCount: coverage.length,
        pendingCoverageCount: pendingCoverage.length,
        completeCoverageCount: coverage.filter((row) => row.state === 'complete').length,
        expectedCursorMatches: pendingCoverage.length === 1 && expectedCursor !== null
          ? pendingCoverage[0].expectedCursor === expectedCursor
          : null,
        expectedBytes: pendingCoverage.length === 1 && Number.isSafeInteger(pendingCoverage[0].expectedBytes)
          ? pendingCoverage[0].expectedBytes
          : null,
        bytesDelivered: pendingCoverage.length === 1 && Number.isSafeInteger(pendingCoverage[0].bytesDelivered)
          ? pendingCoverage[0].bytesDelivered
          : null,
        hasProgressToken: pendingCoverage.length === 1 && hasDigest(pendingCoverage[0].progressToken),
        hasCursorChainDigest: pendingCoverage.length === 1 && hasDigest(pendingCoverage[0].cursorChainDigest),
        hasArtifactDigest: pendingCoverage.length === 1 && hasDigest(pendingCoverage[0].artifactSha256),
        artifactMetadataCount: artifactCount,
        readyArtifactCount: scopedArtifacts.filter((row) => row.state === 'ready').length,
        recoveryPromptCanaryPresent: promptCanary !== null && recoveryText.includes(promptCanary),
        recoveryTranscriptCanaryPresent: transcriptCanary !== null && recoveryText.includes(transcriptCanary),
        recoveryCursorPresent: expectedCursor !== null && recoveryText.includes(expectedCursor),
        canonicalPromptCanaryPresent: promptCanary !== null && canonicalText.includes(promptCanary),
        canonicalTranscriptCanaryPresent: transcriptCanary !== null && canonicalText.includes(transcriptCanary),
        artifactCanaryPresent: artifactCanary !== null && artifactMetadataText.includes(artifactCanary),
        toolResultCanaryPresent: toolResultCanary !== null && artifactMetadataText.includes(toolResultCanary),
        canonicalSourceRowCount: sourceCallId === null ? 0 : canonicalMessages.filter((row) => row.toolCallId === sourceCallId).length,
        canonicalFinalRowCount: canonicalMessages.filter((row) => row.role === 'agent' && !Array.isArray(row.toolCalls)).length,
        canonicalSourcePairCount: committedCanonicalSource.pairCount,
        recoveryProjectedMessageCount: projectedMessages.length,
        recoveryCanonicalMessageCount: recoveryCanonicalMessages.length,
        recoveryProjectedReaderAssistantCount: projectedReader.assistantCount,
        recoveryProjectedReaderToolCount: projectedReader.toolCount,
        recoveryProjectedReaderPairCount: projectedReader.pairCount,
        recoveryCanonicalSourcePairCount: canonicalSource.pairCount,
        recoveryCanonicalReaderPairCount: canonicalReader.pairCount,
        boundedProjectionComplete: canonicalMessageCount <= 16
          && artifactCount <= 2
          && projectedMessages.length <= 32
          && recoveryCanonicalMessages.length <= 32,
      },
    };
  } finally {
    db.close();
  }
}

async function seedRepositoryFixture({ repository }) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const now = '2026-08-08T00:00:00.000Z';
    const fixed = (prefix, index) => `runtime-worker-${prefix}-${String(index).padStart(2, '0')}-`.padEnd(120, prefix[0]);
    const tx = db.transaction(['stars', 'tags'], 'readwrite');
    tx.objectStore('stars').put({
      full_name: repository,
      html_url: `https://github.com/${repository}`,
      description: 'runtime-worker-recovery-description'.padEnd(128, 'd'),
      language: 'TypeScript',
      stargazers_count: 4242,
      topics: Array.from({ length: 12 }, (_, index) => fixed('topic', index)),
      pushed_at: now,
      created_at: now,
      fork: false,
      archived: false,
      starred_at: now,
      tombstone: false,
      synced_at: now,
    });
    tx.objectStore('tags').put({
      full_name: repository,
      manualTags: Array.from({ length: 12 }, (_, index) => fixed('tag', index)),
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: now,
      autoTagsMtime: now,
      dismissedAutoTagsMtime: now,
      notes: '',
      mtime: now,
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function waitForOptionsReady(targetPage) {
  await targetPage.waitForFunction(() => {
    const refresh = document.querySelector('[data-testid="agent-storage-panel"] button');
    return !!document.querySelector('#agent-provider') && !!refresh && !refresh.disabled;
  }, { timeout: SETUP_TIMEOUT_MS });
}

async function saveGitHubToken(targetPage) {
  await clickTextTrusted(targetPage, /^EN$/i);
  await targetPage.waitForSelector('textarea[placeholder="github_pat_..."]:not([disabled])', { visible: true, timeout: SETUP_TIMEOUT_MS });
  await targetPage.evaluate(() => {
    const element = document.querySelector('textarea[placeholder="github_pat_..."]');
    if (!(element instanceof HTMLTextAreaElement)) throw new Error('GitHub credential field is unavailable.');
    element.focus();
    element.select();
  });
  await targetPage.keyboard.type(GITHUB_CREDENTIAL);
  await clickText(targetPage, /^Save & verify$/i);
  await waitUntil(
    () => targetPage.evaluate(() => [...document.querySelectorAll('a')].some((anchor) => anchor.getAttribute('href') === 'https://github.com/runtime-user?tab=stars')),
    SETUP_TIMEOUT_MS,
    'GitHub identity was not confirmed by production Options.',
  );
}

async function saveProvider(targetPage) {
  await clickElementTextTrusted(targetPage, '#agent-provider', /.+/);
  await targetPage.waitForSelector('[role="option"]', { visible: true, timeout: SETUP_TIMEOUT_MS });
  await clickElementTextTrusted(targetPage, '[role="option"]', /^Custom AI service$/i);
  await targetPage.waitForFunction(() => !!document.querySelector('#agent-base-url'), { timeout: SETUP_TIMEOUT_MS });
  await targetPage.evaluate(() => {
    for (const content of document.querySelectorAll('[role="listbox"][data-state="closed"]')) {
      const animationName = getComputedStyle(content).animationName.split(',')[0]?.trim() ?? '';
      content.dispatchEvent(new AnimationEvent('animationend', { animationName, bubbles: true }));
    }
    const details = document.querySelector('[data-testid="agent-advanced-settings"]');
    if (details instanceof HTMLDetailsElement) details.open = true;
  });
  await waitUntil(() => targetPage.evaluate(() => getComputedStyle(document.body).pointerEvents !== 'none'), SETUP_TIMEOUT_MS, 'Provider menu did not unlock.');
  await typeValue(targetPage, '#agent-base-url', PROVIDER_BASE_URL);
  await clickText(targetPage, /^Responses API$/i);
  await typeValue(targetPage, '#agent-provider-context-window', '32768');
  await typeValue(targetPage, '#agent-working-context-window', '32768');
  await typeValue(targetPage, '#agent-model', MODEL);
  await typeValue(targetPage, '#agent-api-key', PROVIDER_CREDENTIAL);

  const permission = { origins: [`${PROVIDER_ORIGIN}/*`] };
  if (!await targetPage.evaluate((details) => chrome.permissions.contains(details), permission)) {
    await clickTextTrusted(targetPage, /allow access/i);
    await waitUntil(() => targetPage.evaluate((details) => chrome.permissions.contains(details), permission), SETUP_TIMEOUT_MS, 'Provider host access was not granted.');
  }
  await acceptAgentDataDisclosure(targetPage, 'custom-openai-compatible', PROVIDER_ORIGIN);
  await clickText(targetPage, /^Save & test$/i);
  await waitUntil(
    () => targetPage.evaluate(() => [...document.querySelectorAll('[role="status"], [role="alert"], .gsm-status-note')].some((node) => node.textContent?.includes('Saved · Connected'))),
    SETUP_TIMEOUT_MS,
    'Provider connection was not saved through production Options.',
  );
}

async function typeValue(targetPage, selector, value) {
  await targetPage.waitForSelector(selector, { visible: true, timeout: SETUP_TIMEOUT_MS });
  await targetPage.evaluate((target, nextValue) => {
    const element = document.querySelector(target);
    if (!(element instanceof HTMLInputElement)) throw new Error('Options input is unavailable.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter.call(element, nextValue);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: null }));
  }, selector, value);
}

async function clickText(targetPage, matcher) {
  const clicked = await targetPage.evaluate(({ source, flags }) => {
    const expression = new RegExp(source, flags);
    const button = [...document.querySelectorAll('button')].find((node) => expression.test(node.textContent?.trim() ?? ''));
    button?.click();
    return !!button;
  }, { source: matcher.source, flags: matcher.flags });
  assert.equal(clicked, true);
}

async function clickTextTrusted(targetPage, matcher) {
  return clickElementTextTrusted(targetPage, 'button', matcher);
}

async function clickElementTextTrusted(targetPage, selector, matcher) {
  const box = await targetPage.evaluate(({ selector: targetSelector, source, flags }) => {
    const expression = new RegExp(source, flags);
    const element = [...document.querySelectorAll(targetSelector)].find((node) => expression.test(node.textContent?.trim() ?? ''));
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, visible: rect.width > 0 && rect.height > 0 };
  }, { selector, source: matcher.source, flags: matcher.flags });
  assert.ok(box?.visible);
  await targetPage.mouse.click(box.x, box.y);
}

async function rpc(targetPage, request) {
  return targetPage.evaluate(async (value) => {
    const response = await chrome.runtime.sendMessage(value);
    if (!response?.ok) throw new Error('Production Agent session RPC failed.');
    return response.data;
  }, request);
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function sensitiveEvidenceMarkers() {
  return [
    GITHUB_CREDENTIAL,
    PROVIDER_CREDENTIAL,
    PROMPT_CANARY,
    ARTIFACT_CANARY,
    TOOL_RESULT_CANARY,
    TRANSCRIPT_CANARY,
    scenario.readonly?.artifactId,
    scenario.readonly?.cursor,
  ].filter((value) => typeof value === 'string' && value.length > 0);
}

function assertNoPrivateEvidence(value) {
  const serialized = JSON.stringify(value);
  for (const marker of sensitiveEvidenceMarkers()) {
    assert.equal(serialized.includes(marker), false);
  }
}

function buildWorkerRecoveryEvidence() {
  const scenarioIds = ['committed_replay', 'statically_read_only_resume', 'state_uncertain_abandonment'];
  return {
    schemaVersion: 1,
    status: 'passed',
    proofScope: 'packaged_worker_recovery',
    productionDistExercised: true,
    releaseDist: readRuntimeReleaseDistIdentity(DIST),
    workerRecovery: {
      scenarios: scenario.counters.map((entry) => ({
        id: entry.name,
        providerRequests: entry.providerRequests,
        toolCalls: entry.scriptedToolCalls,
        toolResults: entry.scriptedToolResults,
        interruptions: entry.interruptions,
        replacements: entry.replacements,
        revisionDelta: entry.observableRevisionDelta,
        writeDelta: entry.observableWriteDelta,
        receiptCount: entry.terminalReceiptCount,
        recoveryRows: entry.recoveryRowResidue,
      })),
      replacements: scenario.replacements.map((entry, index) => ({
        scenarioId: scenarioIds[index],
        oldVersionId: entry.stopped.versionId,
        newVersionId: entry.replacement.versionId,
        oldTargetId: entry.stopped.targetId,
        newTargetId: entry.replacement.targetId,
        oldAttachmentId: entry.stopped.attachmentId,
        newAttachmentId: entry.replacement.attachmentId,
        scriptRelativePath: entry.replacement.route.replace(/^\//u, ''),
        lifecycleMode: entry.lifecycle.mode,
        stopCommandOrdinal: entry.lifecycle.stopCommandOrdinal,
        stoppedOrdinal: entry.lifecycle.stoppedOrdinal,
        installCompletedOrdinal: entry.lifecycle.installCompletedOrdinal,
        startCommandOrdinal: entry.lifecycle.startCommandOrdinal,
        runningOrdinal: entry.lifecycle.runningOrdinal,
      })),
      productEpochs: scenario.productEpochs.map((entry, index) => ({
        scenarioId: scenarioIds[index],
        oldEpochId: entry.oldEpochId,
        newEpochId: entry.newEpochId,
      })),
      durableRecovery: { ...scenario.durableRecovery },
      runtimeDiagnostics: scenario.runtimeDiagnostics.map((entry) => ({
        scenarioId: entry.scenario,
        count: entry.count,
        overflow: entry.overflow,
      })),
    },
    containment: {
      networkFailClosed: scenario.networkIsolationVerified,
      unexpectedNetworkRequests: provider.unexpectedRequests.length + pageHttpPolicy.unexpectedRequests.length,
      rawCredentialOccurrences: 0,
      privatePayloadOccurrences: 0,
      overflow: Object.values(provider.overflow).some(Boolean) || pageHttpPolicy.overflow,
    },
    cleanup: { ...scenario.cleanup },
    evidenceBytes: 0,
  };
}

function validateWorkerRecoveryEvidence(value) {
  const scenarioIds = ['committed_replay', 'statically_read_only_resume', 'state_uncertain_abandonment'];
  assertExactEvidenceKeys(value, ['schemaVersion', 'status', 'proofScope', 'productionDistExercised', 'releaseDist', 'workerRecovery', 'containment', 'cleanup', 'evidenceBytes']);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.status, 'passed');
  assert.equal(value.proofScope, 'packaged_worker_recovery');
  assert.equal(value.productionDistExercised, true);
  assertRuntimeReleaseDistIdentity(value.releaseDist);
  assertExactEvidenceKeys(value.workerRecovery, ['scenarios', 'replacements', 'productEpochs', 'durableRecovery', 'runtimeDiagnostics']);
  assert.equal(value.workerRecovery.scenarios.length, 3);
  assert.deepEqual(value.workerRecovery.scenarios.map((entry) => entry.id), scenarioIds);
  for (const entry of value.workerRecovery.scenarios) {
    assertExactEvidenceKeys(entry, ['id', 'providerRequests', 'toolCalls', 'toolResults', 'interruptions', 'replacements', 'revisionDelta', 'writeDelta', 'receiptCount', 'recoveryRows']);
    for (const count of Object.values(entry).slice(1)) assertNonnegativeEvidenceInteger(count);
    assert.equal(entry.replacements, 1);
    assert.equal(entry.revisionDelta, 1);
    assert.equal(entry.writeDelta, 0);
    assert.equal(entry.receiptCount, 1);
    assert.equal(entry.recoveryRows, 0);
  }
  assert.deepEqual(value.workerRecovery.scenarios.map((entry) => entry.interruptions), [0, 1, 1]);
  assert.equal(value.workerRecovery.replacements.length, 3);
  for (const [index, entry] of value.workerRecovery.replacements.entries()) {
    assertExactEvidenceKeys(entry, ['scenarioId', 'oldVersionId', 'newVersionId', 'oldTargetId', 'newTargetId', 'oldAttachmentId', 'newAttachmentId', 'scriptRelativePath', 'lifecycleMode', 'stopCommandOrdinal', 'stoppedOrdinal', 'installCompletedOrdinal', 'startCommandOrdinal', 'runningOrdinal']);
    assert.equal(entry.scenarioId, scenarioIds[index]);
    for (const key of ['oldVersionId', 'newVersionId', 'oldTargetId', 'newTargetId', 'oldAttachmentId', 'newAttachmentId']) assertBoundedEvidenceIdentifier(entry[key]);
    assert.match(entry.scriptRelativePath, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+\.js$/u);
    assert.equal(entry.lifecycleMode, 'stopped_target_preinstalled');
    for (const key of ['stopCommandOrdinal', 'stoppedOrdinal', 'installCompletedOrdinal', 'startCommandOrdinal', 'runningOrdinal']) assertNonnegativeEvidenceInteger(entry[key]);
    assert.equal(entry.stopCommandOrdinal < entry.stoppedOrdinal, true);
    assert.equal(entry.stoppedOrdinal <= entry.installCompletedOrdinal, true);
    assert.equal(entry.installCompletedOrdinal <= entry.startCommandOrdinal, true);
    assert.equal(entry.startCommandOrdinal < entry.runningOrdinal, true);
    assert.equal(entry.oldVersionId, entry.newVersionId);
    assert.equal(entry.oldTargetId, entry.newTargetId);
    assert.equal(entry.oldAttachmentId, entry.newAttachmentId);
  }
  assert.equal(value.workerRecovery.productEpochs.length, 3);
  for (const [index, entry] of value.workerRecovery.productEpochs.entries()) {
    assertExactEvidenceKeys(entry, ['scenarioId', 'oldEpochId', 'newEpochId']);
    assert.equal(entry.scenarioId, scenarioIds[index]);
    assertBoundedEvidenceIdentifier(entry.oldEpochId);
    assertBoundedEvidenceIdentifier(entry.newEpochId);
    assert.notEqual(entry.oldEpochId, entry.newEpochId);
  }
  validateDurableRecoveryEvidence(value.workerRecovery.durableRecovery);
  assert.equal(value.workerRecovery.runtimeDiagnostics.length, 3);
  for (const [index, entry] of value.workerRecovery.runtimeDiagnostics.entries()) {
    assertExactEvidenceKeys(entry, ['scenarioId', 'count', 'overflow']);
    assert.equal(entry.scenarioId, scenarioIds[index]);
    assert.deepEqual({ count: entry.count, overflow: entry.overflow }, { count: 0, overflow: false });
  }
  assertExactEvidenceKeys(value.containment, ['networkFailClosed', 'unexpectedNetworkRequests', 'rawCredentialOccurrences', 'privatePayloadOccurrences', 'overflow']);
  assert.deepEqual(value.containment, { networkFailClosed: true, unexpectedNetworkRequests: 0, rawCredentialOccurrences: 0, privatePayloadOccurrences: 0, overflow: false });
  assertExactEvidenceKeys(value.cleanup, ['networkGatesClosed', 'diagnosticsDetached', 'pagesClosed', 'browserClosed', 'temporaryStateRemoved']);
  assert.equal(Object.values(value.cleanup).every((entry) => entry === true), true);
  assert.equal(Number.isSafeInteger(value.evidenceBytes) && value.evidenceBytes > 0 && value.evidenceBytes <= MAX_RUNTIME_EVIDENCE_BYTES, true);
}

function validateDurableRecoveryEvidence(value) {
  assertExactEvidenceKeys(value, ['beforeReplacement', 'afterCommit', 'stateUncertain', 'afterAbandonment']);
  assertExactEvidenceKeys(value.beforeReplacement, ['recoveryRows', 'pendingCoverage', 'completeCoverage', 'cursorAuthority', 'continuationPresent', 'leasePresent', 'canonicalPromptResidue', 'recoveryAuthorityPresent', 'provisionalTranscriptResidue']);
  assert.deepEqual(value.beforeReplacement, { recoveryRows: 1, pendingCoverage: 1, completeCoverage: 0, cursorAuthority: true, continuationPresent: true, leasePresent: true, canonicalPromptResidue: false, recoveryAuthorityPresent: true, provisionalTranscriptResidue: false });
  assertExactEvidenceKeys(value.afterCommit, ['recoveryRows', 'pendingCoverage', 'completeCoverage', 'continuationPresent', 'leasePresent', 'receiptPresent', 'canonicalSourceRows', 'canonicalFinalRows', 'canonicalSourcePairs', 'provisionalTranscriptResidue']);
  assert.deepEqual(value.afterCommit, { recoveryRows: 0, pendingCoverage: 0, completeCoverage: 1, continuationPresent: false, leasePresent: false, receiptPresent: true, canonicalSourceRows: 1, canonicalFinalRows: 1, canonicalSourcePairs: 1, provisionalTranscriptResidue: false });
  assertExactEvidenceKeys(value.stateUncertain, ['state', 'terminalReason', 'writeSettlement', 'automaticProviderRequests', 'automaticToolResults', 'writeDelta', 'receiptCount', 'recoveryRows', 'continuationPresent', 'leasePresent']);
  assert.deepEqual(value.stateUncertain, { state: 'state_uncertain', terminalReason: 'attempt_state_lost', writeSettlement: 'unsafe', automaticProviderRequests: 0, automaticToolResults: 0, writeDelta: 0, receiptCount: 0, recoveryRows: 0, continuationPresent: false, leasePresent: false });
  assertExactEvidenceKeys(value.afterAbandonment, ['state', 'terminalReason', 'writeSettlement', 'receiptCount', 'recoveryRows', 'continuationPresent', 'leasePresent', 'freshTurnState', 'freshRevisionDelta', 'freshReceiptCount']);
  assert.deepEqual(value.afterAbandonment, { state: 'terminal_non_retryable', terminalReason: 'abandoned', writeSettlement: 'unsafe', receiptCount: 0, recoveryRows: 0, continuationPresent: false, leasePresent: false, freshTurnState: 'committed', freshRevisionDelta: 1, freshReceiptCount: 1 });
}

function assertExactEvidenceKeys(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value), keys);
}

function assertNonnegativeEvidenceInteger(value) {
  assert.equal(Number.isSafeInteger(value) && value >= 0, true);
}

function assertBoundedEvidenceIdentifier(value) {
  assert.equal(typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/u.test(value), true);
}

function runtimeEvidenceFailureCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[a-z_]{1,64}$/u.test(code) ? code : 'evidence_failure';
}

async function boundedDiagnostics(error) {
  const phases = new Set([
    'setup', 'precondition-start', 'precondition-result', 'precondition-final',
    'readonly-start', 'readonly-source', 'readonly-file', 'readonly-first-page',
    'readonly-resume', 'readonly-page-result', 'readonly-final',
    'uncertain-start', 'uncertain-held', 'fresh-start', 'fresh-final',
  ]);
  const modes = new Set(['setup', 'precondition', 'readonly', 'uncertain', 'fresh']);
  return {
    status: 'failed',
    code: boundedFailureCode(error),
    mode: modes.has(scenario.mode) ? scenario.mode : 'unknown',
    phase: phases.has(scenario.phase) ? scenario.phase : 'unknown',
    providerRequests: provider?.capture?.length ?? 0,
    interruptions: provider?.interruptions?.length ?? 0,
    semanticStage: scenario.semanticStage,
    authority: scenario.lastAuthority,
    portState: page && !page.isClosed?.() ? await page.evaluate(() => globalThis.__workerRecovery?.diagnostics?.() ?? []).catch(() => []) : [],
    replacementCount: scenario.replacements.length,
    replacementDiagnostic: boundedReplacementDiagnostic(error),
    terminal: scenario.lastTerminal,
    providerFailures: provider?.failures?.slice(0, 8) ?? [],
    lastProviderRequest: scenario.lastProviderRequest,
    unexpectedRoutes: provider?.unexpectedRequests?.slice(0, 8).map((entry) => ({ route: entry.route, method: entry.method, kind: entry.kind })) ?? [],
    pageHttpPolicy: {
      unexpectedCount: pageHttpPolicy.unexpectedRequests.length,
      expectedCount: pageHttpPolicy.expectedRequests.length,
      overflow: pageHttpPolicy.overflow,
      interceptionFailure: pageHttpPolicy.interceptionFailure,
      unexpectedRoutes: pageHttpPolicy.unexpectedRequests.slice(0, 8).map((entry) => ({
        route: entry.route,
        method: entry.method,
        resourceType: entry.resourceType,
      })),
    },
    pageIssueKinds: pageIssues.slice(0, 8).map((entry) => entry.kind),
  };
}

function boundedReplacementDiagnostic(error) {
  const value = error?.replacementDiagnostic;
  if (!value || typeof value !== 'object') return null;
  const count = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 16 ? candidate : null;
  return {
    candidateCount: count(value.candidateCount),
    postStopTransitionCount: count(value.postStopTransitionCount),
    duplicateCount: count(value.duplicateCount),
    pausedSessionCount: count(value.pausedSessionCount),
    drainOperationCount: count(value.drainOperationCount),
    pausedSessionCountAfterCleanup: count(value.pausedSessionCountAfterCleanup),
    drainOperationCountAfterCleanup: count(value.drainOperationCountAfterCleanup),
    cleanupBarrierSatisfied: value.cleanupBarrierSatisfied === true,
  };
}

function boundedFailureCode(error) {
  if (error instanceof assert.AssertionError) return 'assertion_failed';
  const message = error instanceof Error ? error.message : '';
  if (message.includes('matching_target_not_paused')) return 'replacement_matching_target_not_paused';
  if (message.includes('multiple_matching_targets')) return 'replacement_multiple_matching_targets';
  if (message.includes('unrelated_paused_target')) return 'replacement_unrelated_paused_target';
  if (message.includes('paused_target_cleanup_failed')) return 'replacement_paused_cleanup_failed';
  if (message.includes('replacement_start_transition_missing')) return 'replacement_start_transition_missing';
  if (message.includes('replacement_attachment_missing')) return 'replacement_attachment_missing';
  if (message.includes('replacement_candidate_missing')) return 'replacement_candidate_missing';
  if (message.includes('replacement_post_stop_transition_missing')) return 'replacement_post_stop_transition_missing';
  if (message.includes('replacement_candidate_transition_mismatch')) return 'replacement_candidate_transition_mismatch';
  if (message.includes('current stopped transition')) return 'replacement_stop_proof_failed';
  if (message.includes('post-stop lifecycle') || message.includes('correlation failed')) return 'replacement_correlation_failed';
  if (message.includes('paused on start')) return 'replacement_not_paused';
  if (message.includes('Manual replacement') || message.includes('manual replacement')) return 'replacement_manual_attach_failed';
  if (message.includes('preinstalled stopped target did not report a post-start transition')) return 'replacement_instrumented_start_missing';
  if (message.includes('preinstalled replacement worker did not reach running')) return 'replacement_instrumented_running_missing';
  if (message.includes('Production Port controller timed out')) return 'replacement_product_recovery_timeout';
  if (message.includes('Paused auto-attached')) return 'replacement_pause_cleanup_failed';
  if (message.includes('registration ID')) return 'replacement_registration_invalid';
  if (message.includes('network client was not retired')) return 'replacement_retirement_failed';
  if (message.includes('distinct session')) return 'replacement_stopped_session_not_distinct';
  if (message.includes('stopped replacement service-worker CDP session')) return 'replacement_stopped_session_unavailable';
  if (message.includes('restarted before provider installation completed')) return 'replacement_preinstall_restarted';
  if (message.includes('identity or status changed before provider installation completed')) return 'replacement_preinstall_changed';
  if (message.includes('post-stop start transition')) return 'replacement_instrumented_start_missing';
  if (message.includes('uninstrumented replacement target')) return 'replacement_uninstrumented_target';
  if (message.includes('instrumented replacement worker did not reach running')) return 'replacement_instrumented_running_missing';
  return 'runtime_failure';
}

async function teardown() {
  const failures = [];
  let pageDiagnosticsDetached = false;
  let replacementDiagnosticsDetached = false;
  const attempt = async (operation) => {
    try { await operation(); } catch (error) { failures.push(error); }
  };
  await attempt(async () => {
    pageDiagnostics?.cleanup?.();
    pageDiagnosticsDetached = true;
  });
  await attempt(async () => {
    await pageHttpPolicy.close?.();
  });
  await attempt(async () => {
    await replacementController?.close?.();
    replacementDiagnosticsDetached = true;
  });
  if (provider && providerHandle) {
    await attempt(async () => {
      if (await retireControlledProviderClient(provider, providerHandle) !== true) throw new Error('Active provider gate was not retired during teardown.');
      providerHandle = null;
    });
  }
  await attempt(() => closeControlledResponsesProvider(provider));
  scenario.cleanup.networkGatesClosed = pageHttpPolicy.closed === true && provider?.closed === true;
  scenario.cleanup.diagnosticsDetached = pageDiagnosticsDetached && replacementDiagnosticsDetached;
  if (page && !page.isClosed?.()) {
    await attempt(() => page.evaluate(() => globalThis.__workerRecovery?.close?.()));
  }
  if (page && !page.isClosed?.()) await attempt(() => page.close());
  scenario.cleanup.pagesClosed = !page || page.isClosed?.() === true;
  if (browser) await attempt(() => browser.close());
  scenario.cleanup.browserClosed = true;
  await attempt(() => rmSync(profile, { recursive: true, force: true }));
  scenario.cleanup.temporaryStateRemoved = !existsSync(profile);
  if (failures.length > 0) throw failures[0];
}
