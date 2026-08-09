#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import {
  createFileEvidence,
  FINAL_CHECK_SPECS,
  parseViteChunkAdvisories,
  RUNTIME_EVIDENCE_CONTRACTS,
  validateProvisionalReleaseEvidence,
  validateReleaseVersionApproval,
  validateRuntimeEvidenceFile,
  validateRuntimeVerificationEvidence,
} from './agent-runtime-release-evidence.mjs';
import { readRuntimeReleaseDistIdentity } from './agent-runtime-evidence-contract.mjs';
import { packageInputFingerprint } from './package-input-fingerprint.mjs';
import {
  discoverMermaidArtifacts,
  enforceWorkerReleaseBaseline,
  measureBundleArtifact,
  resolvePackagePath,
} from './package-manifest-closure.mjs';

const EXPECTED_SCENARIO_IDS = Object.freeze([
  'small-window-multiple-tools',
  'overflow-then-success',
  'malformed-summary-fallback',
  'cancel-during-compaction',
  'agent-port-disconnect',
  'organize-cross-batch-recovery',
  'organize-cancel-during-apply',
  'organize-port-reconnect',
  'cubby-artifact-continuation-coverage',
]);
const PACKAGE_INPUT_CHECKPOINTS = new Set([
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
]);
export const AGENT_PROVIDER_ADAPTER_TEST_FILES = Object.freeze([
  'tests/unit/agent-provider-openai-responses.test.ts',
  'tests/unit/agent-provider-openai-compatible.test.ts',
  'tests/unit/agent-provider-anthropic.test.ts',
  'tests/unit/agent-provider-registry.test.ts',
  'tests/unit/agent-provider-error-translation.test.ts',
]);
export const RELEASE_CHILD_AMBIENT_ENVIRONMENT_ALLOWLIST = Object.freeze([
  'CI',
  'COLORTERM',
  'COREPACK_HOME',
  'FORCE_COLOR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'PATH',
  'PNPM_HOME',
  'PUPPETEER_EXECUTABLE_PATH',
  'PUPPETEER_HEADLESS',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);
export const RELEASE_CHILD_COMMAND_ENVIRONMENT_ALLOWLIST = Object.freeze([
  'GSM_APPROVED_RELEASE_VERSION',
  'GSM_ARTIFACTS_DIR',
  'GSM_DEV',
  'GSM_DIST_DIR',
  'GSM_RELEASE',
  'GSM_RELEASE_BUILD_EVIDENCE',
  'GSM_RUNTIME_EVIDENCE_DIR',
  'GSM_SKIP_PACKAGE_BUILD',
  'GSM_TESTED_PACKAGE_INPUT',
  'GSM_VERSION_APPROVAL',
]);

export async function runAgentRuntimeVerification({
  root = process.cwd(),
  env = process.env,
  packageVersion = pkg.version,
  operations = {},
} = {}) {
  const resolvedRoot = path.resolve(root);
  const distDir = path.resolve(resolvedRoot, env.GSM_DIST_DIR ?? 'dist');
  const versionApproval = parseVersionApproval(env.GSM_VERSION_APPROVAL);
  validateReleaseVersionApproval(versionApproval, packageVersion);

  const defaults = createDefaultOperations(resolvedRoot, env);
  const ops = { ...defaults, ...operations };
  assertCleanSource(ops.git, 'Agent runtime verification must start from a clean source tree.');
  const sourceCommit = ops.git(['rev-parse', 'HEAD']);
  const { artifactsDir, runtimeEvidenceDir } = createFreshRunDirectories({
    root: resolvedRoot,
    requestedArtifactsDir: env.GSM_ARTIFACTS_DIR,
  });
  const outputPath = path.join(artifactsDir, 'agent-runtime-verification.json');
  const provisionalPath = path.join(artifactsDir, `release-evidence-${packageVersion}.provisional.json`);
  const sharedEnvironment = {
    GSM_ARTIFACTS_DIR: artifactsDir,
    GSM_DIST_DIR: distDir,
    GSM_RUNTIME_EVIDENCE_DIR: runtimeEvidenceDir,
    GSM_VERSION_APPROVAL: canonical(versionApproval).trimEnd(),
    GSM_APPROVED_RELEASE_VERSION: versionApproval.approvedCandidateVersion,
  };

  const checks = {};
  const fingerprintCheckpoints = [];
  let releaseDist;
  let testedPackageInput;
  let buildEvidence;
  let runtimeEvidence;

  for (const spec of FINAL_CHECK_SPECS) {
    if (spec.key === 'bundleBudget') {
      requireBuildState(releaseDist, testedPackageInput, buildEvidence);
      checks[spec.key] = internalCheck(spec, ops.now, {
        worker: buildEvidence.worker,
        mermaid: buildEvidence.mermaid,
        advisories: buildEvidence.advisories,
      });
      continue;
    }
    if (spec.key === 'agentProviderAdapterContracts') {
      checks[spec.key] = await ops.runAdapterContracts(spec, sharedEnvironment);
      const current = ops.fingerprint(distDir);
      assertFingerprintStable(testedPackageInput, current, 'Provider adapter contracts changed the production package input.');
      fingerprintCheckpoints.push(checkpoint(spec.key, current));
      continue;
    }
    if (spec.key === 'packageInputStable') {
      assertFingerprintStable(testedPackageInput, ops.fingerprint(distDir), 'Runtime hosts changed the production package input.');
      checks[spec.key] = internalCheck(spec, ops.now, { checkpoints: fingerprintCheckpoints });
      continue;
    }

    const stepEnvironment = spec.key === 'productionBuild'
      ? { ...sharedEnvironment, GSM_RELEASE: 'true', GSM_DEV: 'false' }
      : spec.key === 'packageExtension'
        ? {
            ...sharedEnvironment,
            GSM_SKIP_PACKAGE_BUILD: 'true',
            GSM_TESTED_PACKAGE_INPUT: canonical(testedPackageInput).trimEnd(),
            GSM_RELEASE_BUILD_EVIDENCE: canonical(buildEvidence).trimEnd(),
          }
        : sharedEnvironment;
    checks[spec.key] = await ops.runPnpmScript(spec, stepEnvironment, {
      captureOutput: spec.key === 'productionBuild',
    });

    if (spec.key === 'productionBuild') {
      releaseDist = ops.readReleaseDist(distDir);
      testedPackageInput = ops.fingerprint(distDir);
      buildEvidence = ops.measureBuild({
        distDir,
        releaseDist,
        commandOutput: checks[spec.key].capturedOutput,
      });
      checks[spec.key] = withoutCapturedOutput(checks[spec.key]);
      fingerprintCheckpoints.push(checkpoint('productionBuild', testedPackageInput));
    } else if (PACKAGE_INPUT_CHECKPOINTS.has(spec.key)) {
      const current = ops.fingerprint(distDir);
      assertFingerprintStable(testedPackageInput, current, `${spec.key} changed the production package input.`);
      fingerprintCheckpoints.push(checkpoint(spec.key, current));
      if (spec.key === 'agentRuntimeComposition') {
        runtimeEvidence = ops.collectRuntimeEvidence({ runtimeEvidenceDir, releaseDist });
      }
    } else if (spec.key === 'packageExtension') {
      const current = ops.fingerprint(distDir);
      assertFingerprintStable(testedPackageInput, current, 'Packaging changed the production package input.');
      fingerprintCheckpoints.push(checkpoint('packageExtension', current));
    }
  }

  requireBuildState(releaseDist, testedPackageInput, buildEvidence);
  if (!runtimeEvidence) throw new Error('Runtime evidence was not collected.');
  assertSourceUnchanged(ops.git, sourceCommit, 'Agent runtime verification changed tracked, untracked, or committed source.');
  assertFingerprintStable(testedPackageInput, ops.fingerprint(distDir), 'Packaging changed the verified production package input.');
  const provisionalRaw = ops.readRequiredFile(provisionalPath, 'Missing immutable provisional release evidence.');
  const provisional = parseCanonical(provisionalRaw, 'provisional release evidence');
  ops.validateProvisional(provisional, {
    sourceCommit,
    packageVersion,
    packageInput: testedPackageInput,
    releaseDist,
    build: buildEvidence,
  });
  const provisionalReleaseEvidence = createFileEvidence(path.basename(provisionalPath), provisionalRaw);
  const evidence = {
    schemaVersion: 2,
    generatedAt: ops.now(),
    executionAuthority: 'durable_agent_runtime_release_plan',
    source: { commit: sourceCommit, dirty: false },
    packageVersion,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    checks: Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, stripPrivateCheckFields(value)])),
    build: {
      packageInput: testedPackageInput,
      worker: buildEvidence.worker,
      mermaid: buildEvidence.mermaid,
      advisories: buildEvidence.advisories,
      outputSha256: buildEvidence.outputSha256,
    },
    runtimeEvidence: runtimeEvidence.files,
    provisionalReleaseEvidence,
    status: 'agent_runtime_verification_passed',
  };
  ops.validateRuntimeVerification(evidence, {
    sourceCommit,
    releaseDist,
    packageVersion,
    packageInput: testedPackageInput,
    runtimeEvidence: runtimeEvidence.files,
  });

  assertSourceUnchanged(ops.git, sourceCommit, 'Source changed while validating Agent runtime evidence.');
  assertFingerprintStable(testedPackageInput, ops.fingerprint(distDir), 'Package input changed while validating Agent runtime evidence.');
  const provisionalAfterValidation = ops.readRequiredFile(
    provisionalPath,
    'Immutable provisional release evidence disappeared during validation.',
  );
  if (!Buffer.from(provisionalRaw).equals(Buffer.from(provisionalAfterValidation))) {
    throw new Error('Immutable provisional release evidence changed during validation.');
  }
  if (existsSync(outputPath)) throw new Error('Agent runtime verification evidence already exists.');
  ops.writeEvidenceAtomic(outputPath, canonical(evidence));
  console.log(`Verified Agent runtime and wrote ${path.relative(resolvedRoot, outputPath)}`);
  return Object.freeze({ artifactsDir, runtimeEvidenceDir, outputPath, evidence });
}

