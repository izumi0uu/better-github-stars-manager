import { describe, expect, it } from 'vitest';
import {
  canContinueOrganizeJobRun,
  CONNECTION_INTERRUPTED_COPY,
  createAgentWorkbenchState,
  currentOrganizeJobState,
  displayedAnalyzedRepositoryCount,
  isDurableOrganizeJobAuthoritative,
  reduceAgentWorkbench,
  type WorkbenchPendingCommand,
  WORKER_LOST_COPY,
} from '@/ui/agent-workbench-state';
import {
  parseControllerId,
  parseProposalId,
  parseRunId,
} from '@/bgsm-agent/identity';
import {
  createFrozenScope,
  parseContinuationCursorToken,
  parsePreflightToken,
  parseScopeFingerprintV1,
  projectFrozenScope,
} from '@/bgsm-agent/scope';
import {
  createEmptyRunBudgetUsage,
  createProductionRunBudget,
} from '@/bgsm-agent/policy';
import type { OrganizeJobRunSnapshot } from '@/bgsm-agent/events';
import type { BgsmOrganizeJobPresentation } from '@/utils/messaging';

const controllerId = parseControllerId('controller:v1:ui-test');
const sessionId = 'ui-session';
const runId = parseRunId('run:v1:parent');
const proposalId = parseProposalId('proposal:v1:parent');

