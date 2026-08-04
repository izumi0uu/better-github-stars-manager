import { describe, expect, it } from 'vitest';
import {
  resolveAgentUiPresentation,
  selectOrganizeWorkbenchView,
  type AgentChatPresentationInput,
} from '@/ui/agent-ui-presentation';
import {
  createAgentWorkbenchState,
  type AgentWorkbenchState,
} from '@/ui/agent-workbench-state';
import { parseControllerId, parseProposalId, parseRunId } from '@/bgsm-agent/identity';
import {
  createFrozenScope,
  parseContinuationCursorToken,
  parseScopeFingerprintV1,
  projectFrozenScope,
} from '@/bgsm-agent/scope';
import { createEmptyRunBudgetUsage, createProductionRunBudget } from '@/bgsm-agent/policy';
import type { OrganizeJobRunSnapshot } from '@/bgsm-agent/events';
import type { BgsmOrganizeJobPresentation } from '@/utils/messaging';

const controllerId = parseControllerId('controller:v1:presentation-test');
const sessionId = 'presentation-session';
const runId = parseRunId('run:v1:presentation-test');
const proposalId = parseProposalId('proposal:v1:presentation-test');

const IDLE_CHAT: AgentChatPresentationInput = {
  phase: 'idle',
  hasError: false,
  hasContextRecovery: false,
  unsafeReplayBlocked: false,
};

describe('Agent UI presentation selectors', () => {
  it('uses one monotonic analysis progress value on every projection', () => {
    const state = stateWith({
      snapshot: snapshot('analyzing'),
      analysisProgress: { runId, generation: 1, processed: 7, total: 10 },
    });

    const view = selectOrganizeWorkbenchView(state, 6);
    const presentation = resolveAgentUiPresentation(IDLE_CHAT, view);

    expect(view.progress).toEqual({ kind: 'analysis', completed: 7, total: 10, remaining: 3 });
    expect(presentation.header.progress).toEqual(view.progress);
    expect(presentation.toolbar.progress).toEqual(view.progress);
  });

  it('shows review loading until the current durable review page arrives', () => {
    const job = presentation('review');
    const loading = stateWith({
      snapshot: snapshot('review'),
      organizeJob: job,
      organizeReviewRequestId: 'review-page:pending',
    });
    expect(selectOrganizeWorkbenchView(loading).phase).toBe('review_loading');

    const invalid = stateWith({
      snapshot: snapshot('review'),
      organizeJob: {
        ...job,
        coverage: { ...job.coverage, analyzed: 9, analysisFailed: 1 },
      },
    });
    const invalidView = selectOrganizeWorkbenchView(invalid);
    expect(invalidView.phase).toBe('review_invalid');
    expect(invalidView.capabilities.canRestart).toBe(true);
    expect(invalidView.capabilities.canDiscard).toBe(true);
  });

  it('keeps header, toolbar, mascot, stopbar, and permissions coherent for each active phase', () => {
    const cases = [
      [stateWith({ preflight: {
        requestId: 'preflight:requesting',
        status: 'requesting',
        taskInstruction: 'Organize all repositories.',
        label: '',
        count: 0,
        preflightToken: null,
      } }), 'scope_requesting', 'cancel_preflight', 'queued'],
      [stateWith({ preflight: {
        requestId: 'preflight:starting',
        status: 'starting',
        taskInstruction: 'Organize everything.',
        label: 'All stars',
        count: 10,
        preflightToken: null,
      } }), 'scope_starting', 'cancel_preflight', 'queued'],
      [stateWith({ snapshot: snapshot('analyzing') }), 'analyzing', 'stop_analysis', 'working'],
      [stateWith({
        snapshot: snapshot('analyzing'),
        organizeJob: { ...presentation('applying'), apply: applyProgress() },
      }), 'applying', 'pause_apply', 'tool'],
    ] as const;

    for (const [state, phase, action, mascot] of cases) {
      const view = selectOrganizeWorkbenchView(state);
      const ui = resolveAgentUiPresentation(IDLE_CHAT, view);
      expect(view.phase).toBe(phase);
      expect(ui.dominantPhase).toBe(phase);
      expect(ui.header.kind).toBe(phase);
      expect(ui.toolbar.kind).toBe(phase);
      expect(ui.stopbar?.action).toBe(action);
      expect(ui.mascot).toBe(mascot);
      expect(ui.active).toBe(true);
    }
  });

  it('separates a failed review-page fetch from invalid analysis coverage', () => {
    const job = presentation('review');
    const view = selectOrganizeWorkbenchView(stateWith({
      snapshot: snapshot('review'),
      organizeJob: job,
      organizeReviewError: 'BGSM_AGENT_REVIEW_REQUEST_FAILED',
    }));
    const ui = resolveAgentUiPresentation(IDLE_CHAT, view);

    expect(view.phase).toBe('review_failed');
    expect(view.coverageComplete).toBe(true);
    expect(view.capabilities.canRetryReviewPage).toBe(true);
    expect(view.capabilities.canDiscard).toBe(true);
    expect(ui.mascot).toBe('error');
    expect(ui.stopbar).toBeNull();
  });

  it('treats transport loss as reconnecting without an error projection or analysis spinner', () => {
    const state = stateWith({
      snapshot: snapshot('analyzing'),
      transport: 'disconnected',
      error: 'BGSM_AGENT_CONNECTION_INTERRUPTED',
    });
    const view = selectOrganizeWorkbenchView(state);
    const ui = resolveAgentUiPresentation(IDLE_CHAT, view);

    expect(view.phase).toBe('reconnecting');
    expect(view.error).toBeNull();
    expect(ui.dominantPhase).toBe('reconnecting');
    expect(ui.mascot).toBe('queued');
    expect(ui.stopbar).toBeNull();
  });

  it('gives every owned terminal state an explicit release action', () => {
    for (const runState of ['failed', 'interrupted', 'cancelled'] as const) {
      const view = selectOrganizeWorkbenchView(stateWith({ snapshot: snapshot(runState) }));
      expect(view.ownsSession).toBe(true);
      expect(view.capabilities.canDiscard || view.capabilities.canRestart).toBe(true);
      expect(resolveAgentUiPresentation(IDLE_CHAT, view).stopbar).toBeNull();
    }

    const receipt = selectOrganizeWorkbenchView(stateWith({
      snapshot: snapshot('completed'),
      organizeJob: { ...presentation('completed'), apply: applyProgress(3, 3) },
    }));
    expect(receipt.phase).toBe('receipt');
    expect(receipt.capabilities.canDiscard).toBe(true);
    expect(resolveAgentUiPresentation(IDLE_CHAT, receipt).stopbar).toBeNull();
  });

  it('lets a running review follow-up dominate presentation without losing review ownership', () => {
    const job = presentation('review');
    const view = selectOrganizeWorkbenchView(stateWith({
      snapshot: snapshot('review'),
      organizeJob: job,
      proposal: {
        proposalId,
        actionableCount: 0,
        nonActionableCount: 10,
        review: { version: 1, proposalId, runId, generation: 1, rows: [] },
      },
    }));
    const ui = resolveAgentUiPresentation({
      ...IDLE_CHAT,
      phase: 'working',
    }, view);

    expect(view.phase).toBe('review_ready');
    expect(ui.dominantPhase).toBe('chat_working');
    expect(ui.mascot).toBe('working');
    expect(ui.sessionPolicy.ownsWorkbench).toBe(true);
    expect(ui.sessionPolicy.canSwitchSession).toBe(false);
  });
});

