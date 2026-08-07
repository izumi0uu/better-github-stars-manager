import { describe, expect, it } from 'vitest';
import {
  AGENT_ATTEMPT_STATE_LOST_ERROR_CODE,
  AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE,
  AGENT_SESSION_TURN_TRANSPORT_MAX_BYTES,
  AGENT_TURN_ERROR_CODES,
  BGSM_AGENT_PROMPT_MAX_BYTES,
  normalizeAgentTurnErrorCode,
  parseAgentTurnErrorCode,
  parseBgsmAgentTurnClientMessage,
  parseBgsmAgentTurnServerMessage,
} from '@/bgsm-agent';

const DELIVERY_IDENTITY = {
  turnAttemptId: 'turn-attempt-1',
  sessionId: 'session-1',
  baseRevision: 0,
} as const;

const EXECUTION_EPOCH_ID = 'worker-epoch-1';

function event(payload: Record<string, unknown>) {
  return { ...DELIVERY_IDENTITY, ...payload };
}

function serverEvent(payload: Record<string, unknown>, sequence = 0) {
  return {
    type: 'bgsmAgentTurnEvent',
    sequence,
    event: event(payload),
  };
}

function result(commit: Record<string, unknown> | null = null) {
  return {
    ...DELIVERY_IDENTITY,
    reason: 'final_answer',
    changed: false,
    changedCount: 0,
    commit,
  };
}

function commit() {
  const transcriptMessages: Record<string, unknown>[] = [
    {
      sequence: 1,
      id: 'message-user-1',
      role: 'user',
      content: 'Inspect the protocol.',
      createdAt: 1,
    },
    {
      sequence: 2,
      id: 'message-agent-1',
      role: 'agent',
      content: '',
      createdAt: 2,
      toolCalls: [{ id: 'call-1', name: 'inspect', arguments: { path: 'src' } }],
    },
    {
      sequence: 3,
      id: 'message-tool-1',
      role: 'tool',
      content: 'Stored externally.',
      createdAt: 3,
      toolCallId: 'call-1',
      toolName: 'inspect',
      opaqueReferences: ['artifact:v1:one'],
    },
  ];
  return {
    session: {
      id: DELIVERY_IDENTITY.sessionId,
      revision: 1,
    },
    summary: {
      id: DELIVERY_IDENTITY.sessionId,
      title: 'Protocol fixture',
      createdAt: 1,
      updatedAt: 2,
    },
    turnAttemptId: DELIVERY_IDENTITY.turnAttemptId,
    idempotent: false,
    appliedRevision: 1,
    digest: `asd:v1:${'a'.repeat(43)}`,
    launchDigest: `asl:v1:${'b'.repeat(43)}`,
    outcome: {
      reason: 'final_answer',
      changed: false,
      changedCount: 0,
      writeSettlement: 'none',
    },
    transcript: {
      sessionId: DELIVERY_IDENTITY.sessionId,
      messages: transcriptMessages,
      nextBeforeSequence: null,
    },
    presentationMessages: [
      {
        sequence: 1,
        id: 'message-user-1',
        role: 'user',
        content: 'Inspect the protocol.',
        createdAt: 1,
      },
      {
        sequence: 2,
        id: 'message-agent-1',
        role: 'agent',
        content: '',
        createdAt: 2,
      },
    ],
  };
}

