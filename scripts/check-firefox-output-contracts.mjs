#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import {
  FIREFOX_DIST_DIR,
  FIREFOX_GECKO_ID,
  FIREFOX_MIN_VERSION,
  FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS,
  FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS,
} from './build-firefox-extension.mjs';

const REQUIRED_PERMISSIONS = Object.freeze(['storage', 'alarms']);
const REQUIRED_HOST_PERMISSIONS = Object.freeze([
  'https://api.github.com/*',
  'https://api.openai.com/*',
  'https://api.anthropic.com/*',
  'https://github.com/*',
  'https://openrouter.ai/*',
]);
const OPTIONAL_HOST_PERMISSIONS = Object.freeze([
  'https://*/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
]);
const GITHUB_CONTENT_MATCH = 'https://github.com/*';
const POPUP_PATH = 'src/popup/index.html';
const OPTIONS_PATH = 'src/options/index.html';

export class FirefoxManifestContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'FirefoxManifestContractError';
    this.code = code;
  }
}

export function assertFirefoxManifestContract(manifest, options = {}) {
  assert(isPlainObject(manifest), 'manifest_invalid', 'Firefox manifest must be an object');
  assert(manifest.manifest_version === 3, 'manifest_version_invalid', 'Firefox manifest must use MV3');
  assert(
    manifest.version === (options.expectedVersion ?? pkg.version),
    'manifest_version_mismatch',
    `Firefox manifest version must equal ${options.expectedVersion ?? pkg.version}`,
  );

  const background = manifest.background;
  assert(isPlainObject(background), 'background_invalid', 'Firefox manifest must define background');
  assertExactKeys(background, ['scripts', 'type'], 'background_keys_invalid', 'Firefox background');
  assert(
    Array.isArray(background.scripts)
      && background.scripts.length === 1
      && isPackageFilePath(background.scripts[0]),
    'background_scripts_invalid',
    'Firefox background.scripts must contain exactly one built module loader',
  );
  assert(background.type === 'module', 'background_type_invalid', 'Firefox background must use module type');
  assert(!Object.hasOwn(background, 'service_worker'), 'chrome_background_key_present', 'Firefox background must not contain service_worker');

  const gecko = manifest.browser_specific_settings?.gecko;
  assert(isPlainObject(gecko), 'gecko_settings_missing', 'Firefox manifest must define Gecko settings');
  assertExactKeys(
    gecko,
    ['data_collection_permissions', 'id', 'strict_min_version'],
    'gecko_keys_invalid',
    'Firefox Gecko settings',
  );
  assert(gecko.id === FIREFOX_GECKO_ID, 'gecko_id_invalid', 'Firefox manifest has the wrong permanent Gecko ID');
  assert(
    gecko.strict_min_version === FIREFOX_MIN_VERSION,
    'gecko_min_version_invalid',
    `Firefox manifest must require Firefox ${FIREFOX_MIN_VERSION} or later`,
  );

  const dataPermissions = gecko.data_collection_permissions;
  assert(isPlainObject(dataPermissions), 'data_permissions_invalid', 'Firefox data collection permissions must be an object');
  assertExactKeys(dataPermissions, ['optional', 'required'], 'data_permission_keys_invalid', 'Firefox data collection permissions');
  assertExactStringSet(
    dataPermissions.required,
    FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS,
    'required_data_permissions_invalid',
    'required Firefox data collection permissions',
  );
  assertExactStringSet(
    dataPermissions.optional,
    FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS,
    'optional_data_permissions_invalid',
    'optional Firefox data collection permissions',
  );

  assertExactStringSet(manifest.permissions, REQUIRED_PERMISSIONS, 'permissions_invalid', 'Firefox permissions');
  assertExactStringSet(manifest.host_permissions, REQUIRED_HOST_PERMISSIONS, 'host_permissions_invalid', 'Firefox host permissions');
  assertExactStringSet(
    manifest.optional_host_permissions,
    OPTIONAL_HOST_PERMISSIONS,
    'optional_host_permissions_invalid',
    'Firefox optional host permissions',
  );

  assert(manifest.action?.default_popup === POPUP_PATH, 'popup_invalid', `Firefox popup must be ${POPUP_PATH}`);
  assert(manifest.options_ui?.page === OPTIONS_PATH, 'options_invalid', `Firefox Options page must be ${OPTIONS_PATH}`);
  assert(manifest.options_ui?.open_in_tab === true, 'options_mode_invalid', 'Firefox Options page must open in a tab');

  const contentScripts = manifest.content_scripts;
  assert(Array.isArray(contentScripts) && contentScripts.length === 2, 'content_scripts_invalid', 'Firefox manifest must contain both GitHub content scripts');
  const contentScriptPaths = [];
  for (const contentScript of contentScripts) {
    assert(isPlainObject(contentScript), 'content_script_invalid', 'Each Firefox content script must be an object');
    assertExactKeys(contentScript, ['js', 'matches', 'run_at'], 'content_script_keys_invalid', 'Firefox content script');
    assertExactStringSet(contentScript.matches, [GITHUB_CONTENT_MATCH], 'content_script_matches_invalid', 'Firefox content script matches');
    assert(contentScript.run_at === 'document_idle', 'content_script_timing_invalid', 'Firefox content scripts must run at document_idle');
    assert(
      Array.isArray(contentScript.js)
        && contentScript.js.length === 1
        && isPackageFilePath(contentScript.js[0]),
      'content_script_entry_invalid',
      'Each Firefox content script must contain exactly one built JavaScript entry',
    );
    contentScriptPaths.push(contentScript.js[0]);
  }
  assert(new Set(contentScriptPaths).size === 2, 'content_script_duplicate', 'Firefox content scripts must use two distinct built entries');

  return Object.freeze({
    backgroundScript: background.scripts[0],
    popupPath: POPUP_PATH,
    optionsPath: OPTIONS_PATH,
    contentScriptPaths: Object.freeze([...contentScriptPaths]),
  });
}

