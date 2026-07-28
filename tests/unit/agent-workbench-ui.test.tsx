/**
 * @vitest-environment jsdom
 */
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPanel } from '@/ui/components/AgentPanel';
import { useBgsmAgent } from '@/ui/hooks/use-bgsm-agent';
import { useBgsmAgentWorkbench } from '@/ui/hooks/use-bgsm-agent-workbench';
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
import type { OrganizeJobRunCoverageSummary, OrganizeJobRunSnapshot } from '@/bgsm-agent/events';
import type {
  BgsmOrganizeJobClientMessage,
  BgsmOrganizeJobDeliveryEnvelope,
  BgsmOrganizeJobPresentation,
  BgsmOrganizeJobServerMessage,
} from '@/utils/messaging';
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from './test-utils';

const mountedRoots: MountedRoot[] = [];
let port: FakePort;
let ports: FakePort[];
let fakePortEpoch = 0;

beforeEach(() => {
  ports = [];
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn((connectInfo?: { name?: string }) => {
        port = new FakePort(connectInfo?.name ?? 'unknown');
        ports.push(port);
        return port.asChromePort();
      }),
      lastError: undefined,
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Agent organize-job workbench UI', () => {
  it('replaces the current run phase instead of accumulating a synthetic checklist', async () => {
    const container = await mountHarness();
    await click(buttonWithText(container, 'Organize full library'));
    const request = postedMessage('requestBgsmOrganizeJobPreflight');
    const activeBase = analysisSnapshot(request.controllerId, request.sessionId, 'frozen');

    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: activeBase });
    expect(currentPhase(container)).toBe('Frozen');
    expect(container.textContent).not.toContain('Resolving scope');

    await emitMessage({
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: { ...activeBase, state: 'checking_provider' },
    });
    expect(currentPhase(container)).toBe('Checking provider');

    await emitMessage({
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: { ...activeBase, state: 'analyzing' },
    });
    expect(currentPhase(container)).toBe('Analyzing');
    expect(container.querySelector('[aria-label="Agent activity"]')).toBeNull();
  });

  it('advances every visible progress surface one repository at a time', async () => {
    vi.useFakeTimers();
    const container = await mountHarness();
    await click(buttonWithText(container, 'Organize full library'));
    const request = postedMessage('requestBgsmOrganizeJobPreflight');
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing', 30);
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing });
    await emitMessage({
      type: 'bgsmOrganizeJobRunEvent',
      event: {
        type: 'budget_usage_changed',
        controllerId: analyzing.controllerId,
        sessionId: analyzing.sessionId,
        runId: analyzing.runId,
        generation: analyzing.generation,
        eventId: 'ui-incremental-progress',
        budget: analyzing.budget,
        usage: {
          ...analyzing.usage,
          consumedFrozenPositions: 25,
          analyzerBatches: 1,
          providerAttempts: 1,
        },
      },
    });

    expectVisibleProgress(container, 0, 30);
    for (let expected = 1; expected <= 25; expected += 1) {
      await act(async () => {
        vi.advanceTimersByTime(60);
        await Promise.resolve();
      });
      expectVisibleProgress(container, expected, 30);
    }
  });

  it('handles empty and confirmed preflight without exposing protocol details', async () => {
    const container = await mountHarness();
    await click(buttonWithText(container, 'Organize full library'));
    const emptyRequest = postedMessage('requestBgsmOrganizeJobPreflight');
    await emitMessage({
      type: 'bgsmOrganizeJobRunPreflightResult',
      controllerId: emptyRequest.controllerId,
      sessionId: emptyRequest.sessionId,
      requestId: emptyRequest.requestId,
      status: 'no_work',
      preflightToken: null,
      label: 'Current view · untagged only',
      count: 0,
    });
    expect(container.textContent).toContain('Nothing to analyze');
    expect(container.textContent).toContain('0 repositories match this scope');
    await click(buttonWithText(container, 'Dismiss'));

    await click(buttonWithText(container, 'Organize full library'));
    const readyRequest = postedMessages('requestBgsmOrganizeJobPreflight').at(-1)!;
    await emitMessage({
      type: 'bgsmOrganizeJobRunPreflightResult',
      controllerId: readyRequest.controllerId,
      sessionId: readyRequest.sessionId,
      requestId: readyRequest.requestId,
      status: 'ready',
      preflightToken: parsePreflightToken('preflight:v1:ui-confirm'),
      label: 'All live stars',
      count: 290,
    });
    expect(container.textContent).toContain('Confirm analysis scope');
    expect(container.textContent).toContain('290 repositories will be frozen');
    expect(container.innerHTML).not.toContain('preflight:v1:ui-confirm');
    await click(buttonWithText(container, 'Start analysis'));
    expect(port.posted).toContainEqual(expect.objectContaining({
      type: 'startBgsmOrganizeJob',
      preflightToken: 'preflight:v1:ui-confirm',
    }));
  });

  it('keeps analysis failures review-free and resumes only the failed suffix', async () => {
    const container = await mountHarness();
    await click(buttonWithText(container, 'Organize full library'));
    const request = postedMessage('requestBgsmOrganizeJobPreflight');
    const continuationCursor = parseContinuationCursorToken('cursor:v1:analysis-blocked');
    const snapshot = analysisSnapshot(request.controllerId, request.sessionId, 'analysis_blocked');
    const coverage: OrganizeJobRunCoverageSummary = {
      total: 3,
      analyzed: 3,
      actionable: 0,
      unchanged: 2,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: 1,
    };
    const blocked: OrganizeJobRunSnapshot = {
      ...snapshot,
      terminalReason: 'analysis_failed',
      continuationCursor,
      coverage,
    };
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: blocked });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: blocked.controllerId,
      sessionId: blocked.sessionId,
      runId: blocked.runId,
      generation: blocked.generation,
      presentation: presentationFor(blocked, {
        jobId: 'organize-job:v1:analysis-blocked',
        status: 'analysis_blocked',
        coverage,
        selectedRepositories: 0,
        selectedActions: 0,
      }),
    });

    expect(container.textContent).toContain('1 repository could not be analyzed');
    expect(container.querySelector('[data-testid="organize-job-proposal-card"]')).toBeNull();
    await click(buttonWithText(container, 'Continue remaining'));
    expect(port.posted.at(-1)).toEqual({
      type: 'continueBgsmOrganizeJob',
      controllerId: blocked.controllerId,
      sessionId: blocked.sessionId,
      runId: blocked.runId,
      generation: blocked.generation,
      continuationCursor,
    });
  });

  it('continues an exhausted analysis internally as one cumulative task', async () => {
    const container = await mountHarness();
    await click(buttonWithText(container, 'Organize full library'));
    const request = postedMessage('requestBgsmOrganizeJobPreflight');
    const parent: OrganizeJobRunSnapshot = {
      ...analysisSnapshot(request.controllerId, request.sessionId, 'analyzing'),
      usage: {
        ...createEmptyRunBudgetUsage(),
        firstAnalyzerRequestAt: 1,
        consumedFrozenPositions: 2,
        analyzerBatches: 1,
        providerAttempts: 1,
        requestedOutputTokens: 4_096,
      },
    };
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: parent });
    await emitMessage({
      type: 'bgsmOrganizeJobRunEvent',
      event: {
        type: 'budget_exhausted',
        controllerId: parent.controllerId,
        sessionId: parent.sessionId,
        runId: parent.runId,
        generation: parent.generation,
        eventId: 'ui-auto-continuation-budget',
        state: 'budget_exhausted',
        reason: 'requested_output_tokens',
        budget: parent.budget,
        usage: parent.usage,
        continuationCursor: parseContinuationCursorToken('cursor:v1:auto-continuation'),
      },
    });

    expect(container.textContent).not.toContain('Budget exhausted');
    expect(container.textContent).not.toContain('Continue remaining');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);

    const child: OrganizeJobRunSnapshot = {
      ...parent,
      runId: parseRunId('run:v1:ui-auto-continuation'),
      generation: parent.generation + 1,
      state: 'prepared',
      terminalReason: null,
      usage: createEmptyRunBudgetUsage(),
      continuationCursor: null,
    };
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: child });
    await emitMessage({
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: {
        ...child,
        state: 'analyzing',
        usage: {
          ...child.usage,
          firstAnalyzerRequestAt: 2,
          consumedFrozenPositions: 1,
          analyzerBatches: 1,
          providerAttempts: 1,
          requestedOutputTokens: 4_096,
        },
      },
    });

    await waitForProgress(container, 3);
    expect(container.textContent).toContain('3 analyzed · 0 remaining');
    expect(currentPhase(container)).toBe('Analyzing');
  });

  it('renders a stopped task without suggesting that changes were applied', async () => {
    const container = await mountHarness();
    await click(buttonWithText(container, 'Organize full library'));
    const request = postedMessage('requestBgsmOrganizeJobPreflight');
    const base = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing', 28);
    await emitMessage({
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: {
        ...base,
        state: 'cancelled',
        terminalReason: 'user_stopped',
        usage: { ...base.usage, consumedFrozenPositions: 9 },
      },
    });
    expect(container.textContent).toContain('Stopped by you');
    expect(container.querySelector('[data-testid="organize-job-stop-card"]')).toBeTruthy();
    expect(container.textContent).toContain('Completed reads: 9');
    expect(container.textContent).toContain('Not started: 19');
    expect(container.textContent).not.toContain('Library update receipt');
  });

  it('restores a failed chat prompt as a retryable Provider error', async () => {
    const container = await mountHarness();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await setTextareaValue(textarea, 'Analyze my local stars');
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    const agentPort = port;
    const turn = agentPort.posted[0] as {
      turnAttemptId: string;
      sessionId: string;
      baseRevision: number;
    };
    await act(async () => {
      agentPort.emit({
        type: 'bgsmAgentTurnResult',
        sequence: 0,
        result: {
          turnAttemptId: turn.turnAttemptId,
          sessionId: turn.sessionId,
          baseRevision: turn.baseRevision,
          reason: 'context_limit',
          contextFailureReason: 'final_preflight_failed',
          changed: false,
          changedCount: 0,
          newMessages: [],
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-provider-error-card"]')?.textContent)
      .toContain('Provider error');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value)
      .toBe('Analyze my local stars');
    expect(container.textContent).toContain('Retry');
  });

  it('rotates Chat and workbench session identity together', async () => {
    const container = await mountHarness();
    const firstPort = port;
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Start new conversation"]')!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ports).toHaveLength(2);
    const disconnect = firstPort.posted.find((message) => message.type === 'disconnectBgsmOrganizeJob');
    expect(disconnect).toEqual(expect.objectContaining({ type: 'disconnectBgsmOrganizeJob' }));
    await click(buttonWithText(container, 'Organize full library'));
    const nextRequest = ports[1].posted.find(
      (message) => message.type === 'requestBgsmOrganizeJobPreflight',
    );
    expect(nextRequest?.sessionId).not.toBe(disconnect?.sessionId);
    expect(nextRequest?.controllerId).not.toBe(disconnect?.controllerId);
  });

  it('ignores duplicate deliveries and reconciles a sequence gap through a replacement Port', async () => {
    const container = await mountHarness();
    await click(buttonWithText(container, 'Organize full library'));
    const request = postedMessage('requestBgsmOrganizeJobPreflight');
    const firstPort = port;
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing');
    const failed: OrganizeJobRunSnapshot = {
      ...analyzing,
      state: 'failed',
      terminalReason: 'provider_error',
    };

    await emitEnvelopeOn(firstPort, envelope('ui-gap', 0, {
      type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing,
    }));
    expect(currentPhase(container)).toBe('Analyzing');
    await emitEnvelopeOn(firstPort, envelope('ui-gap', 0, {
      type: 'bgsmOrganizeJobRunSnapshot', snapshot: failed,
    }));
    expect(currentPhase(container)).toBe('Analyzing');
    await emitEnvelopeOn(firstPort, envelope('ui-gap', 2, {
      type: 'bgsmOrganizeJobRunSnapshot', snapshot: failed,
    }));
    expect(ports).toHaveLength(2);
    expect(ports[1]?.posted).toContainEqual({
      type: 'requestBgsmOrganizeJobSnapshot',
      controllerId: analyzing.controllerId,
      sessionId: analyzing.sessionId,
      runId: analyzing.runId,
      generation: analyzing.generation,
    });

    await emitMessageOn(ports[1]!, {
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: failed,
    }, 'authoritative_snapshot', 11);
    expect(firstPort.disconnectCalls).toBe(1);
    expect(container.textContent).toContain('Full-library analysis did not finish');
  });

  it('reconnects when one Port changes epoch without resetting its sequence', async () => {
    const container = await mountHarness();
    await click(buttonWithText(container, 'Organize full library'));
    const request = postedMessage('requestBgsmOrganizeJobPreflight');
    const firstPort = port;
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing');
    await emitEnvelopeOn(firstPort, envelope('ui-epoch-a', 0, {
      type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing,
    }));
    await emitEnvelopeOn(firstPort, envelope('ui-epoch-b', 1, {
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: { ...analyzing, state: 'failed', terminalReason: 'provider_error' },
    }));
    expect(ports).toHaveLength(2);
    expect(currentPhase(container)).toBe('Analyzing');
  });

  it('reviews, applies, and renders receipts only from durable job pages', async () => {
    const container = await mountHarness();
    await click(buttonWithText(container, 'Organize full library'));
    const preflight = postedMessage('requestBgsmOrganizeJobPreflight');
    await emitMessage({
      type: 'bgsmOrganizeJobRunPreflightResult',
      controllerId: preflight.controllerId,
      sessionId: preflight.sessionId,
      requestId: preflight.requestId,
      status: 'ready',
      preflightToken: parsePreflightToken('preflight:v1:durable-review'),
      label: 'All live stars',
      count: 102,
    });
    await click(buttonWithText(container, 'Start analysis'));

    const snapshot = reviewSnapshot(preflight.controllerId, preflight.sessionId, 102);
    const coverage = completeCoverage(102, 102);
    const presentation = presentationFor(snapshot, {
      jobId: 'organize-job:v1:ui-durable',
      revision: 8,
      status: 'review',
      coverage,
      selectedRepositories: 100,
      selectedActions: 120,
    });
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      presentation,
    });
    await act(async () => { await Promise.resolve(); });

    const pageRequest = postedMessages('requestBgsmOrganizeReviewPage').at(-1)!;
    expect(pageRequest).toEqual(expect.objectContaining({
      jobId: presentation.jobId,
      rowOffset: 0,
      limit: 100,
    }));
    const reviewRows = [
      {
        position: 0,
        proposalRowId: `${snapshot.proposalId}:row:0`,
        repositoryId: 'owner/repo-0',
        proposedActions: [{ kind: 'add_existing_tag' as const, tag: 'TypeScript', evidence: 'Topic' }],
        selected: true,
      },
      {
        position: 1,
        proposalRowId: `${snapshot.proposalId}:row:1`,
        repositoryId: 'owner/repo-1',
        proposedActions: [{ kind: 'propose_new_tag' as const, tag: 'CLI', evidence: 'Tooling' }],
        selected: true,
      },
    ];
    await emitMessage({
      type: 'bgsmOrganizeReviewPage',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      requestId: pageRequest.requestId,
      jobId: presentation.jobId,
      revision: 8,
      proposalId: snapshot.proposalId!,
      totalRows: 102,
      selectedRepositories: 100,
      selectedActions: 120,
      rowOffset: 0,
      rows: reviewRows,
      nextRowOffset: 2,
    });

    expect(container.textContent).toContain('1-2 of 102');
    expect(container.textContent).toContain('Apply 120 tags to 100 repositories');
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Select owner/repo-0"]')!);
    const selection = postedMessages('updateBgsmOrganizeSelection').at(-1)!;
    expect('command' in selection).toBe(false);

    const revised = {
      ...presentation,
      revision: 9,
      selectedRepositories: 99,
      selectedActions: 119,
    };
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      presentation: revised,
    });
    await emitMessage({
      type: 'bgsmOrganizeReviewPage',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      requestId: selection.requestId,
      jobId: presentation.jobId,
      revision: 9,
      proposalId: snapshot.proposalId!,
      totalRows: 102,
      selectedRepositories: 99,
      selectedActions: 119,
      rowOffset: 0,
      rows: reviewRows.map((row, index) => index === 0 ? { ...row, selected: false } : row),
      nextRowOffset: 2,
    });
    await click(buttonWithText(container, 'Apply 119 tags to 99 repositories'));
    expect(port.posted.at(-1)).toEqual({
      type: 'applyBgsmOrganizeSelection',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      jobId: presentation.jobId,
      expectedRevision: 9,
    });

    const durableApply = {
      applyId: 'organize-apply:v1:ui-durable',
      total: 99,
      settled: 20,
      changed: 20,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    };
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      presentation: { ...revised, revision: 10, status: 'applying', apply: durableApply },
    });
    expect(container.textContent).toContain('Applying selected changes');
    expect(container.textContent).toContain('20 of 99 rows selected · checkboxes locked');

    const completedApply = {
      ...durableApply,
      settled: 99,
      changed: 1,
      unchanged: 97,
      skipped: 1,
    };
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      presentation: { ...revised, revision: 11, status: 'completed', apply: completedApply },
    });
    await act(async () => { await Promise.resolve(); });
    const receiptRequest = postedMessages('requestBgsmOrganizeReceiptPage').at(-1)!;
    expect(receiptRequest).toEqual(expect.objectContaining({
      jobId: presentation.jobId,
      applyId: completedApply.applyId,
      filter: 'all',
    }));
    await emitMessage({
      type: 'bgsmOrganizeReceiptPage',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      requestId: receiptRequest.requestId,
      applyId: completedApply.applyId,
      rowOffset: 0,
      rows: [
        {
          position: 0,
          proposalRowId: reviewRows[0]!.proposalRowId,
          repositoryId: reviewRows[0]!.repositoryId,
          outcome: 'changed',
          reason: null,
        },
        {
          position: 1,
          proposalRowId: reviewRows[1]!.proposalRowId,
          repositoryId: reviewRows[1]!.repositoryId,
          outcome: 'skipped',
          reason: 'stale_source',
        },
      ],
      nextRowOffset: null,
    });

    expect(container.querySelector('[data-testid="organize-job-receipt-card"]')).toBeTruthy();
    expect(container.textContent).toContain('Library update receipt');
    expect(container.textContent).toContain('owner/repo-0');
    expect(container.textContent).toContain('owner/repo-1');
    expect(container.textContent).toContain('Source changed after proposal');
  });
});

