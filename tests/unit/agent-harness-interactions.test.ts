import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import {
  MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES,
  MAX_PROVIDER_HISTORY_BYTES,
  MAX_SUSPENDED_TOOL_RESULT_MEMORY_BYTES,
  MAX_TOOL_RESULT_BYTES,
  ProtocolValidationError,
  SuspendedTurnValidationError,
  constructSuspendedTurn,
  parseCandidateSetToken,
  errorToolResult,
  finalizeToolResult,
  fingerprintHistory,
  okToolResult,
  runAgentLoop,
  serializeBoundedToolResult,
  serializedToolResultByteLength,
  settleSuspendedTurn,
  transitionSuspendedTurnPhase,
  validateProviderProtocolHistory,
  validateSerializedResult,
  validateSuspendedTurn,
  type AgentMessage,
  type AgentInteractionTool,
  type AgentTool,
  type ConstructSuspendedTurnInput,
  type ModelMessage,
  type SuspendedTurn,
  type ToolResult,
} from '../../src/agent-harness/index.ts';

const encoder = new TextEncoder();

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

function sequentialIdFactory(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function exactSuccess(targetBytes: number, character = 'x'): ToolResult {
  const overhead = encoder.encode(JSON.stringify(okToolResult({ payload: '' }))).byteLength;
  const characterBytes = encoder.encode(character).byteLength;
  const available = targetBytes - overhead;
  const repetitions = Math.floor(available / characterBytes);
  return okToolResult({
    payload: character.repeat(repetitions) + 'x'.repeat(available - repetitions * characterBytes),
  });
}

function calls() {
  return [0, 1, 2].map((index) => ({
    index,
    id: `call-${index}`,
    name: `tool_${index}`,
    arguments: { index },
  }));
}

function checkpointInput(pendingIndex: number): ConstructSuspendedTurnInput {
  const toolCalls = calls();
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    generation: 7,
    interactionId: 'interaction-1',
    interactionKind: 'scope_selector',
    appPayload: {
      version: 1,
      task: 'prepare_scope_branch',
      candidateSetToken: parseCandidateSetToken('candidate:v1:opaque'),
    },
    assistantEnvelope: {
      messageId: 'assistant-envelope-1',
      content: 'Preparing a scope.',
      createdAt: 20,
      finishReason: 'tool_calls',
      toolCalls,
    },
    completedPrefix: toolCalls.slice(0, pendingIndex).map((call) => ({
      index: call.index,
      messageId: `result-message-${call.index}`,
      callId: call.id,
      toolName: call.name,
      serializedResult: serializeBoundedToolResult(okToolResult({ index: call.index })).serialized,
      createdAt: 21 + call.index,
    })),
    pendingIndex,
    remainingStepBudget: 3,
    priorHistory: [{ role: 'user', content: 'Organize these repositories.' }],
    createdAt: 30,
  };
}

function settlementMessageIds(checkpoint: SuspendedTurn) {
  return checkpoint.assistantEnvelope.toolCalls
    .slice(checkpoint.pendingIndex)
    .map((call) => ({ messageId: `settled-message-${call.index}`, createdAt: 40 + call.index }));
}

