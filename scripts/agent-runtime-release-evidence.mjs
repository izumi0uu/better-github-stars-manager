import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  assertRuntimeReleaseDistIdentity,
  MAX_RUNTIME_EVIDENCE_BYTES,
} from './agent-runtime-evidence-contract.mjs';
import {
  compareChromeExtensionVersions,
  enforceWorkerReleaseBaseline,
  normalizePackageRelativePath,
  parseChromeExtensionVersion,
  RELEASE_WORKER_BASELINE,
} from './package-manifest-closure.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VITE_MARKER = /^\(!\) Some chunks are larger than \d+(?:\.\d+)? kB after minification\. Consider:$/u;
const VITE_ROW = /^\s*\S.*?\s+\d+(?:\.\d+)? kB(?:\s+│\s+gzip:\s+\d+(?:\.\d+)? kB)?\s*$/u;
const VITE_ADVICE = [
  /^- Using dynamic import\(\) to code-split the application$/u,
  /^- Use build\.rollupOptions\.output\.manualChunks to improve chunking: https:\/\/rollupjs\.org\/configuration-options\/#output-manualchunks$/u,
  /^- Adjust chunk size limit for this warning via build\.chunkSizeWarningLimit\.$/u,
];
const BUILD_ADVISORY_PATH = /^\$\.build\.advisories\[\d+\]$/u;
const FINAL_BUILD_ADVISORY_PATH = /^\$\.finalValue\.build\.advisories\[\d+\]$/u;
const DEFAULT_ADVISORY_LIMITS = Object.freeze({ maxBlocks: 16, maxBlockBytes: 16 * 1024, maxTotalBytes: 64 * 1024 });
const MAX_VALIDATION_DEPTH = 20;
const MAX_VALIDATION_NODES = 4_096;
const MAX_COLLECTION_ITEMS = 256;
const MAX_STRING_BYTES = 1_024;
const REQUIRED_MANUAL_EXCLUSIONS = deepFreeze([
  'chrome_web_store_publication',
  'chrome_web_store_review',
  'chrome_web_store_upload',
  'live_provider_credential_check',
]);
const EXPECTED_SCENARIO_IDS = deepFreeze([
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

export class ReleaseEvidenceError extends Error {
  constructor(code, jsonPath = '$') {
    super(jsonPath);
    this.name = 'ReleaseEvidenceError';
    this.code = code;
    this.jsonPath = jsonPath;
  }
}

export const FINAL_CHECK_SPECS = deepFreeze([
  { key: 'typecheck', command: 'pnpm typecheck' },
  { key: 'fullVitest', command: 'pnpm test:vitest' },
  { key: 'logic', command: 'pnpm test:logic' },
  { key: 'regressions', command: 'pnpm test:regressions' },
  { key: 'productionBuild', command: 'GSM_RELEASE=true GSM_DEV=false pnpm build' },
  { key: 'bundleBudget', command: 'internal:bundle-budget' },
  { key: 'runtime', command: 'pnpm test:runtime' },
  { key: 'extensionSmoke', command: 'pnpm test:smoke' },
  { key: 'organizeJobExtensionHost', command: 'pnpm test:runtime:organize-job-host' },
  { key: 'organizeJobRecovery', command: 'pnpm test:runtime:organize-job-recovery' },
  { key: 'agentDiagnosticsReleaseIsolation', command: 'pnpm test:runtime:agent-diagnostics' },
  { key: 'agentScenariosExtensionHost', command: 'pnpm test:runtime:agent-scenarios' },
  { key: 'agentArtifactExtensionHost', command: 'pnpm test:runtime:agent-session' },
  { key: 'agentWorkerRecoveryExtensionHost', command: 'pnpm test:runtime:agent-worker-recovery' },
  { key: 'agentUiHistoryExtensionHost', command: 'pnpm test:runtime:agent-ui-history' },
  { key: 'agentRuntimeComposition', command: 'pnpm test:runtime:agent-composition' },
  { key: 'agentProviderAdapterContracts', command: 'internal:agent-provider-adapter-contracts' },
  { key: 'packageInputStable', command: 'internal:package-input-stable' },
  { key: 'packageExtension', command: 'GSM_SKIP_PACKAGE_BUILD=true pnpm package:extension' },
]);

const RUNTIME_CONTRACT_LIST = [
  ['artifact', 'agent-artifact.schema-v1.json', 'packaged_durable_artifact', 'agentArtifactExtensionHost', true, 'artifactFlow'],
  ['workerRecovery', 'agent-worker-recovery.schema-v1.json', 'packaged_worker_recovery', 'agentWorkerRecoveryExtensionHost', true, 'workerRecovery'],
  ['uiHistory', 'agent-ui-history.schema-v1.json', 'packaged_ui_history', 'agentUiHistoryExtensionHost', true, 'uiHistory'],
  ['organize', 'organize-job.schema-v1.json', 'packaged_organize_job', 'organizeJobExtensionHost', true, 'organize'],
  ['organizeRecovery', 'organize-job-recovery.schema-v1.json', 'packaged_organize_recovery', 'organizeJobRecovery', true, 'organizeRecovery'],
  ['scenarioLab', 'agent-scenarios.schema-v1.json', 'development_scenario_lab', 'agentScenariosExtensionHost', false, 'scenarioLab'],
  ['runtimeComposition', 'agent-runtime-composition.schema-v1.json', 'runtime_composition', 'agentRuntimeComposition', true, null],
];

export const RUNTIME_EVIDENCE_CONTRACTS = deepFreeze(Object.fromEntries(
  RUNTIME_CONTRACT_LIST.map(([key, filename, proofScope, runnerKey, productionDistExercised, factsKey]) => [key, {
    key,
    filename,
    proofScope,
    runnerKey,
    productionDistExercised,
    factsKey,
  }]),
));

const CONTAINMENT_SHAPE = {
  networkFailClosed: exact(true),
  unexpectedNetworkRequests: exact(0),
  rawCredentialOccurrences: exact(0),
  privatePayloadOccurrences: exact(0),
  overflow: exact(false),
};
const CLEANUP_SHAPE = {
  networkGatesClosed: exact(true),
  diagnosticsDetached: exact(true),
  pagesClosed: exact(true),
  browserClosed: exact(true),
  temporaryStateRemoved: exact(true),
};
const RELEASE_DIST_SHAPE = {
  packageInput: { algorithm: exact('sha256'), fileCount: integer(0), sha256: digest() },
  manifest: {
    relativePath: exact('manifest.json'), bytes: integer(1), sha256: digest(),
    manifestVersion: exact(3), extensionVersion: version(),
  },
  loader: { relativePath: relativeJsPath(), bytes: integer(1), sha256: digest() },
  worker: { relativePath: relativeJsPath(), bytes: integer(1), sha256: digest() },
};
const ARTIFACT_SHAPE = {
  provider: numericObject(['requests', 'sourceRequests', 'locatingReads', 'exhaustivePageReads', 'ordinaryBoundaries', 'provisionalFinals', 'correctiveReprompts', 'finalResponses']),
  coverage: {
    firstPageOmittedCursor: boolean(), cursorChainExact: boolean(), pageCount: integer(0),
    expectedBytes: integer(0), deliveredBytes: integer(0), nextCursorNull: boolean(),
    artifactDigestPresent: boolean(), manifestDigestPresent: boolean(), cursorChainDigestPresent: boolean(), chunksMatchManifest: boolean(),
  },
  canonical: numericObject(['sourceToolRows', 'readerRows', 'prematureAssistantRows', 'finalAssistantRows', 'receiptCount']),
  settlement: {
    commitApplied: boolean(), revisionDelta: integer(0), recoveryRows: integer(0),
    continuationPresent: boolean(), leasePresent: boolean(),
  },
};
const WORKER_SCENARIO_SHAPE = {
  id: identifier(), providerRequests: integer(0), toolCalls: integer(0), toolResults: integer(0),
  interruptions: integer(0), replacements: integer(0), revisionDelta: integer(0), writeDelta: integer(0),
  receiptCount: integer(0), recoveryRows: integer(0),
};
const REPLACEMENT_SHAPE = {
  scenarioId: identifier(), oldVersionId: identifier(), newVersionId: identifier(),
  oldTargetId: identifier(), newTargetId: identifier(), oldAttachmentId: identifier(), newAttachmentId: identifier(),
  scriptRelativePath: relativeJsPath(), lifecycleMode: identifier(), stopCommandOrdinal: integer(0),
  stoppedOrdinal: integer(0), installCompletedOrdinal: integer(0), startCommandOrdinal: integer(0), runningOrdinal: integer(0),
};
const WORKER_SHAPE = {
  scenarios: arrayOf(WORKER_SCENARIO_SHAPE, 3, 3),
  replacements: arrayOf(REPLACEMENT_SHAPE, 3, 3),
  productEpochs: arrayOf({ scenarioId: identifier(), oldEpochId: identifier(), newEpochId: identifier() }, 3, 3),
  durableRecovery: {
    beforeReplacement: semanticObject(['recoveryRows', 'pendingCoverage', 'completeCoverage', 'cursorAuthority', 'continuationPresent', 'leasePresent', 'canonicalPromptResidue', 'recoveryAuthorityPresent', 'provisionalTranscriptResidue']),
    afterCommit: semanticObject(['recoveryRows', 'pendingCoverage', 'completeCoverage', 'continuationPresent', 'leasePresent', 'receiptPresent', 'canonicalSourceRows', 'canonicalFinalRows', 'canonicalSourcePairs', 'provisionalTranscriptResidue']),
    stateUncertain: semanticObject(['state', 'terminalReason', 'writeSettlement', 'automaticProviderRequests', 'automaticToolResults', 'writeDelta', 'receiptCount', 'recoveryRows', 'continuationPresent', 'leasePresent']),
    afterAbandonment: semanticObject(['state', 'terminalReason', 'writeSettlement', 'receiptCount', 'recoveryRows', 'continuationPresent', 'leasePresent', 'freshTurnState', 'freshRevisionDelta', 'freshReceiptCount']),
  },
  runtimeDiagnostics: arrayOf({ scenarioId: identifier(), count: integer(0), overflow: boolean() }, 3, 3),
};
const UI_HISTORY_SHAPE = {
  scenarios: {
    atomic: semanticObject(['sessionRows', 'sameSession']),
    pageLocal: semanticObject(['sessionRows', 'pageAPickedNew', 'pageBStayedLocal']),
    subscription: semanticObject(['resumeOnlyWinnerStarts', 'resumeOnlyRejectedStarts', 'providerDelta', 'providerRequests', 'sessionRows', 'attemptRows', 'committedRows', 'terminalPages']),
    conflict: semanticObject(['typed', 'exactPublicText', 'domRollback', 'inputRetainedBefore', 'inputRetainedAfter', 'composerEnabledAfter', 'sessionDelta', 'attemptDelta', 'providerDelta', 'messageDelta']),
    retry: semanticObject(['httpStatus', 'requestDelta', 'attemptDelta', 'sourceRetried', 'committed', 'writeSettlementsNone', 'selectedTools']),
    history: semanticObject(['lightweightTurns', 'canonicalRows', 'userRows', 'assistantRows', 'recentRows', 'loadedRows', 'recentExactOrder', 'fullExactOrder', 'occurrenceOnce', 'firstSequence', 'lastSequence', 'gaps', 'duplicateIds', 'finalCursorNull']),
  },
  provider: semanticObject(['requests', 'connectionRequests', 'scenarioRequests', 'http503Responses', 'selectedScenarioTools', 'authenticatedRequests', 'failures', 'interruptions']),
  network: semanticObject(['browserFailClosed', 'workerFixtures', 'workerUnexpected', 'pageExpected', 'pageUnexpected', 'pageIssues', 'overflow']),
  canary: semanticObject(['secretDurableOccurrences', 'secretEvidenceOccurrences', 'submittedDurableOccurrences', 'submittedProviderAssociations', 'providerResponseDurableOccurrences', 'neverSubmittedDurableOccurrences', 'neverSubmittedProviderOccurrences', 'rejectedDurableOccurrences', 'rejectedProviderOccurrences']),
};
const ORGANIZE_SHAPE = {
  configuration: semanticObject(['transientProbeRequests', 'savedCredentialUnchanged', 'savedCapabilityReady']),
  corruption: semanticObject(['activeCheckpointDiscarded', 'blockedCheckpointReplaced', 'duplicateStartIdempotent']),
  start: semanticObject(['preflightRows', 'admittedRows']),
  budget: semanticObject(['frozenRows', 'providerAttemptsBeforeContinuation', 'continuationCount', 'completed']),
  detach: semanticObject(['detachedWhileActive', 'terminalRetainedUntilDismiss']),
  ownership: semanticObject(['rawPages', 'ownerPages', 'observerPages', 'ownerLostPages', 'explicitTakeoverPages', 'formerOwnerObserverPages', 'ownerObserverConverged', 'ownerLossRequiredExplicitTakeover', 'takeoverProviderRequestDelta', 'terminalProjectionPages', 'terminalPagesConverged']),
  deletion: semanticObject(['nonterminalDeletionBlocked', 'deletionUiActors', 'originDeletedAfterCommit', 'terminalEvidenceRetained', 'originProvenanceRetained', 'deletedPagesInvalidated', 'deletedOriginInCatalog', 'terminalCards', 'originDeletedCopyPages', 'retainedTerminalRows', 'retainedApplyRows']),
  draftRecovery: semanticObject(['contentPages', 'originSessionPagesBefore', 'replacementSessionsCreated', 'invalidationPages', 'draftsPreserved', 'replacementSessionPages', 'composerEnabledPages', 'deletedOriginTranscriptRows', 'deletedOriginRetryCards', 'replacementSessionSelected', 'unsentDraftPreservedExactly']),
  nextAdmission: semanticObject(['actorPages', 'observerPages', 'noJobProjectionPages', 'oldTerminalRows', 'oldApplyRows', 'newPreflightRows', 'providerRequestDelta', 'pagesConverged']),
  dismiss: semanticObject(['actorPages', 'convergedPages', 'dismissedTerminalRows', 'dismissedApplyRows', 'pagesConverged']),
  provider: semanticObject(['requests', 'authenticatedRequests', 'githubFixtureRequests', 'unexpectedRequests', 'failures', 'overflow', 'customHostDeniedFetches']),
};
const ORGANIZE_RECOVERY_SHAPE = {
  replacement: REPLACEMENT_SHAPE,
  epochs: { oldEpochId: identifier(), newEpochId: identifier() },
  outcome: {
    runIdStable: boolean(), generationStable: boolean(), firstPageAttempts: integer(0), retriedFirstPage: boolean(),
    settledCount: integer(0), uniqueSettledPositionCount: integer(0), providerAttemptCount: integer(0),
    duplicateProviderRequests: integer(0), terminalStatus: identifier(),
  },
  provider: numericObject(['requests', 'interruptions', 'failures']),
};
const SCENARIO_SHAPE = {
  scenarios: {
    ids: arrayOf(identifier(), 1, 32), rootCount: integer(0), eventCount: integer(0), completedCount: integer(0),
    cancelledCount: integer(0), failedCount: integer(0), lastEventTerminal: boolean(),
    artifactContinuationProviderRequests: integer(0), writeOutcomeEvents: integer(0),
  },
  rawCapture: { warningRendered: boolean(), armedBeforeReload: boolean(), disarmedAfterReload: boolean() },
  issues: { page: integer(0), worker: integer(0) },
};
const INPUT_FILE_SHAPE = {
  filename: identifier(), bytes: integer(1), sha256: digest(), schemaVersion: exact(1), status: exact('passed'), proofScope: identifier(),
};
const COMPOSITION_SHAPE = {
  schemaVersion: exact(1), status: exact('passed'), proofScope: exact('runtime_composition'),
  releaseDist: RELEASE_DIST_SHAPE,
  inputs: {
    artifact: INPUT_FILE_SHAPE, workerRecovery: INPUT_FILE_SHAPE, uiHistory: INPUT_FILE_SHAPE,
    organize: INPUT_FILE_SHAPE, organizeRecovery: INPUT_FILE_SHAPE, scenarioLab: INPUT_FILE_SHAPE,
  },
  organizeOutcomes: {
    ownerObserverConverged: exact(true), ownerLossRequiredExplicitTakeover: exact(true), takeoverProviderRequestDelta: exact(0),
    terminalPagesConverged: exact(true), nonterminalDeletionBlocked: exact(true), originDeletedAfterCommit: exact(true),
    terminalEvidenceRetained: exact(true), originProvenanceRetained: exact(true), deletedPagesInvalidated: exact(true),
    replacementSessionSelected: exact(true), unsentDraftPreservedExactly: exact(true), nextAdmissionPagesConverged: exact(true),
    dismissPagesConverged: exact(true), workerRecoveryCompleted: exact(true),
  },
  containment: CONTAINMENT_SHAPE,
  cleanup: CLEANUP_SHAPE,
  evidenceBytes: integer(1, MAX_RUNTIME_EVIDENCE_BYTES),
};
const FACT_SHAPES = {
  artifact: ARTIFACT_SHAPE,
  workerRecovery: WORKER_SHAPE,
  uiHistory: UI_HISTORY_SHAPE,
  organize: ORGANIZE_SHAPE,
  organizeRecovery: ORGANIZE_RECOVERY_SHAPE,
  scenarioLab: SCENARIO_SHAPE,
};

export function parseViteChunkAdvisories({ stdout = '', stderr = '' }, limits = {}) {
  if (typeof stdout !== 'string' || typeof stderr !== 'string') throw new ReleaseEvidenceError('build_output_invalid');
  const resolvedLimits = { ...DEFAULT_ADVISORY_LIMITS, ...limits };
  for (const key of ['maxBlocks', 'maxBlockBytes', 'maxTotalBytes']) {
    if (!Number.isSafeInteger(resolvedLimits[key]) || resolvedLimits[key] <= 0) {
      throw new ReleaseEvidenceError('advisory_limit_invalid', `$.limits.${key}`);
    }
  }
  const advisories = [];
  const streams = [['stdout', stdout], ['stderr', stderr]].map(([streamName, stream]) => {
    const lines = stream.replace(/\r\n?/gu, '\n').split('\n');
    return {
      streamName,
      lines,
      emittedRows: lines.filter((line) => VITE_ROW.test(stripAnsi(line))),
      hasMarker: lines.some((line) => VITE_MARKER.test(stripAnsi(line))),
    };
  });
  const splitStreamRows = streams.filter(({ hasMarker }) => !hasMarker).flatMap(({ emittedRows }) => emittedRows);
  for (const { streamName, lines } of streams) {
    for (let index = 0; index < lines.length; index += 1) {
      if (!VITE_MARKER.test(stripAnsi(lines[index]))) continue;
      const localRows = [];
      for (let row = index - 1; row >= 0 && VITE_ROW.test(stripAnsi(lines[row])); row -= 1) localRows.unshift(lines[row]);
      const rows = localRows.length > 0 ? localRows : splitStreamRows;
      if (rows.length === 0) throw new ReleaseEvidenceError('vite_advisory_incomplete', `$.${streamName}`);
      const advice = lines.slice(index + 1, index + 4);
      if (advice.length !== 3 || advice.some((line, adviceIndex) => !VITE_ADVICE[adviceIndex].test(stripAnsi(line)))) {
        throw new ReleaseEvidenceError('vite_advisory_incomplete', `$.${streamName}`);
      }
      const block = [...rows, lines[index], ...advice].join('\n');
      if (Buffer.byteLength(block) > resolvedLimits.maxBlockBytes) {
        throw new ReleaseEvidenceError('vite_advisory_block_too_large', `$.${streamName}`);
      }
      advisories.push(block);
      index += 3;
    }
  }
  if (advisories.length > resolvedLimits.maxBlocks) throw new ReleaseEvidenceError('vite_advisory_count_exceeded');
  if (Buffer.byteLength(advisories.join('\n')) > resolvedLimits.maxTotalBytes) {
    throw new ReleaseEvidenceError('vite_advisory_total_too_large');
  }
  const stdoutSha256 = sha256(Buffer.from(stdout));
  const stderrSha256 = sha256(Buffer.from(stderr));
  return deepFreeze({
    advisories,
    stdoutSha256,
    stderrSha256,
    outputSha256: sha256(Buffer.from(`${stdoutSha256}\n${stderrSha256}\n`)),
  });
}

export function createFileEvidence(relativePath, bytes) {
  const safePath = normalizePackageRelativePath(relativePath, 'evidence file');
  const buffer = asBuffer(bytes, '$.bytes');
  return Object.freeze({ relativePath: safePath, bytes: buffer.byteLength, sha256: sha256(buffer) });
}

export function validateReleaseVersionApproval(value, packageVersion) {
  validateShape(value, {
    approvedCandidateVersion: version(),
    observedCurrentPublicVersion: version(),
    observedPriorUploadVersion: version(),
  }, '$.versionApproval');
  if (value.approvedCandidateVersion !== packageVersion) {
    throw new ReleaseEvidenceError('approved_candidate_version_mismatch', '$.versionApproval.approvedCandidateVersion');
  }
  for (const key of ['observedCurrentPublicVersion', 'observedPriorUploadVersion']) {
    if (compareChromeExtensionVersions(value.approvedCandidateVersion, value[key]) <= 0) {
      throw new ReleaseEvidenceError('approved_candidate_not_newer', `$.versionApproval.${key}`);
    }
  }
  return deepFreeze(value);
}

export function assertReleaseVersionIdentity({
  packageVersion,
  releaseDist,
  provisional,
  runtimeVerification,
  final,
  gate,
  packagedManifestVersion,
  zipManifestVersion,
}) {
  if (!version()(packageVersion)) throw new ReleaseEvidenceError('package_version_invalid', '$.packageVersion');
  const versions = [
    ['$.releaseDist.manifest.extensionVersion', releaseDist?.manifest?.extensionVersion],
    ['$.provisional.packageVersion', provisional?.packageVersion],
    ['$.runtimeVerification.packageVersion', runtimeVerification?.packageVersion],
    ['$.final.packageVersion', final?.packageVersion],
    ['$.gate.packageVersion', gate?.packageVersion],
    ['$.packagedManifest.version', packagedManifestVersion],
    ['$.zipManifest.version', zipManifestVersion],
  ];
  for (const [jsonPath, candidate] of versions) {
    if (candidate === undefined) continue;
    if (!version()(candidate) || candidate !== packageVersion) {
      throw new ReleaseEvidenceError('release_version_identity_mismatch', jsonPath);
    }
  }
  return true;
}

export function assertEvidenceRedacted(value, { forbiddenValues = [], allowedUrlPaths = [], allowedUrls = [], allowedStringLimits = [] } = {}) {
  for (const limit of allowedStringLimits) {
    if (!isPlainObject(limit) || !(limit.path instanceof RegExp) || !Number.isSafeInteger(limit.maxBytes) || limit.maxBytes < MAX_STRING_BYTES) {
      throw new ReleaseEvidenceError('evidence_unbounded');
    }
  }
  const privateValues = forbiddenValues.filter((entry) => typeof entry === 'string' && entry.length > 0);
  const urlPathAllowed = (jsonPath) => allowedUrlPaths.some((entry) => entry instanceof RegExp ? entry.test(jsonPath) : entry === jsonPath);
  const urlValueAllowed = (jsonPath, candidate) => {
    const urls = candidate.match(/\b(?:https?|chrome-extension|data):\/\/[^\s]+/giu) ?? [];
    return urls.length > 0 && allowedUrls.some(({ path, value }) => (
      path.test(jsonPath) && urls.every((url) => value.test(url))
    ));
  };
  let nodes = 0;
  const visit = (candidate, jsonPath, depth) => {
    nodes += 1;
    if (nodes > MAX_VALIDATION_NODES || depth > MAX_VALIDATION_DEPTH) throw new ReleaseEvidenceError('evidence_unbounded', jsonPath);
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new ReleaseEvidenceError('private_evidence_rejected', jsonPath);
      return;
    }
    if (typeof candidate === 'boolean' || candidate === null) return;
    if (typeof candidate === 'string') {
      const stringLimit = allowedStringLimits.find(({ path: allowedPath }) => allowedPath.test(jsonPath))?.maxBytes ?? MAX_STRING_BYTES;
      if (Buffer.byteLength(candidate) > stringLimit) throw new ReleaseEvidenceError('evidence_unbounded', jsonPath);
      if (
        (/\b(?:https?|chrome-extension|data):\/\//iu.test(candidate) && !urlPathAllowed(jsonPath) && !urlValueAllowed(jsonPath, candidate))
        || /\b(?:authorization|bearer|basic)\b|(?:github_pat_|gh[opurs]_|sk-[A-Za-z0-9])|api[-_ ]?key/iu.test(candidate)
        || /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(candidate)
        || privateValues.some((entry) => candidate.includes(entry))
      ) throw new ReleaseEvidenceError('private_evidence_rejected', jsonPath);
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_COLLECTION_ITEMS) throw new ReleaseEvidenceError('evidence_unbounded', jsonPath);
      candidate.forEach((entry, index) => visit(entry, `${jsonPath}[${index}]`, depth + 1));
      return;
    }
    if (!isPlainObject(candidate)) throw new ReleaseEvidenceError('private_evidence_rejected', jsonPath);
    const entries = Object.entries(candidate);
    if (entries.length > MAX_COLLECTION_ITEMS) throw new ReleaseEvidenceError('evidence_unbounded', jsonPath);
    for (const [key, nested] of entries) {
      if (isForbiddenEvidenceKey(key)) throw new ReleaseEvidenceError('private_evidence_rejected', `${jsonPath}.${key}`);
      visit(nested, `${jsonPath}.${key}`, depth + 1);
    }
  };
  visit(value, '$', 0);
  return true;
}

export function validateRuntimeEvidenceFile(contract, raw, context = {}) {
  const resolvedContract = resolveRuntimeContract(contract);
  const bytes = asBuffer(raw, '$');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUNTIME_EVIDENCE_BYTES) {
    throw new ReleaseEvidenceError('runtime_evidence_size_invalid');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReleaseEvidenceError('runtime_evidence_utf8_invalid');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReleaseEvidenceError('runtime_evidence_json_invalid');
  }
  if (`${JSON.stringify(value, null, 2)}\n` !== text) throw new ReleaseEvidenceError('runtime_evidence_not_canonical');
  assertEvidenceRedacted(value, { forbiddenValues: context.forbiddenValues });

  if (context.relativePath !== undefined && context.relativePath !== resolvedContract.filename) {
    throw new ReleaseEvidenceError('runtime_evidence_path_mismatch', '$.relativePath');
  }
  if (resolvedContract.key === 'runtimeComposition') {
    validateShape(value, COMPOSITION_SHAPE, '$');
    validateCompositionInputs(value, context.runtimeFiles);
  } else {
    const factsShape = FACT_SHAPES[resolvedContract.key];
    if (!factsShape) throw new ReleaseEvidenceError('runtime_contract_shape_required');
    validateShape(value, producerShape(resolvedContract, factsShape), '$');
    validatePassingProducerFacts(resolvedContract.key, value);
    if (resolvedContract.key === 'scenarioLab') {
      if (deepEqual(value.releaseDist, value.diagnosticsBuild)) {
        throw new ReleaseEvidenceError('diagnostics_build_not_distinct', '$.diagnosticsBuild');
      }
      if (value.diagnosticsBuild.manifest.extensionVersion !== value.releaseDist.manifest.extensionVersion) {
        throw new ReleaseEvidenceError('diagnostics_build_version_mismatch', '$.diagnosticsBuild.manifest.extensionVersion');
      }
      if (!deepEqual(value.scenarioLab.scenarios.ids, EXPECTED_SCENARIO_IDS)) {
        throw new ReleaseEvidenceError('scenario_ids_mismatch', '$.scenarioLab.scenarios.ids');
      }
    }
  }
  assertReleaseIdentity(value.releaseDist, '$.releaseDist');
  if (context.releaseDist && !deepEqual(value.releaseDist, context.releaseDist)) {
    throw new ReleaseEvidenceError('release_dist_mismatch', '$.releaseDist');
  }
  if (value.diagnosticsBuild) assertReleaseIdentity(value.diagnosticsBuild, '$.diagnosticsBuild');
  if (value.evidenceBytes !== bytes.byteLength) throw new ReleaseEvidenceError('runtime_evidence_byte_count_mismatch', '$.evidenceBytes');
  return deepFreeze({
    value,
    file: createFileEvidence(resolvedContract.filename, bytes),
  });
}