async function mountHarness() {
  const container = mountReact(<Harness />, mountedRoots);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function Harness() {
  const [open, setOpen] = useState(true);
  const agent = useBgsmAgent();
  const workbench = useBgsmAgentWorkbench(undefined, agent.sessionId);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Show Agent</button>
      <AgentPanel
        open={open}
        onHide={() => setOpen(false)}
        agent={agent}
        workbench={workbench}
        defaultCandidate={{ kind: 'all_live_stars' }}
      />
    </>
  );
}

class FakePort {
  posted: any[] = [];
  disconnectCalls = 0;
  private messageListeners = new Set<(message: unknown) => void>();
  private disconnectListeners = new Set<() => void>();
  private deliverySequence = 0;
  private readonly connectionEpochId = `organize-connection:v1:fake-${++fakePortEpoch}`;

  constructor(private readonly name: string) {}

  emit(
    message: unknown,
    deliveryKind: BgsmOrganizeJobDeliveryEnvelope['deliveryKind'] = 'live',
    durableRevision: number | null = null,
  ) {
    if (this.name !== 'bgsm-agent-organize-job') {
      this.messageListeners.forEach((listener) => listener(message));
      return;
    }
    this.emitEnvelope({
      type: 'bgsmOrganizeJobRunDelivery',
      connectionEpochId: this.connectionEpochId,
      deliverySequence: this.deliverySequence,
      deliveryKind,
      durableRevision,
      message: message as BgsmOrganizeJobServerMessage,
    });
  }

