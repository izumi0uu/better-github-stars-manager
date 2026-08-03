import {
  AgentProviderError,
  MAX_PROVIDER_BUFFERED_RESPONSE_BYTES,
  MAX_PROVIDER_ERROR_BYTES,
  type ModelResponse,
  type ModelToolCall,
  type ModelUsage,
} from './provider';

export type ModelStreamEvent =
  | Readonly<{ type: 'response_start' }>
  | Readonly<{ type: 'text_delta'; delta: string }>
  | Readonly<{ type: 'refusal_delta'; delta: string }>
  | Readonly<{ type: 'tool_call_start'; index: number; id: string; name: string }>
  | Readonly<{ type: 'tool_call_arguments_delta'; index: number; delta: string }>
  | Readonly<{ type: 'tool_call_end'; index: number }>
  | Readonly<{ type: 'usage'; usage: ModelUsage }>
  | Readonly<{ type: 'response_end'; finishReason: string }>
  | Readonly<{ type: 'error'; error: AgentProviderError }>;

export type ModelStreamObserver = (event: ModelStreamEvent) => void;

export type ModelStreamLimits = Readonly<{
  maxEvents: number;
  maxTextBytes: number;
  maxRefusalBytes: number;
  maxToolArgumentBytes: number;
  maxBufferedBytes: number;
}>;

export const DEFAULT_MODEL_STREAM_LIMITS: ModelStreamLimits = Object.freeze({
  maxEvents: 65_536,
  maxTextBytes: MAX_PROVIDER_BUFFERED_RESPONSE_BYTES,
  maxRefusalBytes: 64 * 1024,
  maxToolArgumentBytes: MAX_PROVIDER_BUFFERED_RESPONSE_BYTES,
  maxBufferedBytes: MAX_PROVIDER_BUFFERED_RESPONSE_BYTES,
});

const MAX_TOOL_CALL_ID_BYTES = 512;
const MAX_TOOL_NAME_BYTES = 256;
const utf8Encoder = new TextEncoder();

type PendingToolCall = {
  index: number;
  id: string;
  name: string;
  argumentParts: string[];
  complete: boolean;
  parsedArguments?: Record<string, unknown>;
};

type TerminalEvent = Extract<ModelStreamEvent, { type: 'response_end' | 'error' }>;

