#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRuntimeReleaseDistIdentity,
  MAX_RUNTIME_EVIDENCE_BYTES,
  publishRuntimeEvidence,
  RuntimeEvidenceError,
  serializeRuntimeEvidence,
} from '../../scripts/agent-runtime-evidence-contract.mjs';

const OUTPUT_FILENAME = 'agent-runtime-composition.schema.json';
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]{1,160}$/u;
const SAFE_RELATIVE_JAVASCRIPT = /^[A-Za-z0-9._/-]+\.js$/u;
const EXPECTED_SCENARIO_IDS = Object.freeze([
  'small-window-multiple-tools',
  'overflow-then-success',
  'malformed-summary-fallback',
  'cancel-during-compaction',
  'agent-port-disconnect',
  'organize-cross-batch-recovery',
  'organize-cancel-during-apply',
  'organize-port-reconnect',
  'cubby-artifact-continuation-coverage',
]);
const WORKER_SCENARIO_IDS = Object.freeze([
  'committed_replay',
  'statically_read_only_resume',
  'state_uncertain_abandonment',
]);

const PRODUCERS = Object.freeze([
  Object.freeze({ key: 'artifact', filename: 'agent-artifact.schema.json', scope: 'packaged_durable_artifact', factsKey: 'artifactFlow' }),
  Object.freeze({ key: 'workerRecovery', filename: 'agent-worker-recovery.schema.json', scope: 'packaged_worker_recovery', factsKey: 'workerRecovery' }),
  Object.freeze({ key: 'uiHistory', filename: 'agent-ui-history.schema.json', scope: 'packaged_ui_history', factsKey: 'uiHistory' }),
  Object.freeze({ key: 'organize', filename: 'organize-job.schema.json', scope: 'packaged_organize_job', factsKey: 'organize' }),
  Object.freeze({ key: 'organizeRecovery', filename: 'organize-job-recovery.schema.json', scope: 'packaged_organize_recovery', factsKey: 'organizeRecovery' }),
  Object.freeze({ key: 'scenarioLab', filename: 'agent-scenarios.schema.json', scope: 'development_scenario_lab', factsKey: 'scenarioLab', scenario: true }),
]);