describe('canonical bounded tool results', () => {
  it('preserves a generic success exactly at 65536 UTF-8 bytes and replaces one byte over', () => {
    const exact = serializeBoundedToolResult(exactSuccess(MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES));
    const plusOne = serializeBoundedToolResult(
      exactSuccess(MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES + 1),
    );

    assert.equal(exact.byteLength, MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES);
    assert.equal(exact.serialized, JSON.stringify(exact.result));
    assert.equal(exact.result.ok, true);
    assert.equal(plusOne.byteLength <= MAX_GENERIC_TOOL_ERROR_RESULT_BYTES, true);
    assert.equal(plusOne.result.ok, false);
    assert.equal(
      (plusOne.result as { ok: false; error: { code: string } }).error.code,
      'tool_result_too_large',
    );
  });

  it('measures CJK, emoji, and combining sequences by TextEncoder bytes', () => {
    for (const character of ['界', '😀', 'e\u0301']) {
      const exact = serializeBoundedToolResult(
        exactSuccess(MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES, character),
      );
      assert.equal(exact.byteLength, MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES);
      assert.equal(encoder.encode(exact.serialized).byteLength, exact.byteLength);
      assert.equal(exact.serialized.length <= exact.byteLength, true);
    }
  });

  it('uses bounded static serialization failures for cyclic, BigInt, and throwing toJSON data', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const values = [
      cyclic,
      1n,
      { toJSON() { throw new Error('secret serialization detail'); } },
    ];
    for (const value of values) {
      const finalized = serializeBoundedToolResult(okToolResult(value));
      assert.equal(finalized.result.ok, false);
      assert.equal(
        (finalized.result as { ok: false; error: { code: string } }).error.code,
        'tool_result_serialization_failed',
      );
      assert.equal(finalized.byteLength <= MAX_GENERIC_TOOL_ERROR_RESULT_BYTES, true);
      assert.doesNotThrow(() => JSON.parse(finalized.serialized));
    }
  });

  it('keeps static fallbacks within the hard ceiling when ordinary error limits are lower', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const serializationFailure = serializeBoundedToolResult(okToolResult(cyclic), {
      errorBytes: 1,
    });
    const tooLarge = serializeBoundedToolResult(exactSuccess(200), {
      successBytes: 1,
      errorBytes: 1,
    });
    for (const result of [serializationFailure, tooLarge]) {
      assert.equal(result.result.ok, false);
      assert.equal(result.byteLength <= MAX_GENERIC_TOOL_ERROR_RESULT_BYTES, true);
      assert.doesNotThrow(() => JSON.parse(result.serialized));
    }
    assert.equal(
      (serializationFailure.result as { ok: false; error: { code: string } }).error.code,
      'tool_result_serialization_failed',
    );
    assert.equal(
      (tooLarge.result as { ok: false; error: { code: string } }).error.code,
      'tool_result_too_large',
    );
  });

  it('bounds dynamic error details and keeps the old 8KiB adapter fallback contract', () => {
    const error = serializeBoundedToolResult(errorToolResult('bad'.repeat(100), '界'.repeat(10_000)));
    assert.equal(error.byteLength <= MAX_GENERIC_TOOL_ERROR_RESULT_BYTES, true);
    assert.equal(error.serialized, JSON.stringify(error.result));

    const strict = finalizeToolResult(exactSuccess(MAX_TOOL_RESULT_BYTES + 1), 0);
    assert.equal(strict.result.ok, false);
    assert.equal(
      (strict.result as { ok: false; error: { code: string } }).error.code,
      'tool_output_too_large',
    );
    assert.equal(strict.byteLength <= MAX_TOOL_RESULT_BYTES, true);
  });

  it('keeps raw sizing distinct from bounded fallback serialization', () => {
    const raw = exactSuccess(MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES + 1);
    assert.equal(serializedToolResultByteLength(raw), MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES + 1);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    assert.throws(() => serializedToolResultByteLength(okToolResult(cyclic)));
  });
});

describe('provider protocol history validation', () => {
  const assistant: ModelMessage = {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call-a', name: 'read_a', arguments: {} },
      { id: 'call-b', name: 'read_b', arguments: {} },
    ],
  };
  const resultA: ModelMessage = {
    role: 'tool',
    content: '{"ok":true,"data":{}}',
    toolCallId: 'call-a',
    toolName: 'read_a',
  };
  const resultB: ModelMessage = {
    role: 'tool',
    content: '{"ok":false,"error":{"code":"x","message":"y"}}',
    toolCallId: 'call-b',
    toolName: 'read_b',
  };

  it('accepts complete exact ordered multi-call history unchanged', () => {
    const history = [{ role: 'user', content: 'read' }, assistant, resultA, resultB] as ModelMessage[];
    assert.doesNotThrow(() => validateProviderProtocolHistory(history));
    assert.deepEqual(history[1], assistant);
  });

  it('rejects orphan, duplicate, missing, mismatched, out-of-order, and intervening results', () => {
    const malformed: ModelMessage[][] = [
      [resultA],
      [assistant, resultA, resultA],
      [assistant, resultA],
      [assistant, { ...resultA, toolCallId: 'wrong' }, resultB],
      [assistant, resultB, resultA],
      [assistant, { role: 'user', content: 'intervening' }, resultA, resultB],
    ];
    for (const history of malformed) {
      assert.throws(
        () => validateProviderProtocolHistory(history),
        (error: unknown) => error instanceof ProtocolValidationError && error.code === 'protocol_error',
      );
    }
  });

  it('rejects globally reused, empty, whitespace-padded, and duplicate envelope call IDs', () => {
    const prior = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read', arguments: {} }] },
      { role: 'tool', content: '{"ok":true,"data":{}}', toolCallId: 'old', toolName: 'read' },
    ] as ModelMessage[];
    const badCalls = ['old', '', ' padded '].map((id) => [
      ...prior,
      { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: {} }] },
    ] as ModelMessage[]);
    badCalls.push([{
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'same', name: 'read', arguments: {} },
        { id: 'same', name: 'read', arguments: {} },
      ],
    }]);
    badCalls.push([
      ...prior,
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read', arguments: {} }] },
      { role: 'tool', content: '{"ok":true,"data":{}}', toolCallId: 'old', toolName: 'read' },
    ]);
    for (const history of badCalls) assert.throws(() => validateProviderProtocolHistory(history));
  });

  it('requires the complete ToolResult envelope schema and bounded valid JSON', () => {
    for (const content of [
      '',
      'not-json',
      '{}',
      '{"ok":true}',
      '{"ok":true,"data":{},"extra":1}',
      '{"ok":false,"error":{"code":"x"}}',
      '{"ok":false,"error":{"code":"x","message":"y","extra":1}}',
    ]) assert.throws(() => validateSerializedResult(content));
  });

  it('preflights malformed input before every provider invocation and malformed output before tools', async () => {
    let providerCalls = 0;
    const malformedInput: AgentMessage[] = [{
      id: 'orphan',
      role: 'tool',
      content: '{"ok":true,"data":{}}',
      createdAt: 1,
      toolCallId: 'missing',
      toolName: 'missing',
    }];
    const inputResult = await runAgentLoop({
      sessionId: 'protocol-input',
      messages: malformedInput,
      tools: [],
      provider: { async generate() { providerCalls++; return { content: 'no' }; } },
    });
    assert.equal(inputResult.reason, 'protocol_error');
    assert.equal(providerCalls, 0);

    let toolCalls = 0;
    const outputResult = await runAgentLoop({
      sessionId: 'protocol-output',
      messages: [{ id: 'u', role: 'user', content: 'read', createdAt: 1 }],
      tools: [{
        name: 'read',
        description: 'read',
        risk: 'read',
        async execute() { toolCalls++; return {}; },
      }],
      provider: {
        async generate() {
          providerCalls++;
          return { toolCalls: [
            { id: 'duplicate', name: 'read', arguments: {} },
            { id: 'duplicate', name: 'read', arguments: {} },
          ] };
        },
      },
    });
    assert.equal(outputResult.reason, 'protocol_error');
    assert.equal(toolCalls, 0);
    assert.equal(providerCalls, 1);
  });
});

