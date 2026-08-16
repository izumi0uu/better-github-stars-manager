import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { FINAL_CHECK_SPECS, FIREFOX_RUNTIME_SCENARIO_IDS, RUNTIME_EVIDENCE_CONTRACTS } from '../../scripts/agent-runtime-release-evidence.mjs';
import {
  AGENT_PROVIDER_ADAPTER_TEST_FILES,
  createFreshRunDirectories,
  createReleaseChildEnvironment,
  runAgentRuntimeVerification,
  writeEvidenceAtomic,
} from '../../scripts/run-agent-runtime-verification.mjs';
import { FIREFOX_GECKO_ID } from '../../scripts/build-firefox-extension.mjs';

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const VERSION = '1.0.9';
const FINGERPRINT = Object.freeze({ algorithm: 'sha256', fileCount: 3, sha256: SHA });
const RELEASE_DIST = Object.freeze({
  packageInput: FINGERPRINT,
  manifest: { relativePath: 'manifest.json', bytes: 100, sha256: SHA, manifestVersion: 3, extensionVersion: VERSION },
  loader: { relativePath: 'service-worker-loader.js', bytes: 10, sha256: SHA },
  worker: { relativePath: 'assets/worker.js', bytes: 100, sha256: SHA },
});
const FIREFOX_FINGERPRINT = Object.freeze({ algorithm: 'sha256', fileCount: 3, sha256: 'c'.repeat(64) });
const FIREFOX_RELEASE_DIST = Object.freeze({
  browserTarget: 'firefox',
  packageInput: FIREFOX_FINGERPRINT,
  manifest: { ...RELEASE_DIST.manifest, sha256: 'd'.repeat(64) },
  loader: RELEASE_DIST.loader,
  worker: RELEASE_DIST.worker,
});
const FIREFOX_SHARED_CHROME_RUNTIME_CHECKS = new Set([
  'organizeJobExtensionHost',
  'organizeJobRecovery',
  'agentDiagnosticsReleaseIsolation',
  'agentScenariosExtensionHost',
  'agentArtifactExtensionHost',
  'agentWorkerRecoveryExtensionHost',
  'agentUiHistoryExtensionHost',
  'agentRuntimeComposition',
]);
const BUILD = Object.freeze({
  worker: { relativePath: 'assets/worker.js', bytes: 100, kib: 100 / 1024, sha256: SHA },
  mermaid: [],
  advisories: [],
  outputSha256: SHA,
});
const RUNTIME_FILES = Object.freeze(Object.fromEntries(Object.entries(RUNTIME_EVIDENCE_CONTRACTS).map(([key, contract]) => [
  key,
  { relativePath: contract.filename, bytes: 10, sha256: SHA },
])));

const EXPECTED_CHECK_KEYS = Object.freeze([
  'typecheck',
  'fullVitest',
  'logic',
  'regressions',
  'productionBuild',
  'bundleBudget',
  'runtime',
  'extensionSmoke',
  'organizeJobExtensionHost',
  'organizeJobRecovery',
  'agentDiagnosticsReleaseIsolation',
  'agentScenariosExtensionHost',
  'agentArtifactExtensionHost',
  'agentWorkerRecoveryExtensionHost',
  'agentUiHistoryExtensionHost',
  'agentRuntimeComposition',
  'agentProviderAdapterContracts',
  'packageInputStable',
  'packageExtension',
]);

function approval() {
  return JSON.stringify({
    approvedCandidateVersion: VERSION,
    observedCurrentPublicVersion: '1.0.8',
    observedPriorUploadVersion: '1.0.8',
  });
}

function check(spec, index, capturedOutput = undefined) {
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString();
  const finishedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2 + 1)).toISOString();
  return {
    status: 'passed',
    command: spec.command,
    startedAt,
    finishedAt,
    outputSha256: SHA,
    ...(capturedOutput ? { capturedOutput } : {}),
  };
}

