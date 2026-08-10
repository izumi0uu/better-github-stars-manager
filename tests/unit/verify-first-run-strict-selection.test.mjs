import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

const VERIFY_FIRST_RUN = path.resolve('tests/manual/e2e/verify-first-run.mjs');
const SCENARIO_ENV_KEYS = [
  'GH_TOKEN',
  'GH_TOKEN_NO_GISTS',
  'GH_USER',
  'GH_TOKEN_INVALID',
  'GSM_RESET_GIST',
];

function runVerifyFirstRun(root, args, environment = {}) {
  const env = {
    ...process.env,
    // Any browser launch makes the ordinary skipped invocation fail deterministically.
    PUPPETEER_EXECUTABLE_PATH: path.join(root, 'chrome-must-not-launch'),
  };
  for (const key of SCENARIO_ENV_KEYS) delete env[key];
  Object.assign(env, environment);

  return spawnSync(process.execPath, [VERIFY_FIRST_RUN, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`;
}

test('selected valid-token skips without Chrome and strict mode fails closed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verify-first-run-strict-'));

  try {
    mkdirSync(path.join(root, 'dist'));
    writeFileSync(path.join(root, 'dist', 'manifest.json'), '{}\n');

    const ordinary = runVerifyFirstRun(root, ['--scenario=valid-token']);
    assert.equal(ordinary.error, undefined, ordinary.error?.message);
    assert.equal(ordinary.status, 0, outputOf(ordinary));
    assert.match(ordinary.stdout, /Summary:\n - valid-token: skipped/u);

    const strict = runVerifyFirstRun(root, ['--scenario=valid-token', '--require-selected']);
    assert.equal(strict.error, undefined, strict.error?.message);
    assert.equal(strict.status, 1, outputOf(strict));
    assert.match(strict.stdout, /Summary:\n - valid-token: skipped/u);
    assert.match(strict.stderr, /--require-selected: selected scenario\(s\) skipped: valid-token/u);
    assert.doesNotMatch(strict.stdout, /Profile:/u);

    const missingToken = runVerifyFirstRun(
      root,
      ['--scenario=valid-token', '--require-selected'],
      { GH_USER: 'fixture-user' },
    );
    assert.equal(missingToken.error, undefined, missingToken.error?.message);
    assert.equal(missingToken.status, 1, outputOf(missingToken));
    assert.match(missingToken.stdout, /valid-token: skipped — Missing required env/u);
    assert.match(missingToken.stderr, /selected scenario\(s\) skipped: valid-token/u);
    assert.doesNotMatch(missingToken.stdout, /Profile:/u);

    const unknown = runVerifyFirstRun(root, ['--scenario=unknown', '--require-selected']);
    assert.equal(unknown.error, undefined, unknown.error?.message);
    assert.equal(unknown.status, 1, outputOf(unknown));
    assert.match(unknown.stderr, /Unknown --scenario selection: unknown/u);
    assert.doesNotMatch(unknown.stdout, /Summary:/u);

    const empty = runVerifyFirstRun(root, ['--scenario=', '--require-selected']);
    assert.equal(empty.error, undefined, empty.error?.message);
    assert.equal(empty.status, 1, outputOf(empty));
    assert.match(empty.stderr, /empty --scenario selection/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