export function createFreshRunDirectories({ root, requestedArtifactsDir }) {
  const artifactsDir = requestedArtifactsDir
    ? path.resolve(root, requestedArtifactsDir)
    : path.resolve(root, 'artifacts');
  mkdirSync(path.dirname(artifactsDir), { recursive: true, mode: 0o700 });
  if (existsSync(artifactsDir)) {
    const entry = lstatSync(artifactsDir);
    if (!entry.isDirectory() || entry.isSymbolicLink() || readdirSync(artifactsDir).length !== 0) {
      throw new Error('GSM_ARTIFACTS_DIR must be a fresh empty run-scoped directory.');
    }
    chmodSync(artifactsDir, 0o700);
  } else {
    mkdirSync(artifactsDir, { mode: 0o700 });
  }
  const runtimeEvidenceDir = path.join(artifactsDir, 'runtime-evidence');
  if (existsSync(runtimeEvidenceDir)) throw new Error('Runtime evidence directory already exists.');
  mkdirSync(runtimeEvidenceDir, { mode: 0o700 });
  return Object.freeze({ artifactsDir, runtimeEvidenceDir });
}

export function collectAndValidateRuntimeEvidence({ runtimeEvidenceDir, releaseDist }) {
  const expectedEntries = Object.values(RUNTIME_EVIDENCE_CONTRACTS)
    .map(({ filename }) => filename)
    .sort(bytewiseCompare);
  const actualEntries = readdirSync(runtimeEvidenceDir).sort(bytewiseCompare);
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`Runtime evidence set mismatch: expected ${expectedEntries.join(', ')}, received ${actualEntries.join(', ')}.`);
  }
  const files = {};
  for (const key of ['artifact', 'workerRecovery', 'uiHistory', 'organize', 'organizeRecovery', 'scenarioLab', 'runtimeComposition']) {
    const contract = RUNTIME_EVIDENCE_CONTRACTS[key];
    const raw = readFileSync(path.join(runtimeEvidenceDir, contract.filename));
    const validated = validateRuntimeEvidenceFile(key, raw, {
      releaseDist,
      relativePath: contract.filename,
      runtimeFiles: files,
      expectedScenarioIds: EXPECTED_SCENARIO_IDS,
    });
    files[key] = validated.file;
  }
  return Object.freeze({ files: Object.freeze(files) });
}