describe('Agent workbench durable organize-job reducer', () => {
  it('serializes organize commands and makes synchronous send failures retryable', () => {
    let state = deliverJob(
      withSnapshot({ ...baseSnapshot(), state: 'review', proposalId }),
      presentation(),
    );
    state = reduceAgentWorkbench(state, {
      type: 'organize_command_requested',
      command: pendingCommand('apply-current', 'apply_selection'),
    });

    expect(state.pendingCommand).toEqual(pendingCommand('apply-current', 'apply_selection'));
    expect(reduceAgentWorkbench(state, {
      type: 'organize_command_requested',
      command: pendingCommand('apply-duplicate', 'apply_selection'),
    })).toBe(state);
    expect(reduceAgentWorkbench(state, {
      type: 'organize_command_send_failed',
      commandId: 'apply-stale',
    })).toBe(state);

    const failed = reduceAgentWorkbench(state, {
      type: 'organize_command_send_failed',
      commandId: 'apply-current',
    });
    expect(failed.pendingCommand).toBeNull();
    expect(failed.error).toBe(CONNECTION_INTERRUPTED_COPY);

    const retrying = reduceAgentWorkbench(failed, {
      type: 'organize_command_requested',
      command: pendingCommand('apply-retry', 'apply_selection'),
    });
    expect(retrying.pendingCommand?.id).toBe('apply-retry');
    expect(retrying.error).toBeNull();
  });

  it('holds organize commands until their matching authoritative transition arrives', () => {
    const applyProgress = {
      applyId: 'organize-apply:v1:pending-command',
      total: 2,
      settled: 0,
      changed: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    };

    let applySelection = deliverJob(
      withSnapshot({ ...baseSnapshot(), state: 'review', proposalId }),
      presentation(),
    );
    applySelection = reduceAgentWorkbench(applySelection, {
      type: 'organize_command_requested',
      command: pendingCommand('apply-selection', 'apply_selection'),
    });
    const staleApplying = deliverJob(applySelection, {
      ...presentation(),
      status: 'applying',
      apply: applyProgress,
    });
    expect(staleApplying.pendingCommand?.kind).toBe('apply_selection');
    const unchangedReview = deliverJob(staleApplying, {
      ...presentation(),
      revision: 8,
    });
    expect(unchangedReview.pendingCommand?.kind).toBe('apply_selection');
    const applying = deliverJob(unchangedReview, {
      ...presentation(),
      revision: 9,
      status: 'applying',
      apply: applyProgress,
    });
    expect(applying.pendingCommand).toBeNull();

    let pauseApply = reduceAgentWorkbench(applying, {
      type: 'organize_command_requested',
      command: pendingCommand('pause-apply', 'pause_apply', 9),
    });
    pauseApply = deliverJob(pauseApply, {
      ...presentation(),
      revision: 10,
      status: 'applying',
      apply: applyProgress,
    });
    expect(pauseApply.pendingCommand?.kind).toBe('pause_apply');
    const paused = deliverJob(pauseApply, {
      ...presentation(),
      revision: 11,
      status: 'paused',
      apply: applyProgress,
    });
    expect(paused.pendingCommand).toBeNull();

    let resumeApply = reduceAgentWorkbench(paused, {
      type: 'organize_command_requested',
      command: pendingCommand('resume-apply', 'resume_apply', 11),
    });
    resumeApply = deliverJob(resumeApply, {
      ...presentation(),
      revision: 12,
      status: 'paused',
      apply: applyProgress,
    });
    expect(resumeApply.pendingCommand?.kind).toBe('resume_apply');
    const resumed = deliverJob(resumeApply, {
      ...presentation(),
      revision: 13,
      status: 'applying',
      apply: applyProgress,
    });
    expect(resumed.pendingCommand).toBeNull();
  });

  it('keeps Stop pending through active snapshots and clears it on a terminal result', () => {
    let state = withSnapshot(baseSnapshot());
    state = reduceAgentWorkbench(state, {
      type: 'organize_command_requested',
      command: pendingCommand('stop-analysis', 'stop_analysis', null),
    });

    const stillAnalyzing = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot: baseSnapshot() },
    });
    expect(stillAnalyzing.pendingCommand?.kind).toBe('stop_analysis');

    const stopped = reduceAgentWorkbench(stillAnalyzing, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunResult',
        controllerId,
        sessionId,
        runId,
        generation: 1,
        snapshot: {
          ...baseSnapshot(),
          state: 'cancelled',
          terminalReason: 'user_stopped',
        },
      },
    });
    expect(stopped.pendingCommand).toBeNull();
  });

  it('clears a pending organize command only when the run error matches its request', () => {
    let state = withSnapshot(baseSnapshot());
    state = reduceAgentWorkbench(state, {
      type: 'organize_command_requested',
      command: pendingCommand('stop-error', 'stop_analysis', null),
    });

    const unrelated = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunError',
        controllerId,
        sessionId,
        runId,
        generation: 1,
        requestId: 'another-command',
        reason: 'internal_error',
        message: 'An unrelated request failed.',
      },
    });
    expect(unrelated.pendingCommand?.id).toBe('stop-error');
    expect(unrelated.error).toBeNull();

    const failed = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunError',
        controllerId,
        sessionId,
        runId,
        generation: 1,
        requestId: 'stop-error',
        reason: 'internal_error',
        message: 'Stop failed.',
      },
    });
    expect(failed.pendingCommand).toBeNull();
    expect(failed.error).toBe('Stop failed.');

    const retrying = reduceAgentWorkbench(failed, {
      type: 'organize_command_requested',
      command: pendingCommand('stop-disconnect', 'stop_analysis', null),
    });
    const disconnected = reduceAgentWorkbench(retrying, { type: 'transport_disconnected' });
    expect(disconnected.pendingCommand).toBeNull();
  });

  it('keeps reconnecting after the connection handshake until authoritative state arrives', () => {
    const active = deliverJob(withSnapshot(baseSnapshot()), {
      ...presentation(),
      status: 'analyzing',
    });
    const disconnected = reduceAgentWorkbench(active, { type: 'transport_disconnected' });
    const handshake = reduceAgentWorkbench(disconnected, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunConnectionReady',
        controllerId,
        sessionId,
      },
    });

    expect(handshake.transport).toBe('disconnected');
    expect(handshake.snapshot?.runId).toBe(runId);
    expect(handshake.organizeJob?.jobId).toBe(presentation().jobId);

    const restored = reduceAgentWorkbench(handshake, {
      type: 'server_message',
      authoritative: true,
      message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot: baseSnapshot() },
    });
    expect(restored.transport).toBe('connected');
  });

  it('clears stale organize state when an authoritative reconnect reports no active job', () => {
    const active = deliverJob(withSnapshot(baseSnapshot()), {
      ...presentation(),
      status: 'analyzing',
    });
    const disconnected = reduceAgentWorkbench(active, { type: 'transport_disconnected' });
    const liveNoActive = reduceAgentWorkbench(disconnected, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunNoActive',
        controllerId,
        sessionId,
      },
    });
    expect(liveNoActive).toBe(disconnected);

    const noActive = reduceAgentWorkbench(disconnected, {
      type: 'server_message',
      authoritative: true,
      message: {
        type: 'bgsmOrganizeJobRunNoActive',
        controllerId,
        sessionId,
      },
    });

    expect(noActive.transport).toBe('connected');
    expect(noActive.snapshot).toBeNull();
    expect(noActive.organizeJob).toBeNull();
    expect(noActive.pendingCommand).toBeNull();
    expect(reduceAgentWorkbench(noActive, {
      type: 'server_message',
      authoritative: true,
      message: {
        type: 'bgsmOrganizeJobRunNoActive',
        controllerId,
        sessionId,
      },
    })).toBe(noActive);
  });

  it('preserves a ready preflight when reconnect authority reports no active run', () => {
    const anchor = { messageId: 'preflight-message', createdAt: 10 };
    let state = reduceAgentWorkbench(createAgentWorkbenchState(controllerId, sessionId), {
      type: 'preflight_requested',
      requestId: 'preflight-reconnect',
      taskInstruction: 'Organize everything.',
      conversationAnchor: anchor,
    });
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunPreflightResult',
        controllerId,
        sessionId,
        requestId: 'preflight-reconnect',
        status: 'ready',
        preflightToken: parsePreflightToken('preflight:v1:reconnect'),
        label: 'All live stars',
        count: 3,
      },
    });
    state = reduceAgentWorkbench(state, { type: 'transport_disconnected' });
    const restored = reduceAgentWorkbench(state, {
      type: 'server_message',
      authoritative: true,
      message: {
        type: 'bgsmOrganizeJobRunNoActive',
        controllerId,
        sessionId,
      },
    });

    expect(restored.transport).toBe('connected');
    expect(restored.preflight?.status).toBe('ready');
    expect(restored.conversationAnchor).toEqual(anchor);
  });

  it('makes a failed review-page request explicitly retryable without accepting stale failures', () => {
    let state = deliverJob(
      withSnapshot({ ...baseSnapshot(), state: 'review', proposalId }),
      presentation(),
    );
    state = reduceAgentWorkbench(state, {
      type: 'organize_review_page_requested',
      requestId: 'review-current',
    });

    const stale = reduceAgentWorkbench(state, {
      type: 'organize_review_request_failed',
      requestId: 'review-stale',
    });
    expect(stale).toBe(state);

    const failed = reduceAgentWorkbench(state, {
      type: 'organize_review_request_failed',
      requestId: 'review-current',
    });
    expect(failed.organizeReviewRequestId).toBeNull();
    expect(failed.organizeReviewError).not.toBeNull();

    const retrying = reduceAgentWorkbench(failed, {
      type: 'organize_review_page_requested',
      requestId: 'review-retry',
    });
    expect(retrying.organizeReviewRequestId).toBe('review-retry');
    expect(retrying.organizeReviewError).toBeNull();

    const serverFailed = reduceAgentWorkbench(retrying, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunError',
        controllerId,
        sessionId,
        runId,
        generation: 1,
        requestId: 'review-retry',
        reason: 'internal_error',
        message: 'The review page could not be loaded.',
      },
    });
    expect(serverFailed.organizeReviewRequestId).toBeNull();
    expect(serverFailed.organizeReviewError).not.toBeNull();
    expect(serverFailed.error).toBeNull();
  });

  it('rolls back a failed continuation request so the same suffix can be retried', () => {
    const parent = {
      ...baseSnapshot(),
      state: 'analysis_blocked' as const,
      terminalReason: 'analysis_failed' as const,
      continuationCursor: parseContinuationCursorToken('cursor:v1:retryable-send-failure'),
    };
    const state = withSnapshot(parent);
    const pending = reduceAgentWorkbench(state, { type: 'continue_requested' });
    const duplicate = reduceAgentWorkbench(pending, { type: 'continue_requested' });

    expect(pending.continuationPending).toBe(true);
    expect(duplicate).toBe(pending);

    const recovered = reduceAgentWorkbench(pending, { type: 'continue_send_failed' });
    expect(recovered.continuationPending).toBe(false);
    expect(recovered.retryingFailedSuffix).toBe(false);
    expect(recovered.error).toBe(CONNECTION_INTERRUPTED_COPY);
  });

  it('models a temporary transport disconnect as reconnecting, not as a run failure', () => {
    const state = withSnapshot(baseSnapshot());
    const disconnected = reduceAgentWorkbench(state, { type: 'transport_disconnected' });

    expect(disconnected.transport).toBe('disconnected');
    expect(disconnected.snapshot?.state).toBe('analyzing');
    expect(disconnected.error).toBeNull();
  });

  it('uses runtime terminal detail until the durable job advances past analyzing', () => {
    const snapshot = baseSnapshot();
    const durableAnalyzing = { ...presentation(), status: 'analyzing' as const };

    for (const state of ['failed', 'budget_exhausted', 'analysis_blocked'] as const) {
      const terminal = { ...snapshot, state };
      expect(isDurableOrganizeJobAuthoritative(terminal, durableAnalyzing)).toBe(false);
      expect(currentOrganizeJobState(terminal, durableAnalyzing)).toBe(state);
    }

    for (const status of ['analysis_blocked', 'review', 'apply_sealed', 'applying', 'paused', 'completed', 'cancelled'] as const) {
      const advanced = { ...durableAnalyzing, status };
      expect(isDurableOrganizeJobAuthoritative(snapshot, advanced)).toBe(true);
      expect(currentOrganizeJobState(snapshot, advanced)).toBe(status);
    }

    const child = {
      ...durableAnalyzing,
      runId: parseRunId('run:v1:child-durable'),
      generation: snapshot.generation + 1,
    };
    const failedSnapshot = { ...snapshot, state: 'failed' as const };
    expect(isDurableOrganizeJobAuthoritative(failedSnapshot, child)).toBe(true);
    expect(currentOrganizeJobState(failedSnapshot, child)).toBe('analyzing');
  });

  it('admits continuation only from stopped authoritative states', () => {
    const cursor = parseContinuationCursorToken('cursor:v1:row-101');
    for (const state of ['analysis_blocked', 'budget_exhausted', 'completed', 'failed'] as const) {
      expect(canContinueOrganizeJobRun({ state, continuationCursor: cursor })).toBe(true);
    }
    for (const state of ['analyzing', 'review', 'cancelled', 'interrupted'] as const) {
      expect(canContinueOrganizeJobRun({ state, continuationCursor: cursor })).toBe(false);
    }
    expect(canContinueOrganizeJobRun({ state: 'completed', continuationCursor: null })).toBe(false);
  });

  it('accepts only the current preflight request and controller identity', () => {
    let state = createAgentWorkbenchState(controllerId, sessionId);
    state = reduceAgentWorkbench(state, {
      type: 'preflight_requested',
      requestId: 'request-current',
      taskInstruction: 'Organize every starred repository.',
      conversationAnchor: { messageId: 'request-current-message', createdAt: 1 },
    });

    const stale = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunPreflightResult',
        controllerId,
        sessionId,
        requestId: 'request-stale',
        status: 'ready',
        preflightToken: parsePreflightToken('preflight:v1:stale'),
        label: 'Stale scope',
        count: 4,
      },
    });
    expect(stale).toBe(state);

    const ready = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunPreflightResult',
        controllerId,
        sessionId,
        requestId: 'request-current',
        status: 'ready',
        preflightToken: parsePreflightToken('preflight:v1:current'),
        label: 'Selected repository',
        count: 1,
      },
    });
    expect(ready.preflight).toEqual(expect.objectContaining({
      status: 'ready',
      label: 'Selected repository',
      count: 1,
      taskInstruction: 'Organize every starred repository.',
    }));
  });

  it('clears preflight timeline state when scope confirmation is cancelled', () => {
    let state = createAgentWorkbenchState(controllerId, sessionId);
    state = reduceAgentWorkbench(state, {
      type: 'preflight_requested',
      requestId: 'request-cancel',
      taskInstruction: 'Organize every starred repository.',
      conversationAnchor: { messageId: 'request-cancel-message', createdAt: 1 },
    });
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunPreflightResult',
        controllerId,
        sessionId,
        requestId: 'request-cancel',
        status: 'ready',
        preflightToken: parsePreflightToken('preflight:v1:cancel'),
        label: 'All live stars',
        count: 303,
      },
    });
    expect(state.timeline.length).toBeGreaterThan(0);

    const cancelled = reduceAgentWorkbench(state, { type: 'preflight_cancelled' });

    expect(cancelled.preflight).toBeNull();
    expect(cancelled.conversationAnchor).toBeNull();
    expect(cancelled.timeline).toEqual([]);
  });

  it('accepts an unscoped start error only while start is pending', () => {
    const errorMessage = {
      type: 'bgsmOrganizeJobRunError' as const,
      controllerId,
      sessionId,
      runId: null,
      generation: null,
      reason: 'preflight_stale' as const,
      message: 'The saved analysis scope expired. Prepare it again.',
    };
    let requesting = createAgentWorkbenchState(controllerId, sessionId);
    requesting = reduceAgentWorkbench(requesting, {
      type: 'preflight_requested',
      requestId: 'request-race',
      taskInstruction: 'Organize everything.',
      conversationAnchor: { messageId: 'request-race-message', createdAt: 1 },
    });
    expect(reduceAgentWorkbench(requesting, {
      type: 'server_message',
      message: errorMessage,
    })).toBe(requesting);
    const requestFailed = reduceAgentWorkbench(requesting, {
      type: 'server_message',
      message: { ...errorMessage, requestId: 'request-race' },
    });
    expect(requestFailed.preflight).toBeNull();
    expect(requestFailed.error).toBe(errorMessage.message);

    let ready = reduceAgentWorkbench(requesting, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunPreflightResult',
        controllerId,
        sessionId,
        requestId: 'request-race',
        status: 'ready',
        preflightToken: parsePreflightToken('preflight:v1:state-start'),
        label: 'All live stars',
        count: 303,
      },
    });
    ready = reduceAgentWorkbench(ready, { type: 'preflight_start_requested' });
    expect(ready.preflight?.status).toBe('starting');

    const failed = reduceAgentWorkbench(ready, {
      type: 'server_message',
      message: { ...errorMessage, requestId: 'request-race' },
    });
    expect(failed.preflight).toBeNull();
    expect(failed.conversationAnchor).toBeNull();
    expect(failed.error).toBe(errorMessage.message);
  });

  it('hydrates review pages only for the current durable revision and request', () => {
    let state = withSnapshot({
      ...baseSnapshot(),
      state: 'review',
      proposalId,
    });
    state = deliverJob(state, presentation());
    state = reduceAgentWorkbench(state, {
      type: 'organize_review_page_requested',
      requestId: 'review-current',
    });
    const page = {
      type: 'bgsmOrganizeReviewPage' as const,
      controllerId,
      sessionId,
      runId,
      generation: 1,
      requestId: 'review-current',
      jobId: 'organize-job:v1:ui',
      revision: 7,
      proposalId,
      totalRows: 2,
      selectedRepositories: 2,
      selectedActions: 3,
      rowOffset: 0,
      rows: [{
        position: 0,
        proposalRowId: `${proposalId}:row:0`,
        repositoryId: 'owner/repo-0',
        proposedActions: [{ kind: 'add_existing_tag' as const, tag: 'TypeScript', evidence: 'Topic' }],
        selected: true,
      }],
      nextRowOffset: 1,
    };

    const wrongRevision = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: { ...page, revision: 6 },
    });
    expect(wrongRevision).toBe(state);

    const wrongRequest = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: { ...page, requestId: 'review-stale' },
    });
    expect(wrongRequest).toBe(state);

    const current = reduceAgentWorkbench(state, { type: 'server_message', message: page });
    expect(current.proposal?.actionableCount).toBe(2);
    expect(current.proposal?.review.rows).toHaveLength(1);
    expect([...current.selectedProposalRowIds]).toEqual([`${proposalId}:row:0`]);
    expect(current.organizeJob?.selectedRepositories).toBe(2);
    expect(current.organizeJob?.selectedActions).toBe(3);

    const newer = deliverJob(current, { ...presentation(), revision: 8, status: 'paused' });
    const staleJob = deliverJob(newer, presentation());
    expect(staleJob).toBe(newer);
    expect(newer.proposal).toBeNull();
  });

  it('accepts only the latest requested durable receipt page', () => {
    let state = withSnapshot({ ...baseSnapshot(), state: 'completed', proposalId });
    state = deliverJob(state, {
      ...presentation(),
      revision: 10,
      status: 'completed',
      selectedRepositories: 1,
      selectedActions: 1,
      apply: {
        applyId: 'organize-apply:v1:receipt-pages',
        total: 1,
        settled: 1,
        changed: 1,
        unchanged: 0,
        skipped: 0,
        failed: 0,
      },
    });
    state = reduceAgentWorkbench(state, {
      type: 'organize_receipt_page_requested',
      requestId: 'receipt-old',
    });
    state = reduceAgentWorkbench(state, {
      type: 'organize_receipt_page_requested',
      requestId: 'receipt-new',
    });
    const page = {
      type: 'bgsmOrganizeReceiptPage' as const,
      controllerId,
      sessionId,
      runId,
      generation: 1,
      requestId: 'receipt-old',
      applyId: 'organize-apply:v1:receipt-pages',
      rowOffset: 0,
      rows: [{
        position: 0,
        proposalRowId: `${proposalId}:row:0`,
        repositoryId: 'owner/repo-0',
        outcome: 'changed' as const,
        reason: null,
      }],
      nextRowOffset: null,
    };
    expect(reduceAgentWorkbench(state, { type: 'server_message', message: page })).toBe(state);

    const current = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: { ...page, requestId: 'receipt-new' },
    });
    expect(current.organizeReceiptPage?.requestId).toBe('receipt-new');
    expect(current.organizeReceiptRequestId).toBeNull();

    const loading = reduceAgentWorkbench(current, {
      type: 'organize_receipt_page_requested',
      requestId: 'receipt-retry',
    });
    const failed = reduceAgentWorkbench(loading, {
      type: 'organize_receipt_request_failed',
      requestId: 'receipt-retry',
    });
    expect(failed.organizeReceiptRequestId).toBeNull();
    expect(failed.organizeReceiptError).not.toBeNull();

    const retrying = reduceAgentWorkbench(failed, {
      type: 'organize_receipt_page_requested',
      requestId: 'receipt-server-failure',
    });
    const serverFailed = reduceAgentWorkbench(retrying, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunError',
        controllerId,
        sessionId,
        runId,
        generation: 1,
        requestId: 'receipt-server-failure',
        reason: 'internal_error',
        message: 'The receipt could not be loaded.',
      },
    });
    expect(serverFailed.organizeReceiptRequestId).toBeNull();
    expect(serverFailed.organizeReceiptError).not.toBeNull();
    expect(serverFailed.error).toBeNull();
  });

  it('accepts a new generation only after continuation is requested', () => {
    const parent = {
      ...baseSnapshot(),
      state: 'budget_exhausted' as const,
      terminalReason: 'consumed_positions' as const,
      continuationCursor: parseContinuationCursorToken('cursor:v1:next'),
    };
    const child = {
      ...baseSnapshot(parseRunId('run:v1:child'), 2),
      state: 'prepared' as const,
    };
    const state = withSnapshot(parent);
    expect(reduceAgentWorkbench(state, {
      type: 'server_message',
      message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot: child },
    })).toBe(state);

    const waiting = reduceAgentWorkbench(state, { type: 'continue_requested' });
    expect(waiting.continuationPending).toBe(true);
    const accepted = reduceAgentWorkbench(waiting, {
      type: 'server_message',
      message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot: child },
    });
    expect(accepted.snapshot?.runId).toBe(child.runId);
    expect(accepted.continuationPending).toBe(false);
  });

  it('rewinds visible progress while a failed suffix is retried', () => {
    const continuationCursor = parseContinuationCursorToken('cursor:v1:failed-suffix-retry');
    const parentCoverage = {
      total: 3,
      analyzed: 3,
      actionable: 0,
      unchanged: 2,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: 1,
    };
    const parent: OrganizeJobRunSnapshot = {
      ...baseSnapshot(),
      state: 'analysis_blocked',
      terminalReason: 'analysis_failed',
      coverage: parentCoverage,
      continuationCursor,
    };
    let state = deliverJob(withSnapshot(parent), {
      ...presentation(),
      status: 'analysis_blocked',
      coverage: parentCoverage,
    });

    state = reduceAgentWorkbench(state, { type: 'continue_requested' });
    expect(state.retryingFailedSuffix).toBe(true);
    expect(displayedAnalyzedRepositoryCount(state)).toBe(2);

    const childRunId = parseRunId('run:v1:failed-suffix-retry-child');
    const childCoverage = {
      ...parentCoverage,
      analyzed: 2,
      analysisFailed: 0,
    };
    state = deliverJob(state, {
      ...presentation(),
      runId: childRunId,
      generation: 2,
      revision: 8,
      status: 'analyzing',
      coverage: childCoverage,
    });
    const child: OrganizeJobRunSnapshot = {
      ...parent,
      runId: childRunId,
      generation: 2,
      state: 'analyzing',
      terminalReason: null,
      usage: createEmptyRunBudgetUsage(),
      coverage: childCoverage,
      continuationCursor: null,
    };
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot: child },
    });
    expect(displayedAnalyzedRepositoryCount(state)).toBe(2);

    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobAnalysisProgress',
        controllerId,
        sessionId,
        runId: childRunId,
        generation: 2,
        processed: 3,
        total: 3,
      },
    });
    expect(displayedAnalyzedRepositoryCount(state)).toBe(3);

    state = deliverJob(state, {
      ...presentation(),
      runId: childRunId,
      generation: 2,
      revision: 9,
    });
    expect(state.retryingFailedSuffix).toBe(false);
  });

  it('surfaces a failed manual continuation instead of treating it as automatic recovery', () => {
    const continuationCursor = parseContinuationCursorToken('cursor:v1:manual-retry-error');
    const parent: OrganizeJobRunSnapshot = {
      ...baseSnapshot(),
      state: 'analysis_blocked',
      terminalReason: 'analysis_failed',
      coverage: {
        total: 3,
        analyzed: 3,
        actionable: 0,
        unchanged: 2,
        insufficientEvidence: 0,
        missing: 0,
        tombstoned: 0,
        analysisFailed: 1,
      },
      continuationCursor,
    };
    let state = deliverJob(withSnapshot(parent), {
      ...presentation(),
      status: 'analysis_blocked',
      coverage: parent.coverage!,
    });
    state = reduceAgentWorkbench(state, { type: 'continue_requested' });

    const childRunId = parseRunId('run:v1:manual-retry-error-child');
    state = deliverJob(state, {
      ...presentation(),
      runId: childRunId,
      generation: 2,
      revision: 8,
      status: 'analyzing',
      coverage: {
        ...parent.coverage!,
        analyzed: 2,
        analysisFailed: 0,
      },
    });
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunError',
        controllerId,
        sessionId,
        runId: childRunId,
        generation: 2,
        reason: 'internal_error',
        message: 'Manual retry could not start.',
      },
    });

    expect(state.error).toBe('Manual retry could not start.');
    expect(state.continuationPending).toBe(false);
  });

  it('keeps streamed repository progress monotonic and separate from durable coverage', () => {
    let state = withSnapshot(baseSnapshot());
    const progress = (processed: number, overrides: Record<string, unknown> = {}) => ({
      type: 'bgsmOrganizeJobAnalysisProgress' as const,
      controllerId,
      sessionId,
      runId,
      generation: 1,
      processed,
      total: 3,
      ...overrides,
    });

    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: progress(1),
    });
    expect(displayedAnalyzedRepositoryCount(state)).toBe(1);
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: progress(3),
    });
    expect(displayedAnalyzedRepositoryCount(state)).toBe(3);

    const regressed = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: progress(2),
    });
    expect(regressed).toBe(state);
    for (const stale of [
      progress(3, { runId: parseRunId('run:v1:stale-progress') }),
      progress(3, { generation: 2 }),
      progress(3, { total: 4 }),
    ]) {
      expect(reduceAgentWorkbench(state, {
        type: 'server_message',
        message: stale,
      })).toBe(state);
    }

    const reconnected = reduceAgentWorkbench(state, {
      type: 'server_message',
      authoritative: true,
      message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot: baseSnapshot() },
    });
    expect(reconnected.analysisProgress).toBeNull();
    expect(displayedAnalyzedRepositoryCount(reconnected)).toBe(0);
  });

  it('keeps visible progress monotonic across a same-job authoritative restore', () => {
    let state = deliverJob(withSnapshot(baseSnapshot()), {
      ...presentation(),
      status: 'analyzing',
      coverage: {
        ...presentation().coverage,
        analyzed: 2,
        actionable: 1,
        unchanged: 1,
      },
    });
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobAnalysisProgress',
        controllerId,
        sessionId,
        runId,
        generation: 1,
        processed: 3,
        total: 3,
      },
    });
    expect(displayedAnalyzedRepositoryCount(state)).toBe(3);

    const restored = reduceAgentWorkbench(state, {
      type: 'server_message',
      authoritative: true,
      message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot: baseSnapshot() },
    });

    expect(displayedAnalyzedRepositoryCount(restored)).toBe(3);
  });

  it('accepts a newer authoritative durable generation after reconnect', () => {
    const parent = {
      ...baseSnapshot(),
      state: 'analyzing' as const,
      usage: {
        ...baseSnapshot().usage,
        firstAnalyzerRequestAt: 1,
        consumedFrozenPositions: 125,
        analyzerBatches: 5,
        providerAttempts: 5,
      },
    };
    const child = {
      ...baseSnapshot(parseRunId('run:v1:reconnected-child'), 2),
      state: 'analyzing' as const,
      usage: {
        ...baseSnapshot().usage,
        firstAnalyzerRequestAt: 2,
        consumedFrozenPositions: 25,
        analyzerBatches: 1,
        providerAttempts: 1,
      },
    };
    let state = deliverJob(withSnapshot(parent), {
      ...presentation(),
      status: 'analyzing',
      coverage: { ...presentation().coverage, total: 303, analyzed: 125 },
    });
    const accepted = reduceAgentWorkbench(state, {
      type: 'server_message',
      authoritative: true,
      message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot: child },
    });

    expect(accepted.snapshot?.runId).toBe(child.runId);
    expect(accepted.snapshot?.generation).toBe(2);
    expect(accepted.usageOffset.consumedFrozenPositions).toBe(125);
    expect(accepted.error).toBeNull();
  });

  it('lets a newer durable generation supersede a stale parent terminal snapshot', () => {
    const repositoryIds = Array.from({ length: 315 }, (_, index) => `owner/repo-${index}`);
    const frozenScope = projectFrozenScope(createFrozenScope({
      kind: 'all_live_stars',
      label: 'All stars',
      filterSnapshot: '{}',
      repositoryIds,
      capturedAt: 1,
      fingerprint: parseScopeFingerprintV1(`fs:v1:${'b'.repeat(43)}`),
    }));
    const parent: OrganizeJobRunSnapshot = {
      ...baseSnapshot(),
      state: 'budget_exhausted',
      terminalReason: 'requested_output_tokens',
      frozenScope,
      usage: {
        ...baseSnapshot().usage,
        firstAnalyzerRequestAt: 1,
        consumedFrozenPositions: 150,
        analyzerBatches: 6,
        providerAttempts: 6,
      },
      coverage: {
        total: 315,
        analyzed: 150,
        actionable: 50,
        unchanged: 100,
        insufficientEvidence: 0,
        missing: 0,
        tombstoned: 0,
        analysisFailed: 0,
      },
      continuationCursor: parseContinuationCursorToken('cursor:v1:durable-child'),
    };
    const parentJob: BgsmOrganizeJobPresentation = {
      ...presentation(),
      revision: 20,
      status: 'analyzing',
      scopeCount: 315,
      coverage: parent.coverage!,
      selectedRepositories: 50,
      selectedActions: 50,
    };
    const childRunId = parseRunId('run:v1:durable-child');
    const childJob: BgsmOrganizeJobPresentation = {
      ...parentJob,
      runId: childRunId,
      generation: 2,
      revision: 21,
      coverage: {
        ...parentJob.coverage,
        analyzed: 237,
        actionable: 80,
        unchanged: 157,
      },
      selectedRepositories: 80,
      selectedActions: 80,
    };

    let state = deliverJob(withSnapshot(parent), parentJob);
    state = deliverJob(state, childJob);
    expect(state.organizeJob).toEqual(childJob);
    expect(state.continuationPending).toBe(true);
    expect(displayedAnalyzedRepositoryCount(state)).toBe(237);

    const childError = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunError',
        controllerId,
        sessionId,
        runId: childRunId,
        generation: 2,
        reason: 'internal_error',
        message: 'Child generation failed before publishing its snapshot.',
      },
    });
    expect(childError).toBe(state);

    const staleParent = deliverJob(state, {
      ...parentJob,
      coverage: { ...parentJob.coverage, analyzed: 125, actionable: 25, unchanged: 100 },
    });
    expect(staleParent).toBe(state);

    const childSnapshot: OrganizeJobRunSnapshot = {
      ...parent,
      runId: childRunId,
      generation: 2,
      state: 'analyzing',
      terminalReason: null,
      usage: {
        ...baseSnapshot().usage,
        firstAnalyzerRequestAt: 2,
        consumedFrozenPositions: 87,
        analyzerBatches: 4,
        providerAttempts: 4,
      },
      coverage: childJob.coverage,
      continuationCursor: null,
    };
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      authoritative: true,
      message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot: childSnapshot },
    });
    expect(state.snapshot?.runId).toBe(childRunId);
    expect(state.snapshot?.state).toBe('analyzing');
    expect(state.continuationPending).toBe(false);
    expect(displayedAnalyzedRepositoryCount(state)).toBe(237);
  });

  it('clears continuation wait after a background failure', () => {
    const parent = {
      ...baseSnapshot(),
      usage: {
        ...baseSnapshot().usage,
        firstAnalyzerRequestAt: 1,
        consumedFrozenPositions: 1,
        analyzerBatches: 1,
        providerAttempts: 1,
        requestedOutputTokens: 4_096,
      },
    };
    let state = withSnapshot(parent);
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunEvent',
        event: {
          type: 'budget_exhausted',
          controllerId,
          sessionId,
          runId,
          generation: 1,
          eventId: 'event-auto-continuation',
          state: 'budget_exhausted',
          reason: 'requested_output_tokens',
          budget: parent.budget,
          usage: parent.usage,
          continuationCursor: parseContinuationCursorToken('cursor:v1:auto-failed'),
        },
      },
    });
    expect(state.continuationPending).toBe(true);
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunError',
        controllerId,
        sessionId,
        runId,
        generation: 1,
        reason: 'internal_error',
        message: 'Automatic continuation could not start.',
      },
    });
    expect(state.continuationPending).toBe(false);
    expect(state.error).toBe('Automatic continuation could not start.');
  });

  it('keeps showing progress while a durable automatic continuation is recoverable', () => {
    const parent = {
      ...baseSnapshot(),
      usage: {
        ...baseSnapshot().usage,
        firstAnalyzerRequestAt: 1,
        consumedFrozenPositions: 100,
        analyzerBatches: 4,
        providerAttempts: 4,
        requestedOutputTokens: 4_096,
      },
    };
    let state = deliverJob(withSnapshot(parent), {
      ...presentation(),
      status: 'analyzing',
      coverage: {
        ...presentation().coverage,
        analyzed: 100,
        unchanged: 100,
      },
    });
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunEvent',
        event: {
          type: 'budget_exhausted',
          controllerId,
          sessionId,
          runId,
          generation: 1,
          eventId: 'event-durable-auto-continuation',
          state: 'budget_exhausted',
          reason: 'requested_output_tokens',
          budget: parent.budget,
          usage: parent.usage,
          continuationCursor: parseContinuationCursorToken('cursor:v1:durable-auto-retry'),
        },
      },
    });
    expect(state.continuationPending).toBe(true);

    const transientError = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunError',
        controllerId,
        sessionId,
        runId,
        generation: 1,
        reason: 'internal_error',
        message: 'Organize continuation generation must advance exactly once from its parent.',
      },
    });

    expect(transientError).toBe(state);
    expect(transientError.error).toBeNull();
    expect(transientError.continuationPending).toBe(true);
    expect(transientError.snapshot?.state).toBe('budget_exhausted');
  });

  it('drops an active durable presentation when its matching run is cancelled', () => {
    const activeSnapshot = baseSnapshot();
    const activeJob = {
      ...presentation(),
      status: 'analyzing' as const,
      coverage: {
        ...presentation().coverage,
        analyzed: 1,
        actionable: 0,
        unchanged: 1,
      },
      selectedRepositories: 0,
      selectedActions: 0,
    };
    let state = deliverJob(withSnapshot(activeSnapshot), activeJob);
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunResult',
        controllerId,
        sessionId,
        runId,
        generation: 1,
        snapshot: {
          ...activeSnapshot,
          state: 'cancelled',
          terminalReason: 'user_stopped',
          usage: { ...activeSnapshot.usage, consumedFrozenPositions: 1 },
        },
      },
    });

    expect(state.snapshot?.state).toBe('cancelled');
    expect(state.organizeJob).toBeNull();
    expect(state.continuationPending).toBe(false);
  });

  it('starts a fresh preflight without retaining durable review authority', () => {
    let state = withSnapshot({ ...baseSnapshot(), state: 'completed', proposalId });
    state = deliverJob(state, presentation());
    state = reduceAgentWorkbench(state, {
      type: 'organize_review_page_requested',
      requestId: 'review-current',
    });
    const next = reduceAgentWorkbench(state, {
      type: 'preflight_requested',
      requestId: 'request-next',
      taskInstruction: 'Organize everything.',
      conversationAnchor: { messageId: 'request-next-message', createdAt: 1 },
    });
    expect(next.snapshot).toBeNull();
    expect(next.proposal).toBeNull();
    expect(next.selectedProposalRowIds.size).toBe(0);
    expect(next.organizeJob).toBeNull();
    expect(next.organizeReviewPage).toBeNull();
    expect(next.organizeReviewRequestId).toBeNull();
    expect(next.preflight?.status).toBe('requesting');
  });

  it('marks an in-memory run interrupted when the replacement worker confirms it is gone', () => {
    const state = reduceAgentWorkbench(withSnapshot(baseSnapshot()), {
      type: 'transport_disconnected',
    });
    const message = {
      type: 'bgsmOrganizeJobRunDisconnected' as const,
      controllerId,
      sessionId,
      runId,
      generation: 1,
    };
    expect(reduceAgentWorkbench(state, {
      type: 'server_message',
      message,
    })).toBe(state);
    const disconnected = reduceAgentWorkbench(state, {
      type: 'server_message',
      authoritative: true,
      message,
    });
    expect(disconnected.snapshot?.state).toBe('interrupted');
    expect(disconnected.snapshot?.terminalReason).toBe('worker_lost');
    expect(disconnected.error).toBe(WORKER_LOST_COPY);
  });

  it('accepts a disconnect from a durable child that is newer than the visible snapshot', () => {
    const parent = {
      ...baseSnapshot(),
      state: 'budget_exhausted' as const,
      terminalReason: 'requested_output_tokens' as const,
    };
    const childRunId = parseRunId('run:v1:disconnect-child');
    let state = deliverJob(withSnapshot(parent), {
      ...presentation(),
      status: 'analyzing',
    });
    state = deliverJob(state, {
      ...presentation(),
      runId: childRunId,
      generation: 2,
      revision: 8,
      status: 'analyzing',
    });
    state = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunDisconnected',
        controllerId,
        sessionId,
        runId: childRunId,
        generation: 2,
      },
    });

    expect(state.error).toBe(WORKER_LOST_COPY);
    expect(state.snapshot).toBeNull();
    expect(state.organizeJob).toBeNull();
  });
});

