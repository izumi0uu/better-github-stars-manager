#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIREFOX_DIST_DIR = 'dist-firefox';
export const FIREFOX_GECKO_ID = 'better-github-stars-manager@example.com';
export const FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS = [
  'authenticationInfo',
  'websiteActivity',
  'websiteContent',
];


export function createFirefoxManifest(chromeManifest) {
  const backgroundScript = chromeManifest.background?.service_worker;
  if (!backgroundScript) throw new Error('Chrome manifest must define background.service_worker before Firefox conversion');

  const firefoxManifest = {
    ...chromeManifest,
    background: {
      scripts: [backgroundScript],
      type: 'module',
    },
    browser_specific_settings: {
      ...(chromeManifest.browser_specific_settings ?? {}),
      gecko: {
        ...((chromeManifest.browser_specific_settings ?? {}).gecko ?? {}),
        id: FIREFOX_GECKO_ID,
        data_collection_permissions: {
          required: FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS,
        },
      },
    },
  };

  return firefoxManifest;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isCliEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function main() {
  const root = process.cwd();
  const chromeDist = path.resolve(root, 'dist');
  const firefoxDist = path.resolve(root, FIREFOX_DIST_DIR);
  const chromeManifestPath = path.join(chromeDist, 'manifest.json');
  const firefoxManifestPath = path.join(firefoxDist, 'manifest.json');

  if (process.env.GSM_SKIP_FIREFOX_SOURCE_BUILD !== 'true') {
    execFileSync('pnpm', ['build:chrome'], {
      cwd: root,
      stdio: 'inherit',
    });
  }

  if (!existsSync(chromeManifestPath)) {
    throw new Error(`No Chrome manifest found at ${chromeManifestPath}. Run "pnpm build:chrome" first.`);
  }

  rmSync(firefoxDist, { recursive: true, force: true });
  mkdirSync(firefoxDist, { recursive: true });
  cpSync(chromeDist, firefoxDist, { recursive: true });

  const firefoxManifest = createFirefoxManifest(readJson(chromeManifestPath));
  writeFileSync(firefoxManifestPath, `${JSON.stringify(firefoxManifest, null, 2)}\n`);

  console.log(`Firefox build written: ${path.relative(root, firefoxDist)}`);
  console.log('Firefox background strategy: target-specific MV3 event page scripts with module loader');
}

if (isCliEntry()) {
  main();
}
