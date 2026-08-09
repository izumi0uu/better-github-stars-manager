import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  classifyForbiddenPackageEntry,
  compareChromeExtensionVersions,
  discoverMermaidArtifacts,
  enforceWorkerIdentity,
  enforceWorkerByteCeiling,
  enforceWorkerReleaseBaseline,
  measureBundleArtifact,
  normalizePackageRelativePath,
  parseChromeExtensionVersion,
  PackageClosureError,
  parseMv3WorkerLoader,
  resolvePackagePath,
  validateManifestResourceClosure,
  RELEASE_WORKER_BASELINE,
  WORKER_BYTE_CEILING,
} from '../../scripts/package-manifest-closure.mjs';

const manifest = {
  manifest_version: 3,
  version: '1.0.8',
  icons: { 16: 'icons/icon.png' },
  background: { service_worker: 'service-worker-loader.js', type: 'module' },
  action: { default_icon: { 16: 'icons/icon.png' }, default_popup: 'popup.html' },
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
};

function entries(overrides = []) {
  const defaults = [
    ['manifest.json', JSON.stringify(manifest)],
    ['service-worker-loader.js', "import './assets/worker.js';\n"],
    ['assets/worker.js', 'worker'],
    ['icons/icon.png', 'icon'],
    ['popup.html', 'popup'],
    ['options.html', 'options'],
    ['assets/content.js', 'content'],
    ['assets/content.css', 'styles'],

    ['assets/public.svg', 'public'],
  ].map(([relativePath, bytes]) => ({ relativePath, bytes }));
  const replacements = new Map(overrides.map((entry) => [entry.relativePath, entry]));
  return defaults
    .filter((entry) => replacements.get(entry.relativePath)?.remove !== true)
    .map((entry) => replacements.get(entry.relativePath) ?? entry)
    .concat(overrides.filter((entry) => !defaults.some((candidate) => candidate.relativePath === entry.relativePath) && !entry.remove));
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof PackageClosureError && error.code === code);
}
test('parses and compares canonical Chrome extension versions', () => {
  assert.deepEqual(parseChromeExtensionVersion('1.0.9'), [1, 0, 9]);
  assert.deepEqual(parseChromeExtensionVersion('0.1.0.0'), [0, 1, 0, 0]);
  assert.deepEqual(parseChromeExtensionVersion('65535.65535.65535.65535'), [65_535, 65_535, 65_535, 65_535]);
  assert.equal(compareChromeExtensionVersions('1.0.9', '1.0.8'), 1);
  assert.equal(compareChromeExtensionVersions('1', '1.0.0.0'), 0);
  assert.equal(compareChromeExtensionVersions('1.2', '1.2.0.1'), -1);
  for (const candidate of ['', '0', '0.0.0', '00.1', '01.2', '1.02', '1.2.3.4.5', '1.-1', '1.65536', '1.a', ' 1', '1 ', '１.0', '1'.repeat(24)]) {
    expectCode(() => parseChromeExtensionVersion(candidate), 'extension_version_invalid');
  }
});

test('accepts only canonical contained package-relative paths', () => {
  assert.equal(normalizePackageRelativePath('assets/worker.js'), 'assets/worker.js');
  for (const candidate of ['', '.', './asset.js', '../asset.js', 'assets/../asset.js', '/asset.js', 'C:/asset.js', '\\\\host\\asset.js', 'https://host/asset.js', 'data:text/javascript,x', 'asset.js?x', 'asset.js#x', 'assets\\asset.js', 'assets/%2e%2e/asset.js', 'assets/line\nbreak.js']) {
    expectCode(() => normalizePackageRelativePath(candidate), 'package_path_invalid');
  }
  expectCode(() => normalizePackageRelativePath(`assets/${'猫'.repeat(171)}.js`), 'package_path_invalid');
});

