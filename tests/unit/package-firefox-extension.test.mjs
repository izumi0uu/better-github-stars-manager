import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  FIREFOX_GECKO_ID,
  FIREFOX_MIN_VERSION,
  FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS,
  FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS,
} from '../../scripts/build-firefox-extension.mjs';
import { FirefoxManifestContractError } from '../../scripts/check-firefox-output-contracts.mjs';
import { createPackageInputInventory, fingerprintPackageInventory } from '../../scripts/package-input-fingerprint.mjs';
import { discoverMermaidArtifacts, measureBundleArtifact, validateManifestResourceClosure } from '../../scripts/package-manifest-closure.mjs';
import {
  assertRemoteExecutableCodeExcluded,
  packageExtension,
  PackageExtensionError,
  readZipInventory,
} from '../../scripts/package-extension.mjs';
import { verifyFirefoxArtifactChecksums } from '../../scripts/package-firefox-extension.mjs';
import {
  createFirefoxReviewerSourceInventory,
  FIREFOX_REVIEWER_README,
  FirefoxReviewerSourceError,
  packageFirefoxReviewerSource,
  validateFirefoxReviewerSourceArtifact,
} from '../../scripts/package-firefox-review-source.mjs';

const VERSION = '1.0.9';
const COMMIT = 'a'.repeat(40);
const GENERATED_AT = '2026-08-15T12:00:00.000Z';
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
const WORKER_SOURCE = `${DISCLOSURE_MARKERS.join(' ')}\nfetch('https://api.github.com/user');\n`;
const WORKER = measureBundleArtifact({ relativePath: 'assets/worker.js', bytes: Buffer.from(WORKER_SOURCE) });
const WORKER_BASELINE = Object.freeze({ relativePath: WORKER.relativePath, bytes: WORKER.bytes, sha256: WORKER.sha256 });
const TRACKED_BUILD_INPUTS = [
  '.gitignore',
  'manifest.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/deterministic-zip.mjs',
  'scripts/lint-firefox-extension.mjs',
  'store-assets/screenshots/token-guide-create-classic-pat.webp',
  'store-assets/screenshots/token-guide-generate-token.webp',
  'store-assets/screenshots/token-guide-select-scopes.webp',
  'src/index.ts',
  'vite.config.ts',
];

function withFixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'package-firefox-'));
  try {
    createSourceInputs(root);
    createFirefoxDist(root);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createSourceInputs(root) {
  write(root, '.gitignore', 'node_modules\ndist\nartifacts\n');
  write(root, 'package.json', JSON.stringify({ packageManager: 'pnpm@10.33.2' }));
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  write(root, 'pnpm-workspace.yaml', "packages: ['.']\n");
  write(root, 'manifest.config.ts', 'export default {};\n');
  write(root, 'vite.config.ts', 'export default {};\n');
  write(root, 'scripts/deterministic-zip.mjs', 'export const deterministicZip = true;\n');
  write(root, 'scripts/lint-firefox-extension.mjs', 'export const reviewedWarnings = 5;\n');
  write(root, 'store-assets/screenshots/token-guide-create-classic-pat.webp', Buffer.from([0, 1, 2]));
  write(root, 'store-assets/screenshots/token-guide-generate-token.webp', Buffer.from([0, 3, 4]));
  write(root, 'store-assets/screenshots/token-guide-select-scopes.webp', Buffer.from([0, 5, 6]));
  write(root, 'src/index.ts', 'export const extension = true;\n');
}

function createFirefoxDist(root) {
  const manifest = {
    manifest_version: 3,
    name: 'Firefox fixture',
    version: VERSION,
    permissions: ['storage', 'alarms'],
    host_permissions: [
      'https://api.github.com/*',
      'https://github.com/*',
    ],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    background: { scripts: ['service-worker-loader.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_GECKO_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        data_collection_permissions: {
          required: [...FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS],
          optional: [...FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS],
        },
      },
    },
    action: { default_popup: 'src/popup/index.html' },
    options_ui: { page: 'src/options/index.html', open_in_tab: true },
    content_scripts: [
      {
        matches: ['https://github.com/*'],
        js: ['assets/stars-page-loader.js'],
        run_at: 'document_idle',
      },
      {
        matches: ['https://github.com/*'],
        js: ['assets/repo-chip-loader.js'],
        run_at: 'document_idle',
      },
    ],
  };
  write(root, 'dist-firefox/manifest.json', `${JSON.stringify(manifest)}\n`);
  write(root, 'dist-firefox/service-worker-loader.js', "import './assets/worker.js';\n");
  write(root, 'dist-firefox/assets/worker.js', WORKER_SOURCE);
  write(root, 'dist-firefox/assets/mermaid-renderer.js', 'export const mermaid = true;\n');
  write(root, 'dist-firefox/assets/content.js', "fetch('https://api.github.com/user');\n");
  write(root, 'dist-firefox/assets/stars-page-loader.js', 'export const stars = true;\n');
  write(root, 'dist-firefox/assets/repo-chip-loader.js', 'export const repo = true;\n');
  write(root, 'dist-firefox/src/popup/index.html', '<main>popup</main>');
  write(root, 'dist-firefox/src/options/index.html', '<main>options</main>');
}

