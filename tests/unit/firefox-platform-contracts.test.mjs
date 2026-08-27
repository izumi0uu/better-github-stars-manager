import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import pkg from '../../package.json';
import {
  buildFirefoxExtension,
  createFirefoxManifest,
  FIREFOX_DIST_DIR,
  FIREFOX_GECKO_ID,
  FIREFOX_MIN_VERSION,
  FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS,
  FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS,
  FIREFOX_TEST_UUID,
} from '../../scripts/build-firefox-extension.mjs';
import {
  assertFirefoxManifestContract,
  assertFirefoxOutputContract,
  FirefoxManifestContractError,
} from '../../scripts/check-firefox-output-contracts.mjs';
import {
  assertFirefoxLintContract,
  FirefoxLintContractError,
} from '../../scripts/lint-firefox-extension.mjs';
import { packageFirefoxArtifacts } from '../../scripts/package-firefox-extension.mjs';
import { resolveFirefoxVerificationRuns } from '../manual/e2e/verify-firefox.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONTENT_SCRIPT_PATHS = [
  'assets/stars-page-loader.js',
  'assets/repo-chip-loader.js',
];

function chromeManifest() {
  return {
    manifest_version: 3,
    name: 'Better GitHub Stars Manager',
    version: pkg.version,
    description: pkg.description,
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
    background: {
      service_worker: 'service-worker-loader.js',
      type: 'module',
    },
    action: {
      default_popup: 'src/popup/index.html',
      default_title: 'Better GitHub Stars Manager',
    },
    options_ui: {
      page: 'src/options/index.html',
      open_in_tab: true,
    },
    content_scripts: CONTENT_SCRIPT_PATHS.map((scriptPath) => ({
      js: [scriptPath],
      matches: ['https://github.com/*'],
      run_at: 'document_idle',
    })),
    browser_specific_settings: {
      safari: { strict_min_version: '17.0' },
      gecko: { id: 'untrusted-old-id@example.test' },
    },
    web_accessible_resources: [],
  };
}

function write(root, relativePath, bytes = relativePath) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
}

function writeChromeOutput(distDir, manifest = chromeManifest()) {
  write(distDir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  write(distDir, manifest.background.service_worker, 'background');
  write(distDir, manifest.action.default_popup, '<main>popup</main>');
  write(distDir, manifest.options_ui.page, '<main>options</main>');
  for (const contentScript of manifest.content_scripts) write(distDir, contentScript.js[0], contentScript.js[0]);
  write(distDir, 'icons/icon-128.png', Buffer.from([0, 1, 2, 3]));
}

function writeFirefoxOutput(distDir, manifest = createFirefoxManifest(chromeManifest())) {
  write(distDir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  write(distDir, manifest.background.scripts[0], 'background');
  write(distDir, manifest.action.default_popup, '<main>popup</main>');
  write(distDir, manifest.options_ui.page, '<main>options</main>');
  for (const contentScript of manifest.content_scripts) write(distDir, contentScript.js[0], contentScript.js[0]);
}

function withFixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'firefox-platform-contracts-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fileInventory(root) {
  const entries = new Map();
  visit(root, '');
  return entries;

  function visit(directory, relativeDirectory) {
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      const absolutePath = path.join(directory, dirent.name);
      if (dirent.isDirectory()) visit(absolutePath, relativePath);
      else entries.set(relativePath, readFileSync(absolutePath));
    }
  }
}

function expectContractCode(run, code) {
  assert.throws(run, (error) => error instanceof FirefoxManifestContractError && error.code === code);
}