export function assertFirefoxOutputContract(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const distDir = path.resolve(root, options.distDir ?? FIREFOX_DIST_DIR);
  const manifestPath = path.join(distDir, 'manifest.json');
  const manifest = readJson(manifestPath);
  const resources = assertFirefoxManifestContract(manifest, options);

  for (const resourcePath of [
    resources.backgroundScript,
    resources.popupPath,
    resources.optionsPath,
    ...resources.contentScriptPaths,
  ]) {
    assertOutputFile(distDir, resourcePath);
  }

  return Object.freeze({ distDir, manifestPath, manifest, resources });
}

function assertOutputFile(distDir, relativePath) {
  const absolutePath = path.resolve(distDir, ...relativePath.split('/'));
  assert(
    absolutePath.startsWith(`${distDir}${path.sep}`),
    'output_resource_path_invalid',
    `Firefox output resource escapes the output root: ${relativePath}`,
  );
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch {
    throw new FirefoxManifestContractError('output_resource_missing', `Firefox output is missing ${relativePath}`);
  }
  assert(stats.isFile(), 'output_resource_invalid', `Firefox output resource must be a regular file: ${relativePath}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new FirefoxManifestContractError(
      'manifest_read_failed',
      `Unable to read Firefox manifest at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertExactKeys(value, expected, code, label) {
  assertExactStringSet(Object.keys(value), expected, code, `${label} keys`);
}

function assertExactStringSet(actual, expected, code, label) {
  assert(
    Array.isArray(actual)
      && actual.every((value) => typeof value === 'string')
      && actual.length === new Set(actual).size
      && sameSortedStrings(actual, expected),
    code,
    `${label} must be exactly ${expected.join(', ')}`,
  );
}

function sameSortedStrings(left, right) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(bytewiseCompare);
  const sortedRight = [...right].sort(bytewiseCompare);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function isPackageFilePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function assert(condition, code, message) {
  if (!condition) throw new FirefoxManifestContractError(code, message);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = assertFirefoxOutputContract({ distDir: process.argv[2] ?? FIREFOX_DIST_DIR });
    console.log(`Firefox output contract ok: ${path.relative(process.cwd(), result.manifestPath)}`);
  } catch (error) {
    console.error(`Firefox output contract failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
