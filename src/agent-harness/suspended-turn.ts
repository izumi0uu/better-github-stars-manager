import { canonicalJson, sha256Base64Url } from './canonical-json';
import {
  MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES,
} from './const';
import type { AgentMessage, ModelMessage } from './messages';
import type { ModelToolCall } from './provider';
import { isCandidateSetToken, type CandidateSetToken } from './interaction-token';
import {
  validateProviderProtocolHistory,
  validateSerializedResult,
  validateToolCallEnvelope,
} from './protocol';
import {
  errorToolResult,
  type ToolResult,
  utf8ByteLength,
} from './results';
import {
  finalizeToolResult,
  MIN_TOOL_RESULT_ENVELOPE_BYTES,
  ToolResultBudgetError,
} from './tools';

export type SuspendedTurnPhase = 'pending' | 'resuming' | 'cancelled';
export type InteractionKind = 'scope_selector';
export const MAX_SUSPENDED_TOOL_RESULT_MEMORY_BYTES = MAX_GENERIC_TOOL_SUCCESS_RESULT_BYTES;

export type SuspendedToolCall = Readonly<ModelToolCall & { index: number }>;

export type SuspendedTurn = Readonly<{
  version: 1;
  phase: SuspendedTurnPhase;
  sessionId: string;
  runId: string;
  generation: number;
  interactionId: string;
  interactionKind: InteractionKind;
  appPayload: Readonly<{
    version: 1;
    task: 'prepare_scope_branch';
    candidateSetToken: CandidateSetToken;
  }>;
  assistantEnvelope: Readonly<{
    messageId: string;
    content: string;
    createdAt: number;
    finishReason: 'tool_calls';
    toolCalls: readonly SuspendedToolCall[];
  }>;
  completedPrefix: readonly SuspendedToolResult[];
  pendingIndex: number;
  siblings: readonly SuspendedToolCall[];
  remainingStepBudget: number;
  historySnapshot: readonly ModelMessage[];
  historyFingerprint: string;
  createdAt: number;
}>;

export type SuspendedToolResult = Readonly<{
  index: number;
  messageId: string;
  callId: string;
  toolName: string;
  serializedResult: string;
  createdAt: number;
}>;

export type ConstructSuspendedTurnInput = Readonly<{
  sessionId: string;
  runId: string;
  generation: number;
  interactionId: string;
  interactionKind: InteractionKind;
  appPayload: SuspendedTurn['appPayload'];
  assistantEnvelope: SuspendedTurn['assistantEnvelope'];
  completedPrefix: readonly SuspendedToolResult[];
  pendingIndex: number;
  remainingStepBudget: number;
  priorHistory: readonly ModelMessage[];
  createdAt: number;
}>;

export type SettlementKind = 'resumed' | 'cancelled' | 'approval_required' | 'aborted';

export type SettleSuspendedTurnInput = Readonly<{
  kind: SettlementKind;
  result?: ToolResult;
  resultMessages: readonly Readonly<{ messageId: string; createdAt: number }>[];
}>;

export type SettledTurn = Readonly<{
  history: readonly ModelMessage[];
  messages: readonly AgentMessage[];
  completedResults: readonly SuspendedToolResult[];
  remainingStepBudget: number;
  continueProvider: boolean;
}>;

export class SuspendedTurnValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuspendedTurnValidationError';
  }
}

export async function constructSuspendedTurn(
  input: ConstructSuspendedTurnInput,
): Promise<SuspendedTurn> {
  validateConstructionInput(input);
  const assistantEnvelope = cloneJson(input.assistantEnvelope);
  const completedPrefix = cloneJson(input.completedPrefix);
  const priorHistory = cloneJson(input.priorHistory);
  const historySnapshot = buildIncompleteHistory(
    priorHistory,
    assistantEnvelope,
    completedPrefix,
  );
  const checkpoint: SuspendedTurn = {
    version: 1,
    phase: 'pending',
    sessionId: input.sessionId,
    runId: input.runId,
    generation: input.generation,
    interactionId: input.interactionId,
    interactionKind: input.interactionKind,
    appPayload: cloneJson(input.appPayload),
    assistantEnvelope,
    completedPrefix,
    pendingIndex: input.pendingIndex,
    siblings: assistantEnvelope.toolCalls.slice(input.pendingIndex + 1),
    remainingStepBudget: input.remainingStepBudget,
    historySnapshot,
    historyFingerprint: await fingerprintHistory(historySnapshot),
    createdAt: input.createdAt,
  };
  validateSuspendedTurnStructure(checkpoint);
  return deepFreeze(checkpoint);
}

