import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBgsmAgentClientController,
  type BgsmAgentClientController,
  type BgsmAgentClientLabels,
  type BgsmAgentClientSnapshot,
} from '@/ui/agent-client-controller';
import type * as MessagingModule from '@/utils/messaging';
import type { BgsmAgentTurnHandlers } from '@/utils/messaging';
import type { AgentRetryDraft } from '@/storage/agent-session-store';
import type { AgentSessionCommitResult, LoadedAgentSession } from '@/storage/agent-session-store';

const messaging = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  create: vi.fn(),
  inspect: vi.fn(),
  inspectActive: vi.fn(),
  load: vi.fn(),
  retryDraft: vi.fn(),
  start: vi.fn(),
}));

vi.mock('@/utils/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof MessagingModule>();
  return {
    ...actual,
    createDurableBgsmAgentSession: messaging.create,
    getOrCreateInitialDurableBgsmAgentSession: messaging.getOrCreate,
    inspectBgsmAgentSessionCatalog: messaging.inspect,
    inspectActiveBgsmAgentSessionTurn: messaging.inspectActive,
    loadDurableBgsmAgentSession: messaging.load,
    readDurableAgentRetryDraftCandidate: messaging.retryDraft,
    startBgsmAgentTurn: messaging.start,
  };
});