function stateWith(overrides: Partial<AgentWorkbenchState>): AgentWorkbenchState {
  return { ...createAgentWorkbenchState(controllerId, sessionId), ...overrides };
}

function snapshot(state: OrganizeJobRunSnapshot['state']): OrganizeJobRunSnapshot {
  return {
    controllerId,
    sessionId,
    runId,
    generation: 1,
    state,
    terminalReason: state === 'interrupted' ? 'worker_lost' : state === 'failed' ? 'internal_error' : null,
    frozenScope: projectFrozenScope(createFrozenScope({
      kind: 'all_live_stars',
      label: 'All stars',
      filterSnapshot: '{}',
      repositoryIds: Array.from({ length: 10 }, (_, index) => `repo-${index}`),
      capturedAt: 1,
      fingerprint: parseScopeFingerprintV1(`fs:v1:${'p'.repeat(43)}`),
    })),
    budget: createProductionRunBudget(),
    usage: createEmptyRunBudgetUsage(),
    coverage: {
      total: 10,
      analyzed: state === 'analyzing' ? 0 : 10,
      actionable: 0,
      unchanged: state === 'analyzing' ? 0 : 10,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: 0,
    },
    proposalId: state === 'review' ? proposalId : null,
    continuationCursor: ['analysis_blocked', 'failed'].includes(state)
      ? parseContinuationCursorToken('cursor:v1:presentation-test')
      : null,
  };
}

function presentation(status: BgsmOrganizeJobPresentation['status']): BgsmOrganizeJobPresentation {
  return {
    controllerId,
    sessionId,
    runId,
    generation: 1,
    jobId: 'organize-job:v1:presentation-test',
    revision: 1,
    status,
    scopeLabel: 'All stars',
    scopeCount: 10,
    capturedAt: 1,
    proposalId,
    coverage: {
      total: 10,
      analyzed: 10,
      actionable: 0,
      unchanged: 10,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: 0,
    },
    selectedRepositories: 0,
    selectedActions: 0,
    apply: null,
  };
}

function applyProgress(settled = 1, total = 3) {
  return {
    applyId: 'apply:v1:presentation-test',
    total,
    settled,
    changed: settled,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };
}
