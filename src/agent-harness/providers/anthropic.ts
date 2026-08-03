import {
  AGENT_API_KEY_EMPTY,
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_HOST_PERMISSION_DENIED,
  AGENT_MODEL_EMPTY,
  AGENT_PROVIDER_IDENTITY_CHANGED,
  AGENT_PROVIDER_TIMEOUT,
} from '@/api/errors';
import type { ModelMessage } from '../messages';
import { assertAgentProviderExactOrigin } from '../provider-access';
import { isAgentLivenessManagedSignal } from '../liveness';
import {
  AGENT_PROVIDER_DEADLINE_MS,
  AgentProviderError,
  assertProviderRequestInspectionAccepted,
  inspectProviderRequestBytes,
  isStructuredProviderContextOverflow,
  MAX_PROVIDER_ERROR_BYTES,
  MAX_PROVIDER_OUTPUT_TOKENS,
  MAX_PROVIDER_RESPONSE_BYTES,
  type ModelGenerateInput,
  type ExactPreparedModelRequest,
  type ExactRequestModelProvider,
  type ModelRequestShape,
  type ModelResponse,
  type ModelToolChoice,
  type ModelUsage,
  type ProviderRequestInspection,
} from '../provider';
import {
  aggregateModelStream,
  type ModelStreamEvent,
  type ModelStreamObserver,
} from '../provider-stream';
import {
  ProtocolValidationError,
  validateProviderProtocolHistory,
} from '../protocol';
import { truncateUtf8, utf8ByteLength } from '../results';
import { decodeSseStream } from '../sse';
import type { AgentToolDefinition } from '../tools';

export const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

export type AnthropicMessagesConfig = Readonly<{
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  expectedOrigin?: string;
  hostPermissionCheck?: () => Promise<boolean>;
  validateRuntimeIdentity?: () => Promise<boolean>;
  now?: () => number;
}>;

type RuntimeConfig = Readonly<{
  model: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  expectedOrigin: string;
  hostPermissionCheck: () => Promise<boolean>;
  validateRuntimeIdentity: () => Promise<boolean>;
  now: () => number;
}>;

type PreparedAnthropicRequest = Readonly<{
  requestBody: string;
  requestBytes: number;
  inspection: ProviderRequestInspection;
  observer?: ModelStreamObserver;
}>;

type RequestDeadline = {
  signal: AbortSignal;
  expiresAt: number;
  readonly timedOut: boolean;
  readonly callerAborted: boolean;
  expireIfNeeded(): void;
  dispose(): void;
};

type AnthropicContentBlock = Record<string, unknown>;
type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
};

type TextBlockState = {
  kind: 'text';
  index: number;
};

type ToolBlockState = {
  kind: 'tool_use';
  index: number;
  toolIndex: number;
  id: string;
  name: string;
  argumentParts: string[];
};

type ThinkingBlockState = {
  kind: 'thinking';
  index: number;
};

type RedactedThinkingBlockState = {
  kind: 'redacted_thinking';
  index: number;
};

type BlockState =
  | TextBlockState
  | ToolBlockState
  | ThinkingBlockState
  | RedactedThinkingBlockState;

export function createAnthropicMessagesProvider(
  config: AnthropicMessagesConfig,
): ExactRequestModelProvider {
  const runtime = resolveRuntimeConfig(config);
  const prepare = (input: Omit<ModelGenerateInput, 'signal'>): ExactPreparedModelRequest => {
    const prepared = prepareAnthropicRequest(runtime, input);
    let executed = false;
    return Object.freeze({
      serializedRequestBody: prepared.requestBody,
      serializedRequestBytes: prepared.requestBytes,
      inspection: prepared.inspection,
      async execute(signal?: AbortSignal): Promise<ModelResponse> {
        if (executed) throw protocolError('A prepared provider request is single-use.');
        executed = true;
        return executePreparedAnthropicRequest(runtime, prepared, signal);
      },
    });
  };
  return {
    inspectRequest: (input) => inspectAnthropicRequest(runtime, input),
    prepare,
    async generate(input): Promise<ModelResponse> {
      const prepared = prepareAnthropicRequest(runtime, input);
      return executePreparedAnthropicRequest(runtime, prepared, input.signal);
    },
  };
}