function successfulOperations(overrides = {}) {
  let commandIndex = 0;
  return {
    git: (args) => args[0] === 'status' ? '' : COMMIT,
    now: () => new Date(Date.UTC(2026, 0, 1, 1, 0, commandIndex += 1)).toISOString(),
    fingerprint: () => FINGERPRINT,
    readReleaseDist: () => RELEASE_DIST,
    measureBuild: () => BUILD,
    collectRuntimeEvidence: () => ({ files: RUNTIME_FILES }),
    readRequiredFile: () => Buffer.from('{}\n'),
    validateProvisional: (value) => value,
    validateRuntimeVerification: (value) => value,
    runPnpmScript: async (spec, _environment, options) => check(
      spec,
      commandIndex += 1,
      options.captureOutput ? { stdout: '', stderr: '' } : undefined,
    ),
    runAdapterContracts: async (spec) => check(spec, commandIndex += 1),
    ...overrides,
  };
}

test('runs the frozen behavior-named checks in order and publishes bounded schema-v2 evidence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-runtime-runner-'));
  const calls = [];
  const lifecycle = [];
  const commandEnvironments = [];
  const packageEnvironments = [];
  let clock = Date.UTC(2026, 0, 1, 1);
  let fingerprintReads = 0;
  try {
    const result = await runAgentRuntimeVerification({
      root,
      packageVersion: VERSION,
      env: { GSM_ARTIFACTS_DIR: 'run-evidence', GSM_VERSION_APPROVAL: approval() },
      operations: {
        git: (args) => args[0] === 'status' ? '' : COMMIT,
        now: () => new Date(clock += 1_000).toISOString(),
        fingerprint: () => { fingerprintReads += 1; return FINGERPRINT; },
        readReleaseDist: () => RELEASE_DIST,
        measureBuild: () => BUILD,
        collectRuntimeEvidence: () => {
          lifecycle.push('collectRuntimeEvidence');
          return { files: RUNTIME_FILES };
        },
        readRequiredFile: () => Buffer.from('{}\n'),
        validateProvisional: (value) => {
          lifecycle.push('validateProvisional');
          return value;
        },
        validateRuntimeVerification: (value) => {
          lifecycle.push('validateRuntimeVerification');
          return value;
        },
        runPnpmScript: async (spec, environment, options) => {
          calls.push(spec.key);
          lifecycle.push(spec.key);
          commandEnvironments.push([spec.key, environment]);
          if (spec.key === 'packageExtension') packageEnvironments.push(environment);
          return check(spec, calls.length, options.captureOutput ? { stdout: '', stderr: '' } : undefined);
        },
        runAdapterContracts: async (spec, environment) => {
          calls.push(spec.key);
          lifecycle.push(spec.key);
          commandEnvironments.push([spec.key, environment]);
          return check(spec, calls.length);
        },
      },
    });

    assert.deepEqual(FINAL_CHECK_SPECS.map(({ key }) => key), EXPECTED_CHECK_KEYS);
    assert.deepEqual(Object.keys(result.evidence.checks), EXPECTED_CHECK_KEYS);
    assert.deepEqual(calls, EXPECTED_CHECK_KEYS
      .filter((key) => !['bundleBudget', 'packageInputStable'].includes(key)));
    assert.equal(fingerprintReads, 16, 'fingerprints build, every production/variant host, adapters, package, and both final checkpoints');
    assert.equal(result.evidence.schemaVersion, 2);
    assert.equal(result.evidence.status, 'agent_runtime_verification_passed');
    assert.deepEqual(result.evidence.runtimeEvidence, RUNTIME_FILES);
    assert.equal(Object.hasOwn(result.evidence.runtimeEvidence, 'runtimeComposition'), true);
    assert.equal(Object.hasOwn(result.evidence.runtimeEvidence, 'composition'), false);
    assert.deepEqual(Object.keys(result.evidence.runtimeEvidence), [
      'artifact',
      'workerRecovery',
      'uiHistory',
      'organize',
      'organizeRecovery',
      'scenarioLab',
      'runtimeComposition',
    ]);
    assert.equal(result.evidence.provisionalReleaseEvidence.relativePath, `release-evidence-${VERSION}.provisional.json`);
    assert.equal(packageEnvironments.length, 1);
    assert.equal(packageEnvironments[0].GSM_SKIP_PACKAGE_BUILD, 'true');
    assert.equal(packageEnvironments[0].GSM_APPROVED_RELEASE_VERSION, VERSION);
    assert.deepEqual(JSON.parse(packageEnvironments[0].GSM_TESTED_PACKAGE_INPUT), FINGERPRINT);
    assert.deepEqual(JSON.parse(packageEnvironments[0].GSM_RELEASE_BUILD_EVIDENCE), BUILD);
    assert.equal(lifecycle.indexOf('collectRuntimeEvidence'), lifecycle.indexOf('agentRuntimeComposition') + 1);
    assert.ok(lifecycle.indexOf('collectRuntimeEvidence') < lifecycle.indexOf('agentProviderAdapterContracts'));
    assert.ok(lifecycle.indexOf('packageExtension') < lifecycle.indexOf('validateProvisional'));
    assert.ok(lifecycle.indexOf('validateProvisional') < lifecycle.indexOf('validateRuntimeVerification'));
    const expectedDist = path.join(root, 'dist');
    const expectedRuntimeEvidence = path.join(root, 'run-evidence', 'runtime-evidence');
    for (const [, environment] of commandEnvironments) {
      assert.equal(environment.GSM_DIST_DIR, expectedDist);
      assert.equal(environment.GSM_RUNTIME_EVIDENCE_DIR, expectedRuntimeEvidence);
    }
    assert.equal(statSync(result.outputPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(result.outputPath, 'utf8')), result.evidence);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maps the stable Firefox binary into child smoke commands and redacts executable paths from evidence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-runtime-firefox-'));
  const minimumExecutable = '/opt/firefox-140/firefox';
  const stableExecutable = '/opt/firefox-stable/firefox';
  const commandEnvironments = [];
  let commandIndex = 0;
  try {
    const result = await runAgentRuntimeVerification({
      root,
      packageVersion: VERSION,
      env: {
        GSM_VERSION_APPROVAL: approval(),
        GSM_BROWSER_TARGET: 'firefox',
        FIREFOX_140_EXECUTABLE: minimumExecutable,
        FIREFOX_STABLE_EXECUTABLE: stableExecutable,
      },
      operations: successfulOperations({
        fingerprint: (distDir) => path.basename(distDir) === 'dist-firefox'
          ? FIREFOX_FINGERPRINT
          : FINGERPRINT,
        readReleaseDist: (distDir) => path.basename(distDir) === 'dist-firefox'
          ? FIREFOX_RELEASE_DIST
          : RELEASE_DIST,
        collectRuntimeEvidence: ({ releaseDist }) => {
          assert.deepEqual(releaseDist, RELEASE_DIST);
          return { files: RUNTIME_FILES };
        },
        validateRuntimeVerification: (evidence, context) => {
          assert.deepEqual(context.releaseDist, FIREFOX_RELEASE_DIST);
          assert.deepEqual(context.sharedRuntimeReleaseDist, RELEASE_DIST);
          return evidence;
        },
        runPnpmScript: async (spec, environment, options) => {
          commandEnvironments.push([spec.key, environment]);
          return check(spec, commandIndex += 1, options.captureOutput ? { stdout: '', stderr: '' } : undefined);
        },
        runAdapterContracts: async (spec, environment) => {
          commandEnvironments.push([spec.key, environment]);
          return check(spec, commandIndex += 1);
        },
        runFirefoxBrowsers: async ({ runs }) => ({
          runs: runs.map((run) => {
            const browserVersion = run.role === 'firefox_140' ? '140.0.4' : '151.0';
            return {
              role: run.role,
              executablePath: run.executablePath,
              reportedVersion: browserVersion,
              result: {
                browserTarget: 'firefox',
                realBrowser: true,
                browserVersion,
                executablePath: run.executablePath,
                extensionId: FIREFOX_GECKO_ID,
                background: { kind: 'event_page', module: true },
                scenarioIds: [...FIREFOX_RUNTIME_SCENARIO_IDS],
                diagnostics: {
                  observedPageErrors: 0,
                  observedBackgroundErrors: 0,
                  observedUncaughtErrors: 0,
                  backgroundObservation: 'post_startup_guarded_intervals',
                  startupHealthChecks: 2,
                },
              },
            };
          }),
        }),
      }),
    });

    assert.ok(commandEnvironments.length > 0);
    for (const [key, environment] of commandEnvironments) {
      assert.equal(environment.FIREFOX_140_EXECUTABLE, minimumExecutable);
      assert.equal(environment.FIREFOX_EXECUTABLE, stableExecutable);
      assert.equal(environment.FIREFOX_STABLE_EXECUTABLE, stableExecutable);
      if (FIREFOX_SHARED_CHROME_RUNTIME_CHECKS.has(key)) {
        assert.equal(environment.GSM_BROWSER_TARGET, undefined);
        assert.equal(environment.GSM_PACKAGE_TARGET, undefined);
        assert.equal(environment.GSM_DIST_DIR, path.join(root, 'dist'));
      } else {
        assert.equal(environment.GSM_BROWSER_TARGET, 'firefox');
        assert.equal(environment.GSM_PACKAGE_TARGET, 'firefox');
        assert.equal(environment.GSM_DIST_DIR, path.join(root, 'dist-firefox'));
      }
    }
    assert.deepEqual(result.evidence.sharedRuntimeReleaseDist, RELEASE_DIST);
    assert.deepEqual(result.evidence.build.packageInput, FIREFOX_FINGERPRINT);
    const [minimum, stable] = result.evidence.firefox.runs;
    assert.equal(minimum.executablePathSha256, createHash('sha256').update(minimumExecutable).digest('hex'));
    assert.equal(stable.executablePathSha256, createHash('sha256').update(stableExecutable).digest('hex'));
    assert.equal(Object.hasOwn(minimum, 'executablePath'), false);
    assert.equal(Object.hasOwn(stable, 'executablePath'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires explicit version approval before creating evidence or running commands', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-runtime-approval-'));
  let commands = 0;
  try {
    await assert.rejects(
      runAgentRuntimeVerification({
        root,
        packageVersion: VERSION,
        env: { GSM_ARTIFACTS_DIR: 'must-not-exist' },
        operations: { runPnpmScript: async () => { commands += 1; } },
      }),
      /GSM_VERSION_APPROVAL/,
    );
    assert.equal(commands, 0);
    assert.equal(statSync(root).isDirectory(), true);
    assert.throws(() => statSync(path.join(root, 'must-not-exist')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts only a fresh empty run root and creates a private nested runtime evidence directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-runtime-root-'));
  try {
    const empty = path.join(root, 'empty');
    mkdirSync(empty);
    const created = createFreshRunDirectories({ root, requestedArtifactsDir: empty, runId: 'unused' });
    assert.equal(created.artifactsDir, empty);
    assert.equal(statSync(created.artifactsDir).mode & 0o777, 0o700);
    assert.equal(statSync(created.runtimeEvidenceDir).mode & 0o777, 0o700);

    const firefoxRoot = path.join(root, 'firefox-root');
    mkdirSync(firefoxRoot);
    const firefox = createFreshRunDirectories({ root: firefoxRoot, browserTarget: 'firefox' });
    assert.equal(firefox.artifactsDir, path.join(firefoxRoot, 'artifacts', 'firefox'));
    assert.equal(firefox.runtimeEvidenceDir, path.join(firefox.artifactsDir, 'runtime-evidence'));

    const reused = path.join(root, 'reused');
    mkdirSync(reused);
    writeFileSync(path.join(reused, 'stale.json'), '{}\n');
    assert.throws(
      () => createFreshRunDirectories({ root, requestedArtifactsDir: reused, runId: 'unused' }),
      /fresh empty run-scoped directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('passes only allowlisted ambient and runner-owned values to release children', () => {
  const environment = createReleaseChildEnvironment({
    PATH: '/safe/bin',
    HOME: '/safe/home',
    CI: 'true',
    PUPPETEER_HEADLESS: 'new',
    OPENAI_API_KEY: 'private-openai-key',
    GITHUB_TOKEN: 'private-github-token',
    GSM_ORGANIZE_EVIDENCE_SELF_TEST: '1',
    GSM_UI_HISTORY_EVIDENCE_SELF_TEST: '1',
    KEEP_ME: 'ambient-but-unapproved',
  }, {
    FIREFOX_140_EXECUTABLE: '/safe/firefox-140',
    FIREFOX_EXECUTABLE: '/safe/firefox-stable',
    FIREFOX_STABLE_EXECUTABLE: '/safe/firefox-stable',
    GSM_DIST_DIR: '/fresh/dist',
    GSM_RUNTIME_EVIDENCE_DIR: '/fresh/runtime-evidence',
  });

  assert.deepEqual(environment, {
    CI: 'true',
    HOME: '/safe/home',
    PATH: '/safe/bin',
    PUPPETEER_HEADLESS: 'new',
    FIREFOX_140_EXECUTABLE: '/safe/firefox-140',
    FIREFOX_EXECUTABLE: '/safe/firefox-stable',
    FIREFOX_STABLE_EXECUTABLE: '/safe/firefox-stable',
    GSM_DIST_DIR: '/fresh/dist',
    GSM_RUNTIME_EVIDENCE_DIR: '/fresh/runtime-evidence',
  });
  assert.throws(
    () => createReleaseChildEnvironment({}, { GSM_ORGANIZE_EVIDENCE_SELF_TEST: '1' }),
    /environment key is not allowed/,
  );
});

test('records the exact focused Provider adapter contract registry', () => {
  assert.deepEqual(AGENT_PROVIDER_ADAPTER_TEST_FILES, [
    'tests/unit/agent-provider-openai-responses.test.ts',
    'tests/unit/agent-provider-openai-compatible.test.ts',
    'tests/unit/agent-provider-anthropic.test.ts',
    'tests/unit/agent-provider-registry.test.ts',
    'tests/unit/agent-provider-error-translation.test.ts',
  ]);
});

test('rechecks clean HEAD after schema-v2 validation before publishing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-runtime-final-source-'));
  let revisionReads = 0;
  let validated = false;
  let published = false;
  try {
    await assert.rejects(runAgentRuntimeVerification({
      root,
      packageVersion: VERSION,
      env: { GSM_ARTIFACTS_DIR: 'run-evidence', GSM_VERSION_APPROVAL: approval() },
      operations: successfulOperations({
        git: (args) => {
          if (args[0] === 'status') return '';
          revisionReads += 1;
          return validated && revisionReads === 3 ? 'c'.repeat(40) : COMMIT;
        },
        validateRuntimeVerification: (value) => {
          validated = true;
          return value;
        },
        writeEvidenceAtomic: () => { published = true; },
      }),
    }), /Source changed while validating Agent runtime evidence/);
    assert.equal(published, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rechecks package input and immutable provisional bytes after schema-v2 validation', async () => {
  for (const failure of ['packageInput', 'provisional']) {
    const root = mkdtempSync(path.join(os.tmpdir(), `bgsm-runtime-final-${failure}-`));
    let validated = false;
    let provisionalReads = 0;
    let published = false;
    try {
      await assert.rejects(runAgentRuntimeVerification({
        root,
        packageVersion: VERSION,
        env: { GSM_ARTIFACTS_DIR: 'run-evidence', GSM_VERSION_APPROVAL: approval() },
        operations: successfulOperations({
          fingerprint: () => failure === 'packageInput' && validated
            ? { ...FINGERPRINT, sha256: 'c'.repeat(64) }
            : FINGERPRINT,
          readRequiredFile: () => {
            provisionalReads += 1;
            return Buffer.from(failure === 'provisional' && provisionalReads === 2 ? '{"changed":true}\n' : '{}\n');
          },
          validateRuntimeVerification: (value) => {
            validated = true;
            return value;
          },
          writeEvidenceAtomic: () => { published = true; },
        }),
      }), failure === 'packageInput'
        ? /Package input changed while validating Agent runtime evidence/
        : /Immutable provisional release evidence changed during validation/);
      assert.equal(published, false, `${failure} mutation must block publication`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('atomic publication refuses to overwrite an existing verification record', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bgsm-runtime-atomic-'));
  const destination = path.join(root, 'agent-runtime-verification.json');
  try {
    writeFileSync(destination, 'existing\n', { mode: 0o600 });
    assert.throws(() => writeEvidenceAtomic(destination, 'replacement\n'), /already exists/);
    assert.equal(readFileSync(destination, 'utf8'), 'existing\n');
    assert.deepEqual(readdirSync(root), ['agent-runtime-verification.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
