import { describe, expect, it } from 'vitest';
import {
  canChatWithOrganizeJobRun,
  canContinueOrganizeJobRun,
  createAgentWorkbenchState,
  reduceAgentWorkbench,
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

  it('keeps chat available outside active analysis and apply states', () => {
    expect(canChatWithOrganizeJobRun(null)).toBe(true);
    for (const state of ['completed', 'budget_exhausted', 'failed', 'cancelled', 'interrupted', 'review'] as const) {
      expect(canChatWithOrganizeJobRun({ state })).toBe(true);
    }
    for (const state of ['prepared', 'analyzing'] as const) {
      expect(canChatWithOrganizeJobRun({ state })).toBe(false);
    }
  });

  it('accepts only the current preflight request and controller identity', () => {
    let state = createAgentWorkbenchState(controllerId, sessionId);
    state = reduceAgentWorkbench(state, { type: 'preflight_requested', requestId: 'request-current' });

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
    }));
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
    });
    expect(next.snapshot).toBeNull();
    expect(next.proposal).toBeNull();
    expect(next.selectedProposalRowIds.size).toBe(0);
    expect(next.preflight?.status).toBe('requesting');
  });

  it('marks an in-memory run interrupted when the replacement worker confirms it is gone', () => {
    const state = withSnapshot(baseSnapshot());
    const disconnected = reduceAgentWorkbench(state, {
      type: 'server_message',
      message: {
        type: 'bgsmOrganizeJobRunDisconnected',
        controllerId,
        sessionId,
        runId,
        generation: 1,
      },
    });
    expect(disconnected.snapshot?.state).toBe('interrupted');
    expect(disconnected.snapshot?.terminalReason).toBe('worker_lost');
    expect(disconnected.error).toBe(WORKER_LOST_COPY);
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
      runId,
      generation: 1,
      presentation: job,
    },
  });
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