export async function aggregateModelStream(
  events: AsyncIterable<ModelStreamEvent>,
  observer?: ModelStreamObserver,
  limitOverrides: Partial<ModelStreamLimits> = {},
): Promise<ModelResponse> {
  const limits = resolveLimits(limitOverrides);
  const toolCalls = new Map<number, PendingToolCall>();
  const toolCallIds = new Set<string>();
  const textParts: string[] = [];
  let eventCount = 0;
  let textBytes = 0;
  let refusalBytes = 0;
  let toolArgumentBytes = 0;
  let bufferedBytes = 0;
  let started = false;
  let hasNonWhitespaceText = false;
  let hasRefusal = false;
  let usage: ModelUsage | undefined;
  let terminal: TerminalEvent | undefined;
  let observerTerminalSent = false;

  const emit = (event: ModelStreamEvent): void => {
    if (!observer) return;
    try {
      observer(event);
    } catch {
      throw protocolError('Provider stream observer failed.');
    }
  };

  const emitErrorTerminal = (error: AgentProviderError): void => {
    if (observerTerminalSent || !observer) return;
    observerTerminalSent = true;
    try {
      observer({ type: 'error', error: boundProviderError(error) });
    } catch {
      // A broken observer cannot be allowed to replace the bounded provider error.
    }
  };

  try {
    for await (const event of events) {
      eventCount += 1;
      if (eventCount > limits.maxEvents) {
        throw overflowError('Provider stream event limit exceeded.');
      }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
        throw protocolError('Provider stream emitted a malformed event.');
      }
      if (terminal) {
        throw protocolError('Provider stream emitted an event after its terminal outcome.');
      }

      switch (event.type) {
        case 'response_start': {
          if (started) throw protocolError('Provider stream emitted response_start more than once.');
          started = true;
          emit(event);
          break;
        }
        case 'text_delta': {
          requireStarted(started);
          const deltaBytes = validateDelta(event.delta, 'text');
          textBytes = addWithinLimit(
            textBytes,
            deltaBytes,
            limits.maxTextBytes,
            'Provider stream text limit exceeded.',
          );
          bufferedBytes = addWithinLimit(
            bufferedBytes,
            deltaBytes,
            limits.maxBufferedBytes,
            'Provider stream buffer limit exceeded.',
          );
          textParts.push(event.delta);
          hasNonWhitespaceText ||= event.delta.trim().length > 0;
          emit(event);
          break;
        }
        case 'refusal_delta': {
          requireStarted(started);
          const deltaBytes = validateDelta(event.delta, 'refusal');
          refusalBytes = addWithinLimit(
            refusalBytes,
            deltaBytes,
            limits.maxRefusalBytes,
            'Provider stream refusal limit exceeded.',
          );
          bufferedBytes = addWithinLimit(
            bufferedBytes,
            deltaBytes,
            limits.maxBufferedBytes,
            'Provider stream buffer limit exceeded.',
          );
          hasRefusal = true;
          emit(event);
          break;
        }
        case 'tool_call_start': {
          requireStarted(started);
          validateToolIndex(event.index);
          const id = validateBoundedIdentifier(event.id, MAX_TOOL_CALL_ID_BYTES, 'tool-call ID');
          const name = validateBoundedIdentifier(event.name, MAX_TOOL_NAME_BYTES, 'tool name');
          bufferedBytes = addWithinLimit(
            bufferedBytes,
            utf8Encoder.encode(id).byteLength + utf8Encoder.encode(name).byteLength,
            limits.maxBufferedBytes,
            'Provider stream buffer limit exceeded.',
          );
          if (toolCalls.has(event.index)) {
            throw protocolError('Provider stream reused a tool-call index.');
          }
          if (toolCallIds.has(id)) {
            throw protocolError('Provider stream reused a tool-call ID.');
          }
          toolCalls.set(event.index, {
            index: event.index,
            id,
            name,
            argumentParts: [],
            complete: false,
          });
          toolCallIds.add(id);
          emit(event);
          break;
        }
        case 'tool_call_arguments_delta': {
          requireStarted(started);
          validateToolIndex(event.index);
          const pending = requireOpenToolCall(toolCalls, event.index);
          const deltaBytes = validateDelta(event.delta, 'tool arguments');
          toolArgumentBytes = addWithinLimit(
            toolArgumentBytes,
            deltaBytes,
            limits.maxToolArgumentBytes,
            'Provider stream tool-argument limit exceeded.',
          );
          bufferedBytes = addWithinLimit(
            bufferedBytes,
            deltaBytes,
            limits.maxBufferedBytes,
            'Provider stream buffer limit exceeded.',
          );
          pending.argumentParts.push(event.delta);
          emit(event);
          break;
        }
        case 'tool_call_end': {
          requireStarted(started);
          validateToolIndex(event.index);
          const pending = requireOpenToolCall(toolCalls, event.index);
          const argumentsText = pending.argumentParts.join('');
          let parsed: unknown;
          try {
            parsed = JSON.parse(argumentsText);
          } catch {
            throw protocolError('Provider stream tool arguments are not valid JSON.');
          }
          if (!isPlainRecord(parsed)) {
            throw protocolError('Provider stream tool arguments must decode to an object.');
          }
          pending.parsedArguments = parsed;
          pending.complete = true;
          pending.argumentParts = [];
          emit(event);
          break;
        }
        case 'usage': {
          requireStarted(started);
          if (usage) throw protocolError('Provider stream emitted usage more than once.');
          usage = validateUsage(event.usage);
          emit(event);
          break;
        }
        case 'response_end': {
          requireStarted(started);
          validateSuccessfulTerminal(
            event.finishReason,
            hasNonWhitespaceText,
            hasRefusal,
            toolCalls,
            usage,
          );
          terminal = event;
          break;
        }
        case 'error': {
          if (!(event.error instanceof AgentProviderError)) {
            throw protocolError('Provider stream emitted an invalid error outcome.');
          }
          terminal = { type: 'error', error: boundProviderError(event.error) };
          break;
        }
        default:
          throw protocolError('Provider stream emitted an unsupported event.');
      }
    }

    if (!terminal) throw protocolError('Provider stream ended without a terminal outcome.');
    if (terminal.type === 'error') {
      emitErrorTerminal(terminal.error);
      throw terminal.error;
    }

    const completeToolCalls = materializeToolCalls(toolCalls);
    const response: ModelResponse = { finishReason: terminal.finishReason };
    if (textParts.length > 0) response.content = textParts.join('');
    if (completeToolCalls.length > 0) response.toolCalls = completeToolCalls;
    if (usage) response.usage = usage;
    observerTerminalSent = true;
    emit(terminal);
    return response;
  } catch (cause) {
    const error = normalizeProviderStreamError(cause);
    emitErrorTerminal(error);
    throw error;
  }
}

function resolveLimits(overrides: Partial<ModelStreamLimits>): ModelStreamLimits {
  const limits = { ...DEFAULT_MODEL_STREAM_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AgentProviderError(
        'protocol_error',
        `Provider stream limit ${name} must be a positive safe integer.`,
      );
    }
  }
  return limits;
}

function requireStarted(started: boolean): void {
  if (!started) throw protocolError('Provider stream emitted data before response_start.');
}

function validateDelta(delta: unknown, label: string): number {
  if (typeof delta !== 'string' || delta.length === 0) {
    throw protocolError(`Provider stream emitted an invalid ${label} delta.`);
  }
  return utf8Encoder.encode(delta).byteLength;
}