const RULE = Symbol('runtime-composition-rule');
const NONNEGATIVE = rule('nonnegative integer', (value) => Number.isSafeInteger(value) && value >= 0);
const POSITIVE = rule('positive integer', (value) => Number.isSafeInteger(value) && value > 0);
const AT_LEAST_TWELVE = rule('integer at least twelve', (value) => Number.isSafeInteger(value) && value >= 12);
const IDENTIFIER = rule('bounded identifier', (value) => typeof value === 'string' && SAFE_IDENTIFIER.test(value));
const RELATIVE_JAVASCRIPT_PATH = rule('relative JavaScript path', (value) => {
  if (typeof value !== 'string' || value.length > 240 || value.startsWith('/') || value.includes('\\') || !SAFE_RELATIVE_JAVASCRIPT.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
});
const RELEASE_DIST = rule('release dist identity', (value) => {
  try {
    assertRuntimeReleaseDistIdentity(value);
    return true;
  } catch {
    return false;
  }
});

const CONTAINMENT_SCHEMA = Object.freeze({
  networkFailClosed: true,
  unexpectedNetworkRequests: 0,
  rawCredentialOccurrences: 0,
  privatePayloadOccurrences: 0,
  overflow: false,
});
const CLEANUP_SCHEMA = Object.freeze({
  networkGatesClosed: true,
  diagnosticsDetached: true,
  pagesClosed: true,
  browserClosed: true,
  temporaryStateRemoved: true,
});

const ARTIFACT_FLOW_SCHEMA = Object.freeze({
  provider: {
    requests: POSITIVE,
    sourceRequests: 1,
    locatingReads: 2,
    exhaustivePageReads: POSITIVE,
    ordinaryBoundaries: POSITIVE,
    provisionalFinals: 1,
    correctiveReprompts: 1,
    finalResponses: 1,
  },
  coverage: {
    firstPageOmittedCursor: true,
    cursorChainExact: true,
    pageCount: POSITIVE,
    expectedBytes: POSITIVE,
    deliveredBytes: POSITIVE,
    nextCursorNull: true,
    artifactDigestPresent: true,
    manifestDigestPresent: true,
    cursorChainDigestPresent: true,
    chunksMatchManifest: true,
  },
  canonical: {
    sourceToolRows: 1,
    readerRows: 0,
    prematureAssistantRows: 0,
    finalAssistantRows: 1,
    receiptCount: 1,
  },
  settlement: {
    commitApplied: true,
    revisionDelta: 1,
    recoveryRows: 0,
    continuationPresent: false,
    leasePresent: false,
  },
});

const WORKER_RECOVERY_SCHEMA = Object.freeze({
  scenarios: arrayOf({
    id: IDENTIFIER,
    providerRequests: NONNEGATIVE,
    toolCalls: NONNEGATIVE,
    toolResults: NONNEGATIVE,
    interruptions: NONNEGATIVE,
    replacements: NONNEGATIVE,
    revisionDelta: NONNEGATIVE,
    writeDelta: NONNEGATIVE,
    receiptCount: NONNEGATIVE,
    recoveryRows: NONNEGATIVE,
  }, { length: 3 }),
  replacements: arrayOf({
    scenarioId: IDENTIFIER,
    oldVersionId: IDENTIFIER,
    newVersionId: IDENTIFIER,
    oldTargetId: IDENTIFIER,
    newTargetId: IDENTIFIER,
    oldAttachmentId: IDENTIFIER,
    newAttachmentId: IDENTIFIER,
    scriptRelativePath: RELATIVE_JAVASCRIPT_PATH,
    lifecycleMode: 'stopped_target_preinstalled',
    stopCommandOrdinal: POSITIVE,
    stoppedOrdinal: POSITIVE,
    installCompletedOrdinal: POSITIVE,
    startCommandOrdinal: POSITIVE,
    runningOrdinal: POSITIVE,
  }, { length: 3 }),
  productEpochs: arrayOf({
    scenarioId: IDENTIFIER,
    oldEpochId: IDENTIFIER,
    newEpochId: IDENTIFIER,
  }, { length: 3 }),
  durableRecovery: {
    beforeReplacement: {
      recoveryRows: POSITIVE,
      pendingCoverage: POSITIVE,
      completeCoverage: 0,
      cursorAuthority: true,
      continuationPresent: true,
      leasePresent: true,
      canonicalPromptResidue: false,
      recoveryAuthorityPresent: true,
      provisionalTranscriptResidue: false,
    },
    afterCommit: {
      recoveryRows: 0,
      pendingCoverage: 0,
      completeCoverage: POSITIVE,
      continuationPresent: false,
      leasePresent: false,
      receiptPresent: true,
      canonicalSourceRows: POSITIVE,
      canonicalFinalRows: POSITIVE,
      canonicalSourcePairs: POSITIVE,
      provisionalTranscriptResidue: false,
    },
    stateUncertain: {
      state: 'state_uncertain',
      terminalReason: 'attempt_state_lost',
      writeSettlement: 'unsafe',
      automaticProviderRequests: 0,
      automaticToolResults: 0,
      writeDelta: 0,
      receiptCount: 0,
      recoveryRows: 0,
      continuationPresent: false,
      leasePresent: false,
    },
    afterAbandonment: {
      state: 'terminal_non_retryable',
      terminalReason: 'abandoned',
      writeSettlement: 'unsafe',
      receiptCount: 0,
      recoveryRows: 0,
      continuationPresent: false,
      leasePresent: false,
      freshTurnState: 'committed',
      freshRevisionDelta: 1,
      freshReceiptCount: 1,
    },
  },
  runtimeDiagnostics: arrayOf({ scenarioId: IDENTIFIER, count: 0, overflow: false }, { length: 3 }),
});

const UI_HISTORY_SCHEMA = Object.freeze({
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
  provider: {
    requests: POSITIVE,
    connectionRequests: 2,
    scenarioRequests: POSITIVE,
    http503Responses: 1,
    selectedScenarioTools: 0,
    authenticatedRequests: POSITIVE,
    failures: 0,
    interruptions: 0,
  },
  network: {
    browserFailClosed: true,
    workerFixtures: NONNEGATIVE,
    workerUnexpected: 0,
    pageExpected: NONNEGATIVE,
    pageUnexpected: 0,
    pageIssues: 0,
    overflow: false,
  },
  canary: {
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
});

const ORGANIZE_SCHEMA = Object.freeze({
  configuration: { transientProbeRequests: 2, savedCredentialUnchanged: true, savedCapabilityReady: true },
  corruption: { activeCheckpointDiscarded: true, blockedCheckpointReplaced: true, duplicateStartIdempotent: true },
  start: { preflightRows: 501, admittedRows: 1 },
  budget: { frozenRows: 501, providerAttemptsBeforeContinuation: 7, continuationCount: 2, completed: true },
  detach: { detachedWhileActive: true, terminalRetainedUntilDismiss: true },
  ownership: {
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
  },
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
    retainedTerminalRows: 1,
    retainedApplyRows: 501,
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
  nextAdmission: {
    actorPages: 1,
    observerPages: 1,
    noJobProjectionPages: 2,
    oldTerminalRows: 0,
    oldApplyRows: 0,
    newPreflightRows: 1,
    providerRequestDelta: 0,
    pagesConverged: true,
  },
  dismiss: {
    actorPages: 1,
    convergedPages: 2,
    dismissedTerminalRows: 0,
    dismissedApplyRows: 0,
    pagesConverged: true,
  },
  provider: {
    requests: POSITIVE,
    authenticatedRequests: POSITIVE,
    githubFixtureRequests: POSITIVE,
    unexpectedRequests: 0,
    failures: 0,
    overflow: false,
    customHostDeniedFetches: 0,
  },
});

const ORGANIZE_RECOVERY_SCHEMA = Object.freeze({
  replacement: {
    scenarioId: IDENTIFIER,
    oldVersionId: IDENTIFIER,
    newVersionId: IDENTIFIER,
    oldTargetId: IDENTIFIER,
    newTargetId: IDENTIFIER,
    oldAttachmentId: IDENTIFIER,
    newAttachmentId: IDENTIFIER,
    scriptRelativePath: RELATIVE_JAVASCRIPT_PATH,
    lifecycleMode: 'paused_target_auto_attached',
    stopCommandOrdinal: POSITIVE,
    stoppedOrdinal: POSITIVE,
    installCompletedOrdinal: POSITIVE,
    startCommandOrdinal: POSITIVE,
    runningOrdinal: POSITIVE,
  },
  epochs: { oldEpochId: IDENTIFIER, newEpochId: IDENTIFIER },
  outcome: {
    runIdStable: true,
    generationStable: true,
    firstPageAttempts: 2,
    retriedFirstPage: true,
    settledCount: 501,
    uniqueSettledPositionCount: 501,
    providerAttemptCount: 21,
    duplicateProviderRequests: 1,
    terminalStatus: 'review',
  },
  provider: { requests: 22, interruptions: 1, failures: 0 },
});

const SCENARIO_LAB_SCHEMA = Object.freeze({
  scenarios: {
    ids: arrayOf(IDENTIFIER, { length: EXPECTED_SCENARIO_IDS.length }),
    rootCount: EXPECTED_SCENARIO_IDS.length,
    eventCount: POSITIVE,
    completedCount: 7,
    cancelledCount: 2,
    failedCount: 0,
    lastEventTerminal: true,
    artifactContinuationProviderRequests: AT_LEAST_TWELVE,
    writeOutcomeEvents: 0,
  },
  rawCapture: { warningRendered: true, armedBeforeReload: true, disarmedAfterReload: true },
  issues: { page: 0, worker: 0 },
});

const FACT_SCHEMAS = Object.freeze({
  artifact: ARTIFACT_FLOW_SCHEMA,
  workerRecovery: WORKER_RECOVERY_SCHEMA,
  uiHistory: UI_HISTORY_SCHEMA,
  organize: ORGANIZE_SCHEMA,
  organizeRecovery: ORGANIZE_RECOVERY_SCHEMA,
  scenarioLab: SCENARIO_LAB_SCHEMA,
});

export class RuntimeCompositionError extends Error {
  constructor(code) {
    super('Runtime evidence composition failed.');
    this.name = 'RuntimeCompositionError';
    this.code = code;
  }
}

export function composeAgentRuntimeEvidence({ directory = process.env.GSM_RUNTIME_EVIDENCE_DIR } = {}) {
  const root = requireFreshEvidenceDirectory(directory);
  const records = PRODUCERS.map((contract) => readProducerEvidence(root, contract));
  const evidence = createRuntimeCompositionEvidence(records);
  publishRuntimeEvidence({
    directory: root,
    filename: OUTPUT_FILENAME,
    evidence,
    validateEvidence: validateRuntimeCompositionEvidence,
  });
  return Object.freeze({
    filename: OUTPUT_FILENAME,
    bytes: evidence.evidenceBytes,
    sha256: sha256(readFileSync(path.join(root, OUTPUT_FILENAME))),
  });
}

export function createRuntimeCompositionEvidence(records) {
  if (!Array.isArray(records) || records.length !== PRODUCERS.length) fail('input_set_invalid');
  const byKey = new Map(records.map((record) => [record.contract.key, record]));
  if (byKey.size !== PRODUCERS.length || PRODUCERS.some(({ key }) => !byKey.has(key))) fail('input_set_invalid');

  const production = PRODUCERS.filter((contract) => !contract.scenario).map(({ key }) => byKey.get(key).value.releaseDist);
  for (const identity of production.slice(1)) {
    if (!deepEqual(identity, production[0])) fail('release_dist_mismatch');
  }
  const scenario = byKey.get('scenarioLab').value;
  if (!deepEqual(scenario.releaseDist, production[0]) || deepEqual(scenario.diagnosticsBuild, production[0])) {
    fail('scenario_binding_invalid');
  }

  const organize = byKey.get('organize').value.organize;
  const organizeRecovery = byKey.get('organizeRecovery').value.organizeRecovery;
  const inputs = {};
  for (const contract of PRODUCERS) {
    const record = byKey.get(contract.key);
    inputs[contract.key] = {
      filename: contract.filename,
      bytes: record.bytes.byteLength,
      sha256: sha256(record.bytes),
      schemaVersion: record.value.schemaVersion,
      status: record.value.status,
      proofScope: record.value.proofScope,
    };
  }

  return {
    schemaVersion: 1,
    status: 'passed',
    proofScope: 'runtime_composition',
    releaseDist: structuredClone(production[0]),
    inputs,
    organizeOutcomes: {
      ownerObserverConverged: organize.ownership.ownerObserverConverged,
      ownerLossRequiredExplicitTakeover: organize.ownership.ownerLossRequiredExplicitTakeover,
      takeoverProviderRequestDelta: organize.ownership.takeoverProviderRequestDelta,
      terminalPagesConverged: organize.ownership.terminalPagesConverged,
      nonterminalDeletionBlocked: organize.deletion.nonterminalDeletionBlocked,
      originDeletedAfterCommit: organize.deletion.originDeletedAfterCommit,
      terminalEvidenceRetained: organize.deletion.terminalEvidenceRetained,
      originProvenanceRetained: organize.deletion.originProvenanceRetained,
      deletedPagesInvalidated: organize.deletion.deletedPagesInvalidated,
      replacementSessionSelected: organize.draftRecovery.replacementSessionSelected,
      unsentDraftPreservedExactly: organize.draftRecovery.unsentDraftPreservedExactly,
      nextAdmissionPagesConverged: organize.nextAdmission.pagesConverged,
      dismissPagesConverged: organize.dismiss.pagesConverged,
      workerRecoveryCompleted: organizeRecovery.outcome.terminalStatus === 'review'
        && organizeRecovery.outcome.retriedFirstPage === true
        && organizeRecovery.outcome.duplicateProviderRequests === 1,
    },
    containment: { ...CONTAINMENT_SCHEMA },
    cleanup: { ...CLEANUP_SCHEMA },
    evidenceBytes: 0,
  };
}

export function validateRuntimeCompositionEvidence(value) {
  validateShape(value, {
    schemaVersion: 1,
    status: 'passed',
    proofScope: 'runtime_composition',
    releaseDist: RELEASE_DIST,
    inputs: Object.fromEntries(PRODUCERS.map((contract) => [contract.key, {
      filename: contract.filename,
      bytes: POSITIVE,
      sha256: rule('full SHA-256', (digest) => typeof digest === 'string' && HEX_SHA256.test(digest)),
      schemaVersion: 1,
      status: 'passed',
      proofScope: contract.scope,
    }])),
    organizeOutcomes: {
      ownerObserverConverged: true,
      ownerLossRequiredExplicitTakeover: true,
      takeoverProviderRequestDelta: 0,
      terminalPagesConverged: true,
      nonterminalDeletionBlocked: true,
      originDeletedAfterCommit: true,
      terminalEvidenceRetained: true,
      originProvenanceRetained: true,
      deletedPagesInvalidated: true,
      replacementSessionSelected: true,
      unsentDraftPreservedExactly: true,
      nextAdmissionPagesConverged: true,
      dismissPagesConverged: true,
      workerRecoveryCompleted: true,
    },
    containment: CONTAINMENT_SCHEMA,
    cleanup: CLEANUP_SCHEMA,
    evidenceBytes: POSITIVE,
  }, '$');
  if (value.evidenceBytes > MAX_RUNTIME_EVIDENCE_BYTES) fail('composition_invalid');
}

function validateProducerEvidence(value, contract) {
  const top = contract.scenario
    ? {
      schemaVersion: 1,
      status: 'passed',
      proofScope: contract.scope,
      productionDistExercised: false,
      releaseDist: RELEASE_DIST,
      diagnosticsBuild: RELEASE_DIST,
      [contract.factsKey]: FACT_SCHEMAS[contract.key],
      containment: CONTAINMENT_SCHEMA,
      cleanup: CLEANUP_SCHEMA,
      evidenceBytes: POSITIVE,
    }
    : {
      schemaVersion: 1,
      status: 'passed',
      proofScope: contract.scope,
      productionDistExercised: true,
      releaseDist: RELEASE_DIST,
      [contract.factsKey]: FACT_SCHEMAS[contract.key],
      containment: CONTAINMENT_SCHEMA,
      cleanup: CLEANUP_SCHEMA,
      evidenceBytes: POSITIVE,
    };
  validateShape(value, top, '$');
  if (value.evidenceBytes > MAX_RUNTIME_EVIDENCE_BYTES) fail('input_too_large');

  if (contract.key === 'artifact') {
    if (value.artifactFlow.coverage.expectedBytes !== value.artifactFlow.coverage.deliveredBytes) fail('input_schema_invalid');
    if (value.artifactFlow.provider.exhaustivePageReads !== value.artifactFlow.coverage.pageCount) fail('input_schema_invalid');
  }
  if (contract.key === 'workerRecovery') validateWorkerRelationships(value.workerRecovery);
  if (contract.key === 'uiHistory') {
    if (value.uiHistory.provider.authenticatedRequests !== value.uiHistory.provider.requests) fail('input_schema_invalid');
  }
  if (contract.key === 'organize') validateOrganizeRelationships(value.organize);
  if (contract.key === 'organizeRecovery') validateOrganizeRecoveryRelationships(value.organizeRecovery);
  if (contract.key === 'scenarioLab') {
    if (!deepEqual(value.scenarioLab.scenarios.ids, EXPECTED_SCENARIO_IDS)) fail('input_schema_invalid');
    if (deepEqual(value.releaseDist, value.diagnosticsBuild)) fail('scenario_binding_invalid');
  }
}

function validateWorkerRelationships(value) {
  assertScenarioOrder(value.scenarios, 'id', WORKER_SCENARIO_IDS);
  assertScenarioOrder(value.replacements, 'scenarioId', WORKER_SCENARIO_IDS);
  assertScenarioOrder(value.productEpochs, 'scenarioId', WORKER_SCENARIO_IDS);
  assertScenarioOrder(value.runtimeDiagnostics, 'scenarioId', WORKER_SCENARIO_IDS);
  if (!deepEqual(value.scenarios.map((entry) => entry.interruptions), [0, 1, 1])) fail('input_schema_invalid');
  for (const entry of value.scenarios) {
    if (entry.replacements !== 1 || entry.revisionDelta !== 1 || entry.writeDelta !== 0 || entry.receiptCount !== 1 || entry.recoveryRows !== 0) fail('input_schema_invalid');
  }
  for (const entry of value.replacements) {
    if (entry.oldVersionId !== entry.newVersionId || entry.oldTargetId !== entry.newTargetId || entry.oldAttachmentId !== entry.newAttachmentId) fail('input_schema_invalid');
    if (!(entry.stopCommandOrdinal < entry.stoppedOrdinal
      && entry.stoppedOrdinal <= entry.installCompletedOrdinal
      && entry.installCompletedOrdinal <= entry.startCommandOrdinal
      && entry.startCommandOrdinal < entry.runningOrdinal)) fail('input_schema_invalid');
  }
  for (const entry of value.productEpochs) {
    if (entry.oldEpochId === entry.newEpochId) fail('input_schema_invalid');
  }
}

function validateOrganizeRelationships(value) {
  if (value.provider.authenticatedRequests !== value.provider.requests) fail('input_schema_invalid');
  if (value.ownership.terminalProjectionPages !== value.ownership.rawPages) fail('input_schema_invalid');
  if (value.draftRecovery.invalidationPages !== value.draftRecovery.contentPages) fail('input_schema_invalid');
  if (value.draftRecovery.draftsPreserved !== value.draftRecovery.contentPages) fail('input_schema_invalid');
  if (value.draftRecovery.replacementSessionPages !== value.draftRecovery.contentPages) fail('input_schema_invalid');
  if (value.nextAdmission.noJobProjectionPages !== value.nextAdmission.actorPages + value.nextAdmission.observerPages) fail('input_schema_invalid');
  if (value.dismiss.convergedPages !== value.draftRecovery.contentPages) fail('input_schema_invalid');
}

function validateOrganizeRecoveryRelationships(value) {
  if (value.replacement.oldVersionId !== value.replacement.newVersionId
    || value.replacement.oldTargetId !== value.replacement.newTargetId
    || value.replacement.oldAttachmentId !== value.replacement.newAttachmentId
    || value.epochs.oldEpochId === value.epochs.newEpochId
    || value.outcome.settledCount !== value.outcome.uniqueSettledPositionCount
    || !(value.replacement.stopCommandOrdinal < value.replacement.stoppedOrdinal
      && value.replacement.stoppedOrdinal <= value.replacement.installCompletedOrdinal
      && value.replacement.installCompletedOrdinal <= value.replacement.startCommandOrdinal
      && value.replacement.startCommandOrdinal < value.replacement.runningOrdinal)) fail('input_schema_invalid');
}

function requireFreshEvidenceDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) fail('evidence_directory_invalid');
  let root;
  try {
    const requested = path.resolve(directory);
    const directoryStats = lstatSync(requested);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) fail('evidence_directory_invalid');
    root = realpathSync(requested);
    const entries = readdirSync(root, { withFileTypes: true });
    const expected = PRODUCERS.map(({ filename }) => filename).sort();
    const actual = entries.map(({ name }) => name).sort();
    if (!deepEqual(actual, expected)) fail('input_set_invalid');
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) fail('input_file_invalid');
    }
  } catch (error) {
    if (error instanceof RuntimeCompositionError) throw error;
    fail('evidence_directory_invalid');
  }
  return root;
}

