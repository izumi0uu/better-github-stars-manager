import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CHROMIUM_FULL_PRODUCT_SCENARIO_IDS } from './extension-browser-smoke.mjs';
import {
  assertFullProductEdgeManifest,
  classifyEdgeBrowserIdentity,
  createEdgeFullProductEvidence,
  EDGE_FULL_PRODUCT_CAPABILITIES,
} from './edge-full-product-smoke.mjs';

const fullProductManifest = Object.freeze({
  manifest_version: 3,
  permissions: ['storage', 'alarms'],
  host_permissions: [
    'https://api.github.com/*',
    'https://api.openai.com/*',
    'https://api.anthropic.com/*',
    'https://github.com/*',
    'https://openrouter.ai/*',
  ],
  optional_host_permissions: [
    'https://*/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ],
  background: { service_worker: 'service-worker-loader.js', type: 'module' },
  action: { default_popup: 'src/popup/index.html' },
  options_ui: { page: 'src/options/index.html' },
});

function evidenceInput(browserIdentity) {
  return {
    proofScope: browserIdentity.releaseProofEligible
      ? 'microsoft_edge_shared_chromium_runtime'
      : 'test_only_local_chromium_runtime',
    browserIdentity,
    executableSha256: 'a'.repeat(64),
    extensionId: 'b'.repeat(32),
    manifestEvidence: assertFullProductEdgeManifest(fullProductManifest),
    verifiedScenarioIds: CHROMIUM_FULL_PRODUCT_SCENARIO_IDS,
    diagnostics: Object.freeze({
      observedPageErrors: 0,
      observedBackgroundErrors: 0,
      observedUncaughtErrors: 0,
      backgroundObservation: 'post_guard_install',
      startupHealthChecks: 0,
    }),
    packageInput: Object.freeze({ algorithm: 'sha256', fileCount: 7, sha256: 'c'.repeat(64) }),
    packagedCapabilities: EDGE_FULL_PRODUCT_CAPABILITIES,
  };
}

test('Edge manifest projects the exact full Chrome permission surface', () => {
  const evidence = assertFullProductEdgeManifest(fullProductManifest);
  assert.deepEqual(evidence.permissions, ['alarms', 'storage']);
  assert.deepEqual(evidence.optionalPermissions, []);
  assert.deepEqual(evidence.hostPermissions, [
    'https://api.anthropic.com/*',
    'https://api.github.com/*',
    'https://api.openai.com/*',
    'https://github.com/*',
    'https://openrouter.ai/*',
  ]);
  assert.deepEqual(evidence.optionalHostPermissions, [
    'http://127.0.0.1/*',
    'http://localhost/*',
    'https://*/*',
  ]);

  assert.throws(
    () => assertFullProductEdgeManifest({
      ...fullProductManifest,
      host_permissions: fullProductManifest.host_permissions.filter(
        (permission) => permission !== 'https://api.openai.com/*',
      ),
    }),
    /manifest\.host_permissions is not the full-product Edge set/u,
  );
  assert.throws(
    () => assertFullProductEdgeManifest({
      ...fullProductManifest,
      optional_host_permissions: undefined,
    }),
    /manifest\.optional_host_permissions must be an array/u,
  );
  assert.throws(
    () => assertFullProductEdgeManifest({
      ...fullProductManifest,
      optional_permissions: ['tabs'],
    }),
    /must omit optional_permissions like Chrome/u,
  );
});

test('release proof requires a hashed executable and rejects User-Agent substitution', () => {
  const verifiedEdge = classifyEdgeBrowserIdentity({
    product: 'Chrome/140.0.0.0',
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    reportedVersion: 'Chrome/140.0.0.0',
    commandLineArguments: ['Microsoft Edge', '--remote-debugging-pipe'],
    executableSha256: 'a'.repeat(64),
  });
  assert.deepEqual(verifiedEdge, {
    name: 'Microsoft Edge',
    version: '140.0.0.0',
    releaseProofEligible: true,
  });

  for (const unverified of [
    classifyEdgeBrowserIdentity({
      product: 'Chrome/140.0.0.0',
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Edg/140.0.0.0',
      commandLineArguments: ['Chromium', '--user-agent=Mozilla/5.0 Edg/140.0.0.0'],
      executableSha256: 'a'.repeat(64),
    }),
    classifyEdgeBrowserIdentity({
      product: 'Chrome/140.0.0.0',
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Edg/140.0.0.0',
      commandLineArguments: ['Microsoft Edge'],
    }),
    classifyEdgeBrowserIdentity({
      product: 'Chrome/140.0.0.0',
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Edg/140.0.0.0',
      executableSha256: 'a'.repeat(64),
    }),
    classifyEdgeBrowserIdentity({
      product: 'Chrome/140.0.0.0',
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0',
      commandLineArguments: ['Chromium'],
      executableSha256: 'a'.repeat(64),
    }),
  ]) {
    assert.equal(unverified.name, 'Non-Edge Chromium (test-only local mode)');
    assert.equal(unverified.releaseProofEligible, false);
  }
});

test('test-only local Chromium evidence separates package declarations from verified scenarios', () => {
  const browserIdentity = classifyEdgeBrowserIdentity({
    product: 'Chrome/140.0.0.0',
    userAgent: 'Chrome/140.0.0.0',
    commandLineArguments: ['Chromium'],
    executableSha256: 'a'.repeat(64),
  });
  const evidence = createEdgeFullProductEvidence(evidenceInput(browserIdentity));

  assert.equal(evidence.browserTarget, 'edge');
  assert.equal(evidence.releaseProof, false);
  assert.equal(evidence.proofScope, 'test_only_local_chromium_runtime');
  assert.deepEqual(evidence.browserIdentity, {
    name: 'Non-Edge Chromium (test-only local mode)',
    version: '140.0.0.0',
  });
  assert.deepEqual(evidence.packagedCapabilities, {
    gistSync: true,
    agent: true,
    organizeProvider: true,
  });
  assert.equal(evidence.executable.sha256, 'a'.repeat(64));
  assert.equal(Object.hasOwn(evidence.executable, 'path'), false);
  assert.deepEqual(evidence.verifiedScenarioIds, CHROMIUM_FULL_PRODUCT_SCENARIO_IDS);
  assert.deepEqual(evidence.diagnostics, {
    observedPageErrors: 0,
    observedBackgroundErrors: 0,
    observedUncaughtErrors: 0,
    backgroundObservation: 'post_guard_install',
    startupHealthChecks: 0,
  });
});

test('only a verified Edge identity can produce shared Chromium runtime proof', () => {
  const browserIdentity = classifyEdgeBrowserIdentity({
    userAgent: 'Edg/140.0.0.0',
    commandLineArguments: ['Microsoft Edge'],
    executableSha256: 'a'.repeat(64),
  });
  const evidence = createEdgeFullProductEvidence(evidenceInput(browserIdentity));
  assert.equal(evidence.releaseProof, true);
  assert.equal(evidence.proofScope, 'microsoft_edge_shared_chromium_runtime');

  assert.throws(
    () => createEdgeFullProductEvidence({
      ...evidenceInput(browserIdentity),
      proofScope: 'test_only_local_chromium_runtime',
    }),
    /proof scope does not match/u,
  );
  assert.throws(
    () => createEdgeFullProductEvidence({
      ...evidenceInput(browserIdentity),
      packagedCapabilities: { ...EDGE_FULL_PRODUCT_CAPABILITIES, agent: false },
    }),
    /packaged capability declaration is not exact/u,
  );
  assert.throws(
    () => createEdgeFullProductEvidence({
      ...evidenceInput(browserIdentity),
      verifiedScenarioIds: CHROMIUM_FULL_PRODUCT_SCENARIO_IDS.slice(0, -1),
    }),
    /scenarios it actually executed/u,
  );
});
