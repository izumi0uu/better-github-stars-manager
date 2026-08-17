import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  assertReleaseVersionIdentity,
  assertEvidenceRedacted,
  createFileEvidence,
  FINAL_CHECK_SPECS,
  finalCheckSpecsForTarget,
  FIREFOX_RELEASE_MANUAL_EXCLUSIONS,
  FIREFOX_RUNTIME_SCENARIO_IDS,
  parseViteChunkAdvisories,
  planEvidencePublication,
  prepareReleaseFinalization,
  ReleaseEvidenceError,
  RELEASE_MANUAL_EXCLUSIONS,
  RUNTIME_EVIDENCE_CONTRACTS,
  validateProvisionalReleaseEvidence,
  validatePublishedReleaseGate,
  validateRuntimeEvidenceFile,
  validateReleaseVersionApproval,
  validateRuntimeVerificationEvidence,
} from '../../scripts/agent-runtime-release-evidence.mjs';
import {
  EDGE_RELEASE_WORKER_BASELINE,
  RELEASE_WORKER_BASELINE,
} from '../../scripts/package-manifest-closure.mjs';
import {
  FIREFOX_GECKO_ID,
  FIREFOX_MIN_VERSION,
  FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS,
  FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS,
} from '../../scripts/build-firefox-extension.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const COMMIT = 'a'.repeat(40);
const VERSION = '1.0.9';
const STARTED = '2026-08-09T00:00:00.000Z';
const FINISHED = '2026-08-09T00:00:01.000Z';
const GENERATED = '2026-08-09T00:00:02.000Z';
const FINALIZED = '2026-08-09T00:00:03.000Z';
const PACKAGE_GENERATED = '2026-08-09T00:00:00.910Z';
const WORKER_SCENARIO_IDS = ['committed_replay', 'statically_read_only_resume', 'state_uncertain_abandonment'];
const SCENARIO_IDS = [
  'small-window-multiple-tools',
  'overflow-then-success',
  'malformed-summary-fallback',
  'cancel-during-compaction',
  'agent-port-disconnect',
  'organize-cross-batch-recovery',
  'organize-cancel-during-apply',
  'organize-port-reconnect',
  'cubby-artifact-continuation-coverage',
];
const releaseDist = {
  packageInput: { algorithm: 'sha256', fileCount: 9, sha256: SHA_A },
  manifest: { relativePath: 'manifest.json', bytes: 100, sha256: SHA_B, manifestVersion: 3, extensionVersion: VERSION },
  loader: { relativePath: 'service-worker-loader.js', bytes: 29, sha256: 'c'.repeat(64) },
  worker: { ...RELEASE_WORKER_BASELINE },
};
const diagnosticsBuild = {
  ...releaseDist,
  packageInput: { ...releaseDist.packageInput, sha256: 'e'.repeat(64) },
};
const containment = { networkFailClosed: true, unexpectedNetworkRequests: 0, rawCredentialOccurrences: 0, privatePayloadOccurrences: 0, overflow: false };
const cleanup = { networkGatesClosed: true, diagnosticsDetached: true, pagesClosed: true, browserClosed: true, temporaryStateRemoved: true };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function rotateKeys(value) {
  const entries = Object.entries(value);
  return Object.fromEntries([...entries.slice(1), entries[0]]);
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializeProducer(value) {
  let previous = -1;
  while (value.evidenceBytes !== previous) {
    previous = value.evidenceBytes;
    value.evidenceBytes = Buffer.byteLength(canonical(value));
  }
  return canonical(value);
}

function exactValues(keys, overrides = {}) {
  return Object.fromEntries(keys.map((key) => [key, overrides[key] ?? 0]));
}

function producer(key, facts) {
  const contract = RUNTIME_EVIDENCE_CONTRACTS[key];
  const value = {
    schemaVersion: 1,
    status: 'passed',
    proofScope: contract.proofScope,
    productionDistExercised: contract.productionDistExercised,
    releaseDist: clone(releaseDist),
  };
  if (key === 'scenarioLab') value.diagnosticsBuild = clone(diagnosticsBuild);
  value[contract.factsKey] = facts;
  value.containment = clone(containment);
  value.cleanup = clone(cleanup);
  value.evidenceBytes = 0;
  return value;
}

const producerFacts = {
  artifact: {
    provider: exactValues(['requests', 'sourceRequests', 'locatingReads', 'exhaustivePageReads', 'ordinaryBoundaries', 'provisionalFinals', 'correctiveReprompts', 'finalResponses'], { exhaustivePageReads: 2 }),
    coverage: { firstPageOmittedCursor: true, cursorChainExact: true, pageCount: 2, expectedBytes: 100, deliveredBytes: 100, nextCursorNull: true, artifactDigestPresent: true, manifestDigestPresent: true, cursorChainDigestPresent: true, chunksMatchManifest: true },
    canonical: exactValues(['sourceToolRows', 'readerRows', 'prematureAssistantRows', 'finalAssistantRows', 'receiptCount']),
    settlement: { commitApplied: true, revisionDelta: 1, recoveryRows: 0, continuationPresent: false, leasePresent: false },
  },
  workerRecovery: {
    scenarios: WORKER_SCENARIO_IDS.map((id, index) => ({ id, providerRequests: 1, toolCalls: 1, toolResults: 1, interruptions: [0, 1, 1][index], replacements: 1, revisionDelta: 1, writeDelta: 0, receiptCount: 1, recoveryRows: 0 })),
    replacements: WORKER_SCENARIO_IDS.map((scenarioId, index) => ({ scenarioId, oldVersionId: `version-${index}`, newVersionId: `version-${index}`, oldTargetId: `target-${index}`, newTargetId: `target-${index}`, oldAttachmentId: `attachment-${index}`, newAttachmentId: `attachment-${index}`, scriptRelativePath: 'assets/worker.js', lifecycleMode: 'stopped_target_preinstalled', stopCommandOrdinal: 1, stoppedOrdinal: 2, installCompletedOrdinal: 3, startCommandOrdinal: 4, runningOrdinal: 5 })),
    productEpochs: WORKER_SCENARIO_IDS.map((scenarioId, index) => ({ scenarioId, oldEpochId: `epoch-old-${index}`, newEpochId: `epoch-new-${index}` })),
    durableRecovery: {
      beforeReplacement: { recoveryRows: 1, pendingCoverage: true, completeCoverage: false, cursorAuthority: 'durable', continuationPresent: true, leasePresent: true, canonicalPromptResidue: 0, recoveryAuthorityPresent: true, provisionalTranscriptResidue: 0 },
      afterCommit: { recoveryRows: 0, pendingCoverage: false, completeCoverage: true, continuationPresent: false, leasePresent: false, receiptPresent: true, canonicalSourceRows: 1, canonicalFinalRows: 1, canonicalSourcePairs: 1, provisionalTranscriptResidue: 0 },
      stateUncertain: { state: 'abandoned', terminalReason: 'state_uncertain', writeSettlement: 'unsafe', automaticProviderRequests: 0, automaticToolResults: 0, writeDelta: 0, receiptCount: 0, recoveryRows: 0, continuationPresent: false, leasePresent: false },
      afterAbandonment: { state: 'completed', terminalReason: 'fresh_turn', writeSettlement: 'unsafe', receiptCount: 1, recoveryRows: 0, continuationPresent: false, leasePresent: false, freshTurnState: 'completed', freshRevisionDelta: 1, freshReceiptCount: 1 },
    },
    runtimeDiagnostics: WORKER_SCENARIO_IDS.map((scenarioId) => ({ scenarioId, count: 0, overflow: false })),
  },
  uiHistory: {
    scenarios: {
      atomic: exactValues(['sessionRows', 'sameSession'], { sameSession: true }),
      pageLocal: exactValues(['sessionRows', 'pageAPickedNew', 'pageBStayedLocal'], { pageAPickedNew: true, pageBStayedLocal: true }),
      subscription: exactValues(['resumeOnlyWinnerStarts', 'resumeOnlyRejectedStarts', 'providerDelta', 'providerRequests', 'sessionRows', 'attemptRows', 'committedRows', 'terminalPages']),
      conflict: exactValues(['typed', 'exactPublicText', 'domRollback', 'inputRetainedBefore', 'inputRetainedAfter', 'composerEnabledAfter', 'sessionDelta', 'attemptDelta', 'providerDelta', 'messageDelta'], { typed: true, exactPublicText: true, domRollback: true, inputRetainedBefore: true, inputRetainedAfter: true, composerEnabledAfter: true }),
      retry: exactValues(['httpStatus', 'requestDelta', 'attemptDelta', 'sourceRetried', 'committed', 'writeSettlementsNone', 'selectedTools']),
      history: exactValues(['lightweightTurns', 'canonicalRows', 'userRows', 'assistantRows', 'recentRows', 'loadedRows', 'recentExactOrder', 'fullExactOrder', 'occurrenceOnce', 'firstSequence', 'lastSequence', 'gaps', 'duplicateIds', 'finalCursorNull'], { recentExactOrder: true, fullExactOrder: true, occurrenceOnce: true, finalCursorNull: true }),
    },
    provider: exactValues(['requests', 'connectionRequests', 'scenarioRequests', 'http503Responses', 'selectedScenarioTools', 'authenticatedRequests', 'failures', 'interruptions']),
    network: exactValues(['browserFailClosed', 'workerFixtures', 'workerUnexpected', 'pageExpected', 'pageUnexpected', 'pageIssues', 'overflow'], { browserFailClosed: true, overflow: false }),
    canary: exactValues(['secretDurableOccurrences', 'secretEvidenceOccurrences', 'submittedDurableOccurrences', 'submittedProviderAssociations', 'providerResponseDurableOccurrences', 'neverSubmittedDurableOccurrences', 'neverSubmittedProviderOccurrences', 'rejectedDurableOccurrences', 'rejectedProviderOccurrences']),
  },
  organize: {
    configuration: exactValues(['transientProbeRequests', 'savedCredentialUnchanged', 'savedCapabilityReady'], { transientProbeRequests: 2, savedCredentialUnchanged: true, savedCapabilityReady: true }),
    corruption: exactValues(['activeCheckpointDiscarded', 'blockedCheckpointReplaced', 'duplicateStartIdempotent']),
    start: exactValues(['preflightRows', 'admittedRows']),
    budget: exactValues(['frozenRows', 'providerAttemptsBeforeContinuation', 'continuationCount', 'completed'], { completed: true }),
    detach: exactValues(['detachedWhileActive', 'terminalRetainedUntilDismiss'], { detachedWhileActive: true, terminalRetainedUntilDismiss: true }),
    ownership: exactValues(['rawPages', 'ownerPages', 'observerPages', 'ownerLostPages', 'explicitTakeoverPages', 'formerOwnerObserverPages', 'ownerObserverConverged', 'ownerLossRequiredExplicitTakeover', 'takeoverProviderRequestDelta', 'terminalProjectionPages', 'terminalPagesConverged'], { ownerObserverConverged: true, ownerLossRequiredExplicitTakeover: true, terminalPagesConverged: true }),
    deletion: exactValues(['nonterminalDeletionBlocked', 'deletionUiActors', 'originDeletedAfterCommit', 'terminalEvidenceRetained', 'originProvenanceRetained', 'deletedPagesInvalidated', 'deletedOriginInCatalog', 'terminalCards', 'originDeletedCopyPages', 'retainedTerminalRows', 'retainedApplyRows'], { nonterminalDeletionBlocked: true, originDeletedAfterCommit: true, terminalEvidenceRetained: true, originProvenanceRetained: true, deletedPagesInvalidated: true }),
    draftRecovery: exactValues(['contentPages', 'originSessionPagesBefore', 'replacementSessionsCreated', 'invalidationPages', 'draftsPreserved', 'replacementSessionPages', 'composerEnabledPages', 'deletedOriginTranscriptRows', 'deletedOriginRetryCards', 'replacementSessionSelected', 'unsentDraftPreservedExactly'], { replacementSessionSelected: true, unsentDraftPreservedExactly: true }),
    nextAdmission: exactValues(['actorPages', 'observerPages', 'noJobProjectionPages', 'oldTerminalRows', 'oldApplyRows', 'newPreflightRows', 'providerRequestDelta', 'pagesConverged'], { pagesConverged: true }),
    dismiss: exactValues(['actorPages', 'convergedPages', 'dismissedTerminalRows', 'dismissedApplyRows', 'pagesConverged'], { pagesConverged: true }),
    provider: exactValues(['requests', 'authenticatedRequests', 'githubFixtureRequests', 'unexpectedRequests', 'failures', 'overflow', 'customHostDeniedFetches'], { overflow: false }),
  },
  organizeRecovery: {
    replacement: { scenarioId: 'organize_recovery', oldVersionId: 'version', newVersionId: 'version', oldTargetId: 'target', newTargetId: 'target', oldAttachmentId: 'attachment', newAttachmentId: 'attachment', scriptRelativePath: 'assets/worker.js', lifecycleMode: 'paused_target_auto_attached', stopCommandOrdinal: 1, stoppedOrdinal: 2, installCompletedOrdinal: 3, startCommandOrdinal: 4, runningOrdinal: 5 },
    epochs: { oldEpochId: 'epoch-old', newEpochId: 'epoch-new' },
    outcome: { runIdStable: true, generationStable: true, firstPageAttempts: 2, retriedFirstPage: true, settledCount: 501, uniqueSettledPositionCount: 501, providerAttemptCount: 2, duplicateProviderRequests: 1, terminalStatus: 'review' },
    provider: { requests: 2, interruptions: 1, failures: 0 },
  },
  scenarioLab: {
    scenarios: { ids: SCENARIO_IDS, rootCount: 9, eventCount: 18, completedCount: 7, cancelledCount: 2, failedCount: 0, lastEventTerminal: true, artifactContinuationProviderRequests: 12, writeOutcomeEvents: 0 },
    rawCapture: { warningRendered: true, armedBeforeReload: true, disarmedAfterReload: true },
    issues: { page: 0, worker: 0 },
  },
};

function runtimeRecords() {
  const documents = Object.fromEntries(Object.entries(producerFacts).map(([key, facts]) => [key, producer(key, clone(facts))]));
  const raws = Object.fromEntries(Object.entries(documents).map(([key, value]) => [key, serializeProducer(value)]));
  const files = Object.fromEntries(Object.entries(raws).map(([key, raw]) => [key, createFileEvidence(RUNTIME_EVIDENCE_CONTRACTS[key].filename, raw)]));
  const runtimeComposition = {
    schemaVersion: 1,
    status: 'passed',
    proofScope: 'runtime_composition',
    releaseDist: clone(releaseDist),
    inputs: Object.fromEntries(['artifact', 'workerRecovery', 'uiHistory', 'organize', 'organizeRecovery', 'scenarioLab'].map((key) => [key, { filename: files[key].relativePath, bytes: files[key].bytes, sha256: files[key].sha256, schemaVersion: 1, status: 'passed', proofScope: RUNTIME_EVIDENCE_CONTRACTS[key].proofScope }])),
    organizeOutcomes: { ownerObserverConverged: true, ownerLossRequiredExplicitTakeover: true, takeoverProviderRequestDelta: 0, terminalPagesConverged: true, nonterminalDeletionBlocked: true, originDeletedAfterCommit: true, terminalEvidenceRetained: true, originProvenanceRetained: true, deletedPagesInvalidated: true, replacementSessionSelected: true, unsentDraftPreservedExactly: true, nextAdmissionPagesConverged: true, dismissPagesConverged: true, workerRecoveryCompleted: true },
    containment: clone(containment),
    cleanup: clone(cleanup),
    evidenceBytes: 0,
  };
  documents.runtimeComposition = runtimeComposition;
  raws.runtimeComposition = serializeProducer(runtimeComposition);
  files.runtimeComposition = createFileEvidence(RUNTIME_EVIDENCE_CONTRACTS.runtimeComposition.filename, raws.runtimeComposition);
  return { documents, raws, files };
}

function provisionalEvidence() {
  return {
    schemaVersion: 2,
    generatedAt: PACKAGE_GENERATED,
    packageVersion: VERSION,
    source: { commit: COMMIT, dirty: false },
    package: { releaseReady: false, releaseReadinessReason: 'agent_runtime_verification_required', dashboardSubmissionClaimed: false, zipRootManifest: true, manifestResourcesClosed: true, sourceOnlyEntriesExcluded: true, productionDisclosureMarkers: ['Agent settings'] },
    packagedPermissions: { permissions: ['alarms', 'storage'], optionalPermissions: [], hostPermissions: ['https://api.github.com/*'], optionalHostPermissions: ['https://*/*'] },
    packageInput: clone(releaseDist.packageInput),
    build: { worker: { relativePath: releaseDist.worker.relativePath, bytes: releaseDist.worker.bytes, kib: releaseDist.worker.bytes / 1024, sha256: releaseDist.worker.sha256 }, mermaid: [{ relativePath: 'assets/mermaid-a.js', bytes: 10, kib: 10 / 1024, sha256: SHA_B }], advisories: [], outputSha256: SHA_A },
    generatedFiles: [{ relativePath: 'better-github-stars-manager-1.0.9.zip', bytes: 100, sha256: SHA_A }, { relativePath: 'better-github-stars-manager-1.0.9.zip.sha256', bytes: 80, sha256: SHA_B }],
    packagedManifest: { relativePath: 'manifest.json', bytes: 100, sha256: releaseDist.manifest.sha256 },
    manifestResources: [{ relativePath: releaseDist.worker.relativePath, bytes: releaseDist.worker.bytes, sha256: releaseDist.worker.sha256, referencedBy: ['background.service_worker.import'] }, { relativePath: 'service-worker-loader.js', bytes: releaseDist.loader.bytes, sha256: releaseDist.loader.sha256, referencedBy: ['background.service_worker'] }],
  };
}

function edgeProvisionalEvidence() {
  const provisional = provisionalEvidence();
  return {
    schemaVersion: 4,
    browserTarget: 'edge',
    capabilities: { gistSync: true, agent: true, organizeProvider: true },
    generatedAt: provisional.generatedAt,
    packageVersion: provisional.packageVersion,
    source: provisional.source,
    package: {
      releaseReady: false,
      releaseReadinessReason: 'edge_runtime_verification_required',
      publicationClaimed: false,
      zipRootManifest: true,
      manifestResourcesClosed: true,
      sourceOnlyEntriesExcluded: true,
      remoteExecutableCodeExcluded: true,
      productionDisclosureMarkers: provisional.package.productionDisclosureMarkers,
    },
    packagedPermissions: provisional.packagedPermissions,
    packageInput: provisional.packageInput,
    build: {
      ...provisional.build,
      worker: {
        relativePath: EDGE_RELEASE_WORKER_BASELINE.relativePath,
        bytes: EDGE_RELEASE_WORKER_BASELINE.bytes,
        kib: EDGE_RELEASE_WORKER_BASELINE.bytes / 1024,
        sha256: EDGE_RELEASE_WORKER_BASELINE.sha256,
      },
    },
    generatedFiles: provisional.generatedFiles.map((entry) => ({
      ...entry,
      relativePath: entry.relativePath.replace(
        `better-github-stars-manager-${VERSION}`,
        `better-github-stars-manager-edge-${VERSION}`,
      ),
    })),
    packagedManifest: { ...provisional.packagedManifest, browserTarget: 'edge' },
    manifestResources: provisional.manifestResources.map((entry) => (
      entry.relativePath === RELEASE_WORKER_BASELINE.relativePath
        ? {
            relativePath: EDGE_RELEASE_WORKER_BASELINE.relativePath,
            bytes: EDGE_RELEASE_WORKER_BASELINE.bytes,
            sha256: EDGE_RELEASE_WORKER_BASELINE.sha256,
            referencedBy: entry.referencedBy,
          }
        : entry
    )),
  };
}

function verificationEvidence(files, provisionalFile) {
  return {
    schemaVersion: 2,
    generatedAt: GENERATED,
    executionAuthority: 'durable_agent_runtime_release_plan',
    source: { commit: COMMIT, dirty: false },
    packageVersion: VERSION,
    environment: { node: 'v22.1.0', platform: 'darwin', arch: 'arm64' },
    checks: Object.fromEntries(FINAL_CHECK_SPECS.map(({ key, command }, index) => [key, {
      status: 'passed',
      command,
      startedAt: new Date(Date.parse(STARTED) + index * 50).toISOString(),
      finishedAt: new Date(Date.parse(STARTED) + index * 50 + 25).toISOString(),
      outputSha256: SHA_A,
    }])),
    build: { packageInput: clone(releaseDist.packageInput), worker: { relativePath: releaseDist.worker.relativePath, bytes: releaseDist.worker.bytes, kib: releaseDist.worker.bytes / 1024, sha256: releaseDist.worker.sha256 }, mermaid: [{ relativePath: 'assets/mermaid-a.js', bytes: 10, kib: 10 / 1024, sha256: SHA_B }], advisories: [], outputSha256: SHA_A },
    runtimeEvidence: clone(files),
    provisionalReleaseEvidence: provisionalFile,
    status: 'agent_runtime_verification_passed',
  };
}

function firefoxReleaseDist() {
  return {
    browserTarget: 'firefox',
    ...clone(releaseDist),
    background: { kind: 'event_page', module: true, scripts: [releaseDist.loader.relativePath] },
    gecko: {
      id: FIREFOX_GECKO_ID,
      strictMinVersion: FIREFOX_MIN_VERSION,
      dataCollectionPermissions: {
        required: [...FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS],
        optional: [...FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS],
      },
    },
  };
}

function firefoxProvisionalEvidence() {
  const dist = firefoxReleaseDist();
  const baseName = `better-github-stars-manager-firefox-${VERSION}`;
  const files = [
    { relativePath: `${baseName}.zip`, bytes: 100, sha256: SHA_A },
    { relativePath: `${baseName}.zip.sha256`, bytes: 80, sha256: SHA_B },
    { relativePath: `${baseName}-source.zip`, bytes: 200, sha256: 'c'.repeat(64) },
    { relativePath: `${baseName}-source.zip.sha256`, bytes: 90, sha256: 'd'.repeat(64) },
  ].sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  const sourceArchive = files.find(({ relativePath }) => relativePath === `${baseName}-source.zip`);
  const sourceChecksum = files.find(({ relativePath }) => relativePath === `${baseName}-source.zip.sha256`);
  return {
    schemaVersion: 3,
    browserTarget: 'firefox',
    generatedAt: PACKAGE_GENERATED,
    packageVersion: VERSION,
    source: { commit: COMMIT, dirty: false },
    package: { releaseReady: false, releaseReadinessReason: 'agent_runtime_verification_required', publicationClaimed: false, zipRootManifest: true, manifestResourcesClosed: true, sourceOnlyEntriesExcluded: true, remoteExecutableCodeExcluded: true, productionDisclosureMarkers: ['Agent settings'] },
    packagedPermissions: { permissions: ['alarms', 'storage'], optionalPermissions: [], hostPermissions: ['https://api.github.com/*'], optionalHostPermissions: ['https://*/*'], dataCollectionPermissions: clone(dist.gecko.dataCollectionPermissions) },
    packageInput: clone(dist.packageInput),
    build: { worker: { relativePath: dist.worker.relativePath, bytes: dist.worker.bytes, kib: dist.worker.bytes / 1024, sha256: dist.worker.sha256 }, mermaid: [{ relativePath: 'assets/mermaid-a.js', bytes: 10, kib: 10 / 1024, sha256: SHA_B }], advisories: [], outputSha256: SHA_A },
    generatedFiles: files,
    packagedManifest: { relativePath: 'manifest.json', bytes: 100, sha256: dist.manifest.sha256, browserTarget: 'firefox', background: clone(dist.background), gecko: clone(dist.gecko) },
    reviewerSource: { archive: sourceArchive, checksum: sourceChecksum, readme: { relativePath: 'FIREFOX_REVIEWER_BUILD.md', bytes: 300, sha256: 'e'.repeat(64) }, packageInput: { algorithm: 'sha256', fileCount: 20, sha256: 'f'.repeat(64) } },
    manifestResources: [{ relativePath: dist.worker.relativePath, bytes: dist.worker.bytes, sha256: dist.worker.sha256, referencedBy: ['background.scripts[0].import'] }, { relativePath: dist.loader.relativePath, bytes: dist.loader.bytes, sha256: dist.loader.sha256, referencedBy: ['background.scripts[0]'] }],
  };
}

function firefoxVerificationEvidence(files, provisionalFile) {
  const base = verificationEvidence(files, provisionalFile);
  const run = (role, browserVersion, executablePathSha256) => ({
    role,
    browserTarget: 'firefox',
    realBrowser: true,
    browserVersion,
    executablePathSha256,
    extensionId: FIREFOX_GECKO_ID,
    background: { kind: 'event_page', module: true },
    scenarioIds: [...FIREFOX_RUNTIME_SCENARIO_IDS],
    diagnostics: {
      observedPageErrors: 0,
      observedBackgroundErrors: 0,
      observedUncaughtErrors: 0,
      backgroundObservation: 'post_startup_guarded_intervals',
      startupHealthChecks: 2,
    },
  });
  return {
    schemaVersion: 3,
    browserTarget: 'firefox',
    generatedAt: base.generatedAt,
    executionAuthority: base.executionAuthority,
    source: base.source,
    packageVersion: base.packageVersion,
    environment: base.environment,
    firefox: { runs: [run('firefox_140', '140.0.4', SHA_A), run('stable', '142.0.1', SHA_B)] },
    sharedRuntimeReleaseDist: clone(releaseDist),
    checks: Object.fromEntries(finalCheckSpecsForTarget('firefox').map(({ key, command }) => [key, { ...base.checks[key], command }])),
    build: base.build,
    runtimeEvidence: base.runtimeEvidence,
    provisionalReleaseEvidence: base.provisionalReleaseEvidence,
    status: base.status,
  };
}

function finalizationFixture() {
  const runtime = runtimeRecords();
  const provisional = provisionalEvidence();
  const provisionalRaw = canonical(provisional);
  const provisionalRelativePath = 'release-evidence-1.0.9.provisional.json';
  const verification = verificationEvidence(runtime.files, createFileEvidence(provisionalRelativePath, provisionalRaw));
  return { runtime, provisional, verification, input: {
    provisionalRaw,
    provisionalRelativePath,
    runtimeVerificationRaw: canonical(verification),
    runtimeVerificationRelativePath: 'agent-runtime-verification.json',
    runtimeEvidenceRaw: runtime.raws,
    releaseDist: clone(releaseDist),
    sourceCommit: COMMIT,
    packageVersion: VERSION,
    packageInput: clone(releaseDist.packageInput),
    versionApproval: { approvedCandidateVersion: VERSION, observedCurrentPublicVersion: '1.0.8', observedPriorUploadVersion: '1.0.8' },
    packagedManifestVersion: VERSION,
    zipManifestVersion: VERSION,
    publicationTimestamp: GENERATED,
    finalRelativePath: 'release-evidence-1.0.9.json',
    gateRelativePath: 'agent-release-gate-evidence.json',
    manualExclusions: [...RELEASE_MANUAL_EXCLUSIONS],
    expectedScenarioIds: SCENARIO_IDS,
  } };
}
function firefoxFinalizationFixture() {
  const runtime = runtimeRecords();
  const provisional = firefoxProvisionalEvidence();
  const provisionalRaw = canonical(provisional);
  const provisionalRelativePath = `release-evidence-${VERSION}.provisional.json`;
  const verification = firefoxVerificationEvidence(
    runtime.files,
    createFileEvidence(provisionalRelativePath, provisionalRaw),
  );
  return {
    runtime,
    verification,
    input: {
      provisionalRaw,
      provisionalRelativePath,
      runtimeVerificationRaw: canonical(verification),
      runtimeVerificationRelativePath: 'agent-runtime-verification.json',
      runtimeEvidenceRaw: runtime.raws,
      releaseDist: firefoxReleaseDist(),
      sharedRuntimeReleaseDist: clone(releaseDist),
      sourceCommit: COMMIT,
      packageVersion: VERSION,
      packageInput: clone(firefoxReleaseDist().packageInput),
      browserTarget: 'firefox',
      versionApproval: { approvedCandidateVersion: VERSION, observedCurrentPublicVersion: '1.0.8', observedPriorUploadVersion: '1.0.8' },
      packagedManifestVersion: VERSION,
      zipManifestVersion: VERSION,
      publicationTimestamp: GENERATED,
      finalRelativePath: `release-evidence-${VERSION}.json`,
      gateRelativePath: 'agent-release-gate-evidence.json',
      manualExclusions: [...FIREFOX_RELEASE_MANUAL_EXCLUSIONS],
      expectedScenarioIds: SCENARIO_IDS,
    },
  };
}


function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ReleaseEvidenceError && error.code === code);
}