export function measureProductionBuild({ distDir, releaseDist, commandOutput }) {
  const parsed = parseViteChunkAdvisories(commandOutput);
  const workerBytes = readFileSync(resolvePackagePath(distDir, releaseDist.worker.relativePath, 'production worker'));
  const worker = measureBundleArtifact({ relativePath: releaseDist.worker.relativePath, bytes: workerBytes });
  enforceWorkerReleaseBaseline(worker);
  const mermaid = discoverMermaidArtifacts(collectNamedJavaScript(distDir, /^mermaid-[A-Za-z0-9._-]+\.js$/u));
  return Object.freeze({
    worker,
    mermaid,
    advisories: parsed.advisories,
    outputSha256: parsed.outputSha256,
  });
}

function createDefaultOperations(root, baseEnvironment) {
  return {
    git: (args) => runGit(root, args),
    now: () => new Date().toISOString(),
    fingerprint: packageInputFingerprint,
    readReleaseDist: readRuntimeReleaseDistIdentity,
    measureBuild: measureProductionBuild,
    collectRuntimeEvidence: collectAndValidateRuntimeEvidence,
    readRequiredFile: (filePath, message) => {
      if (!existsSync(filePath)) throw new Error(message);
      return readFileSync(filePath);
    },
    validateProvisional: validateProvisionalReleaseEvidence,
    validateRuntimeVerification: validateRuntimeVerificationEvidence,
    writeEvidenceAtomic,
    runPnpmScript: (spec, commandEnv, options) => executePnpmScript(root, baseEnvironment, spec, commandEnv, options),
    runAdapterContracts: (spec, commandEnv) => executeAdapterContracts(root, baseEnvironment, spec, commandEnv),
  };
}

