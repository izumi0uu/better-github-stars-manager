#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  packageInputFingerprint,
  validatePackageInputFingerprint,
} from '../../scripts/package-input-fingerprint.mjs';
import {
  CHROMIUM_FULL_PRODUCT_SCENARIO_IDS,
  runExtensionBrowserSmoke,
} from './extension-browser-smoke.mjs';
import {
  classifyEdgeBrowserIdentity,
  resolveExecutablePath,
} from './puppeteer-runtime.mjs';
import { resolvePackagedServiceWorker } from './extension-runtime-targets.mjs';

const EXPECTED_PERMISSIONS = Object.freeze(['alarms', 'storage']);
const EXPECTED_HOST_PERMISSIONS = Object.freeze([
  'https://api.github.com/*',
  'https://github.com/*',
]);
const EXPECTED_OPTIONAL_HOST_PERMISSIONS = Object.freeze([
  'http://127.0.0.1/*',
  'http://localhost/*',
  'https://*/*',
]);
export const EDGE_FULL_PRODUCT_CAPABILITIES = Object.freeze({
  gistSync: true,
  agent: true,
  organizeProvider: true,
});

export { classifyEdgeBrowserIdentity };

export function assertFullProductEdgeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('Full-product Edge manifest must be an object.');
  }
  assert.equal(manifest.manifest_version, 3, 'Full-product Edge package must use Manifest V3.');
  assert.equal(
    manifest.background?.type,
    'module',
    'Full-product Edge background service worker must be a module.',
  );
  assert.equal(
    typeof manifest.background?.service_worker,
    'string',
    'Full-product Edge manifest must declare a background service worker.',
  );
  assertExactStringSet(manifest.permissions, EXPECTED_PERMISSIONS, 'manifest.permissions');
  assertExactStringSet(
    manifest.host_permissions,
    EXPECTED_HOST_PERMISSIONS,
    'manifest.host_permissions',
  );
  assertExactStringSet(
    manifest.optional_host_permissions,
    EXPECTED_OPTIONAL_HOST_PERMISSIONS,
    'manifest.optional_host_permissions',
  );
  assert.equal(
    Object.hasOwn(manifest, 'optional_permissions'),
    false,
    'Full-product Edge manifest must omit optional_permissions like Chrome.',
  );
  assert.equal(
    typeof manifest.action?.default_popup,
    'string',
    'Full-product Edge manifest must retain the popup.',
  );
  assert.equal(
    typeof (manifest.options_ui?.page ?? manifest.options_page),
    'string',
    'Full-product Edge manifest must retain Options.',
  );

  return deepFreeze({
    manifestVersion: 3,
    background: { kind: 'service_worker', module: true },
    permissions: EXPECTED_PERMISSIONS,
    optionalPermissions: [],
    hostPermissions: EXPECTED_HOST_PERMISSIONS,
    optionalHostPermissions: EXPECTED_OPTIONAL_HOST_PERMISSIONS,
  });
}