const VALID_EVENT_PAYLOADS: readonly Record<string, unknown>[] = [
  { type: 'agent_queued' },
  {
    type: 'conversation_bound',
    binding: {
      version: 1,
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repository',
      },
      scopeFingerprint: `fs:v1:${'a'.repeat(43)}`,
      label: 'owner/repository',
      count: 1,
      providerFingerprint: `pcf:v1:${'b'.repeat(43)}`,
    },
  },
  { type: 'agent_start' },
  { type: 'turn_start', step: 0 },
  { type: 'assistant_stream_start', step: 0 },
  { type: 'assistant_text_delta', step: 0, delta: 'Hello' },
  {
    type: 'message_update',
    message: {
      id: 'message-live-user',
      role: 'user',
      content: 'Hello',
      createdAt: 1,
    },
  },
  { type: 'tool_execution_queued', toolName: 'inspect', callId: 'call-1' },
  { type: 'tool_execution_start', toolName: 'inspect', callId: 'call-1', risk: 'read' },
  {
    type: 'tool_execution_end',
    toolName: 'inspect',
    callId: 'call-1',
    risk: 'read',
    ok: true,
    writeOutcome: 'not_applicable',
  },
  { type: 'approval_required', callId: 'call-1', summary: 'Approve this write.' },
  { type: 'context_compaction_start' },
  {
    type: 'context_diagnostic',
    stage: 'tool_allowance',
    providerWindow: 128_000,
    workingWindow: 96_000,
    softLimit: 80_000,
    hardLimit: 90_000,
    capabilitySource: 'provider-verified',
    capabilityRevision: 'capability:v1',
    policyRevision: 'policy:v1',
    inputTokens: 1_000,
    deterministicInputTokens: 900,
    usageAdjustmentTokens: 100,
    observedPrefixTokens: null,
    contextRemainingTokens: 95_000,
    toolAllowanceBytes: 32_000,
    toolMemoryRemainingBytes: 64_000,
    toolProviderResultCeilingBytes: 48_000,
    toolBudgetLimitedBy: 'multiple',
    toolResultBytes: 1_024,
    toolResultReduced: false,
    action: 'triggered',
    trigger: 'tool_result_memory_pressure',
    category: 'succeeded',
  },
  { type: 'context_compaction_end', ok: true, summarizedMessageCount: 4 },
  { type: 'agent_error', message: 'Bounded failure.', category: 'provider' },
  { type: 'agent_done', reason: 'context_limit', contextFailureReason: 'no_candidate' },
];

