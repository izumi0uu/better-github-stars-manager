import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  createPackageInputInventory,
  fingerprintPackageEntries,
  fingerprintPackageInventory,
  packageInputFingerprint,
  PackageInputError,
  samePackageInputFingerprint,
  validatePackageInputFingerprint,
} from '../../scripts/package-input-fingerprint.mjs';

function withFixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'package-input-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function write(root, relativePath, bytes) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

function expectCode(run, code) {
  assert.throws(run, (error) => error instanceof PackageInputError && error.code === code);
}

function entry(relativePath, bytes) {
  const content = Buffer.from(bytes);
  return {
    relativePath,
    bytes: content,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

test('builds one filtered inventory in deterministic bytewise POSIX order', () => withFixture((root) => {
  write(root, 'z-last.js', 'z');
  write(root, 'assets/dev-runtime.js', 'kept');
  write(root, 'A-first.js', 'A');
  write(root, 'a-middle.js', 'a');
  write(root, '.omp/session.json', 'excluded');
  write(root, '.trellis/task.json', 'excluded');
  write(root, '.git/local-state', 'excluded');
  write(root, '.DS_Store', 'excluded');
  write(root, '.workspace/runtime.json', 'excluded');
  write(root, 'assets/.cache/chunk.json', 'excluded');
  write(root, 'docs/release.txt', 'excluded');
  write(root, 'store-assets/promo.png', 'excluded');
  write(root, 'poster/source.svg', 'excluded');
  write(root, 'assets/application.js.map', 'excluded');
  write(root, 'src/dev-agent/index.html', 'excluded');
  write(root, 'assets/diagnostics/report.json', 'excluded');
  write(root, 'captures/credentials.json', 'excluded');
  write(root, 'captures/raw-capture.json', 'excluded');
  write(root, 'local-state/session.json', 'excluded');
  write(root, '.env', 'excluded');
  write(root, 'config/production.env', 'excluded');
  write(root, 'credentials.pem', 'excluded');
  write(root, 'certs/secret.key', 'excluded');
  write(root, 'certs/secrets.cert', 'excluded');
  write(root, 'secrets/provider.pem', 'excluded');
  write(root, 'credentials/custom.yaml', 'excluded');
  write(root, 'secret.env', 'excluded');
  write(root, 'credentials.production.yaml', 'excluded');
  write(root, 'keys/provider.json', 'excluded');
  write(root, 'certificates/provider.yaml', 'excluded');
  write(root, 'public/signing.key', 'excluded');
  write(root, 'public/client.cert', 'excluded');

  const inventory = createPackageInputInventory(root);
  assert.deepEqual(inventory.map(({ relativePath }) => relativePath), [
    'A-first.js',
    'a-middle.js',
    'assets/dev-runtime.js',
    'z-last.js',
  ]);
  assert.equal(inventory.every(({ bytes }) => Buffer.isBuffer(bytes)), true);
  assert.deepEqual(packageInputFingerprint(root), fingerprintPackageInventory(inventory));
}));

test('fingerprint binds canonical paths and exact bytes', () => withFixture((root) => {
  write(root, 'manifest.json', '{"version":"1.0.9"}');
  write(root, 'assets/worker.js', 'worker-a');
  const first = packageInputFingerprint(root);
  const repeated = packageInputFingerprint(root);
  assert.deepEqual(repeated, first);

  write(root, 'assets/worker.js', 'worker-b');
  assert.notEqual(packageInputFingerprint(root).sha256, first.sha256);
  write(root, 'assets/worker.js', 'worker-a');
  write(root, 'assets/extra.js', 'extra');
  assert.notEqual(packageInputFingerprint(root).sha256, first.sha256);
}));

test('entry fingerprinting canonicalizes order and validates exact fingerprint shapes', () => {
  const first = fingerprintPackageEntries([
    { relativePath: 'z.js', bytes: Buffer.from('z') },
    { relativePath: 'a.js', bytes: Buffer.from('a') },
  ]);
  const second = fingerprintPackageEntries([entry('a.js', 'a'), entry('z.js', 'z')]);
  assert.deepEqual(first, second);
  assert.deepEqual(validatePackageInputFingerprint(first), first);
  assert.equal(samePackageInputFingerprint(first, second), true);
  assert.equal(samePackageInputFingerprint(first, { ...second, sha256: '0'.repeat(64) }), false);
  expectCode(() => validatePackageInputFingerprint({ ...first, extra: true }), 'package_fingerprint_invalid');
  expectCode(() => validatePackageInputFingerprint({ ...first, fileCount: -1 }), 'package_fingerprint_invalid');
  expectCode(() => fingerprintPackageEntries([
    { ...entry('a.js', 'a'), symlink: true },
  ]), 'package_inventory_entry_invalid');
  expectCode(() => fingerprintPackageEntries([
    { ...entry('a.js', 'a'), type: 'directory' },
  ]), 'package_inventory_entry_invalid');
});

test('rejects included and package-private file and directory symlinks instead of omitting them', () => {
  withFixture((root) => {
    write(root, 'manifest.json', '{}');
    write(root, 'assets/real.js', 'worker');
    symlinkSync(path.join(root, 'assets', 'real.js'), path.join(root, 'assets', 'extra.js'));
    expectCode(() => createPackageInputInventory(root), 'package_input_symlink_rejected');
  });
  withFixture((root) => {
    write(root, 'manifest.json', '{}');
    mkdirSync(path.join(root, 'real-assets'));
    symlinkSync(path.join(root, 'real-assets'), path.join(root, 'assets'));
    expectCode(() => createPackageInputInventory(root), 'package_input_symlink_rejected');
  });
  withFixture((root) => {
    write(root, 'manifest.json', '{}');
    write(root, 'outside-secret.pem', 'secret');
    symlinkSync(path.join(root, 'outside-secret.pem'), path.join(root, 'credentials.pem'));
    expectCode(() => createPackageInputInventory(root), 'package_input_symlink_rejected');
  });
  withFixture((root) => {
    write(root, 'manifest.json', '{}');
    mkdirSync(path.join(root, 'real-secrets'));
    symlinkSync(path.join(root, 'real-secrets'), path.join(root, 'secrets'));
    expectCode(() => createPackageInputInventory(root), 'package_input_symlink_rejected');
  });
});

test('rejects package-internal hard-link aliases', () => withFixture((root) => {
  write(root, 'manifest.json', '{}');
  write(root, 'assets/worker.js', 'worker');
  linkSync(path.join(root, 'assets', 'worker.js'), path.join(root, 'assets', 'worker-alias.js'));
  expectCode(() => createPackageInputInventory(root), 'package_input_alias_rejected');
}));

test('rejects every non-regular included dirent', () => withFixture((root) => {
  write(root, 'manifest.json', '{}');
  execFileSync('mkfifo', [path.join(root, 'unexpected.pipe')]);
  expectCode(() => createPackageInputInventory(root), 'package_input_not_regular');
}));

test('rejects symlinked and non-directory inventory roots', () => withFixture((parent) => {
  const realRoot = path.join(parent, 'real');
  mkdirSync(realRoot);
  write(realRoot, 'manifest.json', '{}');
  const linkedRoot = path.join(parent, 'linked');
  symlinkSync(realRoot, linkedRoot);
  expectCode(() => createPackageInputInventory(linkedRoot), 'package_input_root_invalid');
  expectCode(() => createPackageInputInventory(path.join(realRoot, 'manifest.json')), 'package_input_root_invalid');
}));

test('fingerprint rejects traversal, forbidden, duplicate, unordered, and stale inventory entries', () => {
  expectCode(() => fingerprintPackageInventory([entry('../escape.js', 'x')]), 'package_inventory_path_invalid');
  expectCode(() => fingerprintPackageInventory([entry('assets/line\nbreak.js', 'x')]), 'package_inventory_path_invalid');
  expectCode(() => fingerprintPackageInventory([entry('docs/private.txt', 'x')]), 'package_inventory_entry_invalid');
  expectCode(() => fingerprintPackageInventory([entry('b.js', 'b'), entry('a.js', 'a')]), 'package_inventory_order_invalid');
  expectCode(() => fingerprintPackageInventory([entry('a.js', 'a'), entry('a.js', 'a')]), 'package_inventory_order_invalid');
  const stale = entry('a.js', 'a');
  stale.sha256 = '0'.repeat(64);
  expectCode(() => fingerprintPackageInventory([stale]), 'package_inventory_entry_invalid');
  expectCode(() => fingerprintPackageInventory([{ ...entry('a.js', 'a'), type: 'directory' }]), 'package_inventory_entry_invalid');
  expectCode(() => fingerprintPackageInventory([{ ...entry('a.js', 'a'), symlink: true }]), 'package_inventory_entry_invalid');
});