export function validateRuntimeVerificationEvidence(value, context = {}) {
  const shape = {
    schemaVersion: exact(2), generatedAt: timestamp(), executionAuthority: exact('durable_agent_runtime_release_plan'),
    source: { commit: commit(), dirty: exact(false) }, packageVersion: version(),
    environment: environment(),
    checks: Object.fromEntries(FINAL_CHECK_SPECS.map(({ key, command }) => [key, {
      status: exact('passed'), command: exact(command), startedAt: timestamp(), finishedAt: timestamp(), outputSha256: digest(),
    }])),
    build: {
      packageInput: packageFingerprintShape(),
      worker: bundleArtifactShape(),
      mermaid: arrayOf(bundleArtifactShape(), 0, 128),
      advisories: arrayOf(string(1, DEFAULT_ADVISORY_LIMITS.maxBlockBytes), 0, DEFAULT_ADVISORY_LIMITS.maxBlocks),
      outputSha256: digest(),
    },
    runtimeEvidence: Object.fromEntries(RUNTIME_CONTRACT_LIST.map(([key, filename]) => [key, {
      relativePath: exact(filename), bytes: integer(1), sha256: digest(),
    }])),
    provisionalReleaseEvidence: fileEvidenceShape(),
    status: exact('agent_runtime_verification_passed'),
  };
  validateShape(value, shape, '$');
  assertEvidenceRedacted(value, {
    forbiddenValues: context.forbiddenValues,
    allowedStringLimits: [{ path: BUILD_ADVISORY_PATH, maxBytes: DEFAULT_ADVISORY_LIMITS.maxBlockBytes }],
    allowedUrls: [{
      path: BUILD_ADVISORY_PATH,
      value: /^https:\/\/rollupjs\.org\/configuration-options\/#output-manualchunks$/u,
    }],
  });
  assertTimestampOrder(value.generatedAt, Object.values(value.checks), '$.checks');
  validateBuildEvidence(value.build, context);
  if (context.releaseDist) assertReleaseVersionIdentity({
    packageVersion: value.packageVersion,
    releaseDist: context.releaseDist,
    runtimeVerification: value,
    packagedManifestVersion: context.packagedManifestVersion,
    zipManifestVersion: context.zipManifestVersion,
  });
  if (context.sourceCommit && value.source.commit !== context.sourceCommit) throw new ReleaseEvidenceError('source_commit_mismatch', '$.source.commit');
  if (context.packageVersion && value.packageVersion !== context.packageVersion) throw new ReleaseEvidenceError('package_version_mismatch', '$.packageVersion');
  if (context.packageInput && !sameFingerprint(value.build.packageInput, context.packageInput)) throw new ReleaseEvidenceError('package_fingerprint_mismatch', '$.build.packageInput');
  if (context.releaseDist && !sameFingerprint(context.releaseDist.packageInput, value.build.packageInput)) {
    throw new ReleaseEvidenceError('release_dist_fingerprint_mismatch', '$.build.packageInput');
  }
  if (context.runtimeEvidence) {
    for (const [key] of RUNTIME_CONTRACT_LIST) {
      if (!sameFileEvidence(value.runtimeEvidence[key], context.runtimeEvidence[key])) {
        throw new ReleaseEvidenceError('runtime_evidence_hash_mismatch', `$.runtimeEvidence.${key}`);
      }
    }
  }
  return deepFreeze(value);
}

