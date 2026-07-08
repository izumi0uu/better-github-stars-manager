#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isBuiltLoaderContentScript(script) {
  return (
    script.run_at === 'document_idle' &&
    (script.js ?? []).some((entry) => /^assets\/.+-loader-[\w-]+\.js$/.test(entry))
  );
}

function isCliEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

export function assertChromeManifestContract(manifest) {
  const contentScripts = manifest.content_scripts ?? [];
  const githubContentScripts = contentScripts.filter((script) => script.matches?.includes('https://github.com/*'));
  const contentScriptEntries = githubContentScripts.flatMap((script) => script.js ?? []);
  const hasSourceEntries =
    contentScriptEntries.includes('src/content/stars-page/index.tsx') &&
    contentScriptEntries.includes('src/content/repo-chip/index.tsx');
  const hasBuiltLoaderEntries = githubContentScripts.length >= 2 && githubContentScripts.every(isBuiltLoaderContentScript);

  assert(manifest.manifest_version === 3, 'Chrome manifest must be MV3');
  assert(manifest.background?.service_worker, 'Chrome manifest must define background.service_worker');
  assert(manifest.background?.type === 'module', 'Chrome background service worker must stay module-based');
  assert(!manifest.background?.scripts, 'Chrome manifest must not include Firefox-only background.scripts');
  assert(!manifest.browser_specific_settings?.gecko, 'Chrome manifest must not include Gecko release metadata');
  assert(manifest.permissions?.includes('storage'), 'Chrome manifest must keep storage permission');
  assert(manifest.host_permissions?.includes('https://api.github.com/*'), 'Chrome manifest must keep GitHub API host permission');
  assert(manifest.host_permissions?.includes('https://github.com/*'), 'Chrome manifest must keep GitHub host permission');
  assert(manifest.action?.default_popup, 'Chrome manifest must keep action.default_popup');
  assert(manifest.options_ui?.page, 'Chrome manifest must keep options_ui.page');
  assert(Array.isArray(manifest.content_scripts), 'Chrome manifest must keep content_scripts');
  assert(githubContentScripts.length >= 2, 'Chrome manifest must keep both GitHub content scripts');
  assert(hasSourceEntries || hasBuiltLoaderEntries, 'Chrome manifest must keep source content entries or built loader entries');
}

export function chromePreservationRows() {
  return [
    {
      surface: 'build',
      invariant: 'pnpm build writes root dist/manifest.json',
      protectedTest: 'pnpm build && pnpm check:chrome-output',
      breakingSymptom: 'Chrome packaging cannot find the manifest',
      rollback: 'Revert output directory or target split',
    },
    {
      surface: 'package',
      invariant: 'GSM_SKIP_PACKAGE_BUILD=true pnpm package:extension packages root dist',
      protectedTest: 'GSM_SKIP_PACKAGE_BUILD=true pnpm package:extension',
      breakingSymptom: 'Chrome artifact is missing or includes the wrong target output',
      rollback: 'Restore scripts/package-extension.mjs to root dist',
    },
    {
      surface: 'manifest',
      invariant: 'Chrome manifest uses module service worker and excludes Firefox-only keys',
      protectedTest: 'pnpm test:contracts',
      breakingSymptom: 'Chrome extension rejects or ignores the background contract',
      rollback: 'Revert Chrome manifest generation to manifest.config.ts',
    },
  ];
}

function main() {
  const manifestPath = process.argv[2] ?? path.resolve(process.cwd(), 'dist/manifest.json');
  const manifest = readJsonFile(manifestPath);
  assertChromeManifestContract(manifest);
  console.log(`Chrome output contract ok: ${path.relative(process.cwd(), manifestPath)}`);
}

if (isCliEntry()) {
  main();
}