describe('pure sealed SuspendedTurn operations', () => {
  it('constructs first, middle, and last checkpoints with exact envelope/prefix/sibling invariants', async () => {
    for (const pendingIndex of [0, 1, 2]) {
      const input = checkpointInput(pendingIndex);
      const checkpoint = await constructSuspendedTurn(input);
      assert.equal(checkpoint.phase, 'pending');
      assert.equal(checkpoint.completedPrefix.length, pendingIndex);
      assert.deepEqual(checkpoint.siblings, checkpoint.assistantEnvelope.toolCalls.slice(pendingIndex + 1));
      assert.equal(checkpoint.historySnapshot.length, 2 + pendingIndex);
      assert.equal(checkpoint.remainingStepBudget, 3);
      assert.match(checkpoint.historyFingerprint, /^hf:v1:[A-Za-z0-9_-]{43}$/u);
      await assert.doesNotReject(() => validateSuspendedTurn(checkpoint));
    }
  });

  it('keeps suspended-turn structure valid when prior raw history exceeds Provider bytes', async () => {
    const input = checkpointInput(0);
    const priorHistory: ModelMessage[] = [
      { role: 'user', content: 'x'.repeat(270 * 1024) },
      { role: 'assistant', content: 'y'.repeat(270 * 1024) },
    ];
    assert.ok(encoder.encode(JSON.stringify(priorHistory)).byteLength > MAX_PROVIDER_HISTORY_BYTES);

    const pending = await constructSuspendedTurn({ ...input, priorHistory });
    await assert.doesNotReject(() => validateSuspendedTurn(pending));
    const resuming = transitionSuspendedTurnPhase(pending, 'resuming');
    const settled = settleSuspendedTurn(resuming, {
      kind: 'resumed',
      result: okToolResult({ preparedRunId: 'child-run', count: 4 }),
      resultMessages: settlementMessageIds(resuming),
    });

    assert.equal(settled.continueProvider, true);
    assert.ok(encoder.encode(JSON.stringify(settled.history)).byteLength > MAX_PROVIDER_HISTORY_BYTES);
  });

  it('uses controller values verbatim, rejects model-shaped app payload extras, and trims no IDs', async () => {
    const checkpoint = await constructSuspendedTurn(checkpointInput(1));
    assert.equal(checkpoint.createdAt, 30);
    assert.equal(checkpoint.interactionId, 'interaction-1');
    assert.equal(checkpoint.appPayload.candidateSetToken, 'candidate:v1:opaque');

    const base = checkpointInput(1);
    const extraPayload = {
      ...base,
      appPayload: { ...base.appPayload, label: '<model markup>' },
    } as unknown as ConstructSuspendedTurnInput;
    await assert.rejects(() => constructSuspendedTurn(extraPayload), SuspendedTurnValidationError);
    await assert.rejects(
      () => constructSuspendedTurn({ ...checkpointInput(1), interactionId: ' padded ' }),
      SuspendedTurnValidationError,
    );
    await assert.rejects(
      () => constructSuspendedTurn({ ...checkpointInput(1), interactionId: 'run-1' }),
      SuspendedTurnValidationError,
    );
  });

  it('deep-freezes replacement data and fingerprints canonical history deterministically', async () => {
    const first = await constructSuspendedTurn(checkpointInput(1));
    const second = await constructSuspendedTurn(checkpointInput(1));
    assert.equal(first.historyFingerprint, second.historyFingerprint);
    assert.equal(first.historyFingerprint, await fingerprintHistory(first.historySnapshot));
    assert.equal(
      await fingerprintHistory([]),
      'hf:v1:T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU',
    );
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.assistantEnvelope.toolCalls), true);
    assert.throws(() => {
      (first.assistantEnvelope.toolCalls as unknown as Array<{ id: string }>)[0].id = 'changed';
    });
    assert.equal(first.assistantEnvelope.toolCalls[0].id, 'call-0');

    const changedBase = checkpointInput(1);
    const changed: ConstructSuspendedTurnInput = {
      ...changedBase,
      assistantEnvelope: {
      ...changedBase.assistantEnvelope,
      toolCalls: changedBase.assistantEnvelope.toolCalls.map((call) =>
        call.index === 2 ? { ...call, arguments: { index: 99 } } : call),
      },
    };
    assert.notEqual(
      (await constructSuspendedTurn(changed)).historyFingerprint,
      first.historyFingerprint,
    );
  });

  it('canonicalizes sparse arrays as dense null entries for cloning and fingerprints', async () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = 'value';
    const dense = [null, 'value'];
    const sparseHistory: ModelMessage[] = [{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'sparse-call', name: 'read', arguments: { values: sparse } }],
    }];
    const denseHistory: ModelMessage[] = [{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'sparse-call', name: 'read', arguments: { values: dense } }],
    }];
    assert.equal(await fingerprintHistory(sparseHistory), await fingerprintHistory(denseHistory));

    const base = checkpointInput(0);
    const checkpoint = await constructSuspendedTurn({
      ...base,
      assistantEnvelope: {
        ...base.assistantEnvelope,
        toolCalls: base.assistantEnvelope.toolCalls.map((call, index) =>
          index === 0 ? { ...call, arguments: { values: sparse } } : call),
      },
    });
    const clonedValues = (checkpoint.assistantEnvelope.toolCalls[0].arguments as {
      values: unknown[];
    }).values;
    assert.equal(0 in clonedValues, true);
    assert.deepEqual(clonedValues, dense);
  });

  it('rejects malformed checkpoint structure, fingerprint, and cross-envelope message IDs', async () => {
    const checkpoint = await constructSuspendedTurn(checkpointInput(1));
    for (const malformed of [
      { ...checkpoint, pendingIndex: 2 },
      { ...checkpoint, siblings: [] },
      { ...checkpoint, historyFingerprint: 'hf:v1:forged' },
      {
        ...checkpoint,
        completedPrefix: [{ ...checkpoint.completedPrefix[0], messageId: checkpoint.assistantEnvelope.messageId }],
      },
      { ...checkpoint, interactionKind: 'other_kind' as 'scope_selector' },
    ] as SuspendedTurn[]) {
      await assert.rejects(() => validateSuspendedTurn(malformed), SuspendedTurnValidationError);
    }
  });

  it('settles resumed first/middle/last interactions with real prefix and exact ordered siblings', async () => {
    for (const pendingIndex of [0, 1, 2]) {
      const pending = await constructSuspendedTurn(checkpointInput(pendingIndex));
      const resuming = transitionSuspendedTurnPhase(pending, 'resuming');
      const settled = settleSuspendedTurn(resuming, {
        kind: 'resumed',
        result: okToolResult({ preparedRunId: 'child-run', count: 4 }),
        resultMessages: settlementMessageIds(resuming),
      });
      assert.equal(settled.continueProvider, true);
      assert.equal(settled.remainingStepBudget, 3);
      assert.deepEqual(
        settled.completedResults.slice(0, pendingIndex),
        pending.completedPrefix,
      );
      assert.equal(settled.completedResults.length, 3);
      assert.deepEqual(
        settled.completedResults.map((entry) => entry.index),
        [0, 1, 2],
      );
      assert.equal(
        JSON.parse(settled.completedResults[pendingIndex].serializedResult).ok,
        true,
      );
      for (const sibling of settled.completedResults.slice(pendingIndex + 1)) {
        assert.equal(JSON.parse(sibling.serializedResult).error.code, 'not_executed_due_to_interaction');
      }
      assert.doesNotThrow(() => validateProviderProtocolHistory(settled.history));
      assert.deepEqual(
        settled.messages.map((message) => message.id),
        [
          'assistant-envelope-1',
          ...[0, 1, 2].map((index) => index < pendingIndex
            ? `result-message-${index}`
            : `settled-message-${index}`),
        ],
      );
    }
  });

  it('settles cancellation, approval, and orderly abort without provider continuation', async () => {
    const cases = [
      ['cancelled', 'interaction_cancelled', 'not_executed_due_to_cancel'],
      ['approval_required', 'approval_required', 'not_executed_due_to_approval'],
      ['aborted', 'tool_execution_aborted', 'not_executed_due_to_abort'],
    ] as const;
    for (const [kind, currentCode, siblingCode] of cases) {
      const pending = await constructSuspendedTurn(checkpointInput(1));
      const checkpoint = kind === 'cancelled'
        ? transitionSuspendedTurnPhase(pending, 'cancelled')
        : pending;
      const settled = settleSuspendedTurn(checkpoint, {
        kind,
        resultMessages: settlementMessageIds(checkpoint),
      });
      assert.equal(settled.continueProvider, false);
      assert.equal(JSON.parse(settled.completedResults[1].serializedResult).error.code, currentCode);
      assert.equal(JSON.parse(settled.completedResults[2].serializedResult).error.code, siblingCode);
      assert.equal(settled.completedResults.every((entry) => {
        const bytes = encoder.encode(entry.serializedResult).byteLength;
        return bytes > 0 && bytes <= MAX_GENERIC_TOOL_ERROR_RESULT_BYTES;
      }), true);
    }
  });

  it('returns no partial settlement for invalid identities or phases', async () => {
    const pending = await constructSuspendedTurn(checkpointInput(1));
    assert.throws(() => settleSuspendedTurn(pending, {
      kind: 'resumed',
      result: okToolResult({}),
      resultMessages: settlementMessageIds(pending),
    }), SuspendedTurnValidationError);
    const cancelled = transitionSuspendedTurnPhase(pending, 'cancelled');
    assert.throws(() => settleSuspendedTurn(cancelled, {
      kind: 'cancelled',
      resultMessages: [
        { messageId: pending.assistantEnvelope.messageId, createdAt: 40 },
        { messageId: 'other', createdAt: 41 },
      ],
    }), SuspendedTurnValidationError);
    for (const kind of ['approval_required', 'aborted'] as const) {
      assert.throws(() => settleSuspendedTurn(cancelled, {
        kind,
        resultMessages: settlementMessageIds(cancelled),
      }), SuspendedTurnValidationError);
    }
    const resuming = transitionSuspendedTurnPhase(
      await constructSuspendedTurn(checkpointInput(1)),
      'resuming',
    );
    assert.throws(() => settleSuspendedTurn(resuming, {
      kind: 'cancelled',
      resultMessages: settlementMessageIds(resuming),
    }), SuspendedTurnValidationError);
    assert.throws(
      () => transitionSuspendedTurnPhase(pending, 'pending' as never),
      SuspendedTurnValidationError,
    );
    assert.throws(
      () => transitionSuspendedTurnPhase(pending, 'arbitrary' as never),
      SuspendedTurnValidationError,
    );
  });

  it('keeps sealed phase replacement and settlement digest-free for later synchronous CAS', async () => {
    const pending = await constructSuspendedTurn(checkpointInput(1));
    const alreadySealed = {
      ...pending,
      historyFingerprint: `hf:v1:${'A'.repeat(43)}`,
    } as SuspendedTurn;
    const resuming = transitionSuspendedTurnPhase(alreadySealed, 'resuming');
    const settled = settleSuspendedTurn(resuming, {
      kind: 'resumed',
      result: okToolResult({ prepared: true }),
      resultMessages: settlementMessageIds(resuming),
    });
    assert.equal(settled.continueProvider, true);
    await assert.rejects(() => validateSuspendedTurn(alreadySealed), SuspendedTurnValidationError);
  });

  it('has no checkpoint slot, I/O, BGSM, background, storage, or UI dependency', () => {
    const source = readFileSync(
      new URL('../../src/agent-harness/suspended-turn.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /@\/bgsm-agent|background|storage|indexeddb|chrome\.|AgentPanel/u);
    assert.doesNotMatch(source, /checkpointSlot|pendingCheckpoint|localStorage|sessionStorage/u);
  });
});

