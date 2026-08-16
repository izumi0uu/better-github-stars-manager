#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildExtensionBrowserLaunchOptions,
  normalizePuppeteerDriver,
  resolveExecutablePath,
} from './puppeteer-runtime.mjs';
import {
  FIREFOX_GECKO_ID,
  FIREFOX_TEST_UUID,
} from '../../scripts/build-firefox-extension.mjs';

const chromeOptions = buildExtensionBrowserLaunchOptions({
  dist: '/tmp/dist',
  userDataDir: '/tmp/profile',
  executablePath: '/tmp/chrome',
});
assert.equal(chromeOptions.browser, undefined);
assert.equal(chromeOptions.args.includes('--load-extension=/tmp/dist'), true);
assert.equal(chromeOptions.extraPrefsFirefox, undefined);

const firefoxOptions = buildExtensionBrowserLaunchOptions({
  target: 'firefox',
  dist: '/tmp/dist-firefox',
  userDataDir: '/tmp/firefox-profile',
  executablePath: '/tmp/firefox',
});
assert.equal(firefoxOptions.browser, 'firefox');
assert.equal(firefoxOptions.args.some((argument) => argument.startsWith('--load-extension=')), false);
assert.deepEqual(
  JSON.parse(firefoxOptions.extraPrefsFirefox['extensions.webextensions.uuids']),
  { [FIREFOX_GECKO_ID]: FIREFOX_TEST_UUID },
);
assert.equal(firefoxOptions.extraPrefsFirefox['ui.prefersReducedMotion'], 1);
assert.equal(firefoxOptions.extraPrefsFirefox['extensions.webextOptionalPermissionPrompts'], false);
assert.equal(normalizePuppeteerDriver(), 'default');
assert.equal(normalizePuppeteerDriver('firefox_140'), 'firefox_140');
assert.throws(() => normalizePuppeteerDriver('firefox_141'), /Unsupported Puppeteer driver/u);
console.log('✓ puppeteer runtime preserves Chrome defaults and configures real Firefox launch');

try {
  const executablePath = await resolveExecutablePath();

  assert.equal(typeof executablePath, 'string');
  assert.ok(executablePath.length > 0, 'expected a non-empty browser executable path');

  console.log('✓ puppeteer runtime resolves a concrete executable path');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  assert.match(
    message,
    /pnpm exec puppeteer browsers install chrome|PUPPETEER_EXECUTABLE_PATH/,
  );
  console.log('✓ puppeteer runtime reports actionable browser-install guidance');
}