export function validateProvisionalReleaseEvidence(value, context = {}) {
  const shape = {
    schemaVersion: exact(2), generatedAt: timestamp(), packageVersion: version(),
    source: { commit: commit(), dirty: exact(false) },
    package: {
      releaseReady: exact(false), releaseReadinessReason: exact('agent_runtime_verification_required'),
      dashboardSubmissionClaimed: exact(false), zipRootManifest: exact(true), manifestResourcesClosed: exact(true),
      sourceOnlyEntriesExcluded: exact(true), productionDisclosureMarkers: arrayOf(string(1, 256), 0, 128),
    },
    packagedPermissions: {
      permissions: arrayOf(identifier(), 0, 64), optionalPermissions: arrayOf(identifier(), 0, 64),
      hostPermissions: arrayOf(hostPermission(), 0, 128), optionalHostPermissions: arrayOf(hostPermission(), 0, 128),
    },
    packageInput: packageFingerprintShape(),
    build: provisionalBuildShape(),
    generatedFiles: arrayOf(fileEvidenceShape(), 2, 2),
    packagedManifest: fileEvidenceShape(),
    manifestResources: arrayOf({
      relativePath: relativePath(), bytes: integer(0), sha256: digest(), referencedBy: arrayOf(string(1, 256), 1, 128),
    }, 1, MAX_COLLECTION_ITEMS),
  };
  validateShape(value, shape, '$');
  assertEvidenceRedacted(value, {
    forbiddenValues: context.forbiddenValues,
    allowedUrlPaths: [/^\$\.packagedPermissions\.(?:hostPermissions|optionalHostPermissions)\[\d+\]$/u],
    allowedStringLimits: [{ path: BUILD_ADVISORY_PATH, maxBytes: DEFAULT_ADVISORY_LIMITS.maxBlockBytes }],
    allowedUrls: [{
      path: BUILD_ADVISORY_PATH,
      value: /^https:\/\/rollupjs\.org\/configuration-options\/#output-manualchunks$/u,
    }],
  });
  validateBuildEvidence(value.build, context);
  assertSortedUnique(value.packagedPermissions.permissions, '$.packagedPermissions.permissions');
  assertSortedUnique(value.packagedPermissions.optionalPermissions, '$.packagedPermissions.optionalPermissions');
  assertSortedUnique(value.packagedPermissions.hostPermissions, '$.packagedPermissions.hostPermissions');
  assertSortedUnique(value.packagedPermissions.optionalHostPermissions, '$.packagedPermissions.optionalHostPermissions');
  validatePackageEvidenceRelationships(value, context);
  if (context.sourceCommit && value.source.commit !== context.sourceCommit) throw new ReleaseEvidenceError('source_commit_mismatch', '$.source.commit');
  if (context.packageVersion && value.packageVersion !== context.packageVersion) throw new ReleaseEvidenceError('package_version_mismatch', '$.packageVersion');
  if (context.releaseDist) assertReleaseVersionIdentity({
    packageVersion: value.packageVersion,
    releaseDist: context.releaseDist,
    provisional: value,
    packagedManifestVersion: context.packagedManifestVersion,
    zipManifestVersion: context.zipManifestVersion,
  });
  if (context.packageInput && !sameFingerprint(value.packageInput, context.packageInput)) throw new ReleaseEvidenceError('package_fingerprint_mismatch', '$.packageInput');
  if (context.build && !deepEqual(value.build, context.build)) {
    throw new ReleaseEvidenceError('provisional_build_mismatch', '$.build');
  }
  return deepFreeze(value);
}