function prepareAnthropicRequest(
  config: RuntimeConfig,
  input: Pick<
    ModelGenerateInput,
    'messages' | 'tools' | 'toolChoice' | 'maxOutputTokens' | 'onStreamEvent'
  >,
): PreparedAnthropicRequest {
  const serialized = serializeAnthropicRequest(config, input);
  assertProviderRequestInspectionAccepted(serialized.inspection);
  return serialized;
}

function inspectAnthropicRequest(
  config: RuntimeConfig,
  input: ModelRequestShape,
): ProviderRequestInspection {
  return serializeAnthropicRequest(config, input).inspection;
}

function serializeAnthropicRequest(
  config: RuntimeConfig,
  input: Pick<
    ModelGenerateInput,
    'messages' | 'tools' | 'toolChoice' | 'maxOutputTokens' | 'onStreamEvent'
  >,
): PreparedAnthropicRequest {
  assertAgentProviderExactOrigin(config.expectedOrigin, ANTHROPIC_MESSAGES_ENDPOINT);
  validateOutputBudget(input.maxOutputTokens);
  try {
    validateProviderProtocolHistory(input.messages);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new AgentProviderError(error.code, error.message);
    }
    throw error;
  }

  let converted: ReturnType<typeof toAnthropicHistory>;
  let serializedHistory: string;
  try {
    converted = toAnthropicHistory(input.messages);
    serializedHistory = stringifyProviderJson(converted, 'history');
  } catch (error) {
    throw normalizeSerializationError(error, 'history');
  }
  const historyBytes = utf8ByteLength(serializedHistory);

  let requestBody: string;
  try {
    const tools = input.tools.length > 0 ? input.tools.map(toAnthropicTool) : undefined;
    const toolChoice = serializeToolChoice(input.toolChoice, input.tools);
    requestBody = stringifyProviderJson({
      model: config.model,
      ...(converted.system ? { system: converted.system } : {}),
      messages: converted.messages,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      max_tokens: input.maxOutputTokens,
      stream: true,
    }, 'request');
  } catch (error) {
    throw normalizeSerializationError(error, 'request');
  }
  const requestBytes = utf8ByteLength(requestBody);
  return Object.freeze({
    requestBody,
    requestBytes,
    inspection: inspectProviderRequestBytes(historyBytes, requestBytes),
    ...(input.onStreamEvent ? { observer: input.onStreamEvent } : {}),
  });
}

async function executePreparedAnthropicRequest(
  config: RuntimeConfig,
  prepared: PreparedAnthropicRequest,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  const deadline = createDeadline(
    signal,
    isAgentLivenessManagedSignal(signal) ? undefined : config.requestTimeoutMs,
    config.now,
  );
  try {
    throwIfAborted(deadline);
    if (!await waitForAuthorityCheck(config.hostPermissionCheck(), deadline)) {
      throw new Error(AGENT_HOST_PERMISSION_DENIED);
    }
    throwIfAborted(deadline);
    if (!await waitForAuthorityCheck(config.validateRuntimeIdentity(), deadline)) {
      throw new Error(AGENT_PROVIDER_IDENTITY_CHANGED);
    }
    throwIfAborted(deadline);
    assertAgentProviderExactOrigin(config.expectedOrigin, ANTHROPIC_MESSAGES_ENDPOINT);

    let response: Response;
    try {
      response = await config.fetchImpl.call(globalThis, ANTHROPIC_MESSAGES_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: prepared.requestBody,
        signal: deadline.signal,
      });
    } catch (error) {
      throw classifyTransportError(error, deadline);
    }
    if (!response.ok) {
      const body = await readErrorResponseBody(response, deadline);
      const error = isAnthropicContextOverflow(body, response.status)
        ? contextOverflowError(response.status)
        : httpError(response.status);
      throwIfAborted(deadline);
      throw error;
    }
    assertDeclaredResponseLength(response);
    throwIfAborted(deadline);
    if (!isEventStreamResponse(response)) {
      void response.body?.cancel().catch(() => undefined);
      throw protocolError('Provider streaming response must use text/event-stream.');
    }
    if (!response.body) {
      throw new AgentProviderError('parse_error', 'Provider stream body is empty.');
    }

    try {
      const result = await aggregateModelStream(
        anthropicStreamEvents(response.body, deadline.signal),
        prepared.observer,
      );
      throwIfAborted(deadline);
      return result;
    } catch (error) {
      throwIfAborted(deadline);
      if (error instanceof AgentProviderError) throw error;
      throw classifyTransportError(error, deadline);
    }
  } finally {
    deadline.dispose();
  }
}