export async function validateSuspendedTurn(value: SuspendedTurn): Promise<void> {
  validateSuspendedTurnStructure(value);
  if (value.historyFingerprint !== await fingerprintHistory(value.historySnapshot)) {
    fail('History fingerprint does not match the canonical snapshot.');
  }
}

function validateSuspendedTurnStructure(value: SuspendedTurn): void {
  if (!value || typeof value !== 'object') fail('Checkpoint must be an object.');
  if (value.version !== 1) fail('Checkpoint version must be 1.');
  if (!['pending', 'resuming', 'cancelled'].includes(value.phase)) fail('Invalid checkpoint phase.');
  assertNonempty(value.sessionId, 'sessionId');
  assertNonempty(value.runId, 'runId');
  assertNonempty(value.interactionId, 'interactionId');
  if (value.runId === value.interactionId) fail('runId and interactionId must be unique.');
  if (value.interactionKind !== 'scope_selector') fail('Unsupported interaction kind.');
  assertSafeInteger(value.generation, 'generation');
  assertSafeInteger(value.pendingIndex, 'pendingIndex');
  assertSafeInteger(value.remainingStepBudget, 'remainingStepBudget');
  assertSafeInteger(value.createdAt, 'createdAt');
  validateAppPayload(value.appPayload);
  validateEnvelope(value.assistantEnvelope);
  if (value.pendingIndex >= value.assistantEnvelope.toolCalls.length) {
    fail('pendingIndex must identify an assistant tool call.');
  }
  validatePrefix(
    value.completedPrefix,
    value.assistantEnvelope.toolCalls,
    value.pendingIndex,
    value.assistantEnvelope.messageId,
  );
  const expectedSiblings = value.assistantEnvelope.toolCalls.slice(value.pendingIndex + 1);
  if (!jsonDataEqual(value.siblings, expectedSiblings)) {
    fail('Siblings must equal the exact unexecuted call suffix.');
  }
  const priorLength = value.historySnapshot.length - 1 - value.completedPrefix.length;
  if (priorLength < 0) fail('History snapshot is missing its assistant envelope.');
  const priorHistory = value.historySnapshot.slice(0, priorLength);
  validateProviderProtocolHistory(priorHistory);
  validateToolCallEnvelope(value.assistantEnvelope.toolCalls, priorHistory);
  const expectedHistory = buildIncompleteHistory(
    priorHistory,
    value.assistantEnvelope,
    value.completedPrefix,
  );
  if (!jsonDataEqual(value.historySnapshot, expectedHistory)) {
    fail('History snapshot does not match the sealed envelope and prefix.');
  }
  if (!/^hf:v1:[A-Za-z0-9_-]{43}$/u.test(value.historyFingerprint)) {
    fail('History fingerprint is malformed.');
  }
}

export function transitionSuspendedTurnPhase(
  value: SuspendedTurn,
  phase: Exclude<SuspendedTurnPhase, 'pending'>,
): SuspendedTurn {
  if (phase !== 'resuming' && phase !== 'cancelled') fail('Invalid checkpoint transition target.');
  if (value.phase !== 'pending') fail('Only a pending checkpoint can transition.');
  validateSuspendedTurnStructure(value);
  return deepFreeze({ ...cloneJson(value), phase });
}