function readProducerEvidence(root, contract) {
  const inputPath = path.join(root, contract.filename);
  try {
    const stats = lstatSync(inputPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) fail('input_file_invalid');
    if (stats.size > MAX_RUNTIME_EVIDENCE_BYTES) fail('input_too_large');
    const bytes = readFileSync(inputPath);
    if (bytes.byteLength !== stats.size) fail('input_file_invalid');
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('input_encoding_invalid');
    }
    let value;
    try {
      value = JSON.parse(source);
    } catch {
      fail('input_json_invalid');
    }
    if (value?.evidenceBytes !== bytes.byteLength) fail('input_digest_mismatch');
    validateProducerEvidence(value, contract);
    let canonical;
    try {
      canonical = serializeRuntimeEvidence(structuredClone(value), {
        validateEvidence(candidate) {
          validateProducerEvidence(candidate, contract);
        },
      });
    } catch (error) {
      if (error instanceof RuntimeCompositionError) throw error;
      if (error instanceof RuntimeEvidenceError) fail('input_private_or_schema_invalid');
      throw error;
    }
    if (!Buffer.from(canonical).equals(bytes)) fail('input_noncanonical');
    return Object.freeze({ contract, bytes, value });
  } catch (error) {
    if (error instanceof RuntimeCompositionError) throw error;
    fail('input_file_invalid');
  }
}

