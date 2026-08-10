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
import {
  createPackageInputInventory,
  fingerprintPackageInventory,
} from '../../scripts/package-input-fingerprint.mjs';
import {
  discoverMermaidArtifacts,
  measureBundleArtifact,
  validateManifestResourceClosure,
} from '../../scripts/package-manifest-closure.mjs';
import {
  packageExtension,
  PackageExtensionError,
  readZipInventory,
  validateZipEntryNames,
} from '../../scripts/package-extension.mjs';
import { validateProvisionalReleaseEvidence } from '../../scripts/agent-runtime-release-evidence.mjs';
const VITE_ADVISORY = [
  'dist/assets/worker.js  530.00 kB │ gzip: 100.00 kB',
  '(!) Some chunks are larger than 500 kB after minification. Consider:',
  '- Using dynamic import() to code-split the application',
  '- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks',
  '- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.',
].join('\n');

const VERSION = '1.0.9';
const COMMIT = 'a'.repeat(40);
const BUILD_OUTPUT_SHA = 'b'.repeat(64);
const GENERATED_AT = '2026-08-09T12:00:00.000Z';
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
const FIXTURE_WORKER_SOURCE = `const disclosure = ${JSON.stringify(DISCLOSURE_MARKERS)};\n`;
const measuredFixtureWorker = measureBundleArtifact({
  relativePath: 'assets/worker.js',
  bytes: Buffer.from(FIXTURE_WORKER_SOURCE),
});
const FIXTURE_WORKER_BASELINE = Object.freeze({
  relativePath: measuredFixtureWorker.relativePath,
  bytes: measuredFixtureWorker.bytes,
  sha256: measuredFixtureWorker.sha256,
});

function withFixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'package-extension-'));
  try {
    createDist(root);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withTimezone(timezone, run) {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function createDist(root, manifestOverrides = {}) {
  const dist = path.join(root, 'dist');
  const manifest = {
    manifest_version: 3,
    name: 'Fixture extension',
    version: VERSION,
    permissions: ['storage', 'alarms'],
    host_permissions: [
      'https://api.github.com/*',
      'https://api.openai.com/*',
      'https://api.anthropic.com/*',
      'https://github.com/*',
      'https://openrouter.ai/*',
    ],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    background: { service_worker: 'service-worker-loader.js', type: 'module' },
    icons: { 16: 'icons/icon.png' },
    action: { default_popup: 'popup.html', default_icon: { 16: 'icons/icon.png' } },
    options_ui: { page: 'options.html', open_in_tab: true },
    content_scripts: [{
      matches: ['https://github.com/*'],
      js: ['assets/content.js'],
      css: ['assets/content.css'],
    }],
    web_accessible_resources: [{
      resources: ['assets/public.svg'],
      matches: ['https://github.com/*'],
    }],
    storage: { managed_schema: 'schema/policy.json' },
    declarative_net_request: { rule_resources: [{ id: 'fixture', enabled: true, path: 'rules/rules.json' }] },
    ...manifestOverrides,
  };
  write(root, 'dist/manifest.json', `${JSON.stringify(manifest)}\n`);
  write(root, 'dist/service-worker-loader.js', "import './assets/worker.js';\n");
  write(root, 'dist/assets/worker.js', FIXTURE_WORKER_SOURCE);
  write(root, 'dist/assets/mermaid-renderer.js', 'export const mermaid = true;\n');
  write(root, 'dist/assets/content.js', 'content');
  write(root, 'dist/assets/content.css', 'styles');
  write(root, 'dist/assets/public.svg', '<svg/>');
  write(root, 'dist/icons/icon.png', 'icon');
  write(root, 'dist/popup.html', 'popup');
  write(root, 'dist/options.html', 'options');
  write(root, 'dist/schema/policy.json', '{}');
  write(root, 'dist/rules/rules.json', '[]');
  return { dist, manifest };
}

function write(root, relativePath, bytes) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

function releaseInputs(root) {
  const inventory = createPackageInputInventory(path.join(root, 'dist'));
  const manifest = JSON.parse(readFileSync(path.join(root, 'dist', 'manifest.json'), 'utf8'));
  const closure = validateManifestResourceClosure({ manifest, packageEntries: inventory });
  const workerEntry = inventory.find(({ relativePath }) => relativePath === closure.workerRelativePath);
  return {
    testedPackageInput: fingerprintPackageInventory(inventory),
    buildEvidence: {
      worker: measureBundleArtifact(workerEntry),
      mermaid: discoverMermaidArtifacts(inventory),
      advisories: [VITE_ADVISORY],
      outputSha256: BUILD_OUTPUT_SHA,
    },
  };
}

function packageFixture(root, artifactsDir, overrides = {}) {
  const inputs = releaseInputs(root);
  return packageExtension({
    root,
    distDir: 'dist',
    artifactsDir,
    environment: {},
    packageVersion: VERSION,
    approvedVersion: VERSION,
    skipBuild: true,
    source: { commit: COMMIT, dirty: false },
    generatedAt: GENERATED_AT,
    workerBaseline: FIXTURE_WORKER_BASELINE,
    ...inputs,
    ...overrides,
  });
}

function expectCode(run, code) {
  assert.throws(run, (error) => error instanceof PackageExtensionError && error.code === code);
}

test('packages one deterministic inventory into staged files, ZIP, checksum, and immutable schema-v2 evidence', () => withFixture((root) => {
  const first = withTimezone('Pacific/Honolulu', () => packageFixture(root, 'artifacts-a'));
  const second = withTimezone('Asia/Kathmandu', () => packageFixture(root, 'artifacts-b'));
  assert.equal(hash(readFileSync(first.zipPath)), hash(readFileSync(second.zipPath)));
  assert.deepEqual(readFileSync(first.checksumPath), readFileSync(second.checksumPath));
  assert.deepEqual(readFileSync(first.evidencePath), readFileSync(second.evidencePath));
  const outputPaths = [first.zipPath, first.checksumPath, first.evidencePath];
  assert.deepEqual(outputPaths.map((filePath) => path.basename(filePath)), [
    `better-github-stars-manager-${VERSION}.zip`,
    `better-github-stars-manager-${VERSION}.zip.sha256`,
    `release-evidence-${VERSION}.provisional.json`,
  ]);
  for (const outputPath of outputPaths) assert.equal(statSync(outputPath).mode & 0o777, 0o600);

  const zipInventory = readZipInventory(first.zipPath);
  const expectedInventory = createPackageInputInventory(path.join(root, 'dist'));
  assert.deepEqual(
    zipInventory.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes: bytes.byteLength, sha256 })),
    expectedInventory.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes: bytes.byteLength, sha256 })),
  );
  assert.equal(zipInventory[0].relativePath, 'assets/content.css');
  assert.equal(zipInventory.some(({ relativePath }) => relativePath === 'manifest.json'), true);
  const checksum = readFileSync(first.checksumPath, 'utf8');
  assert.equal(checksum, `${hash(readFileSync(first.zipPath))}  better-github-stars-manager-${VERSION}.zip\n`);

  const evidenceBytes = readFileSync(first.evidencePath);
  const evidence = JSON.parse(evidenceBytes);
  validateProvisionalReleaseEvidence(evidence, {
    sourceCommit: COMMIT,
    packageVersion: VERSION,
    packageInput: first.packageInput,
    build: first.build,
    workerBaseline: FIXTURE_WORKER_BASELINE,
    packagedManifestVersion: VERSION,
    zipManifestVersion: VERSION,
  });
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.package.releaseReady, false);
  assert.equal(evidence.package.dashboardSubmissionClaimed, false);
  assert.deepEqual(evidence.packagedPermissions.optionalPermissions, []);
  assert.equal(evidence.build.worker.sha256, hash(Buffer.from(`const disclosure = ${JSON.stringify(DISCLOSURE_MARKERS)};\n`)));
  assert.deepEqual(evidence.build.mermaid.map(({ relativePath }) => relativePath), ['assets/mermaid-renderer.js']);
  assert.deepEqual(evidence.build.advisories, [VITE_ADVISORY]);
  assert.equal(evidence.manifestResources.some(({ relativePath, referencedBy }) => (
    relativePath === 'rules/rules.json'
    && referencedBy.includes('declarative_net_request.rule_resources[0].path')
  )), true);
  assert.equal(evidence.manifestResources.some(({ relativePath, referencedBy }) => (
    relativePath === 'schema/policy.json' && referencedBy.includes('storage.managed_schema')
  )), true);
  assert.equal(evidence.generatedFiles.every(({ bytes, sha256 }) => bytes > 0 && /^[0-9a-f]{64}$/u.test(sha256)), true);
  const packagedManifest = zipInventory.find(({ relativePath }) => relativePath === 'manifest.json');
  assert.deepEqual(evidence.packagedManifest, {
    relativePath: 'manifest.json',
    bytes: packagedManifest.bytes.byteLength,
    sha256: packagedManifest.sha256,
  });
  assert.deepEqual(evidence.generatedFiles.map(({ relativePath }) => relativePath), [
    `better-github-stars-manager-${VERSION}.zip`,
    `better-github-stars-manager-${VERSION}.zip.sha256`,
  ]);
  assert.equal(exists(path.join(root, 'artifacts-a', `release-evidence-${VERSION}.json`)), false);
  assert.equal(exists(path.join(root, 'artifacts-a', 'agent-release-gate-evidence.json')), false);
}));
test('omits public-copied dotenv credential key and certificate files from the staged ZIP', () => withFixture((root) => {
  const forbiddenPublicCopies = [
    '.env',
    '.env.production',
    'secret.env',
    'credentials.pem',
    'credentials.production.yaml',
    'keys/provider.json',
    'certificates/provider.yaml',
    'public/signing.key',
    'public/client.cert',
    'public/client.crt',
    'public/client.cer',
    'public/client.p12',
    'public/client.pfx',
  ];
  for (const relativePath of forbiddenPublicCopies) write(root, `dist/${relativePath}`, 'private');
  write(root, 'dist/assets/dev-signing-key-helper.js', 'kept');

  const result = packageFixture(root, 'artifacts');
  const zipPaths = new Set(readZipInventory(result.zipPath).map(({ relativePath }) => relativePath));
  for (const relativePath of forbiddenPublicCopies) assert.equal(zipPaths.has(relativePath), false);
  assert.equal(zipPaths.has('assets/dev-signing-key-helper.js'), true);
}));

