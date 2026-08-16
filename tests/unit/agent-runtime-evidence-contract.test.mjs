import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  assertRuntimeReleaseDistIdentity,
  publishRuntimeEvidence,
  readRuntimeReleaseDistIdentity,
  RuntimeEvidenceError,
  serializeRuntimeEvidence,
  writeRuntimeEvidenceAtomic,
} from '../../scripts/agent-runtime-evidence-contract.mjs';
import { createFirefoxManifest, FIREFOX_GECKO_ID, FIREFOX_MIN_VERSION } from '../../scripts/build-firefox-extension.mjs';

function exactKeys(value, keys) {
  assert.deepEqual(Object.keys(value), keys);
}

function validateFixtureEvidence(value) {
  exactKeys(value, ['schemaVersion', 'status', 'proofScope', 'releaseDist', 'facts', 'evidenceBytes']);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.status, 'passed');
  assert.equal(value.proofScope, 'fixture_behavior');
  assertRuntimeReleaseDistIdentity(value.releaseDist);
  exactKeys(value.facts, ['proved', 'count']);
  assert.equal(value.facts.proved, true);
  assert.equal(Number.isSafeInteger(value.facts.count) && value.facts.count >= 0, true);
  assert.equal(Number.isSafeInteger(value.evidenceBytes) && value.evidenceBytes > 0, true);
}

function createReleaseFixture(root, version = '1.2.3') {
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    version,
    background: { service_worker: 'service-worker-loader.js', type: 'module' },
  }));
  writeFileSync(path.join(root, 'service-worker-loader.js'), "import './assets/worker.js';\n");
  writeFileSync(path.join(root, 'assets/worker.js'), 'globalThis.fixtureWorker = true;\n');
}

function createFirefoxReleaseFixture(root, version = '1.2.3') {
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  const manifest = createFirefoxManifest({
    manifest_version: 3,
    version,
    background: { service_worker: 'service-worker-loader.js', type: 'module' },
  });
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(root, 'service-worker-loader.js'), "import './assets/worker.js';\n");
  writeFileSync(path.join(root, 'assets/worker.js'), 'globalThis.fixtureWorker = true;\n');
}

