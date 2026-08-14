import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { buildOrganizeFailureDiagnostic } from './organize-job-extension-host.mjs';

const HOST = path.resolve('tests/runtime/organize-job-extension-host.mjs');

for (const recovery of [false, true]) {
  test(`Organize ${recovery ? 'recovery ' : ''}evidence is exact, bounded, and private`, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'bgsm-organize-evidence-'));
    try {
      const result = spawnSync(process.execPath, [HOST], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          GSM_ORGANIZE_EVIDENCE_SELF_TEST: '1',
          GSM_RUNTIME_EVIDENCE_DIR: directory,
          ...(recovery ? { GSM_RUNTIME_WORKER_RECOVERY: '1' } : {}),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      const filename = recovery
        ? 'organize-job-recovery.schema.json'
        : 'organize-job.schema.json';
      const output = path.join(directory, filename);
      const bytes = readFileSync(output);
      assert.equal(bytes.byteLength <= 32 * 1024, true);
      assert.equal(bytes.at(-1), 10);
      assert.equal(statSync(output).mode & 0o777, 0o600);
      const evidence = JSON.parse(bytes.toString('utf8'));
      assert.deepEqual(Object.keys(evidence), [
        'schemaVersion',
        'status',
        'proofScope',
        'productionDistExercised',
        'releaseDist',
        recovery ? 'organizeRecovery' : 'organize',
        'containment',
        'cleanup',
        'evidenceBytes',
      ]);
      assert.equal(evidence.evidenceBytes, bytes.byteLength);
      assert.equal(evidence.productionDistExercised, true);
      assert.equal(evidence.containment.unexpectedNetworkRequests, 0);
      assert.equal(evidence.containment.rawCredentialOccurrences, 0);
      assert.equal(evidence.containment.privatePayloadOccurrences, 0);
      assert.equal(JSON.stringify(evidence).includes('github_pat_runtime_organize_only'), false);
      assert.equal(JSON.stringify(evidence).includes('runtime-organize-origin-draft'), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('Organize failure diagnostics preserve the primary stage and expose exact bounded cleanup facts', () => {
  const diagnostic = buildOrganizeFailureDiagnostic({
    recovery: true,
    primaryStage: 'production_full_sync',
    cleanupFailures: [
      'browser_close',
      'provider_health',
      'private-unknown-cleanup-kind',
      'browser_close',
    ],
    cleanup: {
      networkGatesClosed: true,
      diagnosticsDetached: true,
      pagesClosed: false,
      browserClosed: false,
      temporaryStateRemoved: true,
      privatePayload: 'runtime-organize-origin-draft-a',
    },
    providerFailures: Number.MAX_SAFE_INTEGER,
    providerFailureKinds: [
      { stage: 'releaseStall', kind: 'analyzer-stall', privatePayload: 'runtime-organize-origin-draft-a' },
      { stage: 'fail_closed_cleanup', kind: 'unexpected-http' },
      { stage: 'private-stage', kind: 'private-kind' },
    ],
    unexpectedNetworkRequests: 2,
    pageIssues: 3,
    unexpectedRequestKinds: [
      { method: 'GET', route: 'github-repository', url: 'https://github.com/private' },
      { method: 'POST', route: 'unexpected-private-route' },
    ],
    pageIssueKinds: [
      { kind: 'page-error', value: 'runtime-organize-origin-draft-a' },
    ],
    overflow: true,
    error: new Error('github_pat_runtime_organize_only'),
  });

  assert.deepEqual(diagnostic, {
    replacementFailureCode: 'none',
    schemaVersion: 1,
    status: 'failed',
    proofScope: 'packaged_organize_recovery',
    primaryStage: 'production_full_sync',
    primaryCode: 'production_full_sync_failed',
    cleanupCode: 'cleanup_incomplete',
    cleanupFailures: ['provider_health', 'browser_close'],
    providerFailures: 1_000_000,
    providerFailureKinds: [
      { stage: 'releaseStall', kind: 'analyzer-stall' },
      { stage: 'fail_closed_cleanup', kind: 'unexpected-http' },
      { stage: 'provider_interception', kind: 'provider_request' },
    ],
    unexpectedNetworkRequests: 2,
    pageIssues: 3,
    unexpectedRequestKinds: ['GET_github-repository', 'POST_unexpected-http'],
    pageIssueKinds: ['page-error'],
    overflow: true,
    cleanup: {
      networkGatesClosed: true,
      diagnosticsDetached: true,
      pagesClosed: false,
      browserClosed: false,
      temporaryStateRemoved: true,
    },
  });
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes('github_pat_runtime_organize_only'), false);
  assert.equal(serialized.includes('runtime-organize-origin-draft-a'), false);
  assert.equal(serialized.includes('private-unknown-cleanup-kind'), false);
  assert.equal(/https?:\/\//iu.test(serialized), false);
});

test('Organize provider failure kinds are ordered, normalized, and capped', () => {
  const diagnostic = buildOrganizeFailureDiagnostic({
    primaryStage: 'worker_recovery_cleanup',
    providerFailureKinds: Array.from({ length: 20 }, (_, index) => ({
      stage: index % 2 === 0 ? 'requestPaused' : 'private-stage',
      kind: index % 2 === 0 ? 'analyzer' : 'private-kind',
    })),
  });
  assert.equal(diagnostic.providerFailureKinds.length, 16);
  assert.deepEqual(diagnostic.providerFailureKinds.slice(0, 2), [
    { stage: 'requestPaused', kind: 'analyzer' },
    { stage: 'provider_interception', kind: 'provider_request' },
  ]);
});

test('Organize worker recovery failures retain bounded semantic stages', () => {
  for (const stage of [
    'install_exact_provider_runtime',
    'worker_recovery_start',
    'worker_recovery_stall',
    'worker_recovery_pause_before_expiry',
    'worker_recovery_pause_after_expiry',
    'worker_recovery_detach_port',
    'worker_recovery_pause_after_detach',
    'worker_recovery_replacement',
    'worker_recovery_replacement_pause_wakeups',
    'worker_recovery_replacement_preinstall_entry',
    'worker_recovery_replacement_preinstall_stalled_count',
    'worker_recovery_replacement_preinstall_stopped_interruption',
    'worker_recovery_replacement_resume_wakeups',
    'worker_recovery_replacement_retire_client',
    'worker_recovery_replacement_post_replace',
    'worker_recovery_reconnect',
    'worker_recovery_settle',
    'worker_recovery_cleanup',
  ]) {
    const diagnostic = buildOrganizeFailureDiagnostic({ primaryStage: stage });
    assert.equal(diagnostic.primaryStage, stage);
    assert.equal(diagnostic.primaryCode, `${stage}_failed`);
  }
});

test('Organize catalog refresh and selection failures retain bounded host-only sub-stages', () => {
  for (const stage of [
    'mount_two_content_pages_catalog_page_b_foreground',
    'mount_two_content_pages_catalog_page_b_navigation',
    'mount_two_content_pages_catalog_page_b_entry',
    'mount_two_content_pages_catalog_page_b_drawer',
    'mount_two_content_pages_catalog_selection',
  ]) {
    const diagnostic = buildOrganizeFailureDiagnostic({
      primaryStage: stage,
      cleanup: {},
      error: new Error('runtime-organize-origin-draft-a'),
    });
    assert.equal(diagnostic.primaryStage, stage);
    assert.equal(diagnostic.primaryCode, `${stage}_failed`);
    assert.equal(JSON.stringify(diagnostic).includes('runtime-organize-origin-draft-a'), false);
  }
});

test('Organize origin deletion failures retain bounded semantic sub-stages', () => {
  for (const stage of [
    'trusted_origin_deletion_terminal_precheck',
    'trusted_origin_deletion_replacement_create',
    'trusted_origin_deletion_replacement_create_authority_snapshot',
    'trusted_origin_deletion_replacement_create_click',
    'trusted_origin_deletion_replacement_create_new_current',
    'trusted_origin_deletion_replacement_create_controller_settle',
    'trusted_origin_deletion_replacement_create_catalog_origin_presence',
    'trusted_origin_deletion_replacement_create_close',
    'trusted_origin_deletion_page_b_refresh',
    'trusted_origin_deletion_page_b_catalog',
    'trusted_origin_deletion_origin_reselect',
    'trusted_origin_deletion_drafts',
    'trusted_origin_deletion_trusted_delete',
    'trusted_origin_deletion_trusted_delete_catalog_open',
    'trusted_origin_deletion_trusted_delete_exact_row_delete_hit',
    'trusted_origin_deletion_trusted_delete_confirmation_ready',
    'trusted_origin_deletion_trusted_delete_confirm_hit',
    'trusted_origin_deletion_trusted_delete_committed_menu_close',
    'trusted_origin_deletion_invalidation_convergence',
    'trusted_origin_deletion_invalidation_convergence_composer_drafts',
    'trusted_origin_deletion_invalidation_convergence_transcript_retry',
    'trusted_origin_deletion_invalidation_convergence_terminal_projection',
    'trusted_origin_deletion_invalidation_convergence_catalog_open_page_a',
    'trusted_origin_deletion_invalidation_convergence_catalog_open_page_b',
    'trusted_origin_deletion_invalidation_convergence_catalog_open',
    'trusted_origin_deletion_invalidation_convergence_catalog_projection',
    'trusted_origin_deletion_invalidation_convergence_catalog_close',
    'trusted_origin_deletion_durable_authority',
  ]) {
    const diagnostic = buildOrganizeFailureDiagnostic({
      primaryStage: stage,
      cleanup: {},
      error: new Error('runtime-organize-origin-draft-a'),
    });
    assert.equal(diagnostic.primaryStage, stage);
    assert.equal(diagnostic.primaryCode, `${stage}_failed`);
    assert.equal(JSON.stringify(diagnostic).includes('runtime-organize-origin-draft-a'), false);
  }
});

test('Organize cleanup-only diagnostics distinguish completed behavior from cleanup failure', () => {
  const diagnostic = buildOrganizeFailureDiagnostic({
    primaryStage: 'runtime_complete',
    cleanupFailures: ['network_gates_open', 'cleanup_state_incomplete'],
    cleanup: {},
  });
  assert.equal(diagnostic.primaryStage, 'runtime_complete');
  assert.equal(diagnostic.primaryCode, 'none');
  assert.equal(diagnostic.cleanupCode, 'cleanup_incomplete');
  assert.deepEqual(diagnostic.cleanupFailures, ['network_gates_open', 'cleanup_state_incomplete']);
});