export function settleSuspendedTurn(
  checkpoint: SuspendedTurn,
  input: SettleSuspendedTurnInput,
): SettledTurn {
  validateSuspendedTurnStructure(checkpoint);
  validateSettlementPhase(checkpoint.phase, input.kind);
  const unresolved = checkpoint.assistantEnvelope.toolCalls.slice(checkpoint.pendingIndex);
  if (input.resultMessages.length !== unresolved.length) {
    fail('Settlement requires one controller-supplied message identity per unresolved call.');
  }
  const messageIds = new Set([
    checkpoint.assistantEnvelope.messageId,
    ...checkpoint.completedPrefix.map((entry) => entry.messageId),
  ]);
  const settled: SuspendedToolResult[] = [];
  let cumulativeResultBytes = checkpoint.completedPrefix.reduce(
    (total, entry) => total + utf8ByteLength(entry.serializedResult),
    0,
  );
  for (let offset = 0; offset < unresolved.length; offset += 1) {
    const call = unresolved[offset];
    const identity = input.resultMessages[offset];
    assertNonempty(identity.messageId, 'settlement messageId');
    assertSafeInteger(identity.createdAt, 'settlement createdAt');
    if (messageIds.has(identity.messageId)) fail('Settlement message IDs must be unique.');
    messageIds.add(identity.messageId);
    const candidate = offset === 0
      ? currentSettlementResult(input)
      : siblingSettlementResult(input.kind);
    const remainingEnvelopeBytes = (unresolved.length - offset - 1)
      * MIN_TOOL_RESULT_ENVELOPE_BYTES;
    const memoryRemainingBytes = Math.max(
      0,
      MAX_SUSPENDED_TOOL_RESULT_MEMORY_BYTES
        - cumulativeResultBytes
        - remainingEnvelopeBytes,
    );
    let result: ReturnType<typeof finalizeToolResult>;
    try {
      result = finalizeToolResult(candidate, {
        maxSerializedBytes: memoryRemainingBytes,
        contextRemainingTokens: Number.MAX_SAFE_INTEGER,
        memoryRemainingBytes,
      });
    } catch (error) {
      if (error instanceof ToolResultBudgetError) {
        fail('Suspended turn cannot represent every required tool-result envelope.');
      }
      throw error;
    }
    cumulativeResultBytes += result.byteLength;
    settled.push({
      index: call.index,
      messageId: identity.messageId,
      callId: call.id,
      toolName: call.name,
      serializedResult: result.serialized,
      createdAt: identity.createdAt,
    });
  }

  const completedResults = [...checkpoint.completedPrefix, ...settled];
  const history = [
    ...checkpoint.historySnapshot,
    ...settled.map<ModelMessage>((entry) => ({
      role: 'tool',
      content: entry.serializedResult,
      toolCallId: entry.callId,
      toolName: entry.toolName,
    })),
  ];
  validateProviderProtocolHistory(history);
  const messages: AgentMessage[] = [
    {
      id: checkpoint.assistantEnvelope.messageId,
      role: 'agent',
      content: checkpoint.assistantEnvelope.content,
      createdAt: checkpoint.assistantEnvelope.createdAt,
      toolCalls: checkpoint.assistantEnvelope.toolCalls.map(({ id, name, arguments: args }) => ({
        id,
        name,
        arguments: cloneJson(args),
      })),
    },
    ...completedResults.map((entry) => ({
      id: entry.messageId,
      role: 'tool' as const,
      content: entry.serializedResult,
      createdAt: entry.createdAt,
      toolCallId: entry.callId,
      toolName: entry.toolName,
    })),
  ];
  return deepFreeze({
    history,
    messages,
    completedResults,
    remainingStepBudget: checkpoint.remainingStepBudget,
    continueProvider: input.kind === 'resumed',
  });
}

export async function fingerprintHistory(history: readonly ModelMessage[]): Promise<string> {
  return `hf:v1:${await sha256Base64Url(canonicalJson(history))}`;
}