  emitEnvelope(delivery: BgsmOrganizeJobDeliveryEnvelope) {
    this.deliverySequence = Math.max(this.deliverySequence, delivery.deliverySequence + 1);
    this.messageListeners.forEach((listener) => listener(delivery));
  }

  asChromePort(): chrome.runtime.Port {
    return {
      name: this.name,
      sender: undefined,
      error: undefined,
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          this.messageListeners.add(listener);
          if (this.name === 'bgsm-agent') {
            listener({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-ui' });
          }
        },
        removeListener: (listener: (message: unknown) => void) => this.messageListeners.delete(listener),
        hasListener: (listener: (message: unknown) => void) => this.messageListeners.has(listener),
        hasListeners: () => this.messageListeners.size > 0,
        addRules: () => Promise.resolve(),
        getRules: () => Promise.resolve([]),
        removeRules: () => Promise.resolve(),
      },
      onDisconnect: {
        addListener: (listener: () => void) => this.disconnectListeners.add(listener),
        removeListener: (listener: () => void) => this.disconnectListeners.delete(listener),
        hasListener: (listener: () => void) => this.disconnectListeners.has(listener),
        hasListeners: () => this.disconnectListeners.size > 0,
        addRules: () => Promise.resolve(),
        getRules: () => Promise.resolve([]),
        removeRules: () => Promise.resolve(),
      },
      postMessage: (message: BgsmOrganizeJobClientMessage) => this.posted.push(message),
      disconnect: () => {
        this.disconnectCalls += 1;
        this.disconnectListeners.forEach((listener) => listener());
      },
    } as chrome.runtime.Port;
  }
}

