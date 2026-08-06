import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_TURN_ERROR_CODES,
  normalizeAgentTurnErrorCode,
  parseAgentTurnErrorCode,
  type AgentTurnErrorCode,
  type BgsmAgentTurnInput,
} from '@/bgsm-agent';
import type { AgentRetryDraft, AgentSessionCommitResult } from '@/storage/agent-session-store';
import {
  BackgroundCallError,
  bgCall,
  discardDurableAgentSessionRecovery,
  dismissDurableAgentSessionRetry,
  loadDurableBgsmAgentSessionCommittedTurn,
  readDurableAgentRetryDraftCandidate,
  startBgsmAgentTurn,
  type BgsmAgentTurnError,
  type BgsmAgentTurnResult,
} from '@/utils/messaging';

type Listener<T> = (value: T) => void;

function createRuntimePort() {
  const messageListeners: Array<Listener<unknown>> = [];
  const disconnectListeners: Array<() => void> = [];
  const port = {
    onMessage: {
      addListener: vi.fn((listener: Listener<unknown>) => {
        messageListeners.push(listener);
      }),
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) => {
        disconnectListeners.push(listener);
      }),
    },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    port,
    deliver(message: unknown) {
      messageListeners.forEach((listener) => listener(message));
    },
    disconnect() {
      disconnectListeners.forEach((listener) => listener());
    },
  };
}

