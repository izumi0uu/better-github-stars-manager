import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { createProductManifest } from '../../manifest.config.ts';
import {
  finalCheckSpecsForTarget,
  normalizeReleaseBrowserTarget,
  ReleaseEvidenceError,
} from '../../scripts/agent-runtime-release-evidence.mjs';
import {
  buildEdgeExtension,
  edgeBuildEnvironment,
  EDGE_DIST_DIR,
} from '../../scripts/build-edge-extension.mjs';
import {
  assertEdgeManifestContract,
  assertEdgeOutputContract,
  EDGE_REQUIRED_HOST_PERMISSIONS,
  EDGE_OPTIONAL_HOST_PERMISSIONS,
  EdgeManifestContractError,
} from '../../scripts/check-edge-output-contracts.mjs';
import {
  createPackageInputInventory,
  fingerprintPackageInventory,
} from '../../scripts/package-input-fingerprint.mjs';
import {
  discoverMermaidArtifacts,
  EDGE_RELEASE_WORKER_BASELINE,
  enforceWorkerReleaseBaseline,
  measureBundleArtifact,
  PackageClosureError,
  validateManifestResourceClosure,
} from '../../scripts/package-manifest-closure.mjs';
import {
  packageExtension,
  PackageExtensionError,
  readZipInventory,
  resolvePackageTarget,
} from '../../scripts/package-extension.mjs';
import { packageEdgeExtension } from '../../scripts/package-edge-extension.mjs';

const VERSION = '1.0.9';
const COMMIT = 'a'.repeat(40);
const GENERATED_AT = '2026-08-17T12:00:00.000Z';
const BUILD_OUTPUT_SHA = 'b'.repeat(64);
const DISCLOSURE_MARKERS = [
  'prompt_or_bounded_task_instruction',
  'selected_or_frozen_scope_public_repository_metadata',
  'selected_or_frozen_scope_public_repository_code_snippets',
  'selected_or_frozen_scope_private_notes',
  'visible_bounded_tag_taxonomy',
  'protocol_observations',
  'credentials_or_secrets',
  'github_token',
  'unrelated_or_out_of_scope_stars',
];
const WORKER_SOURCE = `export const fullProductDisclosure = ${JSON.stringify(DISCLOSURE_MARKERS)};\n`;

function write(root, relativePath, bytes = relativePath) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

function withFixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'edge-platform-contract-'));
  try {
    writeEdgeOutput(root);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function edgeManifest(overrides = {}) {
  return {
    manifest_version: 3,
    name: 'Fixture Edge extension',
    version: VERSION,
    permissions: ['storage', 'alarms'],
    host_permissions: [...EDGE_REQUIRED_HOST_PERMISSIONS],
    optional_host_permissions: [...EDGE_OPTIONAL_HOST_PERMISSIONS],
    background: { service_worker: 'service-worker-loader.js', type: 'module' },
    action: { default_popup: 'src/popup/index.html' },
    options_ui: { page: 'src/options/index.html', open_in_tab: true },
    content_scripts: [
      { matches: ['https://github.com/*'], js: ['assets/stars.js'], run_at: 'document_idle' },
      { matches: ['https://github.com/*'], js: ['assets/repo.js'], run_at: 'document_idle' },
    ],
    ...overrides,
  };
}

function writeEdgeOutput(root, overrides = {}) {
  const manifest = edgeManifest(overrides);
  write(root, 'dist-edge/manifest.json', `${JSON.stringify(manifest)}\n`);
  write(root, 'dist-edge/service-worker-loader.js', "import './assets/worker.js';\n");
  write(root, 'dist-edge/assets/worker.js', WORKER_SOURCE);
  write(root, 'dist-edge/assets/stars.js');
  write(root, 'dist-edge/assets/repo.js');
  write(root, 'dist-edge/src/popup/index.html');
  write(root, 'dist-edge/src/options/index.html');
  return manifest;
}

function releaseInputs(root) {
  const distDir = path.join(root, EDGE_DIST_DIR);
  const inventory = createPackageInputInventory(distDir);
  const manifest = JSON.parse(readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  const closure = validateManifestResourceClosure({ manifest, packageEntries: inventory });
  const workerEntry = inventory.find(({ relativePath }) => relativePath === closure.workerRelativePath);
  const worker = measureBundleArtifact(workerEntry);
  return {
    testedPackageInput: fingerprintPackageInventory(inventory),
    workerBaseline: {
      relativePath: worker.relativePath,
      bytes: worker.bytes,
      sha256: worker.sha256,
    },
    buildEvidence: {
      worker,
      mermaid: discoverMermaidArtifacts(inventory),
      advisories: [],
      outputSha256: BUILD_OUTPUT_SHA,
    },
  };
}

function packageEdgeFixture(root, overrides = {}) {
  return packageExtension({
    root,
    target: 'edge',
    environment: {},
    packageVersion: VERSION,
    approvedVersion: VERSION,
    skipBuild: true,
    source: { commit: COMMIT, dirty: false },
    generatedAt: GENERATED_AT,
    ...releaseInputs(root),
    ...overrides,
  });
}

function expectCode(run, code) {
  assert.throws(run, (error) => error instanceof PackageExtensionError && error.code === code);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('normalizes the package target without changing Chrome and Firefox defaults', () => {
  assert.equal(resolvePackageTarget(undefined, undefined), 'chrome');
  assert.equal(resolvePackageTarget(undefined, 'firefox'), 'firefox');
  assert.equal(resolvePackageTarget('edge', 'edge'), 'edge');
  expectCode(() => resolvePackageTarget('edge', 'chrome'), 'package_target_mismatch');
  expectCode(() => resolvePackageTarget('EDGE'), 'package_target_invalid');
  expectCode(() => resolvePackageTarget('opera'), 'package_target_invalid');
  assert.equal(normalizeReleaseBrowserTarget('edge'), 'edge');
  assert.throws(
    () => finalCheckSpecsForTarget('edge'),
    (error) => error instanceof ReleaseEvidenceError && error.code === 'edge_final_release_gate_unsupported',
  );
  withFixture((root) => {
    expectCode(() => packageExtension({
      root,
      target: 'edge',
      environment: { GSM_STORE_TARGET: 'chrome' },
    }), 'package_store_target_mismatch');
  });
  withFixture((root) => {
    expectCode(() => packageExtension({ root, target: 'edge', distDir: 'dist', environment: {} }), 'edge_dist_directory_not_isolated');
    expectCode(() => packageExtension({ root, target: 'edge', artifactsDir: 'artifacts', environment: {} }), 'edge_artifact_directory_not_isolated');
  });

  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['build:edge'], 'node scripts/build-edge-extension.mjs');
  assert.equal(packageJson.scripts['package:edge'], 'node scripts/package-edge-extension.mjs');
  assert.equal(packageJson.scripts['check:edge-output'], 'node scripts/check-edge-output-contracts.mjs');
  assert.equal(packageJson.scripts['test:smoke:edge'], 'node tests/runtime/edge-full-product-smoke.mjs');
});

test('uses one full-product manifest across Edge, Chrome, and Firefox', () => {
  const manifest = createProductManifest();
  assert.deepEqual(manifest.permissions, ['storage', 'alarms']);
  assert.deepEqual(manifest.host_permissions, [...EDGE_REQUIRED_HOST_PERMISSIONS]);
  assert.deepEqual(manifest.optional_host_permissions, [...EDGE_OPTIONAL_HOST_PERMISSIONS]);
  assertEdgeManifestContract(manifest);
});

test('uses an exact Edge worker baseline with the full-product identity shape', () => {
  assert.deepEqual(EDGE_RELEASE_WORKER_BASELINE, {
    relativePath: 'assets/index.ts-Byps2g7n.js',
    bytes: 741_693,
    sha256: '7b8c0ec9b60e7ee8c78f2c935e35192d37c0b7a5a2b2e566d347ad1ac7b9e21b',
  });
  assert.deepEqual(Object.keys(EDGE_RELEASE_WORKER_BASELINE).sort(), ['bytes', 'relativePath', 'sha256']);
  const worker = {
    ...EDGE_RELEASE_WORKER_BASELINE,
    kib: EDGE_RELEASE_WORKER_BASELINE.bytes / 1024,
  };
  assert.deepEqual(enforceWorkerReleaseBaseline(worker, EDGE_RELEASE_WORKER_BASELINE), worker);
  for (const mismatched of [
    { ...worker, relativePath: 'assets/other-worker.js' },
    { ...worker, bytes: worker.bytes - 1, kib: (worker.bytes - 1) / 1024 },
    { ...worker, sha256: 'a'.repeat(64) },
  ]) {
    assert.throws(
      () => enforceWorkerReleaseBaseline(mismatched, EDGE_RELEASE_WORKER_BASELINE),
      (error) => error instanceof PackageClosureError && error.code === 'worker_identity_mismatch',
    );
  }
});

test('isolates the Edge build environment and invokes typecheck before Vite', () => {
  const environment = edgeBuildEnvironment({ KEEP: 'yes', GSM_STORE_TARGET: 'chrome' }, '/tmp/edge-dist');
  assert.deepEqual(environment, {
    KEEP: 'yes',
    GSM_STORE_TARGET: 'edge',
    GSM_PACKAGE_TARGET: 'edge',
    GSM_DEV: 'false',
    GSM_RELEASE: 'true',
    GSM_DIST_DIR: '/tmp/edge-dist',
  });
  assert.equal(Object.hasOwn(environment, 'GSM_BROWSER_TARGET'), false);

  const calls = [];
  const result = buildEdgeExtension({
    root: '/tmp/repository',
    environment: { npm_execpath: '/tmp/pnpm.cjs' },
    runner(input) { calls.push(input); },
  });
  assert.equal(result.edgeDistDir, '/tmp/repository/dist-edge');
  assert.deepEqual(calls.map(({ args }) => args), [
    ['exec', 'tsc', '--noEmit'],
    ['exec', 'vite', 'build'],
  ]);
  assert.equal(calls.every(({ environment: value }) => (
    value.GSM_STORE_TARGET === 'edge' && value.GSM_PACKAGE_TARGET === 'edge'
  )), true);
  assert.throws(
    () => buildEdgeExtension({ root: '/tmp/repository', edgeDistDir: 'dist', runner() {} }),
    /isolated from the Chrome dist/u,
  );
});

test('validates the full Edge output and exact Provider permissions', () => withFixture((root) => {
  const result = assertEdgeOutputContract({ root, expectedVersion: VERSION });
  assert.equal(result.distDir, path.join(root, 'dist-edge'));

  for (const overrides of [
    { optional_permissions: [] },
    { optional_host_permissions: [] },
    { optional_host_permissions: undefined },
    { host_permissions: ['https://api.github.com/*', 'https://github.com/*'] },
    { permissions: ['storage'] },
  ]) {
    assert.throws(
      () => assertEdgeManifestContract(edgeManifest(overrides), { expectedVersion: VERSION }),
      EdgeManifestContractError,
    );
  }
}));


test('packages Edge deterministically with full disclosure and independently labelled evidence', () => withFixture((root) => {
  const first = packageEdgeFixture(root);
  const second = packageEdgeFixture(root, { artifactsDir: 'artifacts/edge-copy' });
  assert.equal(first.zipPath, path.join(root, 'artifacts/edge', `better-github-stars-manager-edge-${VERSION}.zip`));
  assert.equal(path.basename(first.checksumPath), `better-github-stars-manager-edge-${VERSION}.zip.sha256`);
  assert.equal(path.basename(first.evidencePath), `release-evidence-${VERSION}.provisional.json`);
  assert.equal(statSync(first.zipPath).mode & 0o777, 0o600);
  assert.equal(hash(readFileSync(first.zipPath)), hash(readFileSync(second.zipPath)));
  assert.equal(
    readFileSync(first.checksumPath, 'utf8'),
    `${hash(readFileSync(first.zipPath))}  better-github-stars-manager-edge-${VERSION}.zip\n`,
  );

  const zipInventory = readZipInventory(first.zipPath);
  assert.equal(zipInventory.filter(({ relativePath }) => relativePath === 'manifest.json').length, 1);
  assert.deepEqual(first.evidence.capabilities, {
    gistSync: true,
    agent: true,
    organizeProvider: true,
  });
  assert.equal(first.evidence.schemaVersion, 4);
  assert.equal(first.evidence.browserTarget, 'edge');
  assert.equal(first.evidence.package.releaseReady, false);
  assert.equal(first.evidence.package.releaseReadinessReason, 'edge_runtime_verification_required');
  assert.equal(first.evidence.package.remoteExecutableCodeExcluded, true);
  assert.deepEqual(first.evidence.package.productionDisclosureMarkers, DISCLOSURE_MARKERS);
  assert.deepEqual(first.evidence.packagedPermissions, {
    permissions: ['alarms', 'storage'],
    optionalPermissions: [],
    hostPermissions: [...EDGE_REQUIRED_HOST_PERMISSIONS].sort(),
    optionalHostPermissions: [...EDGE_OPTIONAL_HOST_PERMISSIONS].sort(),
  });
  assert.equal(first.evidence.packagedManifest.browserTarget, 'edge');
  assert.equal(first.evidence.manifestResources.some(({ relativePath }) => relativePath === 'manifest.json'), false);
  assert.equal(first.evidence.manifestResources.some(({ relativePath }) => relativePath === 'assets/worker.js'), true);
  assert.deepEqual(first.evidence.generatedFiles.map(({ relativePath }) => relativePath), [
    `better-github-stars-manager-edge-${VERSION}.zip`,
    `better-github-stars-manager-edge-${VERSION}.zip.sha256`,
  ]);
}));

test('scans Edge packages for remote executable code before writing artifacts', () => withFixture((root) => {
  write(root, 'dist-edge/assets/worker.js', `${WORKER_SOURCE}import 'https://example.test/remote.js';\n`);
  expectCode(() => packageEdgeFixture(root), 'remote_executable_code_present');
}));

test('keeps the Edge package wrapper thin and target-forced', () => {
  const calls = [];
  const result = packageEdgeExtension({
    packageOptions: { skipBuild: true },
    extensionPackager(options) {
      calls.push(options);
      return { zipPath: '/tmp/edge.zip' };
    },
  });
  assert.deepEqual(calls, [{ skipBuild: true, target: 'edge' }]);
  assert.deepEqual(result, { zipPath: '/tmp/edge.zip' });
});