function advisoryBlock(chunk) {
  return [`dist/assets/${chunk}.js  530.00 kB │ gzip: 100.00 kB`, '(!) Some chunks are larger than 500 kB after minification. Consider:', '- Using dynamic import() to code-split the application', '- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks', '- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.'].join('\n');
}

test('captures zero or multiple complete bounded Vite advisory blocks', () => {
  assert.deepEqual(parseViteChunkAdvisories({ stdout: 'built', stderr: '' }).advisories, []);
  const parsed = parseViteChunkAdvisories({ stdout: advisoryBlock('worker'), stderr: advisoryBlock('mermaid') });
  assert.equal(parsed.advisories.length, 2);
  assert.match(parsed.outputSha256, /^[0-9a-f]{64}$/u);
  const splitWarning = advisoryBlock('unused').split('\n').slice(1).join('\n');
  const split = parseViteChunkAdvisories({
    stdout: 'dist/assets/worker.js  530.00 kB │ gzip: 100.00 kB\ndist/assets/mermaid.js  520.00 kB │ gzip: 90.00 kB',
    stderr: splitWarning,
  });
  assert.equal(split.advisories.length, 1);
  assert.equal(split.advisories[0].startsWith('dist/assets/worker.js'), true);
  assert.equal(split.advisories[0].includes('dist/assets/mermaid.js'), true);
  expectCode(() => parseViteChunkAdvisories({ stdout: '(!) Some chunks are larger than 500 kB after minification. Consider:', stderr: '' }), 'vite_advisory_incomplete');
  expectCode(() => parseViteChunkAdvisories({ stdout: advisoryBlock('large'), stderr: '' }, { maxBlockBytes: 50 }), 'vite_advisory_block_too_large');
  expectCode(() => parseViteChunkAdvisories({ stdout: `${advisoryBlock('a')}\n${advisoryBlock('b')}`, stderr: '' }, { maxBlocks: 1 }), 'vite_advisory_count_exceeded');
});

