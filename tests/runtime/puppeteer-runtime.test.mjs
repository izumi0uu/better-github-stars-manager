#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildExtensionBrowserLaunchOptions,
  normalizePuppeteerDriver,
  prepareFirefox140ExtensionPage,
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
const firefoxFailClosedOptions = buildExtensionBrowserLaunchOptions({
  target: 'firefox',
  dist: '/tmp/dist-firefox',
  userDataDir: '/tmp/firefox-profile',
  executablePath: '/tmp/firefox',
  failClosedNetwork: true,
});
assert.equal(firefoxFailClosedOptions.extraPrefsFirefox['network.proxy.allow_hijacking_localhost'], true);
assert.equal(normalizePuppeteerDriver(), 'default');
assert.equal(normalizePuppeteerDriver('firefox_140'), 'firefox_140');
assert.throws(() => normalizePuppeteerDriver('firefox_141'), /Unsupported Puppeteer driver/u);
const predicateError = new Error('Firefox 140 predicate failed');
const preparedPage = prepareFirefox140ExtensionPage({
  evaluate: async () => {
    throw predicateError;
  },
});
await assert.rejects(
  () => preparedPage.waitForFunction(() => true, { polling: 1, timeout: 10 }),
  (error) => error === predicateError,
);
console.log('✓ puppeteer runtime preserves Chrome defaults and configures real Firefox launch');

const previousFirefoxExecutable = process.env.FIREFOX_EXECUTABLE;
const previousFirefox140Executable = process.env.FIREFOX_140_EXECUTABLE;
delete process.env.FIREFOX_EXECUTABLE;
delete process.env.FIREFOX_140_EXECUTABLE;
try {
  await assert.rejects(
    () => resolveExecutablePath({ target: 'firefox' }),
    /requires explicit executablePath or FIREFOX_EXECUTABLE.*--format '\{\{path\}\}'/u,
  );
  await assert.rejects(
    () => resolveExecutablePath({ target: 'firefox', puppeteerDriver: 'firefox_140' }),
    /requires explicit executablePath or FIREFOX_140_EXECUTABLE.*stable_140\.0\.4/u,
  );
} finally {
  if (previousFirefoxExecutable === undefined) delete process.env.FIREFOX_EXECUTABLE;
  else process.env.FIREFOX_EXECUTABLE = previousFirefoxExecutable;
  if (previousFirefox140Executable === undefined) delete process.env.FIREFOX_140_EXECUTABLE;
  else process.env.FIREFOX_140_EXECUTABLE = previousFirefox140Executable;
}
console.log('✓ puppeteer runtime requires explicit Firefox executable provenance');

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
