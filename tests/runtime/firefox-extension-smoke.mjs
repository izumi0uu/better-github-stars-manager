#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FIREFOX_DIST_DIR,
  FIREFOX_GECKO_ID,
} from '../../scripts/build-firefox-extension.mjs';
import {
  FIREFOX_RUNTIME_SCENARIO_IDS,
  runExtensionBrowserSmoke,
} from './extension-browser-smoke.mjs';

export async function runFirefoxExtensionSmoke(options = {}) {
  const result = await runExtensionBrowserSmoke({
    target: 'firefox',
    dist: path.resolve(options.dist ?? FIREFOX_DIST_DIR),
    executablePath: options.executablePath,
    puppeteerDriver: options.puppeteerDriver,
  });
  assert.equal(result.browserTarget, 'firefox');
  assert.equal(result.realBrowser, true);
  assert.equal(result.extensionId, FIREFOX_GECKO_ID);
  assert.deepEqual(result.background, { kind: 'event_page', module: true });
  assert.deepEqual(result.scenarioIds, FIREFOX_RUNTIME_SCENARIO_IDS);
  assert.deepEqual(result.diagnostics, {
    observedPageErrors: 0,
    observedBackgroundErrors: 0,
    observedUncaughtErrors: 0,
    backgroundObservation: 'post_startup_guarded_intervals',
    startupHealthChecks: 2,
  });
  assert.match(result.browserVersion, /^Firefox\/\d+(?:\.\d+)+$/u);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFirefoxExtensionSmoke({
    executablePath: process.env.FIREFOX_EXECUTABLE,
  }).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