function firefoxLintReport() {
  const unsafeDescription = 'Due to both security and performance concerns, this may not be set using dynamic values which have not been adequately sanitized. This can lead to security issues or fairly serious performance degradation.';
  const warnings = [
    {
      code: 'KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION',
      file: 'manifest.json',
      message: 'Manifest key not supported by the specified minimum Firefox for Android version',
      description: '"strict_min_version" requires Firefox for Android 140, which was released before version 142 introduced support for "browser_specific_settings.gecko.data_collection_permissions".',
    },
    ...Array.from({ length: 2 }, () => ({
      code: 'UNSAFE_VAR_ASSIGNMENT',
      file: 'assets/recommendation-entry-hash.js',
      message: 'Unsafe assignment to innerHTML',
      description: unsafeDescription,
    })),
    {
      code: 'UNSAFE_VAR_ASSIGNMENT',
      file: 'assets/mermaid-hash.js',
      message: 'Unsafe assignment to innerHTML',
      description: unsafeDescription,
    },
    {
      code: 'UNSAFE_VAR_ASSIGNMENT',
      file: 'assets/mermaid-hash.js',
      message: 'Unsafe call to X5(r).document().write for argument 0',
      description: unsafeDescription,
    },
  ];
  return {
    count: warnings.length,
    errors: [],
    notices: [],
    warnings,
    summary: { errors: 0, notices: 0, warnings: warnings.length },
    metadata: {
      id: FIREFOX_GECKO_ID,
      manifestVersion: 3,
      version: pkg.version,
      firefoxMinVersion: FIREFOX_MIN_VERSION,
    },
  };
}

function expectLintCode(run, code) {
  assert.throws(run, (error) => error instanceof FirefoxLintContractError && error.code === code);
}

test('converts the exact Chrome background entry to the fixed Firefox manifest contract without mutating Chrome', () => {
  const chrome = chromeManifest();
  const originalChrome = structuredClone(chrome);
  const firefox = createFirefoxManifest(chrome);

  assert.deepEqual(chrome, originalChrome);
  assertFirefoxManifestContract(firefox);
  assert.deepEqual(firefox.background, {
    scripts: [originalChrome.background.service_worker],
    type: 'module',
  });
  assert.equal(Object.hasOwn(firefox.background, 'service_worker'), false);
  assert.deepEqual(firefox.browser_specific_settings.safari, originalChrome.browser_specific_settings.safari);
  for (const preservedKey of [
    'manifest_version',
    'name',
    'version',
    'description',
    'permissions',
    'host_permissions',
    'optional_host_permissions',
    'action',
    'options_ui',
    'content_scripts',
    'web_accessible_resources',
  ]) {
    assert.deepEqual(firefox[preservedKey], originalChrome[preservedKey]);
  }
  assert.deepEqual(firefox.browser_specific_settings.gecko, {
    id: FIREFOX_GECKO_ID,
    strict_min_version: FIREFOX_MIN_VERSION,
    data_collection_permissions: {
      required: [...FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS],
      optional: [...FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS],
    },
  });
  assert.equal(FIREFOX_DIST_DIR, 'dist-firefox');
  assert.equal(FIREFOX_GECKO_ID, '{5aeb7340-40e6-428d-9566-f3cacbe06352}');
  assert.equal(FIREFOX_MIN_VERSION, '140.0');
  assert.deepEqual(FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS, [
    'authenticationInfo',
    'websiteActivity',
    'websiteContent',
  ]);
  assert.deepEqual(FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS, ['personalCommunications']);
  assert.equal(FIREFOX_TEST_UUID, '5aeb7340-40e6-428d-9566-f3cacbe06352');
});

test('builds Firefox from the production Chrome output and changes only manifest bytes', () => withFixture((root) => {
  const chromeDist = path.join(root, 'dist');
  let observedBuild;
  const result = buildFirefoxExtension({
    root,
    buildRunner(input) {
      observedBuild = input;
      writeChromeOutput(input.chromeDistDir);
    },
    environment: { KEEP_ME: 'yes' },
  });

  assert.equal(observedBuild.root, root);
  assert.equal(observedBuild.chromeDistDir, chromeDist);
  assert.equal(observedBuild.environment.KEEP_ME, 'yes');
  assert.equal(observedBuild.environment.GSM_DEV, 'false');
  assert.equal(observedBuild.environment.GSM_RELEASE, 'true');
  assert.equal(observedBuild.environment.GSM_STORE_TARGET, 'chrome');
  assert.equal(observedBuild.environment.GSM_DIST_DIR, chromeDist);
  assert.equal(result.firefoxDistDir, path.join(root, FIREFOX_DIST_DIR));

  const chromeFiles = fileInventory(chromeDist);
  const firefoxFiles = fileInventory(result.firefoxDistDir);
  const chromeManifestBytes = chromeFiles.get('manifest.json');
  const firefoxManifestBytes = firefoxFiles.get('manifest.json');
  chromeFiles.delete('manifest.json');
  firefoxFiles.delete('manifest.json');
  assert.deepEqual(firefoxFiles, chromeFiles);
  assert.notDeepEqual(firefoxManifestBytes, chromeManifestBytes);
  assertFirefoxOutputContract({ root });
  assert.equal(JSON.parse(chromeManifestBytes).background.service_worker, 'service-worker-loader.js');
}));