function validateConstructionInput(input: ConstructSuspendedTurnInput): void {
  assertNonempty(input.sessionId, 'sessionId');
  assertNonempty(input.runId, 'runId');
  assertNonempty(input.interactionId, 'interactionId');
  if (input.runId === input.interactionId) fail('runId and interactionId must be unique.');
  assertSafeInteger(input.generation, 'generation');
  assertSafeInteger(input.pendingIndex, 'pendingIndex');
  assertSafeInteger(input.remainingStepBudget, 'remainingStepBudget');
  assertSafeInteger(input.createdAt, 'createdAt');
  if (input.interactionKind !== 'scope_selector') fail('Unsupported interaction kind.');
  validateAppPayload(input.appPayload);
  validateEnvelope(input.assistantEnvelope);
  if (input.pendingIndex >= input.assistantEnvelope.toolCalls.length) {
    fail('pendingIndex must identify an assistant tool call.');
  }
  validatePrefix(
    input.completedPrefix,
    input.assistantEnvelope.toolCalls,
    input.pendingIndex,
    input.assistantEnvelope.messageId,
  );
  validateProviderProtocolHistory(input.priorHistory);
  validateToolCallEnvelope(input.assistantEnvelope.toolCalls, input.priorHistory);
}

function validateAppPayload(value: SuspendedTurn['appPayload']): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid appPayload.');
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'candidateSetToken' ||
    keys[1] !== 'task' ||
    keys[2] !== 'version'
  ) fail('appPayload contains unsupported fields.');
  if (value.version !== 1 || value.task !== 'prepare_scope_branch') fail('Invalid appPayload task.');
  if (!isCandidateSetToken(value.candidateSetToken)) {
    fail('candidateSetToken must be a nonempty candidate:v1: token.');
  }
  if (jsonByteLength(value) > MAX_GENERIC_TOOL_ERROR_RESULT_BYTES) {
    fail('appPayload exceeds the control-envelope byte limit.');
  }
}

function validateEnvelope(value: SuspendedTurn['assistantEnvelope']): void {
  if (!value || typeof value !== 'object') fail('Invalid assistant envelope.');
  assertNonempty(value.messageId, 'assistant messageId');
  if (typeof value.content !== 'string') fail('Assistant content must be a string.');
  assertSafeInteger(value.createdAt, 'assistant createdAt');
  if (value.finishReason !== 'tool_calls') fail('Suspended envelope must finish with tool_calls.');
  if (!Array.isArray(value.toolCalls) || value.toolCalls.length === 0) {
    fail('Suspended envelope must contain tool calls.');
  }
  for (const [index, call] of value.toolCalls.entries()) {
    if (call.index !== index) fail('Tool-call indices must be contiguous and ordered.');
  }
  validateToolCallEnvelope(value.toolCalls);
  cloneJson(value);
}

function validatePrefix(
  prefix: readonly SuspendedToolResult[],
  calls: readonly SuspendedToolCall[],
  pendingIndex: number,
  assistantMessageId: string,
): void {
  if (!Array.isArray(prefix) || prefix.length !== pendingIndex) {
    fail('Completed prefix length must equal pendingIndex.');
  }
  const messageIds = new Set<string>([assistantMessageId]);
  let cumulativeResultBytes = 0;
  for (const [index, entry] of prefix.entries()) {
    const call = calls[index];
    if (
      entry.index !== index ||
      entry.callId !== call.id ||
      entry.toolName !== call.name
    ) fail('Completed prefix does not match the assistant call envelope.');
    assertNonempty(entry.messageId, 'prefix messageId');
    if (messageIds.has(entry.messageId)) fail('Prefix message IDs must be unique.');
    messageIds.add(entry.messageId);
    assertSafeInteger(entry.createdAt, 'prefix createdAt');
    validateSerializedResult(entry.serializedResult);
    const resultBytes = utf8ByteLength(entry.serializedResult);
    const remainingEnvelopeBytes = (calls.length - index - 1) * MIN_TOOL_RESULT_ENVELOPE_BYTES;
    if (
      resultBytes > MAX_SUSPENDED_TOOL_RESULT_MEMORY_BYTES ||
      cumulativeResultBytes + resultBytes + remainingEnvelopeBytes
        > MAX_SUSPENDED_TOOL_RESULT_MEMORY_BYTES
    ) {
      fail('Completed prefix exceeds the suspended-turn tool-result budget.');
    }
    cumulativeResultBytes += resultBytes;
  }
}

