#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
} from './controlled-responses-provider.mjs';
import {
  discoverExtension,
  hookPageDiagnostics,
  openExtensionPage,
} from './extension-runtime-targets.mjs';

const DIST = path.resolve(process.cwd(), process.env.GSM_DIST_DIR ?? 'dist');
const OPTIONS_PATH = '/src/options/index.html';
const PROVIDER_ORIGIN = 'https://api.openai.com';
const PROVIDER_BASE_URL = `${PROVIDER_ORIGIN}/v1`;
const MODEL = 'runtime-responses-model';
const GITHUB_CREDENTIAL = 'github_pat_runtime_fixture_only';
const PROVIDER_CREDENTIAL = 'runtime-provider-key';
const REPOSITORY = 'runtime-user/runtime-durable-artifact';
const SESSION_ID = 'runtime-agent-session-7a';
const ATTEMPT_ID = 'runtime-agent-attempt-7a';
const SOURCE_CALL_ID = 'runtime-source-get-star';
const READER_CALL_PREFIX = 'runtime-reader-';
const READER_TOOL = 'read_agent_artifact';
const FINAL_MARKER = 'RUNTIME_DURABLE_AGENT_FINAL';
const PREMATURE_MARKER = 'RUNTIME_DURABLE_AGENT_PREMATURE';
const SEARCH_MARKER = 'RUNTIME_DURABLE_AGENT_SEARCH';
const PROMPT_CANARY = 'RUNTIME_DURABLE_AGENT_PROMPT_CANARY';
const ARTIFACT_PAYLOAD_CANARY = 'RUNTIME_DURABLE_AGENT_ARTIFACT_PAYLOAD_CANARY';
const PRIVATE_CANARIES = Object.freeze([PROMPT_CANARY, ARTIFACT_PAYLOAD_CANARY]);
const CONTEXT_SUMMARY = [
  'GOALS:', '- Continue exact durable artifact coverage.',
  'DECISIONS:', '- Reuse only the last host-issued opaque cursor.',
  'OPEN:', '- Complete the pending artifact before finalizing.',
].join('\n');
const SETUP_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 90_000;
const CHECKPOINT_TIMEOUT_MS = 20_000;
const MINIMUM_PAGE_COUNT = 9;
const MAX_DIAGNOSTIC_ITEMS = 12;
const MAX_DIAGNOSTIC_COVERAGE_ROWS = 1;
const AGENT_AUTHORITY_STORES = [
  'agentSessions',
  'agentAttempts',
  'agentAttemptRecoveries',
  'agentMessages',
  'agentArtifacts',
  'agentArtifactChunks',
];

const profile = mkdtempSync(path.join(os.tmpdir(), 'bgsm-agent-session-7a-'));
const pageIssues = [];
const pageHttpPolicy = {
  unexpectedRequests: [],
  expectedRequests: [],
  handler: githubWorkerFixture,
  overflow: false,
  interceptionFailure: false,
  close: null,
};
const runtime = {
  currentStage: 'launch',
  passedStages: [],
  providerConfigStep: 'not-started',
  providerFieldObservation: null,
  coreStep: 'not-started',
  coverageObservation: null,
  containmentStep: 'not-started',
  baseRevision: null,
  networkIsolationVerified: false,
  finalAuthority: null,
  cleanup: {
    networkGatesClosed: false,
    diagnosticsDetached: false,
    pagesClosed: false,
    browserClosed: false,
    temporaryStateRemoved: false,
  },
  main: createMainState(),
};

let browser;
let page;
let provider;
let pageDiagnostics;
let primaryFailure;
let primaryDiagnostic;
let teardownFailure;

try {
  await run();
} catch (error) {
  primaryFailure = error;
  primaryDiagnostic = await buildDiagnostics(error);
}

try {
  await teardown();
} catch (error) {
  teardownFailure = error;
}

if (primaryFailure || teardownFailure) {
  const diagnostic = primaryDiagnostic ?? await buildDiagnostics(teardownFailure);
  console.error(JSON.stringify(safeDiagnosticOrFallback(diagnostic)));
  process.exitCode = 1;
} else {
  if (process.env.GSM_RUNTIME_EVIDENCE_DIR) {
    try {
      publishRuntimeEvidence({
        directory: process.env.GSM_RUNTIME_EVIDENCE_DIR,
        filename: 'agent-artifact.schema.json',
        evidence: buildArtifactEvidence(),
        validateEvidence: validateArtifactEvidence,
        privateMarkers: [
          GITHUB_CREDENTIAL,
          PROVIDER_CREDENTIAL,
          PROMPT_CANARY,
          ARTIFACT_PAYLOAD_CANARY,
          FINAL_MARKER,
          PREMATURE_MARKER,
          SEARCH_MARKER,
        ],
      });
    } catch (error) {
      console.error(JSON.stringify({
        status: 'failed',
        proofScope: 'packaged_durable_artifact',
        code: runtimeEvidenceFailureCode(error),
      }));
      process.exitCode = 1;
    }
  }
  if (process.exitCode !== 1) {
    console.log(JSON.stringify({
      status: 'passed',
      stages: runtime.passedStages,
      providerRequests: provider?.capture?.length ?? 0,
      artifactPages: runtime.main.pageCount,
      ordinaryBoundaries: countOrdinaryProviderRequests(provider),
    }));
  }
}