export function prepareReleaseFinalization(input) {
  if (!isPlainObject(input)) throw new ReleaseEvidenceError('finalization_input_invalid');
  if (!commit()(input.sourceCommit)) throw new ReleaseEvidenceError('source_commit_invalid', '$.sourceCommit');
  validateShape(input.packageInput, packageFingerprintShape(), '$.packageInput');
  assertReleaseIdentity(input.releaseDist, '$.releaseDist');
  const manualExclusions = Array.isArray(input.manualExclusions)
    ? [...input.manualExclusions].sort(bytewiseCompare)
    : null;
  if (!manualExclusions || !deepEqual(manualExclusions, REQUIRED_MANUAL_EXCLUSIONS)) {
    throw new ReleaseEvidenceError('manual_exclusions_invalid', '$.manualExclusions');
  }
  if (!version()(input.packagedManifestVersion)) {
    throw new ReleaseEvidenceError('packaged_manifest_version_required', '$.packagedManifestVersion');
  }
  if (!version()(input.zipManifestVersion)) {
    throw new ReleaseEvidenceError('zip_manifest_version_required', '$.zipManifestVersion');
  }
  validateReleaseVersionApproval(input.versionApproval, input.packageVersion);
  const expectedPaths = expectedEvidencePaths(input.packageVersion);
  for (const [key, candidate] of [
    ['provisional', input.provisionalRelativePath],
    ['runtime', input.runtimeVerificationRelativePath],
    ['final', input.finalRelativePath],
    ['gate', input.gateRelativePath],
  ]) {
    if (candidate !== expectedPaths[key]) throw new ReleaseEvidenceError('publication_path_mismatch', `$.${key}RelativePath`);
  }
  assertExactKeys(input.runtimeEvidenceRaw, RUNTIME_CONTRACT_LIST.map(([key]) => key), '$.runtimeEvidenceRaw');

  const provisionalBytes = asBuffer(input.provisionalRaw, '$.provisionalRaw');
  const runtimeBytes = asBuffer(input.runtimeVerificationRaw, '$.runtimeVerificationRaw');
  const provisional = parseCanonicalEvidence(provisionalBytes, '$.provisionalRaw');
  const runtimeVerification = parseCanonicalEvidence(runtimeBytes, '$.runtimeVerificationRaw');
  const now = input.publicationTimestamp;
  validateTimestamp(now, '$.publicationTimestamp');
  if (now !== runtimeVerification.generatedAt) {
    throw new ReleaseEvidenceError('publication_timestamp_mismatch', '$.publicationTimestamp');
  }

  const runtimeFiles = {};
  const runtimeDocuments = {};
  for (const [key] of RUNTIME_CONTRACT_LIST) {
    const validated = validateRuntimeEvidenceFile(key, input.runtimeEvidenceRaw[key], {
      releaseDist: input.releaseDist,
      relativePath: RUNTIME_EVIDENCE_CONTRACTS[key].filename,
      forbiddenValues: input.forbiddenValues,
      runtimeFiles,
      expectedScenarioIds: input.expectedScenarioIds,
    });
    runtimeFiles[key] = validated.file;
    runtimeDocuments[key] = validated.value;
  }
  assertReleaseVersionIdentity({
    packageVersion: input.packageVersion,
    releaseDist: input.releaseDist,
    provisional,
    runtimeVerification,
    packagedManifestVersion: input.packagedManifestVersion,
    zipManifestVersion: input.zipManifestVersion,
  });
  validateCompositionBindings(runtimeDocuments, runtimeFiles);
  validateRuntimeVerificationEvidence(runtimeVerification, {
    sourceCommit: input.sourceCommit,
    releaseDist: input.releaseDist,
    packageVersion: input.packageVersion,
    packageInput: input.packageInput,
    runtimeEvidence: runtimeFiles,
    forbiddenValues: input.forbiddenValues,
  });
  const runtimePackageBuild = {
    worker: runtimeVerification.build.worker,
    mermaid: runtimeVerification.build.mermaid,
    advisories: runtimeVerification.build.advisories,
    outputSha256: runtimeVerification.build.outputSha256,
  };
  if (!deepEqual(provisional.build, runtimePackageBuild)) {
    throw new ReleaseEvidenceError('provisional_build_mismatch', '$.build');
  }
  validateProvisionalReleaseEvidence(provisional, {
    sourceCommit: input.sourceCommit,
    packageVersion: input.packageVersion,
    packageInput: input.packageInput,
    releaseDist: input.releaseDist,
    forbiddenValues: input.forbiddenValues,
  });
  assertProvisionalTimestampOrder(provisional.generatedAt, runtimeVerification);
  if (!sameFingerprint(input.releaseDist.packageInput, input.packageInput)) {
    throw new ReleaseEvidenceError('release_dist_fingerprint_mismatch', '$.releaseDist.packageInput');
  }
  if (!sameFingerprint(provisional.packageInput, runtimeVerification.build.packageInput)) {
    throw new ReleaseEvidenceError('package_fingerprint_mismatch', '$.packageInput');
  }

  const provisionalFile = createFileEvidence(input.provisionalRelativePath, provisionalBytes);
  const runtimeFile = createFileEvidence(input.runtimeVerificationRelativePath, runtimeBytes);
  if (!sameFileEvidence(runtimeVerification.provisionalReleaseEvidence, provisionalFile)) {
    throw new ReleaseEvidenceError('provisional_digest_mismatch', '$.provisionalReleaseEvidence');
  }
  const finalValue = deepClone(provisional);
  finalValue.package = {
    ...finalValue.package,
    releaseReady: true,
    releaseReadinessReason: 'agent_runtime_verification_passed',
    finalizedAt: now,
  };
  const finalBytes = canonicalBytes(finalValue);
  const finalFile = createFileEvidence(input.finalRelativePath, finalBytes);
  const gateValue = {
    schemaVersion: 2,
    generatedAt: now,
    executionAuthority: 'durable_agent_runtime_release_plan',
    source: { commit: input.sourceCommit, dirty: false },
    packageVersion: input.packageVersion,
    packageInput: input.packageInput,
    evidence: { provisional: provisionalFile, runtime: runtimeFile, final: finalFile },
    build: {
      worker: runtimeVerification.build.worker,
      mermaid: runtimeVerification.build.mermaid,
      advisorySha256: sha256(Buffer.from(runtimeVerification.build.advisories.join('\n'))),
    },
    runtimeEvidence: runtimeFiles,
    claims: {
      sourceVerified: true,
      packageReleaseReady: true,
      liveProviderManuallyChecked: false,
      dashboardSubmissionClaimed: false,
    },
    manualExclusions,
    status: 'release_ready_verified',
  };
  assertReleaseVersionIdentity({
    packageVersion: input.packageVersion,
    releaseDist: input.releaseDist,
    provisional,
    runtimeVerification,
    final: finalValue,
    gate: gateValue,
    packagedManifestVersion: input.packagedManifestVersion,
    zipManifestVersion: input.zipManifestVersion,
  });
  const gateBytes = canonicalBytes(gateValue);
  validatePublishedReleaseGate({
    finalRaw: finalBytes,
    gateRaw: gateBytes,
    finalRelativePath: input.finalRelativePath,
    packageVersion: input.packageVersion,
    releaseDist: input.releaseDist,
    sourceCommit: input.sourceCommit,
    packageInput: input.packageInput,
    packagedManifestVersion: input.packagedManifestVersion,
    zipManifestVersion: input.zipManifestVersion,
    forbiddenValues: input.forbiddenValues,
  });
  return deepFreeze({
    provisionalFile,
    runtimeFile,
    final: { value: finalValue, bytes: finalBytes, file: finalFile },
    gate: { value: gateValue, bytes: gateBytes, file: createFileEvidence(input.gateRelativePath, gateBytes) },
  });
}

