import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  RuntimeEvidenceError,
  serializeRuntimeEvidence,
} from '../../scripts/agent-runtime-evidence-contract.mjs';
import {
  SCENARIO_IDS,
  validateScenarioEvidence,
} from '../runtime/agent-scenarios-extension-host.mjs';

const RELEASE_IDENTITY = releaseIdentity('a', 'b', 'c', 'd');
const DIAGNOSTICS_IDENTITY = releaseIdentity('e', 'f', '1', '2');

function releaseIdentity(packageDigest, manifestDigest, loaderDigest, workerDigest) {
  return {
    packageInput: {
      algorithm: 'sha256',
      fileCount: 4,
      sha256: packageDigest.repeat(64),
    },
    manifest: {
      relativePath: 'manifest.json',
      bytes: 256,
      sha256: manifestDigest.repeat(64),
      manifestVersion: 3,
      extensionVersion: '1.0.8',
    },
    loader: {
      relativePath: 'service-worker-loader.js',
      bytes: 64,
      sha256: loaderDigest.repeat(64),
    },
    worker: {
      relativePath: 'assets/service-worker.js',
      bytes: 1024,
      sha256: workerDigest.repeat(64),
    },
  };
}

function validEvidence() {
  return {
    schemaVersion: 1,
    status: 'passed',
    proofScope: 'development_scenario_lab',
    productionDistExercised: false,
    releaseDist: structuredClone(RELEASE_IDENTITY),
    diagnosticsBuild: structuredClone(DIAGNOSTICS_IDENTITY),
    scenarioLab: {
      scenarios: {
        ids: [...SCENARIO_IDS],
        rootCount: 9,
        eventCount: 413,
        completedCount: 7,
        cancelledCount: 2,
        failedCount: 0,
        lastEventTerminal: true,
        artifactContinuationProviderRequests: 13,
        writeOutcomeEvents: 0,
      },
      rawCapture: {
        warningRendered: true,
        armedBeforeReload: true,
        disarmedAfterReload: true,
      },
      issues: { page: 0, worker: 0 },
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
    evidenceBytes: 0,
  };
}

test('serializes the exact bounded Scenario Lab schema with distinct production and diagnostics identities', () => {
  const evidence = validEvidence();
  const serialized = serializeRuntimeEvidence(evidence, {
    validateEvidence: validateScenarioEvidence,
  });

  assert.equal(serialized.endsWith('\n'), true);
  assert.equal(Buffer.byteLength(serialized), evidence.evidenceBytes);
  assert.deepEqual(Object.keys(evidence), [
    'schemaVersion',
    'status',
    'proofScope',
    'productionDistExercised',
    'releaseDist',
    'diagnosticsBuild',
    'scenarioLab',
    'containment',
    'cleanup',
    'evidenceBytes',
  ]);
  assert.equal(serialized.includes('SCENARIO_PRIVATE'), false);
});

test('rejects unknown Scenario facts and a diagnostics build substituted for production identity', () => {
  const unknownFact = validEvidence();
  unknownFact.scenarioLab.rawCapture.unexpected = true;
  assert.throws(
    () => serializeRuntimeEvidence(unknownFact, { validateEvidence: validateScenarioEvidence }),
    (error) => error instanceof RuntimeEvidenceError && error.code === 'schema_invalid',
  );

  const substitutedIdentity = validEvidence();
  substitutedIdentity.diagnosticsBuild = structuredClone(substitutedIdentity.releaseDist);
  assert.throws(
    () => serializeRuntimeEvidence(substitutedIdentity, { validateEvidence: validateScenarioEvidence }),
    (error) => error instanceof RuntimeEvidenceError && error.code === 'schema_invalid',
  );
});

test('rejects partial Scenario sets, containment gaps, and cleanup gaps', () => {
  const partial = validEvidence();
  partial.scenarioLab.scenarios.ids.pop();
  partial.scenarioLab.scenarios.rootCount -= 1;
  assert.throws(
    () => serializeRuntimeEvidence(partial, { validateEvidence: validateScenarioEvidence }),
    (error) => error instanceof RuntimeEvidenceError && error.code === 'schema_invalid',
  );

  const networkGap = validEvidence();
  networkGap.containment.unexpectedNetworkRequests = 1;
  assert.throws(
    () => serializeRuntimeEvidence(networkGap, { validateEvidence: validateScenarioEvidence }),
    (error) => error instanceof RuntimeEvidenceError && error.code === 'schema_invalid',
  );

  const cleanupGap = validEvidence();
  cleanupGap.cleanup.browserClosed = false;
  assert.throws(
    () => serializeRuntimeEvidence(cleanupGap, { validateEvidence: validateScenarioEvidence }),
    (error) => error instanceof RuntimeEvidenceError && error.code === 'schema_invalid',
  );
});