test('binds evidence to the manifest loader, worker, and complete package input', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-evidence-identity-'));
  try {
    createReleaseFixture(root);
    const identity = readRuntimeReleaseDistIdentity(root);
    assertRuntimeReleaseDistIdentity(identity);
    exactKeys(identity, ['packageInput', 'manifest', 'loader', 'worker']);
    assert.equal(identity.packageInput.fileCount, 3);
    assert.equal(identity.manifest.relativePath, 'manifest.json');
    assert.equal(identity.manifest.manifestVersion, 3);
    assert.equal(identity.manifest.extensionVersion, '1.2.3');
    assert.equal(identity.loader.relativePath, 'service-worker-loader.js');
    assert.equal(identity.worker.relativePath, 'assets/worker.js');
    assert.notEqual(identity.loader.sha256, identity.worker.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('binds Firefox evidence to an event-page module and permanent Gecko identity', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-evidence-firefox-'));
  try {
    createFirefoxReleaseFixture(root);
    const identity = readRuntimeReleaseDistIdentity(root);
    assertRuntimeReleaseDistIdentity(identity);
    exactKeys(identity, ['browserTarget', 'packageInput', 'manifest', 'loader', 'worker', 'background', 'gecko']);
    assert.equal(identity.browserTarget, 'firefox');
    assert.deepEqual(identity.background, {
      kind: 'event_page',
      module: true,
      scripts: ['service-worker-loader.js'],
    });
    assert.equal(identity.gecko.id, FIREFOX_GECKO_ID);
    assert.equal(identity.gecko.strictMinVersion, FIREFOX_MIN_VERSION);

    const serviceWorkerClaim = { ...identity, background: { ...identity.background, kind: 'service_worker' } };
    assert.throws(
      () => assertRuntimeReleaseDistIdentity(serviceWorkerClaim),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'release_dist_background_invalid',
    );
    assert.throws(
      () => assertRuntimeReleaseDistIdentity({ ...identity, browserTarget: 'chrome' }),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'release_dist_target_invalid',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects normalized traversal and every manifest, loader, worker, or unrelated package symlink', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-evidence-paths-'));
  try {
    const traversalRoot = path.join(root, 'traversal');
    createReleaseFixture(traversalRoot);
    writeFileSync(
      path.join(traversalRoot, 'service-worker-loader.js'),
      "import './assets/../assets/worker.js';\n",
    );
    assert.throws(
      () => readRuntimeReleaseDistIdentity(traversalRoot),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'release_dist_identity_invalid',
    );

    const manifestSymlinkRoot = path.join(root, 'manifest-symlink');
    createReleaseFixture(manifestSymlinkRoot);
    const manifestSource = readFileSync(path.join(manifestSymlinkRoot, 'manifest.json'));
    rmSync(path.join(manifestSymlinkRoot, 'manifest.json'));
    writeFileSync(path.join(manifestSymlinkRoot, 'real-manifest.json'), manifestSource);
    symlinkSync('real-manifest.json', path.join(manifestSymlinkRoot, 'manifest.json'));
    assert.throws(
      () => readRuntimeReleaseDistIdentity(manifestSymlinkRoot),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'release_dist_identity_invalid',
    );

    const loaderSymlinkRoot = path.join(root, 'loader-symlink');
    createReleaseFixture(loaderSymlinkRoot);
    rmSync(path.join(loaderSymlinkRoot, 'service-worker-loader.js'));
    writeFileSync(path.join(loaderSymlinkRoot, 'real-loader.js'), "import './assets/worker.js';\n");
    symlinkSync('real-loader.js', path.join(loaderSymlinkRoot, 'service-worker-loader.js'));
    assert.throws(
      () => readRuntimeReleaseDistIdentity(loaderSymlinkRoot),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'release_dist_identity_invalid',
    );

    const workerSymlinkRoot = path.join(root, 'worker-symlink');
    createReleaseFixture(workerSymlinkRoot);
    rmSync(path.join(workerSymlinkRoot, 'assets/worker.js'));
    writeFileSync(path.join(workerSymlinkRoot, 'assets/real-worker.js'), 'globalThis.fixtureWorker = true;\n');
    symlinkSync('real-worker.js', path.join(workerSymlinkRoot, 'assets/worker.js'));
    assert.throws(
      () => readRuntimeReleaseDistIdentity(workerSymlinkRoot),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'release_dist_identity_invalid',
    );

    const unrelatedSymlinkRoot = path.join(root, 'unrelated-symlink');
    createReleaseFixture(unrelatedSymlinkRoot);
    writeFileSync(path.join(unrelatedSymlinkRoot, 'assets/real-extra.js'), 'globalThis.extra = true;\n');
    symlinkSync('real-extra.js', path.join(unrelatedSymlinkRoot, 'assets/extra.js'));
    assert.throws(
      () => readRuntimeReleaseDistIdentity(unrelatedSymlinkRoot),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'release_dist_identity_invalid',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts canonical Chrome versions and rejects permissive version lookalikes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-evidence-version-'));
  try {
    const validRoot = path.join(root, 'valid');
    createReleaseFixture(validRoot, '65535.0.1.2');
    const identity = readRuntimeReleaseDistIdentity(validRoot);
    assert.equal(identity.manifest.extensionVersion, '65535.0.1.2');
    assertRuntimeReleaseDistIdentity(identity);

    for (const [index, version] of ['1.02.3', '1.2.3-beta', '65536.1', '0.0'].entries()) {
      const invalidRoot = path.join(root, `invalid-${index}`);
      createReleaseFixture(invalidRoot, version);
      assert.throws(
        () => readRuntimeReleaseDistIdentity(invalidRoot),
        (error) => error instanceof RuntimeEvidenceError && error.code === 'release_dist_identity_invalid',
      );
    }
    assert.throws(
      () => assertRuntimeReleaseDistIdentity({
        ...identity,
        manifest: { ...identity.manifest, extensionVersion: '1.2.3-beta' },
      }),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'release_dist_identity_invalid',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes newline-inclusive bounded evidence atomically with private permissions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-evidence-write-'));
  try {
    const dist = path.join(root, 'dist');
    const evidenceDirectory = path.join(root, 'evidence');
    mkdirSync(dist);
    createReleaseFixture(dist);
    const evidence = {
      schemaVersion: 1,
      status: 'passed',
      proofScope: 'fixture_behavior',
      releaseDist: readRuntimeReleaseDistIdentity(dist),
      facts: { proved: true, count: 1 },
      evidenceBytes: 0,
    };
    const result = publishRuntimeEvidence({
      directory: evidenceDirectory,
      filename: 'fixture-behavior.schema.json',
      evidence,
      validateEvidence: validateFixtureEvidence,
      privateMarkers: ['private-fixture-marker'],
    });
    const destination = path.join(evidenceDirectory, 'fixture-behavior.schema.json');
    const serialized = readFileSync(destination, 'utf8');
    assert.equal(serialized.endsWith('\n'), true);
    assert.equal(Buffer.byteLength(serialized), evidence.evidenceBytes);
    assert.equal(result.bytes, evidence.evidenceBytes);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.equal(statSync(evidenceDirectory).mode & 0o777, 0o700);
    assert.deepEqual(
      readFileSync(destination, 'utf8'),
      serializeRuntimeEvidence(JSON.parse(serialized), {
        validateEvidence: validateFixtureEvidence,
        privateMarkers: ['private-fixture-marker'],
      }),
    );
    assert.deepEqual(readdirSync(evidenceDirectory), ['fixture-behavior.schema.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unknown schema keys, raw URLs, and caller-supplied private markers before writing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-evidence-private-'));
  try {
    const dist = path.join(root, 'dist');
    mkdirSync(dist);
    createReleaseFixture(dist);
    const base = {
      schemaVersion: 1,
      status: 'passed',
      proofScope: 'fixture_behavior',
      releaseDist: readRuntimeReleaseDistIdentity(dist),
      facts: { proved: true, count: 1 },
      evidenceBytes: 0,
    };
    assert.throws(
      () => serializeRuntimeEvidence({ ...base, unexpected: true }, { validateEvidence: validateFixtureEvidence }),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'schema_invalid',
    );
    assert.throws(
      () => serializeRuntimeEvidence({ ...base, facts: { proved: true, count: 1, location: 'https://private.invalid/path' } }, {
        validateEvidence(value) {
          exactKeys(value, ['schemaVersion', 'status', 'proofScope', 'releaseDist', 'facts', 'evidenceBytes']);
        },
      }),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'private_evidence_rejected',
    );
    assert.throws(
      () => serializeRuntimeEvidence({ ...base, facts: { proved: true, count: 1, error: 'raw failure detail' } }, {
        validateEvidence(value) {
          exactKeys(value, ['schemaVersion', 'status', 'proofScope', 'releaseDist', 'facts', 'evidenceBytes']);
        },
      }),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'private_evidence_rejected',
    );
    assert.throws(
      () => publishRuntimeEvidence({
        directory: path.join(root, 'evidence'),
        filename: 'fixture-behavior.schema.json',
        evidence: { ...base, facts: { proved: true, count: 1, label: 'private-fixture-marker' } },
        validateEvidence(value) {
          exactKeys(value, ['schemaVersion', 'status', 'proofScope', 'releaseDist', 'facts', 'evidenceBytes']);
        },
        privateMarkers: ['private-fixture-marker'],
      }),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'private_evidence_rejected',
    );
    assert.equal(existsSync(path.join(root, 'evidence')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects oversized evidence and removes a same-directory temporary file after rename failure', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-evidence-failure-'));
  try {
    const dist = path.join(root, 'dist');
    mkdirSync(dist);
    createReleaseFixture(dist);
    const oversized = {
      schemaVersion: 1,
      status: 'passed',
      proofScope: 'fixture_behavior',
      releaseDist: readRuntimeReleaseDistIdentity(dist),
      facts: { padding: Array.from({ length: 128 }, () => 'x'.repeat(300)) },
      evidenceBytes: 0,
    };
    assert.throws(
      () => serializeRuntimeEvidence(oversized, {
        validateEvidence(value) {
          exactKeys(value, ['schemaVersion', 'status', 'proofScope', 'releaseDist', 'facts', 'evidenceBytes']);
        },
      }),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'evidence_too_large',
    );

    const evidenceDirectory = path.join(root, 'evidence');
    const destinationDirectory = path.join(evidenceDirectory, 'fixture-behavior.schema.json');
    mkdirSync(destinationDirectory, { recursive: true });
    assert.throws(
      () => writeRuntimeEvidenceAtomic(evidenceDirectory, 'fixture-behavior.schema.json', '{}\n'),
      (error) => error instanceof RuntimeEvidenceError && error.code === 'atomic_write_failed',
    );
    assert.deepEqual(readdirSync(evidenceDirectory), ['fixture-behavior.schema.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