export function planEvidencePublication(prepared, paths, transactionId, existing = {}) {
  if (!isPlainObject(prepared) || !isPlainObject(paths)) throw new ReleaseEvidenceError('publication_plan_invalid');
  validateShape(paths, { provisional: relativePath(), runtime: relativePath(), final: relativePath(), gate: relativePath() }, '$.paths');
  if (new Set(Object.values(paths)).size !== 4) throw new ReleaseEvidenceError('publication_paths_not_distinct');
  const preparedFiles = {
    provisional: prepared.provisionalFile,
    runtime: prepared.runtimeFile,
    final: prepared.final?.file,
    gate: prepared.gate?.file,
  };
  for (const key of ['provisional', 'runtime', 'final', 'gate']) {
    if (preparedFiles[key]?.relativePath !== paths[key]) {
      throw new ReleaseEvidenceError('publication_path_mismatch', `$.paths.${key}`);
    }
  }
  if (typeof transactionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(transactionId)) {
    throw new ReleaseEvidenceError('transaction_id_invalid');
  }
  const expectedFinal = asBuffer(prepared.final?.bytes, '$.prepared.final.bytes');
  const expectedGate = asBuffer(prepared.gate?.bytes, '$.prepared.gate.bytes');
  if (!sameFileEvidence(prepared.final?.file, createFileEvidence(paths.final, expectedFinal))) {
    throw new ReleaseEvidenceError('prepared_evidence_mismatch', '$.prepared.final');
  }
  if (!sameFileEvidence(prepared.gate?.file, createFileEvidence(paths.gate, expectedGate))) {
    throw new ReleaseEvidenceError('prepared_evidence_mismatch', '$.prepared.gate');
  }
  const { gateValue } = validatePublishedReleaseGate({
    finalRaw: expectedFinal,
    gateRaw: expectedGate,
    finalRelativePath: paths.final,
  });
  const expectedPaths = expectedEvidencePaths(gateValue.packageVersion);
  for (const key of ['provisional', 'runtime', 'final', 'gate']) {
    if (paths[key] !== expectedPaths[key]) throw new ReleaseEvidenceError('publication_path_mismatch', `$.paths.${key}`);
  }
  for (const key of ['provisional', 'runtime', 'final']) {
    if (!sameFileEvidence(gateValue.evidence?.[key], preparedFiles[key])) {
      throw new ReleaseEvidenceError('prepared_evidence_mismatch', `$.prepared.${key}`);
    }
  }
  const existingKeys = Object.keys(existing);
  if (!deepEqual(existingKeys, []) && !deepEqual(existingKeys, ['final']) && !deepEqual(existingKeys, ['gate']) && !deepEqual(existingKeys, ['final', 'gate'])) {
    throw new ReleaseEvidenceError('publication_existing_invalid', '$.existing');
  }
  const existingFinal = optionalBuffer(existing.final);
  const existingGate = optionalBuffer(existing.gate);
  if (existingGate && !existingFinal) throw new ReleaseEvidenceError('published_gate_without_final', '$.existing.gate');
  if (existingFinal && !existingFinal.equals(expectedFinal)) throw new ReleaseEvidenceError('published_final_mismatch', '$.existing.final');
  if (existingGate && !existingGate.equals(expectedGate)) throw new ReleaseEvidenceError('published_gate_mismatch', '$.existing.gate');
  if (existingGate) return deepFreeze({ status: 'already_published', actions: [], cleanup: [] });

  const actions = [];
  const cleanup = [];
  const queue = (kind, destination, bytes) => {
    const temporary = `${destination}.${transactionId}.tmp`;
    actions.push({ operation: 'writeExclusive', kind, path: temporary, mode: 0o600, bytes: bytes.toString('utf8') });
    actions.push({ operation: 'rename', kind, from: temporary, to: destination });
    cleanup.push(temporary);
  };
  if (!existingFinal) queue('final', paths.final, expectedFinal);
  queue('gate', paths.gate, expectedGate);
  const writes = actions.filter((action) => action.operation === 'writeExclusive');
  const renames = actions.filter((action) => action.operation === 'rename');
  return deepFreeze({
    status: existingFinal ? 'recover_gate' : 'publish_required',
    actions: [...writes, ...renames],
    cleanup,
  });
}