async function run() {
  if (!existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('A packaged extension manifest is required before the 7A runtime host can start.');
  }

  browser = await launchExtensionBrowser({
    dist: DIST,
    userDataDir: profile,
    protocolTimeout: TURN_TIMEOUT_MS,
    failClosedNetwork: true,
  });
  await assertFailClosedNetworkIsolation(browser);
  runtime.networkIsolationVerified = true;
  const extension = await discoverExtension(browser, { dist: DIST, timeoutMs: SETUP_TIMEOUT_MS });
  provider = createControlledResponsesProvider({
    providerOrigin: PROVIDER_ORIGIN,
    handler: providerHandler(runtime),
    httpFixtureHandler: githubWorkerFixture,
  });
  await installControlledProvider(extension.target, provider);

  await stage('open-options', async () => {
    page = await openExtensionPage(
      browser,
      extension.extensionId,
      OPTIONS_PATH,
      'runtime-options',
      {
        timeoutMs: SETUP_TIMEOUT_MS,
        failClosedHttp: pageHttpPolicy,
      },
    );
    pageDiagnostics = hookPageDiagnostics(page, 'runtime-options', { issues: pageIssues });
    await useEnglishLocale(page);
    await waitForOptionsReady(page);
  });

  await stage('configure-github', async () => {
    await saveGitHubToken(page);
  });

  await stage('configure-provider', async () => {
    await saveProvider(page);
  });

  await stage('verify-options', async () => {
    assert.deepEqual(await readSafeConfig(page, PROVIDER_ORIGIN), {
      username: 'runtime-user',
      provider: 'custom-openai-compatible',
      protocol: 'responses',
      baseUrl: PROVIDER_BASE_URL,
      model: MODEL,
      hasKey: true,
      disclosureRendered: true,
      hostAccessGranted: true,
      capabilityReady: true,
    });
    await page.evaluate(installPageClient, {
      prematureMarker: PREMATURE_MARKER,
      promptCanary: PROMPT_CANARY,
      artifactPayloadCanary: ARTIFACT_PAYLOAD_CANARY,
      syntheticCredentials: [GITHUB_CREDENTIAL, PROVIDER_CREDENTIAL],
    });
  });

  await stage('seed-and-empty-authority', async () => {
    await page.evaluate(seedFixture, {
      repository: REPOSITORY,
      marker: SEARCH_MARKER,
      artifactPayloadCanary: ARTIFACT_PAYLOAD_CANARY,
    });
    assert.deepEqual(await page.evaluate(readSeed, {
      repository: REPOSITORY,
      artifactPayloadCanary: ARTIFACT_PAYLOAD_CANARY,
    }), {
      stars: 1,
      tags: 1,
      topicCount: 12,
      manualTagCount: 12,
      oversizedBytes: true,
      hasArtifactPayloadCanary: true,
    });
    const authority = await page.evaluate(readAgentAuthority, AGENT_AUTHORITY_STORES);
    assert.deepEqual(authority, {
      agentSessions: 0,
      agentAttempts: 0,
      agentAttemptRecoveries: 0,
      agentMessages: 0,
      agentArtifacts: 0,
      agentArtifactChunks: 0,
    });
  });

  await stage('create-and-load-session', async () => {
    const created = await rpc(page, { type: 'createAgentSession', sessionId: SESSION_ID });
    assert.equal(created.session.id, SESSION_ID);
    const loaded = await rpc(page, { type: 'loadAgentSession', sessionId: SESSION_ID });
    assert.equal(loaded.session.id, SESSION_ID);
    assert.equal(loaded.session.revision, created.session.revision);
    assert.equal(Number.isSafeInteger(loaded.session.revision), true);
    runtime.baseRevision = loaded.session.revision;
  });

  let terminalResult;
  await stage('core-artifact-turn', async () => {
    runtime.coreStep = 'launching';
    runtime.main.active = true;
    const launch = {
      turnAttemptId: ATTEMPT_ID,
      sessionId: SESSION_ID,
      baseRevision: runtime.baseRevision,
      prompt: `${PROMPT_CANARY}: Inspect ${REPOSITORY} with exact durable artifact coverage before responding.`,
      candidateContract: { kind: 'selected_repository', selectedRepositoryIdHint: REPOSITORY },
    };
    await begin(page, 'core', launch);
    runtime.coreStep = 'waiting-first-hold';

    await waitForHold(provider, 'after-first-page', CHECKPOINT_TIMEOUT_MS);
    runtime.coreStep = 'reading-first-checkpoint';
    const beforeLocating = await readCoverageCheckpoint(page, SESSION_ID, ATTEMPT_ID);
    assertPendingCheckpoint(beforeLocating, runtime.main);
    runtime.main.firstCheckpointObserved = true;
    await provider.releaseHeldResponse('after-first-page');
    runtime.coreStep = 'waiting-locating-hold';

    await waitForHold(provider, 'after-locating', CHECKPOINT_TIMEOUT_MS);
    runtime.coreStep = 'reading-locating-checkpoint';
    const afterLocating = await readCoverageCheckpoint(page, SESSION_ID, ATTEMPT_ID);
    assertPendingCheckpoint(afterLocating, runtime.main);
    assertUnchangedLocatingCoverage(beforeLocating, afterLocating);
    runtime.main.locatingCoverageStable = true;
    await provider.releaseHeldResponse('after-locating');
    runtime.coreStep = 'waiting-terminal';

    terminalResult = await terminal(page, 'core', TURN_TIMEOUT_MS);
    runtime.main.terminal = terminalResult;
    runtime.coreStep = 'asserting-terminal';
    assert.equal(terminalResult.kind, 'result');
    assert.equal(terminalResult.reason, 'final_answer');
    assert.equal(terminalResult.commitApplied, true);
    assert.equal(terminalResult.appliedRevision, runtime.baseRevision + 1);
    assert.equal(terminalResult.acknowledged, true);
    assert.equal(terminalResult.prematureTextObserved, false);
    assert.equal(terminalResult.artifactPayloadCanaryDeliveryCount, 0);
    assert.equal(terminalResult.syntheticCredentialDeliveryCount, 0);
    assert.equal(runtime.main.prematureFinalCount, 1);
    assert.equal(runtime.main.correctiveRequestCount, 1);
    assert.equal(runtime.main.locatingReadCount, 2);
    assert.equal(runtime.main.firstPageOmittedCursor, true);
    assert.equal(runtime.main.cursorChainExact, true);
    assert.equal(runtime.main.initialSourceReaderAbsent, true);
    assert.equal(runtime.main.continuationReaderObserved, true);
    assert.equal(runtime.main.sourceRequestCount, 1);
    assert.equal(runtime.main.finalAfterNull, true);
    assert.equal(runtime.main.finalResponseCount, 1);
    assert.equal(runtime.main.pageRequestCount, runtime.main.pageCount);
    assert.equal(runtime.main.returnedCursors.size, Math.max(0, runtime.main.pageCount - 1));
    assert.equal(runtime.main.terminal.resultDeliveryCount, 1);
    assert.equal(runtime.main.pageCount >= MINIMUM_PAGE_COUNT, true);
    assert.equal(countOrdinaryProviderRequests(provider) >= 1, true);
    runtime.coreStep = 'complete';
  });
  await stage('durable-terminal-assertions', async () => {
    const stores = await readSafeStoreProjection(page, SESSION_ID, ATTEMPT_ID, {
      sourceCallId: SOURCE_CALL_ID,
      readerPrefix: READER_CALL_PREFIX,
      finalMarker: FINAL_MARKER,
      prematureMarker: PREMATURE_MARKER,
      maxCoverageRows: MAX_DIAGNOSTIC_COVERAGE_ROWS,
    });
    assert.equal(stores.authorityCounts.agentSessions, 1);
    assert.equal(stores.authorityCounts.agentAttempts, 1);
    assert.equal(stores.authorityCounts.agentAttemptRecoveries, 0);
    assert.equal(stores.authorityCounts.agentArtifacts, 1);
    assert.equal(stores.authorityCounts.agentMessages >= 3, true);
    assert.equal(stores.authorityCounts.agentArtifactChunks > 0, true);
    assert.equal(stores.attempt.coverageTotalCount, 1);
    assert.equal(stores.attempt.coverage.length, 1);
    assert.equal(stores.session.count, 1);
    assert.equal(stores.session.revision, runtime.baseRevision + 1);
    assert.equal(stores.attempt.count, 1);
    assert.equal(stores.attempt.state, 'committed');
    assert.equal(stores.attempt.hasContinuation, false);
    assert.equal(stores.attempt.recoveryCount, 0);
    assert.equal(stores.attempt.coverage.length, 1);
    assert.deepEqual(stores.attempt.coverage[0], {
      state: 'complete',
      expectedBytes: stores.attempt.coverage[0].expectedBytes,
      bytesDelivered: stores.attempt.coverage[0].expectedBytes,
      expectedCursorNull: true,
      hasProgressToken: true,
      hasArtifactDigest: true,
      hasManifestDigest: true,
      immutableArtifactMatches: true,
      hasCursorChainDigest: true,
    });
    assert.equal(stores.attempt.coverage[0].expectedBytes > 0, true);
    assert.equal(stores.artifact.count, 1);
    assert.deepEqual(stores.artifact.item, {
      state: 'ready',
      storageClass: 'canonical',
      ownerPresent: true,
      sourceCallMatches: true,
      hasArtifactDigest: true,
      hasManifestDigest: true,
      manifestChunkCount: stores.artifact.item.manifestChunkCount,
      storedChunkCount: stores.artifact.item.manifestChunkCount,
      chunksMatchManifest: true,
    });
    assert.equal(stores.artifact.item.manifestChunkCount > 0, true);
    assert.equal(stores.artifact.item.storedChunkCount, stores.artifact.item.manifestChunkCount);
    assert.equal(stores.messages.sourceToolRowCount, 1);
    assert.equal(stores.messages.sourceReceiptCount, 1);
    assert.equal(stores.messages.sourceReceiptMatchesArtifact, true);
    assert.equal(stores.messages.hasReaderCallId, false);
    assert.equal(stores.messages.hasPrematureAssistantText, false);
    assert.equal(stores.messages.hasFinalAssistantText, true);
    assert.equal(stores.attempt.leasePresent, false);
    assert.equal(stores.messages.readerRowCount, 0);
    assert.equal(stores.messages.prematureAssistantRowCount, 0);
    assert.equal(stores.messages.finalAssistantRowCount, 1);
    runtime.finalAuthority = stores;
  });

  await stage('containment-health', async () => {
    runtime.containmentStep = 'provider-health';
    await assertControlledProviderHealthy(provider);
    runtime.containmentStep = 'network-isolation';
    assert.equal(runtime.networkIsolationVerified, true);
    assert.equal(provider.capture.length > 0, true);
    assert.equal(provider.capture.every((entry) => entry.protocol === 'responses'), true);
    assert.equal(provider.capture.every((entry) => entry.authorizationPresent === true), true);
    runtime.containmentStep = 'source-catalog';
    const sourceRequests = provider.capture.filter((entry) => entry.kind === 'source-get-star');
    assert.equal(sourceRequests.length, 1);
    const [sourceRequest] = sourceRequests;
    assert.equal(Number.isSafeInteger(sourceRequest.ordinal) && sourceRequest.ordinal > 0, true);
    assert.equal(sourceRequest.toolNames.offered.includes('get_star'), true);
    assert.equal(sourceRequest.toolNames.offered.includes(READER_TOOL), false);
    assert.equal(provider.capture.some((entry) => entry.toolNames.offered.includes(READER_TOOL)), true);
    runtime.containmentStep = 'unexpected-network';
    assert.equal(provider.unexpectedRequests.length, 0);
    runtime.containmentStep = 'page-fixture-sequence';
    assert.deepEqual(pageHttpPolicy.expectedRequests.map((entry) => `${entry.method} ${entry.route}`), [
      'GET github-user',
      'GET github-starred',
      'POST github-gists',
      'DELETE github-probe-gist',
      'GET github-notifications',
    ]);
    runtime.containmentStep = 'page-unexpected';
    assert.equal(pageHttpPolicy.unexpectedRequests.length, 0);
    runtime.containmentStep = 'page-overflow';
    assert.equal(pageHttpPolicy.overflow, false);
    runtime.containmentStep = 'page-interception';
    assert.equal(pageHttpPolicy.interceptionFailure, false);
    runtime.containmentStep = 'page-issues';
    assert.deepEqual(pageIssues.map((entry) => ({ kind: entry.kind, value: entry.value ?? null })), [{
      kind: 'request-failed',
      value: 'DELETE github-probe-gist',
    }]);
    runtime.containmentStep = 'retained-evidence';
    const retainedEvidence = {
      providerCapture: provider.capture,
      providerFixtures: provider.httpFixtureCapture,
      providerFailures: provider.failures,
      providerUnexpected: provider.unexpectedRequests,
      pageIssues,
      pageUnexpected: pageHttpPolicy.unexpectedRequests,
      pageExpected: pageHttpPolicy.expectedRequests,
      terminalResult,
    };
    assertNoSensitiveEvidence(retainedEvidence);
    runtime.containmentStep = 'public-diagnostics';
    assertNoSensitiveEvidence(await buildDiagnostics(null));
    runtime.containmentStep = 'complete';
  });

}

async function stage(name, task) {
  runtime.currentStage = name;
  const result = await task();
  runtime.passedStages.push(name);
  return result;
}

function countOrdinaryProviderRequests(control) {
  return control?.capture?.filter((entry) => entry.kind === 'ordinary-context-summary').length ?? 0;
}

function providerHandler(state) {
  return async (request) => {
    assert.equal(request.protocol, 'responses');
    if (request.toolName === 'bgsm_connection_probe') {
      return toolCall('runtime-connection-probe', 'bgsm_connection_probe', { nonce: 'bgsm' }, 'connection-probe');
    }
    if (request.latestToolResult?.name === 'bgsm_connection_probe') {
      return textCompletion('runtime provider ready', 'connection-probe-complete');
    }
    if (!state.main.active) throw new Error('Controlled provider received a core request before the runtime turn began.');
    const handlerStep = request.offeredToolNames.length === 0
      ? 'ordinary'
      : `core:${state.main.action}`;
    state.main.handlerStep = handlerStep;
    try {
      return request.offeredToolNames.length === 0
        ? handleOrdinaryBoundary(state.main, request)
        : handleCoreRequest(state.main, request);
    } catch (error) {
      state.main.handlerFailureStep = state.main.handlerStep ?? handlerStep;
      throw error;
    }
  };
}

function handleCoreRequest(main, request) {
  if (main.action === 'start') {
    assert.equal(request.offeredToolNames.includes(READER_TOOL), false);
    assert.equal(request.offeredToolNames.includes('get_star'), true);
    main.initialSourceReaderAbsent = true;
    main.sourceRequestCount += 1;
    main.action = 'source';
    return toolCall(SOURCE_CALL_ID, 'get_star', { full_name: REPOSITORY }, 'source-get-star', {
      input_tokens: 27_009,
      output_tokens: 10,
      total_tokens: 27_019,
    });
  }

  const completingArtifact = main.action === 'pages'
    && request.latestToolResult?.callId === main.pendingPage?.callId
    && request.latestToolResult?.nextCursor === null;
  assert.equal(request.offeredToolNames.includes(READER_TOOL), !completingArtifact);
  if (!completingArtifact) main.continuationReaderObserved = true;

  if (main.action === 'source') {
    assertInvocation(request, SOURCE_CALL_ID, 'get_star', { full_name: REPOSITORY });
    const source = request.latestToolResult;
    assert.equal(source?.name, 'get_star');
    assert.equal(source?.status, 'artifact_available');
    assert.equal(typeof source?.artifactId, 'string');
    main.artifactId = source.artifactId;
    main.action = 'first-page';
    return issueExhaustivePage(main);
  }

  if (main.action === 'first-page') {
    consumeExhaustivePage(main, request);
    main.action = 'search';
    return {
      ...issueSearch(main),
      hold: 'after-first-page',
    };
  }

  if (main.action === 'first-page-summary') {
    main.action = 'search';
    return {
      ...issueSearch(main),
      hold: 'after-first-page',
    };
  }

  if (main.action === 'search') {
    const result = consumeLocatingRead(main, request, 'search');
    assert.equal(Number.isSafeInteger(result.matchByteOffset), true);
    main.searchByteOffset = result.matchByteOffset;
    main.locatingReadCount += 1;
    main.action = 'offset';
    return issueOffset(main);
  }

  if (main.action === 'offset') {
    consumeLocatingRead(main, request, 'offset');
    main.locatingReadCount += 1;
    assert.equal(main.prematureFinalCount, 0);
    main.prematureFinalCount = 1;
    main.action = 'premature';
    return {
      ...textCompletion(PREMATURE_MARKER, 'premature-final'),
      hold: 'after-locating',
    };
  }

  if (main.action === 'premature') {
    assert.equal(main.correctiveRequestCount, 0);
    main.correctiveRequestCount = 1;
    main.action = 'pages';
    return issueExhaustivePage(main);
  }

  if (main.action === 'pages') {
    main.handlerStep = 'core:pages:consume';
    consumeExhaustivePage(main, request);
    main.handlerStep = 'core:pages:continue';
    return continueOrFinalize(main);
  }

  if (main.action === 'pages-after-summary') {
    return continueOrFinalize(main);
  }

  throw new Error('Controlled provider reached an invalid core state.');
}