function releaseInputs(root) {
  const inventory = createPackageInputInventory(path.join(root, 'dist-firefox'));
  const manifest = JSON.parse(readFileSync(path.join(root, 'dist-firefox', 'manifest.json'), 'utf8'));
  const closure = validateManifestResourceClosure({ manifest, packageEntries: inventory });
  return {
    testedPackageInput: fingerprintPackageInventory(inventory),
    buildEvidence: {
      worker: measureBundleArtifact(inventory.find(({ relativePath }) => relativePath === closure.workerRelativePath)),
      mermaid: discoverMermaidArtifacts(inventory),
      advisories: [],
      outputSha256: BUILD_OUTPUT_SHA,
    },
  };
}

function packageFixture(root, artifactsDir, overrides = {}) {
  return packageExtension({
    root,
    target: 'firefox',
    artifactsDir,
    environment: {},
    packageVersion: VERSION,
    approvedVersion: VERSION,
    skipBuild: true,
    source: { commit: COMMIT, dirty: false },
    generatedAt: GENERATED_AT,
    workerBaseline: WORKER_BASELINE,
    reviewerSourceOptions: { trackedFiles: TRACKED_BUILD_INPUTS, verifyGitSource: false },
    ...releaseInputs(root),
    ...overrides,
  });
}

function write(root, relativePath, bytes) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