async function* anthropicStreamEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  let started = false;
  let messageDeltaSeen = false;
  let stopped = false;
  let nextToolIndex = 0;
  let lastStartedBlockIndex = -1;
  const openBlocks = new Map<number, BlockState>();
  const seenBlockIndexes = new Set<number>();
  const usageParts = {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  };
  let finishReason: string | undefined;

  for await (const sseEvent of decodeSseStream(body, { signal })) {
    if (stopped) throw protocolError('Anthropic stream emitted data after message_stop.');
    const event = parseAnthropicEvent(sseEvent.data, sseEvent.event);

    switch (event.type) {
      case 'message_start': {
        if (started) throw protocolError('Anthropic stream emitted message_start more than once.');
        const message = requireRecord(event.message, 'message_start message');
        requireIdentifier(message.id, 'message ID');
        if (
          message.type !== 'message'
          || message.role !== 'assistant'
          || !Array.isArray(message.content)
          || message.content.length !== 0
          || message.stop_reason !== null
        ) {
          throw protocolError('Anthropic stream started with a malformed message.');
        }
        const usage = requireRecord(message.usage, 'message_start usage');
        mergeUsage(usageParts, usage, {
          requireInputTokens: true,
          requireOutputTokens: true,
        });
        started = true;
        yield { type: 'response_start' };
        break;
      }
      case 'content_block_start': {
        requireStarted(started);
        requireBeforeMessageDelta(messageDeltaSeen);
        const index = requireIndex(event.index, 'content block index');
        if (openBlocks.has(index) || seenBlockIndexes.has(index)) {
          throw protocolError('Anthropic stream reused a content block index.');
        }
        if (index <= lastStartedBlockIndex) {
          throw protocolError('Anthropic stream content block indexes moved backwards.');
        }
        const block = requireRecord(event.content_block, 'content block');
        let state: BlockState;
        if (block.type === 'text') {
          const initial = requireString(block.text, 'initial text');
          state = { kind: 'text', index };
          if (initial) yield { type: 'text_delta', delta: initial };
        } else if (block.type === 'tool_use') {
          const input = requireRecord(block.input, 'initial tool input');
          if (Object.keys(input).length !== 0) {
            throw protocolError('Anthropic streamed tool input must start empty.');
          }
          state = {
            kind: 'tool_use',
            index,
            toolIndex: nextToolIndex,
            id: requireIdentifier(block.id, 'tool-use ID'),
            name: requireIdentifier(block.name, 'tool name'),
            argumentParts: [],
          };
          nextToolIndex += 1;
        } else if (block.type === 'thinking') {
          requireString(block.thinking, 'initial thinking');
          if (block.signature !== undefined) requireString(block.signature, 'initial signature');
          state = { kind: 'thinking', index };
        } else if (block.type === 'redacted_thinking') {
          requireString(block.data, 'redacted thinking data');
          state = { kind: 'redacted_thinking', index };
        } else {
          throw protocolError('Anthropic stream started an unsupported content block.');
        }
        openBlocks.set(index, state);
        seenBlockIndexes.add(index);
        lastStartedBlockIndex = index;
        break;
      }
      case 'content_block_delta': {
        requireStarted(started);
        requireBeforeMessageDelta(messageDeltaSeen);
        const block = requireOpenBlock(openBlocks, event.index);
        const delta = requireRecord(event.delta, 'content block delta');
        if (block.kind === 'text' && delta.type === 'text_delta') {
          const text = requireNonemptyString(delta.text, 'text delta');
          yield { type: 'text_delta', delta: text };
        } else if (block.kind === 'tool_use' && delta.type === 'input_json_delta') {
          block.argumentParts.push(requireNonemptyString(delta.partial_json, 'tool input delta'));
        } else if (block.kind === 'thinking' && delta.type === 'thinking_delta') {
          requireNonemptyString(delta.thinking, 'thinking delta');
        } else if (block.kind === 'thinking' && delta.type === 'signature_delta') {
          requireNonemptyString(delta.signature, 'thinking signature delta');
        } else {
          throw protocolError('Anthropic stream emitted a delta incompatible with its open block.');
        }
        break;
      }
      case 'content_block_stop': {
        requireStarted(started);
        requireBeforeMessageDelta(messageDeltaSeen);
        const block = requireOpenBlock(openBlocks, event.index);
        if (block.kind === 'tool_use') {
          const argumentsText = block.argumentParts.length > 0
            ? block.argumentParts.join('')
            : '{}';
          validateToolArguments(argumentsText);
          yield {
            type: 'tool_call_start',
            index: block.toolIndex,
            id: block.id,
            name: block.name,
          };
          yield {
            type: 'tool_call_arguments_delta',
            index: block.toolIndex,
            delta: argumentsText,
          };
          yield { type: 'tool_call_end', index: block.toolIndex };
        }
        openBlocks.delete(block.index);
        break;
      }
      case 'message_delta': {
        requireStarted(started);
        if (openBlocks.size > 0) {
          throw protocolError('Anthropic stream ended its message with an open block.');
        }
        if (messageDeltaSeen) {
          throw protocolError('Anthropic stream emitted message_delta more than once.');
        }
        const delta = requireRecord(event.delta, 'message delta');
        finishReason = mapStopReason(delta.stop_reason);
        const usage = requireRecord(event.usage, 'message_delta usage');
        mergeUsage(usageParts, usage, {
          requireInputTokens: false,
          requireOutputTokens: true,
        });
        messageDeltaSeen = true;
        break;
      }
      case 'message_stop': {
        requireStarted(started);
        if (openBlocks.size > 0) {
          throw protocolError('Anthropic stream stopped with an open content block.');
        }
        if (!messageDeltaSeen || !finishReason) {
          throw protocolError('Anthropic stream stopped before its terminal message delta.');
        }
        const inputTokens = usageParts.inputTokens
          + usageParts.cacheCreationInputTokens
          + usageParts.cacheReadInputTokens;
        const outputTokens = usageParts.outputTokens;
        const totalTokens = inputTokens + outputTokens;
        if (!Number.isSafeInteger(totalTokens)) {
          throw protocolError('Anthropic stream emitted overflowing usage.');
        }
        const usage: ModelUsage = {
          inputTokens,
          outputTokens,
          totalTokens,
          ...(usageParts.cacheReadInputTokens > 0
            ? { cachedInputTokens: usageParts.cacheReadInputTokens }
            : {}),
          ...(usageParts.cacheCreationInputTokens > 0
            ? { cacheCreationInputTokens: usageParts.cacheCreationInputTokens }
            : {}),
        };
        yield { type: 'usage', usage };
        yield { type: 'response_end', finishReason };
        stopped = true;
        break;
      }
      case 'ping':
        break;
      case 'error':
        if (isStructuredProviderContextOverflow(event, 'anthropic')) {
          throw contextOverflowError();
        }
        throw protocolError('Anthropic stream ended with an error event.');
      default:
        throw protocolError('Anthropic stream emitted an unsupported event type.');
    }
  }

  if (!stopped) throw protocolError('Anthropic stream ended without message_stop.');
}