test('accepts skip-build only with exact runner JSON bindings', () => withFixture((root) => {
  const inputs = releaseInputs(root);
  const result = packageExtension({
    root,
    artifactsDir: 'artifacts',
    packageVersion: VERSION,
    approvedVersion: VERSION,
    source: { commit: COMMIT, dirty: false },
    generatedAt: GENERATED_AT,
    workerBaseline: FIXTURE_WORKER_BASELINE,
    environment: {
      GSM_SKIP_PACKAGE_BUILD: 'true',
      GSM_TESTED_PACKAGE_INPUT: JSON.stringify({
        sha256: inputs.testedPackageInput.sha256,
        algorithm: inputs.testedPackageInput.algorithm,
        fileCount: inputs.testedPackageInput.fileCount,
      }),
      GSM_RELEASE_BUILD_EVIDENCE: JSON.stringify(inputs.buildEvidence),
    },
  });
  assert.deepEqual(result.packageInput, inputs.testedPackageInput);

  expectCode(() => packageExtension({
    root,
    artifactsDir: 'unused',
    packageVersion: VERSION,
    approvedVersion: VERSION,
    source: { commit: COMMIT, dirty: false },
    environment: { GSM_SKIP_PACKAGE_BUILD: 'TRUE' },
  }), 'skip_build_invalid');
}));