test('validates all seven exact runtime evidence contracts and their composition binding', () => {
  const { raws, files } = runtimeRecords();
  for (const key of ['artifact', 'workerRecovery', 'uiHistory', 'organize', 'organizeRecovery', 'scenarioLab']) {
    assert.deepEqual(validateRuntimeEvidenceFile(key, raws[key], { releaseDist }).file, files[key]);
  }
  assert.equal(validateRuntimeEvidenceFile('runtimeComposition', raws.runtimeComposition, { releaseDist, runtimeFiles: files }).value.proofScope, 'runtime_composition');
});

test('rejects wrong runtime schema, status, hash, private fields, and stale composition input', () => {
  const fixture = runtimeRecords();
  const extra = clone(fixture.documents.artifact);
  extra.artifactFlow.provider.extra = 1;
  expectCode(() => validateRuntimeEvidenceFile('artifact', serializeProducer(extra)), 'schema_invalid');
  const failed = clone(fixture.documents.artifact);
  failed.status = 'failed';
  expectCode(() => validateRuntimeEvidenceFile('artifact', serializeProducer(failed)), 'schema_invalid');
  const wrongHash = clone(fixture.documents.artifact);
  wrongHash.releaseDist.worker.sha256 = 'short';
  expectCode(() => validateRuntimeEvidenceFile('artifact', serializeProducer(wrongHash)), 'schema_invalid');
  const privateField = clone(fixture.documents.artifact);
  privateField.prompt = 'private';
  expectCode(() => validateRuntimeEvidenceFile('artifact', serializeProducer(privateField)), 'private_evidence_rejected');
  expectCode(() => assertEvidenceRedacted({ safe: 'Bearer abc' }), 'private_evidence_rejected');
  expectCode(() => assertEvidenceRedacted({ safe: 'PRIVATE-CANARY' }, { forbiddenValues: ['PRIVATE-CANARY'] }), 'private_evidence_rejected');
  const staleRuntimeComposition = clone(fixture.documents.runtimeComposition);
  staleRuntimeComposition.inputs.artifact.sha256 = SHA_B;
  expectCode(() => validateRuntimeEvidenceFile('runtimeComposition', serializeProducer(staleRuntimeComposition), { runtimeFiles: fixture.files }), 'composition_input_mismatch');
  expectCode(() => validateRuntimeEvidenceFile('composition', fixture.raws.runtimeComposition), 'runtime_contract_invalid');
  expectCode(() => validateRuntimeEvidenceFile('artifact', fixture.raws.artifact.trimEnd()), 'runtime_evidence_not_canonical');
});
test('rejects reordered producer keys, path substitution, and diagnostics version drift', () => {
  const fixture = runtimeRecords();
  expectCode(() => validateRuntimeEvidenceFile('artifact', serializeProducer(rotateKeys(clone(fixture.documents.artifact)))), 'schema_invalid');
  expectCode(() => validateRuntimeEvidenceFile('artifact', fixture.raws.artifact, { relativePath: 'substitute.schema.json' }), 'runtime_evidence_path_mismatch');
  const scenario = clone(fixture.documents.scenarioLab);
  scenario.diagnosticsBuild.manifest.extensionVersion = '1.0.8';
  expectCode(() => validateRuntimeEvidenceFile('scenarioLab', serializeProducer(scenario)), 'diagnostics_build_version_mismatch');
  const otherDist = clone(releaseDist);
  otherDist.worker.sha256 = 'e'.repeat(64);
  expectCode(() => validateRuntimeEvidenceFile('artifact', fixture.raws.artifact, { releaseDist: otherDist }), 'release_dist_mismatch');
  expectCode(() => assertEvidenceRedacted({ safe: 'x'.repeat(1_025) }), 'evidence_unbounded');
});