function validateToolIndex(index: unknown): asserts index is number {
  if (!Number.isSafeInteger(index) || Number(index) < 0) {
    throw protocolError('Provider stream emitted an invalid tool-call index.');
  }
}

function validateBoundedIdentifier(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw protocolError(`Provider stream emitted an invalid ${label}.`);
  }
  const normalized = value.trim();
  if (utf8Encoder.encode(normalized).byteLength > maxBytes) {
    throw overflowError(`Provider stream ${label} limit exceeded.`);
  }
  return normalized;
}

function requireOpenToolCall(
  calls: ReadonlyMap<number, PendingToolCall>,
  index: number,
): PendingToolCall {
  const call = calls.get(index);
  if (!call) throw protocolError('Provider stream referenced an unknown tool-call index.');
  if (call.complete) throw protocolError('Provider stream modified a completed tool call.');
  return call;
}

function validateUsage(value: unknown): ModelUsage {
  if (!isPlainRecord(value)) throw protocolError('Provider stream emitted invalid usage.');
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const totalTokens = value.totalTokens;
  const cachedInputTokens = optionalTokenCount(value.cachedInputTokens);
  const cacheCreationInputTokens = optionalTokenCount(value.cacheCreationInputTokens);
  const reasoningOutputTokens = optionalTokenCount(value.reasoningOutputTokens);
  if (
    !isNonNegativeSafeInteger(inputTokens)
    || !isNonNegativeSafeInteger(outputTokens)
    || !isNonNegativeSafeInteger(totalTokens)
    || inputTokens + outputTokens !== totalTokens
    || cachedInputTokens === null
    || cacheCreationInputTokens === null
    || reasoningOutputTokens === null
    || (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) > inputTokens
    || (reasoningOutputTokens ?? 0) > outputTokens
  ) {
    throw protocolError('Provider stream emitted inconsistent usage.');
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
}

function optionalTokenCount(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return isNonNegativeSafeInteger(value) ? value : null;
}

function validateSuccessfulTerminal(
  finishReason: unknown,
  hasNonWhitespaceText: boolean,
  hasRefusal: boolean,
  toolCalls: ReadonlyMap<number, PendingToolCall>,
  usage: ModelUsage | undefined,
): void {
  if (hasRefusal) {
    throw protocolError('Provider stream ended with a refusal.');
  }
  for (const call of toolCalls.values()) {
    if (!call.complete) throw protocolError('Provider stream ended with an incomplete tool call.');
  }
  assertContiguousToolIndexes(toolCalls);
  if (finishReason === 'stop') {
    if (toolCalls.size > 0) {
      throw protocolError('Provider stream finish reason does not match its tool calls.');
    }
    if (!hasNonWhitespaceText) {
      throw protocolError('Provider stream ended without assistant content.');
    }
    return;
  }
  if (finishReason === 'tool_calls') {
    if (toolCalls.size === 0) {
      throw protocolError('Provider stream ended without the declared tool calls.');
    }
    return;
  }
  if (finishReason === 'length') {
    if (!hasNonWhitespaceText && toolCalls.size === 0 && usage?.outputTokens === 0) {
      return;
    }
    throw protocolError('Provider stream ended before a complete response.');
  }
  throw protocolError('Provider stream emitted an unsupported finish reason.');
}

function assertContiguousToolIndexes(calls: ReadonlyMap<number, PendingToolCall>): void {
  const indexes = [...calls.keys()].sort((left, right) => left - right);
  for (let expected = 0; expected < indexes.length; expected += 1) {
    if (indexes[expected] !== expected) {
      throw protocolError('Provider stream tool-call indexes must be contiguous.');
    }
  }
}

function materializeToolCalls(calls: ReadonlyMap<number, PendingToolCall>): ModelToolCall[] {
  return [...calls.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) => {
      if (!call.complete || !call.parsedArguments) {
        throw protocolError('Provider stream contains an incomplete tool call.');
      }
      return { id: call.id, name: call.name, arguments: call.parsedArguments };
    });
}

function addWithinLimit(current: number, added: number, limit: number, message: string): number {
  if (added > limit - current) throw overflowError(message);
  return current + added;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function protocolError(message: string): AgentProviderError {
  return new AgentProviderError('protocol_error', message);
}

function overflowError(message: string): AgentProviderError {
  return new AgentProviderError('provider_response_too_large', message);
}

function normalizeProviderStreamError(cause: unknown): AgentProviderError {
  if (cause instanceof AgentProviderError) return boundProviderError(cause);
  return new AgentProviderError('network_error', 'Provider stream failed.');
}

function boundProviderError(error: AgentProviderError): AgentProviderError {
  return new AgentProviderError(error.code, truncateUtf8(error.message, MAX_PROVIDER_ERROR_BYTES), error.status);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = '...';
  const suffixBytes = utf8Encoder.encode(suffix).byteLength;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Encoder.encode(character).byteLength;
    if (bytes + characterBytes + suffixBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}
