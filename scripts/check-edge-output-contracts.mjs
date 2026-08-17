#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { EDGE_DIST_DIR } from './build-edge-extension.mjs';

export const EDGE_REQUIRED_PERMISSIONS = Object.freeze(['storage', 'alarms']);
export const EDGE_REQUIRED_HOST_PERMISSIONS = Object.freeze([
  'https://api.github.com/*',
  'https://api.openai.com/*',
  'https://api.anthropic.com/*',
  'https://github.com/*',
  'https://openrouter.ai/*',
]);
export const EDGE_OPTIONAL_HOST_PERMISSIONS = Object.freeze([
  'https://*/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
]);


const GITHUB_CONTENT_MATCH = 'https://github.com/*';
const POPUP_PATH = 'src/popup/index.html';
const OPTIONS_PATH = 'src/options/index.html';

export class EdgeManifestContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'EdgeManifestContractError';
    this.code = code;
  }
}

export function assertEdgeManifestContract(manifest, options = {}) {
  assert(isPlainObject(manifest), 'edge_manifest_invalid', 'Edge manifest must be an object');
  assert(manifest.manifest_version === 3, 'edge_manifest_version_invalid', 'Edge manifest must use MV3');
  assert(
    manifest.version === (options.expectedVersion ?? pkg.version),
    'edge_extension_version_invalid',
    `Edge manifest version must equal ${options.expectedVersion ?? pkg.version}`,
  );
  assertExactStringSet(manifest.permissions, EDGE_REQUIRED_PERMISSIONS, 'edge_permissions_invalid', 'Edge permissions');
  assertExactStringSet(manifest.host_permissions, EDGE_REQUIRED_HOST_PERMISSIONS, 'edge_host_permissions_invalid', 'Edge host permissions');
  assert(!Object.hasOwn(manifest, 'optional_permissions'), 'edge_optional_permissions_present', 'Edge manifest must not declare optional permissions');
  assertExactStringSet(manifest.optional_host_permissions, EDGE_OPTIONAL_HOST_PERMISSIONS, 'edge_optional_host_permissions_invalid', 'Edge optional host permissions');

  const background = manifest.background;
  assert(isPlainObject(background), 'edge_background_invalid', 'Edge manifest must define a background service worker');
  assertExactKeys(background, ['service_worker', 'type'], 'edge_background_invalid', 'Edge background');
  assert(isPackageFilePath(background.service_worker), 'edge_background_invalid', 'Edge service worker path must be a package file');
  assert(background.type === 'module', 'edge_background_invalid', 'Edge service worker must be a module');

  assert(isPackageFilePath(manifest.action?.default_popup), 'edge_popup_invalid', 'Edge popup must be a package file');
  assert(manifest.action.default_popup === POPUP_PATH, 'edge_popup_invalid', `Edge popup must be ${POPUP_PATH}`);
  assert(isPackageFilePath(manifest.options_ui?.page), 'edge_options_invalid', 'Edge Options must be a package file');
  assert(manifest.options_ui.page === OPTIONS_PATH, 'edge_options_invalid', `Edge Options must be ${OPTIONS_PATH}`);
  assert(manifest.options_ui.open_in_tab === true, 'edge_options_invalid', 'Edge Options must open in a tab');

  assert(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 2, 'edge_content_scripts_invalid', 'Edge manifest must retain both GitHub content scripts');
  const contentScriptPaths = [];
  for (const [index, contentScript] of manifest.content_scripts.entries()) {
    assert(isPlainObject(contentScript), 'edge_content_scripts_invalid', `Edge content script ${index} must be an object`);
    assertExactKeys(contentScript, ['js', 'matches', 'run_at'], 'edge_content_scripts_invalid', `Edge content script ${index}`);
    assertExactStringSet(contentScript.matches, [GITHUB_CONTENT_MATCH], 'edge_content_scripts_invalid', `Edge content script ${index} matches`);
    assert(contentScript.run_at === 'document_idle', 'edge_content_scripts_invalid', `Edge content script ${index} must run at document_idle`);
    assert(Array.isArray(contentScript.js) && contentScript.js.length === 1 && isPackageFilePath(contentScript.js[0]), 'edge_content_scripts_invalid', `Edge content script ${index} must contain one package JavaScript file`);
    contentScriptPaths.push(contentScript.js[0]);
  }
  assert(new Set(contentScriptPaths).size === 2, 'edge_content_scripts_invalid', 'Edge content scripts must use distinct package files');

  return Object.freeze({
    permissions: Object.freeze([...EDGE_REQUIRED_PERMISSIONS].sort(bytewiseCompare)),
    hostPermissions: Object.freeze([...EDGE_REQUIRED_HOST_PERMISSIONS].sort(bytewiseCompare)),
    optionalHostPermissions: Object.freeze([...EDGE_OPTIONAL_HOST_PERMISSIONS].sort(bytewiseCompare)),
  });
}

export function assertEdgeOutputContract(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const distDir = path.resolve(root, options.distDir ?? process.env.GSM_DIST_DIR ?? EDGE_DIST_DIR);
  const manifest = readJson(path.join(distDir, 'manifest.json'));
  assertEdgeManifestContract(manifest, options);

  const referencedFiles = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...manifest.content_scripts.flatMap((contentScript) => contentScript.js),
  ]);
  for (const relativePath of referencedFiles) assertOutputFile(distDir, relativePath);
  return Object.freeze({ distDir, manifest });
}


function assertOutputFile(distDir, relativePath) {
  const absolutePath = path.resolve(distDir, relativePath);
  assert(absolutePath.startsWith(`${distDir}${path.sep}`), 'edge_output_path_invalid', `Edge output path escapes dist: ${relativePath}`);
  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch {
    throw new EdgeManifestContractError('edge_output_file_missing', `Missing Edge output file: ${relativePath}`);
  }
  assert(stats.isFile() && !stats.isSymbolicLink(), 'edge_output_file_invalid', `Edge output file must be regular: ${relativePath}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new EdgeManifestContractError('edge_manifest_unreadable', `Unable to read Edge manifest at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertExactKeys(value, expected, code, label) {
  assertExactStringSet(Object.keys(value), expected, code, `${label} keys`);
}

function assertExactStringSet(actual, expected, code, label) {
  assert(Array.isArray(actual), code, `${label} must be an array`);
  assert(actual.every((entry) => typeof entry === 'string'), code, `${label} must contain strings`);
  assert(new Set(actual).size === actual.length, code, `${label} must not contain duplicates`);
  assert(sameSortedStrings(actual, expected), code, `${label} must equal the reviewed set`);
}


function isPackageFilePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.includes('..')
    && !/[*?\\]/u.test(value);
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function assert(condition, code, message) {
  if (!condition) throw new EdgeManifestContractError(code, message);
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sameSortedStrings(left, right) {
  const sortedLeft = [...left].sort(bytewiseCompare);
  const sortedRight = [...right].sort(bytewiseCompare);
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = assertEdgeOutputContract();
    console.log(`Edge output contract passed: ${path.relative(process.cwd(), result.distDir)}`);
  } catch (error) {
    console.error(`Edge output contract failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