export function validatePublishedReleaseGate(input) {
  const finalBytes = asBuffer(input.finalRaw, '$.finalRaw');
  const gateBytes = asBuffer(input.gateRaw, '$.gateRaw');
  const finalValue = parseCanonicalEvidence(finalBytes, '$.finalRaw');
  const gateValue = parseCanonicalEvidence(gateBytes, '$.gateRaw');
  validateShape(finalValue, finalReleaseEvidenceShape(), '$.finalRaw');
  validateShape(gateValue, publishedGateShape(), '$.gateRaw');
  assertReleaseVersionIdentity({
    packageVersion: input.packageVersion ?? finalValue.packageVersion,
    releaseDist: input.releaseDist,
    final: finalValue,
    gate: gateValue,
    packagedManifestVersion: input.packagedManifestVersion,
    zipManifestVersion: input.zipManifestVersion,
  });
  const expectedPaths = expectedEvidencePaths(finalValue.packageVersion);
  if (input.finalRelativePath !== expectedPaths.final) {
    throw new ReleaseEvidenceError('publication_path_mismatch', '$.finalRelativePath');
  }
  for (const key of ['provisional', 'runtime', 'final']) {
    if (gateValue.evidence[key].relativePath !== expectedPaths[key]) {
      throw new ReleaseEvidenceError('publication_path_mismatch', `$.gateRaw.evidence.${key}.relativePath`);
    }
  }
  if (!sameFingerprint(finalValue.packageInput, gateValue.packageInput)) {
    throw new ReleaseEvidenceError('published_fingerprint_mismatch', '$.gateRaw.packageInput');
  }
  if (!deepEqual(finalValue.source, gateValue.source)) {
    throw new ReleaseEvidenceError('published_source_mismatch', '$.gateRaw.source');
  }
  if (input.sourceCommit && finalValue.source.commit !== input.sourceCommit) {
    throw new ReleaseEvidenceError('source_commit_mismatch', '$.finalRaw.source.commit');
  }
  if (input.packageInput && !sameFingerprint(finalValue.packageInput, input.packageInput)) {
    throw new ReleaseEvidenceError('package_fingerprint_mismatch', '$.finalRaw.packageInput');
  }
  if (input.releaseDist && !sameFingerprint(finalValue.packageInput, input.releaseDist.packageInput)) {
    throw new ReleaseEvidenceError('release_dist_fingerprint_mismatch', '$.finalRaw.packageInput');
  }
  validatePackageEvidenceRelationships(finalValue, { releaseDist: input.releaseDist });
  validateBuildEvidence(finalValue.build, { releaseDist: input.releaseDist });
  if (
    !deepEqual(gateValue.build.worker, finalValue.build.worker)
    || !deepEqual(gateValue.build.mermaid, finalValue.build.mermaid)
    || gateValue.build.advisorySha256 !== sha256(Buffer.from(finalValue.build.advisories.join('\n')))
  ) throw new ReleaseEvidenceError('published_build_mismatch', '$.gateRaw.build');
  if (
    Date.parse(finalValue.generatedAt) > Date.parse(finalValue.package.finalizedAt)
    || finalValue.package.finalizedAt !== gateValue.generatedAt
  ) throw new ReleaseEvidenceError('published_timestamp_mismatch', '$.gateRaw.generatedAt');
  if (finalValue.package?.releaseReady !== true || finalValue.package?.dashboardSubmissionClaimed !== false) {
    throw new ReleaseEvidenceError('final_release_state_invalid', '$.finalRaw.package');
  }
  if (gateValue.status !== 'release_ready_verified') throw new ReleaseEvidenceError('release_gate_status_invalid', '$.gateRaw.status');
  if (!sameFileEvidence(gateValue.evidence?.final, createFileEvidence(input.finalRelativePath, finalBytes))) {
    throw new ReleaseEvidenceError('final_digest_mismatch', '$.gateRaw.evidence.final');
  }
  if (gateValue.claims?.packageReleaseReady !== true || gateValue.claims?.dashboardSubmissionClaimed !== false) {
    throw new ReleaseEvidenceError('release_gate_claim_invalid', '$.gateRaw.claims');
  }
  if (!deepEqual(gateValue.manualExclusions, REQUIRED_MANUAL_EXCLUSIONS)) {
    throw new ReleaseEvidenceError('manual_exclusions_invalid', '$.gateRaw.manualExclusions');
  }
  assertEvidenceRedacted({ finalValue, gateValue }, {
    forbiddenValues: input.forbiddenValues,
    allowedUrlPaths: [/^\$\.finalValue\.packagedPermissions\.(?:hostPermissions|optionalHostPermissions)\[\d+\]$/u],
    allowedStringLimits: [{ path: FINAL_BUILD_ADVISORY_PATH, maxBytes: DEFAULT_ADVISORY_LIMITS.maxBlockBytes }],
    allowedUrls: [{
      path: FINAL_BUILD_ADVISORY_PATH,
      value: /^https:\/\/rollupjs\.org\/configuration-options\/#output-manualchunks$/u,
    }],
  });
  return deepFreeze({ finalValue, gateValue });
}

function finalReleaseEvidenceShape() {
  return {
    schemaVersion: exact(2), generatedAt: timestamp(), packageVersion: version(),
    source: { commit: commit(), dirty: exact(false) },
    package: {
      releaseReady: exact(true), releaseReadinessReason: exact('agent_runtime_verification_passed'),
      dashboardSubmissionClaimed: exact(false), zipRootManifest: exact(true), manifestResourcesClosed: exact(true),
      sourceOnlyEntriesExcluded: exact(true), productionDisclosureMarkers: arrayOf(string(1, 256), 0, 128),
      finalizedAt: timestamp(),
    },
    packagedPermissions: {
      permissions: arrayOf(identifier(), 0, 64), optionalPermissions: arrayOf(identifier(), 0, 64),
      hostPermissions: arrayOf(hostPermission(), 0, 128), optionalHostPermissions: arrayOf(hostPermission(), 0, 128),
    },
    packageInput: packageFingerprintShape(),
    build: provisionalBuildShape(),
    generatedFiles: arrayOf(fileEvidenceShape(), 2, 2),
    packagedManifest: fileEvidenceShape(),
    manifestResources: arrayOf({
      relativePath: relativePath(), bytes: integer(0), sha256: digest(), referencedBy: arrayOf(string(1, 256), 1, 128),
    }, 1, MAX_COLLECTION_ITEMS),
  };
}

function publishedGateShape() {
  return {
    schemaVersion: exact(2), generatedAt: timestamp(), executionAuthority: exact('durable_agent_runtime_release_plan'),
    source: { commit: commit(), dirty: exact(false) }, packageVersion: version(), packageInput: packageFingerprintShape(),
    evidence: { provisional: fileEvidenceShape(), runtime: fileEvidenceShape(), final: fileEvidenceShape() },
    build: { worker: bundleArtifactShape(), mermaid: arrayOf(bundleArtifactShape(), 0, 128), advisorySha256: digest() },
    runtimeEvidence: Object.fromEntries(RUNTIME_CONTRACT_LIST.map(([key, filename]) => [key, {
      relativePath: exact(filename), bytes: integer(1), sha256: digest(),
    }])),
    claims: {
      sourceVerified: exact(true), packageReleaseReady: exact(true), liveProviderManuallyChecked: exact(false),
      dashboardSubmissionClaimed: exact(false),
    },
    manualExclusions: arrayOf(identifier(), 1, 32),
    status: exact('release_ready_verified'),
  };
}

function producerShape(contract, factsShape) {
  const shape = {
    schemaVersion: exact(1), status: exact('passed'), proofScope: exact(contract.proofScope),
    productionDistExercised: exact(contract.productionDistExercised), releaseDist: RELEASE_DIST_SHAPE,
  };
  if (contract.key === 'scenarioLab') shape.diagnosticsBuild = RELEASE_DIST_SHAPE;
  shape[contract.factsKey] = factsShape;
  shape.containment = CONTAINMENT_SHAPE;
  shape.cleanup = CLEANUP_SHAPE;
  shape.evidenceBytes = integer(1, MAX_RUNTIME_EVIDENCE_BYTES);
  return shape;
}

function validateCompositionInputs(value, runtimeFiles) {
  const producerContracts = RUNTIME_CONTRACT_LIST.filter(([key]) => key !== 'runtimeComposition');
  producerContracts.forEach(([key, filename, proofScope]) => {
    const input = value.inputs[key];
    if (input.filename !== filename) throw new ReleaseEvidenceError('composition_filename_mismatch', `$.inputs.${key}.filename`);
    if (input.proofScope !== proofScope) throw new ReleaseEvidenceError('composition_scope_mismatch', `$.inputs.${key}.proofScope`);
    if (runtimeFiles?.[key] && !sameInputFileEvidence(input, runtimeFiles[key])) {
      throw new ReleaseEvidenceError('composition_input_mismatch', `$.inputs.${key}`);
    }
  });
}

function validateCompositionBindings(documents, files) {
  const runtimeComposition = documents.runtimeComposition;
  for (const key of ['artifact', 'workerRecovery', 'uiHistory', 'organize', 'organizeRecovery']) {
    if (!deepEqual(documents[key].releaseDist, runtimeComposition.releaseDist)) {
      throw new ReleaseEvidenceError('production_release_dist_mismatch', `$.${key}.releaseDist`);
    }
  }
  if (!deepEqual(documents.scenarioLab.releaseDist, runtimeComposition.releaseDist)) {
    throw new ReleaseEvidenceError('scenario_release_dist_mismatch', '$.scenarioLab.releaseDist');
  }
  validateCompositionInputs(runtimeComposition, files);
  const organize = documents.organize.organize;
  const organizeRecovery = documents.organizeRecovery.organizeRecovery;
  const expectedOutcomes = {
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
  };
  if (!deepEqual(runtimeComposition.organizeOutcomes, expectedOutcomes)) {
    throw new ReleaseEvidenceError('composition_outcome_mismatch', '$.runtimeComposition.organizeOutcomes');
  }
}