function validateShape(value, schema, jsonPath) {
  if (schema && typeof schema === 'object' && schema[RULE] === true) {
    if (!schema.check(value)) fail('input_schema_invalid');
    return;
  }
  if (schema && typeof schema === 'object' && schema[RULE] === 'array') {
    if (!Array.isArray(value) || value.length !== schema.length) fail('input_schema_invalid');
    value.forEach((entry, index) => validateShape(entry, schema.item, `${jsonPath}[${index}]`));
    return;
  }
  if (schema && typeof schema === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('input_schema_invalid');
    const expectedKeys = Object.keys(schema);
    if (!deepEqual(Object.keys(value), expectedKeys)) fail('input_schema_invalid');
    for (const key of expectedKeys) validateShape(value[key], schema[key], `${jsonPath}.${key}`);
    return;
  }
  if (!Object.is(value, schema)) fail('input_schema_invalid');
}

function rule(label, check) {
  return Object.freeze({ [RULE]: true, label, check });
}

function arrayOf(item, { length }) {
  return Object.freeze({ [RULE]: 'array', item, length });
}

function assertScenarioOrder(entries, key, expected) {
  if (!deepEqual(entries.map((entry) => entry[key]), expected)) fail('input_schema_invalid');
}

function deepEqual(left, right) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(code) {
  throw new RuntimeCompositionError(code);
}

