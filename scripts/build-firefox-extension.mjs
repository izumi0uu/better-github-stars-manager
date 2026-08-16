#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIREFOX_DIST_DIR = 'dist-firefox';
export const FIREFOX_GECKO_ID = '{5aeb7340-40e6-428d-9566-f3cacbe06352}';
export const FIREFOX_TEST_UUID = '5aeb7340-40e6-428d-9566-f3cacbe06352';
export const FIREFOX_MIN_VERSION = '140.0';
export const FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS = Object.freeze([
  'authenticationInfo',
  'websiteActivity',
  'websiteContent',
]);
export const FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS = Object.freeze([
  'personalCommunications',
]);

export function createFirefoxManifest(chromeManifest) {
  if (!isPlainObject(chromeManifest)) {
    throw new TypeError('Chrome manifest must be an object');
  }

  const chromeBackground = chromeManifest.background;
  const backgroundScript = chromeBackground?.service_worker;
  if (!isPlainObject(chromeBackground) || typeof backgroundScript !== 'string' || backgroundScript.length === 0) {
    throw new Error('Chrome manifest must define a non-empty background.service_worker before Firefox conversion');
  }

  const browserSpecificSettings = isPlainObject(chromeManifest.browser_specific_settings)
    ? chromeManifest.browser_specific_settings
    : {};
  const background = {
    ...chromeBackground,
    scripts: [backgroundScript],
    type: 'module',
  };
  delete background.service_worker;

  return {
    ...chromeManifest,
    background,
    browser_specific_settings: {
      ...browserSpecificSettings,
      gecko: {
        id: FIREFOX_GECKO_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        data_collection_permissions: {
          required: [...FIREFOX_REQUIRED_DATA_COLLECTION_PERMISSIONS],
          optional: [...FIREFOX_OPTIONAL_DATA_COLLECTION_PERMISSIONS],
        },
      },
    },
  };
}

export function buildFirefoxExtension(options = {}) {
  const environment = options.environment ?? process.env;
  const root = path.resolve(options.root ?? process.cwd());
  const chromeDistDir = path.resolve(root, options.chromeDistDir ?? 'dist');
  const firefoxDistDir = path.resolve(root, options.firefoxDistDir ?? FIREFOX_DIST_DIR);

  if (chromeDistDir === firefoxDistDir) {
    throw new Error('Chrome and Firefox output directories must be different');
  }
  if (!options.skipChromeBuild) {
    runChromeProductionBuild({ root, chromeDistDir, environment, runner: options.buildRunner });
  }


  const outputParent = path.dirname(firefoxDistDir);
  mkdirSync(outputParent, { recursive: true });
  const stagingRoot = mkdtempSync(path.join(outputParent, `.${path.basename(firefoxDistDir)}-`));
  const stagedDistDir = path.join(stagingRoot, path.basename(firefoxDistDir));
  let firefoxManifest;
  try {
    cpSync(chromeDistDir, stagedDistDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const chromeManifest = readJson(path.join(stagedDistDir, 'manifest.json'), 'staged Chrome manifest');
    firefoxManifest = createFirefoxManifest(chromeManifest);
    writeFileSync(
      path.join(stagedDistDir, 'manifest.json'),
      `${JSON.stringify(firefoxManifest, null, 2)}\n`,
    );
    rmSync(firefoxDistDir, { recursive: true, force: true });
    renameSync(stagedDistDir, firefoxDistDir);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  return Object.freeze({
    chromeDistDir,
    firefoxDistDir,
    manifest: firefoxManifest,
  });
}

function runChromeProductionBuild({ root, chromeDistDir, environment, runner }) {
  if (runner) {
    runner({
      root,
      chromeDistDir,
      environment: productionBuildEnvironment(environment, chromeDistDir),
    });
    return;
  }

  const pnpmExecPath = environment.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const args = pnpmExecPath ? [pnpmExecPath, 'build:chrome'] : ['pnpm', 'build:chrome'];
  const result = spawnSync(command, args, {
    cwd: root,
    env: productionBuildEnvironment(environment, chromeDistDir),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Chrome production build exited on signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`Chrome production build failed with status ${result.status}`);
}

function productionBuildEnvironment(environment, chromeDistDir) {
  return {
    ...environment,
    GSM_DEV: 'false',
    GSM_RELEASE: 'true',
    GSM_STORE_TARGET: 'chrome',
    GSM_DIST_DIR: chromeDistDir,
  };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${filePath}`, { cause: error });
  }
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildFirefoxExtension();
    console.log(`Firefox build written: ${path.relative(process.cwd(), result.firefoxDistDir)}`);
  } catch (error) {
    console.error(`Firefox build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