function validatePassingProducerFacts(key, value) {
  const require = (condition, jsonPath, code = 'passing_evidence_relationship_invalid') => {
    if (!condition) throw new ReleaseEvidenceError(code, jsonPath);
  };
  const requireZero = (candidate, jsonPath) => require(candidate === 0, jsonPath, 'passing_evidence_nonzero_failure');
  const requireFalse = (candidate, jsonPath) => require(candidate === false, jsonPath, 'passing_evidence_failure_flag');
  if (key === 'artifact') {
    const facts = value.artifactFlow;
    require(facts.coverage.deliveredBytes === facts.coverage.expectedBytes, '$.artifactFlow.coverage.deliveredBytes');
    require(facts.provider.exhaustivePageReads === facts.coverage.pageCount, '$.artifactFlow.provider.exhaustivePageReads');
  } else if (key === 'workerRecovery') {
    validateWorkerRelationships(value.workerRecovery);
    value.workerRecovery.runtimeDiagnostics.forEach((entry, index) => {
      requireZero(entry.count, `$.workerRecovery.runtimeDiagnostics[${index}].count`);
      requireFalse(entry.overflow, `$.workerRecovery.runtimeDiagnostics[${index}].overflow`);
    });
  } else if (key === 'uiHistory') {
    const facts = value.uiHistory;
    for (const field of ['workerUnexpected', 'pageUnexpected', 'pageIssues']) requireZero(facts.network[field], `$.uiHistory.network.${field}`);
    requireFalse(facts.network.overflow, '$.uiHistory.network.overflow');
    for (const field of ['failures', 'interruptions', 'selectedScenarioTools']) requireZero(facts.provider[field], `$.uiHistory.provider.${field}`);
    require(facts.provider.authenticatedRequests === facts.provider.requests, '$.uiHistory.provider.authenticatedRequests');
    for (const field of ['secretDurableOccurrences', 'secretEvidenceOccurrences', 'neverSubmittedDurableOccurrences', 'neverSubmittedProviderOccurrences', 'rejectedDurableOccurrences', 'rejectedProviderOccurrences']) {
      requireZero(facts.canary[field], `$.uiHistory.canary.${field}`);
    }
  } else if (key === 'organize') {
    const facts = value.organize;
    for (const field of ['unexpectedRequests', 'failures', 'customHostDeniedFetches']) requireZero(facts.provider[field], `$.organize.provider.${field}`);
    requireFalse(facts.provider.overflow, '$.organize.provider.overflow');
    require(facts.provider.authenticatedRequests === facts.provider.requests, '$.organize.provider.authenticatedRequests');
    require(facts.ownership.terminalProjectionPages === facts.ownership.rawPages, '$.organize.ownership.terminalProjectionPages');
    require(facts.draftRecovery.invalidationPages === facts.draftRecovery.contentPages, '$.organize.draftRecovery.invalidationPages');
    require(facts.draftRecovery.draftsPreserved === facts.draftRecovery.contentPages, '$.organize.draftRecovery.draftsPreserved');
    require(facts.draftRecovery.replacementSessionPages === facts.draftRecovery.contentPages, '$.organize.draftRecovery.replacementSessionPages');
    require(facts.nextAdmission.noJobProjectionPages === facts.nextAdmission.actorPages + facts.nextAdmission.observerPages, '$.organize.nextAdmission.noJobProjectionPages');
    require(facts.dismiss.convergedPages === facts.draftRecovery.contentPages, '$.organize.dismiss.convergedPages');
  } else if (key === 'organizeRecovery') {
    validateReplacementRelationships(value.organizeRecovery.replacement, '$.organizeRecovery.replacement');
    require(value.organizeRecovery.epochs.oldEpochId !== value.organizeRecovery.epochs.newEpochId, '$.organizeRecovery.epochs');
    require(value.organizeRecovery.outcome.settledCount === value.organizeRecovery.outcome.uniqueSettledPositionCount, '$.organizeRecovery.outcome.uniqueSettledPositionCount');
    requireZero(value.organizeRecovery.provider.failures, '$.organizeRecovery.provider.failures');
  } else if (key === 'scenarioLab') {
    requireZero(value.scenarioLab.issues.page, '$.scenarioLab.issues.page');
    requireZero(value.scenarioLab.issues.worker, '$.scenarioLab.issues.worker');
    require(value.scenarioLab.scenarios.failedCount === 0, '$.scenarioLab.scenarios.failedCount');
    require(value.scenarioLab.scenarios.writeOutcomeEvents === 0, '$.scenarioLab.scenarios.writeOutcomeEvents');
    require(value.scenarioLab.scenarios.lastEventTerminal === true, '$.scenarioLab.scenarios.lastEventTerminal');
    require(value.scenarioLab.scenarios.completedCount + value.scenarioLab.scenarios.cancelledCount === value.scenarioLab.scenarios.rootCount, '$.scenarioLab.scenarios.rootCount');
    require(deepEqual(value.scenarioLab.rawCapture, { warningRendered: true, armedBeforeReload: true, disarmedAfterReload: true }), '$.scenarioLab.rawCapture');
  }
}

function validateWorkerRelationships(value) {
  const expected = ['committed_replay', 'statically_read_only_resume', 'state_uncertain_abandonment'];
  for (const [collection, idKey] of [['scenarios', 'id'], ['replacements', 'scenarioId'], ['productEpochs', 'scenarioId'], ['runtimeDiagnostics', 'scenarioId']]) {
    if (!deepEqual(value[collection].map((entry) => entry[idKey]), expected)) {
      throw new ReleaseEvidenceError('worker_scenario_order_invalid', `$.workerRecovery.${collection}`);
    }
  }
  if (!deepEqual(value.scenarios.map(({ interruptions }) => interruptions), [0, 1, 1])) {
    throw new ReleaseEvidenceError('passing_evidence_relationship_invalid', '$.workerRecovery.scenarios');
  }
  value.scenarios.forEach((entry, index) => {
    if (entry.replacements !== 1 || entry.revisionDelta !== 1 || entry.writeDelta !== 0 || entry.receiptCount !== 1 || entry.recoveryRows !== 0) {
      throw new ReleaseEvidenceError('passing_evidence_relationship_invalid', `$.workerRecovery.scenarios[${index}]`);
    }
  });
  value.replacements.forEach((entry, index) => validateReplacementRelationships(entry, `$.workerRecovery.replacements[${index}]`));
  value.productEpochs.forEach((entry, index) => {
    if (entry.oldEpochId === entry.newEpochId) throw new ReleaseEvidenceError('passing_evidence_relationship_invalid', `$.workerRecovery.productEpochs[${index}]`);
  });
}

function validateReplacementRelationships(value, jsonPath) {
  if (
    value.oldVersionId !== value.newVersionId
    || value.oldTargetId !== value.newTargetId
    || value.oldAttachmentId !== value.newAttachmentId
    || !(value.stopCommandOrdinal < value.stoppedOrdinal
      && value.stoppedOrdinal <= value.installCompletedOrdinal
      && value.installCompletedOrdinal <= value.startCommandOrdinal
      && value.startCommandOrdinal < value.runningOrdinal)
  ) throw new ReleaseEvidenceError('passing_evidence_relationship_invalid', jsonPath);
}

function assertReleaseIdentity(value, jsonPath) {
  try {
    assertRuntimeReleaseDistIdentity(value);
  } catch {
    throw new ReleaseEvidenceError('release_dist_invalid', jsonPath);
  }
}
function expectedEvidencePaths(packageVersion) {
  return {
    provisional: `release-evidence-${packageVersion}.provisional.json`,
    runtime: 'agent-runtime-verification.json',
    final: `release-evidence-${packageVersion}.json`,
    gate: 'agent-release-gate-evidence.json',
  };
}

function assertExactKeys(value, expected, jsonPath) {
  if (!isPlainObject(value) || !deepEqual(Object.keys(value), expected)) {
    throw new ReleaseEvidenceError('schema_invalid', jsonPath);
  }
}

function validatePackageEvidenceRelationships(value, context) {
  const generatedPaths = value.generatedFiles.map(({ relativePath }) => relativePath);
  assertSortedUnique(generatedPaths, '$.generatedFiles');
  const baseName = `better-github-stars-manager-${value.packageVersion}.zip`;
  if (!deepEqual(generatedPaths, [`${baseName}.sha256`, baseName].sort(bytewiseCompare))) {
    throw new ReleaseEvidenceError('generated_file_set_mismatch', '$.generatedFiles');
  }
  const resourcePaths = value.manifestResources.map(({ relativePath }) => relativePath);
  assertSortedUnique(resourcePaths, '$.manifestResources');
  value.manifestResources.forEach((resource, index) => {
    assertSortedUnique(resource.referencedBy, `$.manifestResources[${index}].referencedBy`);
  });
  if (!context.releaseDist) return;
  if (!sameFingerprint(value.packageInput, context.releaseDist.packageInput)) {
    throw new ReleaseEvidenceError('release_dist_fingerprint_mismatch', '$.packageInput');
  }
  if (!sameFileEvidence(value.packagedManifest, context.releaseDist.manifest)) {
    throw new ReleaseEvidenceError('packaged_manifest_identity_mismatch', '$.packagedManifest');
  }
  for (const key of ['loader', 'worker']) {
    const resource = value.manifestResources.find(({ relativePath }) => relativePath === context.releaseDist[key].relativePath);
    if (!resource || !sameFileEvidence(resource, context.releaseDist[key])) {
      throw new ReleaseEvidenceError('manifest_resource_identity_mismatch', `$.manifestResources.${key}`);
    }
  }
}