function deliverJob(
  state: ReturnType<typeof createAgentWorkbenchState>,
  job: BgsmOrganizeJobPresentation,
) {
  return reduceAgentWorkbench(state, {
    type: 'server_message',
    message: {
      type: 'bgsmOrganizeJobState',
      controllerId,
      sessionId,
      runId: job.runId,
      generation: job.generation,
      presentation: job,
    },
  });
}

function pendingCommand(
  id: string,
  kind: WorkbenchPendingCommand['kind'],
  baselineRevision: number | null = 7,
): WorkbenchPendingCommand {
  return {
    id,
    kind,
    runId,
    generation: 1,
    jobId: baselineRevision === null ? null : presentation().jobId,
    baselineRevision,
  };
}

function presentation(): BgsmOrganizeJobPresentation {
  return {
    controllerId,
    sessionId,
    runId,
    generation: 1,
    jobId: 'organize-job:v1:ui',
    revision: 7,
    status: 'review',
    scopeLabel: 'All stars',
    scopeCount: 3,
    capturedAt: 1,
    proposalId,
    coverage: {
      total: 3,
      analyzed: 3,
      actionable: 2,
      unchanged: 1,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: 0,
    },
    selectedRepositories: 2,
    selectedActions: 3,
    apply: null,
  };
}

function withSnapshot(snapshot: OrganizeJobRunSnapshot) {
  return reduceAgentWorkbench(
    createAgentWorkbenchState(controllerId, sessionId),
    { type: 'server_message', message: { type: 'bgsmOrganizeJobRunSnapshot', snapshot } },
  );
}

function baseSnapshot(id = runId, generation = 1): OrganizeJobRunSnapshot {
  return {
    controllerId,
    sessionId,
    runId: id,
    generation,
    state: 'analyzing',
    terminalReason: null,
    frozenScope: projectFrozenScope(createFrozenScope({
      kind: 'all_live_stars',
      label: 'All stars',
      filterSnapshot: '{}',
      repositoryIds: ['repo-0', 'repo-1', 'repo-2'],
      capturedAt: 1,
      fingerprint: parseScopeFingerprintV1(`fs:v1:${'a'.repeat(43)}`),
    })),
    budget: createProductionRunBudget(),
    usage: createEmptyRunBudgetUsage(),
    proposalId: null,
    continuationCursor: null,
  };
}