export function createEdgeFullProductEvidence(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Edge full-product smoke evidence input is required.');
  }
  const releaseProof = input.browserIdentity?.releaseProofEligible === true;
  const expectedProofScope = releaseProof
    ? 'microsoft_edge_shared_chromium_runtime'
    : 'test_only_local_chromium_runtime';
  if (input.proofScope !== expectedProofScope) {
    throw new Error('Edge full-product proof scope does not match the observed browser identity.');
  }
  if (!/^[a-z]{32}$/u.test(input.extensionId)) {
    throw new Error('Edge full-product smoke extension ID is invalid.');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.executableSha256)) {
    throw new Error('Edge full-product executable content digest is invalid.');
  }
  validatePackageInputFingerprint(input.packageInput);
  assert.equal(input.manifestEvidence.manifestVersion, 3);
  assert.deepEqual(
    input.manifestEvidence.background,
    { kind: 'service_worker', module: true },
  );
  assert.deepEqual(input.manifestEvidence.permissions, EXPECTED_PERMISSIONS);
  assert.deepEqual(input.manifestEvidence.optionalPermissions, []);
  assert.deepEqual(input.manifestEvidence.hostPermissions, EXPECTED_HOST_PERMISSIONS);
  assert.deepEqual(
    input.manifestEvidence.optionalHostPermissions,
    EXPECTED_OPTIONAL_HOST_PERMISSIONS,
  );
  assert.equal(
    input.browserIdentity.name,
    releaseProof ? 'Microsoft Edge' : 'Non-Edge Chromium (test-only local mode)',
    'Edge full-product browser label does not match its proof eligibility.',
  );
  if (releaseProof && !/^[0-9]+(?:\.[0-9]+)*$/u.test(input.browserIdentity.version)) {
    throw new Error('Microsoft Edge release proof requires an observed Edg/<version> identity.');
  }
  assert.deepEqual(
    input.packagedCapabilities,
    EDGE_FULL_PRODUCT_CAPABILITIES,
    'Edge packaged capability declaration is not exact.',
  );
  assert.deepEqual(
    input.verifiedScenarioIds,
    CHROMIUM_FULL_PRODUCT_SCENARIO_IDS,
    'Edge must report the shared Chromium scenarios it actually executed.',
  );

  return deepFreeze({
    schemaVersion: 1,
    status: 'passed',
    browserTarget: 'edge',
    proofScope: input.proofScope,
    releaseProof,
    browserIdentity: {
      name: input.browserIdentity.name,
      version: input.browserIdentity.version,
    },
    executable: {
      algorithm: 'sha256',
      sha256: input.executableSha256,
    },
    extensionId: input.extensionId,
    background: input.manifestEvidence.background,
    manifest: {
      permissions: input.manifestEvidence.permissions,
      optionalPermissions: input.manifestEvidence.optionalPermissions,
      hostPermissions: input.manifestEvidence.hostPermissions,
      optionalHostPermissions: input.manifestEvidence.optionalHostPermissions,
    },
    verifiedScenarioIds: input.verifiedScenarioIds,
    diagnostics: projectEdgeDiagnostics(input.diagnostics),
    packageInput: input.packageInput,
    packagedCapabilities: input.packagedCapabilities,
  });
}

export async function runEdgeFullProductSmoke(options = {}) {
  const dist = path.resolve(options.dist ?? process.env.GSM_DIST_DIR ?? 'dist-edge');
  const executablePath = await resolveExecutablePath({
    target: 'edge',
    executablePath: options.executablePath,
  });
  const packagedWorker = resolvePackagedServiceWorker(dist, { target: 'edge' });
  const manifestEvidence = assertFullProductEdgeManifest(
    parseManifest(packagedWorker.manifestBytes),
  );
  const packageInput = packageInputFingerprint(dist);
  const smoke = await runExtensionBrowserSmoke({
    target: 'edge',
    dist,
    executablePath,
    allowNonEdgeExecutableForLocalTest: options.allowNonEdgeExecutableForLocalTest === true,
  });

  return createEdgeFullProductEvidence({
    proofScope: smoke.browserIdentity.releaseProofEligible
      ? 'microsoft_edge_shared_chromium_runtime'
      : 'test_only_local_chromium_runtime',
    browserIdentity: smoke.browserIdentity,
    executableSha256: smoke.executable.sha256,
    extensionId: smoke.extensionId,
    manifestEvidence,
    verifiedScenarioIds: smoke.scenarioIds,
    diagnostics: smoke.diagnostics,
    packageInput,
    packagedCapabilities: EDGE_FULL_PRODUCT_CAPABILITIES,
  });
}

function projectEdgeDiagnostics(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Edge full-product diagnostics are required.');
  }
  const projected = {
    observedPageErrors: nonnegativeInteger(input.observedPageErrors, 'observedPageErrors'),
    observedBackgroundErrors: nonnegativeInteger(
      input.observedBackgroundErrors,
      'observedBackgroundErrors',
    ),
    observedUncaughtErrors: nonnegativeInteger(
      input.observedUncaughtErrors,
      'observedUncaughtErrors',
    ),
    backgroundObservation: input.backgroundObservation,
    startupHealthChecks: nonnegativeInteger(input.startupHealthChecks, 'startupHealthChecks'),
  };
  if (projected.backgroundObservation !== 'post_guard_install') {
    throw new Error('Edge full-product diagnostics have an unexpected observation scope.');
  }
  return projected;
}

function nonnegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Edge full-product diagnostics.${field} must be a nonnegative integer.`);
  }
  return value;
}

function parseManifest(bytes) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('dist-edge/manifest.json is not valid JSON.');
  }
}

function assertExactStringSet(actual, expected, label) {
  assert.ok(Array.isArray(actual), `${label} must be an array.`);
  const normalized = [...new Set(actual)].sort();
  assert.equal(normalized.length, actual.length, `${label} must not contain duplicates.`);
  assert.deepEqual(normalized, expected, `${label} is not the full-product Edge set.`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function formatError(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEdgeFullProductSmoke().then((evidence) => {
    console.log(JSON.stringify(evidence));
  }).catch((error) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}