function analysisSnapshot(
  controller: string,
  sessionId: string,
  state: 'frozen' | 'prepared' | 'checking_provider' | 'analyzing' | 'analysis_blocked',
  count = 3,
): OrganizeJobRunSnapshot {
  return {
    controllerId: parseControllerId(controller),
    sessionId,
    runId: parseRunId('run:v1:ui'),
    generation: 1,
    state,
    terminalReason: null,
    frozenScope: projectFrozenScope(createFrozenScope({
      kind: 'all_live_stars',
      label: 'All live stars',
      filterSnapshot: '{}',
      repositoryIds: Array.from({ length: count }, (_, index) => `owner/repo-${index}`),
      capturedAt: 1,
      fingerprint: parseScopeFingerprintV1(`fs:v1:${'a'.repeat(43)}`),
    })),
    budget: createProductionRunBudget(),
    usage: createEmptyRunBudgetUsage(),
    proposalId: null,
    proposalReviewSummary: null,
    continuationCursor: null,
  };
}

function reviewSnapshot(controller: string, sessionId: string, count: number): OrganizeJobRunSnapshot {
  const base = analysisSnapshot(controller, sessionId, 'analyzing', count);
  const proposalId = parseProposalId('proposal:v1:ui');
  return {
    ...base,
    state: 'review',
    usage: {
      ...base.usage,
      firstAnalyzerRequestAt: 1,
      consumedFrozenPositions: count,
      analyzerBatches: 1,
      providerAttempts: 1,
      requestedOutputTokens: 4_096,
    },
    proposalId,
    proposalReviewSummary: {
      version: 1,
      proposalId,
      runId: base.runId,
      generation: base.generation,
      totalRows: count,
    },
    coverage: completeCoverage(count, count),
  };
}