test('resolves regular files while rejecting missing, nonregular, and symlinked package paths', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'manifest-closure-path-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'manifest-closure-outside-'));
  try {
    mkdirSync(path.join(root, 'assets'));
    writeFileSync(path.join(root, 'assets', 'worker.js'), 'worker');
    writeFileSync(path.join(outside, 'worker.js'), 'outside');
    assert.equal(resolvePackagePath(root, 'assets/worker.js').endsWith('/assets/worker.js'), true);
    expectCode(() => resolvePackagePath(root, 'assets/missing.js'), 'package_file_missing');
    expectCode(() => resolvePackagePath(root, 'assets'), 'package_file_not_regular');
    symlinkSync(path.join(outside, 'worker.js'), path.join(root, 'assets', 'linked.js'));
    expectCode(() => resolvePackagePath(root, 'assets/linked.js'), 'package_symlink_rejected');
    symlinkSync(outside, path.join(root, 'linked-assets'));
    expectCode(() => resolvePackagePath(root, 'linked-assets/worker.js'), 'package_symlink_rejected');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('resolves the single static relative MV3 worker import', () => {
  assert.deepEqual(parseMv3WorkerLoader({
    manifest,
    loaderText: "import './assets/worker.js';\n",
  }), {
    loaderRelativePath: 'service-worker-loader.js',
    workerRelativePath: 'assets/worker.js',
  });
});

test('rejects missing, multiple, external, data, dynamic, absolute, traversal, and decorated worker imports', () => {
  const invalidLoaders = [
    '',
    "import './assets/one.js';\nimport './assets/two.js';\n",
    "import 'worker-package';\n",
    "import 'https://example.test/worker.js';\n",
    "import 'data:text/javascript,export default 1';\n",
    "import('/assets/worker.js');\n",
    "import '/assets/worker.js';\n",
    "import '../worker.js';\n",
    "import './../worker.js';\n",
    "import './assets/../worker.js';\n",
    "// loader\nimport './assets/worker.js';\n",
    "import './assets/worker.js';\nglobalThis.started = true;\n",
  ];
  for (const loaderText of invalidLoaders) {
    assert.throws(() => parseMv3WorkerLoader({ manifest, loaderText }), PackageClosureError);
  }
  expectCode(() => parseMv3WorkerLoader({
    manifest: { ...manifest, background: { ...manifest.background, type: undefined } },
    loaderText: "import './assets/worker.js';\n",
  }), 'mv3_module_worker_required');
});

test('rejects wildcard loaders and non-UTF-8 loader bytes', () => {
  expectCode(() => parseMv3WorkerLoader({
    manifest: { ...manifest, background: { ...manifest.background, service_worker: 'loader*.js' } },
    loaderText: "import './assets/worker.js';\n",
  }), 'package_path_invalid');
  expectCode(() => validateManifestResourceClosure({
    manifest,
    packageEntries: entries([{ relativePath: 'service-worker-loader.js', bytes: Buffer.from([0xff]) }]),
  }), 'package_entry_bytes_invalid');
});

test('measures bundle identities and enforces the frozen release worker exactly', () => {
  const measured = measureBundleArtifact({
    relativePath: 'assets/measured-worker.js',
    bytes: Buffer.from('measured worker'),
  });
  assert.equal(measured.bytes, Buffer.byteLength('measured worker'));
  assert.equal(measured.kib, measured.bytes / 1024);
  assert.match(measured.sha256, /^[0-9a-f]{64}$/u);

  const exact = {
    ...RELEASE_WORKER_BASELINE,
    kib: RELEASE_WORKER_BASELINE.bytes / 1024,
  };
  assert.equal(exact.bytes, 645_779);
  assert.equal(WORKER_BYTE_CEILING, exact.bytes);
  assert.equal(enforceWorkerByteCeiling(exact).withinCeiling, true);
  assert.deepEqual(enforceWorkerReleaseBaseline(exact), exact);
  assert.deepEqual(enforceWorkerIdentity(exact, RELEASE_WORKER_BASELINE), exact);

  const under = { ...exact, bytes: exact.bytes - 1, kib: (exact.bytes - 1) / 1024 };
  const over = { ...exact, bytes: exact.bytes + 1, kib: (exact.bytes + 1) / 1024 };
  expectCode(() => enforceWorkerReleaseBaseline(under), 'worker_identity_mismatch');
  expectCode(() => enforceWorkerReleaseBaseline(over), 'worker_byte_ceiling_exceeded');
  expectCode(() => enforceWorkerReleaseBaseline({ ...exact, sha256: '0'.repeat(64) }), 'worker_identity_mismatch');
  expectCode(() => enforceWorkerReleaseBaseline({ ...exact, relativePath: 'assets/other.js' }), 'worker_identity_mismatch');
  expectCode(() => enforceWorkerIdentity(exact, { ...RELEASE_WORKER_BASELINE, kib: exact.kib }), 'worker_identity_invalid');
  expectCode(() => enforceWorkerByteCeiling({ ...exact, kib: 1 }), 'worker_measurement_invalid');
});

test('discovers every regular Mermaid JavaScript artifact in bytewise path order', () => {
  const artifacts = discoverMermaidArtifacts([
    { relativePath: 'assets/mermaid-z.js', bytes: '猫' },
    { relativePath: 'assets/application.js', bytes: 'app' },
    { relativePath: 'chunks/mermaid-a.js', bytes: 'a' },
  ]);
  assert.deepEqual(artifacts.map((entry) => entry.relativePath), [
    'assets/mermaid-z.js',
    'chunks/mermaid-a.js',
  ]);
  assert.equal(artifacts[0].bytes, 3);
  assert.match(artifacts[0].sha256, /^[0-9a-f]{64}$/u);
  expectCode(() => discoverMermaidArtifacts([
    { relativePath: 'assets/mermaid-linked.js', bytes: 'x', symlink: true },
  ]), 'package_entry_not_regular');
});

test('closes literal manifest icons, pages, worker, content assets, and web-accessible resources', () => {
  const closure = validateManifestResourceClosure({ manifest, packageEntries: entries() });
  assert.equal(closure.manifestResourcesClosed, true);
  assert.equal(closure.workerRelativePath, 'assets/worker.js');
  assert.deepEqual(closure.resources.map((entry) => entry.relativePath), [
    'assets/content.css',
    'assets/content.js',
    'assets/public.svg',
    'assets/worker.js',
    'icons/icon.png',
    'options.html',
    'popup.html',
    'service-worker-loader.js',
  ]);
  assert.deepEqual(
    closure.resources.find((entry) => entry.relativePath === 'icons/icon.png').referencedBy,
    ['action.default_icon.16', 'icons.16'],
  );
  assert.deepEqual(
    closure.resources.find((entry) => entry.relativePath === 'assets/worker.js').referencedBy,
    ['background.service_worker.import'],
  );
});

test('distinguishes URL match patterns from literal package resources', () => {
  const withWildcardMatches = {
    ...manifest,
    content_scripts: [{ ...manifest.content_scripts[0], matches: ['https://*.example.test/*'] }],
    web_accessible_resources: [{
      ...manifest.web_accessible_resources[0],
      matches: ['https://*.example.test/*'],
    }],
  };
  assert.equal(validateManifestResourceClosure({
    manifest: withWildcardMatches,
    packageEntries: entries([{ relativePath: 'manifest.json', bytes: JSON.stringify(withWildcardMatches) }]),
  }).manifestResourcesClosed, true);
});

test('closes the literal managed storage schema and rejects missing or escaping schema paths', () => {
  const managed = { ...manifest, storage: { managed_schema: 'schemas/managed-storage.json' } };
  const managedEntries = entries([
    { relativePath: 'manifest.json', bytes: JSON.stringify(managed) },
    { relativePath: 'schemas/managed-storage.json', bytes: '{"type":"object"}' },
  ]);
  const closure = validateManifestResourceClosure({ manifest: managed, packageEntries: managedEntries });
  assert.deepEqual(
    closure.resources.find((entry) => entry.relativePath === 'schemas/managed-storage.json').referencedBy,
    ['storage.managed_schema'],
  );
  expectCode(() => validateManifestResourceClosure({
    manifest: managed,
    packageEntries: managedEntries.filter((entry) => entry.relativePath !== 'schemas/managed-storage.json'),
  }), 'manifest_resource_missing');
  const escaping = { ...manifest, storage: { managed_schema: '../managed-storage.json' } };
  expectCode(() => validateManifestResourceClosure({
    manifest: escaping,
    packageEntries: entries([{ relativePath: 'manifest.json', bytes: JSON.stringify(escaping) }]),
  }), 'package_path_invalid');
});

test('closes declarative Net Request rule resources and rejects missing or escaping rule paths', () => {
  const dnr = { ...manifest, declarative_net_request: { rule_resources: [{ id: 'base', enabled: true, path: 'rules/base.json' }] } };
  const dnrEntries = entries([
    { relativePath: 'manifest.json', bytes: JSON.stringify(dnr) },
    { relativePath: 'rules/base.json', bytes: '[]' },
  ]);
  const closure = validateManifestResourceClosure({ manifest: dnr, packageEntries: dnrEntries });
  assert.deepEqual(
    closure.resources.find((entry) => entry.relativePath === 'rules/base.json').referencedBy,
    ['declarative_net_request.rule_resources[0].path'],
  );
  expectCode(() => validateManifestResourceClosure({
    manifest: dnr,
    packageEntries: dnrEntries.filter((entry) => entry.relativePath !== 'rules/base.json'),
  }), 'manifest_resource_missing');
  const escaping = { ...manifest, declarative_net_request: { rule_resources: [{ id: 'bad', enabled: true, path: '../rules.json' }] } };
  expectCode(() => validateManifestResourceClosure({
    manifest: escaping,
    packageEntries: entries([{ relativePath: 'manifest.json', bytes: JSON.stringify(escaping) }]),
  }), 'package_path_invalid');
});

test('binds closure to the exact packaged manifest bytes', () => {
  const staleManifest = { ...manifest, options_ui: { page: 'stale-options.html', open_in_tab: true } };
  expectCode(() => validateManifestResourceClosure({
    manifest: staleManifest,
    packageEntries: entries(),
  }), 'packaged_manifest_mismatch');
  expectCode(() => validateManifestResourceClosure({
    manifest,
    packageEntries: entries([{ relativePath: 'manifest.json', bytes: '{invalid' }]),
  }), 'packaged_manifest_invalid');
});

test('rejects missing, escaping, wildcard, duplicate, and symlinked manifest resources', () => {
  expectCode(() => validateManifestResourceClosure({
    manifest,
    packageEntries: entries([{ relativePath: 'options.html', remove: true }]),
  }), 'manifest_resource_missing');

  const escaping = { ...manifest, options_ui: { page: '../options.html' } };
  expectCode(() => validateManifestResourceClosure({
    manifest: escaping,
    packageEntries: entries([{ relativePath: 'manifest.json', bytes: JSON.stringify(escaping) }]),
  }), 'package_path_invalid');

  const wildcard = {
    ...manifest,
    web_accessible_resources: [{ resources: ['assets/*.js'], matches: ['https://github.com/*'] }],
  };
  expectCode(() => validateManifestResourceClosure({
    manifest: wildcard,
    packageEntries: entries([{ relativePath: 'manifest.json', bytes: JSON.stringify(wildcard) }]),
  }), 'manifest_resource_wildcard');

  expectCode(() => validateManifestResourceClosure({
    manifest,
    packageEntries: [...entries(), { relativePath: 'popup.html', bytes: 'duplicate' }],
  }), 'package_entry_duplicate');

  expectCode(() => validateManifestResourceClosure({
    manifest,
    packageEntries: entries([{ relativePath: 'assets/worker.js', bytes: 'worker', symlink: true }]),
  }), 'package_entry_not_regular');
});

test('rejects forbidden and nonregular package inventory entries before closure', () => {
  expectCode(() => validateManifestResourceClosure({
    manifest,
    packageEntries: [...entries(), { relativePath: '.workspace/session.json', bytes: '{}' }],
  }), 'package_entry_forbidden');
  expectCode(() => validateManifestResourceClosure({
    manifest,
    packageEntries: entries([{ relativePath: 'assets/worker.js', bytes: 'worker', type: 'directory' }]),
  }), 'package_entry_not_regular');
});

test('rejects only anchored package-private paths without blocking production dev-named chunks', () => {
  assert.equal(classifyForbiddenPackageEntry('assets/dev-rsSWfq8L.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/diagnostic-renderer.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/credential-field.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/secret-label.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/local-state-viewer.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/environment.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/secretary-key.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/credentials-helper.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/app.env.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/secrets-view/provider.svg'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/credentials-helper/custom.yaml'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/key-manager.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/certificate-viewer.js'), null);
  assert.equal(classifyForbiddenPackageEntry('assets/dev-signing-key-helper.js'), null);
  for (const candidate of [
    'src/dev-agent/index.html',
    'diagnostics/report.json',
    'assets/agent-diagnostics.json',
    'runtime/local-state/session.json',
    'provider-capture/foo-raw-capture.json',
    'artifacts/foo-raw-capture.json',
    'artifacts/provider-capture-20260809T123456Z.json',
    'artifacts/raw-capture-2026-08-09T12-34-56Z.json',
    'artifacts/credentials-1723200000000.json',
    'assets/development-build-hash.json',
    '.env',
    'assets/.env.production',
    'config/production.env',
    'credentials.pem',
    'certs/credential.pem',
    'certs/secret.key',
    'certs/secrets.cert',
    'secrets/provider.pem',
    'credentials/custom.yaml',
    'nested/credential/config',
    'secret.env',
    'credentials.production.yaml',
    'keys/provider.json',
    'certificates/provider.yaml',
    'public/signing.key',
    'public/client.cert',
    'public/client.crt',
    'public/client.cer',
    'public/client.p12',
    'public/client.pfx',
  ]) assert.equal(classifyForbiddenPackageEntry(candidate), candidate.includes('local-state') ? 'source_or_local_state' : 'private_or_development_artifact');
  assert.equal(classifyForbiddenPackageEntry('assets/application.js.map'), 'source_map');
  assert.equal(classifyForbiddenPackageEntry('.omp/session.json'), 'source_or_local_state');
  assert.equal(classifyForbiddenPackageEntry('poster/source.svg'), 'source_or_local_state');
  assert.equal(classifyForbiddenPackageEntry('.DS_Store'), 'source_or_local_state');
  assert.equal(classifyForbiddenPackageEntry('assets/.DS_Store'), 'source_or_local_state');
  assert.equal(classifyForbiddenPackageEntry('.workspace/session.json'), 'source_or_local_state');
  assert.equal(classifyForbiddenPackageEntry('assets/.cache/bundle.js'), 'source_or_local_state');
});