async function executePnpmScript(root, baseEnvironment, spec, commandEnv, { captureOutput = false } = {}) {
  const pnpmExecPath = baseEnvironment.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const script = spec.command.split('pnpm ').at(-1);
  const args = pnpmExecPath ? [pnpmExecPath, script] : ['pnpm', script];
  return executeCommand({ root, baseEnvironment, spec, command, args, commandEnv, captureOutput });
}

async function executeAdapterContracts(root, baseEnvironment, spec, commandEnv) {
  const pnpmExecPath = baseEnvironment.npm_execpath;
  const command = pnpmExecPath ? process.execPath : 'corepack';
  const args = pnpmExecPath
    ? [pnpmExecPath, 'exec', 'vitest', 'run', ...AGENT_PROVIDER_ADAPTER_TEST_FILES]
    : ['pnpm', 'exec', 'vitest', 'run', ...AGENT_PROVIDER_ADAPTER_TEST_FILES];
  return executeCommand({ root, baseEnvironment, spec, command, args, commandEnv, captureOutput: false });
}

export function createReleaseChildEnvironment(baseEnvironment, commandEnvironment) {
  const childEnvironment = {};
  for (const key of RELEASE_CHILD_AMBIENT_ENVIRONMENT_ALLOWLIST) {
    if (typeof baseEnvironment[key] === 'string') childEnvironment[key] = baseEnvironment[key];
  }
  for (const key of Object.keys(commandEnvironment)) {
    if (!RELEASE_CHILD_COMMAND_ENVIRONMENT_ALLOWLIST.includes(key)) {
      throw new Error(`Release child environment key is not allowed: ${key}.`);
    }
    if (typeof commandEnvironment[key] !== 'string') {
      throw new Error(`Release child environment value must be a string: ${key}.`);
    }
    childEnvironment[key] = commandEnvironment[key];
  }
  return childEnvironment;
}