function toAnthropicHistory(messages: readonly ModelMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systems: string[] = [];
  const result: AnthropicMessage[] = [];
  let conversationStarted = false;

  for (const message of messages) {
    if (message.role === 'system') {
      if (conversationStarted) {
        throw protocolError('Anthropic system messages must precede conversation history.');
      }
      systems.push(message.content);
      continue;
    }
    conversationStarted = true;
    if (message.role === 'user') {
      appendAnthropicMessage(result, 'user', [{ type: 'text', text: message.content }]);
      continue;
    }
    if (message.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      if (content.length === 0) {
        throw protocolError('Anthropic assistant messages must contain text or tool calls.');
      }
      appendAnthropicMessage(result, 'assistant', content);
      continue;
    }
    appendAnthropicMessage(result, 'user', [{
      type: 'tool_result',
      tool_use_id: message.toolCallId,
      content: message.content,
      is_error: isFailedToolResult(message.content),
    }]);
  }

  return {
    ...(systems.length > 0 ? { system: systems.join('\n\n') } : {}),
    messages: result,
  };
}

function appendAnthropicMessage(
  messages: AnthropicMessage[],
  role: AnthropicMessage['role'],
  content: AnthropicContentBlock[],
): void {
  const prior = messages.at(-1);
  if (prior?.role === role) {
    prior.content.push(...content);
    return;
  }
  messages.push({ role, content });
}