function handleOrdinaryBoundary(main, request) {
  if (main.pendingPage && request.latestToolResult?.callId === main.pendingPage.callId) {
    consumeExhaustivePage(main, request);
    if (main.action === 'first-page') main.action = 'first-page-summary';
    if (main.action === 'pages') main.action = 'pages-after-summary';
  }
  return textCompletion(CONTEXT_SUMMARY, 'ordinary-context-summary', {
    input_tokens: 30_130,
    output_tokens: 10,
    total_tokens: 30_140,
  });
}

function continueOrFinalize(main) {
  main.handlerStep = 'core:pages:finalize';
  if (main.cursor === null) {
    assert.equal(main.finalResponseCount, 0);
    main.finalResponseCount = 1;
    main.finalAfterNull = true;
    main.action = 'final';
    return textCompletion(FINAL_MARKER, 'final-answer');
  }
  main.action = 'pages';
  return issueExhaustivePage(main);
}

function issueExhaustivePage(main) {
  main.handlerStep = 'core:pages:issue';
  const ordinal = main.pageRequestCount;
  const callId = `${READER_CALL_PREFIX}page-${String(ordinal).padStart(3, '0')}`;
  let argumentsValue;
  if (ordinal === 0) {
    argumentsValue = { artifactId: main.artifactId };
    main.firstPageOmittedCursor = true;
    main.pendingPage = { callId, cursor: null, first: true };
  } else {
    assert.equal(typeof main.cursor, 'string');
    assert.equal(main.issuedCursors.has(main.cursor), false);
    main.issuedCursors.add(main.cursor);
    argumentsValue = { artifactId: main.artifactId, cursor: main.cursor };
    main.pendingPage = { callId, cursor: main.cursor, first: false };
  }
  main.pageRequestCount += 1;
  const usage = ordinal === 0
    ? { input_tokens: 30_180, output_tokens: 10, total_tokens: 30_190 }
    : { input_tokens: 29_925, output_tokens: 10, total_tokens: 29_935 };
  return toolCall(callId, READER_TOOL, argumentsValue, 'artifact-page', usage);
}

function issueSearch(main) {
  const callId = `${READER_CALL_PREFIX}search`;
  main.pendingLocating = { callId, kind: 'search' };
  return toolCall(callId, READER_TOOL, {
    artifactId: main.artifactId,
    search: { query: SEARCH_MARKER, fromByte: 0 },
  }, 'artifact-search', {
    input_tokens: 30_130,
    output_tokens: 10,
    total_tokens: 30_140,
  });
}

function issueOffset(main) {
  const callId = `${READER_CALL_PREFIX}offset`;
  main.pendingLocating = { callId, kind: 'offset' };
  return toolCall(callId, READER_TOOL, {
    artifactId: main.artifactId,
    byteOffset: main.searchByteOffset,
  }, 'artifact-offset', {
    input_tokens: 30_130,
    output_tokens: 10,
    total_tokens: 30_140,
  });
}

function consumeExhaustivePage(main, request) {
  const pending = main.pendingPage;
  assert.ok(pending);
  const invocation = request.latestToolCall;
  const result = request.latestToolResult;
  main.consumeObservation = {
    pendingPresent: pending !== null && pending !== undefined,
    invocationPresent: invocation !== null && invocation !== undefined,
    invocationIdMatches: invocation?.id === pending?.callId,
    invocationNameMatches: invocation?.name === READER_TOOL,
    resultPresent: result !== null && result !== undefined,
    resultCallIdMatches: result?.callId === pending?.callId,
    resultNameMatches: result?.name === READER_TOOL,
    resultArtifactMatches: result?.artifactId === main.artifactId,
    resultByteLengthValid: Number.isSafeInteger(result?.byteLength) && result.byteLength > 0,
    resultTotalBytesMatches: result?.totalBytes === main.artifactBytes || main.artifactBytes === null,
    invocationArgumentsMatch: pending?.first
      ? invocation?.arguments?.artifactId === main.artifactId
        && Object.keys(invocation.arguments).length === 1
      : invocation?.arguments?.artifactId === main.artifactId
        && invocation?.arguments?.cursor === pending?.cursor
        && Object.keys(invocation.arguments).length === 2,
    nextCursorValid: result?.nextCursor === null || typeof result?.nextCursor === 'string',
    nextCursorUnique: result?.nextCursor === null || !main.returnedCursors.has(result?.nextCursor),
  };
  assert.equal(invocation?.id, pending.callId);
  assert.equal(invocation?.name, READER_TOOL);
  assert.equal(result?.callId, pending.callId);
  assert.equal(result?.name, READER_TOOL);
  assert.equal(result?.artifactId, main.artifactId);
  assert.equal(Number.isSafeInteger(result?.byteLength) && result.byteLength > 0, true);
  assert.equal(Number.isSafeInteger(result?.totalBytes) && result.totalBytes > 0, true);
  if (pending.first) {
    assert.deepEqual(invocation.arguments, { artifactId: main.artifactId });
  } else {
    assert.deepEqual(invocation.arguments, { artifactId: main.artifactId, cursor: pending.cursor });
  }
  if (main.artifactBytes === null) main.artifactBytes = result.totalBytes;
  assert.equal(result.totalBytes, main.artifactBytes);
  assert.equal(result.nextCursor === null || typeof result.nextCursor === 'string', true);
  if (result.nextCursor !== null) {
    assert.equal(main.returnedCursors.has(result.nextCursor), false);
    main.returnedCursors.add(result.nextCursor);
  }
  main.cursor = result.nextCursor;
  main.pageCount += 1;
  main.pendingPage = null;
  main.cursorChainExact = true;
}

function consumeLocatingRead(main, request, expectedKind) {
  const pending = main.pendingLocating;
  assert.ok(pending);
  assert.equal(pending.kind, expectedKind);
  const invocation = request.latestToolCall;
  const result = request.latestToolResult;
  assert.equal(invocation?.id, pending.callId);
  assert.equal(invocation?.name, READER_TOOL);
  assert.equal(result?.callId, pending.callId);
  assert.equal(result?.name, READER_TOOL);
  assert.equal(result?.artifactId, main.artifactId);
  assert.equal(Number.isSafeInteger(result?.byteLength) && result.byteLength > 0, true);
  assert.equal(result?.totalBytes, main.artifactBytes);
  if (expectedKind === 'search') {
    assert.deepEqual(invocation.arguments, {
      artifactId: main.artifactId,
      search: { query: SEARCH_MARKER, fromByte: 0 },
    });
  } else {
    assert.deepEqual(invocation.arguments, {
      artifactId: main.artifactId,
      byteOffset: main.searchByteOffset,
    });
  }
  main.pendingLocating = null;
  return result;
}

function assertInvocation(request, callId, name, argumentsValue) {
  assert.equal(request.latestToolCall?.id, callId);
  assert.equal(request.latestToolCall?.name, name);
  assert.deepEqual(request.latestToolCall?.arguments, argumentsValue);
  assert.equal(request.latestToolResult?.callId, callId);
}