beforeEach(() => {
  messaging.create.mockReset();
  messaging.getOrCreate.mockReset();
  messaging.inspect.mockReset();
  messaging.inspectActive.mockReset();
  messaging.load.mockReset();
  messaging.retryDraft.mockReset();
  messaging.start.mockReset();
  messaging.inspect.mockResolvedValue({ summaries: [], corruptions: [] });
  messaging.inspectActive.mockResolvedValue(null);
  messaging.retryDraft.mockResolvedValue(null);
  messaging.getOrCreate.mockResolvedValue(loadedEmptySession('durable-session'));
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn() },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BgsmAgentClientController', () => {
  it('keeps its cached snapshot stable and publishes one immutable atomic hydration view', async () => {
    const controller = createBgsmAgentClientController({ labels: labels() });
    const initial = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(initial);
    const seen: BgsmAgentClientSnapshot[] = [];
    const unsubscribe = controller.subscribe(() => seen.push(controller.getSnapshot()));

    const deactivate = controller.activate();
    await waitForReady(controller);

    const hydrated = controller.getSnapshot();
    expect(hydrated).not.toBe(initial);
    expect(hydrated.sessionReady).toBe(true);
    expect(hydrated.activeSessionId).toBe('durable-session');
    expect(hydrated.sessions.map((session) => session.id)).toContain('durable-session');
    expect(hydrated.messages).toEqual([]);
    expect(Object.isFrozen(hydrated)).toBe(true);
    expect(Object.isFrozen(hydrated.sessions)).toBe(true);
    expect(Object.isFrozen(hydrated.messages)).toBe(true);
    expect(seen.filter((snapshot) => snapshot.sessionReady)).toEqual([hydrated]);

    unsubscribe();
    deactivate();
  });

  it('does not touch Chrome/session messaging while constructed but inactive', () => {
    const controller = createBgsmAgentClientController({ labels: labels() });

    expect(controller.getSnapshot().sessionReady).toBe(false);
    expect(messaging.inspect).not.toHaveBeenCalled();
    expect(messaging.create).not.toHaveBeenCalled();
    expect(messaging.start).not.toHaveBeenCalled();
  });

  it('joins Strict Mode reactivation to one hydration generation', async () => {
    const deferred = createDeferred<{ summaries: never[]; corruptions: never[] }>();
    messaging.inspect.mockReturnValue(deferred.promise);
    const controller = createBgsmAgentClientController({ labels: labels() });

    const firstDeactivate = controller.activate();
    firstDeactivate();
    const secondDeactivate = controller.activate();
    expect(messaging.inspect).toHaveBeenCalledTimes(1);

    deferred.resolve({ summaries: [], corruptions: [] });
    await waitForReady(controller);
    expect(controller.getSnapshot()).toMatchObject({
      sessionReady: true,
      activeSessionId: 'durable-session',
    });
    expect(messaging.inspect).toHaveBeenCalledTimes(1);
    secondDeactivate();
  });

  it('keeps page instances and their selection snapshots isolated', async () => {
    const first = createBgsmAgentClientController({ labels: labels() });
    const second = createBgsmAgentClientController({ labels: labels() });
    expect(first.getSnapshot().activeSessionId).not.toBe(second.getSnapshot().activeSessionId);
    const deactivate = first.activate();


    await waitForReady(first);
    expect(second.getSnapshot().sessionReady).toBe(false);
    deactivate();
  });

  it('detaches an in-flight Port on deactivation without requesting stop', async () => {
    const stop = vi.fn();
    const detach = vi.fn();
    messaging.start.mockReturnValue({ stop, detach, acknowledge: vi.fn() });
    const controller = createBgsmAgentClientController({ labels: labels() });
    const deactivate = controller.activate();
    await waitForReady(controller);
    const result = controller.startTurn('Keep running after this page closes');
    await Promise.resolve();
    await vi.waitFor(() => expect(messaging.start).toHaveBeenCalledTimes(1));

    deactivate();

    expect(stop).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toBeNull();
  });
  it.each([
    'agent_session_turn_active',
    'agent_session_attempt_conflict',
  ] as const)('reconciles %s, subscribes to the winner, and preserves the rejected prompt', async (code) => {
    const session = loadedEmptySession(`durable-conflict-${code}`);
    const winner = {
      executionEpochId: `worker-winner-${code}`,
      launch: {
        turnAttemptId: `winner-${code}`,
        sessionId: session.session.id,
        baseRevision: 0,
        prompt: 'Winning prompt',
      },
    } as const;
    const starts: Array<{
      input: Parameters<NonNullable<BgsmAgentTurnHandlers['onError']>>[0];
      handlers: BgsmAgentTurnHandlers;
      options: unknown;
    }> = [];
    messaging.getOrCreate.mockResolvedValue(session);
    messaging.load.mockResolvedValue(session);
    messaging.inspectActive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    messaging.start.mockImplementation((input, handlers, options) => {
      starts.push({ input, handlers, options });
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    const controller = createBgsmAgentClientController({ labels: labels() });
    const deactivate = controller.activate();
    await waitForReady(controller);
    const rejectedPrompt = '  Keep this exact rejected prompt.\n';

    const rejectedResult = controller.startTurn(rejectedPrompt);
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    const rejected = starts[0]!;
    await rejected.handlers.onError?.({
      ...rejected.input,
      message: 'Another Cubby turn is already active for this conversation.',
      category: 'other',
      code,
    });
    await expect(rejectedResult).resolves.toBeNull();

    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(messaging.load).toHaveBeenCalledWith(session.session.id);
    expect(messaging.inspectActive).toHaveBeenLastCalledWith(session.session.id);
    expect(starts[1]).toMatchObject({
      input: winner.launch,
      options: {
        expectedExecutionEpochId: winner.executionEpochId,
        resumeOnly: true,
      },
    });
    expect(controller.getSnapshot().turnState).toMatchObject({
      running: true,
      error: 'Another Cubby turn is already active for this conversation.',
      draftRecovery: rejectedPrompt,
      canRetryLastTurn: true,
    });
    expect(controller.getCanRetryLastTurn()).toBe(false);
    expect(controller.getSnapshot().turnState.transientSafeResendPrompt).toBe(rejectedPrompt);
    expect(controller.getTransientSafeResendPrompt()).toBe(rejectedPrompt);

    await starts[1]!.handlers.onResult?.({
      ...winner.launch,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      commit: committedWinner(session.session.id, winner.launch.turnAttemptId),
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual([
        'Winning prompt',
        'Winning answer',
      ]);
    });
    expect(controller.getSnapshot().turnState).toMatchObject({
      running: false,
      error: 'Another Cubby turn is already active for this conversation.',
      canRetryLastTurn: true,
    });
    expect(controller.getCanRetryLastTurn()).toBe(false);
    expect(controller.getTransientSafeResendPrompt()).toBe(rejectedPrompt);
    expect(messaging.getOrCreate).toHaveBeenCalledTimes(1);
    expect(messaging.create).not.toHaveBeenCalled();
    expect(messaging.start).toHaveBeenCalledTimes(2);
    deactivate();
  });


  it('reloads canonical state and subscribes to a newer active turn after the first winner commits', async () => {
    const initial = loadedEmptySession('durable-conflict-newer-active');
    const afterFirstWinner = loadedConversation(initial.session.id, 1, [
      ['First winning prompt', 'First winning answer'],
    ]);
    const afterNewerWinner = loadedConversation(initial.session.id, 2, [
      ['First winning prompt', 'First winning answer'],
      ['Newer active prompt', 'Newer active answer'],
    ]);
    const newerActive = {
      executionEpochId: 'worker-newer-active',
      launch: {
        turnAttemptId: 'winner-newer-active',
        sessionId: initial.session.id,
        baseRevision: 1,
        prompt: 'Newer active prompt',
      },
    } as const;
    const starts: Array<{
      input: Parameters<NonNullable<BgsmAgentTurnHandlers['onError']>>[0];
      handlers: BgsmAgentTurnHandlers;
      options: unknown;
    }> = [];
    messaging.getOrCreate.mockResolvedValue(initial);
    messaging.load
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(afterFirstWinner);
    messaging.inspectActive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(newerActive);
    messaging.start.mockImplementation((input, handlers, options) => {
      starts.push({ input, handlers, options });
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    const controller = createBgsmAgentClientController({ labels: labels() });
    const deactivate = controller.activate();
    await waitForReady(controller);

    const rejectedResult = controller.startTurn('Rejected while the first winner commits');
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    await starts[0]!.handlers.onError?.({
      ...starts[0]!.input,
      message: 'Another Cubby turn is already active for this conversation.',
      category: 'other',
      code: 'agent_session_turn_active',
    });
    await expect(rejectedResult).resolves.toBeNull();

    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(messaging.load).toHaveBeenCalledTimes(2);
    expect(starts[1]).toMatchObject({
      input: newerActive.launch,
      options: {
        expectedExecutionEpochId: newerActive.executionEpochId,
        resumeOnly: true,
      },
    });
    await starts[1]!.handlers.onResult?.({
      ...newerActive.launch,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      commit: commitFromLoaded(afterNewerWinner, newerActive.launch.turnAttemptId),
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual([
        'First winning prompt',
        'First winning answer',
        'Newer active prompt',
        'Newer active answer',
      ]);
    });
    expect(controller.getCanRetryLastTurn()).toBe(false);
    expect(controller.getTransientSafeResendPrompt()).toBe('Rejected while the first winner commits');
    expect(messaging.getOrCreate).toHaveBeenCalledTimes(1);
    expect(messaging.create).not.toHaveBeenCalled();
    expect(messaging.start).toHaveBeenCalledTimes(2);
    deactivate();
  });

  it('drops a deferred final conflict load after deactivate and reactivation', async () => {
    const initial = loadedEmptySession('durable-conflict-deferred-final');
    const finalLoad = createDeferred<LoadedAgentSession>();
    const starts: Array<{
      input: Parameters<NonNullable<BgsmAgentTurnHandlers['onError']>>[0];
      handlers: BgsmAgentTurnHandlers;
    }> = [];
    messaging.getOrCreate.mockResolvedValue(initial);
    messaging.load
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(finalLoad.promise);
    messaging.inspectActive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    messaging.start.mockImplementation((input, handlers) => {
      starts.push({ input, handlers });
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    const controller = createBgsmAgentClientController({ labels: labels() });
    const deactivate = controller.activate();
    await waitForReady(controller);
    const rejectedResult = controller.startTurn('Do not publish after deactivate');
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    const conflict = starts[0]!.handlers.onError?.({
      ...starts[0]!.input,
      message: 'Another Cubby turn is already active for this conversation.',
      category: 'other',
      code: 'agent_session_turn_active',
    });
    await vi.waitFor(() => expect(messaging.load).toHaveBeenCalledTimes(2));

    deactivate();
    const deactivateAgain = controller.activate();
    finalLoad.resolve(loadedConversation(initial.session.id, 1, [
      ['Late winning prompt', 'Late winning answer'],
    ]));
    await conflict;
    await expect(rejectedResult).resolves.toBeNull();

    expect(controller.getSnapshot().messages).toEqual([]);
    expect(messaging.start).toHaveBeenCalledTimes(1);
    expect(messaging.create).not.toHaveBeenCalled();
    deactivateAgain();
  });

  it('does not let a stale final conflict load replace a newer canonical revision', async () => {
    const initial = loadedEmptySession('durable-conflict-monotonic');
    const newest = loadedConversation(initial.session.id, 2, [
      ['Newest prompt', 'Newest answer'],
    ]);
    const stale = loadedConversation(initial.session.id, 1, [
      ['Stale prompt', 'Stale answer'],
    ]);
    const staleFinalLoad = createDeferred<LoadedAgentSession>();
    const activeAtStaleRevision = {
      executionEpochId: 'worker-stale-active',
      launch: {
        turnAttemptId: 'stale-active-attempt',
        sessionId: initial.session.id,
        baseRevision: 1,
        prompt: 'Stale active prompt',
      },
    } as const;
    let handlers: BgsmAgentTurnHandlers | null = null;
    messaging.getOrCreate.mockResolvedValue(initial);
    messaging.load
      .mockResolvedValueOnce(newest)
      .mockReturnValueOnce(staleFinalLoad.promise);
    messaging.inspectActive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(activeAtStaleRevision);
    messaging.start.mockImplementation((_input, nextHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    const controller = createBgsmAgentClientController({ labels: labels() });
    const deactivate = controller.activate();
    await waitForReady(controller);
    const rejectedResult = controller.startTurn('Preserve the newest revision');
    await vi.waitFor(() => expect(handlers).not.toBeNull());
    const rejectedInput = messaging.start.mock.calls[0]![0];
    const conflict = handlers!.onError?.({
      ...rejectedInput,
      message: 'Another Cubby turn is already active for this conversation.',
      category: 'other',
      code: 'agent_session_turn_active',
    });
    await vi.waitFor(() => expect(messaging.load).toHaveBeenCalledTimes(2));
    staleFinalLoad.resolve(stale);
    await conflict;
    await expect(rejectedResult).resolves.toBeNull();

    const contents = controller.getSnapshot().messages.map((message) => message.content);
    expect(contents).toContain('Newest answer');
    expect(contents).not.toContain('Stale answer');
    expect(messaging.start).toHaveBeenCalledTimes(1);
    expect(messaging.create).not.toHaveBeenCalled();
    deactivate();
  });

  it('retains earlier history when an equal-revision conflict load is bounded and stale', async () => {
    const initial = loadedConversation('durable-conflict-equal-revision', 2, [
      ['Earlier prompt', 'Earlier answer'],
      ['Latest prompt', 'Latest answer'],
    ]);
    const bounded = loadedConversation(initial.session.id, 2, [
      ['Latest prompt', 'Latest answer'],
    ]);
    let handlers: BgsmAgentTurnHandlers | null = null;
    messaging.getOrCreate.mockResolvedValue(initial);
    messaging.load.mockResolvedValue(bounded);
    messaging.inspectActive.mockResolvedValue(null);
    messaging.start.mockImplementation((_input, nextHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    const controller = createBgsmAgentClientController({ labels: labels() });
    const deactivate = controller.activate();
    await waitForReady(controller);
    const rejectedResult = controller.startTurn('Keep the canonical history');
    await vi.waitFor(() => expect(handlers).not.toBeNull());
    const rejectedInput = messaging.start.mock.calls[0]![0];
    await handlers!.onError?.({
      ...rejectedInput,
      message: 'Another Cubby turn is already active for this conversation.',
      category: 'other',
      code: 'agent_session_turn_active',
    });
    await expect(rejectedResult).resolves.toBeNull();
    const contents = controller.getSnapshot().messages.map((message) => message.content);
    expect(contents).toEqual(expect.arrayContaining([
      'Earlier prompt',
      'Earlier answer',
      'Latest prompt',
      'Latest answer',
    ]));
    expect(messaging.start).toHaveBeenCalledTimes(1);
    deactivate();
  });

  it('blocks transient resend authority for a durable retry-source conflict', async () => {
    const initial = loadedEmptySession('durable-conflict-retry-source');
    const draft: AgentRetryDraft = {
      sessionId: initial.session.id,
      turnAttemptId: 'retry-source-attempt',
      baseRevision: initial.session.revision,
      prompt: 'Retry this exact source',
      kind: 'stopped',
      settlement: 'retryable',
      updatedAt: 1,
    };
    let handlers: BgsmAgentTurnHandlers | null = null;
    messaging.getOrCreate.mockResolvedValue(initial);
    messaging.load.mockResolvedValue(initial);
    messaging.inspectActive.mockResolvedValue(null);
    messaging.retryDraft.mockResolvedValue(draft);
    messaging.start.mockImplementation((_input, nextHandlers) => {
      handlers = nextHandlers;
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    const controller = createBgsmAgentClientController({ labels: labels() });
    const deactivate = controller.activate();
    await waitForReady(controller);
    const rejectedResult = controller.startTurn(draft.prompt, {
      retrySourceAttemptId: draft.turnAttemptId,
    });
    await vi.waitFor(() => expect(handlers).not.toBeNull());
    const rejectedInput = messaging.start.mock.calls[0]![0];
    expect(rejectedInput.retrySourceAttemptId).toBe(draft.turnAttemptId);
    await handlers!.onError?.({
      ...rejectedInput,
      message: 'Another Cubby turn is already active for this conversation.',
      category: 'other',
      code: 'agent_session_attempt_conflict',
    });
    await expect(rejectedResult).resolves.toBeNull();
    expect(controller.getTransientSafeResendPrompt()).toBeNull();
    expect(controller.getCanRetryLastTurn()).toBe(false);
    deactivate();
  });

  it('does not grant transient resend authority after admission or a write starts', async () => {
    const initial = loadedEmptySession('durable-conflict-after-write');
    let turn: { input: Parameters<NonNullable<BgsmAgentTurnHandlers['onError']>>[0]; handlers: BgsmAgentTurnHandlers } | null = null;
    messaging.getOrCreate.mockResolvedValue(initial);
    messaging.load.mockResolvedValue(initial);
    messaging.inspectActive.mockResolvedValue(null);
    messaging.start.mockImplementation((input, handlers) => {
      turn = { input, handlers };
      return { stop: vi.fn(), detach: vi.fn(), acknowledge: vi.fn() };
    });
    const controller = createBgsmAgentClientController({ labels: labels() });
    const deactivate = controller.activate();
    await waitForReady(controller);
    const rejectedResult = controller.startTurn('A write may have started');
    await vi.waitFor(() => expect(turn).not.toBeNull());
    turn!.handlers.onEvent?.({ ...turn!.input, type: 'agent_start' });
    turn!.handlers.onEvent?.({
      ...turn!.input,
      type: 'tool_execution_start',
      toolName: 'assign_repo_tags',
      callId: 'write-call',
      risk: 'write',
    });
    await turn!.handlers.onError?.({
      ...turn!.input,
      message: 'Another Cubby turn is already active for this conversation.',
      category: 'other',
      code: 'agent_session_turn_active',
    });
    await expect(rejectedResult).resolves.toBeNull();

    expect(controller.getSnapshot().turnState.transientSafeResendPrompt).toBeNull();
    expect(controller.getCanRetryLastTurn()).toBe(false);
    deactivate();
  });
});

function labels(): BgsmAgentClientLabels {
  return {
    agentCompacting: 'Compacting',
    agentDone: 'Done',
    agentQueued: 'Queued',
    agentStarting: 'Starting',
    agentStopped: 'Stopped',
    agentThinking: 'Thinking',
    agentWriting: 'Writing',
    agentReadingData: 'Reading',
    agentPreparingOrganizationScope: 'Preparing',
    agentApplyingChanges: 'Applying',
    attemptResumeStateUnknown: 'Resume unknown',
    attemptStateLost: 'Attempt lost',
    turnFailed: 'Turn failed',
  };
}

function loadedEmptySession(id: string): LoadedAgentSession {
  return {
    session: { id, revision: 0 },
    transcript: { sessionId: id, messages: [], nextBeforeSequence: null },
    summary: { id, title: '', createdAt: 1, updatedAt: 1 },
    lastAppliedTurnAttemptId: null,
    appliedTurnReceipts: [],
  };
}

function loadedConversation(
  sessionId: string,
  revision: number,
  turns: readonly (readonly [prompt: string, answer: string])[],
): LoadedAgentSession {
  const messages = turns.flatMap(([prompt, answer], index) => {
    const turn = index + 1;
    return [
      {
        sequence: index * 2 + 1,
        id: `user-${revision}-${turn}`,
        role: 'user' as const,
        content: prompt,
        createdAt: index * 2 + 2,
      },
      {
        sequence: index * 2 + 2,
        id: `agent-${revision}-${turn}`,
        role: 'agent' as const,
        content: answer,
        createdAt: index * 2 + 3,
      },
    ];
  });
  return {
    session: { id: sessionId, revision },
    transcript: { sessionId, messages, nextBeforeSequence: null },
    summary: {
      id: sessionId,
      title: turns[0]?.[0] ?? '',
      createdAt: 1,
      updatedAt: revision + 1,
    },
    lastAppliedTurnAttemptId: null,
    appliedTurnReceipts: [],
  };
}

function commitFromLoaded(
  loaded: LoadedAgentSession,
  turnAttemptId: string,
): AgentSessionCommitResult {
  return {
    session: loaded.session,
    summary: loaded.summary,
    turnAttemptId,
    idempotent: false,
    appliedRevision: loaded.session.revision,
    digest: `asd:v1:${'c'.repeat(43)}` as `asd:v1:${string}`,
    launchDigest: `asl:v1:${'d'.repeat(43)}` as `asl:v1:${string}`,
    outcome: {
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      writeSettlement: 'none',
    },
    transcript: loaded.transcript,
    presentationMessages: loaded.transcript.messages.filter(
      (message): message is typeof message & { role: 'user' | 'agent' } => (
        message.role === 'user' || message.role === 'agent'
      )),
  };
}

function committedWinner(sessionId: string, turnAttemptId: string) {
  const messages = [
    { sequence: 1, id: 'winner-user', role: 'user' as const, content: 'Winning prompt', createdAt: 2 },
    { sequence: 2, id: 'winner-agent', role: 'agent' as const, content: 'Winning answer', createdAt: 3 },
  ];
  return {
    session: { id: sessionId, revision: 1 },
    summary: { id: sessionId, title: 'Winning prompt', createdAt: 1, updatedAt: 3 },
    turnAttemptId,
    idempotent: false,
    appliedRevision: 1,
    digest: `asd:v1:${'a'.repeat(43)}` as `asd:v1:${string}`,
    launchDigest: `asl:v1:${'b'.repeat(43)}` as `asl:v1:${string}`,
    outcome: {
      reason: 'final_answer' as const,
      changed: false,
      changedCount: 0,
      writeSettlement: 'none' as const,
    },
    transcript: { sessionId, messages, nextBeforeSequence: null },
    presentationMessages: messages,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitForReady(controller: BgsmAgentClientController): Promise<void> {
  await vi.waitFor(() => expect(controller.getSnapshot().sessionReady).toBe(true));
}