test('rejects dirty source before invoking a production build', () => withFixture((root) => {
  let buildCalled = false;
  expectCode(() => packageExtension({
    root,
    artifactsDir: 'artifacts',
    environment: {},
    packageVersion: VERSION,
    approvedVersion: VERSION,
    skipBuild: false,
    source: { commit: COMMIT, dirty: true },
    buildRunner: () => {
      buildCalled = true;
      return { advisories: [VITE_ADVISORY], outputSha256: BUILD_OUTPUT_SHA };
    },
  }), 'clean_source_required');
  assert.equal(buildCalled, false);
  assert.equal(exists(path.join(root, 'artifacts')), false);
}));
test('fresh builds bind captured output and reject ambient stale evidence before packaging', () => {
  withFixture((root) => {
    const capturedOutputSha256 = 'c'.repeat(64);
    const result = packageExtension({
      root,
      artifactsDir: 'artifacts',
      environment: {},
      packageVersion: VERSION,
      approvedVersion: VERSION,
      skipBuild: false,
      source: { commit: COMMIT, dirty: false },
      generatedAt: GENERATED_AT,
      workerBaseline: FIXTURE_WORKER_BASELINE,
      buildRunner: () => ({
        advisories: [VITE_ADVISORY],
        outputSha256: capturedOutputSha256,
      }),
    });
    assert.equal(result.build.outputSha256, capturedOutputSha256);
    assert.equal(JSON.parse(readFileSync(result.evidencePath, 'utf8')).build.outputSha256, capturedOutputSha256);
  });

  withFixture((root) => {
    const stale = releaseInputs(root);
    let buildCalled = false;
    expectCode(() => packageExtension({
      root,
      artifactsDir: 'artifacts',
      environment: {
        GSM_RELEASE_BUILD_EVIDENCE: JSON.stringify({
          ...stale.buildEvidence,
          outputSha256: 'd'.repeat(64),
        }),
      },
      packageVersion: VERSION,
      approvedVersion: VERSION,
      skipBuild: false,
      source: { commit: COMMIT, dirty: false },
      buildRunner: () => {
        buildCalled = true;
        return { advisories: [VITE_ADVISORY], outputSha256: 'c'.repeat(64) };
      },
    }), 'fresh_build_external_evidence_forbidden');
    assert.equal(buildCalled, false);
    assert.equal(exists(path.join(root, 'artifacts', `release-evidence-${VERSION}.provisional.json`)), false);
  });
});


test('rejects stale tested inputs and bundle evidence without leaving partial outputs', () => withFixture((root) => {
  const stale = releaseInputs(root);
  write(root, 'dist/assets/extra.js', 'extra');
  const sentinel = path.join(root, 'artifacts', 'unrelated-user-artifact.txt');
  mkdirSync(path.dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, 'keep');
  expectCode(() => packageFixture(root, 'artifacts', {
    testedPackageInput: stale.testedPackageInput,
    buildEvidence: stale.buildEvidence,
  }), 'tested_package_input_stale');
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(exists(path.join(root, 'artifacts', `better-github-stars-manager-${VERSION}.zip`)), false);

  const fresh = releaseInputs(root);
  expectCode(() => packageFixture(root, 'artifacts', {
    ...fresh,
    buildEvidence: { ...fresh.buildEvidence, outputSha256: 'short' },
  }), 'release_build_output_hash_invalid');
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(exists(path.join(root, 'artifacts', `better-github-stars-manager-${VERSION}.zip`)), false);
}));

test('removes owned outputs and preserves unrelated artifacts after provisional validation fails', () => withFixture((root) => {
  const sentinel = path.join(root, 'artifacts', 'manual-note.txt');
  write(root, 'artifacts/manual-note.txt', 'keep');
  assert.throws(
    () => packageFixture(root, 'artifacts', { generatedAt: 'not-an-iso-timestamp' }),
    (error) => error?.code === 'schema_invalid' && error?.jsonPath === '$.generatedAt',
  );
  for (const basename of [
    `better-github-stars-manager-${VERSION}.zip`,
    `better-github-stars-manager-${VERSION}.zip.sha256`,
    `release-evidence-${VERSION}.provisional.json`,
  ]) assert.equal(exists(path.join(root, 'artifacts', basename)), false);
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
}));

test('never overwrites immutable, stale-trust, or unrelated artifacts', () => {
  withFixture((root) => {
    const result = packageFixture(root, 'artifacts');
    const evidenceBefore = readFileSync(result.evidencePath);
    write(root, 'artifacts/manual-note.txt', 'keep');
    expectCode(() => packageFixture(root, 'artifacts'), 'package_artifact_exists');
    assert.deepEqual(readFileSync(result.evidencePath), evidenceBefore);
    assert.equal(readFileSync(path.join(root, 'artifacts', 'manual-note.txt'), 'utf8'), 'keep');
  });
  for (const basename of [
    `better-github-stars-manager-${VERSION}.zip`,
    `better-github-stars-manager-${VERSION}.zip.sha256`,
    `release-evidence-${VERSION}.provisional.json`,
  ]) {
    withFixture((root) => {
      write(root, `artifacts/${basename}`, 'stale-target');
      write(root, 'artifacts/manual-note.txt', 'keep');
      expectCode(() => packageFixture(root, 'artifacts'), 'package_artifact_exists');
      assert.equal(readFileSync(path.join(root, 'artifacts', basename), 'utf8'), 'stale-target');
      assert.equal(readFileSync(path.join(root, 'artifacts/manual-note.txt'), 'utf8'), 'keep');
    });
  }
  for (const basename of [`release-evidence-${VERSION}.json`, 'agent-release-gate-evidence.json']) {
    withFixture((root) => {
      write(root, `artifacts/${basename}`, 'stale-trust');
      write(root, 'artifacts/manual-note.txt', 'keep');
      expectCode(() => packageFixture(root, 'artifacts'), 'stale_release_artifact_present');
      assert.equal(readFileSync(path.join(root, 'artifacts', basename), 'utf8'), 'stale-trust');
      assert.equal(readFileSync(path.join(root, 'artifacts/manual-note.txt'), 'utf8'), 'keep');
    });
  }
});

