#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { FIREFOX_GECKO_ID, FIREFOX_MIN_VERSION } from './build-firefox-extension.mjs';

const UNSAFE_ASSIGNMENT_DESCRIPTION = 'Due to both security and performance concerns, this may not be set using dynamic values which have not been adequately sanitized. This can lead to security issues or fairly serious performance degradation.';
const REVIEWED_WARNINGS = Object.freeze([
  Object.freeze({
    code: 'KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION',
    file: /^manifest\.json$/u,
    message: /^Manifest key not supported by the specified minimum Firefox for Android version$/u,
    description: /^"strict_min_version" requires Firefox for Android 140, which was released before version 142 introduced support for "browser_specific_settings\.gecko\.data_collection_permissions"\.$/u,
  }),
  ...Array.from({ length: 2 }, () => Object.freeze({
    code: 'UNSAFE_VAR_ASSIGNMENT',
    file: /^assets\/recommendation-entry-[A-Za-z0-9_-]+\.js$/u,
    message: /^Unsafe assignment to innerHTML$/u,
    description: new RegExp(`^${escapeRegExp(UNSAFE_ASSIGNMENT_DESCRIPTION)}$`, 'u'),
  })),
  Object.freeze({
    code: 'UNSAFE_VAR_ASSIGNMENT',
    file: /^assets\/mermaid-[A-Za-z0-9_-]+\.js$/u,
    message: /^Unsafe assignment to innerHTML$/u,
    description: new RegExp(`^${escapeRegExp(UNSAFE_ASSIGNMENT_DESCRIPTION)}$`, 'u'),
  }),
  Object.freeze({
    code: 'UNSAFE_VAR_ASSIGNMENT',
    file: /^assets\/mermaid-[A-Za-z0-9_-]+\.js$/u,
    message: /^Unsafe call to .+\.document\(\)\.write for argument 0$/u,
    description: new RegExp(`^${escapeRegExp(UNSAFE_ASSIGNMENT_DESCRIPTION)}$`, 'u'),
  }),
]);

export class FirefoxLintContractError extends Error {
  constructor(code, detail = 'Firefox lint result') {
    super(`${code}: ${detail}`);
    this.name = 'FirefoxLintContractError';
    this.code = code;
  }
}

export function assertFirefoxLintContract(report, options = {}) {
  if (!isPlainObject(report)) throw new FirefoxLintContractError('lint_report_invalid');
  const errors = requireArray(report.errors, 'lint_errors_invalid');
  const notices = requireArray(report.notices, 'lint_notices_invalid');
  const warnings = requireArray(report.warnings, 'lint_warnings_invalid');
  const summary = report.summary;
  if (!isPlainObject(summary)
    || summary.errors !== errors.length
    || summary.notices !== notices.length
    || summary.warnings !== warnings.length
    || report.count !== errors.length + notices.length + warnings.length) {
    throw new FirefoxLintContractError('lint_summary_invalid');
  }
  if (errors.length > 0) throw new FirefoxLintContractError('lint_errors_present', describeMessage(errors[0]));
  if (notices.length > 0) throw new FirefoxLintContractError('lint_notices_present', describeMessage(notices[0]));

  const metadata = report.metadata;
  if (!isPlainObject(metadata)
    || metadata.id !== FIREFOX_GECKO_ID
    || metadata.manifestVersion !== 3
    || metadata.version !== (options.expectedVersion ?? pkg.version)
    || metadata.firefoxMinVersion !== FIREFOX_MIN_VERSION) {
    throw new FirefoxLintContractError('lint_metadata_invalid');
  }

  const unmatched = [...warnings];
  for (const contract of REVIEWED_WARNINGS) {
    const matchIndex = unmatched.findIndex((warning) => matchesWarning(warning, contract));
    if (matchIndex < 0) throw new FirefoxLintContractError('reviewed_warning_missing', contract.code);
    unmatched.splice(matchIndex, 1);
  }
  if (unmatched.length > 0) {
    throw new FirefoxLintContractError('unreviewed_warning_present', describeMessage(unmatched[0]));
  }

  return Object.freeze({ errors: 0, notices: 0, reviewedWarnings: warnings.length });
}

export function runFirefoxLint(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const sourceDir = path.resolve(root, options.sourceDir ?? 'dist-firefox');
  const webExtCli = path.resolve(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
  const result = spawnSync(
    process.execPath,
    [webExtCli, 'lint', '--source-dir', sourceDir, '--output', 'json'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) throw new FirefoxLintContractError('lint_process_failed', result.error.message);

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    const detail = String(result.stderr || result.stdout || `exit ${String(result.status)}`).trim();
    throw new FirefoxLintContractError('lint_output_invalid', detail);
  }
  const validated = assertFirefoxLintContract(report, options);
  if (result.status !== 0) throw new FirefoxLintContractError('lint_process_failed', `exit ${String(result.status)}`);
  return Object.freeze({ ...validated, sourceDir });
}

function matchesWarning(warning, contract) {
  return isPlainObject(warning)
    && warning.code === contract.code
    && contract.file.test(warning.file)
    && contract.message.test(warning.message)
    && contract.description.test(warning.description);
}

function requireArray(value, code) {
  if (!Array.isArray(value)) throw new FirefoxLintContractError(code);
  return value;
}

function describeMessage(value) {
  if (!isPlainObject(value)) return String(value);
  return [value.code, value.file, value.message].filter((part) => typeof part === 'string').join(': ');
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runFirefoxLint();
    console.log(`Firefox lint contract ok: ${result.errors} errors, ${result.notices} notices, ${result.reviewedWarnings} reviewed warnings.`);
  } catch (error) {
    console.error(`Firefox lint failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