function executeCommand({ root, baseEnvironment, spec, command, args, commandEnv, captureOutput }) {
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const stdoutHash = createHash('sha256');
    const stderrHash = createHash('sha256');
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    const child = spawn(command, args, {
      cwd: root,
      env: createReleaseChildEnvironment(baseEnvironment, commandEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const consume = (streamName, chunk) => {
      const bytes = Buffer.from(chunk);
      (streamName === 'stdout' ? stdoutHash : stderrHash).update(bytes);
      (streamName === 'stdout' ? process.stdout : process.stderr).write(bytes);
      if (captureOutput) {
        capturedBytes += bytes.byteLength;
        if (capturedBytes > 8 * 1024 * 1024) {
          child.kill('SIGTERM');
          reject(new Error(`${spec.key} output exceeded the bounded capture limit.`));
          return;
        }
        (streamName === 'stdout' ? stdout : stderr).push(bytes);
      }
    };
    child.stdout.on('data', (chunk) => consume('stdout', chunk));
    child.stderr.on('data', (chunk) => consume('stderr', chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) return reject(new Error(`${spec.key} terminated by ${signal}.`));
      if (code !== 0) return reject(new Error(`${spec.key} failed with exit code ${code}.`));
      const stdoutSha256 = stdoutHash.digest('hex');
      const stderrSha256 = stderrHash.digest('hex');
      resolve({
        status: 'passed',
        command: spec.command,
        startedAt,
        finishedAt: new Date().toISOString(),
        outputSha256: hash(Buffer.from(`${stdoutSha256}\n${stderrSha256}\n`)),
        ...(captureOutput ? { capturedOutput: { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') } } : {}),
      });
    });
  });
}

function internalCheck(spec, now, value) {
  const startedAt = now();
  const outputSha256 = hash(Buffer.from(canonical(value)));
  const finishedAt = now();
  return { status: 'passed', command: spec.command, startedAt, finishedAt, outputSha256 };
}

export function writeEvidenceAtomic(destination, bytes) {
  if (existsSync(destination)) throw new Error('Agent runtime verification evidence already exists.');
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function collectNamedJavaScript(root, filenamePattern) {
  const entries = [];
  const visit = (relativeDirectory) => {
    const absoluteDirectory = path.join(root, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && filenamePattern.test(entry.name)) {
        entries.push({ relativePath: relativePath.split(path.sep).join('/'), bytes: readFileSync(path.join(root, relativePath)) });
      }
    }
  };
  visit('');
  return entries;
}

function parseCanonical(raw, label) {
  const text = raw.toString('utf8');
  const value = JSON.parse(text);
  if (`${JSON.stringify(value, null, 2)}\n` !== text) throw new Error(`${label} must use canonical JSON bytes.`);
  return value;
}

function parseVersionApproval(serialized) {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new Error('GSM_VERSION_APPROVAL must contain the explicit approved candidate version decision.');
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error('GSM_VERSION_APPROVAL must be valid JSON.');
  }
}

function assertCleanSource(git, message) {
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error(message);
}

function assertSourceUnchanged(git, sourceCommit, message) {
  assertCleanSource(git, message);
  if (git(['rev-parse', 'HEAD']) !== sourceCommit) throw new Error(message);
}

function runGit(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function assertFingerprintStable(expected, actual, message) {
  if (!sameFingerprint(expected, actual)) throw new Error(message);
}

function sameFingerprint(left, right) {
  return left?.algorithm === 'sha256'
    && left.algorithm === right?.algorithm
    && left.fileCount === right.fileCount
    && left.sha256 === right.sha256;
}

function checkpoint(after, fingerprint) {
  return { after, fingerprint };
}

function requireBuildState(releaseDist, testedPackageInput, buildEvidence) {
  if (!releaseDist || !testedPackageInput || !buildEvidence) throw new Error('Production build evidence is unavailable.');
}

function withoutCapturedOutput(check) {
  const { capturedOutput: _capturedOutput, ...publicCheck } = check;
  return publicCheck;
}

function stripPrivateCheckFields(check) {
  return withoutCapturedOutput(check);
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runAgentRuntimeVerification();
