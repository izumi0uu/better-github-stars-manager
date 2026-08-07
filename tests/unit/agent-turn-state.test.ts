/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  createAgentTurnState,
  reduceAgentTurn,
  type AgentTurnAction,
} from '@/ui/agent-turn-state';
import { useBgsmAgent } from '@/ui/hooks/use-bgsm-agent';
import type { AgentStopReason } from '@/agent-harness';
import type { BgsmAgentTurnResult } from '@/bgsm-agent/turn-protocol';
import type { BgsmAgentTurnHandlers } from '@/utils/messaging';
import { cleanupMountedRootsAndBody, mountReact, type MountedRoot } from './test-utils';

const messagingMocks = vi.hoisted(() => ({
  startBgsmAgentTurn: vi.fn(),
}));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/messaging')>();
  return {
    ...actual,
    startBgsmAgentTurn: messagingMocks.startBgsmAgentTurn,
  };
});

const mountedRoots: MountedRoot[] = [];

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('Agent turn reducer', () => {
  it('atomically clears terminal and recovery state when a new turn starts', () => {
    const failed = reduceAgentTurn(createAgentTurnState(), {
      type: 'turn_failed',
      result: null,
      message: 'Provider failed.',
      category: 'provider',
      status: { kind: 'error', text: 'Provider failed.' },
      prompt: 'Retry me',
      canRetry: false,
    });
    const recovering = reduceAgentTurn(failed, {
      type: 'context_recovery_required',
      result: result('context_limit'),
      recovery: {
        prompt: 'Shorten me',
        reason: 'current_turn_too_large',
      },
      prompt: 'Shorten me',
      canRetry: true,
    });

    const started = reduceAgentTurn(recovering, {
      type: 'turn_started',
      status: { kind: 'queued', text: 'Queued' },
    });

    expect(started).toEqual({
      phase: 'queued',
      running: true,
      status: { kind: 'queued', text: 'Queued' },
      error: null,
      errorCategory: null,
      lastTurnResult: null,
      contextLimitRecovery: null,
      draftRecovery: null,
      canRetryLastTurn: true,
      toolActivities: [],
      preCompactionStatus: null,
    });
  });

  it.each([
    'approval_required',
    'interaction_required',
    'protocol_error',
    'step_budget_reached',
    'provider_error',
    'attempt_state_lost',
    'context_limit',
  ] satisfies AgentStopReason[])('turns a result-only %s into a visible retryable failure', (reason) => {
    const running = reduceAgentTurn(createAgentTurnState(), {
      type: 'turn_started',
      status: { kind: 'queued', text: 'Queued' },
    });

    const settled = reduceAgentTurn(running, finishAction(reason));

    expect(settled.running).toBe(false);
    expect(settled.phase).toBe('failed');
    expect(settled.status).toEqual({ kind: 'error', text: 'Turn failed.' });
    expect(settled.error).toBe('Turn failed.');
    expect(settled.errorCategory).toBe(reason === 'provider_error' || reason === 'context_limit'
      ? 'provider'
      : 'other');
    expect(settled.lastTurnResult?.reason).toBe(reason);
    expect(settled.draftRecovery).toBe('Original prompt');
    expect(settled.canRetryLastTurn).toBe(true);
  });

  it('settles final answers and aborts without leaving an active state behind', () => {
    const running = reduceAgentTurn(createAgentTurnState(), {
      type: 'turn_started',
      status: { kind: 'queued', text: 'Queued' },
    });
    const done = reduceAgentTurn(running, finishAction('final_answer'));
    const stopped = reduceAgentTurn(running, finishAction('aborted'));

    expect(done).toMatchObject({
      running: false,
      status: { kind: 'done', text: 'Done' },
      error: null,
      draftRecovery: null,
    });
    expect(stopped).toMatchObject({
      running: false,
      status: { kind: 'stopped', text: 'Stopped' },
      error: null,
      draftRecovery: 'Original prompt',
    });
  });

  it('does not overwrite an observed error with a later final-answer status', () => {
    let state = reduceAgentTurn(createAgentTurnState(), {
      type: 'turn_started',
      status: { kind: 'queued', text: 'Queued' },
    });
    state = reduceAgentTurn(state, {
      type: 'error_observed',
      message: 'Stream failed.',
      category: 'provider',
      status: { kind: 'error', text: 'Stream failed.' },
    });

    state = reduceAgentTurn(state, finishAction('final_answer'));

    expect(state).toMatchObject({
      running: false,
      status: { kind: 'error', text: 'Stream failed.' },
      error: 'Stream failed.',
      errorCategory: 'provider',
    });
  });

  it('does not let late progress overwrite an observed terminal error', () => {
    let state = reduceAgentTurn(createAgentTurnState(), {
      type: 'turn_started',
      status: { kind: 'queued', text: 'Queued' },
    });
    state = reduceAgentTurn(state, {
      type: 'error_observed',
      message: 'Stream failed.',
      category: 'provider',
      status: { kind: 'error', text: 'Stream failed.' },
    });

    const late = reduceAgentTurn(state, {
      type: 'status_changed',
      status: { kind: 'working', text: 'Still working' },
    });

    expect(late).toBe(state);
  });

  it('preserves and restores the previous status around visible compaction', () => {
    let state = reduceAgentTurn(createAgentTurnState(), {
      type: 'turn_started',
      status: { kind: 'queued', text: 'Queued' },
    });
    state = reduceAgentTurn(state, {
      type: 'status_changed',
      status: { kind: 'tool', text: 'Reading' },
    });
    state = reduceAgentTurn(state, { type: 'compaction_started' });
    state = reduceAgentTurn(state, {
      type: 'compaction_shown',
      status: { kind: 'compacting', text: 'Compacting' },
    });

    expect(state.preCompactionStatus).toEqual({ kind: 'tool', text: 'Reading' });
    expect(state.status?.kind).toBe('compacting');

    state = reduceAgentTurn(state, {
      type: 'compaction_finished',
      restore: true,
      fallbackStatus: { kind: 'working', text: 'Thinking' },
    });
    expect(state.status).toEqual({ kind: 'tool', text: 'Reading' });
    expect(state.preCompactionStatus).toBeNull();
  });

  it('updates tool calls by identity and fails only unfinished activity at a terminal', () => {
    let state = reduceAgentTurn(createAgentTurnState(), {
      type: 'turn_started',
      status: { kind: 'queued', text: 'Queued' },
    });
    state = reduceAgentTurn(state, toolAction('read-1', 'queued'));
    state = reduceAgentTurn(state, toolAction('read-1', 'running'));
    state = reduceAgentTurn(state, toolAction('read-2', 'completed'));
    state = reduceAgentTurn(state, finishAction('provider_error'));

    expect(state.toolActivities).toEqual([
      { callId: 'read-1', toolName: 'list_stars', state: 'failed' },
      { callId: 'read-2', toolName: 'list_stars', state: 'completed' },
    ]);
  });
});