function isFailedToolResult(content: string): boolean {
  const result = JSON.parse(content) as { ok?: unknown };
  return result.ok === false;
}

function toAnthropicTool(tool: AgentToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  };
}

function serializeToolChoice(
  choice: ModelToolChoice | undefined,
  tools: readonly AgentToolDefinition[],
): Record<string, unknown> | undefined {
  if (tools.length === 0) {
    if (choice && choice !== 'auto') {
      throw protocolError('Tool choice requires at least one tool definition.');
    }
    return undefined;
  }
  if (choice === undefined || choice === 'auto') return choice ? { type: 'auto' } : undefined;
  if (choice === 'required') return { type: 'any' };
  const name = choice.name.trim();
  if (!name || !tools.some((tool) => tool.name === name)) {
    throw protocolError('Named tool choice must match a declared tool.');
  }
  return { type: 'tool', name };
}

function parseAnthropicEvent(data: string, eventName?: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new AgentProviderError('parse_error', 'Anthropic stream event is not valid JSON.');
  }
  const event = requireRecord(value, 'stream event');
  if (typeof event.type !== 'string' || !event.type) {
    throw protocolError('Anthropic stream event is missing its type.');
  }
  if (!eventName || eventName !== event.type) {
    throw protocolError('Anthropic stream SSE event name does not match its payload type.');
  }
  return event;
}

function mergeUsage(
  target: {
    inputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    outputTokens: number;
  },
  usage: Record<string, unknown>,
  requirements: Readonly<{
    requireInputTokens: boolean;
    requireOutputTokens: boolean;
  }>,
): void {
  target.inputTokens = mergedTokenCount(
    usage.input_tokens,
    target.inputTokens,
    'input tokens',
    requirements.requireInputTokens,
  );
  target.cacheCreationInputTokens = mergedTokenCount(
    usage.cache_creation_input_tokens,
    target.cacheCreationInputTokens,
    'cache creation input tokens',
    false,
  );
  target.cacheReadInputTokens = mergedTokenCount(
    usage.cache_read_input_tokens,
    target.cacheReadInputTokens,
    'cache read input tokens',
    false,
  );
  target.outputTokens = mergedTokenCount(
    usage.output_tokens,
    target.outputTokens,
    'output tokens',
    requirements.requireOutputTokens,
  );
}

function mergedTokenCount(
  value: unknown,
  current: number,
  label: string,
  required: boolean,
): number {
  if (value === undefined || value === null) {
    if (required) throw protocolError(`Anthropic stream omitted required ${label}.`);
    return current;
  }
  const next = requireTokenCount(value, label);
  if (next < current) {
    throw protocolError(`Anthropic stream ${label} decreased.`);
  }
  return next;
}

function mapStopReason(value: unknown): string {
  switch (value) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    case 'model_context_window_exceeded':
      throw contextOverflowError();
    default:
      throw protocolError('Anthropic stream emitted an unsupported stop reason.');
  }
}