function toolCall(id, name, argumentsValue, kind, usage = undefined) {
  return {
    kind,
    completion: {
      toolCall: { id, name, arguments: JSON.stringify(argumentsValue) },
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function textCompletion(content, kind, usage = undefined) {
  return {
    kind,
    completion: { content, ...(usage === undefined ? {} : { usage }) },
  };
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
    'GET github-notifications': json([], 'github-token-notifications'),
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

async function useEnglishLocale(targetPage) {
  await targetPage.evaluate(async () => {
    const { gsm_config: config = {} } = await chrome.storage.local.get('gsm_config');
    await chrome.storage.local.set({
      gsm_config: { ...config, locale: 'en' },
    });
  });
  await targetPage.waitForFunction(
    () => [...document.querySelectorAll('button')]
      .some((button) => /^Save & verify$/i.test(button.textContent?.trim() ?? '')),
    { timeout: SETUP_TIMEOUT_MS },
  );
}

async function waitForOptionsReady(targetPage) {
  await targetPage.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="agent-storage-panel"]');
    const refresh = panel?.querySelector('button');
    return !!document.querySelector('#agent-provider') && !!refresh && !refresh.disabled;
  }, { timeout: SETUP_TIMEOUT_MS });
}

async function saveGitHubToken(targetPage) {
  await targetPage.waitForSelector('textarea[placeholder="github_pat_..."]:not([disabled])', {
    visible: true,
    timeout: SETUP_TIMEOUT_MS,
  });
  await targetPage.evaluate(() => {
    const element = document.querySelector('textarea[placeholder="github_pat_..."]');
    if (!(element instanceof HTMLTextAreaElement)) throw new Error('GitHub credential field is unavailable.');
    element.focus();
    element.select();
  });
  await targetPage.keyboard.type(GITHUB_CREDENTIAL);
  await targetPage.waitForFunction(
    (credential) => (
      document.querySelector('textarea[placeholder="github_pat_..."]')?.value === credential
      && [...document.querySelectorAll('button')].some((button) => (
        /^Save & verify$/i.test(button.textContent?.trim() ?? '') && !button.disabled
      ))
    ),
    { timeout: SETUP_TIMEOUT_MS },
    GITHUB_CREDENTIAL,
  );
  await clickText(targetPage, /^Save & verify$/i);
  await waitUntil(
    () => targetPage.evaluate(() => {
      const token = document.querySelector('textarea[placeholder="github_pat_..."]');
      const authenticated = [...document.querySelectorAll('a')].some((anchor) => (
        anchor.getAttribute('href') === 'https://github.com/runtime-user?tab=stars'
      ));
      const settledSave = [...document.querySelectorAll('button')].some((button) => (
        /^Save & verify$/i.test(button.textContent?.trim() ?? '') && button.disabled
      ));
      return authenticated
        && token instanceof HTMLTextAreaElement
        && token.value === ''
        && settledSave;
    }),
    SETUP_TIMEOUT_MS,
    'GitHub identity was not confirmed by the settled production Options flow.',
  );
}

async function saveProvider(targetPage) {
  runtime.providerConfigStep = 'open-menu';
  await clickElementTextTrusted(targetPage, '#agent-provider', /.+/);
  runtime.providerConfigStep = 'menu-opened';
  await targetPage.waitForSelector('[role="option"]', { visible: true, timeout: SETUP_TIMEOUT_MS });
  runtime.providerConfigStep = 'menu-options-ready';
  await clickElementTextTrusted(
    targetPage,
    '[role="option"]',
    /^Custom AI service$/i,
  );
  runtime.providerConfigStep = 'custom-selected';
  await targetPage.waitForFunction(
    () => /custom/i.test(document.querySelector('#agent-provider')?.textContent ?? '')
      && !!document.querySelector('#agent-base-url'),
    { timeout: SETUP_TIMEOUT_MS },
  );
  runtime.providerConfigStep = 'custom-fields-ready';
  await targetPage.evaluate(() => {
    for (const content of document.querySelectorAll('[role="listbox"][data-state="closed"]')) {
      const animationName = getComputedStyle(content).animationName.split(',')[0]?.trim() ?? '';
      content.dispatchEvent(new AnimationEvent('animationend', { animationName, bubbles: true }));
    }
  });
  await waitUntil(
    () => targetPage.evaluate(() => getComputedStyle(document.body).pointerEvents !== 'none'),
    SETUP_TIMEOUT_MS,
    'Provider menu did not release its pointer lock.',
  );
  runtime.providerConfigStep = 'menu-unlocked';
  await targetPage.evaluate(() => {
    const details = document.querySelector('[data-testid="agent-advanced-settings"]');
    if (!(details instanceof HTMLDetailsElement)) throw new Error('Agent advanced settings are unavailable.');
    details.open = true;
  });
  runtime.providerConfigStep = 'advanced-open';
  runtime.providerConfigStep = 'fill-base-url';
  await typeValue(targetPage, '#agent-base-url', PROVIDER_BASE_URL);
  runtime.providerConfigStep = 'base-url-filled';
  await clickText(targetPage, /^Responses API$/i);
  runtime.providerConfigStep = 'protocol-selected';
  await typeValue(targetPage, '#agent-provider-context-window', '32768');
  runtime.providerConfigStep = 'declared-context-filled';
  await typeValue(targetPage, '#agent-working-context-window', '32768');
  runtime.providerConfigStep = 'working-context-filled';
  await typeValue(targetPage, '#agent-model', MODEL);
  runtime.providerConfigStep = 'model-filled';
  await typeValue(targetPage, '#agent-api-key', PROVIDER_CREDENTIAL);
  runtime.providerConfigStep = 'fields-filled';
  await targetPage.waitForSelector('[data-testid="agent-data-disclosure"]', { timeout: SETUP_TIMEOUT_MS });
  runtime.providerConfigStep = 'disclosure-visible';

  const permissionDetails = { origins: [`${new URL(PROVIDER_ORIGIN).protocol}//${new URL(PROVIDER_ORIGIN).hostname}/*`] };
  const hasHostAccess = () => targetPage.evaluate(
    (details) => chrome.permissions.contains(details),
    permissionDetails,
  );
  runtime.providerConfigStep = 'host-permission';
  if (!await hasHostAccess()) {
    await waitUntil(
      () => targetPage.evaluate(() => [...document.querySelectorAll('button')]
        .some((button) => /allow access/i.test(button.textContent ?? ''))),
      SETUP_TIMEOUT_MS,
      'Provider host-access control did not render.',
    );
    await clickTextTrusted(targetPage, /allow access/i);
    await waitUntil(hasHostAccess, SETUP_TIMEOUT_MS, 'Provider host permission was not granted.');
  }
  runtime.providerConfigStep = 'host-permission-ready';
  await targetPage.waitForFunction(
    () => [...document.querySelectorAll('button')].some((button) => (
      /^Save & test$/i.test(button.textContent?.trim() ?? '') && !button.disabled
    )),
    { timeout: SETUP_TIMEOUT_MS },
  );
  runtime.providerConfigStep = 'save-enabled';
  await clickText(targetPage, /^Save & test$/i);
  runtime.providerConfigStep = 'save-clicked';
  await waitUntil(
    () => targetPage.evaluate(() => [...document.querySelectorAll('[role="status"], [role="alert"], .gsm-status-note')]
      .some((node) => node.textContent?.includes('Saved · Connected'))),
    SETUP_TIMEOUT_MS,
    'Provider connection was not saved through the production Options flow.',
  );
}

async function readSafeConfig(targetPage, providerOrigin) {
  return targetPage.evaluate(async (origin) => {
    const config = (await chrome.storage.local.get('gsm_config')).gsm_config;
    const agent = config?.agentProvider;
    return {
      username: config?.username ?? null,
      provider: agent?.provider ?? null,
      protocol: agent?.protocol ?? null,
      baseUrl: agent?.baseUrl ?? null,
      model: agent?.model ?? null,
      hasKey: !!agent?.apiKeyEncrypted,
      disclosureRendered: !!document.querySelector('[data-testid="agent-data-disclosure"]'),
      hostAccessGranted: await chrome.permissions.contains({ origins: [`${new URL(origin).protocol}//${new URL(origin).hostname}/*`] }),
      capabilityReady: agent?.capability?.namedToolRoundTrip === true,
    };
  }, providerOrigin);
}

async function typeValue(targetPage, selector, value) {
  const observe = () => targetPage.evaluate((target, expected) => {
    const element = document.querySelector(target);
    return {
      field: target,
      present: element instanceof HTMLInputElement,
      enabled: element instanceof HTMLInputElement && !element.disabled,
      visible: element instanceof HTMLInputElement && element.getClientRects().length > 0,
      exact: element instanceof HTMLInputElement && element.value === expected,
    };
  }, selector, value);
  runtime.providerFieldObservation = await observe();
  await targetPage.waitForSelector(selector, { visible: true, timeout: SETUP_TIMEOUT_MS });
  await targetPage.evaluate((target, nextValue) => {
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
  await targetPage.waitForFunction((target, expected) => {
    const element = document.querySelector(target);
    return element instanceof HTMLInputElement
      && !element.disabled
      && element.getClientRects().length > 0
      && element.value === expected;
  }, { polling: 50, timeout: SETUP_TIMEOUT_MS }, selector, value);
  runtime.providerFieldObservation = await observe();
  assert.deepEqual(runtime.providerFieldObservation, {
    field: selector,
    present: true,
    enabled: true,
    visible: true,
    exact: true,
  });
}

async function clickText(targetPage, matcher) {
  const clicked = await targetPage.evaluate(({ source, flags }) => {
    const expression = new RegExp(source, flags);
    const button = [...document.querySelectorAll('button')]
      .find((node) => expression.test(node.textContent?.trim() ?? ''));
    button?.click();
    return !!button;
  }, { source: matcher.source, flags: matcher.flags });
  assert.equal(clicked, true);
}

async function clickTextTrusted(targetPage, matcher) {
  await clickElementTextTrusted(targetPage, 'button', matcher);
}

async function clickElementTextTrusted(targetPage, selector, matcher) {
  const box = await targetPage.evaluate(({ selector: targetSelector, source, flags }) => {
    const expression = new RegExp(source, flags);
    const element = [...document.querySelectorAll(targetSelector)]
      .find((node) => expression.test(node.textContent?.trim() ?? ''));
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      visible: rect.width > 0 && rect.height > 0,
      enabled: !(element instanceof HTMLButtonElement) || !element.disabled,
      hit: hitTarget === element || element.contains(hitTarget),
    };
  }, { selector, source: matcher.source, flags: matcher.flags });
  assert.ok(box);
  assert.equal(box.visible, true);
  assert.equal(box.enabled, true);
  assert.equal(box.hit, true);
  await targetPage.mouse.click(box.x, box.y);
}

async function rpc(targetPage, request) {
  return targetPage.evaluate(async (value) => {
    const response = await chrome.runtime.sendMessage(value);
    if (!response?.ok) throw new Error('Production Agent session RPC failed.');
    return response.data;
  }, request);
}

async function begin(targetPage, id, launch) {
  await targetPage.evaluate(({ turnId, input }) => globalThis.__runtimeAgent.begin(turnId, input), {
    turnId: id,
    input: launch,
  });
}

async function terminal(targetPage, id, timeoutMs) {
  return targetPage.evaluate(({ turnId, timeout }) => globalThis.__runtimeAgent.wait(turnId, timeout), {
    turnId: id,
    timeout: timeoutMs,
  });
}

function installPageClient({ prematureMarker, promptCanary, artifactPayloadCanary, syntheticCredentials = [] }) {
  if (globalThis.__runtimeAgent) return;
  const knownEventTypes = new Set([
    'assistant_stream_start',
    'assistant_delta',
    'assistant_stream_end',
    'tool_call',
    'tool_result',
    'agent_error',
    'context_diagnostic',
    'turn_terminal',
  ]);
  const knownReasons = new Set(['final_answer', 'stopped', 'provider_error', 'context_limit', 'attempt_state_lost']);
  const turns = new Map();
  const eventType = (value) => knownEventTypes.has(value) ? value : 'other';
  const reason = (value) => knownReasons.has(value) ? value : 'other';
  const safeCode = (value) => (
    typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value) ? value : null
  );
  const containsMarker = (value, depth = 0) => {
    if (typeof value === 'string') return value.includes(prematureMarker);
    if (!value || typeof value !== 'object' || depth >= 4) return false;
    return Object.values(value).some((entry) => containsMarker(entry, depth + 1));
  };
  const normalizeCanary = (value) => (
    typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : null
  );
  const normalizedPromptCanary = normalizeCanary(promptCanary);
  const normalizedArtifactPayloadCanary = normalizeCanary(artifactPayloadCanary);
  const normalizedSyntheticCredentials = Array.isArray(syntheticCredentials)
    ? syntheticCredentials.map(normalizeCanary).filter(Boolean).slice(0, 4)
    : [];
  const containsCanary = (value, canaries, depth = 0) => {
    if (typeof value === 'string') return canaries.some((marker) => value.includes(marker));
    if (!value || typeof value !== 'object' || depth >= 4) return false;
    return Object.values(value).some((entry) => containsCanary(entry, canaries, depth + 1));
  };
  const beginTurn = (id, launch) => {
    if (turns.has(id)) throw new Error('Duplicate production Agent Port client.');
    const port = chrome.runtime.connect({ name: 'bgsm-agent' });
    let startInput = launch;
    const turn = {
      port,
      hello: null,
      acknowledged: false,
      terminal: null,
      deliveryCount: 0,
      resultDeliveryCount: 0,
      eventCounts: {},
      prematureTextObserved: false,
      promptCanaryDeliveryCount: 0,
      artifactPayloadCanaryDeliveryCount: 0,
      syntheticCredentialDeliveryCount: 0,
    };
    turns.set(id, turn);
    port.onMessage.addListener((delivery) => {
      turn.deliveryCount += 1;
      if (containsCanary(delivery, normalizedPromptCanary ? [normalizedPromptCanary] : [])) turn.promptCanaryDeliveryCount += 1;
      if (containsCanary(delivery, normalizedArtifactPayloadCanary ? [normalizedArtifactPayloadCanary] : [])) {
        turn.artifactPayloadCanaryDeliveryCount += 1;
      }
      if (containsCanary(delivery, normalizedSyntheticCredentials)) turn.syntheticCredentialDeliveryCount += 1;
      if (delivery?.type === 'bgsmAgentTurnHello') {
        turn.hello = delivery.executionEpochId;
        if (!startInput) throw new Error('Duplicate production Agent Port hello.');
        const input = startInput;
        startInput = null;
        port.postMessage({ type: 'startBgsmAgentTurn', executionEpochId: turn.hello, ...input });
        return;
      }
      if (delivery?.type === 'bgsmAgentTurnEvent') {
        const kind = eventType(delivery.event?.type);
        turn.eventCounts[kind] = (turn.eventCounts[kind] ?? 0) + 1;
        turn.prematureTextObserved ||= containsMarker(delivery.event);
        return;
      }
      if (delivery?.type === 'bgsmAgentTurnResult') {
        turn.resultDeliveryCount += 1;
        const result = delivery.result;
        const revision = Number.isSafeInteger(result?.commit?.appliedRevision)
          ? result.commit.appliedRevision
          : null;
        port.postMessage({
          type: 'ackBgsmAgentTurnResult',
          executionEpochId: turn.hello,
          turnAttemptId: result?.turnAttemptId,
          sessionId: result?.sessionId,
          baseRevision: result?.baseRevision,
          disposition: revision === null ? 'no_transition' : 'applied',
          appliedRevision: revision,
        });
        turn.terminal = {
          kind: 'result',
          reason: reason(result?.reason),
          commitApplied: revision !== null,
          appliedRevision: revision,
          resultDeliveryCount: turn.resultDeliveryCount,
          prematureTextObserved: turn.prematureTextObserved,
          promptCanaryDeliveryCount: turn.promptCanaryDeliveryCount,
          artifactPayloadCanaryDeliveryCount: turn.artifactPayloadCanaryDeliveryCount,
          syntheticCredentialDeliveryCount: turn.syntheticCredentialDeliveryCount,
          eventCounts: turn.eventCounts,
        };
        return;
      }
      if (delivery?.type === 'bgsmAgentTurnAck') {
        turn.acknowledged = true;
        return;
      }
      if (delivery?.type === 'bgsmAgentTurnError') {
        turn.terminal = {
          kind: 'error',
          code: safeCode(delivery.error?.code),
          category: safeCode(delivery.error?.category),
          commitApplied: false,
          appliedRevision: null,
          prematureTextObserved: turn.prematureTextObserved,
          promptCanaryDeliveryCount: turn.promptCanaryDeliveryCount,
          artifactPayloadCanaryDeliveryCount: turn.artifactPayloadCanaryDeliveryCount,
          syntheticCredentialDeliveryCount: turn.syntheticCredentialDeliveryCount,
          eventCounts: turn.eventCounts,
        };
      }
    });
  };
  const wait = async (id, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const turn = turns.get(id);
      if (turn?.terminal && (turn.terminal.kind === 'error' || turn.acknowledged)) {
        return { ...turn.terminal, acknowledged: turn.acknowledged, deliveryCount: turn.deliveryCount };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Production Agent Port did not reach an acknowledged terminal delivery before timeout.');
  };
  const dispose = () => {
    for (const turn of turns.values()) turn.port.disconnect();
    turns.clear();
  };
  globalThis.__runtimeAgent = Object.freeze({ begin: beginTurn, wait, dispose });
}

async function waitForHold(control, label, timeoutMs) {
  await waitUntil(
    () => control.hasHeldResponse(label),
    timeoutMs,
    'Controlled Provider did not reach its bounded checkpoint hold.',
  );
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function assertPendingCheckpoint(checkpoint, main) {
  const observedCoverage = checkpoint.coverage[0];
  runtime.coverageObservation = {
    coverageTotalCount: Number.isSafeInteger(checkpoint.coverageTotalCount) ? checkpoint.coverageTotalCount : null,
    coverageLength: Array.isArray(checkpoint.coverage) ? checkpoint.coverage.length : null,
    state: ['pending', 'complete'].includes(observedCoverage?.state) ? observedCoverage.state : 'other',
    artifactMatches: observedCoverage?.artifactId === main.artifactId,
    expectedCursorMatches: observedCoverage?.expectedCursor === main.cursor,
    expectedCursorNull: observedCoverage?.expectedCursor === null,
    expectedBytes: safeNonnegativeInteger(observedCoverage?.expectedBytes),
    bytesDelivered: safeNonnegativeInteger(observedCoverage?.bytesDelivered),
    hasProgressToken: typeof observedCoverage?.progressToken === 'string',
    hasCursorChainDigest: typeof observedCoverage?.cursorChainDigest === 'string',
  };
  assert.equal(checkpoint.coverageTotalCount, 1);
  assert.equal(checkpoint.coverage.length, 1);
  const [coverage] = checkpoint.coverage;
  assert.equal(coverage.state, 'pending');
  assert.equal(coverage.artifactId, main.artifactId);
  assert.equal(coverage.expectedCursor, main.cursor);
  assert.equal(Number.isSafeInteger(coverage.expectedBytes) && coverage.expectedBytes > 0, true);
  assert.equal(Number.isSafeInteger(coverage.bytesDelivered) && coverage.bytesDelivered > 0, true);
  assert.equal(coverage.bytesDelivered < coverage.expectedBytes, true);
  assert.equal(typeof coverage.progressToken, 'string');
  assert.equal(typeof coverage.cursorChainDigest, 'string');
}

function assertUnchangedLocatingCoverage(before, after) {
  assert.equal(after.coverageTotalCount, 1);
  assert.equal(after.coverage.length, 1);
  assert.deepEqual(after.coverage[0], before.coverage[0]);
}

async function readCoverageCheckpoint(targetPage, sessionId, attemptId) {
  return targetPage.evaluate(coverageCheckpointProjection, {
    sessionId,
    attemptId,
    maxCoverageRows: MAX_DIAGNOSTIC_COVERAGE_ROWS,
  });
}

async function coverageCheckpointProjection({ sessionId, attemptId, maxCoverageRows }) {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const db = await open();
  try {
    const attempt = await new Promise((resolve, reject) => {
      const store = db.transaction('agentAttempts', 'readonly').objectStore('agentAttempts');
      const request = store.index('[sessionId+turnAttemptId]').get([sessionId, attemptId]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!attempt || attempt.sessionId !== sessionId || attempt.turnAttemptId !== attemptId) {
      return { coverageTotalCount: 0, coverage: [] };
    }
    const allCoverage = Array.isArray(attempt.artifactCoverage) ? attempt.artifactCoverage : [];
    const maximum = Number.isSafeInteger(maxCoverageRows) && maxCoverageRows > 0
      ? Math.min(maxCoverageRows, 16)
      : 1;
    return {
      coverageTotalCount: allCoverage.length,
      coverage: allCoverage.slice(0, maximum).map((coverage) => ({
        state: coverage?.state ?? null,
        artifactId: coverage?.artifactId ?? null,
        expectedBytes: coverage?.expectedBytes ?? null,
        bytesDelivered: coverage?.bytesDelivered ?? null,
        expectedCursor: coverage?.expectedCursor ?? null,
        progressToken: coverage?.progressToken ?? null,
        cursorChainDigest: coverage?.cursorChainDigest ?? null,
      })),
    };
  } finally {
    db.close();
  }
}

async function seedFixture({ repository, marker, artifactPayloadCanary }) {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const db = await open();
  try {
    const now = '2026-08-08T00:00:00.000Z';
    const fixed = (prefix, index) => `${marker}-${prefix}-${String(index).padStart(2, '0')}-`.padEnd(120, prefix[0]);
    const topics = Array.from({ length: 12 }, (_, index) => fixed('topic', index));
    const tags = Array.from({ length: 12 }, (_, index) => fixed('tag', index));
    const description = `${marker}-description-${artifactPayloadCanary}-`.padEnd(128, 'd');
    const tx = db.transaction(['stars', 'tags'], 'readwrite');
    tx.objectStore('stars').put({
      full_name: repository,
      html_url: `https://github.com/${repository}`,
      description,
      language: 'TypeScript',
      stargazers_count: 4242,
      topics,
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
      manualTags: tags,
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

async function readSeed({ repository, artifactPayloadCanary }) {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const db = await open();
  try {
    const tx = db.transaction(['stars', 'tags'], 'readonly');
    const get = (name) => new Promise((resolve, reject) => {
      const request = tx.objectStore(name).get(repository);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = (name) => new Promise((resolve, reject) => {
      const request = tx.objectStore(name).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [star, tag, stars, tags] = await Promise.all([get('stars'), get('tags'), count('stars'), count('tags')]);
    return {
      stars,
      tags,
      topicCount: Array.isArray(star?.topics) ? star.topics.length : 0,
      manualTagCount: Array.isArray(tag?.manualTags) ? tag.manualTags.length : 0,
      oversizedBytes: new TextEncoder().encode(JSON.stringify({
        description: star?.description,
        topics: star?.topics,
        manualTags: tag?.manualTags,
      })).byteLength > 3_000,
      hasArtifactPayloadCanary: typeof star?.description === 'string'
        && star.description.includes(artifactPayloadCanary),
    };
  } finally {
    db.close();
  }
}

async function readAgentAuthority(storeNames) {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const db = await open();
  try {
    const tx = db.transaction(storeNames, 'readonly');
    const counts = await Promise.all(storeNames.map((name) => new Promise((resolve, reject) => {
      const request = tx.objectStore(name).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })));
    return Object.fromEntries(storeNames.map((name, index) => [name, counts[index]]));
  } finally {
    db.close();
  }
}

async function readSafeStoreProjection(targetPage, sessionId, attemptId, markers) {
  return targetPage.evaluate(safeStoreProjection, { sessionId, attemptId, markers });
}

async function safeStoreProjection({ sessionId, attemptId, markers }) {
  const authorityStores = [
    'agentSessions',
    'agentAttempts',
    'agentAttemptRecoveries',
    'agentMessages',
    'agentArtifacts',
    'agentArtifactChunks',
  ];
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('better-github-stars-manager');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const db = await open();
  try {
    const tx = db.transaction(authorityStores, 'readonly');
    const getAll = (name) => new Promise((resolve, reject) => {
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [sessions, attempts, recoveries, messages, artifacts, chunks] = await Promise.all(authorityStores.map(getAll));
    const scopedSession = sessions.filter((row) => row?.id === sessionId);
    const scopedAttempts = attempts.filter((row) => row?.sessionId === sessionId && row?.turnAttemptId === attemptId);
    const scopedRecoveries = recoveries.filter((row) => row?.sessionId === sessionId && row?.turnAttemptId === attemptId);
    const scopedMessages = messages.filter((row) => row?.sessionId === sessionId);
    const scopedArtifacts = artifacts.filter((row) => row?.sessionId === sessionId && row?.turnAttemptId === attemptId);
    const artifact = scopedArtifacts[0] ?? null;
    const allCoverage = Array.isArray(scopedAttempts[0]?.artifactCoverage) ? scopedAttempts[0].artifactCoverage : [];
    const maximumCoverageRows = Number.isSafeInteger(markers.maxCoverageRows) && markers.maxCoverageRows > 0
      ? Math.min(markers.maxCoverageRows, 16)
      : 1;
    const coverage = allCoverage.slice(0, maximumCoverageRows);
    const sourceRows = scopedMessages.filter((row) => row?.toolCallId === markers.sourceCallId);
    const receipts = sourceRows.flatMap((row) => Array.isArray(row?.artifactCoverageReceipts) ? row.artifactCoverageReceipts : []);
    const containsMarker = (value, marker, depth = 0) => {
      if (typeof value === 'string') return value.includes(marker);
      if (!value || typeof value !== 'object' || depth >= 4) return false;
      return Object.values(value).some((entry) => containsMarker(entry, marker, depth + 1));
    };
    const readerRows = scopedMessages.filter((row) => (
      String(row?.toolCallId ?? '').startsWith(markers.readerPrefix)
      || (Array.isArray(row?.toolCalls) && row.toolCalls.some((call) => String(call?.id ?? '').startsWith(markers.readerPrefix)))
    ));
    const prematureAssistantRows = scopedMessages.filter((row) => containsMarker(row?.content, markers.prematureMarker));
    const finalAssistantRows = scopedMessages.filter((row) => containsMarker(row?.content, markers.finalMarker));
    const hasReaderCallId = readerRows.length > 0;
    const hasDigest = (value) => typeof value === 'string' && value.length >= 16 && value.length <= 256 && /^[A-Za-z0-9._:/-]+$/u.test(value);
    const expectedArtifactId = artifact?.id;
    const storedArtifactChunks = artifact
      ? chunks.filter((row) => row?.artifactId === artifact.id).sort((left, right) => left.index - right.index)
      : [];
    const manifestChunks = Array.isArray(artifact?.integrity?.chunks) ? artifact.integrity.chunks : [];
    const chunksMatchManifest = manifestChunks.length === storedArtifactChunks.length
      && manifestChunks.every((chunk, index) => (
        Number.isSafeInteger(chunk?.byteLength)
        && chunk.byteLength > 0
        && hasDigest(chunk?.sha256)
        && storedArtifactChunks[index]?.byteLength === chunk.byteLength
        && storedArtifactChunks[index]?.sha256 === chunk.sha256
      ));
    return {
      authorityCounts: {
        agentSessions: sessions.length,
        agentAttempts: attempts.length,
        agentAttemptRecoveries: recoveries.length,
        agentMessages: messages.length,
        agentArtifacts: artifacts.length,
        agentArtifactChunks: chunks.length,
      },
      session: {
        count: scopedSession.length,
        revision: scopedSession.length === 1 && Number.isSafeInteger(scopedSession[0]?.revision)
          ? scopedSession[0].revision
          : null,
      },
      attempt: {
        count: scopedAttempts.length,
        state: scopedAttempts.length === 1 ? scopedAttempts[0]?.state ?? null : null,
        hasContinuation: scopedAttempts.length === 1 && scopedAttempts[0]?.artifactContinuationControl !== null,
        recoveryCount: scopedRecoveries.length,
        leasePresent: scopedAttempts.length === 1 && scopedAttempts[0]?.lease !== null,
        coverageTotalCount: allCoverage.length,
        coverage: coverage.map((row) => ({
          state: row?.state ?? null,
          expectedBytes: Number.isSafeInteger(row?.expectedBytes) ? row.expectedBytes : null,
          bytesDelivered: Number.isSafeInteger(row?.bytesDelivered) ? row.bytesDelivered : null,
          expectedCursorNull: row?.expectedCursor === null,
          hasProgressToken: typeof row?.progressToken === 'string' && row.progressToken.length > 0,
          hasArtifactDigest: hasDigest(row?.artifactSha256),
          hasManifestDigest: hasDigest(row?.integrityManifestSha256),
          immutableArtifactMatches: row?.artifactSha256 === artifact?.sha256
            && row?.integrityManifestSha256 === artifact?.integrity?.manifestSha256,
          hasCursorChainDigest: hasDigest(row?.cursorChainDigest),
        })),
      },
      artifact: {
        count: scopedArtifacts.length,
        item: artifact ? {
          state: artifact.state ?? null,
          storageClass: artifact.storageClass ?? null,
          ownerPresent: typeof artifact.ownerMessageId === 'string' && artifact.ownerMessageId.length > 0,
          sourceCallMatches: artifact.toolCallId === markers.sourceCallId,
          hasArtifactDigest: hasDigest(artifact.sha256),
          hasManifestDigest: hasDigest(artifact.integrity?.manifestSha256),
          manifestChunkCount: manifestChunks.length,
          storedChunkCount: storedArtifactChunks.length,
          chunksMatchManifest,
        } : null,
      },
      messages: {
        sourceToolRowCount: sourceRows.length,
        sourceReceiptCount: receipts.length,
        sourceReceiptMatchesArtifact: receipts.length === 1
          && receipts[0]?.sourceToolCallId === markers.sourceCallId
          && receipts[0]?.artifactId === expectedArtifactId
          && receipts[0]?.byteLength === artifact?.byteLength
          && receipts[0]?.artifactSha256 === artifact?.sha256
          && receipts[0]?.integrityManifestSha256 === artifact?.integrity?.manifestSha256
          && receipts[0]?.cursorChainDigest === coverage[0]?.cursorChainDigest
          && hasDigest(receipts[0]?.cursorChainDigest),
        hasReaderCallId,
        hasPrematureAssistantText: scopedMessages.some((row) => containsMarker(row?.content, markers.prematureMarker)),
        hasFinalAssistantText: scopedMessages.some((row) => containsMarker(row?.content, markers.finalMarker)),
        readerRowCount: readerRows.length,
        prematureAssistantRowCount: prematureAssistantRows.length,
        finalAssistantRowCount: finalAssistantRows.length,
      },
    };
  } finally {
    db.close();
  }
}

async function buildDiagnostics(error) {
  const stores = page && !page.isClosed?.()
    ? await readSafeStoreProjection(page, SESSION_ID, ATTEMPT_ID, {
      sourceCallId: SOURCE_CALL_ID,
      readerPrefix: READER_CALL_PREFIX,
      finalMarker: FINAL_MARKER,
      prematureMarker: PREMATURE_MARKER,
      maxCoverageRows: MAX_DIAGNOSTIC_COVERAGE_ROWS,
    }).catch(() => null)
    : null;
  return {
    schemaVersion: 1,
    stage: safeStage(runtime.currentStage),
    failure: error ? errorCategory(error) : null,
    passedStages: runtime.passedStages.slice(0, MAX_DIAGNOSTIC_ITEMS).map(safeStage),
    providerFieldObservation: safeProviderFieldObservation(runtime.providerFieldObservation),
    providerConfigStep: safeProviderConfigStep(runtime.providerConfigStep),
    containmentStep: safeContainmentStep(runtime.containmentStep),
    pageIssueCheckpoint: {
      count: pageIssues.length,
      kinds: pageIssues.slice(0, 4).map((entry) => safePageIssueKind(entry?.kind)),
      routes: pageIssues.slice(0, 4).map((entry) => {
        const [method, route] = String(entry?.value ?? '').split(' ');
        return `${safeHttpMethod(method)} ${safeRouteLabel(route)}`;
      }),
      expected: pageHttpPolicy.expectedRequests.slice(0, 4).map((entry) => ({
        method: safeHttpMethod(entry?.method),
        route: safeRouteLabel(entry?.route),
        status: safeNonnegativeInteger(entry?.status),
      })),
      unexpectedCount: pageHttpPolicy.unexpectedRequests.length,
      overflow: pageHttpPolicy.overflow === true,
      interceptionFailure: pageHttpPolicy.interceptionFailure === true,
    },
    checkpoint: {
      coreStep: safeCoreStep(runtime.coreStep),
      mainAction: safeMainAction(runtime.main.action),
      sourceRequestCount: safeNonnegativeInteger(runtime.main.sourceRequestCount),
      pageRequestCount: safeNonnegativeInteger(runtime.main.pageRequestCount),
      pageCount: safeNonnegativeInteger(runtime.main.pageCount),
      locatingReadCount: safeNonnegativeInteger(runtime.main.locatingReadCount),
      prematureFinalCount: safeNonnegativeInteger(runtime.main.prematureFinalCount),
      correctiveRequestCount: safeNonnegativeInteger(runtime.main.correctiveRequestCount),
      expectedBytes: safeNonnegativeInteger(runtime.coverageObservation?.expectedBytes),
      bytesDelivered: safeNonnegativeInteger(runtime.coverageObservation?.bytesDelivered),
      ordinaryProviderRequestCount: countOrdinaryProviderRequests(provider),
    },
    handlerStep: safeHandlerStep(runtime.main.handlerStep),
    handlerFailureStep: safeHandlerStep(runtime.main.handlerFailureStep),
    consumeObservation: safeConsumeObservation(runtime.main.consumeObservation),
    providerFailureCount: provider?.failures?.length ?? 0,
    providerFailureCodes: (provider?.failures ?? []).slice(0, 4).map(safeProviderFailureCode),
    terminalCheckpoint: runtime.main.terminal ? {
      kind: runtime.main.terminal.kind === 'result' || runtime.main.terminal.kind === 'error'
        ? runtime.main.terminal.kind
        : 'other',
      reason: safeTerminalReason(runtime.main.terminal.reason),
      code: safeBoundedIdentifier(runtime.main.terminal.code),
      category: safeBoundedIdentifier(runtime.main.terminal.category),
      commitApplied: runtime.main.terminal.commitApplied === true,
      appliedRevision: Number.isSafeInteger(runtime.main.terminal.appliedRevision)
        ? runtime.main.terminal.appliedRevision
        : null,
      acknowledged: runtime.main.terminal.acknowledged === true,
      resultDeliveryCount: safeNonnegativeInteger(runtime.main.terminal.resultDeliveryCount),
    } : null,
    coverage: safeCoverageObservation(runtime.coverageObservation),
    network: {
      browserIsolationVerified: runtime.networkIsolationVerified === true,
      pageUnexpectedCount: pageHttpPolicy.unexpectedRequests.length,
      pageUnexpectedRoutes: pageHttpPolicy.unexpectedRequests.slice(0, MAX_DIAGNOSTIC_ITEMS).map((entry) => ({
        method: safeHttpMethod(entry?.method),
        route: safeRouteLabel(entry?.route),
      })),
      pageExpectedCount: pageHttpPolicy.expectedRequests.length,
      pageExpectedRoutes: pageHttpPolicy.expectedRequests.slice(0, MAX_DIAGNOSTIC_ITEMS).map((entry) => ({
        method: safeHttpMethod(entry?.method),
        route: safeRouteLabel(entry?.route),
        status: Number.isSafeInteger(entry?.status) ? entry.status : null,
      })),
      pageCaptureOverflow: pageHttpPolicy.overflow === true,
      pageInterceptionFailure: pageHttpPolicy.interceptionFailure === true,
    },
    main: {
      action: safeMainAction(runtime.main.action),
      sourceRequestCount: runtime.main.sourceRequestCount,
      pageRequestCount: runtime.main.pageRequestCount,
      pageCount: runtime.main.pageCount,
      locatingReadCount: runtime.main.locatingReadCount,
      prematureFinalCount: runtime.main.prematureFinalCount,
      correctiveRequestCount: runtime.main.correctiveRequestCount,
      firstPageOmittedCursor: runtime.main.firstPageOmittedCursor,
      cursorChainExact: runtime.main.cursorChainExact,
      initialSourceReaderAbsent: runtime.main.initialSourceReaderAbsent,
      continuationReaderObserved: runtime.main.continuationReaderObserved,
      firstCheckpointObserved: runtime.main.firstCheckpointObserved,
      locatingCoverageStable: runtime.main.locatingCoverageStable,
      finalAfterNull: runtime.main.finalAfterNull,
      finalResponseCount: runtime.main.finalResponseCount,
      artifactIdDigest: digestOpaque(runtime.main.artifactId),
      terminal: runtime.main.terminal ? {
        kind: runtime.main.terminal.kind === 'result' || runtime.main.terminal.kind === 'error'
          ? runtime.main.terminal.kind
          : 'other',
        reason: safeTerminalReason(runtime.main.terminal.reason),
        code: safeBoundedIdentifier(runtime.main.terminal.code),
        category: safeBoundedIdentifier(runtime.main.terminal.category),
        commitApplied: runtime.main.terminal.commitApplied === true,
        appliedRevision: Number.isSafeInteger(runtime.main.terminal.appliedRevision)
          ? runtime.main.terminal.appliedRevision
          : null,
        acknowledged: runtime.main.terminal.acknowledged === true,
        promptCanaryDeliveryCount: Number.isSafeInteger(runtime.main.terminal.promptCanaryDeliveryCount)
          ? runtime.main.terminal.promptCanaryDeliveryCount
          : null,
        artifactPayloadCanaryDeliveryCount: Number.isSafeInteger(runtime.main.terminal.artifactPayloadCanaryDeliveryCount)
          ? runtime.main.terminal.artifactPayloadCanaryDeliveryCount
          : null,
        syntheticCredentialDeliveryCount: Number.isSafeInteger(runtime.main.terminal.syntheticCredentialDeliveryCount)
          ? runtime.main.terminal.syntheticCredentialDeliveryCount
          : null,
        deliveryCount: Number.isSafeInteger(runtime.main.terminal.deliveryCount)
          ? runtime.main.terminal.deliveryCount
          : null,
        resultDeliveryCount: Number.isSafeInteger(runtime.main.terminal.resultDeliveryCount)
          ? runtime.main.terminal.resultDeliveryCount
          : null,
      } : null,
    },
    stores,
    provider: provider ? {
      requestCount: provider.capture.length,
      captures: provider.capture.slice(-MAX_DIAGNOSTIC_ITEMS).map((entry) => ({
        ordinal: Number.isSafeInteger(entry.ordinal) ? entry.ordinal : null,
        kind: safeProviderKind(entry.kind),
        route: safeRouteLabel(entry.route),
        protocol: entry.protocol === 'responses' ? 'responses' : 'other',
        model: entry.model === MODEL ? MODEL : null,
        authorizationPresent: entry.authorizationPresent === true,
        httpStatus: Number.isSafeInteger(entry.httpStatus) ? entry.httpStatus : null,
        held: entry.held === true,
        selectedTool: safeToolName(entry.toolNames?.selected),
        offeredTools: (entry.toolNames?.offered ?? []).slice(0, MAX_DIAGNOSTIC_ITEMS).map(safeToolName),
        priorTools: (entry.toolNames?.prior ?? []).slice(0, MAX_DIAGNOSTIC_ITEMS).map(safeToolName),
        latest: entry.latestToolResult ? {
          name: safeToolName(entry.latestToolResult.name),
          status: safeToolResultStatus(entry.latestToolResult.status),
          hasArtifact: entry.latestToolResult.hasArtifact === true,
          hasNextCursor: entry.latestToolResult.hasNextCursor === true,
          hasMatchByteOffset: entry.latestToolResult.hasMatchByteOffset === true,
          byteLength: safeNonnegativeInteger(entry.latestToolResult.byteLength),
          totalBytes: safeNonnegativeInteger(entry.latestToolResult.totalBytes),
        } : null,
        metrics: entry.metrics ? {
          inputItemCount: safeNonnegativeInteger(entry.metrics.inputItemCount),
          toolCallCount: safeNonnegativeInteger(entry.metrics.toolCallCount),
          toolResultCount: safeNonnegativeInteger(entry.metrics.toolResultCount),
          offeredToolCount: safeNonnegativeInteger(entry.metrics.offeredToolCount),
        } : null,
      })),
      httpFixtures: provider.httpFixtureCapture.slice(-MAX_DIAGNOSTIC_ITEMS).map((entry) => ({
        ordinal: Number.isSafeInteger(entry.ordinal) ? entry.ordinal : null,
        kind: safeProviderKind(entry.kind),
        method: safeHttpMethod(entry.method),
        route: safeRouteLabel(entry.route),
        status: Number.isSafeInteger(entry.status) ? entry.status : null,
      })),
      failureCount: provider.failures.length,
      failureCodes: provider.failures.slice(0, MAX_DIAGNOSTIC_ITEMS).map(safeProviderFailureCode),
      unexpectedCount: provider.unexpectedRequests.length,
      unexpectedRoutes: provider.unexpectedRequests.slice(0, MAX_DIAGNOSTIC_ITEMS).map((entry) => ({
        kind: safeProviderFailureCode(entry?.kind),
        method: safeHttpMethod(entry?.method),
        route: safeRouteLabel(entry?.route),
      })),
      captureOverflow: provider.overflow ? Object.fromEntries(
        Object.entries(provider.overflow).slice(0, MAX_DIAGNOSTIC_ITEMS).map(([key, value]) => [safeOverflowKey(key), value === true]),
      ) : null,
    } : null,
    pageIssues: pageIssues.slice(0, MAX_DIAGNOSTIC_ITEMS).map((entry) => ({
      kind: safePageIssueKind(entry?.kind),
      hasPath: typeof entry?.value === 'string' && entry.value.length > 0,
    })),
  };
}

function safeDiagnosticOrFallback(diagnostic) {
  try {
    assertNoSensitiveEvidence(diagnostic);
    return diagnostic;
  } catch {
    return {
      schemaVersion: 1,
      stage: safeStage(runtime.currentStage),
      failure: 'diagnostic-redaction-failure',
    };
  }
}

function safeTerminalReason(value) {
  return ['final_answer', 'stopped', 'provider_error', 'context_limit', 'attempt_state_lost'].includes(value)
    ? value
    : 'other';
}

function safeBoundedIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/u.test(value) ? value : null;
}

function safeProviderKind(value) {
  return [
    'connection-probe',
    'connection-probe-complete',
    'source-get-star',
    'artifact-page',
    'artifact-search',
    'artifact-offset',
    'premature-final',
    'ordinary-context-summary',
    'final-answer',
    'http-fixture',
    'github-token-user',
    'github-token-stars',
    'github-token-gist-create',
    'github-token-gist-delete',
  ].includes(value) ? value : 'other';
}

function safeToolName(value) {
  return ['bgsm_connection_probe', 'get_star', READER_TOOL].includes(value) ? value : 'other';
}

function safeToolResultStatus(value) {
  return ['artifact_available', 'ready', 'complete', 'partial', 'ok'].includes(value) ? value : 'other';
}

function safeHttpMethod(value) {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(value) ? value : 'UNKNOWN';
}

function safeRouteLabel(value) {
  return [
    'responses',
    'github-user',
    'github-starred',
    'github-watch-scope',
    'github-notifications',
    'github-gists',
    'github-probe-gist',
    'github-avatar',
    'github-web',
    'github-gist-web',
    'unknown-http-route',
  ].includes(value) ? value : 'unknown-http-route';
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeProviderFailureCode(value) {
  return [
    'non-http-continue-failed',
    'invalid-request-id',
    'unexpected-provider-method',
    'invalid-responses-json',
    'unexpected-http-request',
    'interception-handler-failed',
    'fail-closed-cleanup-failed',
  ].includes(value) ? value : 'other';
}

function safeOverflowKey(value) {
  return [
    'capture',
    'httpFixture',
    'unexpected',
    'failures',
    'offeredTools',
    'priorTools',
    'inputItems',
    'toolResults',
  ].includes(value) ? value : 'other';
}

function safePageIssueKind(value) {
  return ['console-error', 'page-error', 'request-failed'].includes(value) ? value : 'other';
}

function assertNoSensitiveEvidence(value) {
  const serialized = JSON.stringify(value) ?? '';
  assert.equal(sensitiveMarkerOccurrenceCount(serialized), 0);
}

function sensitiveMarkerOccurrenceCount(serialized) {
  return [GITHUB_CREDENTIAL, PROVIDER_CREDENTIAL, ...PRIVATE_CANARIES]
    .reduce((total, marker) => total + countOccurrences(serialized, marker), 0);
}

function countOccurrences(value, marker) {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(marker, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + marker.length;
  }
  return count;
}

function digestOpaque(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function errorCategory(error) {
  if (error?.name === 'AssertionError') return 'assertion';
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error?.name === 'TypeError') return 'type';
  if (error?.name === 'RangeError') return 'range';
  return 'runtime';
}

function safeStage(value) {
  return [
    'launch',
    'open-options',
    'configure-github',
    'configure-provider',
    'verify-options',
    'seed-and-empty-authority',
    'create-and-load-session',
    'core-artifact-turn',
    'durable-terminal-assertions',
    'containment-health',
    'teardown',
  ].includes(value) ? value : 'unknown';
}
function safeProviderConfigStep(value) {
  return [
    'not-started',
    'open-menu',
    'menu-opened',
    'custom-selected',
    'custom-fields-ready',
    'menu-unlocked',
    'menu-options-ready',
    'advanced-open',
    'fields-filled',
    'disclosure-visible',
    'host-permission',
    'host-permission-ready',
    'save-enabled',
    'save-clicked',
    'fill-base-url',
    'base-url-filled',
    'protocol-selected',
    'declared-context-filled',
    'working-context-filled',
    'model-filled',
  ].includes(value) ? value : 'unknown';
}


function safeProviderFieldObservation(value) {
  const fields = [
    '#agent-base-url',
    '#agent-provider-context-window',
    '#agent-working-context-window',
    '#agent-model',
    '#agent-api-key',
  ];
  if (!value || typeof value !== 'object') return null;
  return {
    field: fields.includes(value.field) ? value.field : 'unknown',
    present: value.present === true,
    enabled: value.enabled === true,
    visible: value.visible === true,
    exact: value.exact === true,
  };
}

function safeMainAction(value) {
  return [
    'start',
    'source',
    'first-page',
    'first-page-summary',
    'search',
    'offset',
    'premature',
    'pages',
    'pages-after-summary',
    'final',
  ].includes(value) ? value : 'unknown';
}
function safeCoverageObservation(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    coverageTotalCount: safeNonnegativeInteger(value.coverageTotalCount),
    coverageLength: safeNonnegativeInteger(value.coverageLength),
    state: ['pending', 'complete'].includes(value.state) ? value.state : 'other',
    artifactMatches: value.artifactMatches === true,
    expectedCursorMatches: value.expectedCursorMatches === true,
    expectedCursorNull: value.expectedCursorNull === true,
    expectedBytes: safeNonnegativeInteger(value.expectedBytes),
    bytesDelivered: safeNonnegativeInteger(value.bytesDelivered),
    hasProgressToken: value.hasProgressToken === true,
    hasCursorChainDigest: value.hasCursorChainDigest === true,
  };
}

function safeConsumeObservation(value) {
  if (!value || typeof value !== 'object') return null;
  const keys = [
    'pendingPresent',
    'invocationPresent',
    'invocationIdMatches',
    'invocationNameMatches',
    'resultPresent',
    'resultCallIdMatches',
    'resultNameMatches',
    'resultArtifactMatches',
    'resultByteLengthValid',
    'resultTotalBytesMatches',
    'invocationArgumentsMatch',
    'nextCursorValid',
    'nextCursorUnique',
  ];
  return {
    checked: keys.length,
    failed: keys.filter((key) => value[key] !== true),
  };
}

function safeHandlerStep(value) {
  const detailed = [
    'core:pages:consume',
    'core:pages:continue',
    'core:pages:finalize',
    'core:pages:issue',
  ];
  if (detailed.includes(value)) return value;
  if (value === 'ordinary') return value;
  const action = typeof value === 'string' && value.startsWith('core:') ? value.slice(5) : null;
  return action && safeMainAction(action) !== 'unknown' ? `core:${action}` : null;
}

function safeContainmentStep(value) {
  return [
    'not-started',
    'provider-health',
    'network-isolation',
    'source-catalog',
    'unexpected-network',
    'page-fixture-sequence',
    'page-unexpected',
    'page-overflow',
    'page-interception',
    'page-issues',
    'retained-evidence',
    'public-diagnostics',
    'complete',
  ].includes(value) ? value : 'unknown';
}

function safeCoreStep(value) {
  return [
    'not-started',
    'launching',
    'waiting-first-hold',
    'reading-first-checkpoint',
    'waiting-locating-hold',
    'reading-locating-checkpoint',
    'waiting-terminal',
    'asserting-terminal',
    'complete',
  ].includes(value) ? value : 'unknown';
}


function buildArtifactEvidence() {
  const authority = runtime.finalAuthority;
  const coverage = authority.attempt.coverage[0];
  return {
    schemaVersion: 1,
    status: 'passed',
    proofScope: 'packaged_durable_artifact',
    productionDistExercised: true,
    releaseDist: readRuntimeReleaseDistIdentity(DIST),
    artifactFlow: {
      provider: {
        requests: provider.capture.length,
        sourceRequests: runtime.main.sourceRequestCount,
        locatingReads: runtime.main.locatingReadCount,
        exhaustivePageReads: runtime.main.pageRequestCount,
        ordinaryBoundaries: countOrdinaryProviderRequests(provider),
        provisionalFinals: runtime.main.prematureFinalCount,
        correctiveReprompts: runtime.main.correctiveRequestCount,
        finalResponses: runtime.main.finalResponseCount,
      },
      coverage: {
        firstPageOmittedCursor: runtime.main.firstPageOmittedCursor,
        cursorChainExact: runtime.main.cursorChainExact,
        pageCount: runtime.main.pageCount,
        expectedBytes: coverage.expectedBytes,
        deliveredBytes: coverage.bytesDelivered,
        nextCursorNull: coverage.expectedCursorNull,
        artifactDigestPresent: coverage.hasArtifactDigest,
        manifestDigestPresent: coverage.hasManifestDigest,
        cursorChainDigestPresent: coverage.hasCursorChainDigest,
        chunksMatchManifest: authority.artifact.item.chunksMatchManifest,
      },
      canonical: {
        sourceToolRows: authority.messages.sourceToolRowCount,
        readerRows: authority.messages.readerRowCount,
        prematureAssistantRows: authority.messages.prematureAssistantRowCount,
        finalAssistantRows: authority.messages.finalAssistantRowCount,
        receiptCount: authority.messages.sourceReceiptCount,
      },
      settlement: {
        commitApplied: runtime.main.terminal.commitApplied,
        revisionDelta: authority.session.revision - runtime.baseRevision,
        recoveryRows: authority.attempt.recoveryCount,
        continuationPresent: authority.attempt.hasContinuation,
        leasePresent: authority.attempt.leasePresent,
      },
    },
    containment: {
      networkFailClosed: runtime.networkIsolationVerified,
      unexpectedNetworkRequests: provider.unexpectedRequests.length + pageHttpPolicy.unexpectedRequests.length,
      rawCredentialOccurrences: 0,
      privatePayloadOccurrences: 0,
      overflow: Object.values(provider.overflow).some(Boolean) || pageHttpPolicy.overflow,
    },
    cleanup: { ...runtime.cleanup },
    evidenceBytes: 0,
  };
}

function validateArtifactEvidence(value) {
  assertExactEvidenceKeys(value, ['schemaVersion', 'status', 'proofScope', 'productionDistExercised', 'releaseDist', 'artifactFlow', 'containment', 'cleanup', 'evidenceBytes']);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.status, 'passed');
  assert.equal(value.proofScope, 'packaged_durable_artifact');
  assert.equal(value.productionDistExercised, true);
  assertRuntimeReleaseDistIdentity(value.releaseDist);
  assertExactEvidenceKeys(value.artifactFlow, ['provider', 'coverage', 'canonical', 'settlement']);
  assertExactEvidenceKeys(value.artifactFlow.provider, ['requests', 'sourceRequests', 'locatingReads', 'exhaustivePageReads', 'ordinaryBoundaries', 'provisionalFinals', 'correctiveReprompts', 'finalResponses']);
  assertExactEvidenceKeys(value.artifactFlow.coverage, ['firstPageOmittedCursor', 'cursorChainExact', 'pageCount', 'expectedBytes', 'deliveredBytes', 'nextCursorNull', 'artifactDigestPresent', 'manifestDigestPresent', 'cursorChainDigestPresent', 'chunksMatchManifest']);
  assertExactEvidenceKeys(value.artifactFlow.canonical, ['sourceToolRows', 'readerRows', 'prematureAssistantRows', 'finalAssistantRows', 'receiptCount']);
  assertExactEvidenceKeys(value.artifactFlow.settlement, ['commitApplied', 'revisionDelta', 'recoveryRows', 'continuationPresent', 'leasePresent']);
  assertExactEvidenceKeys(value.containment, ['networkFailClosed', 'unexpectedNetworkRequests', 'rawCredentialOccurrences', 'privatePayloadOccurrences', 'overflow']);
  assertExactEvidenceKeys(value.cleanup, ['networkGatesClosed', 'diagnosticsDetached', 'pagesClosed', 'browserClosed', 'temporaryStateRemoved']);
  for (const entry of Object.values(value.artifactFlow.provider)) assertNonnegativeEvidenceInteger(entry);
  for (const key of ['pageCount', 'expectedBytes', 'deliveredBytes']) assertNonnegativeEvidenceInteger(value.artifactFlow.coverage[key]);
  for (const entry of Object.values(value.artifactFlow.canonical)) assertNonnegativeEvidenceInteger(entry);
  for (const key of ['revisionDelta', 'recoveryRows']) assertNonnegativeEvidenceInteger(value.artifactFlow.settlement[key]);
  assert.deepEqual(value.artifactFlow.provider, {
    requests: provider.capture.length,
    sourceRequests: 1,
    locatingReads: 2,
    exhaustivePageReads: runtime.main.pageCount,
    ordinaryBoundaries: countOrdinaryProviderRequests(provider),
    provisionalFinals: 1,
    correctiveReprompts: 1,
    finalResponses: 1,
  });
  assert.equal(value.artifactFlow.provider.ordinaryBoundaries >= 1, true);
  assert.equal(value.artifactFlow.coverage.pageCount >= MINIMUM_PAGE_COUNT, true);
  assert.equal(value.artifactFlow.coverage.expectedBytes > 0, true);
  assert.equal(value.artifactFlow.coverage.deliveredBytes, value.artifactFlow.coverage.expectedBytes);
  for (const key of ['firstPageOmittedCursor', 'cursorChainExact', 'nextCursorNull', 'artifactDigestPresent', 'manifestDigestPresent', 'cursorChainDigestPresent', 'chunksMatchManifest']) {
    assert.equal(value.artifactFlow.coverage[key], true);
  }
  assert.deepEqual(value.artifactFlow.canonical, { sourceToolRows: 1, readerRows: 0, prematureAssistantRows: 0, finalAssistantRows: 1, receiptCount: 1 });
  assert.deepEqual(value.artifactFlow.settlement, { commitApplied: true, revisionDelta: 1, recoveryRows: 0, continuationPresent: false, leasePresent: false });
  assert.deepEqual(value.containment, { networkFailClosed: true, unexpectedNetworkRequests: 0, rawCredentialOccurrences: 0, privatePayloadOccurrences: 0, overflow: false });
  assert.equal(Object.values(value.cleanup).every((entry) => entry === true), true);
  assert.equal(Number.isSafeInteger(value.evidenceBytes) && value.evidenceBytes > 0 && value.evidenceBytes <= MAX_RUNTIME_EVIDENCE_BYTES, true);
}

function assertExactEvidenceKeys(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value), keys);
}

function assertNonnegativeEvidenceInteger(value) {
  assert.equal(Number.isSafeInteger(value) && value >= 0, true);
}

function runtimeEvidenceFailureCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[a-z_]{1,64}$/u.test(code) ? code : 'evidence_failure';
}

function createMainState() {
  return {
    active: false,
    action: 'start',
    handlerStep: null,
    handlerFailureStep: null,
    consumeObservation: null,
    artifactId: null,
    artifactBytes: null,
    cursor: null,
    pendingPage: null,
    pendingLocating: null,
    searchByteOffset: null,
    issuedCursors: new Set(),
    returnedCursors: new Set(),
    sourceRequestCount: 0,
    pageRequestCount: 0,
    pageCount: 0,
    locatingReadCount: 0,
    prematureFinalCount: 0,
    correctiveRequestCount: 0,
    firstPageOmittedCursor: false,
    cursorChainExact: false,
    initialSourceReaderAbsent: false,
    continuationReaderObserved: false,
    firstCheckpointObserved: false,
    finalAfterNull: false,
    finalResponseCount: 0,
    terminal: null,
  };
}

async function teardown() {
  runtime.currentStage = 'teardown';
  const failures = [];
  const attempt = async (operation) => {
    try {
      await operation();
    } catch {
      failures.push(true);
    }
  };
  if (page && !page.isClosed?.()) {
    await attempt(() => page.evaluate(() => globalThis.__runtimeAgent?.dispose?.()));
  }
  await attempt(async () => {
    pageDiagnostics?.cleanup?.();
    runtime.cleanup.diagnosticsDetached = true;
  });
  await attempt(async () => {
    await pageHttpPolicy.close?.();
    runtime.cleanup.networkGatesClosed = pageHttpPolicy.closed === true && provider?.closed === true;
  });
  await attempt(async () => {
    await closeControlledResponsesProvider(provider);
    runtime.cleanup.networkGatesClosed = pageHttpPolicy.closed === true && provider?.closed === true;
  });
  if (page && !page.isClosed?.()) await attempt(() => page.close());
  runtime.cleanup.pagesClosed = !page || page.isClosed?.() === true;
  if (browser) await attempt(() => browser.close());
  runtime.cleanup.browserClosed = true;
  await attempt(() => rmSync(profile, { recursive: true, force: true }));
  runtime.cleanup.temporaryStateRemoved = !existsSync(profile);
  runtime.passedStages.push('teardown');
  if (failures.length > 0) throw new Error('Packaged durable Agent session teardown failed.');
}
