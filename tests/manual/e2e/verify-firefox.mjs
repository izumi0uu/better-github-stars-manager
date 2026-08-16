#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FIREFOX_RUNTIME_SCENARIO_IDS } from '../../../scripts/agent-runtime-release-evidence.mjs';
import { runFirefoxExtensionSmoke } from '../../runtime/firefox-extension-smoke.mjs';

export { FIREFOX_RUNTIME_SCENARIO_IDS };

export function resolveFirefoxVerificationRuns(environment = process.env) {
  const configured = [
    ['firefox_140', environment.FIREFOX_140_EXECUTABLE],
    ['stable', environment.FIREFOX_STABLE_EXECUTABLE],
  ];
  const missing = configured
    .filter(([, executablePath]) => typeof executablePath !== 'string' || executablePath.length === 0)
    .map(([role]) => role === 'firefox_140' ? 'FIREFOX_140_EXECUTABLE' : 'FIREFOX_STABLE_EXECUTABLE');
  if (missing.length > 0) {
    throw new Error(
      `test:verify-firefox requires both FIREFOX_140_EXECUTABLE and FIREFOX_STABLE_EXECUTABLE. Missing: ${missing.join(', ')}.`,
    );
  }
  for (const [role, executablePath] of configured) {
    if (!existsSync(executablePath)) {
      throw new Error(`${role} Firefox executable does not exist: ${executablePath}`);
    }
  }
  return Object.freeze(configured.map(([role, executablePath]) => Object.freeze({ role, executablePath })));
}

export async function verifyFirefoxBrowsers(options = {}) {
  const runs = options.runs ?? resolveFirefoxVerificationRuns(options.environment);
  const results = [];
  for (const run of runs) {
    const result = await runFirefoxExtensionSmoke({
      dist: options.dist,
      executablePath: run.executablePath,
      puppeteerDriver: run.role === 'firefox_140' ? 'firefox_140' : 'default',
    });
    const version = parseReportedFirefoxVersion(result.browserVersion);
    if (run.role === 'firefox_140' && version.major !== 140) {
      throw new Error(`FIREFOX_140_EXECUTABLE reported ${result.browserVersion}; expected Firefox 140.x.`);
    }
    if (run.role === 'stable' && version.major <= 140) {
      throw new Error(`FIREFOX_STABLE_EXECUTABLE reported ${result.browserVersion}; expected a current stable Firefox newer than 140.x.`);
    }
    results.push(Object.freeze({
      role: run.role,
      executablePath: run.executablePath,
      reportedVersion: version.value,
      result,
    }));
  }
  return Object.freeze({ browserTarget: 'firefox', runs: Object.freeze(results) });
}

export function parseReportedFirefoxVersion(browserVersion) {
  const match = /^Firefox\/(\d+(?:\.\d+)+)$/u.exec(browserVersion);
  assert.ok(match, `Firefox returned an unexpected browser version: ${String(browserVersion)}`);
  const major = Number(match[1].split('.')[0]);
  return Object.freeze({ major, value: match[1] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyFirefoxBrowsers().then((evidence) => {
    for (const run of evidence.runs) {
      console.log(`${run.role}: Firefox ${run.reportedVersion} (${run.executablePath})`);
    }
    console.log(JSON.stringify(evidence));
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