function commitForMessaging(
  input: BgsmAgentTurnInput,
  messages: readonly {
    id: string;
    role: 'user' | 'agent' | 'tool';
    content: string;
    createdAt: number;
    toolCallId?: string;
    toolName?: string;
    toolCalls?: readonly { id: string; name: string; arguments: unknown }[];
    artifactIds?: string[];
  }[],
  options: Readonly<{
    handoff?: 'request_confirmation' | 'start_analysis';
    activeProjections?: readonly Record<string, unknown>[];
    changed?: boolean;
    changedCount?: number;
    writeSettlement?: AgentSessionCommitResult['outcome']['writeSettlement'];
  }> = {},
): AgentSessionCommitResult {
  const appliedRevision = input.baseRevision + 1;
  const presentationMessages = messages
    .filter((message): message is typeof message & { role: 'user' | 'agent' } => (
      message.role === 'user' || message.role === 'agent'
    ))
    .filter((message) => message.content.trim().length > 0)
    .map((message, index) => ({
      sequence: index + 1,
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }));
  return {
    session: {
      id: input.sessionId,
      revision: appliedRevision,
      ...(options.activeProjections ? { activeProjections: options.activeProjections as never } : {}),
    },
    summary: { id: input.sessionId, title: input.prompt, createdAt: 1, updatedAt: 2 },
    turnAttemptId: input.turnAttemptId,
    idempotent: false,
    appliedRevision,
    digest: `asd:v1:${'a'.repeat(43)}`,
    launchDigest: `asl:v1:${'b'.repeat(43)}`,
    outcome: {
      reason: 'final_answer',
      changed: options.changed ?? false,
      changedCount: options.changedCount ?? 0,
      writeSettlement: options.writeSettlement ?? 'none',
      ...(options.handoff
        ? {
            organizeLibraryAction: options.handoff,
            handoffAnchor: {
              messageId: presentationMessages.at(-1)?.id ?? null,
              createdAt: presentationMessages.at(-1)?.createdAt ?? 1,
            },
          }
        : {}),
    },
    transcript: {
      sessionId: input.sessionId,
      messages: messages.map((message, index) => ({ sequence: index + 1, ...message })),
      nextBeforeSequence: null,
    },
    presentationMessages,
  } as AgentSessionCommitResult;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cubby messaging', () => {
  it('loads an exact durable turn receipt through the typed background RPC', async () => {
    const commit = { turnAttemptId: 'turn-attempt-hydrate' } as AgentSessionCommitResult;
    const sendMessage = vi.fn(async () => ({ ok: true, data: commit }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await expect(loadDurableBgsmAgentSessionCommittedTurn({
      sessionId: 'session-hydrate',
      turnAttemptId: 'turn-attempt-hydrate',
      launchDigest: `asl:v1:${'a'.repeat(43)}`,
    })).resolves.toBe(commit);
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'loadCommittedAgentSessionTurn',
      sessionId: 'session-hydrate',
      turnAttemptId: 'turn-attempt-hydrate',
      launchDigest: `asl:v1:${'a'.repeat(43)}`,
    });
  });

  it('sends retry projection reads and explicit command payloads', async () => {
    const current: AgentRetryDraft = {
      sessionId: 'session-retry-draft',
      turnAttemptId: 'attempt-retry-draft',
      baseRevision: 4,
      prompt: 'List recent repositories.',
      kind: 'stopped',
      settlement: 'stop_pending',
      updatedAt: 1_800_000_000_000,
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'readAgentRetryDraftCandidate') return { ok: true, data: current };
      if (message.type === 'dismissAgentSessionRetry') return { ok: true, data: true };
      if (message.type === 'discardDamagedAgentSessionRecovery') return { ok: true, data: 2 };
      return { ok: false, error: 'Unexpected request.' };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await expect(readDurableAgentRetryDraftCandidate(current.sessionId)).resolves.toEqual(current);
    await expect(dismissDurableAgentSessionRetry({
      sessionId: current.sessionId,
      turnAttemptId: current.turnAttemptId,
    })).resolves.toBe(true);
    await expect(discardDurableAgentSessionRecovery(current.sessionId)).resolves.toBe(2);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: 'readAgentRetryDraftCandidate', sessionId: current.sessionId },
      {
        type: 'dismissAgentSessionRetry',
        sessionId: current.sessionId,
        turnAttemptId: current.turnAttemptId,
      },
      { type: 'discardDamagedAgentSessionRecovery', sessionId: current.sessionId },
    ]);
  });

  it.each([
    ['transport rejection', () => Promise.reject(new Error('worker unavailable'))],
    ['background rejection', () => Promise.resolve({ ok: false, error: 'storage unavailable' })],
  ])('fails retry projection reads and commands closed after %s', async (
    _label,
    response,
  ) => {
    const value: AgentRetryDraft = {
      sessionId: 'session-fallback',
      turnAttemptId: 'attempt-fallback',
      baseRevision: 0,
      prompt: 'Keep this prompt in memory.',
      kind: 'failed',
      settlement: 'retryable',
      updatedAt: 1,
    };
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(response) } });

    await expect(readDurableAgentRetryDraftCandidate(value.sessionId)).rejects.toThrow();
    await expect(dismissDurableAgentSessionRetry({
      sessionId: value.sessionId,
      turnAttemptId: value.turnAttemptId,
    })).rejects.toThrow();
    await expect(discardDurableAgentSessionRecovery(value.sessionId)).rejects.toThrow();
  });

  it('preserves stable background error codes without exposing protocol details as control flow', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () => ({
          ok: false,
          error: 'Finish the active workflow first.',
          code: 'agent_session_deletion_blocked',
          details: { jobId: 'organize-job:v1:blocked' },
        })),
      },
    });

    const error = await bgCall('deleteAgentSession').catch((failure) => failure);
    expect(error).toBeInstanceOf(BackgroundCallError);
    expect(error).toMatchObject({
      message: 'Finish the active workflow first.',
      code: 'agent_session_deletion_blocked',
      details: { jobId: 'organize-job:v1:blocked' },
    });
  });

  it.each(AGENT_TURN_ERROR_CODES)(
    'round-trips producer-normalized Agent error code %s through the UI Port',
    (code: AgentTurnErrorCode) => {
      expect(normalizeAgentTurnErrorCode({ code })).toBe(code);
      expect(parseAgentTurnErrorCode(code)).toBe(code);

      const runtime = createRuntimePort();
      vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => runtime.port) } });
      const input: BgsmAgentTurnInput = {
        turnAttemptId: `turn-attempt-error-${code}`,
        sessionId: 'session-error-code',
        baseRevision: 2,
        prompt: 'Deliver a typed error',
        history: [],
      };
      const onError = vi.fn();
      startBgsmAgentTurn(input, { onError });
      runtime.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
      runtime.deliver({
        type: 'bgsmAgentTurnError',
        sequence: 0,
        error: {
          turnAttemptId: input.turnAttemptId,
          sessionId: input.sessionId,
          baseRevision: input.baseRevision,
          message: 'Typed Agent failure.',
          category: 'other',
          code,
        },
      });

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code }));
    },
  );

  it('fails closed for unknown Agent error codes', () => {
    const runtime = createRuntimePort();
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => runtime.port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-unknown-error-code',
      sessionId: 'session-unknown-error-code',
      baseRevision: 0,
      prompt: 'Reject unknown errors',
      history: [],
    };
    const onError = vi.fn();
    startBgsmAgentTurn(input, { onError });
    runtime.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    runtime.deliver({
      type: 'bgsmAgentTurnError',
      sequence: 0,
      error: {
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        message: 'Unknown failure.',
        category: 'other',
        code: 'agent_unbounded_unknown_code',
      },
    });

    expect(normalizeAgentTurnErrorCode({ code: 'agent_unbounded_unknown_code' })).toBeUndefined();
    expect(parseAgentTurnErrorCode('agent_unbounded_unknown_code')).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Cubby's connection returned invalid data. Try again.",
      category: 'other',
    }));
    expect(runtime.port.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    ['none', false, 0],
    ['all_failed', false, 0],
    ['unsafe', true, 1],
  ] as const)('accepts a %s terminal write settlement across the Port', (
    writeSettlement,
    changed,
    changedCount,
  ) => {
    const runtime = createRuntimePort();
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => runtime.port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: `turn-attempt-settlement-${writeSettlement}`,
      sessionId: `session-settlement-${writeSettlement}`,
      baseRevision: 0,
      prompt: `Validate ${writeSettlement} settlement`,
      history: [],
    };
    const onResult = vi.fn();
    const onError = vi.fn();
    const commit = commitForMessaging(input, [{
      id: `settlement-${writeSettlement}-user`,
      role: 'user',
      content: input.prompt,
      createdAt: 1,
    }], { changed, changedCount, writeSettlement });
    const result = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'final_answer' as const,
      changed,
      changedCount,
      commit,
    };

    startBgsmAgentTurn(input, { onResult, onError });
    runtime.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    runtime.deliver({ type: 'bgsmAgentTurnResult', sequence: 0, result });

    expect(onResult).toHaveBeenCalledWith(result);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid value', false, 0, 'partially_failed'],
    ['changed with none', true, 1, 'none'],
    ['changed with all_failed', true, 1, 'all_failed'],
  ] as const)('rejects terminal settlement contract: %s', (
    label,
    changed,
    changedCount,
    writeSettlement,
  ) => {
    const runtime = createRuntimePort();
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => runtime.port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: `turn-attempt-invalid-settlement-${label.replaceAll(' ', '-')}`,
      sessionId: `session-invalid-settlement-${label.replaceAll(' ', '-')}`,
      baseRevision: 0,
      prompt: 'Reject an invalid settlement receipt',
      history: [],
    };
    const onResult = vi.fn();
    const onError = vi.fn();
    const validCommit = commitForMessaging(input, [{
      id: 'invalid-settlement-user',
      role: 'user',
      content: input.prompt,
      createdAt: 1,
    }]);
    const result = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'final_answer',
      changed,
      changedCount,
      commit: {
        ...validCommit,
        outcome: {
          ...validCommit.outcome,
          changed,
          changedCount,
          writeSettlement,
        },
      },
    };

    startBgsmAgentTurn(input, { onResult, onError });
    runtime.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    runtime.deliver({ type: 'bgsmAgentTurnResult', sequence: 0, result });

    expect(onResult).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ category: 'other' }));
    expect(runtime.port.disconnect).toHaveBeenCalledOnce();
  });

  it('requires persisted sequence on durable transcript messages', () => {
    const runtime = createRuntimePort();
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => runtime.port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-missing-transcript-sequence',
      sessionId: 'session-missing-transcript-sequence',
      baseRevision: 0,
      prompt: 'Reject unordered transcript transport',
      history: [],
    };
    const commit = commitForMessaging(input, [{
      id: 'missing-sequence-user',
      role: 'user',
      content: input.prompt,
      createdAt: 1,
    }]);
    const transcriptMessage = commit.transcript.messages[0]!;
    const { sequence: _sequence, ...withoutSequence } = transcriptMessage;
    const result = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'final_answer' as const,
      changed: false,
      changedCount: 0,
      commit: {
        ...commit,
        transcript: { ...commit.transcript, messages: [withoutSequence] },
      },
    };
    const onResult = vi.fn();
    const onError = vi.fn();

    startBgsmAgentTurn(input, { onResult, onError });
    runtime.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    runtime.deliver({ type: 'bgsmAgentTurnResult', sequence: 0, result });

    expect(onResult).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ category: 'other' }));
    expect(runtime.port.disconnect).toHaveBeenCalledOnce();
  });

  it('delivers context preflight diagnostics across the Port', () => {
    const runtime = createRuntimePort();
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => runtime.port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-context-preflight',
      sessionId: 'session-context-preflight',
      baseRevision: 4,
      prompt: 'Continue after compaction',
      history: [],
    };
    const onEvent = vi.fn();

    startBgsmAgentTurn(input, { onEvent });
    runtime.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    const event = {
      type: 'context_diagnostic' as const,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      stage: 'preflight' as const,
      providerWindow: 272_000,
      workingWindow: 260_000,
      softLimit: 234_000,
      hardLimit: 260_000,
      capabilitySource: 'builtin-official' as const,
      capabilityRevision: 'capability-v1',
      policyRevision: 'policy-v1',
      action: 'triggered' as const,
      trigger: 'context_preflight' as const,
    };

    runtime.deliver({ type: 'bgsmAgentTurnEvent', sequence: 0, event });

    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('delivers a sequence-free live tool message before its terminal result', () => {
    const runtime = createRuntimePort();
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => runtime.port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-live-message',
      sessionId: 'session-live-message',
      baseRevision: 1,
      prompt: 'Run the artifact-backed tool',
      history: [],
    };
    const onEvent = vi.fn();
    const onResult = vi.fn();
    const onError = vi.fn();
    const event = {
      type: 'message_update' as const,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      message: {
        id: 'live-tool-result',
        role: 'tool' as const,
        content: '{"artifact":true}',
        createdAt: 10,
        toolCallId: 'call-live-artifact',
        toolName: 'search_repositories',
        artifactIds: ['artifact:v1:live-result'],
      },
    };
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      commit: null,
    };

    startBgsmAgentTurn(input, { onEvent, onResult, onError });
    runtime.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    runtime.deliver({ type: 'bgsmAgentTurnEvent', sequence: 0, event });
    runtime.deliver({ type: 'bgsmAgentTurnResult', sequence: 1, result });

    expect(onEvent).toHaveBeenCalledWith(event);
    expect(onResult).toHaveBeenCalledWith(result);
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects durable sequence metadata on a live message update', () => {
    const runtime = createRuntimePort();
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => runtime.port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-live-sequence',
      sessionId: 'session-live-sequence',
      baseRevision: 0,
      prompt: 'Reject durable metadata in live events',
      history: [],
    };
    const onEvent = vi.fn();
    const onError = vi.fn();

    startBgsmAgentTurn(input, { onEvent, onError });
    runtime.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    runtime.deliver({
      type: 'bgsmAgentTurnEvent',
      sequence: 0,
      event: {
        type: 'message_update',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        message: {
          sequence: 1,
          id: 'invalid-live-user',
          role: 'user',
          content: input.prompt,
          createdAt: 1,
        },
      },
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ category: 'other' }));
    expect(runtime.port.disconnect).toHaveBeenCalledOnce();
  });

  it('delivers the internal tool-memory recovery reason across the Port', () => {
    const runtime = createRuntimePort();
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => runtime.port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-tool-memory',
      sessionId: 'session-tool-memory',
      baseRevision: 2,
      prompt: 'List every matching repository',
      history: [],
    };
    const onResult = vi.fn();

    startBgsmAgentTurn(input, { onResult });
    runtime.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'context_limit',
      contextFailureReason: 'tool_result_memory_limit',
      changed: false,
      changedCount: 0,
      commit: null,
    };
    runtime.deliver({ type: 'bgsmAgentTurnResult', sequence: 0, result });

    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('keeps canonical history out of the launch Port while preserving turn results', () => {
    let messageListener: Listener<unknown> | undefined;
    const postMessage = vi.fn();
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage,
      disconnect: vi.fn(),
    };
    vi.stubGlobal('chrome', {
      runtime: {
        connect: vi.fn(() => port),
      },
    });

    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-history',
      sessionId: 'session-1',
      baseRevision: 7,
      prompt: 'Continue',
      history: [
        {
          id: 'assistant-call',
          role: 'agent',
          content: '',
          createdAt: 1,
          toolCalls: [{ id: 'call-1', name: 'list_tags', arguments: {} }],
        },
        {
          id: 'tool-result',
          role: 'tool',
          content: '{"ok":true}',
          createdAt: 2,
          toolCallId: 'call-1',
          toolName: 'list_tags',
          artifactIds: ['artifact:v1:committed-result'],
        },
      ],
    };
    const onResult = vi.fn();

    const control = startBgsmAgentTurn(input, { onResult });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'startBgsmAgentTurn',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      prompt: input.prompt,
    });

    const candidateActiveProjection = {
      schemaVersion: 1 as const,
      currentUserMessageId: 'active-user',
      summarizedThroughMessageId: 'active-tool-result',
      retainedSuffixFirstMessageId: null,
      rawMessageCountAtCreation: 3,
      rawTailMessageIdAtCreation: 'active-tool-result',
      capabilityRevision: 'capability-v1',
      policyRevision: 'policy-v1',
      summary: 'Completed tool evidence is untrusted background only.',
    };
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: 'session-1',
      baseRevision: 7,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      commit: commitForMessaging(input, input.history, {
        activeProjections: [candidateActiveProjection],
        handoff: 'request_confirmation',
      }),
      organizeLibraryHandoff: {
        type: 'organize_whole_library',
        action: 'request_confirmation',
        instruction: 'Organize everything in my saved projects.',
      },
    };
    messageListener?.({ type: 'bgsmAgentTurnResult', sequence: 0, result });

    expect(onResult).toHaveBeenCalledWith(result);
    expect(onResult.mock.calls[0]?.[0].commit.session.activeProjections?.[0]).toEqual(candidateActiveProjection);
    expect(onResult.mock.calls[0]?.[0].organizeLibraryHandoff).toEqual(
      result.organizeLibraryHandoff,
    );
    expect(onResult.mock.calls[0]?.[0].commit.transcript.messages[1].toolCallId).toBe('call-1');
    expect(onResult.mock.calls[0]?.[0].commit.transcript.messages[1].artifactIds)
      .toEqual(['artifact:v1:committed-result']);
    control.acknowledge({ disposition: 'applied', appliedRevision: 8 });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 8,
    });
    expect(port.disconnect).not.toHaveBeenCalled();
    messageListener?.({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 8,
    });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it('preserves delivery identity on streamed events and errors', () => {
    let messageListener: Listener<unknown> | undefined;
    let disconnectListener: (() => void) | undefined;
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: {
        addListener: vi.fn((listener: () => void) => {
          disconnectListener = listener;
        }),
      },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    vi.stubGlobal('chrome', {
      runtime: {
        connect: vi.fn(() => port),
        lastError: undefined,
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-delivery',
      sessionId: 'session-1',
      baseRevision: 3,
      prompt: 'Continue',
      history: [],
    };
    const onEvent = vi.fn();
    const onError = vi.fn();

    const firstControl = startBgsmAgentTurn(input, { onEvent, onError });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    const event = {
      type: 'agent_queued' as const,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    };
    messageListener?.({ type: 'bgsmAgentTurnEvent', sequence: 0, event });
    expect(onEvent).toHaveBeenCalledWith(event);

    const error: BgsmAgentTurnError = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      message: 'Provider failed.',
      code: 'agent_artifact_access_denied',
    };
    messageListener?.({ type: 'bgsmAgentTurnError', sequence: 1, error });
    expect(onError).toHaveBeenCalledWith(error);
    firstControl.acknowledge({ disposition: 'no_transition', appliedRevision: null });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'no_transition',
      appliedRevision: null,
    });
    messageListener?.({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'no_transition',
      appliedRevision: null,
    });

    const disconnectError = vi.fn();
    startBgsmAgentTurn(input, { onError: disconnectError });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    disconnectListener?.();
    expect(disconnectError).not.toHaveBeenCalled();
    disconnectListener?.();
    expect(disconnectError).not.toHaveBeenCalled();
    disconnectListener?.();
    expect(disconnectError).toHaveBeenCalledWith({
      turnAttemptId: input.turnAttemptId,
      sessionId: 'session-1',
      baseRevision: 3,
      message: 'Cubby stopped before finishing. Try again.',
    });
  });

  it('retries failed start posts and reports the final Port error', async () => {
    const transports = Array.from({ length: 3 }, () => createRuntimePort());
    for (const transport of transports) {
      transport.port.postMessage.mockImplementation(() => {
        throw new Error('Port is disconnected');
      });
    }
    const connect = vi.fn()
      .mockReturnValueOnce(transports[0].port)
      .mockReturnValueOnce(transports[1].port)
      .mockReturnValueOnce(transports[2].port);
    vi.stubGlobal('chrome', { runtime: { connect, lastError: undefined } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-post-failure',
      sessionId: 'session-post-failure',
      baseRevision: 5,
      prompt: 'Start safely',
      history: [],
    };
    const onError = vi.fn();

    startBgsmAgentTurn(input, { onError });
    transports[0].deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    await Promise.resolve();
    transports[1].deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    await Promise.resolve();
    transports[2].deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(transports.every(({ port }) => port.disconnect.mock.calls.length === 1)).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      message: 'Port is disconnected',
    });
  });

  it('reconnects to the same worker and skips replayed deliveries already applied by the UI', () => {
    const first = createRuntimePort();
    const replay = createRuntimePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(replay.port);
    vi.stubGlobal('chrome', { runtime: { connect, lastError: undefined } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-reconnect',
      sessionId: 'session-reconnect',
      baseRevision: 2,
      prompt: 'Continue safely',
      history: [],
    };
    const onEvent = vi.fn();
    const onResult = vi.fn();

    const control = startBgsmAgentTurn(input, { onEvent, onResult });
    first.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    const queued = {
      type: 'agent_queued' as const,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    };
    first.deliver({ type: 'bgsmAgentTurnEvent', sequence: 0, event: queued });
    first.disconnect();

    replay.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    expect(replay.port.postMessage).toHaveBeenCalledWith({
      type: 'startBgsmAgentTurn',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      prompt: input.prompt,
    });
    replay.deliver({ type: 'bgsmAgentTurnEvent', sequence: 0, event: queued });
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      commit: null,
    };
    replay.deliver({ type: 'bgsmAgentTurnResult', sequence: 1, result });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(result);
    control.acknowledge({ disposition: 'applied', appliedRevision: 3 });
    expect(replay.port.disconnect).not.toHaveBeenCalled();
    replay.deliver({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 3,
    });
    expect(replay.port.disconnect).toHaveBeenCalledOnce();
  });

  it('uses the original epoch after worker restart and accepts attempt_state_lost at sequence zero', () => {
    const first = createRuntimePort();
    const restarted = createRuntimePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(restarted.port);
    vi.stubGlobal('chrome', { runtime: { connect, lastError: undefined } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-lost',
      sessionId: 'session-lost',
      baseRevision: 4,
      prompt: 'Continue safely',
      history: [],
    };
    const onResult = vi.fn();

    const control = startBgsmAgentTurn(input, { onResult });
    first.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    first.deliver({
      type: 'bgsmAgentTurnEvent',
      sequence: 0,
      event: {
        type: 'agent_queued',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
      },
    });
    first.disconnect();
    restarted.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-2' });
    expect(restarted.port.postMessage).toHaveBeenCalledWith({
      type: 'startBgsmAgentTurn',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      prompt: input.prompt,
    });
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'attempt_state_lost',
      changed: false,
      changedCount: 0,
      commit: null,
    };
    restarted.deliver({ type: 'bgsmAgentTurnResult', sequence: 0, result });

    expect(onResult).toHaveBeenCalledWith(result);
    control.acknowledge({ disposition: 'no_transition', appliedRevision: null });
    restarted.deliver({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'no_transition',
      appliedRevision: null,
    });
    expect(restarted.port.disconnect).toHaveBeenCalledOnce();
  });

  it('sends a resume-only launch only when the inspected worker epoch still matches', () => {
    const matching = createRuntimePort();
    const changed = createRuntimePort();
    const connect = vi.fn()
      .mockReturnValueOnce(matching.port)
      .mockReturnValueOnce(changed.port);
    vi.stubGlobal('chrome', { runtime: { connect, lastError: undefined } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-resume-only',
      sessionId: 'session-resume-only',
      baseRevision: 3,
      prompt: 'Resume without rerunning',
      history: [],
    };

    startBgsmAgentTurn(input, {}, {
      expectedExecutionEpochId: 'worker-epoch-1',
      resumeOnly: true,
    });
    matching.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    expect(matching.port.postMessage).toHaveBeenCalledWith({
      type: 'startBgsmAgentTurn',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      prompt: input.prompt,
      resumeOnly: true,
    });

    const onError = vi.fn();
    startBgsmAgentTurn({ ...input, turnAttemptId: 'turn-attempt-old-epoch' }, { onError }, {
      expectedExecutionEpochId: 'worker-epoch-1',
      resumeOnly: true,
    });
    changed.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-2' });
    expect(changed.port.postMessage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'agent_turn_resume_epoch_changed',
    }));
    expect(changed.port.disconnect).toHaveBeenCalledOnce();
  });

  it('resends an unconfirmed acknowledgement after reconnect', () => {
    const first = createRuntimePort();
    const retry = createRuntimePort();
    const connect = vi.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(retry.port);
    vi.stubGlobal('chrome', { runtime: { connect, lastError: undefined } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-ack-retry',
      sessionId: 'session-ack-retry',
      baseRevision: 1,
      prompt: 'Finish safely',
      history: [],
    };
    const control = startBgsmAgentTurn(input, { onResult: vi.fn() });
    first.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    first.deliver({
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: {
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        reason: 'final_answer',
        changed: false,
        changedCount: 0,
        commit: null,
      },
    });
    control.acknowledge({ disposition: 'applied', appliedRevision: 2 });
    first.disconnect();

    retry.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    expect(retry.port.postMessage).toHaveBeenCalledWith({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 2,
    });
    retry.deliver({
      type: 'bgsmAgentTurnAck',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      disposition: 'applied',
      appliedRevision: 2,
    });
    expect(retry.port.disconnect).toHaveBeenCalledOnce();
  });

  it('detaches without stopping, acknowledging, reconnecting, or delivering callbacks', () => {
    const transport = createRuntimePort();
    const connect = vi.fn(() => transport.port);
    vi.stubGlobal('chrome', {
      runtime: { connect, lastError: undefined },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-detached',
      sessionId: 'session-detached',
      baseRevision: 0,
      prompt: 'Stop during unmount',
      history: [],
    };
    const onResult = vi.fn();
    const onError = vi.fn();
    const control = startBgsmAgentTurn(input, { onResult, onError });
    transport.deliver({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    control.detach();
    transport.disconnect();
    transport.deliver({
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: {
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
        reason: 'aborted',
        changed: false,
        changedCount: 0,
        commit: null,
      },
    });

    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(transport.port.disconnect).toHaveBeenCalledOnce();
    expect(transport.port.postMessage).toHaveBeenCalledTimes(1);
    expect(transport.port.postMessage).toHaveBeenCalledWith({
      type: 'startBgsmAgentTurn',
      executionEpochId: 'worker-epoch-1',
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      prompt: input.prompt,
    });
  });

  it('applies exact-next deliveries once, rejects gaps, and sends one explicit stop', () => {
    let messageListener: Listener<unknown> | undefined;
    const postMessage = vi.fn();
    const disconnect = vi.fn();
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage,
      disconnect,
    };
    vi.stubGlobal('chrome', {
      runtime: {
        connect: vi.fn(() => port),
      },
    });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-sequenced',
      sessionId: 'session-sequenced',
      baseRevision: 2,
      prompt: 'Stream this',
      history: [],
    };
    const onEvent = vi.fn();
    const onError = vi.fn();
    const control = startBgsmAgentTurn(input, { onEvent, onError });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    const queued = {
      type: 'agent_queued' as const,
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    };
    messageListener?.({
      type: 'bgsmAgentTurnEvent',
      sequence: 0,
      event: { ...queued, sessionId: 'stale-session' },
    });
    messageListener?.({ type: 'bgsmAgentTurnEvent', sequence: 0, event: queued });
    messageListener?.({ type: 'bgsmAgentTurnEvent', sequence: 0, event: queued });
    messageListener?.({
      type: 'bgsmAgentTurnEvent',
      sequence: 2,
      event: { ...queued, type: 'agent_start' },
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Cubby's connection was interrupted. Try again.",
    }));
    expect(disconnect).toHaveBeenCalledOnce();

    control.stop();
    control.stop();
    expect(postMessage.mock.calls.filter(([message]) => message.type === 'stopBgsmAgentTurn'))
      .toHaveLength(0);
  });

  it('keeps the Port open after Stop until the sequenced aborted result arrives', () => {
    let messageListener: Listener<unknown> | undefined;
    const postMessage = vi.fn();
    const disconnect = vi.fn();
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage,
      disconnect,
    };
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-stop',
      sessionId: 'session-stop',
      baseRevision: 4,
      prompt: 'Stop this',
      history: [],
    };
    const onResult = vi.fn();
    const control = startBgsmAgentTurn(input, { onResult });
    control.stop();
    control.stop();
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });

    expect(postMessage.mock.calls.filter(([message]) => message.type === 'stopBgsmAgentTurn'))
      .toEqual([[{
        type: 'stopBgsmAgentTurn',
        executionEpochId: 'worker-epoch-1',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
      }]]);
    expect(disconnect).not.toHaveBeenCalled();

    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'aborted',
      changed: false,
      changedCount: 0,
      commit: null,
    };
    messageListener?.({ type: 'bgsmAgentTurnResult', sequence: 0, result });
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('does not deliver messages after the final result', () => {
    let messageListener: Listener<unknown> | undefined;
    const port = {
      onMessage: {
        addListener: vi.fn((listener: Listener<unknown>) => {
          messageListener = listener;
        }),
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } });
    const input: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-terminal',
      sessionId: 'session-terminal',
      baseRevision: 1,
      prompt: 'Finish once',
      history: [],
    };
    const onEvent = vi.fn();
    const onResult = vi.fn();
    const result: BgsmAgentTurnResult = {
      turnAttemptId: input.turnAttemptId,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      commit: null,
    };

    startBgsmAgentTurn(input, { onEvent, onResult });
    messageListener?.({ type: 'bgsmAgentTurnHello', executionEpochId: 'worker-epoch-1' });
    messageListener?.({ type: 'bgsmAgentTurnResult', sequence: 0, result });
    messageListener?.({
      type: 'bgsmAgentTurnEvent',
      sequence: 1,
      event: {
        type: 'agent_start',
        turnAttemptId: input.turnAttemptId,
        sessionId: input.sessionId,
        baseRevision: input.baseRevision,
      },
    });

    expect(onResult).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();
  });
});