function validateToolArguments(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw protocolError('Anthropic stream tool input is not valid JSON.');
  }
  if (!isPlainRecord(parsed)) {
    throw protocolError('Anthropic stream tool input must decode to an object.');
  }
}

function requireOpenBlock(
  blocks: ReadonlyMap<number, BlockState>,
  value: unknown,
): BlockState {
  const index = requireIndex(value, 'content block index');
  const block = blocks.get(index);
  if (!block) {
    throw protocolError('Anthropic stream referenced an unknown content block.');
  }
  return block;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw protocolError(`Anthropic ${label} must be an object.`);
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw protocolError(`Anthropic stream emitted an invalid ${label}.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw protocolError(`Anthropic stream emitted invalid ${label}.`);
  return value;
}

function requireNonemptyString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!result) throw protocolError(`Anthropic stream emitted an empty ${label}.`);
  return result;
}

function requireIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw protocolError(`Anthropic stream emitted an invalid ${label}.`);
  }
  return Number(value);
}

function requireTokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw protocolError(`Anthropic stream emitted invalid ${label}.`);
  }
  return Number(value);
}

function requireStarted(started: boolean): void {
  if (!started) throw protocolError('Anthropic stream emitted data before message_start.');
}

function requireBeforeMessageDelta(messageDeltaSeen: boolean): void {
  if (messageDeltaSeen) throw protocolError('Anthropic stream emitted content after message_delta.');
}

function resolveRuntimeConfig(config: AnthropicMessagesConfig): RuntimeConfig {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error(AGENT_API_KEY_EMPTY);
  const model = config.model.trim();
  if (!model) throw new Error(AGENT_MODEL_EMPTY);
  const requestTimeoutMs = config.requestTimeoutMs ?? AGENT_PROVIDER_DEADLINE_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw protocolError('Provider request timeout must be a positive safe integer.');
  }
  return Object.freeze({
    model,
    apiKey,
    fetchImpl: config.fetchImpl ?? fetch,
    requestTimeoutMs,
    expectedOrigin: config.expectedOrigin ?? ANTHROPIC_ORIGIN,
    hostPermissionCheck: config.hostPermissionCheck ?? (async () => true),
    validateRuntimeIdentity: config.validateRuntimeIdentity ?? (async () => true),
    now: config.now ?? Date.now,
  });
}

function validateOutputBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PROVIDER_OUTPUT_TOKENS) {
    throw protocolError(`Output-token budget must be between 1 and ${MAX_PROVIDER_OUTPUT_TOKENS}.`);
  }
}

function createDeadline(
  source: AbortSignal | undefined,
  timeoutMs: number | undefined,
  now: () => number,
): RequestDeadline {
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let disposed = false;
  const expiresAt = timeoutMs === undefined ? Number.POSITIVE_INFINITY : now() + timeoutMs;
  const expire = () => {
    if (timedOut || callerAborted) return;
    timedOut = true;
    controller.abort();
  };
  const timer = timeoutMs === undefined ? null : setTimeout(expire, timeoutMs);
  const abortFromSource = () => {
    callerAborted = true;
    controller.abort(source?.reason);
  };
  source?.addEventListener('abort', abortFromSource, { once: true });
  if (source?.aborted) abortFromSource();
  return {
    signal: controller.signal,
    expiresAt,
    get timedOut() { return timedOut; },
    get callerAborted() { return callerAborted; },
    expireIfNeeded() {
      if (timeoutMs !== undefined && !callerAborted && now() >= expiresAt) expire();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      source?.removeEventListener('abort', abortFromSource);
    },
  };
}

function throwIfAborted(deadline: RequestDeadline): void {
  deadline.expireIfNeeded();
  if (!deadline.signal.aborted) return;
  throw classifyTransportError(new DOMException('Aborted', 'AbortError'), deadline);
}

function classifyTransportError(error: unknown, deadline: RequestDeadline): AgentProviderError {
  if (deadline.timedOut) return new AgentProviderError('timeout', AGENT_PROVIDER_TIMEOUT);
  if (deadline.callerAborted || deadline.signal.aborted) {
    return new AgentProviderError('caller_abort', 'Agent provider request was aborted.');
  }
  if (error instanceof AgentProviderError) return error;
  return new AgentProviderError('network_error', 'Agent provider network request failed.');
}

async function waitForAuthorityCheck(
  check: Promise<boolean>,
  deadline: RequestDeadline,
): Promise<boolean> {
  if (deadline.signal.aborted) throwIfAborted(deadline);
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
  deadline.signal.addEventListener('abort', onAbort, { once: true });
  check.then(resolve, reject).finally(() => {
    deadline.signal.removeEventListener('abort', onAbort);
  });
  try {
    return await promise;
  } catch (error) {
    deadline.expireIfNeeded();
    if (!deadline.signal.aborted && isAuthorityFailure(error)) throw error;
    throw classifyTransportError(error, deadline);
  }
}

function isAuthorityFailure(error: unknown): error is Error {
  return error instanceof Error && [
    AGENT_DATA_DISCLOSURE_REQUIRED,
    AGENT_HOST_PERMISSION_DENIED,
    AGENT_PROVIDER_IDENTITY_CHANGED,
  ].includes(error.message);
}

async function readErrorResponseBody(
  response: Response,
  deadline: RequestDeadline,
): Promise<Uint8Array | null> {
  try {
    const bytes = await readBoundedErrorBody(response, deadline);
    throwIfAborted(deadline);
    return bytes;
  } catch (error) {
    if (error instanceof AgentProviderError) throw error;
    throw classifyTransportError(error, deadline);
  }
}

async function readBoundedErrorBody(
  response: Response,
  deadline: RequestDeadline,
): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_ERROR_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;
  try {
    while (true) {
      const next = await readWithAbort(reader, deadline.signal);
      throwIfAborted(deadline);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_ERROR_BYTES) {
        void reader.cancel().catch(() => undefined);
        overflowed = true;
        break;
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may settle after the reader releases ownership.
    }
  }
  if (overflowed) return null;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}


function assertDeclaredResponseLength(response: Response): void {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (!Number.isFinite(declaredLength) || declaredLength <= MAX_PROVIDER_RESPONSE_BYTES) return;
  void response.body?.cancel().catch(() => undefined);
  throw responseTooLarge();
}

function responseTooLarge(): AgentProviderError {
  return new AgentProviderError(
    'provider_response_too_large',
    `Provider response exceeds the ${MAX_PROVIDER_RESPONSE_BYTES}-byte limit.`,
  );
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('Content-Type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase() === 'text/event-stream';
}

function httpError(status: number): AgentProviderError {
  return new AgentProviderError(
    'http_error',
    `AI provider rejected the request (${status}).`,
    status,
  );
}

function contextOverflowError(status?: number): AgentProviderError {
  return new AgentProviderError(
    'context_overflow',
    'AI provider request exceeded the model context window.',
    status,
  );
}

function isAnthropicContextOverflow(body: Uint8Array | null, status: number): boolean {
  const payload = parseErrorPayload(body);
  return isStructuredProviderContextOverflow(payload, 'anthropic', status);
}

function parseErrorPayload(body: Uint8Array | null): Record<string, unknown> | null {
  if (!body || body.byteLength === 0 || body.byteLength > MAX_PROVIDER_ERROR_BYTES) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return isPlainRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function stringifyProviderJson(value: unknown, boundary: 'history' | 'request'): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new Error(`Provider ${boundary} did not serialize to JSON text.`);
  }
  return serialized;
}

function normalizeSerializationError(
  error: unknown,
  boundary: 'history' | 'request',
): AgentProviderError {
  if (error instanceof AgentProviderError) return error;
  return new AgentProviderError(
    'provider_serialization_error',
    `Provider ${boundary} could not be serialized safely.`,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function protocolError(message: string): AgentProviderError {
  return new AgentProviderError('protocol_error', truncateUtf8(message, MAX_PROVIDER_ERROR_BYTES));
}