function exists(absolutePath) {
  try {
    statSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectPackageCode(run, code) {
  assert.throws(run, (error) => error instanceof PackageExtensionError && error.code === code);
}

test('packages deterministic Firefox target and reviewer-source artifact names and inventories', () => withFixture((root) => {
  const first = packageFixture(root, 'artifacts/firefox-a');
  const second = packageFixture(root, 'artifacts/firefox-b');
  assert.equal(path.basename(first.zipPath), `better-github-stars-manager-firefox-${VERSION}.zip`);
  assert.equal(path.basename(first.checksumPath), `better-github-stars-manager-firefox-${VERSION}.zip.sha256`);
  assert.equal(path.basename(first.reviewerSource.zipPath), `better-github-stars-manager-firefox-${VERSION}-source.zip`);
  assert.equal(path.basename(first.reviewerSource.checksumPath), `better-github-stars-manager-firefox-${VERSION}-source.zip.sha256`);
  assert.equal(hash(readFileSync(first.zipPath)), hash(readFileSync(second.zipPath)));
  assert.equal(hash(readFileSync(first.reviewerSource.zipPath)), hash(readFileSync(second.reviewerSource.zipPath)));
  assert.deepEqual(verifyFirefoxArtifactChecksums({
    root,
    artifactsDir: 'artifacts/firefox-a',
    packageVersion: VERSION,
  }), [
    {
      archive: `better-github-stars-manager-firefox-${VERSION}.zip`,
      bytes: readFileSync(first.zipPath).length,
      sha256: hash(readFileSync(first.zipPath)),
    },
    {
      archive: `better-github-stars-manager-firefox-${VERSION}-source.zip`,
      bytes: readFileSync(first.reviewerSource.zipPath).length,
      sha256: hash(readFileSync(first.reviewerSource.zipPath)),
    },
  ]);
  assert.deepEqual(
    readZipInventory(first.zipPath).map(({ relativePath }) => relativePath),
    createPackageInputInventory(path.join(root, 'dist-firefox')).map(({ relativePath }) => relativePath),
  );
  assert.equal(first.evidence.schemaVersion, 3);
  assert.equal(first.evidence.browserTarget, 'firefox');
  assert.deepEqual(first.evidence.packagedManifest.background, {
    kind: 'event_page',
    module: true,
    scripts: ['service-worker-loader.js'],
  });
  assert.equal(first.evidence.package.remoteExecutableCodeExcluded, true);
  assert.deepEqual(first.evidence.generatedFiles.map(({ relativePath }) => relativePath), [
    `better-github-stars-manager-firefox-${VERSION}-source.zip`,
    `better-github-stars-manager-firefox-${VERSION}-source.zip.sha256`,
    `better-github-stars-manager-firefox-${VERSION}.zip`,
    `better-github-stars-manager-firefox-${VERSION}.zip.sha256`,
  ]);
}));

test('rejects a malformed Firefox background before creating artifacts', () => withFixture((root) => {
  const manifestPath = path.join(root, 'dist-firefox/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.background = { service_worker: 'service-worker-loader.js', type: 'module' };
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

  assert.throws(
    () => packageFixture(root, 'artifacts/firefox-invalid-background'),
    (error) => error instanceof FirefoxManifestContractError
      && error.code === 'background_keys_invalid',
  );
  assert.equal(exists(path.join(root, 'artifacts/firefox-invalid-background')), false);
}));

test('uses the Firefox environment target and passes it to a fresh production build', () => withFixture((root) => {
  let observedTarget = null;
  const result = packageFixture(root, 'artifacts/firefox', {
    target: undefined,
    environment: { GSM_PACKAGE_TARGET: 'firefox' },
    skipBuild: false,
    testedPackageInput: undefined,
    buildEvidence: undefined,
    buildRunner(target) {
      observedTarget = target;
      return { advisories: [], outputSha256: BUILD_OUTPUT_SHA };
    },
  });
  assert.equal(observedTarget, 'firefox');
  assert.equal(path.basename(result.zipPath), `better-github-stars-manager-firefox-${VERSION}.zip`);
  expectPackageCode(() => packageExtension({ target: 'safari', environment: {} }), 'package_target_invalid');
}));

test('rejects remote executable code without rejecting remote data fetches', () => {
  assert.deepEqual(assertRemoteExecutableCodeExcluded([{
    relativePath: 'assets/data.js',
    bytes: Buffer.from("export async function load() { return fetch('https://api.github.com/user'); }"),
  }]), {
    remoteExecutableCodeExcluded: true,
    scannedEntries: ['assets/data.js'],
  });
  expectPackageCode(() => assertRemoteExecutableCodeExcluded([{
    relativePath: 'assets/blob-module.js',
    bytes: Buffer.from("import('blob:https://github.com/runtime-module');"),
  }]), 'remote_executable_code_present');
  withFixture((root) => {
    write(root, 'dist-firefox/assets/content.js', "import('https://cdn.example.test/runtime.js');\n");
    expectPackageCode(() => packageFixture(root, 'artifacts/firefox'), 'remote_executable_code_present');
    assert.equal(exists(path.join(root, 'artifacts/firefox')), false);
  });
});

test('reviewer source contains only tracked build inputs plus generated instructions', () => withFixture((root) => {
  for (const [relativePath, bytes] of [
    ['.trellis/tasks/private.md', 'external work item'],
    ['artifacts/account.json', '{"token":"secret"}'],
    ['dist-firefox/assets/output.js', 'output'],
    ['docs/en/reviewer-notes.md', '/Users/reviewer/private'],
    ['tests/unit/private-fixture.test.ts', 'secret'],
  ]) write(root, relativePath, bytes);
  const trackedFiles = [...TRACKED_BUILD_INPUTS,
    '.trellis/tasks/private.md',
    'artifacts/account.json',
    'dist-firefox/assets/output.js',
    'docs/en/reviewer-notes.md',
    'tests/unit/private-fixture.test.ts',
  ];
  const inventory = createFirefoxReviewerSourceInventory({ root, packageVersion: VERSION, trackedFiles });
  assert.deepEqual(inventory.map(({ relativePath }) => relativePath), [
    '.gitignore',
    FIREFOX_REVIEWER_README,
    'manifest.config.ts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/deterministic-zip.mjs',
    'scripts/lint-firefox-extension.mjs',
    'src/index.ts',
    'store-assets/screenshots/token-guide-create-classic-pat.webp',
    'store-assets/screenshots/token-guide-generate-token.webp',
    'store-assets/screenshots/token-guide-select-scopes.webp',
    'vite.config.ts',
  ]);
  const readme = inventory.find(({ relativePath }) => relativePath === FIREFOX_REVIEWER_README).bytes.toString('utf8');
  assert.match(readme, /corepack prepare pnpm@10\.33\.2 --activate/u);
  assert.match(readme, /pnpm install --frozen-lockfile/u);
  assert.match(readme, /GSM_APPROVED_RELEASE_VERSION=1\.0\.9 pnpm package:firefox/u);
  assert.match(readme, /pnpm lint:firefox/u);
  assert.match(readme, /node scripts\/package-firefox-extension\.mjs --verify-checksums/u);
  const result = packageFirefoxReviewerSource({
    root,
    artifactsDir: 'artifacts/source-only',
    packageVersion: VERSION,
    source: { commit: COMMIT, dirty: false },
    trackedFiles,
    verifyGitSource: false,
  });
  assert.equal(readFileSync(result.checksumPath, 'utf8'), `${hash(readFileSync(result.zipPath))}  ${path.basename(result.zipPath)}\n`);
  assert.deepEqual(validateFirefoxReviewerSourceArtifact({
    zipPath: result.zipPath,
    checksumPath: result.checksumPath,
    evidence: {
      archive: result.archive,
      checksum: result.checksum,
      readme: result.readme,
      packageInput: result.packageInput,
    },
  }), {
    archive: result.archive,
    checksum: result.checksum,
    readme: result.readme,
    packageInput: result.packageInput,
  });
  assert.equal(result.readme.relativePath, FIREFOX_REVIEWER_README);

  write(root, 'src/personal/account.ts', "export const token = 'github_pat_abcdefghijklmnopqrstuvwxyz';\n");
  assert.throws(
    () => createFirefoxReviewerSourceInventory({
      root,
      packageVersion: VERSION,
      trackedFiles: [...TRACKED_BUILD_INPUTS, 'src/personal/account.ts'],
    }),
    (error) => error instanceof FirefoxReviewerSourceError && error.code === 'reviewer_source_private_input',
  );
}));

test('removes extension and reviewer-source artifacts when Firefox evidence fails', () => withFixture((root) => {
  assert.throws(() => packageFixture(root, 'artifacts/firefox', { generatedAt: 'not-an-iso-timestamp' }));
  for (const basename of [
    `better-github-stars-manager-firefox-${VERSION}.zip`,
    `better-github-stars-manager-firefox-${VERSION}.zip.sha256`,
    `better-github-stars-manager-firefox-${VERSION}-source.zip`,
    `better-github-stars-manager-firefox-${VERSION}-source.zip.sha256`,
    `release-evidence-${VERSION}.provisional.json`,
  ]) assert.equal(exists(path.join(root, 'artifacts/firefox', basename)), false);
}));
