import {
  estimateUtf8Tokens,
  preflightContextRequest,
  type ContextBudgetPolicy,
  type ProviderUsageAnchor,
} from './compaction';
import {
  MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  MAX_TURN_TOOL_RESULT_BYTES,
} from './const';
import { type AgentMessage, toModelMessage } from './messages';
import type { ModelProvider, ModelToolCall } from './provider';
import { utf8ByteLength } from './results';
import {
  MIN_TOOL_RESULT_ENVELOPE_BYTES,
  MIN_TOOL_RESULT_ENVELOPE_SERIALIZED,
  type ToolResultAllowance,
  ToolResultBudgetError,
  type toToolDefinition,
} from './tools';

export function resolveToolResultAllowance(input: Readonly<{
  policy?: ContextBudgetPolicy;
  messages: readonly AgentMessage[];
  assistantMessage: AgentMessage;
  stagedToolMessages: readonly AgentMessage[];
  pendingToolCalls: readonly ModelToolCall[];
  toolDefinitions: readonly ReturnType<typeof toToolDefinition>[];
  maxOutputTokens: number;
  latestUsage?: ProviderUsageAnchor;
  cumulativeToolResultBytes: number;
  provider: ModelProvider;
  allowMinimumEnvelopeForContinuation: boolean;
}>): ToolResultAllowance {
  const reservedSiblingBytes = Math.max(0, input.pendingToolCalls.length - 1)
    * MIN_TOOL_RESULT_ENVELOPE_BYTES;
  if (!input.policy) {
    const memoryRemainingBytes = Math.max(
      0,
      MAX_TURN_TOOL_RESULT_BYTES - input.cumulativeToolResultBytes - reservedSiblingBytes,
    );
    const maxSerializedBytes = Math.min(MAX_TOOL_RESULT_BYTES, memoryRemainingBytes);
    if (maxSerializedBytes < MIN_TOOL_RESULT_ENVELOPE_BYTES) {
      throw new ToolResultBudgetError('memory');
    }
    return {
      maxSerializedBytes,
      contextRemainingTokens: Number.MAX_SAFE_INTEGER,
      memoryRemainingBytes,
    };
  }

  const reservedMessages: AgentMessage[] = input.pendingToolCalls.map((toolCall) => ({
    id: `budget:${toolCall.id}`,
    role: 'tool',
    content: MIN_TOOL_RESULT_ENVELOPE_SERIALIZED,
    createdAt: 0,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  }));
  const projection = [
    ...input.messages,
    input.assistantMessage,
    ...input.stagedToolMessages,
    ...reservedMessages,
  ].map(toModelMessage);
  const minimum = preflightContextRequest({
    messages: projection,
    toolSchemas: input.toolDefinitions,
    maxOutputTokens: input.maxOutputTokens,
    ...(input.latestUsage ? { latestUsage: input.latestUsage } : {}),
  }, input.policy);
  const minimumResultTokens = estimateUtf8Tokens(MIN_TOOL_RESULT_ENVELOPE_SERIALIZED);
  const contextRemainingTokens = Math.max(
    0,
    input.policy.hardLimit - minimum.inputTokens + minimumResultTokens,
  );
  const contextRemainingBytes = contextRemainingTokens > Math.floor(Number.MAX_SAFE_INTEGER / 3)
    ? Number.MAX_SAFE_INTEGER
    : contextRemainingTokens * 3;
  const memoryRemainingBytes = Math.max(
    0,
    input.policy.memoryResultCeilingBytes
      - input.cumulativeToolResultBytes
      - reservedSiblingBytes,
  );
  const providerInspection = input.provider.inspectRequest?.({
    messages: projection,
    tools: [...input.toolDefinitions],
    maxOutputTokens: input.maxOutputTokens,
  });
  let providerResultCeilingBytes: number | undefined;
  if (providerInspection) {
    if (!providerInspection.accepted) {
      providerResultCeilingBytes = 0;
    } else {
      const remainingProjectedBytes = Math.max(0, Math.min(
        providerInspection.historyByteLimit - providerInspection.serializedHistoryBytes,
        providerInspection.requestByteLimit - providerInspection.serializedRequestBytes,
      ));
      providerResultCeilingBytes = MIN_TOOL_RESULT_ENVELOPE_BYTES
        + Math.floor(remainingProjectedBytes / 2);
    }
  }
  // A complete minimal envelope gives the continuation owner a protocol-safe
  // boundary to compact before another Provider request or tool execution.
  const contextAllowanceBytes = !minimum.accepted && input.allowMinimumEnvelopeForContinuation
    ? MIN_TOOL_RESULT_ENVELOPE_BYTES
    : contextRemainingBytes;
  const providerAllowanceBytes = providerInspection?.accepted === false
    && input.allowMinimumEnvelopeForContinuation
    ? MIN_TOOL_RESULT_ENVELOPE_BYTES
    : providerResultCeilingBytes ?? Number.MAX_SAFE_INTEGER;
  const maxSerializedBytes = Math.min(
    contextAllowanceBytes,
    memoryRemainingBytes,
    providerAllowanceBytes,
  );
  if (maxSerializedBytes < MIN_TOOL_RESULT_ENVELOPE_BYTES) {
    const factor = memoryRemainingBytes < MIN_TOOL_RESULT_ENVELOPE_BYTES
      ? 'memory' as const
      : providerAllowanceBytes < MIN_TOOL_RESULT_ENVELOPE_BYTES
        ? 'provider' as const
        : 'context' as const;
    throw new ToolResultBudgetError(factor);
  }
  return {
    maxSerializedBytes,
    contextRemainingTokens,
    memoryRemainingBytes,
    ...(providerResultCeilingBytes === undefined ? {} : { providerResultCeilingBytes }),
  };
}