describe('agent-loop suspend and orderly settlement surface', () => {
  const user: AgentMessage = { id: 'user-1', role: 'user', content: 'choose scope', createdAt: 1 };

  it('surfaces a private suspension candidate without a result/slot and preserves maxSteps', async () => {
    let providerCalls = 0;
    const events: string[] = [];
    const tool: AgentInteractionTool<{ index: number }, { observed: number }> = {
      name: 'scope_selector',
      description: 'prepare a scope branch',
      risk: 'read',
      interaction: {
        interactionKind: 'scope_selector',
        task: 'prepare_scope_branch',
      },
      validate(value) { return value as { index: number }; },
      async execute(args) {
        return args.index === 1
          ? { type: 'suspend', interactionKind: 'scope_selector', task: 'prepare_scope_branch' }
          : { observed: args.index };
      },
    };
    const result = await runAgentLoop({
      sessionId: 'suspend-loop',
      messages: [user],
      tools: [tool],
      provider: {
        async generate() {
          providerCalls++;
          return {
            finishReason: 'tool_calls',
            toolCalls: [0, 1, 2].map((index) => ({
              id: `scope-call-${index}`,
              name: 'scope_selector',
              arguments: { index },
            })),
          };
        },
      },
      maxSteps: 4,
      idFactory: (() => { let id = 0; return () => `message-${++id}`; })(),
      now: () => 10,
      emit: (event) => events.push(event.type),
    });

    assert.equal(result.reason, 'interaction_required');
    assert.equal(providerCalls, 1);
    assert.ok(result.suspension);
    assert.equal(result.suspension.pendingIndex, 1);
    assert.equal(result.suspension.completedPrefix.length, 1);
    assert.equal(result.suspension.remainingStepBudget, 3);
    assert.deepEqual(result.messages, [user]);
    assert.equal('appPayload' in result.suspension, false);
    assert.equal('interactionId' in result.suspension, false);
    assert.equal(events.includes('message_update'), false);
    assert.equal(events.includes('agent_done'), false);
  });

  it('carries the settled interaction envelope into the resumed raw transcript', async () => {
    const tool: AgentInteractionTool = {
      name: 'scope_selector',
      description: 'prepare a scope branch',
      risk: 'read',
      interaction: {
        interactionKind: 'scope_selector',
        task: 'prepare_scope_branch',
      },
      async execute() {
        return { type: 'suspend', interactionKind: 'scope_selector', task: 'prepare_scope_branch' };
      },
    };
    const initial = await runAgentLoop({
      sessionId: 'raw-interaction-resume',
      messages: [user],
      rawMessages: [user],
      tools: [tool],
      maxSteps: 3,
      idFactory: sequentialIdFactory('interaction-raw'),
      now: () => 10,
      provider: {
        async generate() {
          return {
            toolCalls: [{ id: 'scope-call', name: tool.name, arguments: {} }],
          };
        },
      },
    });
    assert.equal(initial.reason, 'interaction_required');
    assert.ok(initial.suspension);
    assert.ok(initial.rawMessages);

    const checkpoint = await constructSuspendedTurn({
      sessionId: 'raw-interaction-resume',
      runId: 'run-raw-interaction',
      generation: 1,
      interactionId: 'interaction-raw',
      interactionKind: initial.suspension!.interactionKind,
      appPayload: {
        version: 1,
        task: initial.suspension!.task,
        candidateSetToken: parseCandidateSetToken('candidate:v1:raw-interaction'),
      },
      assistantEnvelope: initial.suspension!.assistantEnvelope,
      completedPrefix: initial.suspension!.completedPrefix,
      pendingIndex: initial.suspension!.pendingIndex,
      remainingStepBudget: initial.suspension!.remainingStepBudget,
      priorHistory: initial.suspension!.priorHistory,
      createdAt: 20,
    });
    const settled = settleSuspendedTurn(transitionSuspendedTurnPhase(checkpoint, 'resuming'), {
      kind: 'resumed',
      result: okToolResult({ scope: 'selected' }),
      resultMessages: [{ messageId: 'scope-result', createdAt: 21 }],
    });
    const resumed = await runAgentLoop({
      sessionId: 'raw-interaction-resume',
      messages: [...initial.messages, ...settled.messages],
      rawMessages: [...initial.rawMessages!, ...settled.messages],
      tools: [],
      maxSteps: settled.remainingStepBudget,
      idFactory: sequentialIdFactory('interaction-resumed'),
      now: () => 30,
      provider: { async generate() { return { content: 'Scope analysis complete.' }; } },
    });

    assert.equal(resumed.reason, 'final_answer');
    assert.deepEqual(resumed.rawMessages?.map((message) => message.role), [
      'user', 'agent', 'tool', 'agent',
    ]);
    assert.equal(resumed.rawMessages?.[1]?.toolCalls?.[0]?.id, 'scope-call');
    assert.equal(resumed.rawMessages?.[2]?.toolCallId, 'scope-call');
  });

  it('treats suspend-shaped ordinary data and registered outcomes with extra keys as data', async () => {
    const shapedData = {
      type: 'suspend' as const,
      interactionKind: 'scope_selector' as const,
      task: 'prepare_scope_branch' as const,
    };
    const ordinaryTool: AgentTool = {
      name: 'ordinary',
      description: 'ordinary data tool',
      risk: 'read',
      async execute() { return shapedData; },
    };
    const registeredTool: AgentInteractionTool = {
      name: 'registered',
      description: 'registered interaction tool',
      risk: 'read',
      interaction: {
        interactionKind: 'scope_selector',
        task: 'prepare_scope_branch',
      },
      async execute() { return { ...shapedData, modelLabel: '<untrusted>' }; },
    };
    for (const tool of [ordinaryTool, registeredTool]) {
      let providerCall = 0;
      const result = await runAgentLoop({
        sessionId: `data-${tool.name}`,
        messages: [user],
        tools: [tool],
        provider: {
          async generate() {
            providerCall++;
            return providerCall === 1
              ? { toolCalls: [{ id: `call-${tool.name}`, name: tool.name, arguments: {} }] }
              : { content: 'done' };
          },
        },
      });
      assert.equal(result.reason, 'final_answer');
      assert.equal(result.suspension, undefined);
      const toolResult = result.messages.find((message) => message.role === 'tool');
      assert.ok(toolResult);
      assert.equal(JSON.parse(toolResult.content).data.type, 'suspend');
    }
  });

  it('aborts after permission resolution before starting or executing the tool', async () => {
    const controller = new AbortController();
    const permissionStarted = deferred<void>();
    const permissionGate = deferred<{ type: 'allow' }>();
    let toolExecutions = 0;
    const events: string[] = [];
    const tool: AgentTool = {
      name: 'permission_race',
      description: 'permission race',
      risk: 'read',
      async execute() { toolExecutions++; return {}; },
    };
    const running = runAgentLoop({
      sessionId: 'permission-abort',
      messages: [user],
      tools: [tool],
      signal: controller.signal,
      permissions: async () => {
        permissionStarted.resolve();
        return permissionGate.promise;
      },
      provider: {
        async generate() {
          return { toolCalls: [0, 1].map((index) => ({
            id: `permission-race-${index}`,
            name: 'permission_race',
            arguments: {},
          })) };
        },
      },
      emit: (event) => events.push(event.type),
    });
    await permissionStarted.promise;
    controller.abort();
    permissionGate.resolve({ type: 'allow' });
    const result = await running;
    assert.equal(result.reason, 'aborted');
    assert.equal(toolExecutions, 0);
    assert.equal(events.includes('tool_execution_start'), false);
    assert.deepEqual(
      result.messages.filter((message) => message.role === 'tool').map((message) =>
        JSON.parse(message.content).error.code),
      ['tool_execution_aborted', 'not_executed_due_to_abort'],
    );
  });

  it('does not suspend when abort arrives before an async interaction tool resolves', async () => {
    const controller = new AbortController();
    const executionStarted = deferred<void>();
    const executionGate = deferred<{
      type: 'suspend';
      interactionKind: 'scope_selector';
      task: 'prepare_scope_branch';
    }>();
    const tool: AgentInteractionTool = {
      name: 'interaction_race',
      description: 'interaction race',
      risk: 'read',
      interaction: {
        interactionKind: 'scope_selector',
        task: 'prepare_scope_branch',
      },
      async execute() {
        executionStarted.resolve();
        return executionGate.promise;
      },
    };
    const running = runAgentLoop({
      sessionId: 'interaction-abort',
      messages: [user],
      tools: [tool],
      signal: controller.signal,
      provider: {
        async generate() {
          return { toolCalls: [0, 1].map((index) => ({
            id: `interaction-race-${index}`,
            name: 'interaction_race',
            arguments: {},
          })) };
        },
      },
    });
    await executionStarted.promise;
    controller.abort();
    executionGate.resolve({
      type: 'suspend',
      interactionKind: 'scope_selector',
      task: 'prepare_scope_branch',
    });
    const result = await running;
    assert.equal(result.reason, 'aborted');
    assert.equal(result.suspension, undefined);
    assert.deepEqual(
      result.messages.filter((message) => message.role === 'tool').map((message) =>
        JSON.parse(message.content).error.code),
      ['tool_execution_aborted', 'not_executed_due_to_abort'],
    );
  });

  it('preserves the 16KiB result budget from raw history after compaction and resume', async () => {
    const base = checkpointInput(2);
    const largePrefix = base.assistantEnvelope.toolCalls.slice(0, 2).map((call) => {
      const serializedResult = serializeBoundedToolResult(exactSuccess(7_900)).serialized;
      return {
        index: call.index,
        messageId: `large-prefix-${call.index}`,
        callId: call.id,
        toolName: call.name,
        serializedResult,
        createdAt: 21 + call.index,
      };
    });
    const pending = await constructSuspendedTurn({ ...base, completedPrefix: largePrefix });
    const resuming = transitionSuspendedTurnPhase(pending, 'resuming');
    const settled = settleSuspendedTurn(resuming, {
      kind: 'resumed',
      result: okToolResult({ prepared: true }),
      resultMessages: settlementMessageIds(resuming),
    });
    const nextTool: AgentTool = {
      name: 'next_read',
      description: 'next read',
      risk: 'read',
      async execute() { return { payload: 'x'.repeat(1_000) }; },
    };
    let providerCall = 0;
    const resumed = await runAgentLoop({
      sessionId: 'resumed-budget',
      messages: [user],
      rawMessages: [user, ...settled.messages],
      tools: [nextTool],
      maxSteps: settled.remainingStepBudget,
      provider: {
        async generate() {
          providerCall++;
          return providerCall === 1
            ? { toolCalls: [{ id: 'next-call', name: 'next_read', arguments: {} }] }
            : { content: 'done' };
        },
      },
    });
    assert.equal(resumed.reason, 'final_answer');
    const results = resumed.rawMessages!.filter((message) => message.role === 'tool');
    const nextResult = results.find((message) => message.toolCallId === 'next-call');
    assert.ok(nextResult);
    assert.equal(JSON.parse(nextResult.content).error.code, 'tool_output_too_large');
    assert.equal(
      results.reduce((sum, message) => sum + encoder.encode(message.content).byteLength, 0) <=
        16 * 1024,
      true,
    );
  });

  it('uses the suspended-turn memory ceiling instead of a model-context cap', async () => {
    const pending = await constructSuspendedTurn(checkpointInput(0));
    const resuming = transitionSuspendedTurnPhase(pending, 'resuming');
    const settled = settleSuspendedTurn(resuming, {
      kind: 'resumed',
      result: exactSuccess(20_000),
      resultMessages: settlementMessageIds(resuming),
    });

    const current = JSON.parse(settled.completedResults[0]!.serializedResult);
    assert.equal(current.ok, true);
    assert.equal(
      encoder.encode(settled.completedResults[0]!.serializedResult).byteLength
        <= MAX_SUSPENDED_TOOL_RESULT_MEMORY_BYTES,
      true,
    );
  });

  it('rejects a suspended checkpoint whose completed prefix exceeds loop budgets', async () => {
    const base = checkpointInput(1);
    const oversizedPrefix = [{
      ...base.completedPrefix[0]!,
      serializedResult: JSON.stringify(exactSuccess(MAX_SUSPENDED_TOOL_RESULT_MEMORY_BYTES + 1)),
    }];

    await assert.rejects(
      () => constructSuspendedTurn({ ...base, completedPrefix: oversizedPrefix }),
      /protocol byte limit|tool-result budget/u,
    );
  });

  it('settles all calls on orderly abort and uses approval-specific sibling codes', async () => {
    const controller = new AbortController();
    const abortResult = await runAgentLoop({
      sessionId: 'abort-loop',
      messages: [user],
      tools: [],
      signal: controller.signal,
      provider: {
        async generate() {
          controller.abort();
          return { toolCalls: [0, 1, 2].map((index) => ({
            id: `abort-${index}`,
            name: 'missing',
            arguments: {},
          })) };
        },
      },
    });
    assert.equal(abortResult.reason, 'aborted');
    assert.deepEqual(
      abortResult.messages.filter((message) => message.role === 'tool').map((message) =>
        JSON.parse(message.content).error.code),
      ['tool_execution_aborted', 'not_executed_due_to_abort', 'not_executed_due_to_abort'],
    );

    const writeTool: AgentTool = {
      name: 'write',
      description: 'write',
      risk: 'write',
      async execute() { return {}; },
    };
    const approvalResult = await runAgentLoop({
      sessionId: 'approval-loop',
      messages: [user],
      tools: [writeTool],
      provider: {
        async generate() {
          return { toolCalls: [0, 1].map((index) => ({
            id: `approval-${index}`,
            name: 'write',
            arguments: {},
          })) };
        },
      },
    });
    assert.deepEqual(
      approvalResult.messages.filter((message) => message.role === 'tool').map((message) =>
        JSON.parse(message.content).error.code),
      ['approval_required', 'not_executed_due_to_approval'],
    );
  });
});
