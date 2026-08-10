/**
 * @vitest-environment jsdom
 */
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPanel } from '@/ui/components/AgentPanel';
import { AgentHost, type AgentHostPresentation } from '@/ui/components/AgentHost';
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
import type {
  AgentSessionCommitResult,
  AgentSessionPresentationMessage,
} from '@/storage/agent-session-store';
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
let handoffTurnSequence = 0;
let agentPortExecutionEpochIds: string[];
let lastAgentMessageCreatedAt = 0;

beforeEach(() => {
  ports = [];
  handoffTurnSequence = 0;
  agentPortExecutionEpochIds = [];
  lastAgentMessageCreatedAt = 0;
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn((connectInfo?: { name?: string }) => {
        const name = connectInfo?.name ?? 'unknown';
        port = new FakePort(
          name,
          name === 'bgsm-agent'
            ? agentPortExecutionEpochIds.shift() ?? 'worker-epoch-ui'
            : undefined,
        );
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
    const request = await requestOrganizePreflight(container);
    const activeBase = analysisSnapshot(request.controllerId, request.sessionId, 'frozen');

    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: activeBase });
    expect(currentPhase(container)).toBe('Scope locked');
    expect(container.textContent).not.toContain('Resolving scope');

    await emitMessage({
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: { ...activeBase, state: 'checking_provider' },
    });
    expect(currentPhase(container)).toBe('Checking AI service');

    await emitMessage({
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: { ...activeBase, state: 'analyzing' },
    });
    expect(currentPhase(container)).toBe('Analyzing');
    expect(container.querySelector('[aria-label="Cubby activity"]')).toBeNull();
  });

  it('advances every visible progress surface one repository at a time', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing', 30);
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing });
    expectVisibleProgress(container, 0, 30);
    for (let expected = 1; expected <= 3; expected += 1) {
      await emitMessage({
        type: 'bgsmOrganizeJobAnalysisProgress',
        controllerId: analyzing.controllerId,
        sessionId: analyzing.sessionId,
        runId: analyzing.runId,
        generation: analyzing.generation,
        processed: expected,
        total: 30,
      });
      expectVisibleProgress(container, expected, 30);
    }

    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: analyzing.controllerId,
      sessionId: analyzing.sessionId,
      role: 'owner',
      presentation: presentationFor(analyzing, {
        coverage: {
          total: 30,
          analyzed: 25,
          actionable: 0,
          unchanged: 0,
          insufficientEvidence: 25,
          missing: 0,
          tombstoned: 0,
          analysisFailed: 0,
        },
      }),
    });
    expectVisibleProgress(container, 25, 30);
  });

  it('reports toolbar progress from streamed rows before the durable batch checkpoint', async () => {
    const presentations: AgentHostPresentation[] = [];
    mountReact(
      <AgentHost
        open
        onHide={vi.fn()}
        onPresentationChange={(presentation) => presentations.push(presentation)}
        defaultCandidate={{ kind: 'all_live_stars' }}
        chatCandidate={{
          kind: 'current_view',
          filter: {
            query: '',
            languages: [],
            tags: [],
            tagMode: 'any',
            showTombstone: false,
            onlyFavorite: false,
            onlyUntagged: false,
            onlyArchived: false,
            sortKey: 'starred_at',
            sortDir: 'desc',
          },
        }}
        scopeCount={30}
      />,
      mountedRoots,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const request = postedMessages('requestBgsmActiveOrganizeJob').at(-1)!;
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing', 30);
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: analyzing.controllerId,
      sessionId: analyzing.sessionId,
      role: 'owner',
      presentation: presentationFor(analyzing, {
        coverage: {
          total: 30,
          analyzed: 0,
          actionable: 0,
          unchanged: 0,
          insufficientEvidence: 0,
          missing: 0,
          tombstoned: 0,
          analysisFailed: 0,
        },
      }),
    });
    expect(presentations.at(-1)?.status).toBe('0/30');
    await emitMessage({
      type: 'bgsmOrganizeJobAnalysisProgress',
      controllerId: analyzing.controllerId,
      sessionId: analyzing.sessionId,
      runId: analyzing.runId,
      generation: analyzing.generation,
      processed: 1,
      total: 30,
    });
    expect(presentations.at(-1)?.status).toBe('1/30');
  });

  it('stops toolbar activity when the durable job completes with a stale review snapshot', async () => {
    const presentations: AgentHostPresentation[] = [];
    mountReact(
      <AgentHost
        open
        onHide={vi.fn()}
        onPresentationChange={(presentation) => presentations.push(presentation)}
        defaultCandidate={{ kind: 'all_live_stars' }}
        chatCandidate={{
          kind: 'current_view',
          filter: {
            query: '',
            languages: [],
            tags: [],
            tagMode: 'any',
            showTombstone: false,
            onlyFavorite: false,
            onlyUntagged: false,
            onlyArchived: false,
            sortKey: 'starred_at',
            sortDir: 'desc',
          },
        }}
        scopeCount={3}
      />,
      mountedRoots,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const request = postedMessages('requestBgsmActiveOrganizeJob').at(-1)!;
    const review = reviewSnapshot(request.controllerId, request.sessionId, 3);
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: review });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: review.controllerId,
      sessionId: review.sessionId,
      role: null,
      presentation: presentationFor(review, { status: 'completed' }),
    });

    expect(presentations.at(-1)).toEqual({ status: 'Completed', active: false });
  });

  it('stops toolbar activity when a newer child snapshot fails before the durable presentation advances', async () => {
    const presentations: AgentHostPresentation[] = [];
    mountReact(
      <AgentHost
        open
        onHide={vi.fn()}
        onPresentationChange={(presentation) => presentations.push(presentation)}
        defaultCandidate={{ kind: 'all_live_stars' }}
        chatCandidate={{
          kind: 'current_view',
          filter: {
            query: '',
            languages: [],
            tags: [],
            tagMode: 'any',
            showTombstone: false,
            onlyFavorite: false,
            onlyUntagged: false,
            onlyArchived: false,
            sortKey: 'starred_at',
            sortDir: 'desc',
          },
        }}
        scopeCount={3}
      />,
      mountedRoots,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const request = postedMessages('requestBgsmActiveOrganizeJob').at(-1)!;
    const parentBase = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing', 3);
    const parent: OrganizeJobRunSnapshot = {
      ...parentBase,
      usage: {
        ...parentBase.usage,
        firstAnalyzerRequestAt: 1,
        consumedFrozenPositions: 1,
        analyzerBatches: 1,
        providerAttempts: 1,
      },
    };
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: parent });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: parent.controllerId,
      sessionId: parent.sessionId,
      role: 'owner',
      presentation: presentationFor(parent),
    });
    await emitMessage({
      type: 'bgsmOrganizeJobRunEvent',
      event: {
        type: 'budget_exhausted',
        controllerId: parent.controllerId,
        sessionId: parent.sessionId,
        runId: parent.runId,
        generation: parent.generation,
        eventId: 'toolbar-parent-budget-exhausted',
        state: 'budget_exhausted',
        reason: 'requested_output_tokens',
        budget: parent.budget,
        usage: parent.usage,
        continuationCursor: parseContinuationCursorToken('cursor:v1:toolbar-child'),
      },
    });

    const child: OrganizeJobRunSnapshot = {
      ...parent,
      runId: parseRunId('run:v1:toolbar-child'),
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
        state: 'failed',
        terminalReason: 'internal_error',
      },
    });

    expect(presentations.at(-1)).toEqual({ status: 'Failed', active: false });
  });

  it('renders a same-generation runtime failure over a durable analyzing phase', async () => {
    const presentations: AgentHostPresentation[] = [];
    const container = mountReact(
      <AgentHost
        open
        onHide={vi.fn()}
        onPresentationChange={(presentation) => presentations.push(presentation)}
        defaultCandidate={{ kind: 'all_live_stars' }}
        chatCandidate={{
          kind: 'current_view',
          filter: {
            query: '',
            languages: [],
            tags: [],
            tagMode: 'any',
            showTombstone: false,
            onlyFavorite: false,
            onlyUntagged: false,
            onlyArchived: false,
            sortKey: 'starred_at',
            sortDir: 'desc',
          },
        }}
        scopeCount={30}
      />,
      mountedRoots,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const request = postedMessages('requestBgsmActiveOrganizeJob').at(-1)!;
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing', 30);
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: analyzing.controllerId,
      sessionId: analyzing.sessionId,
      role: 'owner',
      presentation: presentationFor(analyzing),
    });
    await emitMessage({
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: {
        ...analyzing,
        state: 'failed',
        terminalReason: 'internal_error',
      },
    });

    expect(container.querySelector('[data-testid="agent-header-status"]')?.textContent)
      .toBe('Analysis paused before completion');
    expect(container.textContent).toContain('Analysis paused before completion');
    expect(currentPhase(container)).toBeUndefined();
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    expect(presentations.at(-1)).toEqual({ status: 'Failed', active: false });
  });

  it('handles empty and confirmed preflight without exposing protocol details', async () => {
    const container = await mountHarness();
    const emptyRequest = await requestOrganizePreflight(container);
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

    const readyRequest = await requestOrganizePreflight(container);
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
    expect(container.textContent).toContain('This analysis will include 290 repositories.');
    expect(container.textContent).not.toContain('frozen for this run');
    expect(container.textContent).toContain('No tags are changed at this step');
    expect(container.querySelector('textarea')?.closest('form')?.textContent)
      .toContain('Pending confirmation · 290 repositories');
    expect(container.textContent?.match(/Pending confirmation · 290 repositories/gu))
      .toHaveLength(1);
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(container.innerHTML).not.toContain('preflight:v1:ui-confirm');
    await click(buttonWithText(container, 'Start analysis'));
    expect(activeOrganizePort().posted).toContainEqual(expect.objectContaining({
      type: 'startBgsmOrganizeJob',
      preflightToken: 'preflight:v1:ui-confirm',
    }));
    expect(container.textContent).toContain('Starting analysis');
    await emitMessage({
      type: 'bgsmOrganizeJobRunError',
      controllerId: readyRequest.controllerId,
      sessionId: readyRequest.sessionId,
      runId: null,
      generation: null,
      reason: 'preflight_stale',
      message: 'The saved analysis scope expired. Prepare it again.',
      requestId: readyRequest.requestId,
    });
    expect(container.textContent).toContain('The saved analysis scope is incomplete. Prepare it again.');
    expect(container.textContent).not.toContain('Confirm analysis scope');
  });

  it('lets the Agent confirm a ready scope and start analysis exactly once', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    await emitMessage({
      type: 'bgsmOrganizeJobRunPreflightResult',
      controllerId: request.controllerId,
      sessionId: request.sessionId,
      requestId: request.requestId,
      status: 'ready',
      preflightToken: parsePreflightToken('preflight:v1:agent-confirm'),
      label: 'All live stars',
      count: 303,
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    expect(textarea?.disabled).toBe(false);
    expect(send?.disabled).toBe(true);
    await setTextareaValue(textarea!, '确认，开始分析');
    expect(send?.disabled).toBe(false);
    await click(send!);
    await completeAgentOrganizeAction('确认，开始分析', 'start_analysis');

    const starts = postedMessages('startBgsmOrganizeJob');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual(expect.objectContaining({
      requestId: request.requestId,
      preflightToken: 'preflight:v1:agent-confirm',
    }));
    expect(container.textContent).toContain('Starting analysis');
    expect(container.querySelector('[data-testid="agent-header-status"]')?.textContent)
      .toBe('Starting analysis');
    expect(container.querySelector('[data-testid="agent-stopbar"]')?.textContent)
      .toContain('Starting analysis');
  });

  it('defers an Agent start handoff across an Organize Port disconnect', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    await emitMessage({
      type: 'bgsmOrganizeJobRunPreflightResult',
      controllerId: request.controllerId,
      sessionId: request.sessionId,
      requestId: request.requestId,
      status: 'ready',
      preflightToken: parsePreflightToken('preflight:v1:deferred-start'),
      label: 'All live stars',
      count: 303,
    });

    const prompt = '确认，开始分析';
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    const disconnectedPort = activeOrganizePort();
    disconnectedPort.rejectPosts = true;
    await completeAgentOrganizeAction(prompt, 'start_analysis');
    expect(disconnectedPort.posted.some((message) => message.type === 'startBgsmOrganizeJob'))
      .toBe(false);

    await act(async () => {
      disconnectedPort.disconnect();
      await Promise.resolve();
      await Promise.resolve();
    });

    const replacementPort = activeOrganizePort();
    expect(replacementPort).not.toBe(disconnectedPort);
    expect(replacementPort.posted).toContainEqual(expect.objectContaining({
      type: 'startBgsmOrganizeJob',
      requestId: request.requestId,
      preflightToken: 'preflight:v1:deferred-start',
    }));
  });

  it('defers an Agent confirmation handoff instead of leaving a false requesting state', async () => {
    const container = await mountHarness();
    const prompt = '整理所有仓库并先让我确认范围';
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    const agentPort = agentPorts().at(-1);
    const turn = agentPort?.posted.find((message) => message.type === 'startBgsmAgentTurn');
    if (!agentPort || !turn) throw new Error('Agent confirmation turn did not start.');
    const disconnectedPort = activeOrganizePort();
    disconnectedPort.rejectPosts = true;

    await act(async () => {
      agentPort.emit({
        type: 'bgsmAgentTurnResult',
        sequence: 0,
        result: {
          turnAttemptId: turn.turnAttemptId,
          sessionId: turn.sessionId,
          baseRevision: turn.baseRevision,
          reason: 'final_answer',
          changed: false,
          changedCount: 0,
          commit: workbenchCommitForMessages(turn, [
            { id: 'deferred-request-user', role: 'user', content: prompt, createdAt: 10 },
            {
              id: 'deferred-request-agent',
              role: 'agent',
              content: 'Opening scope confirmation.',
              createdAt: 11,
            },
          ], { organizeLibraryAction: 'request_confirmation' }),
          organizeLibraryHandoff: {
            type: 'organize_whole_library',
            action: 'request_confirmation',
            instruction: prompt,
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(disconnectedPort.posted.some((message) => (
      message.type === 'requestBgsmOrganizeJobPreflight'
    ))).toBe(false);
    expect(container.textContent).toContain('Resolving scope');

    await act(async () => {
      disconnectedPort.disconnect();
      await Promise.resolve();
      await Promise.resolve();
    });

    const replacementPort = activeOrganizePort();
    expect(replacementPort).not.toBe(disconnectedPort);
    expect(replacementPort.posted).toContainEqual(expect.objectContaining({
      type: 'requestBgsmOrganizeJobPreflight',
      taskInstruction: prompt,
    }));
  });

  it('does not apply a late Agent start handoff after the user cancels confirmation', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    await emitMessage({
      type: 'bgsmOrganizeJobRunPreflightResult',
      controllerId: request.controllerId,
      sessionId: request.sessionId,
      requestId: request.requestId,
      status: 'ready',
      preflightToken: parsePreflightToken('preflight:v1:cancel-before-handoff'),
      label: 'All live stars',
      count: 303,
    });

    const prompt = '确认，开始分析';
    await setTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea')!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await click(buttonWithText(container, 'Cancel'));
    await completeAgentOrganizeAction(prompt, 'start_analysis');

    expect(postedMessages('startBgsmOrganizeJob')).toHaveLength(0);
    expect(postedMessages('requestBgsmOrganizeJobPreflight')).toHaveLength(1);
    expect(container.textContent).not.toContain('Confirm analysis scope');
  });

  it('keeps follow-up chat below a ready confirmation card before analysis starts', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    await emitMessage({
      type: 'bgsmOrganizeJobRunPreflightResult',
      controllerId: request.controllerId,
      sessionId: request.sessionId,
      requestId: request.requestId,
      status: 'ready',
      preflightToken: parsePreflightToken('preflight:v1:ordered-confirmation'),
      label: 'All live stars',
      count: 303,
    });

    const followUp = '分析完成后会先让我审阅吗？';
    await completeObservedAgentTurn(container, followUp, '会，应用标签前会先展示完整审阅。');

    const confirmation = buttonWithText(container, 'Start analysis').closest('[data-role="system"]');
    const followUpBubble = [...container.querySelectorAll('[data-role="user"]')]
      .find((element) => element.textContent?.includes(followUp));
    expect(confirmation).not.toBeNull();
    expect(followUpBubble).not.toBeUndefined();
    expect(confirmation!.compareDocumentPosition(followUpBubble!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
  });

  it('freezes the full scope and starts automatically when the Agent receives explicit start intent', async () => {
    const container = await mountHarness();
    const prompt = '现在开始分析整个 starred 资料库';
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    await setTextareaValue(textarea!, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
    await completeAgentOrganizeAction(prompt, 'start_analysis');

    const request = postedMessages('requestBgsmOrganizeJobPreflight').at(-1);
    expect(request).toBeTruthy();
    expect(postedMessages('startBgsmOrganizeJob')).toHaveLength(0);
    await emitMessage({
      type: 'bgsmOrganizeJobRunPreflightResult',
      controllerId: request!.controllerId,
      sessionId: request!.sessionId,
      requestId: request!.requestId,
      status: 'ready',
      preflightToken: parsePreflightToken('preflight:v1:agent-direct-start'),
      label: 'All live stars',
      count: 303,
    });

    const starts = postedMessages('startBgsmOrganizeJob');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual(expect.objectContaining({
      requestId: request!.requestId,
      preflightToken: 'preflight:v1:agent-direct-start',
      taskInstruction: prompt,
    }));
    expect(container.textContent).toContain('Starting analysis');
  });

  it('keeps analysis failures review-free and resumes only the failed suffix', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
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
      role: 'owner',
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
    expect(activeOrganizePort().posted.at(-1)).toEqual({
      type: 'continueBgsmOrganizeJob',
      controllerId: blocked.controllerId,
      sessionId: blocked.sessionId,
      runId: blocked.runId,
      generation: blocked.generation,
      continuationCursor,
    });
  });

  it('rolls back a failed Continue send and allows a clean retry', async () => {
    const container = await mountHarness();
    await enterBlockedAnalysis(container, 'continue-send-retry');
    const organizePort = activeOrganizePort();
    organizePort.rejectPosts = true;

    await click(buttonWithText(container, 'Continue remaining'));
    const retry = buttonWithText(container, 'Continue remaining');
    expect(retry.disabled).toBe(false);
    expect(retry.querySelector('[data-testid="spinner"]')).toBeNull();
    expect(postedMessages('continueBgsmOrganizeJob')).toHaveLength(0);

    organizePort.rejectPosts = false;
    await click(retry);
    expect(postedMessages('continueBgsmOrganizeJob')).toHaveLength(1);
  });

  it('posts a rapid repeated Continue request only once', async () => {
    const container = await mountHarness();
    await enterBlockedAnalysis(container, 'continue-double-click');
    const button = buttonWithText(container, 'Continue remaining');

    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });

    expect(postedMessages('continueBgsmOrganizeJob')).toHaveLength(1);
  });

  it('posts a rapid repeated Stop request only once', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing');
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing });
    const button = buttonWithText(container, 'Stop');

    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });

    expect(postedMessages('stopBgsmOrganizeJob')).toEqual([
      expect.objectContaining({ requestId: expect.any(String) }),
    ]);
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
  });

  it('rolls back a failed Stop send and allows a clean retry', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing');
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing });
    const organizePort = activeOrganizePort();
    organizePort.rejectPosts = true;

    await click(buttonWithText(container, 'Stop'));
    const retry = buttonWithText(container, 'Stop');
    expect(retry.disabled).toBe(false);
    expect(postedMessages('stopBgsmOrganizeJob')).toHaveLength(0);

    organizePort.rejectPosts = false;
    await click(retry);
    expect(postedMessages('stopBgsmOrganizeJob')).toHaveLength(1);
  });

  it('serializes Apply, Pause, and Resume until each durable phase advances', async () => {
    const container = await mountHarness();
    const { snapshot, presentation } = await enterDurableReview(container, 'command-serialization');
    const applyButton = buttonWithText(container, 'Apply 2 tags to 2 repositories');

    await act(async () => {
      applyButton.click();
      applyButton.click();
      await Promise.resolve();
    });

    expect(postedMessages('applyBgsmOrganizeSelection')).toHaveLength(1);
    expect(postedMessages('applyBgsmOrganizeSelection')[0]).toEqual(
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(applyButton.disabled).toBe(true);
    expect(container.querySelector('[data-testid="organize-job-applying-progress"]')).toBeTruthy();

    const apply = {
      applyId: 'organize-apply:v1:command-serialization',
      total: 2,
      settled: 0,
      changed: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    };
    const applying = {
      ...presentation,
      revision: presentation.revision + 1,
      status: 'applying' as const,
      apply,
    };
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: 'owner',
      presentation: applying,
    });
    const pauseButton = buttonWithText(container, 'Pause');

    await act(async () => {
      pauseButton.click();
      pauseButton.click();
      await Promise.resolve();
    });

    expect(postedMessages('stopBgsmOrganizeJob')).toEqual([
      expect.objectContaining({ requestId: expect.any(String) }),
    ]);
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();

    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: 'owner',
      presentation: { ...applying, revision: applying.revision + 1 },
    });
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();

    const paused = {
      ...applying,
      revision: applying.revision + 2,
      status: 'paused' as const,
    };
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: 'owner',
      presentation: paused,
    });
    const resumeButton = buttonWithText(container, 'Continue');

    await act(async () => {
      resumeButton.click();
      resumeButton.click();
      await Promise.resolve();
    });

    expect(postedMessages('resumeBgsmOrganizeApply')).toEqual([
      expect.objectContaining({ requestId: expect.any(String) }),
    ]);
    expect(buttonWithText(container, 'Continue').disabled).toBe(true);

    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: 'owner',
      presentation: { ...paused, revision: paused.revision + 1 },
    });
    expect(buttonWithText(container, 'Continue').disabled).toBe(true);
  });

  it('ignores a stale Pause click after the authoritative state is already paused', async () => {
    const container = await mountHarness();
    const { snapshot, presentation } = await enterDurableReview(container, 'stale-pause-click');
    await click(buttonWithText(container, 'Apply 2 tags to 2 repositories'));
    const apply = {
      applyId: 'organize-apply:v1:stale-pause-click',
      total: 2,
      settled: 1,
      changed: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    };
    const applying = {
      ...presentation,
      revision: presentation.revision + 1,
      status: 'applying' as const,
      apply,
    };
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: 'owner',
      presentation: applying,
    });
    const stalePauseButton = buttonWithText(container, 'Pause');
    const paused = {
      ...applying,
      revision: applying.revision + 1,
      status: 'paused' as const,
    };

    await act(async () => {
      activeOrganizePort().emit({
        type: 'bgsmOrganizeJobState',
        controllerId: snapshot.controllerId,
        sessionId: snapshot.sessionId,
        role: 'owner',
        presentation: paused,
      });
      stalePauseButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(postedMessages('stopBgsmOrganizeJob')).toHaveLength(0);
    expect(buttonWithText(container, 'Continue')).toBeTruthy();
  });

  it('discards a blocked runtime run even while durable state still says analyzing', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const base = analysisSnapshot(request.controllerId, request.sessionId, 'analysis_blocked');
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
      ...base,
      terminalReason: 'analysis_failed',
      continuationCursor: parseContinuationCursorToken('cursor:v1:mixed-authority-discard'),
      coverage,
    };
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: blocked });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: blocked.controllerId,
      sessionId: blocked.sessionId,
      role: 'owner',
      presentation: presentationFor(blocked, {
        jobId: 'organize-job:v1:mixed-authority-discard',
        status: 'analyzing',
        coverage,
      }),
    });

    expect(container.textContent).toContain('1 repository could not be analyzed');
    await click(buttonWithText(container, 'Discard this analysis'));
    expect(postedMessages('stopBgsmOrganizeJob')).toEqual([
      expect.objectContaining({
        type: 'stopBgsmOrganizeJob',
        controllerId: blocked.controllerId,
        sessionId: blocked.sessionId,
        runId: blocked.runId,
        generation: blocked.generation,
        requestId: expect.any(String),
      }),
    ]);
  });

  it('restarts visible progress from durable coverage when retrying a failed suffix', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const total = 319;
    const retryFrom = 300;
    const continuationCursor = parseContinuationCursorToken('cursor:v1:failed-suffix-progress');
    const parentBase = analysisSnapshot(
      request.controllerId,
      request.sessionId,
      'analysis_blocked',
      total,
    );
    const parentCoverage: OrganizeJobRunCoverageSummary = {
      total,
      analyzed: total,
      actionable: 0,
      unchanged: retryFrom,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: total - retryFrom,
    };
    const parent: OrganizeJobRunSnapshot = {
      ...parentBase,
      terminalReason: 'analysis_failed',
      coverage: parentCoverage,
      continuationCursor,
    };
    const parentPresentation = presentationFor(parent, {
      jobId: 'organize-job:v1:failed-suffix-progress',
      revision: 20,
      status: 'analysis_blocked',
      coverage: parentCoverage,
    });
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: parent });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: parent.controllerId,
      sessionId: parent.sessionId,
      role: 'owner',
      presentation: parentPresentation,
    });
    await click(buttonWithText(container, 'Continue remaining'));
    expect(container.querySelector('[data-testid="agent-header-status"]')?.textContent)
      .toBe('Analyzing · 300/319');
    expect(container.textContent).not.toContain('Analysis paused before completion');

    const childRunId = parseRunId('run:v1:failed-suffix-progress-child');
    const childCoverage: OrganizeJobRunCoverageSummary = {
      ...parentCoverage,
      analyzed: retryFrom,
      analysisFailed: 0,
    };
    const child: OrganizeJobRunSnapshot = {
      ...parent,
      runId: childRunId,
      generation: parent.generation + 1,
      state: 'analyzing',
      terminalReason: null,
      usage: createEmptyRunBudgetUsage(),
      coverage: childCoverage,
      continuationCursor: null,
    };
    const childPresentation = presentationFor(child, {
      jobId: parentPresentation.jobId,
      revision: parentPresentation.revision + 1,
      status: 'analyzing',
      coverage: childCoverage,
    });

    // Durable continuation initialization is published before the child snapshot.
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: child.controllerId,
      sessionId: child.sessionId,
      role: 'owner',
      presentation: childPresentation,
    });
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: child });
    expectVisibleProgress(container, retryFrom, total);

    await emitMessage({
      type: 'bgsmOrganizeJobAnalysisProgress',
      controllerId: child.controllerId,
      sessionId: child.sessionId,
      runId: child.runId,
      generation: child.generation,
      processed: retryFrom + 1,
      total,
    });
    expectVisibleProgress(container, retryFrom + 1, total);

    const reviewPresentation = presentationFor(child, {
      jobId: parentPresentation.jobId,
      revision: childPresentation.revision + 1,
      status: 'review',
      coverage: {
        ...childCoverage,
        analyzed: total,
        unchanged: total,
      },
    });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: child.controllerId,
      sessionId: child.sessionId,
      role: 'owner',
      presentation: reviewPresentation,
    });

    expect(currentPhase(container)).toBeUndefined();
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(container.textContent).not.toContain('Analyzing ·');
  });

  it('waits for the durable blocked generation snapshot before exposing Continue', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const parent = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing', 315);
    const parentPresentation = presentationFor(parent, {
      revision: 20,
      coverage: {
        ...completeCoverage(315, 0),
        analyzed: 150,
        unchanged: 150,
      },
    });
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: parent });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: parent.controllerId,
      sessionId: parent.sessionId,
      role: 'owner',
      presentation: parentPresentation,
    });

    const childRunId = parseRunId('run:v1:ui-blocked-child');
    const childPresentation: BgsmOrganizeJobPresentation = {
      ...parentPresentation,
      runId: childRunId,
      generation: 2,
      revision: 21,
      status: 'analysis_blocked',
      coverage: {
        total: 315,
        analyzed: 315,
        actionable: 80,
        unchanged: 234,
        insufficientEvidence: 0,
        missing: 0,
        tombstoned: 0,
        analysisFailed: 1,
      },
      selectedRepositories: 80,
      selectedActions: 80,
    };
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: childPresentation.controllerId,
      sessionId: childPresentation.sessionId,
      role: 'owner',
      presentation: childPresentation,
    });

    expect(container.textContent).toContain('1 repository could not be analyzed');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Continue remaining')))
      .toBe(false);

    const continuationCursor = parseContinuationCursorToken('cursor:v1:ui-blocked-child');
    const childSnapshot: OrganizeJobRunSnapshot = {
      ...parent,
      runId: childRunId,
      generation: 2,
      state: 'analysis_blocked',
      terminalReason: 'analysis_failed',
      coverage: childPresentation.coverage,
      continuationCursor,
    };
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: childSnapshot });
    await click(buttonWithText(container, 'Continue remaining'));
    expect(activeOrganizePort().posted.at(-1)).toEqual({
      type: 'continueBgsmOrganizeJob',
      controllerId: childSnapshot.controllerId,
      sessionId: childSnapshot.sessionId,
      runId: childSnapshot.runId,
      generation: childSnapshot.generation,
      continuationCursor,
    });
  });

  it('continues an exhausted analysis internally as one cumulative task', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
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

    expect(container.textContent).not.toContain('Run limit reached');
    expect(container.textContent).not.toContain('Continue remaining');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);

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

  it('renders a newer durable generation while its child snapshot is still arriving', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const parentBase = analysisSnapshot(request.controllerId, request.sessionId, 'analysis_blocked', 315);
    const parent: OrganizeJobRunSnapshot = {
      ...parentBase,
      terminalReason: 'analysis_failed',
      usage: {
        ...parentBase.usage,
        firstAnalyzerRequestAt: 1,
        consumedFrozenPositions: 75,
        analyzerBatches: 3,
        providerAttempts: 3,
        requestedOutputTokens: 12_288,
      },
      coverage: {
        ...completeCoverage(315, 0),
        analyzed: 75,
        unchanged: 74,
        analysisFailed: 1,
      },
      continuationCursor: parseContinuationCursorToken('cursor:v1:ui-durable-generation'),
    };
    const parentPresentation = presentationFor(parent, {
      revision: 20,
      status: 'analysis_blocked',
      coverage: parent.coverage!,
    });
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: parent });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: parent.controllerId,
      sessionId: parent.sessionId,
      role: 'owner',
      presentation: parentPresentation,
    });

    const child: OrganizeJobRunSnapshot = {
      ...parent,
      runId: parseRunId('run:v1:ui-durable-generation-child'),
      generation: 2,
      state: 'analyzing',
      terminalReason: null,
      usage: {
        ...createEmptyRunBudgetUsage(),
        firstAnalyzerRequestAt: 2,
        consumedFrozenPositions: 50,
        analyzerBatches: 2,
        providerAttempts: 2,
      },
      coverage: {
        ...completeCoverage(315, 0),
        analyzed: 125,
        actionable: 81,
        unchanged: 33,
        insufficientEvidence: 11,
      },
      continuationCursor: null,
    };
    const childPresentation = presentationFor(child, {
      jobId: parentPresentation.jobId,
      revision: 21,
      coverage: child.coverage!,
    });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: child.controllerId,
      sessionId: child.sessionId,
      role: 'owner',
      presentation: childPresentation,
    });

    expectVisibleProgress(container, 125, 315);
    expect(currentPhase(container)).toBe('Analyzing');
    expect(container.textContent).not.toContain('Analysis paused before completion');
    expect(container.textContent).not.toContain('Continue remaining');
    await click(buttonWithText(container, 'Stop'));
    expect(activeOrganizePort().posted.at(-1)).toEqual({
      type: 'stopBgsmOrganizeJob',
      controllerId: child.controllerId,
      sessionId: child.sessionId,
      runId: child.runId,
      generation: child.generation,
      requestId: expect.any(String),
    });

    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: child });
    const reviewPresentation = {
      ...childPresentation,
      revision: 22,
      status: 'review' as const,
      coverage: completeCoverage(315, 80),
      selectedRepositories: 80,
      selectedActions: 80,
    };
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: child.controllerId,
      sessionId: child.sessionId,
      role: 'owner',
      presentation: reviewPresentation,
    });
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(currentPhase(container)).toBeUndefined();
  });

  it('renders a stopped task without suggesting that changes were applied', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const base = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing', 28);
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: base });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: base.controllerId,
      sessionId: base.sessionId,
      role: 'owner',
      presentation: presentationFor(base, {
        status: 'analyzing',
        coverage: {
          ...completeCoverage(28, 0),
          analyzed: 9,
          unchanged: 9,
        },
      }),
    });
    await emitMessage({
      type: 'bgsmOrganizeJobRunResult',
      controllerId: base.controllerId,
      sessionId: base.sessionId,
      runId: base.runId,
      generation: base.generation,
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
    expect(container.textContent).not.toContain('Tag update results');
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(container.querySelector('[data-testid="organize-job-current-phase"]')).toBeNull();
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
          commit: null,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="agent-provider-error-card"]')?.textContent)
      .toContain('AI service error');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value)
      .toBe('Analyze my local stars');
    expect(container.textContent).toContain('Retry');
  });

  it('unlocks and retries a read-only turn after the extension worker restarts', async () => {
    agentPortExecutionEpochIds = [
      'worker-epoch-ui-original',
      'worker-epoch-ui-restarted',
      'worker-epoch-ui-retry',
    ];
    const container = await mountHarness();
    const prompt = 'Find exactly three terminal coding agents.';
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await setTextareaValue(textarea, prompt);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);

    const firstPort = agentPorts()[0];
    const firstTurn = firstPort?.posted.find((message) => message.type === 'startBgsmAgentTurn');
    if (!firstPort || !firstTurn) throw new Error('Initial Agent turn did not start.');
    await act(async () => {
      firstPort.emit({
        type: 'bgsmAgentTurnEvent',
        sequence: 0,
        event: {
          type: 'assistant_text_delta',
          turnAttemptId: firstTurn.turnAttemptId,
          sessionId: firstTurn.sessionId,
          baseRevision: firstTurn.baseRevision,
          step: 0,
          delta: 'Searching candidates...',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain('Searching candidates...');
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeTruthy();

    await act(async () => {
      firstPort.disconnect();
      await Promise.resolve();
    });
    const restartedPort = agentPorts()[1];
    const resumedTurn = restartedPort?.posted.find((message) => message.type === 'startBgsmAgentTurn');
    if (!restartedPort || !resumedTurn) throw new Error('Agent turn did not reconnect.');
    expect(resumedTurn).toEqual(expect.objectContaining({
      executionEpochId: 'worker-epoch-ui-restarted',
      turnAttemptId: firstTurn.turnAttemptId,
      prompt,
    }));

    await act(async () => {
      restartedPort.emit({
        type: 'bgsmAgentTurnResult',
        sequence: 0,
        result: {
          turnAttemptId: firstTurn.turnAttemptId,
          sessionId: firstTurn.sessionId,
          baseRevision: firstTurn.baseRevision,
          reason: 'attempt_state_lost',
          changed: false,
          changedCount: 0,
          commit: null,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Searching candidates...');
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe(prompt);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled)
      .toBe(false);
    const retry = buttonWithText(container, 'Retry');
    expect(retry.disabled).toBe(false);

    await act(async () => {
      restartedPort.emit({
        type: 'bgsmAgentTurnAck',
        turnAttemptId: firstTurn.turnAttemptId,
        sessionId: firstTurn.sessionId,
        baseRevision: firstTurn.baseRevision,
        disposition: 'no_transition',
        appliedRevision: null,
      });
      await Promise.resolve();
    });
    await click(retry);

    const retryPort = agentPorts()[2];
    const retryTurn = retryPort?.posted.find((message) => message.type === 'startBgsmAgentTurn');
    if (!retryPort || !retryTurn) throw new Error('Retry Agent turn did not start.');
    expect(retryTurn).toEqual(expect.objectContaining({
      executionEpochId: 'worker-epoch-ui-retry',
      sessionId: firstTurn.sessionId,
      baseRevision: firstTurn.baseRevision,
      prompt,
    }));
    expect(retryTurn).not.toHaveProperty('history');
    expect(retryTurn.turnAttemptId).not.toBe(firstTurn.turnAttemptId);
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeTruthy();
    expect(textarea.disabled).toBe(true);
  });

  it('keeps review history collapsed and appends multi-turn Agent replies after the workbench', async () => {
    const container = await mountHarness();
    const activeRequest = postedMessages('requestBgsmActiveOrganizeJob').at(-1);
    if (!activeRequest) throw new Error('Active organize-job request was not sent.');
    const snapshot = reviewSnapshot(activeRequest.controllerId, activeRequest.sessionId, 1);
    const presentation = presentationFor(snapshot, {
      status: 'review',
      coverage: completeCoverage(1, 1),
      selectedRepositories: 1,
      selectedActions: 1,
    });
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: 'owner',
      presentation,
    });
    await act(async () => { await Promise.resolve(); });
    const pageRequest = postedMessages('requestBgsmOrganizeReviewPage').at(-1);
    if (!pageRequest) throw new Error('Review page request was not sent.');
    await emitMessage({
      type: 'bgsmOrganizeReviewPage',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      requestId: pageRequest.requestId,
      jobId: presentation.jobId,
      revision: presentation.revision,
      proposalId: snapshot.proposalId!,
      totalRows: 1,
      selectedRepositories: 1,
      selectedActions: 1,
      rowOffset: 0,
      rows: [{
        position: 0,
        proposalRowId: `${snapshot.proposalId}:row:0`,
        repositoryId: 'owner/repo-0',
        proposedActions: [{ kind: 'add_existing_tag', tag: 'TypeScript', evidence: 'Topic' }],
        selected: true,
      }],
      nextRowOffset: null,
    });

    const details = container.querySelector<HTMLDetailsElement>(
      '[data-testid="agent-run-transcript-details"]',
    );
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);

    const first = await completeObservedAgentTurn(
      container,
      'If I organize every repository later, what happens? Do not start it.',
      'I can explain the workflow without starting it.',
    );
    const second = await completeObservedAgentTurn(
      container,
      'Okay.',
      'That acknowledgement alone does not authorize a new analysis.',
    );
    const finalAnswer = 'A review is already active, so a new full-library analysis cannot start.';
    const third = await completeObservedAgentTurn(
      container,
      'Start organizing all my repositories now.',
      finalAnswer,
      {
        toolName: 'start_full_library_analysis',
        toolResult: JSON.stringify({
          status: 'blocked_by_existing_job',
          activeJobStatus: 'review',
          writesPerformed: false,
        }),
      },
    );

    expect([first.baseRevision, second.baseRevision, third.baseRevision]).toEqual([0, 1, 2]);
    const reviewWorkbench = container.querySelector('[data-testid="organize-job-workbench"]');
    const finalReply = [...container.querySelectorAll('[data-role="assistant"]')]
      .find((element) => element.textContent?.includes(finalAnswer));
    expect(details?.open).toBe(false);
    expect(reviewWorkbench).not.toBeNull();
    expect(finalReply).not.toBeUndefined();
    expect(reviewWorkbench!.compareDocumentPosition(finalReply!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
    expect(container.textContent).toContain('Review tag suggestions');
    expect(activeOrganizePort().posted.some((message) => message.type === 'cancelBgsmOrganizeJobRun'))
      .toBe(false);
  });

  it('surfaces a failed review-page request and retries it only when asked', async () => {
    const container = await mountHarness();
    const activeRequest = postedMessages('requestBgsmActiveOrganizeJob').at(-1);
    if (!activeRequest) throw new Error('Active organize-job request was not sent.');
    const snapshot = reviewSnapshot(activeRequest.controllerId, activeRequest.sessionId, 1);
    const durable = presentationFor(snapshot, {
      status: 'review',
      coverage: completeCoverage(1, 1),
      selectedRepositories: 1,
      selectedActions: 1,
    });
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot });
    const port = activeOrganizePort();
    port.rejectPosts = true;
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: 'owner',
      presentation: durable,
    });
    await act(async () => { await Promise.resolve(); });

    expect(postedMessages('requestBgsmOrganizeReviewPage')).toHaveLength(0);
    expect(container.textContent).toContain('Could not load suggestions.');
    expect(container.querySelector('[data-testid="organize-job-review-loading"]')).toBeNull();

    const retry = buttonWithText(container, 'Retry');
    await click(retry);
    expect(postedMessages('requestBgsmOrganizeReviewPage')).toHaveLength(0);
    expect(container.textContent).toContain('Could not load suggestions.');

    port.rejectPosts = false;
    await click(retry);
    expect(postedMessages('requestBgsmOrganizeReviewPage')).toHaveLength(1);
    expect(container.querySelector('[data-testid="organize-job-review-loading"]')).not.toBeNull();
  });

  it('keeps completed tag results usable when receipt details need a retry', async () => {
    const container = await mountHarness();
    const activeRequest = postedMessages('requestBgsmActiveOrganizeJob').at(-1);
    if (!activeRequest) throw new Error('Active organize-job request was not sent.');
    const snapshot = reviewSnapshot(activeRequest.controllerId, activeRequest.sessionId, 1);
    const apply = {
      applyId: 'organize-apply:v1:receipt-retry',
      total: 1,
      settled: 1,
      changed: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    };
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot });
    const port = activeOrganizePort();
    port.rejectPosts = true;
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: null,
      presentation: presentationFor(snapshot, {
        status: 'completed',
        coverage: completeCoverage(1, 1),
        selectedRepositories: 1,
        selectedActions: 1,
        apply,
      }),
    });
    await act(async () => { await Promise.resolve(); });

    expect(postedMessages('requestBgsmOrganizeReceiptPage')).toHaveLength(0);
    expect(container.textContent).toContain('Could not load result details');
    expect(container.textContent).toContain('Applied the selected suggestion as a manual tag');

    port.rejectPosts = false;
    await click(buttonWithText(container, 'Retry'));
    expect(postedMessages('requestBgsmOrganizeReceiptPage')).toHaveLength(1);
  });

  it('supersedes an in-flight receipt page when its filter changes', async () => {
    const container = await mountHarness();
    const activeRequest = postedMessages('requestBgsmActiveOrganizeJob').at(-1);
    if (!activeRequest) throw new Error('Active organize-job request was not sent.');
    const snapshot = reviewSnapshot(activeRequest.controllerId, activeRequest.sessionId, 150);
    const apply = {
      applyId: 'organize-apply:v1:receipt-filter-race',
      total: 150,
      settled: 150,
      changed: 120,
      unchanged: 30,
      skipped: 0,
      failed: 0,
    };
    await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot });
    const completedPresentation = presentationFor(snapshot, {
      status: 'completed',
      coverage: completeCoverage(150, 150),
      selectedRepositories: 150,
      selectedActions: 150,
      apply,
    });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: null,
      presentation: completedPresentation,
    });
    await act(async () => { await Promise.resolve(); });

    const allRequest = postedMessages('requestBgsmOrganizeReceiptPage').at(-1);
    if (!allRequest) throw new Error('Initial receipt request was not sent.');
    expect(allRequest.filter).toBe('all');
    await click(buttonWithText(container, 'View changed'));

    const requests = postedMessages('requestBgsmOrganizeReceiptPage');
    expect(requests).toHaveLength(2);
    const changedRequest = requests[1]!;
    expect(changedRequest).toEqual(expect.objectContaining({
      rowOffset: 0,
      filter: 'changed_or_failed',
    }));
    await emitMessage({
      type: 'bgsmOrganizeReceiptPage',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      requestId: allRequest.requestId,
      applyId: apply.applyId,
      rowOffset: 0,
      rows: [{
        position: 149,
        proposalRowId: `${snapshot.proposalId}:row:149`,
        repositoryId: 'owner/stale-all-filter-row',
        outcome: 'unchanged',
        reason: 'no_change',
      }],
      nextRowOffset: null,
    });
    expect(container.textContent).not.toContain('owner/stale-all-filter-row');

    await emitMessage({
      type: 'bgsmOrganizeReceiptPage',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      requestId: changedRequest.requestId,
      applyId: apply.applyId,
      rowOffset: 0,
      rows: [{
        position: 0,
        proposalRowId: `${snapshot.proposalId}:row:0`,
        repositoryId: 'owner/changed-filter-row',
        outcome: 'changed',
        reason: null,
      }],
      nextRowOffset: 1,
    });
    expect(postedMessages('requestBgsmOrganizeReceiptPage')).toHaveLength(2);
    expect(container.textContent).toContain('owner/changed-filter-row');

    const firstPort = activeOrganizePort();
    await act(async () => {
      firstPort.disconnect();
      await Promise.resolve();
      await Promise.resolve();
    });
    const replacement = activeOrganizePort();
    expect(replacement).not.toBe(firstPort);
    await emitMessageOn(replacement, {
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      role: null,
      presentation: completedPresentation,
    }, 'authoritative_snapshot', completedPresentation.revision);
    expect(postedMessages('requestBgsmOrganizeReceiptPage')).toEqual([
      expect.objectContaining({ filter: 'changed_or_failed', rowOffset: 0 }),
    ]);
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
    const nextRequest = await requestOrganizePreflight(container);
    expect(nextRequest?.sessionId).not.toBe(disconnect?.sessionId);
    expect(nextRequest?.controllerId).not.toBe(disconnect?.controllerId);
  });

  it('ignores duplicate deliveries and reconciles a sequence gap through a replacement Port', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const firstPort = activeOrganizePort();
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
    expect(organizePorts()).toHaveLength(2);
    expect(container.textContent).toContain('Cubby connection was interrupted. Reconnecting');
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(organizePorts()[1]?.posted).toContainEqual({
      type: 'requestBgsmOrganizeJobSnapshot',
      controllerId: analyzing.controllerId,
      sessionId: analyzing.sessionId,
      runId: analyzing.runId,
      generation: analyzing.generation,
    });

    await emitMessageOn(organizePorts()[1]!, {
      type: 'bgsmOrganizeJobRunConnectionReady',
      controllerId: analyzing.controllerId,
      sessionId: analyzing.sessionId,
    });
    expect(container.textContent).toContain('Cubby connection was interrupted. Reconnecting');
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();

    await emitMessageOn(organizePorts()[1]!, {
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: failed,
    }, 'authoritative_snapshot', 11);
    expect(firstPort.disconnectCalls).toBe(1);
    expect(container.textContent).toContain('Analysis paused before completion');
  });

  it('reconnects an advancing durable job through its active generation', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const firstPort = activeOrganizePort();
    const parent = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing', 303);
    const parentPresentation = presentationFor(parent, {
      jobId: 'organize-job:v1:reconnect-active',
      revision: 20,
      status: 'analyzing',
      coverage: {
        total: 303,
        analyzed: 125,
        actionable: 0,
        unchanged: 0,
        insufficientEvidence: 125,
        missing: 0,
        tombstoned: 0,
        analysisFailed: 0,
      },
    });
    await emitMessageOn(firstPort, { type: 'bgsmOrganizeJobRunSnapshot', snapshot: parent });
    await emitMessageOn(firstPort, {
      type: 'bgsmOrganizeJobState',
      controllerId: parent.controllerId,
      sessionId: parent.sessionId,
      role: 'owner',
      presentation: parentPresentation,
    });

    await emitEnvelopeOn(firstPort, envelope('ui-durable-gap', 3, {
      type: 'bgsmOrganizeJobRunSnapshot', snapshot: parent,
    }));
    const replacement = activeOrganizePort();
    expect(replacement).not.toBe(firstPort);
    expect(replacement.posted).toContainEqual({
      type: 'requestBgsmActiveOrganizeJob',
      controllerId: parent.controllerId,
      sessionId: parent.sessionId,
    });
    expect(replacement.posted).not.toContainEqual(expect.objectContaining({
      type: 'requestBgsmOrganizeJobSnapshot',
    }));

    const child = {
      ...parent,
      runId: parseRunId('run:v1:ui-reconnected-generation'),
      generation: 2,
      usage: {
        ...parent.usage,
        firstAnalyzerRequestAt: 2,
        consumedFrozenPositions: 25,
        analyzerBatches: 1,
        providerAttempts: 1,
      },
    };
    await emitMessageOn(replacement, {
      type: 'bgsmOrganizeJobRunSnapshot', snapshot: child,
    }, 'authoritative_snapshot', 24);
    await emitMessageOn(replacement, {
      type: 'bgsmOrganizeJobState',
      controllerId: child.controllerId,
      sessionId: child.sessionId,
      role: 'owner',
      presentation: {
        ...parentPresentation,
        runId: child.runId,
        generation: child.generation,
        revision: 24,
        coverage: { ...parentPresentation.coverage, analyzed: 150, insufficientEvidence: 150 },
      },
    }, 'authoritative_snapshot', 24);

    expect(currentPhase(container)).toBe('Analyzing');
    expect(container.textContent).not.toContain('extension worker restarted');
  });

  it('reconnects when one Port changes epoch without resetting its sequence', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const firstPort = activeOrganizePort();
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing');
    await emitEnvelopeOn(firstPort, envelope('ui-epoch-a', 0, {
      type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing,
    }));
    await emitEnvelopeOn(firstPort, envelope('ui-epoch-b', 1, {
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: { ...analyzing, state: 'failed', terminalReason: 'provider_error' },
    }));
    expect(organizePorts()).toHaveLength(2);
    expect(container.textContent).toContain('Cubby connection was interrupted. Reconnecting');
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();

    await emitMessageOn(activeOrganizePort(), {
      type: 'bgsmOrganizeJobRunSnapshot',
      snapshot: analyzing,
    }, 'authoritative_snapshot', 1);
    expect(currentPhase(container)).toBe('Analyzing');
  });

  it('ends reconnecting only after an authoritative no-job projection', async () => {
    const container = await mountHarness();
    const request = await requestOrganizePreflight(container);
    const firstPort = activeOrganizePort();
    const analyzing = analysisSnapshot(request.controllerId, request.sessionId, 'analyzing');
    await emitMessageOn(firstPort, { type: 'bgsmOrganizeJobRunSnapshot', snapshot: analyzing });

    await act(async () => {
      firstPort.disconnect();
      await Promise.resolve();
      await Promise.resolve();
    });
    const replacement = activeOrganizePort();
    expect(replacement).not.toBe(firstPort);
    expect(container.textContent).toContain('Cubby connection was interrupted. Reconnecting');

    await emitMessageOn(replacement, {
      type: 'bgsmOrganizeJobRunConnectionReady',
      controllerId: analyzing.controllerId,
      sessionId: analyzing.sessionId,
    });
    expect(container.textContent).toContain('Cubby connection was interrupted. Reconnecting');

    await emitMessageOn(replacement, {
      type: 'bgsmOrganizeJobState',
      controllerId: analyzing.controllerId,
      sessionId: analyzing.sessionId,
      presentation: null,
      role: null,
    }, 'authoritative_snapshot');
    expect(container.textContent).not.toContain('Cubby connection was interrupted. Reconnecting');
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(currentPhase(container)).toBeUndefined();
  });

  it('reviews, applies, and renders receipts only from durable job pages', async () => {
    const container = await mountHarness();
    const preflight = await requestOrganizePreflight(container);
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
      role: 'owner',
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
    expect(buttonWithText(container, 'Discard this analysis')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-stopbar"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
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
      role: 'owner',
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
    expect(activeOrganizePort().posted.at(-1)).toEqual({
      type: 'applyBgsmOrganizeSelection',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      generation: snapshot.generation,
      requestId: expect.any(String),
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
      role: 'owner',
      presentation: { ...revised, revision: 10, status: 'applying', apply: durableApply },
    });
    expect(container.textContent).toContain('Applying selected changes');
    expect(container.textContent).toContain('20 of 99 selected · selection locked');

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
      role: null,
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
    expect(container.textContent).toContain('Tag update results');
    expect(container.textContent).toContain('owner/repo-0');
    expect(container.textContent).toContain('owner/repo-1');
    expect(container.textContent).toContain('Repository data changed');

    const followUpPrompt = 'Which repositories changed?';
    const followUpAnswer = 'I can summarize the completed receipt.';
    await completeObservedAgentTurn(
      container,
      followUpPrompt,
      followUpAnswer,
      undefined,
      snapshot.frozenScope.capturedAt + 10,
    );

    const receiptCard = container.querySelector('[data-testid="organize-job-receipt-card"]');
    const followUpBubble = [...container.querySelectorAll('[data-role="user"]')]
      .find((element) => element.textContent?.includes(followUpPrompt));
    const followUpReply = [...container.querySelectorAll('[data-role="assistant"]')]
      .find((element) => element.textContent?.includes(followUpAnswer));
    expect(receiptCard).not.toBeNull();
    expect(followUpBubble).not.toBeUndefined();
    expect(followUpReply).not.toBeUndefined();
    expect(receiptCard!.compareDocumentPosition(followUpBubble!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
    expect(receiptCard!.compareDocumentPosition(followUpReply!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);

    const sessionToggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-session-toggle"]')!;
    expect(sessionToggle.disabled).toBe(false);
    await click(buttonWithText(container, 'Dismiss'));
    expect(activeOrganizePort().posted.at(-1)).toEqual({
      type: 'dismissBgsmTerminalOrganizeJob',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      jobId: presentation.jobId,
      expectedRevision: 11,
    });
    expect(container.querySelector('[data-testid="organize-job-receipt-card"]')).not.toBeNull();
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: snapshot.controllerId,
      sessionId: snapshot.sessionId,
      presentation: null,
      role: null,
    });
    expect(container.querySelector('[data-testid="organize-job-receipt-card"]')).toBeNull();
    expect(sessionToggle.disabled).toBe(false);
  });

  it('posts canonical Take control identity and preserves the draft on typed conflict', async () => {
    const container = await mountHarness();
    const page = postedMessages('requestBgsmActiveOrganizeJob').at(-1)!;
    const snapshot = reviewSnapshot(page.controllerId, page.sessionId, 2);
    const presentation = presentationFor(snapshot, {
      jobId: 'organize-job:v1:take-control-ui',
      revision: 17,
      status: 'review',
      coverage: completeCoverage(2, 2),
      selectedRepositories: 2,
      selectedActions: 2,
    });
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: page.controllerId,
      sessionId: page.sessionId,
      presentation,
      role: 'owner_lost',
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await setTextareaValue(textarea, 'Keep this takeover draft');
    await click(buttonWithText(container, 'Take control'));

    const request = postedMessages('takeControlBgsmOrganizeJob').at(-1)!;
    expect(request).toEqual({
      type: 'takeControlBgsmOrganizeJob',
      controllerId: page.controllerId,
      sessionId: page.sessionId,
      runId: presentation.runId,
      generation: presentation.generation,
      requestId: expect.any(String),
      jobId: presentation.jobId,
      expectedRevision: presentation.revision,
    });
    expect(buttonWithText(container, 'Taking control…').disabled).toBe(true);

    await emitMessage({
      type: 'bgsmOrganizeJobRunError',
      controllerId: page.controllerId,
      sessionId: page.sessionId,
      runId: presentation.runId,
      generation: presentation.generation,
      requestId: request.requestId,
      reason: 'revision_conflict',
      message: 'Internal revision detail.',
    });
    expect(container.querySelector('[data-testid="organize-job-take-control-error"]')?.textContent)
      .toContain('changed while taking control');
    expect(container.textContent).not.toContain('Internal revision detail.');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep this takeover draft');
    expect(buttonWithText(container, 'Take control').disabled).toBe(false);

    await click(buttonWithText(container, 'Take control'));
    await emitMessage({
      type: 'bgsmOrganizeJobState',
      controllerId: page.controllerId,
      sessionId: page.sessionId,
      presentation: { ...presentation, revision: presentation.revision + 1 },
      role: 'owner',
    });
    expect(container.querySelector('[data-testid="organize-job-control-notice"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep this takeover draft');
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

async function requestOrganizePreflight(container: HTMLElement) {
  const prompt = 'Organize my entire starred library with useful tags.';
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('Agent composer not found.');
  await setTextareaValue(textarea, prompt);
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
  if (!send || send.disabled) {
    throw new Error(`Agent composer did not accept the handoff prompt: value=${textarea.value}; disabled=${String(send?.disabled)}`);
  }
  await click(send);

  const agentPort = [...ports].reverse().find((candidate) => candidate.name === 'bgsm-agent');
  const turn = agentPort?.posted.find((message) => message.type === 'startBgsmAgentTurn');
  if (!agentPort || !turn) throw new Error('Agent handoff turn did not start.');
  const sequence = ++handoffTurnSequence;
  await act(async () => {
    agentPort.emit({
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: {
        turnAttemptId: turn.turnAttemptId,
        sessionId: turn.sessionId,
        baseRevision: turn.baseRevision,
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: workbenchCommitForMessages(turn, [
          {
            id: `workbench-handoff-user-${sequence}`,
            role: 'user',
            content: prompt,
            createdAt: sequence * 2 - 1,
          },
          {
            id: `workbench-handoff-agent-${sequence}`,
            role: 'agent',
            content: 'Opening scope confirmation.',
            createdAt: sequence * 2,
          },
        ], { organizeLibraryAction: 'request_confirmation' }),
        organizeLibraryHandoff: {
          type: 'organize_whole_library',
          action: 'request_confirmation',
          instruction: prompt,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  const request = postedMessages('requestBgsmOrganizeJobPreflight').at(-1);
  if (!request) throw new Error('Agent handoff did not request Organize preflight.');
  return request;
}

function workbenchCommitForMessages(
  input: Readonly<{
    turnAttemptId: string;
    sessionId: string;
    baseRevision: number;
    prompt?: string;
  }>,
  messages: readonly {
    id: string;
    role: 'user' | 'agent' | 'tool';
    content: string;
    createdAt: number;
    toolCallId?: string;
    toolName?: string;
    toolCalls?: { id: string; name: string; arguments: unknown }[];
  }[],
  options: Readonly<{
    organizeLibraryAction?: 'request_confirmation' | 'start_analysis';
  }> = {},
): AgentSessionCommitResult {
  const transcript = messages.map((message, index) => ({
    sequence: index + 1,
    ...message,
    ...(message.toolCalls ? { toolCalls: [...message.toolCalls] } : {}),
  }));
  const presentationMessages: readonly AgentSessionPresentationMessage[] = transcript
    .filter((message): message is typeof message & { role: 'user' | 'agent' } => (
      message.role === 'user' || message.role === 'agent'
    ))
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({
      sequence: message.sequence,
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }));
  const appliedRevision = input.baseRevision + 1;
  return {
    session: {
      id: input.sessionId,
      revision: appliedRevision,
    },
    summary: {
      id: input.sessionId,
      title: input.prompt ?? presentationMessages[0]?.content ?? '',
      createdAt: 1,
      updatedAt: 2,
    },
    turnAttemptId: input.turnAttemptId,
    idempotent: false,
    appliedRevision,
    digest: `asd:v1:${'a'.repeat(43)}`,
    launchDigest: `asl:v1:${'b'.repeat(43)}`,
    outcome: {
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      writeSettlement: 'none',
      ...(options.organizeLibraryAction
        ? {
            organizeLibraryAction: options.organizeLibraryAction,
            handoffAnchor: {
              messageId: presentationMessages.at(-1)?.id ?? null,
              createdAt: presentationMessages.at(-1)?.createdAt ?? 2,
            },
          }
        : {}),
    },
    transcript: {
      sessionId: input.sessionId,
      messages: transcript,
      nextBeforeSequence: null,
    },
    presentationMessages,
  };
}

async function completeAgentOrganizeAction(
  prompt: string,
  action: 'request_confirmation' | 'start_analysis',
) {
  const agentPort = [...ports].reverse().find((candidate) => candidate.name === 'bgsm-agent');
  const turn = agentPort?.posted.find((message) => message.type === 'startBgsmAgentTurn');
  if (!agentPort || !turn) throw new Error('Agent organize command turn did not start.');
  const sequence = ++handoffTurnSequence;
  await act(async () => {
    agentPort.emit({
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: {
        turnAttemptId: turn.turnAttemptId,
        sessionId: turn.sessionId,
        baseRevision: turn.baseRevision,
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: workbenchCommitForMessages(turn, [
          {
            id: `workbench-command-user-${sequence}`,
            role: 'user',
            content: prompt,
            createdAt: sequence * 2 + 100,
          },
          {
            id: `workbench-command-agent-${sequence}`,
            role: 'agent',
            content: action === 'start_analysis'
              ? 'Starting full-library analysis.'
              : 'Opening scope confirmation.',
            createdAt: sequence * 2 + 101,
          },
        ], { organizeLibraryAction: action }),
        organizeLibraryHandoff: {
          type: 'organize_whole_library',
          action,
          instruction: prompt,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function completeObservedAgentTurn(
  container: HTMLElement,
  prompt: string,
  answer: string,
  tool?: Readonly<{ toolName: string; toolResult: string }>,
  createdAtBase?: number,
) {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('Agent composer not found.');
  await setTextareaValue(textarea, prompt);
  await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!);
  const agentPort = [...ports].reverse().find((candidate) => candidate.name === 'bgsm-agent');
  const turn = agentPort?.posted.find((message) => message.type === 'startBgsmAgentTurn');
  if (!agentPort || !turn) throw new Error('Agent turn did not start.');
  const messageCreatedAtBase = createdAtBase
    ?? Math.max(Date.now(), lastAgentMessageCreatedAt + 1);
  const toolCallId = `${turn.turnAttemptId}:tool-call`;
  const newMessages = [
    {
      id: `${turn.turnAttemptId}:user`,
      role: 'user' as const,
      content: prompt,
      createdAt: messageCreatedAtBase,
    },
    ...(tool ? [
      {
        id: `${turn.turnAttemptId}:assistant-tool`,
        role: 'agent' as const,
        content: '',
        createdAt: messageCreatedAtBase + 1,
        toolCalls: [{ id: toolCallId, name: tool.toolName, arguments: {} }],
      },
      {
        id: `${turn.turnAttemptId}:tool-result`,
        role: 'tool' as const,
        content: tool.toolResult,
        createdAt: messageCreatedAtBase + 2,
        toolCallId,
        toolName: tool.toolName,
      },
    ] : []),
    {
      id: `${turn.turnAttemptId}:assistant-final`,
      role: 'agent' as const,
      content: answer,
      createdAt: messageCreatedAtBase + (tool ? 3 : 1),
    },
  ];
  lastAgentMessageCreatedAt = newMessages.at(-1)!.createdAt;
  await act(async () => {
    agentPort.emit({
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: {
        turnAttemptId: turn.turnAttemptId,
        sessionId: turn.sessionId,
        baseRevision: turn.baseRevision,
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: workbenchCommitForMessages(turn, newMessages),
      },
    });
    await Promise.resolve();
    await Promise.resolve();
  });
  return turn as { turnAttemptId: string; sessionId: string; baseRevision: number };
}

function Harness() {
  const [open, setOpen] = useState(true);
  const agent = useBgsmAgent(undefined, {
    kind: 'current_view',
    filter: {
      query: '',
      languages: [],
      tags: [],
      tagMode: 'any',
      showTombstone: false,
      onlyFavorite: false,
      onlyUntagged: false,
      onlyArchived: false,
      sortKey: 'starred_at',
      sortDir: 'desc',
    },
  });
  const workbench = useBgsmAgentWorkbench(undefined, agent.sessionId, agent.sessionReady);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Show Cubby</button>
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
  rejectPosts = false;
  private messageListeners = new Set<(message: unknown) => void>();
  private disconnectListeners = new Set<() => void>();
  private deliverySequence = 0;
  private readonly connectionEpochId = `organize-connection:v1:fake-${++fakePortEpoch}`;

  constructor(
    readonly name: string,
    private readonly agentExecutionEpochId = 'worker-epoch-ui',
  ) {}

  disconnect() {
    this.disconnectCalls += 1;
    this.disconnectListeners.forEach((listener) => listener());
  }

  emit(
    message: unknown,
    deliveryKind?: BgsmOrganizeJobDeliveryEnvelope['deliveryKind'],
    durableRevision?: number | null,
  ) {
    if (this.name !== 'bgsm-agent-organize-job') {
      this.messageListeners.forEach((listener) => listener(message));
      return;
    }
    const serverMessage = message as BgsmOrganizeJobServerMessage;
    const isState = serverMessage.type === 'bgsmOrganizeJobState';
    this.emitEnvelope({
      type: 'bgsmOrganizeJobRunDelivery',
      connectionEpochId: this.connectionEpochId,
      deliverySequence: this.deliverySequence,
      deliveryKind: deliveryKind ?? (isState ? 'authoritative_snapshot' : 'live'),
      durableRevision: durableRevision ?? (
        isState && serverMessage.presentation ? serverMessage.presentation.revision : null
      ),
      message: serverMessage,
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
            listener({
              type: 'bgsmAgentTurnHello',
              executionEpochId: this.agentExecutionEpochId,
            });
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
      postMessage: (message: BgsmOrganizeJobClientMessage) => {
        if (this.rejectPosts) throw new Error('Fake Port is disconnected.');
        this.posted.push(message);
      },
      disconnect: () => this.disconnect(),
    } as chrome.runtime.Port;
  }
}

function agentPorts(): FakePort[] {
  return ports.filter((candidate) => candidate.name === 'bgsm-agent');
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

async function enterBlockedAnalysis(container: HTMLElement, suffix: string) {
  const request = await requestOrganizePreflight(container);
  const continuationCursor = parseContinuationCursorToken(`cursor:v1:${suffix}`);
  const base = analysisSnapshot(request.controllerId, request.sessionId, 'analysis_blocked');
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
    ...base,
    terminalReason: 'analysis_failed',
    continuationCursor,
    coverage,
  };
  await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot: blocked });
  await emitMessage({
    type: 'bgsmOrganizeJobState',
    controllerId: blocked.controllerId,
    sessionId: blocked.sessionId,
    role: 'owner',
    presentation: presentationFor(blocked, {
      jobId: `organize-job:v1:${suffix}`,
      status: 'analysis_blocked',
      coverage,
      selectedRepositories: 0,
      selectedActions: 0,
    }),
  });
  return blocked;
}

async function enterDurableReview(container: HTMLElement, suffix: string) {
  const request = await requestOrganizePreflight(container);
  const snapshot = reviewSnapshot(request.controllerId, request.sessionId, 2);
  const presentation = presentationFor(snapshot, {
    jobId: `organize-job:v1:${suffix}`,
    revision: 7,
    status: 'review',
    coverage: completeCoverage(2, 2),
    selectedRepositories: 2,
    selectedActions: 2,
  });
  await emitMessage({ type: 'bgsmOrganizeJobRunSnapshot', snapshot });
  await emitMessage({
    type: 'bgsmOrganizeJobState',
    controllerId: snapshot.controllerId,
    sessionId: snapshot.sessionId,
    role: 'owner',
    presentation,
  });
  await act(async () => { await Promise.resolve(); });
  const pageRequest = postedMessages('requestBgsmOrganizeReviewPage').at(-1);
  if (!pageRequest) throw new Error('Review page was not requested.');
  await emitMessage({
    type: 'bgsmOrganizeReviewPage',
    controllerId: snapshot.controllerId,
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    generation: snapshot.generation,
    requestId: pageRequest.requestId,
    jobId: presentation.jobId,
    revision: presentation.revision,
    proposalId: snapshot.proposalId!,
    totalRows: 2,
    selectedRepositories: 2,
    selectedActions: 2,
    rowOffset: 0,
    rows: [0, 1].map((position) => ({
      position,
      proposalRowId: `${snapshot.proposalId}:row:${position}`,
      repositoryId: `owner/repo-${position}`,
      proposedActions: [{
        kind: 'add_existing_tag' as const,
        tag: position === 0 ? 'TypeScript' : 'CLI',
        evidence: 'Repository metadata',
      }],
      selected: true,
    })),
    nextRowOffset: null,
  });
  return { snapshot, presentation };
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
    originAgentSessionId: snapshot.sessionId,
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

function postedMessages<T extends BgsmOrganizeJobClientMessage['type']>(
  type: T,
): Extract<BgsmOrganizeJobClientMessage, { type: T }>[] {
  return activeOrganizePort().posted.filter((candidate) => candidate.type === type) as Extract<
    BgsmOrganizeJobClientMessage,
    { type: T }
  >[];
}

function organizePorts(): FakePort[] {
  return ports.filter((candidate) => candidate.name === 'bgsm-agent-organize-job');
}

function activeOrganizePort(): FakePort {
  const active = organizePorts().at(-1);
  if (!active) throw new Error('Organize workbench Port not found.');
  return active;
}

async function emitMessage(message: BgsmOrganizeJobServerMessage) {
  await emitMessageOn(activeOrganizePort(), message);
}

async function emitMessageOn(
  target: FakePort,
  message: BgsmOrganizeJobServerMessage,
  deliveryKind?: BgsmOrganizeJobDeliveryEnvelope['deliveryKind'],
  durableRevision?: number | null,
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