test('rejects ZIP traversal, absolute, directory, filespec, option-like, and duplicate entries', () => {
  expectCode(() => validateZipEntryNames(['manifest.json', '../escape.js']), 'zip_entry_path_invalid');
  expectCode(() => validateZipEntryNames(['manifest.json', '/escape.js']), 'zip_entry_path_invalid');
  expectCode(() => validateZipEntryNames(['manifest.json', 'assets/']), 'zip_entry_path_invalid');
  expectCode(() => validateZipEntryNames(['manifest.json', 'assets/line\nbreak.js']), 'zip_entry_path_invalid');
  expectCode(() => validateZipEntryNames(['manifest.json', '-metadata.json']), 'zip_entry_path_invalid');
  expectCode(() => validateZipEntryNames(['manifest.json', 'assets/*.js']), 'zip_entry_path_invalid');
  expectCode(() => validateZipEntryNames(['manifest.json', 'assets/file?.js']), 'zip_entry_path_invalid');
  expectCode(() => validateZipEntryNames(['manifest.json', 'assets/file[0].js']), 'zip_entry_path_invalid');
  expectCode(() => validateZipEntryNames(['manifest.json', 'manifest.json']), 'zip_entry_duplicate');
  expectCode(() => validateZipEntryNames(['assets/app.js']), 'zip_root_manifest_missing');
});

test('rejects unreviewed permissions, missing literal resources, development hashes, and unapproved versions', () => {
  withFixture((root) => {
    createDist(root, { permissions: ['storage'] });
    expectCode(() => packageFixture(root, 'artifacts'), 'packaged_permissions_unreviewed');
  });
  withFixture((root) => {
    rmSync(path.join(root, 'dist', 'schema', 'policy.json'));
    assert.throws(() => packageFixture(root, 'artifacts'), /manifest_resource_missing/u);
    assert.equal(exists(path.join(root, 'artifacts', `better-github-stars-manager-${VERSION}.zip`)), false);
  });
  withFixture((root) => {
    rmSync(path.join(root, 'dist', 'rules', 'rules.json'));
    assert.throws(() => packageFixture(root, 'artifacts'), /manifest_resource_missing/u);
    assert.equal(exists(path.join(root, 'artifacts', `better-github-stars-manager-${VERSION}.zip`)), false);
  });
  withFixture((root) => {
    write(root, 'dist/assets/worker.js', `${DISCLOSURE_MARKERS.join(' ')} 01234567-clean-abcdef`);
    expectCode(() => packageFixture(root, 'artifacts'), 'development_build_hash_present');
  });
  withFixture((root) => {
    const disclosure = Buffer.from(DISCLOSURE_MARKERS.join(' '));
    const oversized = Buffer.concat([
      disclosure,
      Buffer.alloc(FIXTURE_WORKER_BASELINE.bytes + 1 - disclosure.byteLength, 0x61),
    ]);
    write(root, 'dist/assets/worker.js', oversized);
    assert.throws(
      () => packageFixture(root, 'artifacts'),
      (error) => error?.code === 'worker_byte_ceiling_exceeded',
    );
    assert.equal(exists(path.join(root, 'artifacts', `better-github-stars-manager-${VERSION}.zip`)), false);
  });
  withFixture((root) => {
    let buildCalled = false;
    expectCode(() => packageExtension({
      root,
      packageVersion: '1.0.8',
      approvedVersion: '1.0.8',
      buildRunner() { buildCalled = true; },
    }), 'approved_candidate_version_not_newer');
    assert.equal(buildCalled, false);
  });
});

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exists(absolutePath) {
  try {
    statSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}