function buildIncompleteHistory(
  priorHistory: readonly ModelMessage[],
  envelope: SuspendedTurn['assistantEnvelope'],
  prefix: readonly SuspendedToolResult[],
): ModelMessage[] {
  return [
    ...cloneJson(priorHistory),
    {
      role: 'assistant',
      content: envelope.content,
      toolCalls: envelope.toolCalls.map(({ id, name, arguments: args }) => ({
        id,
        name,
        arguments: cloneJson(args),
      })),
    },
    ...prefix.map((entry) => ({
      role: 'tool' as const,
      content: entry.serializedResult,
      toolCallId: entry.callId,
      toolName: entry.toolName,
    })),
  ];
}

function currentSettlementResult(input: SettleSuspendedTurnInput): ToolResult {
  switch (input.kind) {
    case 'resumed':
      if (!input.result) fail('Resumed settlement requires a typed interaction result.');
      return input.result;
    case 'cancelled':
      return errorToolResult('interaction_cancelled', 'The requested interaction was cancelled.');
    case 'approval_required':
      return errorToolResult('approval_required', 'Tool execution requires approval.');
    case 'aborted':
      return errorToolResult('tool_execution_aborted', 'Tool execution was aborted.');
  }
}

function siblingSettlementResult(kind: SettlementKind): ToolResult {
  switch (kind) {
    case 'resumed':
      return errorToolResult(
        'not_executed_due_to_interaction',
        'Tool was not executed after an application interaction.',
      );
    case 'cancelled':
      return errorToolResult(
        'not_executed_due_to_cancel',
        'Tool was not executed because the interaction was cancelled.',
      );
    case 'approval_required':
      return errorToolResult(
        'not_executed_due_to_approval',
        'Tool was not executed because an earlier call requires approval.',
      );
    case 'aborted':
      return errorToolResult(
        'not_executed_due_to_abort',
        'Tool was not executed because the turn was aborted.',
      );
  }
}

function validateSettlementPhase(phase: SuspendedTurnPhase, kind: SettlementKind): void {
  if (kind === 'resumed' && phase !== 'resuming') fail('Resume settlement requires resuming phase.');
  if (kind === 'cancelled' && phase !== 'cancelled') fail('Cancel settlement requires cancelled phase.');
  if ((kind === 'approval_required' || kind === 'aborted') && phase !== 'pending') {
    fail('Orderly approval/abort settlement requires pending phase.');
  }
}

function cloneJson<T>(value: T): T {
  return cloneJsonValue(value, new Set(), true) as T;
}

function cloneJsonValue(
  value: unknown,
  ancestors: Set<object>,
  arrayEntry: boolean,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Checkpoint numbers must be finite.');
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return arrayEntry ? null : undefined;
  }
  if (typeof value === 'bigint' || !value || typeof value !== 'object') {
    fail('Checkpoint input must be JSON data.');
  }
  if (ancestors.has(value)) fail('Checkpoint input must not be cyclic.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) =>
        cloneJsonValue(index in value ? value[index] : undefined, ancestors, true));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('Checkpoint objects must be plain JSON records.');
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const cloned = cloneJsonValue(
        (value as Record<string, unknown>)[key],
        ancestors,
        false,
      );
      if (cloned !== undefined) result[key] = cloned;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function jsonDataEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      const leftEntry = index in left ? left[index] : null;
      const rightEntry = index in right ? right[index] : null;
      if (!jsonDataEqual(leftEntry, rightEntry)) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && jsonDataEqual(leftRecord[key], rightRecord[key]));
}

function jsonByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('Checkpoint control data must serialize to JSON.');
  }
  if (typeof serialized !== 'string') fail('Checkpoint control data must serialize to JSON.');
  return utf8ByteLength(serialized);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function assertNonempty(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) fail(`${field} must be nonempty and already trimmed.`);
}

function assertSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${field} must be a nonnegative safe integer.`);
  }
}

function fail(message: string): never {
  throw new SuspendedTurnValidationError(message);
}