test('strict validation covers version, Gecko data declarations, permissions, hosts, UI pages, and both content scripts', () => {
  const valid = createFirefoxManifest(chromeManifest());
  const invalidCases = [
    ['manifest_version_mismatch', (manifest) => { manifest.version = '9.9.9'; }],
    ['background_keys_invalid', (manifest) => { manifest.background.service_worker = 'service-worker-loader.js'; }],
    ['background_keys_invalid', (manifest) => { manifest.background.page = 'background.html'; }],
    ['background_type_invalid', (manifest) => { manifest.background.type = 'classic'; }],
    ['gecko_id_invalid', (manifest) => { manifest.browser_specific_settings.gecko.id = 'other@example.test'; }],
    ['gecko_min_version_invalid', (manifest) => { manifest.browser_specific_settings.gecko.strict_min_version = '139.0'; }],
    ['required_data_permissions_invalid', (manifest) => { manifest.browser_specific_settings.gecko.data_collection_permissions.required.pop(); }],
    ['optional_data_permissions_invalid', (manifest) => { manifest.browser_specific_settings.gecko.data_collection_permissions.optional = []; }],
    ['permissions_invalid', (manifest) => { manifest.permissions.push('tabs'); }],
    ['host_permissions_invalid', (manifest) => { manifest.host_permissions.pop(); }],
    ['optional_host_permissions_invalid', (manifest) => { manifest.optional_host_permissions.push('https://example.com/*'); }],
    ['popup_invalid', (manifest) => { manifest.action.default_popup = 'popup.html'; }],
    ['options_invalid', (manifest) => { manifest.options_ui.page = 'options.html'; }],
    ['content_scripts_invalid', (manifest) => { manifest.content_scripts.pop(); }],
    ['content_script_keys_invalid', (manifest) => { manifest.content_scripts[0].all_frames = true; }],
    ['content_script_duplicate', (manifest) => { manifest.content_scripts[1].js = [...manifest.content_scripts[0].js]; }],
  ];

  assertFirefoxManifestContract(valid);
  for (const [code, mutate] of invalidCases) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    expectContractCode(() => assertFirefoxManifestContract(candidate), code);
  }
});

test('output validation requires every background, popup, Options, and content-script file', () => withFixture((root) => {
  const distDir = path.join(root, FIREFOX_DIST_DIR);
  writeFirefoxOutput(distDir);
  const validated = assertFirefoxOutputContract({ root });
  assert.equal(validated.resources.contentScriptPaths.length, 2);

  rmSync(path.join(distDir, CONTENT_SCRIPT_PATHS[1]));
  expectContractCode(() => assertFirefoxOutputContract({ root }), 'output_resource_missing');
}));

test('Firefox command aliases use repository-installed web-ext and preserve Chrome defaults', () => {
  assert.equal(pkg.scripts.build, 'tsc --noEmit && vite build');
  assert.equal(pkg.scripts['package:extension'], 'node scripts/package-extension.mjs');
  assert.equal(pkg.scripts['test:smoke'], 'node tests/runtime/extension-browser-smoke.mjs');
  assert.equal(pkg.scripts['test:verify-chrome'], 'node tests/manual/e2e/verify-chrome.mjs');
  assert.deepEqual({
    buildChrome: pkg.scripts['build:chrome'],
    packageChrome: pkg.scripts['package:chrome'],
    buildFirefox: pkg.scripts['build:firefox'],
    packageFirefox: pkg.scripts['package:firefox'],
    checkFirefox: pkg.scripts['check:firefox-output'],
    lintFirefox: pkg.scripts['lint:firefox'],
    smokeFirefox: pkg.scripts['test:smoke:firefox'],
    manualFirefox: pkg.scripts['test:verify-firefox'],
  }, {
    buildChrome: 'pnpm build',
    packageChrome: 'pnpm package:extension',
    buildFirefox: 'node scripts/build-firefox-extension.mjs',
    packageFirefox: 'node scripts/package-firefox-extension.mjs',
    checkFirefox: 'node scripts/check-firefox-output-contracts.mjs',
    lintFirefox: 'node scripts/lint-firefox-extension.mjs',
    smokeFirefox: 'node tests/runtime/firefox-extension-smoke.mjs',
    manualFirefox: 'node tests/manual/e2e/verify-firefox.mjs',
  });
  assert.equal(pkg.devDependencies['web-ext'], '10.6.0');
  assert.doesNotMatch(pkg.scripts['lint:firefox'], /\b(?:dlx|npx)\b/u);
});