function createReleaseDistFixture(seed) {
  const digest = (label) => sha256(Buffer.from(`${seed}:${label}`));
  return {
    packageInput: { algorithm: 'sha256', fileCount: 3, sha256: digest('package') },
    manifest: { relativePath: 'manifest.json', bytes: 128, sha256: digest('manifest'), manifestVersion: 3, extensionVersion: '1.0.8' },
    loader: { relativePath: 'service-worker-loader.js', bytes: 32, sha256: digest('loader') },
    worker: { relativePath: 'assets/service-worker.js', bytes: 2048, sha256: digest('worker') },
  };
}

function createValidProducerFixtures() {
  const releaseDist = createReleaseDistFixture('production');
  const diagnosticsBuild = createReleaseDistFixture('diagnostics');
  const common = (scope, factsKey, facts) => ({
    schemaVersion: 1,
    status: 'passed',
    proofScope: scope,
    productionDistExercised: true,
    releaseDist: structuredClone(releaseDist),
    [factsKey]: facts,
    containment: { ...CONTAINMENT_SCHEMA },
    cleanup: { ...CLEANUP_SCHEMA },
    evidenceBytes: 0,
  });
  const workerScenarios = WORKER_SCENARIO_IDS.map((id, index) => ({
    id, providerRequests: 1, toolCalls: 1, toolResults: 1, interruptions: index === 0 ? 0 : 1, replacements: 1,
    revisionDelta: 1, writeDelta: 0, receiptCount: 1, recoveryRows: 0,
  }));
  const replacements = WORKER_SCENARIO_IDS.map((scenarioId, index) => ({
    scenarioId,
    oldVersionId: `version-${index}`,
    newVersionId: `version-${index}`,
    oldTargetId: `target-${index}`,
    newTargetId: `target-${index}`,
    oldAttachmentId: `attachment-${index}`,
    newAttachmentId: `attachment-${index}`,
    scriptRelativePath: 'assets/service-worker.js',
    lifecycleMode: 'stopped_target_preinstalled',
    stopCommandOrdinal: 1,
    stoppedOrdinal: 2,
    installCompletedOrdinal: 2,
    startCommandOrdinal: 2,
    runningOrdinal: 3,
  }));
  const productEpochs = WORKER_SCENARIO_IDS.map((scenarioId, index) => ({ scenarioId, oldEpochId: `old-epoch-${index}`, newEpochId: `new-epoch-${index}` }));
  const runtimeDiagnostics = WORKER_SCENARIO_IDS.map((scenarioId) => ({ scenarioId, count: 0, overflow: false }));
  const fixtures = {
    artifact: common('packaged_durable_artifact', 'artifactFlow', {
      provider: { requests: 14, sourceRequests: 1, locatingReads: 2, exhaustivePageReads: 10, ordinaryBoundaries: 9, provisionalFinals: 1, correctiveReprompts: 1, finalResponses: 1 },
      coverage: { firstPageOmittedCursor: true, cursorChainExact: true, pageCount: 10, expectedBytes: 4096, deliveredBytes: 4096, nextCursorNull: true, artifactDigestPresent: true, manifestDigestPresent: true, cursorChainDigestPresent: true, chunksMatchManifest: true },
      canonical: { sourceToolRows: 1, readerRows: 0, prematureAssistantRows: 0, finalAssistantRows: 1, receiptCount: 1 },
      settlement: { commitApplied: true, revisionDelta: 1, recoveryRows: 0, continuationPresent: false, leasePresent: false },
    }),
    workerRecovery: common('packaged_worker_recovery', 'workerRecovery', {
      scenarios: workerScenarios,
      replacements,
      productEpochs,
      durableRecovery: {
        beforeReplacement: { recoveryRows: 1, pendingCoverage: 1, completeCoverage: 0, cursorAuthority: true, continuationPresent: true, leasePresent: true, canonicalPromptResidue: false, recoveryAuthorityPresent: true, provisionalTranscriptResidue: false },
        afterCommit: { recoveryRows: 0, pendingCoverage: 0, completeCoverage: 1, continuationPresent: false, leasePresent: false, receiptPresent: true, canonicalSourceRows: 1, canonicalFinalRows: 1, canonicalSourcePairs: 1, provisionalTranscriptResidue: false },
        stateUncertain: { state: 'state_uncertain', terminalReason: 'attempt_state_lost', writeSettlement: 'unsafe', automaticProviderRequests: 0, automaticToolResults: 0, writeDelta: 0, receiptCount: 0, recoveryRows: 0, continuationPresent: false, leasePresent: false },
        afterAbandonment: { state: 'terminal_non_retryable', terminalReason: 'abandoned', writeSettlement: 'unsafe', receiptCount: 0, recoveryRows: 0, continuationPresent: false, leasePresent: false, freshTurnState: 'committed', freshRevisionDelta: 1, freshReceiptCount: 1 },
      },
      runtimeDiagnostics,
    }),
    uiHistory: common('packaged_ui_history', 'uiHistory', {
      scenarios: {
        atomic: { sessionRows: 1, sameSession: true },
        pageLocal: { sessionRows: 2, pageAPickedNew: true, pageBStayedLocal: true },
        subscription: { resumeOnlyWinnerStarts: 1, resumeOnlyRejectedStarts: 0, providerDelta: 0, providerRequests: 1, sessionRows: 1, attemptRows: 1, committedRows: 1, terminalPages: 2 },
        conflict: { typed: true, exactPublicText: true, domRollback: true, inputRetainedBefore: true, inputRetainedAfter: true, composerEnabledAfter: true, sessionDelta: 0, attemptDelta: 0, providerDelta: 0, messageDelta: 0 },
        retry: { httpStatus: 503, requestDelta: 1, attemptDelta: 1, sourceRetried: 1, committed: 1, writeSettlementsNone: 2, selectedTools: 0 },
        history: { lightweightTurns: 50, canonicalRows: 104, userRows: 52, assistantRows: 52, recentRows: 100, loadedRows: 104, recentExactOrder: true, fullExactOrder: true, occurrenceOnce: true, firstSequence: 1, lastSequence: 104, gaps: 0, duplicateIds: 0, finalCursorNull: true },
      },
      provider: { requests: 9, connectionRequests: 2, scenarioRequests: 7, http503Responses: 1, selectedScenarioTools: 0, authenticatedRequests: 9, failures: 0, interruptions: 0 },
      network: { browserFailClosed: true, workerFixtures: 9, workerUnexpected: 0, pageExpected: 3, pageUnexpected: 0, pageIssues: 0, overflow: false },
      canary: { secretDurableOccurrences: 0, secretEvidenceOccurrences: 0, submittedDurableOccurrences: 2, submittedProviderAssociations: 1, providerResponseDurableOccurrences: 1, neverSubmittedDurableOccurrences: 0, neverSubmittedProviderOccurrences: 0, rejectedDurableOccurrences: 0, rejectedProviderOccurrences: 0 },
    }),
    organize: common('packaged_organize_job', 'organize', {
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
      provider: { requests: 12, authenticatedRequests: 12, githubFixtureRequests: 4, unexpectedRequests: 0, failures: 0, overflow: false, customHostDeniedFetches: 0 },
    }),
    organizeRecovery: common('packaged_organize_recovery', 'organizeRecovery', {
      replacement: { scenarioId: 'organize_worker_recovery', oldVersionId: 'version', newVersionId: 'version', oldTargetId: 'target', newTargetId: 'target', oldAttachmentId: 'attachment', newAttachmentId: 'attachment', scriptRelativePath: 'assets/service-worker.js', lifecycleMode: 'paused_target_auto_attached', stopCommandOrdinal: 1, stoppedOrdinal: 2, installCompletedOrdinal: 2, startCommandOrdinal: 2, runningOrdinal: 3 },
      epochs: { oldEpochId: 'old-epoch', newEpochId: 'new-epoch' },
      outcome: { runIdStable: true, generationStable: true, firstPageAttempts: 2, retriedFirstPage: true, settledCount: 501, uniqueSettledPositionCount: 501, providerAttemptCount: 21, duplicateProviderRequests: 1, terminalStatus: 'review' },
      provider: { requests: 22, interruptions: 1, failures: 0 },
    }),
    scenarioLab: {
      schemaVersion: 1,
      status: 'passed',
      proofScope: 'development_scenario_lab',
      productionDistExercised: false,
      releaseDist: structuredClone(releaseDist),
      diagnosticsBuild,
      scenarioLab: { scenarios: { ids: [...EXPECTED_SCENARIO_IDS], rootCount: 9, eventCount: 90, completedCount: 7, cancelledCount: 2, failedCount: 0, lastEventTerminal: true, artifactContinuationProviderRequests: 12, writeOutcomeEvents: 0 }, rawCapture: { warningRendered: true, armedBeforeReload: true, disarmedAfterReload: true }, issues: { page: 0, worker: 0 } },
      containment: { ...CONTAINMENT_SCHEMA },
      cleanup: { ...CLEANUP_SCHEMA },
      evidenceBytes: 0,
    },
  };
  return fixtures;
}