test('honors caller-provided Scenario Lab ID contracts with the existing mismatch error', () => {
  const fixture = runtimeRecords();
  const scenario = clone(fixture.documents.scenarioLab);
  scenario.scenarioLab.scenarios.ids = ['custom-scenario'];
  const raw = serializeProducer(scenario);
  expectCode(() => validateRuntimeEvidenceFile('scenarioLab', raw), 'scenario_ids_mismatch');
  assert.deepEqual(
    validateRuntimeEvidenceFile('scenarioLab', raw, { expectedScenarioIds: ['custom-scenario'] }).value.scenarioLab.scenarios.ids,
    ['custom-scenario'],
  );
  expectCode(
    () => validateRuntimeEvidenceFile('scenarioLab', raw, { expectedScenarioIds: ['different-scenario'] }),
    'scenario_ids_mismatch',
  );
});

test('rejects nonzero failure, private, unexpected, issue, and cleanup evidence in passed records', () => {
  const fixture = runtimeRecords();
  const worker = clone(fixture.documents.workerRecovery);
  worker.workerRecovery.runtimeDiagnostics[0].count = 1;
  expectCode(() => validateRuntimeEvidenceFile('workerRecovery', serializeProducer(worker)), 'passing_evidence_nonzero_failure');
  const unexpected = clone(fixture.documents.uiHistory);
  unexpected.uiHistory.network.workerUnexpected = 1;
  expectCode(() => validateRuntimeEvidenceFile('uiHistory', serializeProducer(unexpected)), 'passing_evidence_nonzero_failure');
  const privateCount = clone(fixture.documents.uiHistory);
  privateCount.uiHistory.canary.secretEvidenceOccurrences = 1;
  expectCode(() => validateRuntimeEvidenceFile('uiHistory', serializeProducer(privateCount)), 'passing_evidence_nonzero_failure');
  const providerFailure = clone(fixture.documents.organize);
  providerFailure.organize.provider.failures = 1;
  expectCode(() => validateRuntimeEvidenceFile('organize', serializeProducer(providerFailure)), 'passing_evidence_nonzero_failure');
  const issue = clone(fixture.documents.scenarioLab);
  issue.scenarioLab.issues.page = 1;
  expectCode(() => validateRuntimeEvidenceFile('scenarioLab', serializeProducer(issue)), 'passing_evidence_nonzero_failure');
  const cleanupFailure = clone(fixture.documents.artifact);
  cleanupFailure.cleanup.browserClosed = false;
  const unexpectedContainment = clone(fixture.documents.artifact);
  unexpectedContainment.containment.unexpectedNetworkRequests = 1;
  expectCode(() => validateRuntimeEvidenceFile('artifact', serializeProducer(unexpectedContainment)), 'schema_invalid');
  const privateContainment = clone(fixture.documents.artifact);
  privateContainment.containment.privatePayloadOccurrences = 1;
  expectCode(() => validateRuntimeEvidenceFile('artifact', serializeProducer(privateContainment)), 'schema_invalid');
  expectCode(() => validateRuntimeEvidenceFile('artifact', serializeProducer(cleanupFailure)), 'schema_invalid');
});