test('Firefox lint accepts only the reviewed pinned-tool warning set', () => {
  const valid = firefoxLintReport();
  assert.deepEqual(assertFirefoxLintContract(valid), {
    errors: 0,
    notices: 0,
    reviewedWarnings: 5,
  });

  const unexpected = structuredClone(valid);
  unexpected.warnings.push({
    code: 'NEW_WARNING',
    file: 'assets/new.js',
    message: 'New warning',
    description: 'Not reviewed',
  });
  unexpected.count += 1;
  unexpected.summary.warnings += 1;
  expectLintCode(() => assertFirefoxLintContract(unexpected), 'unreviewed_warning_present');

  const missing = structuredClone(valid);
  missing.warnings.pop();
  missing.count -= 1;
  missing.summary.warnings -= 1;
  expectLintCode(() => assertFirefoxLintContract(missing), 'reviewed_warning_missing');

  const errorReport = structuredClone(valid);
  errorReport.errors.push({ code: 'BROKEN', file: 'manifest.json', message: 'Broken' });
  errorReport.count += 1;
  errorReport.summary.errors += 1;
  expectLintCode(() => assertFirefoxLintContract(errorReport), 'lint_errors_present');
});

test('lockfile resolves only the exact pinned web-ext 10.6.0 release', () => {
  const lockfile = readFileSync(path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8');
  assert.match(
    lockfile,
    /^      web-ext:\n        specifier: 10\.6\.0\n        version: 10\.6\.0(?:\([^\n]+\))?$/mu,
  );
  const lockedVersions = [...lockfile.matchAll(/^  web-ext@([^\s:(]+)[^:]*:$/gmu)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(lockedVersions)], ['10.6.0']);
});

test('Firefox release verification requires both version roles', () => {
  assert.throws(
    () => resolveFirefoxVerificationRuns({ FIREFOX_EXECUTABLE: process.execPath }),
    /Missing: FIREFOX_140_EXECUTABLE, FIREFOX_STABLE_EXECUTABLE/u,
  );
  assert.throws(
    () => resolveFirefoxVerificationRuns({ FIREFOX_140_EXECUTABLE: process.execPath }),
    /Missing: FIREFOX_STABLE_EXECUTABLE/u,
  );
  assert.deepEqual(resolveFirefoxVerificationRuns({
    FIREFOX_140_EXECUTABLE: process.execPath,
    FIREFOX_STABLE_EXECUTABLE: process.execPath,
  }), [
    { role: 'firefox_140', executablePath: process.execPath },
    { role: 'stable', executablePath: process.execPath },
  ]);
});

test('Firefox helper modules are import-safe', () => {
  for (const relativePath of [
    'scripts/build-firefox-extension.mjs',
    'scripts/check-firefox-output-contracts.mjs',
    'scripts/package-firefox-extension.mjs',
    'scripts/lint-firefox-extension.mjs',
  ]) {
    const scriptUrl = new URL(`../../${relativePath}`, import.meta.url).href;
    const stdout = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', `await import(${JSON.stringify(scriptUrl)});`],
      { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  }
});

test('thin Firefox package orchestration delegates extension then reviewer-source packaging', () => {
  const calls = [];
  const result = packageFirefoxArtifacts({
    extensionPackager(options) {
      calls.push(['extension', options]);
      return { zipPath: '/artifacts/firefox/extension.zip' };
    },
    reviewerSourcePackager(options) {
      calls.push(['reviewerSource', options]);
      return { zipPath: '/artifacts/firefox/source.zip' };
    },
  });

  assert.deepEqual(calls, [
    ['extension', { target: 'firefox' }],
    ['reviewerSource', { reuseExisting: true }],
  ]);
  assert.equal(result.extension.zipPath, '/artifacts/firefox/extension.zip');
  assert.equal(result.reviewerSource.zipPath, '/artifacts/firefox/source.zip');
});
