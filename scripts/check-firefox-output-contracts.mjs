#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIREFOX_GECKO_ID, FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS } from './build-firefox-extension.mjs';

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isCliEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}


function includesAll(values, requiredValues) {
  return requiredValues.every((value) => values.includes(value));
}

export function assertFirefoxManifestContract(manifest) {
  const backgroundScripts = manifest.background?.scripts ?? [];
  const gecko = manifest.browser_specific_settings?.gecko;
  const githubContentScripts = (manifest.content_scripts ?? []).filter((script) => script.matches?.includes('https://github.com/*'));

  assert(manifest.manifest_version === 3, 'Firefox manifest must be MV3');
  assert(Array.isArray(backgroundScripts), 'Firefox manifest must define background.scripts');
  assert(backgroundScripts.includes('service-worker-loader.js'), 'Firefox manifest must reuse the built background loader');
  assert(manifest.background?.type === 'module', 'Firefox background scripts must stay module-based');
  assert(!manifest.background?.service_worker, 'Firefox target manifest must not include Chrome-only background.service_worker');
  assert(gecko?.id === FIREFOX_GECKO_ID, 'Firefox manifest must include the Gate 0 Gecko ID');
  const requiredDataPermissions = gecko?.data_collection_permissions?.required ?? [];
  assert(
    includesAll(requiredDataPermissions, FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS),
    'Firefox manifest must declare required data_collection_permissions for GitHub API and Gist sync data transfer',
  );
  assert(!requiredDataPermissions.includes('none'), 'Firefox manifest must not declare no data collection while using GitHub API and Gist sync');
  assert(manifest.permissions?.includes('storage'), 'Firefox manifest must keep storage permission');
  assert(manifest.host_permissions?.includes('https://api.github.com/*'), 'Firefox manifest must keep GitHub API host permission');
  assert(manifest.host_permissions?.includes('https://github.com/*'), 'Firefox manifest must keep GitHub host permission');
  assert(manifest.action?.default_popup, 'Firefox manifest must keep action.default_popup');
  assert(manifest.options_ui?.page, 'Firefox manifest must keep options_ui.page');
  assert(githubContentScripts.length >= 2, 'Firefox manifest must keep both GitHub content scripts');
}

function main() {
  const manifestPath = process.argv[2] ?? path.resolve(process.cwd(), 'dist-firefox/manifest.json');
  const manifest = readJsonFile(manifestPath);
  assertFirefoxManifestContract(manifest);
  console.log(`Firefox output contract ok: ${path.relative(process.cwd(), manifestPath)}`);
}

if (isCliEntry()) {
  main();
}