function canonicalProducerBytes(value, contract) {
  return Buffer.from(serializeRuntimeEvidence(value, {
    validateEvidence(candidate) {
      validateProducerEvidence(candidate, contract);
    },
  }));
}

function stabilizeJson(value) {
  let previous = -1;
  for (let index = 0; index < 8; index += 1) {
    value.evidenceBytes = previous < 0 ? 0 : previous;
    const source = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = Buffer.byteLength(source);
    if (bytes === value.evidenceBytes) return Buffer.from(source);
    previous = bytes;
  }
  throw new Error('Fixture evidence size did not stabilize.');
}

function writeFixtureDirectory(root, fixtures = createValidProducerFixtures()) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const contract of PRODUCERS) {
    const destination = path.join(root, contract.filename);
    writeFileSync(destination, canonicalProducerBytes(fixtures[contract.key], contract), { mode: 0o600 });
    chmodSync(destination, 0o600);
  }
}

async function runSelfTests() {
  const tests = [
    ['valid composition binds all producer files', () => withFixtureDirectory((root) => {
      const before = Object.fromEntries(PRODUCERS.map(({ filename }) => [filename, readFileSync(path.join(root, filename))]));
      const result = composeAgentRuntimeEvidence({ directory: root });
      const outputPath = path.join(root, OUTPUT_FILENAME);
      const output = JSON.parse(readFileSync(outputPath, 'utf8'));
      assert.equal(result.filename, OUTPUT_FILENAME);
      assert.equal(statSync(outputPath).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(root).sort(), [...PRODUCERS.map(({ filename }) => filename), OUTPUT_FILENAME].sort());
      for (const contract of PRODUCERS) {
        assert.equal(output.inputs[contract.key].bytes, before[contract.filename].byteLength);
        assert.equal(output.inputs[contract.key].sha256, sha256(before[contract.filename]));
      }
      assert.equal(output.organizeOutcomes.workerRecoveryCompleted, true);
    })],
    ['missing producer is rejected', () => withFixtureDirectory((root) => {
      rmSync(path.join(root, PRODUCERS[0].filename));
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_set_invalid');
      assert.equal(readdirSync(root).includes(OUTPUT_FILENAME), false);
    })],
    ['extra key is rejected recursively', () => withFixtureDirectory((root, fixtures) => {
      fixtures.artifact.artifactFlow.coverage.raw = 1;
      writeFileSync(path.join(root, PRODUCERS[0].filename), stabilizeJson(fixtures.artifact));
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_schema_invalid');
    })],
    ['extra stale file is rejected', () => withFixtureDirectory((root) => {
      writeFileSync(path.join(root, 'stale.schema.json'), '{}\n');
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_set_invalid');
    })],
    ['stale production identity is rejected', () => withFixtureDirectory((root, fixtures) => {
      fixtures.uiHistory.releaseDist.worker.sha256 = sha256(Buffer.from('stale-worker'));
      rewriteFixture(root, 'uiHistory', fixtures);
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'release_dist_mismatch');
    })],
    ['wrong Scenario production binding is rejected', () => withFixtureDirectory((root, fixtures) => {
      fixtures.scenarioLab.diagnosticsBuild = structuredClone(fixtures.scenarioLab.releaseDist);
      writeFileSync(path.join(root, PRODUCERS.at(-1).filename), stabilizeJson(fixtures.scenarioLab));
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'scenario_binding_invalid');
    })],
    ['forbidden raw field is rejected', () => withFixtureDirectory((root, fixtures) => {
      fixtures.scenarioLab.scenarioLab.issues.message = 'private diagnostic';
      writeFileSync(path.join(root, PRODUCERS.at(-1).filename), stabilizeJson(fixtures.scenarioLab));
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_schema_invalid');
    })],
    ['credential-like values are rejected in allowed fields', () => withFixtureDirectory((root, fixtures) => {
      fixtures.workerRecovery.workerRecovery.replacements[0].oldVersionId = 'ghp_private_fixture';
      fixtures.workerRecovery.workerRecovery.replacements[0].newVersionId = 'ghp_private_fixture';
      writeFileSync(path.join(root, PRODUCERS[1].filename), stabilizeJson(fixtures.workerRecovery));
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_private_or_schema_invalid');
    })],
    ['traversal and symlink inputs are rejected', () => {
      withFixtureDirectory((root, fixtures) => {
        fixtures.organizeRecovery.organizeRecovery.replacement.scriptRelativePath = '../worker.js';
        writeFileSync(path.join(root, PRODUCERS[4].filename), stabilizeJson(fixtures.organizeRecovery));
        assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_schema_invalid');
      });
      withFixtureDirectory((root) => {
        const filename = PRODUCERS[0].filename;
        const outside = path.join(path.dirname(root), 'outside-evidence.json');
        writeFileSync(outside, readFileSync(path.join(root, filename)));
        rmSync(path.join(root, filename));
        symlinkSync(outside, path.join(root, filename));
        assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_file_invalid');
        rmSync(outside, { force: true });
      });
    }],
    ['digest and byte-accounting mismatch is rejected', () => withFixtureDirectory((root, fixtures) => {
      fixtures.artifact.releaseDist.worker.sha256 = '0'.repeat(63);
      writeFileSync(path.join(root, PRODUCERS[0].filename), stabilizeJson(fixtures.artifact));
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_schema_invalid');
      fixtures.artifact = createValidProducerFixtures().artifact;
      const bytes = canonicalProducerBytes(fixtures.artifact, PRODUCERS[0]);
      const source = bytes.toString('utf8').replace('"evidenceBytes": ', '"evidenceBytes": 9');
      writeFileSync(path.join(root, PRODUCERS[0].filename), source);
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_digest_mismatch');
    })],
    ['oversize input is rejected before parsing', () => withFixtureDirectory((root) => {
      writeFileSync(path.join(root, PRODUCERS[0].filename), Buffer.alloc(MAX_RUNTIME_EVIDENCE_BYTES + 1, 0x20));
      assertCompositionCode(() => composeAgentRuntimeEvidence({ directory: root }), 'input_too_large');
    })],
  ];
  for (const [name, test] of tests) {
    await test();
    process.stdout.write(`ok - ${name}\n`);
  }
}

function rewriteFixture(root, key, fixtures) {
  const contract = PRODUCERS.find((entry) => entry.key === key);
  writeFileSync(path.join(root, contract.filename), canonicalProducerBytes(fixtures[key], contract));
}

function withFixtureDirectory(callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-composition-'));
  const fixtures = createValidProducerFixtures();
  try {
    writeFixtureDirectory(root, fixtures);
    return callback(root, fixtures);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertCompositionCode(callback, expectedCode) {
  assert.throws(callback, (error) => error instanceof RuntimeCompositionError && error.code === expectedCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') {
      await runSelfTests();
    } else if (process.argv.length === 2) {
      const result = composeAgentRuntimeEvidence();
      process.stdout.write(`${JSON.stringify({ status: 'passed', proofScope: 'runtime_composition', filename: result.filename, bytes: result.bytes })}\n`);
    } else {
      fail('arguments_invalid');
    }
  } catch (error) {
    const code = error instanceof RuntimeCompositionError ? error.code : 'composition_failed';
    process.stderr.write(`${JSON.stringify({ status: 'failed', proofScope: 'runtime_composition', code })}\n`);
    process.exitCode = 1;
  }
}
