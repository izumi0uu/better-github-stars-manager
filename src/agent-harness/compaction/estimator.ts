import type { ModelMessage } from '../messages';
import type { ModelUsage } from '../provider';

export const REQUEST_FRAMING_TOKENS = 32;
export const MESSAGE_FRAMING_TOKENS = 8;
export const TOOL_CALL_FRAMING_TOKENS = 16;
export const TOOL_RESULT_LINKAGE_TOKENS = 12;
export const TOOL_SCHEMA_FRAMING_TOKENS = 32;

export type ContextEstimate = {
  inputTokens: number;
  contextDemandTokens: number;
};

export type ContextEstimateInput = {
  messages: readonly ModelMessage[];
  toolSchemas?: readonly unknown[];
  maxOutputTokens: number;
};

export type ProviderUsageAnchor = Readonly<{
  usage: ModelUsage;
  /** Number of messages represented by usage, including the assistant output. */
  prefixMessageCount: number;
}>;

export type ContextUsageEstimateInput = ContextEstimateInput & {
  latestUsage?: ProviderUsageAnchor | null;
};

export type ContextUsageEstimate = ContextEstimate & {
  deterministicInputTokens: number;
  providerPrefixTokens: number | null;
  trailingInputTokens: number;
};

const encoder = new TextEncoder();

export function estimateUtf8Tokens(value: string): number {
  return Math.ceil(encoder.encode(value).byteLength / 3);
}

export function estimateSerializedTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  return estimateUtf8Tokens(serialized ?? '');
}

export function estimateToolSchemasTokens(toolSchemas: readonly unknown[] = []): number {
  return toolSchemas.reduce<number>(
    (total, schema) => saturatingAdd(
      total,
      TOOL_SCHEMA_FRAMING_TOKENS,
      estimateSerializedTokens(schema),
    ),
    0,
  );
}

export function estimateMessageTokens(message: ModelMessage): number {
  let tokens = MESSAGE_FRAMING_TOKENS + estimateUtf8Tokens(message.content);

  for (const toolCall of message.toolCalls ?? []) {
    tokens +=
      TOOL_CALL_FRAMING_TOKENS +
      estimateUtf8Tokens(toolCall.id) +
      estimateUtf8Tokens(toolCall.name) +
      estimateSerializedTokens(toolCall.arguments ?? {});
  }

  if (message.role === 'tool') {
    tokens +=
      TOOL_RESULT_LINKAGE_TOKENS +
      estimateUtf8Tokens(message.toolCallId ?? '') +
      estimateUtf8Tokens(message.toolName ?? '');
  }

  return tokens;
}

export function estimateContext(input: ContextEstimateInput): ContextEstimate {
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 0) {
    throw new RangeError('maxOutputTokens must be a non-negative safe integer.');
  }

  const messageTokens = input.messages.reduce(
    (total, message) => saturatingAdd(total, estimateMessageTokens(message)),
    0,
  );
  const schemaTokens = estimateToolSchemasTokens(input.toolSchemas);
  const inputTokens = saturatingAdd(REQUEST_FRAMING_TOKENS, messageTokens, schemaTokens);

  return {
    inputTokens,
    contextDemandTokens: saturatingAdd(inputTokens, input.maxOutputTokens),
  };
}

export function estimateContextWithUsage(
  input: ContextUsageEstimateInput,
): ContextUsageEstimate {
  const deterministic = estimateContext(input);
  const anchor = validUsageAnchor(input.latestUsage, input.messages.length);
  if (!anchor) {
    return {
      ...deterministic,
      deterministicInputTokens: deterministic.inputTokens,
      providerPrefixTokens: null,
      trailingInputTokens: deterministic.inputTokens,
    };
  }

  const trailingMessageTokens = input.messages
    .slice(anchor.prefixMessageCount)
    .reduce(
      (total, message) => saturatingAdd(total, estimateMessageTokens(message)),
      0,
    );
  const trailingInputTokens = saturatingAdd(
    trailingMessageTokens,
    estimateToolSchemasTokens(input.toolSchemas),
  );
  const providerInputTokens = saturatingAdd(anchor.usage.totalTokens, trailingInputTokens);
  const inputTokens = Math.max(deterministic.inputTokens, providerInputTokens);
  return {
    inputTokens,
    contextDemandTokens: saturatingAdd(inputTokens, input.maxOutputTokens),
    deterministicInputTokens: deterministic.inputTokens,
    providerPrefixTokens: anchor.usage.totalTokens,
    trailingInputTokens,
  };
}

function validUsageAnchor(
  anchor: ProviderUsageAnchor | null | undefined,
  messageCount: number,
): ProviderUsageAnchor | null {
  if (
    !anchor
    || !Number.isSafeInteger(anchor.prefixMessageCount)
    || anchor.prefixMessageCount < 0
    || anchor.prefixMessageCount > messageCount
    || !isValidUsage(anchor.usage)
  ) return null;
  return anchor;
}

function isValidUsage(usage: ModelUsage): boolean {
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0;
  const reasoningOutputTokens = usage.reasoningOutputTokens ?? 0;
  return isNonNegativeSafeInteger(usage.inputTokens)
    && isNonNegativeSafeInteger(usage.outputTokens)
    && isNonNegativeSafeInteger(usage.totalTokens)
    && usage.inputTokens + usage.outputTokens === usage.totalTokens
    && isNonNegativeSafeInteger(cachedInputTokens)
    && isNonNegativeSafeInteger(cacheCreationInputTokens)
    && cachedInputTokens + cacheCreationInputTokens <= usage.inputTokens
    && isNonNegativeSafeInteger(reasoningOutputTokens)
    && reasoningOutputTokens <= usage.outputTokens;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function saturatingAdd(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value >= Number.MAX_SAFE_INTEGER - total) return Number.MAX_SAFE_INTEGER;
    total += value;
  }
  return total;
}