function assertProvisionalTimestampOrder(provisionalGeneratedAt, runtimeVerification) {
  const packageCheck = runtimeVerification.checks.packageExtension;
  const generated = Date.parse(provisionalGeneratedAt);
  if (
    generated < Date.parse(packageCheck.startedAt)
    || generated > Date.parse(packageCheck.finishedAt)
    || generated > Date.parse(runtimeVerification.generatedAt)
  ) throw new ReleaseEvidenceError('provisional_timestamp_invalid', '$.provisionalRaw.generatedAt');
}

function validateShape(value, shape, jsonPath) {
  if (typeof shape === 'function') {
    if (!shape(value)) throw new ReleaseEvidenceError('schema_invalid', jsonPath);
    return;
  }
  if (isArrayShape(shape)) {
    if (!Array.isArray(value) || value.length < shape.minimum || value.length > shape.maximum) {
      throw new ReleaseEvidenceError('schema_invalid', jsonPath);
    }
    value.forEach((entry, index) => validateShape(entry, shape.item, `${jsonPath}[${index}]`));
    return;
  }
  if (!isPlainObject(value) || !isPlainObject(shape)) throw new ReleaseEvidenceError('schema_invalid', jsonPath);
  const actual = Object.keys(value);
  const expected = Object.keys(shape);
  if (!deepEqual(actual, expected)) throw new ReleaseEvidenceError('schema_invalid', jsonPath);
  expected.forEach((key) => validateShape(value[key], shape[key], `${jsonPath}.${key}`));
}

function parseCanonicalEvidence(bytes, jsonPath) {
  let text;
  let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new ReleaseEvidenceError('evidence_parse_invalid', jsonPath);
  }
  if (`${JSON.stringify(value, null, 2)}\n` !== text) throw new ReleaseEvidenceError('evidence_not_canonical', jsonPath);
  return value;
}

function assertTimestampOrder(generatedAt, checks, jsonPath) {
  let prior = -Infinity;
  for (const [index, check] of checks.entries()) {
    const started = Date.parse(check.startedAt);
    const finished = Date.parse(check.finishedAt);
    if (started < prior || finished < started || Date.parse(generatedAt) < finished) {
      throw new ReleaseEvidenceError('check_timestamp_invalid', `${jsonPath}[${index}]`);
    }
    prior = finished;
  }
}

function validateBuildEvidence(build, context) {
  try {
    enforceWorkerReleaseBaseline(build.worker, context.workerBaseline ?? RELEASE_WORKER_BASELINE);
  } catch {
    throw new ReleaseEvidenceError('worker_release_baseline_mismatch', '$.build.worker');
  }
  if (build.worker.kib !== build.worker.bytes / 1024) {
    throw new ReleaseEvidenceError('worker_kib_mismatch', '$.build.worker.kib');
  }
  if (context.releaseDist) {
    const expectedWorker = context.releaseDist.worker;
    if (
      build.worker.relativePath !== expectedWorker.relativePath
      || build.worker.bytes !== expectedWorker.bytes
      || build.worker.sha256 !== expectedWorker.sha256
    ) throw new ReleaseEvidenceError('worker_identity_mismatch', '$.build.worker');
  }
  assertSortedUnique(build.mermaid.map(({ relativePath }) => relativePath), '$.build.mermaid');
  for (const [index, artifact] of build.mermaid.entries()) {
    if (artifact.kib !== artifact.bytes / 1024) {
      throw new ReleaseEvidenceError('mermaid_kib_mismatch', `$.build.mermaid[${index}].kib`);
    }
  }
  if (Buffer.byteLength(build.advisories.join('\n')) > DEFAULT_ADVISORY_LIMITS.maxTotalBytes) {
    throw new ReleaseEvidenceError('vite_advisory_total_too_large', '$.build.advisories');
  }
  for (const [index, advisory] of build.advisories.entries()) {
    const parsed = parseViteChunkAdvisories({ stdout: advisory, stderr: '' });
    if (parsed.advisories.length !== 1 || parsed.advisories[0] !== advisory) {
      throw new ReleaseEvidenceError('vite_advisory_incomplete', `$.build.advisories[${index}]`);
    }
  }
}

function validateTimestamp(value, jsonPath) {
  if (!isCanonicalTimestamp(value)) throw new ReleaseEvidenceError('timestamp_invalid', jsonPath);
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertSortedUnique(value, jsonPath) {
  if (!deepEqual(value, [...new Set(value)].sort(bytewiseCompare))) throw new ReleaseEvidenceError('sorted_unique_required', jsonPath);
}

function resolveRuntimeContract(contract) {
  if (typeof contract === 'string') {
    const resolved = RUNTIME_EVIDENCE_CONTRACTS[contract];
    if (resolved) return resolved;
  }
  if (isPlainObject(contract) && RUNTIME_EVIDENCE_CONTRACTS[contract.key] === contract) return contract;
  throw new ReleaseEvidenceError('runtime_contract_invalid');
}

function sameFingerprint(left, right) {
  return Boolean(left && right)
    && left.algorithm === right.algorithm
    && left.fileCount === right.fileCount
    && left.sha256 === right.sha256;
}

function sameFileEvidence(left, right) {
  return Boolean(left && right)
    && left.relativePath === right.relativePath
    && left.bytes === right.bytes
    && left.sha256 === right.sha256;
}

function sameInputFileEvidence(left, right) {
  return left.filename === right.relativePath && left.bytes === right.bytes && left.sha256 === right.sha256;
}

function canonicalBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function asBuffer(value, jsonPath) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value);
  throw new ReleaseEvidenceError('bytes_required', jsonPath);
}

function optionalBuffer(value) {
  return value === undefined || value === null ? null : asBuffer(value, '$.existing');
}

function isForbiddenEvidenceKey(key) {
  if (key === 'toolResults' || key === 'rawCapture') return false;
  const normalized = key.replace(/([a-z])([A-Z])/gu, '$1_$2').toLowerCase();
  return /^(?:authorization|authorization_header|headers?|cookies?|api_key|credential|credentials|secret|token|prompt|raw_prompt|private_note|private_code|transcript|messages?|tool_arguments?|tool_results?|artifact_payload|artifact_content|artifact_chunks?|provider_request|provider_response|request_body|response_body|raw_capture|dom|stack|cause|error_message)$/u.test(normalized);
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return deepEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isArrayShape(value) {
  return isPlainObject(value) && value.kind === 'array-shape';
}

function exact(expected) {
  return (value) => Object.is(value, expected);
}

function integer(minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) {
  return (value) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function boolean() {
  return (value) => typeof value === 'boolean';
}

function digest() {
  return (value) => typeof value === 'string' && SHA256.test(value);
}

function commit() {
  return (value) => typeof value === 'string' && COMMIT.test(value);
}

function version() {
  return (value) => {
    try {
      parseChromeExtensionVersion(value);
      return true;
    } catch {
      return false;
    }
  };
}

function timestamp() {
  return isCanonicalTimestamp;
}

function identifier() {
  return (value) => typeof value === 'string' && IDENTIFIER.test(value);
}

function string(minimumBytes = 0, maximumBytes = MAX_STRING_BYTES) {
  return (value) => typeof value === 'string' && Buffer.byteLength(value) >= minimumBytes && Buffer.byteLength(value) <= maximumBytes;
}
function hostPermission() {
  return (value) => typeof value === 'string'
    && Buffer.byteLength(value) <= 256
    && /^(?:https?|\*):\/\/(?:\*\.)?(?:\*|[A-Za-z0-9.-]+)(?::(?:\*|\d{1,5}))?\/(?:\*|[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)$/u.test(value)
    && !/[?#]/u.test(value)
    && !value.includes('@');
}

function environment() {
  return (value) => {
    const keys = Object.keys(value ?? {});
    const expected = value?.browser === undefined
      ? ['node', 'platform', 'arch']
      : ['node', 'platform', 'arch', 'browser'];
    if (!isPlainObject(value) || !deepEqual(keys, expected)) return false;
    if (![value.node, value.platform, value.arch].every((entry) => identifier()(entry))) return false;
    return value.browser === undefined || (
      isPlainObject(value.browser)
      && deepEqual(Object.keys(value.browser), ['product', 'version'])
      && string(1, 128)(value.browser.product)
      && string(1, 128)(value.browser.version)
    );
  };
}

function provisionalBuildShape() {
  return {
    worker: bundleArtifactShape(),
    mermaid: arrayOf(bundleArtifactShape(), 0, 128),
    advisories: arrayOf(string(1, DEFAULT_ADVISORY_LIMITS.maxBlockBytes), 0, DEFAULT_ADVISORY_LIMITS.maxBlocks),
    outputSha256: digest(),
  };
}

function relativePath() {
  return (value) => {
    try { return normalizePackageRelativePath(value) === value; } catch { return false; }
  };
}

function relativeJsPath() {
  return (value) => relativePath()(value) && value.endsWith('.js');
}

function arrayOf(item, minimum = 0, maximum = MAX_COLLECTION_ITEMS) {
  return { kind: 'array-shape', item, minimum, maximum };
}

function numericObject(keys) {
  return Object.fromEntries(keys.map((key) => [key, integer(0)]));
}

function semanticObject(keys) {
  return Object.fromEntries(keys.map((key) => [key, semanticScalar()]));
}

function semanticScalar() {
  return (value) => typeof value === 'boolean'
    || (Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && IDENTIFIER.test(value));
}

function packageFingerprintShape() {
  return { algorithm: exact('sha256'), fileCount: integer(0), sha256: digest() };
}

function fileEvidenceShape() {
  return { relativePath: relativePath(), bytes: integer(1), sha256: digest() };
}

function bundleArtifactShape() {
  return { relativePath: relativeJsPath(), bytes: integer(0), kib: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0, sha256: digest() };
}