test('requires exact clean source, version, package fingerprint, and complete passed checks', () => {
  const fixture = finalizationFixture();
  assert.equal(validateRuntimeVerificationEvidence(clone(fixture.verification), { sourceCommit: COMMIT, packageVersion: VERSION, packageInput: releaseDist.packageInput, runtimeEvidence: fixture.runtime.files }).status, 'agent_runtime_verification_passed');
  const dirty = clone(fixture.verification);
  const withAdvisory = clone(fixture.verification);
  withAdvisory.build.advisories = [advisoryBlock('worker')];
  assert.equal(validateRuntimeVerificationEvidence(withAdvisory).build.advisories.length, 1);
  const longAdvisory = [
    ...Array.from({ length: 20 }, (_, index) => `dist/assets/chunk-${index}.js  530.00 kB │ gzip: 100.00 kB`),
    '(!) Some chunks are larger than 500 kB after minification. Consider:',
    '- Using dynamic import() to code-split the application',
    '- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks',
    '- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.',
  ].join('\n');
  assert.ok(Buffer.byteLength(longAdvisory) > 1024);
  const longEvidence = clone(fixture.verification);
  longEvidence.build.advisories = [longAdvisory];
  assert.equal(validateRuntimeVerificationEvidence(longEvidence).build.advisories[0], longAdvisory);
  const maliciousAdvisory = clone(fixture.verification);
  maliciousAdvisory.build.advisories = [advisoryBlock('worker').replace('https://rollupjs.org/configuration-options/#output-manualchunks', 'https://evil.example/payload')];
  expectCode(() => validateRuntimeVerificationEvidence(maliciousAdvisory), 'private_evidence_rejected');
  const maliciousChunkRow = clone(fixture.verification);
  maliciousChunkRow.build.advisories = [advisoryBlock('worker').replace('dist/assets/worker.js', 'https://evil.example/x')];
  expectCode(() => validateRuntimeVerificationEvidence(maliciousChunkRow), 'private_evidence_rejected');
  expectCode(() => assertEvidenceRedacted({ outsideAdvisory: 'https://rollupjs.org/configuration-options/#output-manualchunks' }, {
    allowedUrls: [{ path: /^\$\.build\.advisories\[\d+\]$/u, value: /^https:\/\/rollupjs\.org\/configuration-options\/#output-manualchunks$/u }],
  }), 'private_evidence_rejected');
  dirty.source.dirty = true;
  expectCode(() => validateRuntimeVerificationEvidence(dirty), 'schema_invalid');
  const missing = clone(fixture.verification);
  delete missing.checks.logic;
  expectCode(() => validateRuntimeVerificationEvidence(missing), 'schema_invalid');
  const failed = clone(fixture.verification);
  failed.checks.logic.status = 'failed';
  expectCode(() => validateRuntimeVerificationEvidence(failed), 'schema_invalid');
  expectCode(() => validateRuntimeVerificationEvidence(clone(fixture.verification), { sourceCommit: 'b'.repeat(40) }), 'source_commit_mismatch');
  expectCode(() => validateRuntimeVerificationEvidence(clone(fixture.verification), { packageVersion: '1.0.8' }), 'package_version_mismatch');
  expectCode(() => validateRuntimeVerificationEvidence(clone(fixture.verification), { packageInput: { ...releaseDist.packageInput, sha256: SHA_B } }), 'package_fingerprint_mismatch');
  const staleFiles = clone(fixture.runtime.files);
  staleFiles.artifact.sha256 = SHA_B;
  expectCode(() => validateRuntimeVerificationEvidence(clone(fixture.verification), { runtimeEvidence: staleFiles }), 'runtime_evidence_hash_mismatch');
  const obsoleteCompositionKey = clone(fixture.verification);
  obsoleteCompositionKey.runtimeEvidence.composition = obsoleteCompositionKey.runtimeEvidence.runtimeComposition;
  delete obsoleteCompositionKey.runtimeEvidence.runtimeComposition;
  expectCode(() => validateRuntimeVerificationEvidence(obsoleteCompositionKey), 'schema_invalid');
});
test('accepts the optional bounded browser identity and rejects check reordering', () => {
  const fixture = finalizationFixture();
  const browser = clone(fixture.verification);
  browser.environment.browser = { product: 'Chrome for Testing', version: '140.0.0.0' };
  assert.equal(validateRuntimeVerificationEvidence(browser).environment.browser.product, 'Chrome for Testing');
  const reordered = clone(fixture.verification);
  reordered.checks = rotateKeys(reordered.checks);
  expectCode(() => validateRuntimeVerificationEvidence(reordered), 'schema_invalid');
  expectCode(() => validateRuntimeVerificationEvidence(clone(fixture.verification), {
    releaseDist: { ...clone(releaseDist), packageInput: { ...releaseDist.packageInput, sha256: SHA_B } },
  }), 'release_dist_fingerprint_mismatch');
  const overlapping = clone(fixture.verification);
  overlapping.checks.fullVitest.startedAt = overlapping.checks.typecheck.startedAt;
  expectCode(() => validateRuntimeVerificationEvidence(overlapping), 'check_timestamp_invalid');
});

test('keeps provisional evidence immutable and non-ready until finalization', () => {
  const provisional = provisionalEvidence();
  assert.equal(validateProvisionalReleaseEvidence(clone(provisional), { sourceCommit: COMMIT, packageVersion: VERSION, packageInput: releaseDist.packageInput }).package.releaseReady, false);
  const ready = clone(provisional);
  ready.package.releaseReady = true;
  expectCode(() => validateProvisionalReleaseEvidence(ready), 'schema_invalid');
  expectCode(() => validateProvisionalReleaseEvidence(clone(provisional), { sourceCommit: 'b'.repeat(40) }), 'source_commit_mismatch');
  expectCode(() => validateProvisionalReleaseEvidence(clone(provisional), { packageVersion: '1.0.8' }), 'package_version_mismatch');
  expectCode(() => validateProvisionalReleaseEvidence(clone(provisional), { packageInput: { ...releaseDist.packageInput, fileCount: 10 } }), 'package_fingerprint_mismatch');
});


test('infers the Edge worker baseline from provisional evidence', () => {
  const edge = edgeProvisionalEvidence();
  assert.equal(validateProvisionalReleaseEvidence(clone(edge)).browserTarget, 'edge');

  const chromeWorker = clone(edge);
  chromeWorker.build.worker = {
    relativePath: RELEASE_WORKER_BASELINE.relativePath,
    bytes: RELEASE_WORKER_BASELINE.bytes,
    kib: RELEASE_WORKER_BASELINE.bytes / 1024,
    sha256: RELEASE_WORKER_BASELINE.sha256,
  };
  expectCode(
    () => validateProvisionalReleaseEvidence(chromeWorker),
    'worker_release_baseline_mismatch',
  );
});
test('validates explicit Firefox package evidence without changing the Chrome schema', () => {
  const dist = firefoxReleaseDist();
  const provisional = firefoxProvisionalEvidence();
  assert.equal(validateProvisionalReleaseEvidence(clone(provisional), {
    browserTarget: 'firefox',
    releaseDist: dist,
    sourceCommit: COMMIT,
    packageVersion: VERSION,
    packageInput: dist.packageInput,
  }).browserTarget, 'firefox');
  assert.equal(validateProvisionalReleaseEvidence(provisionalEvidence()).schemaVersion, 2);

  const crossTarget = clone(provisionalEvidence());
  crossTarget.browserTarget = 'firefox';
  expectCode(() => validateProvisionalReleaseEvidence(crossTarget), 'schema_invalid');
  const wrongArtifact = clone(provisional);
  wrongArtifact.generatedFiles.find(({ relativePath }) => relativePath.endsWith(`${VERSION}.zip`)).relativePath = `better-github-stars-manager-firefox-${VERSION}.tar`;
  expectCode(() => validateProvisionalReleaseEvidence(wrongArtifact), 'generated_file_set_mismatch');
  const serviceWorkerClaim = clone(provisional);
  serviceWorkerClaim.packagedManifest.background.kind = 'service_worker';
  expectCode(() => validateProvisionalReleaseEvidence(serviceWorkerClaim), 'schema_invalid');
  const publicationClaim = clone(provisional);
  publicationClaim.package.publicationClaimed = true;
  expectCode(() => validateProvisionalReleaseEvidence(publicationClaim), 'schema_invalid');
});

test('requires real Firefox 140 and stable scenario evidence', () => {
  const runtime = runtimeRecords();
  const provisionalRaw = canonical(firefoxProvisionalEvidence());
  const verification = firefoxVerificationEvidence(
    runtime.files,
    createFileEvidence(`release-evidence-${VERSION}.provisional.json`, provisionalRaw),
  );
  assert.equal(validateRuntimeVerificationEvidence(clone(verification), {
    browserTarget: 'firefox',
    releaseDist: firefoxReleaseDist(),
    sharedRuntimeReleaseDist: releaseDist,
  }).firefox.runs.length, 2);

  const missing140 = clone(verification);
  missing140.firefox.runs[0].browserVersion = '141.0';
  expectCode(() => validateRuntimeVerificationEvidence(missing140), 'firefox_140_evidence_missing');
  const unsupportedStable = clone(verification);
  unsupportedStable.firefox.runs[1].browserVersion = '140.0.5';
  expectCode(() => validateRuntimeVerificationEvidence(unsupportedStable), 'firefox_stable_evidence_missing');
  const substituted = clone(verification);
  substituted.firefox.runs[1].executablePathSha256 = substituted.firefox.runs[0].executablePathSha256;
  expectCode(() => validateRuntimeVerificationEvidence(substituted), 'firefox_browser_substitution');
  const missingScenario = clone(verification);
  missingScenario.firefox.runs[0].scenarioIds = missingScenario.firefox.runs[0].scenarioIds.slice(1);
  expectCode(() => validateRuntimeVerificationEvidence(missingScenario), 'schema_invalid');
  const mismatchedSharedRuntime = clone(verification);
  mismatchedSharedRuntime.sharedRuntimeReleaseDist.worker.sha256 = '0'.repeat(64);
  expectCode(
    () => validateRuntimeVerificationEvidence(mismatchedSharedRuntime, {
      browserTarget: 'firefox',
      releaseDist: firefoxReleaseDist(),
      sharedRuntimeReleaseDist: releaseDist,
    }),
    'shared_runtime_release_dist_mismatch',
  );
  const missingSharedRuntime = clone(verification);
  delete missingSharedRuntime.sharedRuntimeReleaseDist;
  expectCode(() => validateRuntimeVerificationEvidence(missingSharedRuntime), 'schema_invalid');
});
test('finalizes Firefox package evidence against the bound shared Chrome runtime', () => {
  const fixture = firefoxFinalizationFixture();
  const prepared = prepareReleaseFinalization(fixture.input);
  assert.equal(prepared.final.value.browserTarget, 'firefox');
  assert.equal(prepared.final.value.firefox.runs.length, 2);
  assert.equal(prepared.gate.value.browserTarget, 'firefox');

  const missingSharedRuntime = firefoxFinalizationFixture();
  delete missingSharedRuntime.input.sharedRuntimeReleaseDist;
  expectCode(() => prepareReleaseFinalization(missingSharedRuntime.input), 'release_dist_invalid');

  const substitutedSharedRuntime = firefoxFinalizationFixture();
  substitutedSharedRuntime.input.sharedRuntimeReleaseDist.worker.sha256 = '0'.repeat(64);
  expectCode(() => prepareReleaseFinalization(substitutedSharedRuntime.input), 'release_dist_mismatch');
});


test('validates exact worker baseline, Mermaid, advisory, output, and optional-permission evidence', () => {
  const overBaseline = provisionalEvidence();
  overBaseline.build.worker.bytes = RELEASE_WORKER_BASELINE.bytes + 1;
  overBaseline.build.worker.kib = overBaseline.build.worker.bytes / 1024;
  expectCode(() => validateProvisionalReleaseEvidence(overBaseline), 'worker_release_baseline_mismatch');
  const underBaseline = provisionalEvidence();
  underBaseline.build.worker.bytes = RELEASE_WORKER_BASELINE.bytes - 1;
  underBaseline.build.worker.kib = underBaseline.build.worker.bytes / 1024;
  expectCode(() => validateProvisionalReleaseEvidence(underBaseline), 'worker_release_baseline_mismatch');
  const wrongWorkerHash = provisionalEvidence();
  wrongWorkerHash.build.worker.sha256 = '0'.repeat(64);
  expectCode(() => validateProvisionalReleaseEvidence(wrongWorkerHash), 'worker_release_baseline_mismatch');
  const reversedMermaid = provisionalEvidence();
  reversedMermaid.build.mermaid = [
    { relativePath: 'assets/mermaid-z.js', bytes: 1, kib: 1 / 1024, sha256: SHA_A },
    { relativePath: 'assets/mermaid-a.js', bytes: 1, kib: 1 / 1024, sha256: SHA_B },
  ];
  expectCode(() => validateProvisionalReleaseEvidence(reversedMermaid), 'sorted_unique_required');
  const invalidOutputDigest = provisionalEvidence();
  invalidOutputDigest.build.outputSha256 = 'short';
  expectCode(() => validateProvisionalReleaseEvidence(invalidOutputDigest), 'schema_invalid');
  const missingOptionalPermissions = provisionalEvidence();
  delete missingOptionalPermissions.packagedPermissions.optionalPermissions;
  expectCode(() => validateProvisionalReleaseEvidence(missingOptionalPermissions), 'schema_invalid');
  expectCode(() => validateProvisionalReleaseEvidence(provisionalEvidence(), { build: { ...provisionalEvidence().build, outputSha256: SHA_B } }), 'provisional_build_mismatch');
});
test('binds package inventory ordering and full release identity', () => {
  const valid = provisionalEvidence();
  assert.equal(validateProvisionalReleaseEvidence(clone(valid), { releaseDist }).package.releaseReady, false);
  const reordered = rotateKeys(clone(valid));
  expectCode(() => validateProvisionalReleaseEvidence(reordered), 'schema_invalid');
  const wrongManifest = clone(valid);
  wrongManifest.packagedManifest.sha256 = SHA_A;
  expectCode(() => validateProvisionalReleaseEvidence(wrongManifest, { releaseDist }), 'packaged_manifest_identity_mismatch');
  const wrongWorker = clone(valid);
  wrongWorker.manifestResources[0].sha256 = SHA_A;
  expectCode(() => validateProvisionalReleaseEvidence(wrongWorker, { releaseDist }), 'manifest_resource_identity_mismatch');
  const wrongGeneratedFile = clone(valid);
  wrongGeneratedFile.generatedFiles[0].relativePath = 'better-github-stars-manager-1.0.9.tar';
  expectCode(() => validateProvisionalReleaseEvidence(wrongGeneratedFile), 'generated_file_set_mismatch');
  const unsafeHost = clone(valid);
  unsafeHost.packagedPermissions.hostPermissions = ['https://user:pass@example.com/*'];
  expectCode(() => validateProvisionalReleaseEvidence(unsafeHost), 'schema_invalid');
});
test('requires an explicit approved candidate strictly above public and prior-upload versions', () => {
  const approval = { approvedCandidateVersion: '1.0.9', observedCurrentPublicVersion: '1.0.8', observedPriorUploadVersion: '1.0.8' };
  assert.equal(validateReleaseVersionApproval(clone(approval), '1.0.9').approvedCandidateVersion, '1.0.9');
  expectCode(() => validateReleaseVersionApproval({ ...approval, observedCurrentPublicVersion: '1.0.9' }, '1.0.9'), 'approved_candidate_not_newer');
  expectCode(() => validateReleaseVersionApproval({ approvedCandidateVersion: '1.0.7', observedCurrentPublicVersion: '1.0.8', observedPriorUploadVersion: '1.0.6' }, '1.0.7'), 'approved_candidate_not_newer');
  expectCode(() => validateReleaseVersionApproval({ ...approval, approvedCandidateVersion: '1.0.09' }, '1.0.09'), 'schema_invalid');
  expectCode(() => validateReleaseVersionApproval(approval, '1.0.10'), 'approved_candidate_version_mismatch');
  expectCode(() => assertReleaseVersionIdentity({ packageVersion: '1.0.9', releaseDist: { ...releaseDist, manifest: { ...releaseDist.manifest, extensionVersion: '1.0.8' } } }), 'release_version_identity_mismatch');
});

test('prepares a distinct final and gate record bound to unchanged inputs', () => {
  const fixture = finalizationFixture();
  const provisionalBefore = fixture.input.provisionalRaw;
  const prepared = prepareReleaseFinalization(fixture.input);
  const mismatchedGate = clone(prepared.gate.value);
  mismatchedGate.packageVersion = '1.0.10';
  expectCode(() => validatePublishedReleaseGate({
    finalRaw: prepared.final.bytes,
    gateRaw: canonical(mismatchedGate),
    finalRelativePath: fixture.input.finalRelativePath,
  }), 'release_version_identity_mismatch');
  assert.equal(fixture.input.provisionalRaw, provisionalBefore);
  assert.equal(prepared.final.value.package.releaseReady, true);
  assert.equal(prepared.gate.value.status, 'release_ready_verified');
  assert.equal(prepared.gate.value.claims.dashboardSubmissionClaimed, false);
  assert.notEqual(prepared.provisionalFile.relativePath, prepared.final.file.relativePath);
  assert.equal(Object.isFrozen(prepared), true);
  const obsoleteGateKey = clone(prepared.gate.value);
  obsoleteGateKey.runtimeEvidence.composition = obsoleteGateKey.runtimeEvidence.runtimeComposition;
  delete obsoleteGateKey.runtimeEvidence.runtimeComposition;
  expectCode(() => validatePublishedReleaseGate({
    finalRaw: prepared.final.bytes,
    gateRaw: canonical(obsoleteGateKey),
    finalRelativePath: fixture.input.finalRelativePath,
  }), 'schema_invalid');
  assert.equal(validatePublishedReleaseGate({ finalRaw: prepared.final.bytes, gateRaw: prepared.gate.bytes, finalRelativePath: fixture.input.finalRelativePath }).gateValue.status, 'release_ready_verified');
});
test('rejects final and gate timestamp, build, manual-exclusion, and key-order drift', () => {
  const fixture = finalizationFixture();
  const prepared = prepareReleaseFinalization(fixture.input);
  const wrongBuild = clone(prepared.gate.value);
  wrongBuild.build.worker.sha256 = SHA_A;
  expectCode(() => validatePublishedReleaseGate({ finalRaw: prepared.final.bytes, gateRaw: canonical(wrongBuild), finalRelativePath: fixture.input.finalRelativePath }), 'published_build_mismatch');
  const wrongTime = clone(prepared.gate.value);
  wrongTime.generatedAt = FINALIZED;
  expectCode(() => validatePublishedReleaseGate({ finalRaw: prepared.final.bytes, gateRaw: canonical(wrongTime), finalRelativePath: fixture.input.finalRelativePath }), 'published_timestamp_mismatch');
  const missingManual = clone(prepared.gate.value);
  missingManual.manualExclusions = missingManual.manualExclusions.slice(1);
  expectCode(() => validatePublishedReleaseGate({ finalRaw: prepared.final.bytes, gateRaw: canonical(missingManual), finalRelativePath: fixture.input.finalRelativePath }), 'manual_exclusions_invalid');
  expectCode(() => validatePublishedReleaseGate({ finalRaw: prepared.final.bytes, gateRaw: canonical(rotateKeys(clone(prepared.gate.value))), finalRelativePath: fixture.input.finalRelativePath }), 'schema_invalid');
});
test('derives composition outcomes from the six bound producer records', () => {
  const fixture = finalizationFixture();
  fixture.runtime.documents.organize.organize.ownership.ownerObserverConverged = false;
  fixture.runtime.raws.organize = serializeProducer(fixture.runtime.documents.organize);
  fixture.runtime.files.organize = createFileEvidence(RUNTIME_EVIDENCE_CONTRACTS.organize.filename, fixture.runtime.raws.organize);
  fixture.runtime.documents.runtimeComposition.inputs.organize = {
    ...fixture.runtime.documents.runtimeComposition.inputs.organize,
    bytes: fixture.runtime.files.organize.bytes,
    sha256: fixture.runtime.files.organize.sha256,
  };
  fixture.runtime.raws.runtimeComposition = serializeProducer(fixture.runtime.documents.runtimeComposition);
  fixture.runtime.files.runtimeComposition = createFileEvidence(RUNTIME_EVIDENCE_CONTRACTS.runtimeComposition.filename, fixture.runtime.raws.runtimeComposition);
  fixture.verification.runtimeEvidence = clone(fixture.runtime.files);
  fixture.input.runtimeEvidenceRaw = fixture.runtime.raws;
  fixture.input.runtimeVerificationRaw = canonical(fixture.verification);
  expectCode(() => prepareReleaseFinalization(fixture.input), 'composition_outcome_mismatch');
});


test('binds verbatim provisional advisory blocks into the final gate digest', () => {
  const fixture = finalizationFixture();
  const advisory = advisoryBlock('worker');
  fixture.provisional.build.advisories = [advisory];
  fixture.verification.build.advisories = [advisory];
  fixture.input.provisionalRaw = canonical(fixture.provisional);
  fixture.verification.provisionalReleaseEvidence = createFileEvidence(fixture.input.provisionalRelativePath, fixture.input.provisionalRaw);
  fixture.input.runtimeVerificationRaw = canonical(fixture.verification);
  const prepared = prepareReleaseFinalization(fixture.input);
  assert.equal(prepared.final.value.build.advisories[0], advisory);
  assert.equal(prepared.gate.value.build.advisorySha256, createHash('sha256').update(advisory).digest('hex'));
});

test('plans final-first gate-last publication and deterministic crash recovery', () => {
  const fixture = finalizationFixture();
  const prepared = prepareReleaseFinalization(fixture.input);
  const paths = { provisional: fixture.input.provisionalRelativePath, runtime: fixture.input.runtimeVerificationRelativePath, final: fixture.input.finalRelativePath, gate: fixture.input.gateRelativePath };
  const initial = planEvidencePublication(prepared, paths, 'transaction-1');
  assert.deepEqual(initial.actions.map(({ operation, kind }) => `${operation}:${kind}`), ['writeExclusive:final', 'writeExclusive:gate', 'rename:final', 'rename:gate']);
  assert.equal(initial.actions.at(-1).to, paths.gate);
  assert.equal(initial.actions.filter(({ operation }) => operation === 'writeExclusive').every(({ mode }) => mode === 0o600), true);
  const recovery = planEvidencePublication(prepared, paths, 'transaction-1', { final: prepared.final.bytes });
  assert.equal(recovery.status, 'recover_gate');
  assert.deepEqual(recovery.actions.map(({ kind }) => kind), ['gate', 'gate']);
  let wallClock = Date.parse(FINALIZED);
  wallClock += 60_000;
  assert.equal(new Date(wallClock).toISOString(), '2026-08-09T00:01:03.000Z');
  const freshInvocation = finalizationFixture();
  const freshPrepared = prepareReleaseFinalization(freshInvocation.input);
  assert.equal(freshPrepared.final.bytes, prepared.final.bytes);
  assert.equal(freshPrepared.gate.bytes, prepared.gate.bytes);
  const freshRecovery = planEvidencePublication(freshPrepared, paths, 'transaction-2', { final: prepared.final.bytes });
  assert.equal(freshRecovery.status, 'recover_gate');
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'release-publication-crash-'));
  const applyAction = (action) => {
    const absolute = path.join(tempRoot, action.operation === 'rename' ? action.to : action.path);
    mkdirSync(path.dirname(absolute), { recursive: true });
    if (action.operation === 'writeExclusive') {
      writeFileSync(absolute, action.bytes, { flag: 'wx', mode: action.mode });
    } else {
      renameSync(path.join(tempRoot, action.from), absolute);
    }
  };
  try {
    for (const action of initial.actions.slice(0, 3)) applyAction(action);
    const finalPath = path.join(tempRoot, paths.final);
    const gatePath = path.join(tempRoot, paths.gate);
    assert.equal(existsSync(finalPath), true);
    assert.equal(existsSync(gatePath), false);
    const recoveredPlan = planEvidencePublication(freshPrepared, paths, 'transaction-3', { final: readFileSync(finalPath) });
    assert.equal(recoveredPlan.status, 'recover_gate');
    for (const action of recoveredPlan.actions) applyAction(action);
    assert.equal(readFileSync(gatePath, 'utf8'), freshPrepared.gate.bytes);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  assert.deepEqual(planEvidencePublication(prepared, paths, 'transaction-1', { final: prepared.final.bytes, gate: prepared.gate.bytes }), { status: 'already_published', actions: [], cleanup: [] });
  expectCode(() => planEvidencePublication(prepared, paths, 'transaction-1', { gate: prepared.gate.bytes }), 'published_gate_without_final');
  expectCode(() => planEvidencePublication(prepared, paths, 'transaction-1', { final: '{}\n' }), 'published_final_mismatch');
  expectCode(() => planEvidencePublication(prepared, paths, 'transaction-1', { final: prepared.final.bytes, gate: '{}\n' }), 'published_gate_mismatch');
  expectCode(() => planEvidencePublication(prepared, { ...paths, gate: paths.final }, 'transaction-1'), 'publication_paths_not_distinct');
  expectCode(() => planEvidencePublication(prepared, { ...paths, provisional: 'artifacts/substitute.provisional.json' }, 'transaction-1'), 'publication_path_mismatch');
  expectCode(() => planEvidencePublication(prepared, { ...paths, final: 'artifacts/substitute-final.json' }, 'transaction-1'), 'publication_path_mismatch');
  const tamperedPrepared = clone(prepared);
  tamperedPrepared.final.bytes = '{}\n';
  expectCode(() => planEvidencePublication(tamperedPrepared, paths, 'transaction-1'), 'prepared_evidence_mismatch');
  const substitutedProvisional = clone(prepared);
  substitutedProvisional.provisionalFile.sha256 = SHA_B;
  expectCode(() => planEvidencePublication(substitutedProvisional, paths, 'transaction-1'), 'prepared_evidence_mismatch');
  const substitutedRuntime = clone(prepared);
  substitutedRuntime.runtimeFile.bytes += 1;
  expectCode(() => planEvidencePublication(substitutedRuntime, paths, 'transaction-1'), 'prepared_evidence_mismatch');
  const unsafePrepared = clone(prepared);
  const unsafeGate = clone(prepared.gate.value);
  unsafeGate.claims.sourceVerified = false;
  unsafePrepared.gate.bytes = canonical(unsafeGate);
  unsafePrepared.gate.file = createFileEvidence(paths.gate, unsafePrepared.gate.bytes);
  expectCode(() => planEvidencePublication(unsafePrepared, paths, 'transaction-1'), 'schema_invalid');
  expectCode(() => planEvidencePublication(prepared, paths, 'transaction-1', { unknown: prepared.final.bytes }), 'publication_existing_invalid');
});

test('refuses finalization across dirty identity, missing-check, and provisional crash windows', () => {
  const source = finalizationFixture();
  source.input.sourceCommit = 'b'.repeat(40);
  expectCode(() => prepareReleaseFinalization(source.input), 'source_commit_mismatch');
  const version = finalizationFixture();
  version.input.packageVersion = '1.0.10';
  version.input.versionApproval = { approvedCandidateVersion: '1.0.10', observedCurrentPublicVersion: '1.0.9', observedPriorUploadVersion: '1.0.9' };
  version.input.provisionalRelativePath = 'release-evidence-1.0.10.provisional.json';
  version.input.finalRelativePath = 'release-evidence-1.0.10.json';
  expectCode(() => prepareReleaseFinalization(version.input), 'release_version_identity_mismatch');
  const fingerprint = finalizationFixture();
  fingerprint.input.packageInput = { ...releaseDist.packageInput, sha256: SHA_B };
  expectCode(() => prepareReleaseFinalization(fingerprint.input), 'package_fingerprint_mismatch');
  const missing = finalizationFixture();
  delete missing.verification.checks.logic;
  missing.input.runtimeVerificationRaw = canonical(missing.verification);
  expectCode(() => prepareReleaseFinalization(missing.input), 'schema_invalid');
  const whitespace = finalizationFixture();
  whitespace.input.provisionalRaw += '\n';
  expectCode(() => prepareReleaseFinalization(whitespace.input), 'evidence_not_canonical');
  const noApproval = finalizationFixture();
  delete noApproval.input.versionApproval;
  expectCode(() => prepareReleaseFinalization(noApproval.input), 'schema_invalid');
  const missingPackagedVersion = finalizationFixture();
  delete missingPackagedVersion.input.packagedManifestVersion;
  expectCode(() => prepareReleaseFinalization(missingPackagedVersion.input), 'packaged_manifest_version_required');
  const missingZipVersion = finalizationFixture();
  delete missingZipVersion.input.zipManifestVersion;
  expectCode(() => prepareReleaseFinalization(missingZipVersion.input), 'zip_manifest_version_required');
  const wrongZipVersion = finalizationFixture();
  wrongZipVersion.input.zipManifestVersion = '1.0.8';
  expectCode(() => prepareReleaseFinalization(wrongZipVersion.input), 'release_version_identity_mismatch');
  const changingClock = finalizationFixture();
  changingClock.input.publicationTimestamp = FINALIZED;
  expectCode(() => prepareReleaseFinalization(changingClock.input), 'publication_timestamp_mismatch');
  const lateProvisional = finalizationFixture();
  lateProvisional.provisional.generatedAt = FINALIZED;
  lateProvisional.input.provisionalRaw = canonical(lateProvisional.provisional);
  lateProvisional.verification.provisionalReleaseEvidence = createFileEvidence(lateProvisional.input.provisionalRelativePath, lateProvisional.input.provisionalRaw);
  lateProvisional.input.runtimeVerificationRaw = canonical(lateProvisional.verification);
  expectCode(() => prepareReleaseFinalization(lateProvisional.input), 'provisional_timestamp_invalid');
  const unknownRuntime = finalizationFixture();
  unknownRuntime.input.runtimeEvidenceRaw.extra = '{}\n';
  const missingRuntime = finalizationFixture();
  delete missingRuntime.input.runtimeEvidenceRaw.uiHistory;
  expectCode(() => prepareReleaseFinalization(missingRuntime.input), 'schema_invalid');
  expectCode(() => prepareReleaseFinalization(unknownRuntime.input), 'schema_invalid');
  const reorderedRuntime = finalizationFixture();
  reorderedRuntime.input.runtimeEvidenceRaw = rotateKeys(reorderedRuntime.input.runtimeEvidenceRaw);
  expectCode(() => prepareReleaseFinalization(reorderedRuntime.input), 'schema_invalid');
  const missingManual = finalizationFixture();
  missingManual.input.manualExclusions = missingManual.input.manualExclusions.slice(1);
  expectCode(() => prepareReleaseFinalization(missingManual.input), 'manual_exclusions_invalid');
  const wrongPath = finalizationFixture();
  wrongPath.input.provisionalRelativePath = 'nested/release-evidence-1.0.9.provisional.json';
  expectCode(() => prepareReleaseFinalization(wrongPath.input), 'publication_path_mismatch');
  const impossibleTimestamp = finalizationFixture();
  impossibleTimestamp.input.publicationTimestamp = '2026-02-31T00:00:00.000Z';
  expectCode(() => prepareReleaseFinalization(impossibleTimestamp.input), 'timestamp_invalid');
});