describe('Agent turn protocol', () => {
  it.each([
    {
      type: 'startBgsmAgentTurn',
      executionEpochId: EXECUTION_EPOCH_ID,
      ...DELIVERY_IDENTITY,
      prompt: 'Inspect the turn.',
      retrySourceAttemptId: 'turn-attempt-0',
      candidateContract: {
        kind: 'selected_repository',
        selectedRepositoryIdHint: 'owner/repository',
      },
      resumeOnly: true,
    },
    {
      type: 'stopBgsmAgentTurn',
      executionEpochId: EXECUTION_EPOCH_ID,
      ...DELIVERY_IDENTITY,
    },
    ...(['applied', 'no_transition', 'transition_rejected', 'detached'] as const).map(
      (disposition) => ({
        type: 'ackBgsmAgentTurnResult',
        executionEpochId: EXECUTION_EPOCH_ID,
        ...DELIVERY_IDENTITY,
        disposition,
        appliedRevision: disposition === 'applied' ? 1 : null,
      }),
    ),
  ])('accepts client discriminant $type and returns the original object', (message) => {
    expect(parseBgsmAgentTurnClientMessage(message)).toBe(message);
  });

  it.each([
    { type: 'bgsmAgentTurnHello', executionEpochId: EXECUTION_EPOCH_ID },
    {
      type: 'bgsmAgentTurnAck',
      ...DELIVERY_IDENTITY,
      disposition: 'applied',
      appliedRevision: 1,
    },
    serverEvent({ type: 'agent_queued' }),
    { type: 'bgsmAgentTurnResult', sequence: 0, result: result() },
    {
      type: 'bgsmAgentTurnError',
      sequence: 0,
      error: {
        ...DELIVERY_IDENTITY,
        message: 'Typed failure.',
        category: 'other',
        code: AGENT_ATTEMPT_STATE_LOST_ERROR_CODE,
      },
    },
  ])('accepts server discriminant $type and returns the original object', (message) => {
    expect(parseBgsmAgentTurnServerMessage(message)).toBe(message);
  });

  it.each(VALID_EVENT_PAYLOADS)('accepts nested event discriminant $type', (payload) => {
    const message = serverEvent(payload);
    expect(parseBgsmAgentTurnServerMessage(message)).toBe(message);
  });

  it.each([
    [AGENT_ATTEMPT_STATE_LOST_ERROR_CODE],
    [AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE],
  ])('round-trips named bounded error code %s', (code) => {
    expect(AGENT_TURN_ERROR_CODES).toContain(code);
    expect(parseAgentTurnErrorCode(code)).toBe(code);
    expect(normalizeAgentTurnErrorCode({ code })).toBe(code);

    const message = {
      type: 'bgsmAgentTurnError',
      sequence: 0,
      error: { ...DELIVERY_IDENTITY, message: 'Bounded failure.', code },
    };
    expect(parseBgsmAgentTurnServerMessage(message)).toBe(message);
  });

  it('normalizes native quota errors and rejects unknown error codes', () => {
    expect(normalizeAgentTurnErrorCode({ name: 'QuotaExceededError' }))
      .toBe('agent_session_quota_exceeded');
    expect(parseAgentTurnErrorCode('agent_unbounded_unknown_code')).toBeNull();
    expect(normalizeAgentTurnErrorCode({ code: 'agent_unbounded_unknown_code' })).toBeUndefined();
    expect(() => parseBgsmAgentTurnServerMessage({
      type: 'bgsmAgentTurnError',
      sequence: 0,
      error: {
        ...DELIVERY_IDENTITY,
        message: 'Unbounded failure.',
        code: 'agent_unbounded_unknown_code',
      },
    })).toThrow(TypeError);
  });

  it.each([
    [{ type: 'bgsmAgentTurnHello' }],
    [{ type: 'bgsmAgentTurnHello', executionEpochId: EXECUTION_EPOCH_ID, extra: true }],
    [{ ...serverEvent({ type: 'agent_queued' }), sequence: undefined }],
    [{ ...serverEvent({ type: 'agent_queued' }), extra: true }],
    [{
      type: 'stopBgsmAgentTurn',
      executionEpochId: EXECUTION_EPOCH_ID,
      ...DELIVERY_IDENTITY,
      extra: true,
    }],
    [{
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: EXECUTION_EPOCH_ID,
      ...DELIVERY_IDENTITY,
      disposition: 'detached',
    }],
  ])('rejects missing or extra exact keys', (message) => {
    const parser = String((message as Record<string, unknown>).type).startsWith('bgsm')
      ? parseBgsmAgentTurnServerMessage
      : parseBgsmAgentTurnClientMessage;
    expect(() => parser(message)).toThrow(TypeError);
  });

  it.each([
    { executionEpochId: '' },
    { executionEpochId: ' worker ' },
    { turnAttemptId: '' },
    { turnAttemptId: 'x'.repeat(513) },
    { sessionId: ' session ' },
    { baseRevision: -1 },
    { baseRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid client identity coordinates %#', (override) => {
    const turnAttemptId = 'turnAttemptId' in override ? override.turnAttemptId : undefined;
    expect(() => parseBgsmAgentTurnClientMessage({
      type: 'stopBgsmAgentTurn',
      executionEpochId: EXECUTION_EPOCH_ID,
      ...DELIVERY_IDENTITY,
      ...override,
    })).toThrow(turnAttemptId?.length === 513 ? RangeError : TypeError);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid server sequence %s',
    (sequence) => {
      expect(() => parseBgsmAgentTurnServerMessage(
        serverEvent({ type: 'agent_queued' }, sequence),
      )).toThrow(TypeError);
    },
  );

  it.each([
    ['applied', null],
    ['applied', 0],
    ['no_transition', 1],
    ['transition_rejected', 1],
    ['detached', 1],
    ['unknown', null],
  ])('rejects acknowledgement cross-field pair %s/%s', (disposition, appliedRevision) => {
    expect(() => parseBgsmAgentTurnClientMessage({
      type: 'ackBgsmAgentTurnResult',
      executionEpochId: EXECUTION_EPOCH_ID,
      ...DELIVERY_IDENTITY,
      disposition,
      appliedRevision,
    })).toThrow(TypeError);
    expect(() => parseBgsmAgentTurnServerMessage({
      type: 'bgsmAgentTurnAck',
      ...DELIVERY_IDENTITY,
      disposition,
      appliedRevision,
    })).toThrow(TypeError);
  });

  it('distinguishes structural failures from byte-limit failures', () => {
    expect(() => parseBgsmAgentTurnClientMessage({
      type: 'startBgsmAgentTurn',
      executionEpochId: EXECUTION_EPOCH_ID,
      ...DELIVERY_IDENTITY,
      prompt: '',
    })).toThrow(TypeError);
    expect(() => parseBgsmAgentTurnClientMessage({
      type: 'startBgsmAgentTurn',
      executionEpochId: EXECUTION_EPOCH_ID,
      ...DELIVERY_IDENTITY,
      prompt: 'x'.repeat(BGSM_AGENT_PROMPT_MAX_BYTES + 1),
    })).toThrow(RangeError);

    const oversizedCommit = commit();
    const chunk = 'x'.repeat(512 * 1024);
    oversizedCommit.transcript.messages = Array.from({ length: 17 }, (_, index) => ({
      sequence: index + 1,
      id: `oversized-${index}`,
      role: 'user',
      content: chunk,
      createdAt: index + 1,
    }));
    const message = {
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: result(oversizedCommit),
    };
    expect(JSON.stringify(message).length).toBeGreaterThan(AGENT_SESSION_TURN_TRANSPORT_MAX_BYTES);
    expect(() => parseBgsmAgentTurnServerMessage(message)).toThrow(RangeError);
  });

  it('accepts a real durable commit with tool calls and opaque references', () => {
    const message = {
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: result(commit()),
    };
    expect(parseBgsmAgentTurnServerMessage(message)).toBe(message);
  });

  it.each([
    ['event exact keys', serverEvent({ type: 'agent_queued', extra: true })],
    ['event risk/outcome agreement', serverEvent({
      type: 'tool_execution_end',
      toolName: 'write',
      callId: 'call-1',
      risk: 'write',
      ok: true,
      writeOutcome: 'not_applicable',
    })],
    ['live message cannot claim a durable sequence', serverEvent({
      type: 'message_update',
      message: {
        sequence: 1,
        id: 'message-live',
        role: 'user',
        content: 'Not yet durable.',
        createdAt: 1,
      },
    })],
    ['context diagnostic enum', serverEvent({
      type: 'context_diagnostic',
      stage: 'invalid',
      providerWindow: 1,
      workingWindow: 1,
      softLimit: 1,
      hardLimit: 1,
      capabilitySource: 'provider-verified',
      capabilityRevision: 'capability:v1',
      policyRevision: 'policy:v1',
    })],
    ['context failure requires a context-limit event', serverEvent({
      type: 'agent_done',
      reason: 'provider_error',
      contextFailureReason: 'no_candidate',
    })],
    ['context-limit event requires a failure reason', serverEvent({
      type: 'agent_done',
      reason: 'context_limit',
    })],
  ])('rejects invalid nested event payload: %s', (_label, message) => {
    expect(() => parseBgsmAgentTurnServerMessage(message)).toThrow(TypeError);
  });

  it('rejects duplicate opaque references in nested tool rows', () => {
    const invalidCommit = commit();
    const toolMessage = invalidCommit.transcript.messages[2];
    if (!toolMessage || toolMessage.role !== 'tool') throw new Error('Fixture tool row is missing.');
    toolMessage.opaqueReferences = ['artifact:v1:duplicate', 'artifact:v1:duplicate'];
    expect(() => parseBgsmAgentTurnServerMessage({
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: result(invalidCommit),
    })).toThrow(TypeError);
  });

  it.each([
    ['changed count agreement', { ...result(), changed: true }],
    ['handoff requires commit', {
      ...result(),
      organizeLibraryHandoff: {
        type: 'organize_whole_library',
        action: 'request_confirmation',
        instruction: 'Organize everything.',
      },
    }],
    ['commit attempt identity', (() => {
      const invalid = commit();
      Reflect.set(invalid, 'turnAttemptId', 'another-attempt');
      return result(invalid);
    })()],
    ['commit digest', (() => {
      const invalid = commit();
      invalid.digest = 'invalid';
      return result(invalid);
    })()],
    ['terminal outcome agreement', (() => {
      const invalid = commit();
      invalid.outcome.reason = 'aborted';
      return result(invalid);
    })()],
    ['context failure requires a context-limit result', {
      ...result(),
      reason: 'provider_error',
      contextFailureReason: 'no_candidate',
    }],
    ['context-limit result requires a failure reason', {
      ...result(),
      reason: 'context_limit',
    }],
  ])('rejects invalid nested result or commit: %s', (_label, invalidResult) => {
    expect(() => parseBgsmAgentTurnServerMessage({
      type: 'bgsmAgentTurnResult',
      sequence: 0,
      result: invalidResult,
    })).toThrow(TypeError);
  });

  it.each([
    [{ ...DELIVERY_IDENTITY, message: '' }, TypeError],
    [{ ...DELIVERY_IDENTITY, message: 'x'.repeat(4_097) }, RangeError],
    [{ ...DELIVERY_IDENTITY, message: 'Failure.', category: 'unknown' }, TypeError],
    [{ ...DELIVERY_IDENTITY, message: 'Failure.', extra: true }, TypeError],
  ])('rejects invalid nested error payload %#', (error, ErrorConstructor) => {
    expect(() => parseBgsmAgentTurnServerMessage({
      type: 'bgsmAgentTurnError',
      sequence: 0,
      error,
    })).toThrow(ErrorConstructor);
  });
});
