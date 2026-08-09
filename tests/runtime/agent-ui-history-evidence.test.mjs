import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { validateRuntimeEvidenceFile } from '../../scripts/agent-runtime-release-evidence.mjs';

const HOST = path.resolve('tests/runtime/agent-ui-history-extension-host.mjs');
const COMPOSITION = path.resolve('tests/runtime/agent-runtime-composition.mjs');
const FILENAME = 'agent-ui-history.schema-v1.json';

test('UI/history producer publishes the exact private schema-v1 envelope', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bgsm-ui-history-evidence-'));
  try {
    const result = spawnSync(process.execPath, [HOST], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        GSM_UI_HISTORY_EVIDENCE_SELF_TEST: '1',
        GSM_RUNTIME_EVIDENCE_DIR: directory,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');

    const output = path.join(directory, FILENAME);
    const bytes = readFileSync(output);
    assert.equal(bytes.byteLength <= 32 * 1024, true);
    assert.equal(bytes.at(-1), 10);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(output).mode & 0o777, 0o600);

    const evidence = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(Object.keys(evidence), [
      'schemaVersion',
      'status',
      'proofScope',
      'productionDistExercised',
      'releaseDist',
      'uiHistory',
      'containment',
      'cleanup',
      'evidenceBytes',
    ]);
    assert.equal(evidence.evidenceBytes, bytes.byteLength);
    assert.equal(evidence.productionDistExercised, true);
    assert.deepEqual(Object.keys(evidence.cleanup), [
      'networkGatesClosed',
      'diagnosticsDetached',
      'pagesClosed',
      'browserClosed',
      'temporaryStateRemoved',
    ]);
    assert.deepEqual(evidence.containment, {
      networkFailClosed: true,
      unexpectedNetworkRequests: 0,
      rawCredentialOccurrences: 0,
      privatePayloadOccurrences: 0,
      overflow: false,
    });
    assert.equal(Object.hasOwn(evidence, 'source'), false);
    assert.equal(Object.hasOwn(evidence, 'commit'), false);
    assert.equal(JSON.stringify(evidence).includes('github_pat_runtime_ui_history_only'), false);
    assert.equal(JSON.stringify(evidence).includes('runtime-ui-history-submitted-prompt-canary'), false);

    const validated = validateRuntimeEvidenceFile('uiHistory', bytes.toString('utf8'), {
      releaseDist: evidence.releaseDist,
    });
    assert.equal(validated.value.proofScope, 'packaged_ui_history');
    assert.equal(validated.file.relativePath, FILENAME);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('UI/history schema remains compatible with the runtime composer', () => {
  const result = spawnSync(process.execPath, [COMPOSITION, '--self-test'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /ok - valid composition binds all producer files/u);
  assert.match(result.stdout, /ok - stale production identity is rejected/u);
});