function completeCoverage(total: number, actionable: number): OrganizeJobRunCoverageSummary {
  return {
    total,
    analyzed: total,
    actionable,
    unchanged: total - actionable,
    insufficientEvidence: 0,
    missing: 0,
    tombstoned: 0,
    analysisFailed: 0,
  };
}

function presentationFor(
  snapshot: OrganizeJobRunSnapshot,
  overrides: Partial<BgsmOrganizeJobPresentation> = {},
): BgsmOrganizeJobPresentation {
  return {
    controllerId: snapshot.controllerId,
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    generation: snapshot.generation,
    jobId: 'organize-job:v1:ui',
    revision: 1,
    status: 'analyzing',
    scopeLabel: snapshot.frozenScope.label,
    scopeCount: snapshot.frozenScope.count,
    capturedAt: snapshot.frozenScope.capturedAt,
    proposalId: snapshot.proposalId ?? parseProposalId('proposal:v1:ui-presentation'),
    coverage: completeCoverage(snapshot.frozenScope.count, 0),
    selectedRepositories: 0,
    selectedActions: 0,
    apply: null,
    ...overrides,
  };
}

function envelope(
  suffix: string,
  deliverySequence: number,
  message: BgsmOrganizeJobServerMessage,
): BgsmOrganizeJobDeliveryEnvelope {
  return {
    type: 'bgsmOrganizeJobRunDelivery',
    connectionEpochId: `organize-connection:v1:${suffix}`,
    deliverySequence,
    deliveryKind: 'live',
    durableRevision: null,
    message,
  };
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function postedMessage<T extends BgsmOrganizeJobClientMessage['type']>(
  type: T,
): Extract<BgsmOrganizeJobClientMessage, { type: T }> {
  const message = postedMessages(type)[0];
  if (!message) throw new Error(`Posted message not found: ${type}`);
  return message;
}

function postedMessages<T extends BgsmOrganizeJobClientMessage['type']>(
  type: T,
): Extract<BgsmOrganizeJobClientMessage, { type: T }>[] {
  return port.posted.filter((candidate) => candidate.type === type) as Extract<
    BgsmOrganizeJobClientMessage,
    { type: T }
  >[];
}

async function emitMessage(message: BgsmOrganizeJobServerMessage) {
  await emitMessageOn(port, message);
}

async function emitMessageOn(
  target: FakePort,
  message: BgsmOrganizeJobServerMessage,
  deliveryKind: BgsmOrganizeJobDeliveryEnvelope['deliveryKind'] = 'live',
  durableRevision: number | null = null,
) {
  await act(async () => {
    target.emit(message, deliveryKind, durableRevision);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function emitEnvelopeOn(target: FakePort, delivery: BgsmOrganizeJobDeliveryEnvelope) {
  await act(async () => {
    target.emitEnvelope(delivery);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function currentPhase(container: HTMLElement): string | null | undefined {
  return container.querySelector('[data-testid="organize-job-current-phase"]')?.textContent;
}

function progressValue(container: HTMLElement): number {
  return Number(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'));
}

function expectVisibleProgress(container: HTMLElement, processed: number, total: number) {
  expect(progressValue(container)).toBe(processed);
  expect(container.querySelector('[data-testid="organize-job-progress-summary"]')?.textContent)
    .toContain(`${processed} analyzed`);
  expect(container.querySelector('[data-testid="agent-header-status"]')?.textContent)
    .toBe(`Analyzing · ${processed}/${total}`);
}

async function waitForProgress(container: HTMLElement, expected: number) {
  const deadline = Date.now() + 1_000;
  while (progressValue(container) !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(`Organize-job progress did not reach ${expected}.`);
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
  }
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}