describe('useBgsmAgent stop ownership', () => {
  it('keeps a final-answer event settling until its authoritative result arrives', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((_input: unknown, nextHandlers: BgsmAgentTurnHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      });
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await act(async () => {
      void agent!.startTurn('Inspect this repository');
      await Promise.resolve();
    });
    const input = messagingMocks.startBgsmAgentTurn.mock.calls[0]?.[0];
    if (!input || !handlers) throw new Error('Agent turn did not start.');

    await act(async () => {
      handlers!.onEvent?.({
        type: 'agent_done',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        reason: 'final_answer',
      });
      await Promise.resolve();
    });
    expect(agent!.running).toBe(true);
    expect(agent!.phase).not.toBe('done');

    await act(async () => {
      handlers!.onResult?.({
        ...result('final_answer'),
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
      });
      await Promise.resolve();
    });
    expect(agent!.running).toBe(false);
    expect(agent!.phase).toBe('done');
  });

  it('sends one transport stop when Stop is requested repeatedly', async () => {
    const stop = vi.fn();
    messagingMocks.startBgsmAgentTurn.mockReturnValue({ stop, acknowledge: vi.fn() });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      });
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await act(async () => {
      void agent!.startTurn('Inspect all stars');
      await Promise.resolve();
    });
    expect(messagingMocks.startBgsmAgentTurn).toHaveBeenCalledTimes(1);
    expect(agent!.running).toBe(true);
    await act(async () => {
      agent!.stopTurn();
      agent!.stopTurn();
      await Promise.resolve();
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(agent!.durableRetryDraft).toMatchObject({
      prompt: 'Inspect all stars',
      kind: 'stopped',
      settlement: 'stop_pending',
    });
  });

  it('ignores late progress and buffered stream flushes after Stop is requested', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    const stop = vi.fn();
    let flushStream: FrameRequestCallback | undefined;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      flushStream = callback;
      return 1;
    });
    messagingMocks.startBgsmAgentTurn.mockImplementation((_input: unknown, nextHandlers: BgsmAgentTurnHandlers) => {
      handlers = nextHandlers;
      return { stop, acknowledge: vi.fn() };
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      });
      return null;
    }

    try {
      mountReact(createElement(Harness), mountedRoots);
      await act(async () => {
        void agent!.startTurn('Inspect all stars');
        await Promise.resolve();
      });
      const input = messagingMocks.startBgsmAgentTurn.mock.calls[0]?.[0];
      if (!input || !handlers) throw new Error('Agent turn did not start.');

      await act(async () => {
        handlers!.onEvent?.({
          type: 'assistant_text_delta',
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          step: 0,
          delta: 'Late buffered text',
        });
        agent!.stopTurn();
        handlers!.onEvent?.({
          type: 'agent_start',
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
        });
        flushStream?.(0);
        await Promise.resolve();
      });

      expect(stop).toHaveBeenCalledOnce();
      expect(agent!.phase).toBe('stopping');
      expect(agent!.status?.kind).toBe('stopped');
      expect(agent!.messages).toEqual([]);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });

  it('keeps a requested Stop terminal when the transport reports a late error', async () => {
    let handlers: BgsmAgentTurnHandlers | undefined;
    messagingMocks.startBgsmAgentTurn.mockImplementation((_input: unknown, nextHandlers: BgsmAgentTurnHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), acknowledge: vi.fn() };
    });
    let agent: ReturnType<typeof useBgsmAgent> | null = null;

    function Harness() {
      agent = useBgsmAgent(undefined, {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repo',
      });
      return null;
    }

    mountReact(createElement(Harness), mountedRoots);
    await act(async () => {
      void agent!.startTurn('Inspect all stars');
      await Promise.resolve();
    });
    const input = messagingMocks.startBgsmAgentTurn.mock.calls[0]?.[0];
    if (!input || !handlers) throw new Error('Agent turn did not start.');

    await act(async () => {
      agent!.stopTurn();
      handlers!.onError?.({
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        message: 'The transport disconnected while stopping.',
        category: 'other',
      });
      await Promise.resolve();
    });

    expect(agent!.running).toBe(false);
    expect(agent!.phase).toBe('stopped');
    expect(agent!.status?.kind).toBe('stopped');
    expect(agent!.error).toBeNull();
    expect(agent!.messages).toEqual([]);
  });
});

function finishAction(reason: AgentStopReason): AgentTurnAction {
  return {
    type: 'turn_finished',
    result: result(reason),
    prompt: 'Original prompt',
    canRetry: true,
    doneStatus: { kind: 'done', text: 'Done' },
    stoppedStatus: { kind: 'stopped', text: 'Stopped' },
    failureStatus: { kind: 'error', text: 'Turn failed.' },
    failureMessage: 'Turn failed.',
    failureCategory: reason === 'provider_error' || reason === 'context_limit'
      ? 'provider'
      : 'other',
  };
}

function toolAction(
  callId: string,
  state: 'queued' | 'running' | 'completed' | 'failed',
): AgentTurnAction {
  return {
    type: 'tool_activity_updated',
    activity: { callId, toolName: 'list_stars', state },
  };
}

function result(reason: AgentStopReason): BgsmAgentTurnResult {
  return {
    turnAttemptId: 'attempt-1',
    sessionId: 'session-1',
    baseRevision: 0,
    reason,
    changed: false,
    changedCount: 0,
    commit: null,
  };
}