export function canFitMinimumToolResults(
  policy: Pick<ContextBudgetPolicy, 'memoryResultCeilingBytes'>,
  cumulativeToolResultBytes: number,
  pendingToolCallCount: number,
): boolean {
  return cumulativeToolResultBytes
    + pendingToolCallCount * MIN_TOOL_RESULT_ENVELOPE_BYTES
    <= policy.memoryResultCeilingBytes;
}

export function toolResultMemoryPressure(
  policy: Pick<ContextBudgetPolicy, 'memoryResultCeilingBytes'>,
  cumulativeToolResultBytes: number,
): boolean {
  // Reserve a small adaptive tail instead of treating every non-empty result
  // as pressure when a provider advertises a compact result ceiling.
  const lowWaterMark = policy.memoryResultCeilingBytes >= MAX_TOOL_RESULT_BYTES
    ? MAX_TOOL_RESULT_BYTES
    : Math.max(
        MIN_TOOL_RESULT_ENVELOPE_BYTES,
        Math.floor(policy.memoryResultCeilingBytes * 3 / 4),
      );
  return policy.memoryResultCeilingBytes - cumulativeToolResultBytes < lowWaterMark;
}

export function exclusiveToolResultAllowance(): ToolResultAllowance {
  return {
    maxSerializedBytes: MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
    contextRemainingTokens: Number.MAX_SAFE_INTEGER,
    memoryRemainingBytes: MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
    providerResultCeilingBytes: MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  };
}

export function toolResultBytesSinceLatestUser(messages: readonly AgentMessage[]): number {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  let total = 0;
  for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
    if (messages[index].role === 'tool') total += utf8ByteLength(messages[index].content);
  }
  return total;
}

export function toolBudgetLimitingFactor(
  allowance: ToolResultAllowance,
): 'context' | 'memory' | 'provider' | 'multiple' {
  const contextBytes = allowance.contextRemainingTokens > Math.floor(Number.MAX_SAFE_INTEGER / 3)
    ? Number.MAX_SAFE_INTEGER
    : allowance.contextRemainingTokens * 3;
  const ceilings = [
    ['context', contextBytes],
    ['memory', allowance.memoryRemainingBytes],
    ['provider', allowance.providerResultCeilingBytes ?? Number.MAX_SAFE_INTEGER],
  ] as const;
  const minimum = Math.min(...ceilings.map(([, value]) => value));
  const limiting = ceilings.filter(([, value]) => value === minimum);
  return limiting.length === 1 ? limiting[0]![0] : 'multiple';
}
