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
import { isAgentLivenessManagedSignal } from '../liveness';
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

export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

export type OpenAIResponsesConfig = Readonly<{
  model: string;
  apiKey: string;
  endpoint?: string;
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
  endpoint: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  expectedOrigin: string;
  hostPermissionCheck: () => Promise<boolean>;
  validateRuntimeIdentity: () => Promise<boolean>;
  now: () => number;
}>;

type PreparedResponsesRequest = Readonly<{
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

type OutputStateBase = {
  id: string;
  outputIndex: number;
  closed: boolean;
};

type MessagePartState = {
  contentIndex: number;
  kind: 'output_text' | 'refusal';
  parts: string[];
  streamDone: boolean;
  closed: boolean;
};

type MessageOutputState = OutputStateBase & {
  kind: 'message';
  parts: Map<number, MessagePartState>;
};

type FunctionOutputState = OutputStateBase & {
  kind: 'function_call';
  callId: string;
  name: string;
  toolIndex: number;
  argumentParts: string[];
  argumentsDone: boolean;
};

type ReasoningOutputState = OutputStateBase & {
  kind: 'reasoning';
};

type OutputState = MessageOutputState | FunctionOutputState | ReasoningOutputState;

export function createOpenAIResponsesProvider(
  config: OpenAIResponsesConfig,
): ExactRequestModelProvider {
  const runtime = resolveRuntimeConfig(config);
  const prepare = (input: Omit<ModelGenerateInput, 'signal'>): ExactPreparedModelRequest => {
    const prepared = prepareResponsesRequest(runtime, input);
    let executed = false;
    return Object.freeze({
      serializedRequestBody: prepared.requestBody,
      serializedRequestBytes: prepared.requestBytes,
      inspection: prepared.inspection,
      async execute(signal?: AbortSignal): Promise<ModelResponse> {
        if (executed) throw protocolError('A prepared provider request is single-use.');
        executed = true;
        return executePreparedResponsesRequest(runtime, prepared, signal);
      },
    });
  };
  return {
    inspectRequest: (input) => inspectResponsesRequest(runtime, input),
    prepare,
    async generate(input): Promise<ModelResponse> {
      const prepared = prepareResponsesRequest(runtime, input);
      return executePreparedResponsesRequest(runtime, prepared, input.signal);
    },
  };
}

function prepareResponsesRequest(
  config: RuntimeConfig,
  input: Pick<
    ModelGenerateInput,
    'messages' | 'tools' | 'toolChoice' | 'maxOutputTokens' | 'onStreamEvent'
  >,
): PreparedResponsesRequest {
  const serialized = serializeResponsesRequest(config, input);
  assertProviderRequestInspectionAccepted(serialized.inspection);
  return serialized;
}

function inspectResponsesRequest(
  config: RuntimeConfig,
  input: ModelRequestShape,
): ProviderRequestInspection {
  return serializeResponsesRequest(config, input).inspection;
}

function serializeResponsesRequest(
  config: RuntimeConfig,
  input: Pick<
    ModelGenerateInput,
    'messages' | 'tools' | 'toolChoice' | 'maxOutputTokens' | 'onStreamEvent'
  >,
): PreparedResponsesRequest {
  assertAgentProviderExactOrigin(config.expectedOrigin, config.endpoint);
  validateOutputBudget(input.maxOutputTokens);
  try {
    validateProviderProtocolHistory(input.messages);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new AgentProviderError(error.code, error.message);
    }
    throw error;
  }

  let responseInput: ReturnType<typeof toResponsesInput>;
  let serializedHistory: string;
  try {
    responseInput = toResponsesInput(input.messages);
    serializedHistory = stringifyProviderJson(responseInput, 'history');
  } catch (error) {
    throw normalizeSerializationError(error, 'history');
  }
  const historyBytes = utf8ByteLength(serializedHistory);

  let requestBody: string;
  try {
    const tools = input.tools.length > 0 ? input.tools.map(toResponsesTool) : undefined;
    requestBody = stringifyProviderJson({
      model: config.model,
      input: responseInput,
      ...(tools ? { tools } : {}),
      ...(input.toolChoice === undefined
        ? {}
        : { tool_choice: serializeToolChoice(input.toolChoice, input.tools) }),
      max_output_tokens: input.maxOutputTokens,
      stream: true,
      store: false,
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

async function executePreparedResponsesRequest(
  config: RuntimeConfig,
  prepared: PreparedResponsesRequest,
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
    assertAgentProviderExactOrigin(config.expectedOrigin, config.endpoint);

    let response: Response;
    try {
      response = await config.fetchImpl.call(globalThis, config.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: prepared.requestBody,
        signal: deadline.signal,
      });
    } catch (error) {
      throw classifyTransportError(error, deadline);
    }
    if (!response.ok) {
      const body = await readErrorResponseBody(response, deadline);
      const error = isOpenAIContextOverflow(body, response.status)
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
        openAIResponsesStreamEvents(response.body, deadline.signal),
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

async function* openAIResponsesStreamEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  const itemsById = new Map<string, OutputState>();
  const itemsByIndex = new Map<number, OutputState>();
  const callIds = new Set<string>();
  let responseId: string | undefined;
  let started = false;
  let completed = false;
  let nextToolIndex = 0;

  for await (const sseEvent of decodeSseStream(body, { signal })) {
    const eventData = sseEvent.data.trim();
    if (!eventData) continue;
    if (eventData === '[DONE]') {
      if (!completed) {
        throw protocolError('Responses stream ended before response.completed.');
      }
      break;
    }
    if (completed) throw protocolError('Responses stream emitted data after response.completed.');
    const event = parseResponsesEvent(sseEvent.data, sseEvent.event);
    if (requiresTopLevelResponseId(event.type)) {
      validateTopLevelResponseId(event.response_id, responseId);
    }

    switch (event.type) {
      case 'response.created': {
        if (started) throw protocolError('Responses stream emitted response.created more than once.');
        const response = requireRecord(event.response, 'response.created response');
        responseId = requireIdentifier(response.id, 'response ID');
        if (response.status !== 'in_progress' && response.status !== 'queued') {
          throw protocolError('Responses stream started with an invalid response status.');
        }
        started = true;
        yield { type: 'response_start' };
        break;
      }
      case 'response.in_progress':
      case 'response.queued': {
        requireStarted(started);
        validateResponseIdentity(event.response, responseId, event.type);
        break;
      }
      case 'response.output_item.added': {
        requireStarted(started);
        const outputIndex = requireIndex(event.output_index, 'output index');
        const item = requireRecord(event.item, 'output item');
        const id = requireIdentifier(item.id, 'output item ID');
        if (itemsById.has(id) || itemsByIndex.has(outputIndex)) {
          throw protocolError('Responses stream reused an output item identity.');
        }

        let state: OutputState;
        if (item.type === 'message') {
          if (item.role !== 'assistant' || !Array.isArray(item.content) || item.content.length > 0) {
            throw protocolError('Responses stream added a malformed message item.');
          }
          state = { kind: 'message', id, outputIndex, closed: false, parts: new Map() };
        } else if (item.type === 'function_call') {
          const callId = requireIdentifier(item.call_id, 'function call ID');
          const name = requireIdentifier(item.name, 'function name');
          const initialArguments = item.arguments === undefined
            ? ''
            : requireString(item.arguments, 'function arguments');
          if (callIds.has(callId)) throw protocolError('Responses stream reused a function call ID.');
          callIds.add(callId);
          state = {
            kind: 'function_call',
            id,
            outputIndex,
            closed: false,
            callId,
            name,
            toolIndex: nextToolIndex,
            argumentParts: initialArguments ? [initialArguments] : [],
            argumentsDone: false,
          };
          nextToolIndex += 1;
          yield { type: 'tool_call_start', index: state.toolIndex, id: callId, name };
          if (initialArguments) {
            yield {
              type: 'tool_call_arguments_delta',
              index: state.toolIndex,
              delta: initialArguments,
            };
          }
        } else if (item.type === 'reasoning') {
          state = { kind: 'reasoning', id, outputIndex, closed: false };
        } else {
          throw protocolError('Responses stream added an unsupported output item type.');
        }
        itemsById.set(id, state);
        itemsByIndex.set(outputIndex, state);
        break;
      }
      case 'response.content_part.added': {
        requireStarted(started);
        const state = requireOutputState(event, itemsById, itemsByIndex);
        if (state.kind !== 'message' || state.closed) {
          throw protocolError('Responses stream added content to a non-message item.');
        }
        const contentIndex = requireIndex(event.content_index, 'content index');
        if (state.parts.has(contentIndex)) {
          throw protocolError('Responses stream reused a message content index.');
        }
        const part = requireRecord(event.part, 'message content part');
        const kind = parseContentPartKind(part.type);
        const initial = kind === 'output_text'
          ? requireString(part.text, 'output text')
          : requireString(part.refusal, 'refusal');
        const partState: MessagePartState = {
          contentIndex,
          kind,
          parts: initial ? [initial] : [],
          streamDone: false,
          closed: false,
        };
        state.parts.set(contentIndex, partState);
        if (initial) {
          yield kind === 'output_text'
            ? { type: 'text_delta', delta: initial }
            : { type: 'refusal_delta', delta: initial };
        }
        break;
      }
      case 'response.output_text.delta': {
        const part = requireMessagePart(event, 'output_text', itemsById, itemsByIndex);
        const delta = requireNonemptyString(event.delta, 'output text delta');
        part.parts.push(delta);
        yield { type: 'text_delta', delta };
        break;
      }
      case 'response.refusal.delta': {
        const part = requireMessagePart(event, 'refusal', itemsById, itemsByIndex);
        const delta = requireNonemptyString(event.delta, 'refusal delta');
        part.parts.push(delta);
        yield { type: 'refusal_delta', delta };
        break;
      }
      case 'response.output_text.done': {
        const part = requireMessagePart(event, 'output_text', itemsById, itemsByIndex);
        finalizeMessagePartStream(part, event.text, 'output text');
        break;
      }
      case 'response.refusal.done': {
        const part = requireMessagePart(event, 'refusal', itemsById, itemsByIndex);
        finalizeMessagePartStream(part, event.refusal, 'refusal');
        break;
      }
      case 'response.output_text.annotation.added': {
        requireMessagePart(event, 'output_text', itemsById, itemsByIndex);
        break;
      }
      case 'response.content_part.done': {
        const state = requireOutputState(event, itemsById, itemsByIndex);
        if (state.kind !== 'message' || state.closed) {
          throw protocolError('Responses stream completed content for a non-message item.');
        }
        const contentIndex = requireIndex(event.content_index, 'content index');
        const partState = state.parts.get(contentIndex);
        if (!partState || partState.closed || !partState.streamDone) {
          throw protocolError('Responses stream completed an unknown or unfinished content part.');
        }
        const part = requireRecord(event.part, 'completed message content part');
        const kind = parseContentPartKind(part.type);
        const finalText = kind === 'output_text'
          ? requireString(part.text, 'output text')
          : requireString(part.refusal, 'refusal');
        if (kind !== partState.kind || finalText !== partState.parts.join('')) {
          throw protocolError('Responses stream changed completed message content.');
        }
        partState.closed = true;
        break;
      }
      case 'response.function_call_arguments.delta': {
        const state = requireFunctionState(event, itemsById, itemsByIndex);
        const delta = requireNonemptyString(event.delta, 'function arguments delta');
        state.argumentParts.push(delta);
        yield { type: 'tool_call_arguments_delta', index: state.toolIndex, delta };
        break;
      }
      case 'response.function_call_arguments.done': {
        const state = requireFunctionState(event, itemsById, itemsByIndex);
        if (state.argumentsDone) {
          throw protocolError('Responses stream completed function arguments more than once.');
        }
        const finalArguments = requireString(event.arguments, 'completed function arguments');
        const accumulated = state.argumentParts.join('');
        if (!finalArguments.startsWith(accumulated)) {
          throw protocolError('Responses stream changed completed function arguments.');
        }
        const suffix = finalArguments.slice(accumulated.length);
        if (suffix) {
          state.argumentParts.push(suffix);
          yield { type: 'tool_call_arguments_delta', index: state.toolIndex, delta: suffix };
        }
        state.argumentsDone = true;
        break;
      }
      case 'response.output_item.done': {
        const state = requireOutputStateForDone(event, itemsById, itemsByIndex);
        const item = requireRecord(event.item, 'completed output item');
        if (state.kind === 'message') {
          validateCompletedMessageItem(state, item);
        } else if (state.kind === 'function_call') {
          validateCompletedFunctionItem(state, item);
          yield { type: 'tool_call_end', index: state.toolIndex };
        } else if (item.type !== 'reasoning') {
          throw protocolError('Responses stream changed a reasoning item type.');
        }
        state.closed = true;
        break;
      }
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_summary_part.done':
      case 'response.reasoning_text.delta':
      case 'response.reasoning_text.done': {
        requireStarted(started);
        break;
      }
      case 'response.completed': {
        requireStarted(started);
        const response = validateResponseIdentity(event.response, responseId, 'response.completed');
        if (response.status !== 'completed') {
          throw protocolError('Responses stream completed with a non-completed status.');
        }
        for (const state of itemsById.values()) {
          if (!state.closed) throw protocolError('Responses stream completed with an open output item.');
        }
        const usage = parseUsage(response.usage);
        yield { type: 'usage', usage };
        yield {
          type: 'response_end',
          finishReason: nextToolIndex > 0 ? 'tool_calls' : 'stop',
        };
        completed = true;
        break;
      }
      case 'response.failed': {
        requireStarted(started);
        const response = validateResponseIdentity(event.response, responseId, 'response.failed');
        if (response.status !== 'failed') {
          throw protocolError('Responses stream failed with a malformed response.');
        }
        if (isStructuredProviderContextOverflow(response, 'openai')) {
          throw contextOverflowError();
        }
        throw protocolError('Responses stream ended with response.failed.');
      }
      case 'error':
        if (isStructuredProviderContextOverflow(event, 'openai')) {
          throw contextOverflowError();
        }
        throw protocolError('Responses stream ended with error.');
      case 'response.cancelled':
      case 'response.incomplete':
        throw protocolError(`Responses stream ended with ${event.type}.`);
      default:
        throw protocolError('Responses stream emitted an unsupported event type.');
    }
  }

  if (!completed) throw protocolError('Responses stream ended without response.completed.');
}

function toResponsesInput(messages: readonly ModelMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  let assistantMessageIndex = 0;
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      input.push({
        role: message.role,
        content: [{ type: 'input_text', text: message.content }],
      });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) {
        input.push({
          type: 'message',
          id: `msg_bgsm_${assistantMessageIndex}`,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content, annotations: [] }],
        });
        assistantMessageIndex += 1;
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments ?? {}),
        });
      }
      continue;
    }
    input.push({
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    });
  }
  return input;
}

function toResponsesTool(tool: AgentToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    strict: false,
  };
}

function serializeToolChoice(
  choice: ModelToolChoice,
  tools: readonly AgentToolDefinition[],
): unknown {
  if (tools.length === 0) {
    if (choice !== 'auto') throw protocolError('Tool choice requires at least one tool definition.');
    return undefined;
  }
  if (choice === 'auto' || choice === 'required') return choice;
  const name = choice.name.trim();
  if (!name || !tools.some((tool) => tool.name === name)) {
    throw protocolError('Named tool choice must match a declared tool.');
  }
  return { type: 'function', name };
}

function parseResponsesEvent(data: string, eventName?: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new AgentProviderError('parse_error', 'Responses stream event is not valid JSON.');
  }
  const event = requireRecord(value, 'stream event');
  if (typeof event.type !== 'string' || !event.type) {
    throw protocolError('Responses stream event is missing its type.');
  }
  if (eventName !== undefined && eventName !== event.type) {
    throw protocolError('Responses stream SSE event name does not match its payload type.');
  }
  return event;
}

function requireOutputState(
  event: Record<string, unknown>,
  byId: ReadonlyMap<string, OutputState>,
  byIndex: ReadonlyMap<number, OutputState>,
): OutputState {
  const id = requireIdentifier(event.item_id, 'output item ID');
  const outputIndex = requireIndex(event.output_index, 'output index');
  const byItemId = byId.get(id);
  const byOutputIndex = byIndex.get(outputIndex);
  if (!byItemId || byItemId !== byOutputIndex) {
    throw protocolError('Responses stream referenced an unknown or mismatched output item.');
  }
  return byItemId;
}

function requireOutputStateForDone(
  event: Record<string, unknown>,
  byId: ReadonlyMap<string, OutputState>,
  byIndex: ReadonlyMap<number, OutputState>,
): OutputState {
  const outputIndex = requireIndex(event.output_index, 'output index');
  const item = requireRecord(event.item, 'completed output item');
  const id = requireIdentifier(item.id, 'output item ID');
  const byItemId = byId.get(id);
  const byOutputIndex = byIndex.get(outputIndex);
  if (!byItemId || byItemId !== byOutputIndex || byItemId.closed) {
    throw protocolError('Responses stream completed an unknown or closed output item.');
  }
  return byItemId;
}

function requireMessagePart(
  event: Record<string, unknown>,
  kind: MessagePartState['kind'],
  byId: ReadonlyMap<string, OutputState>,
  byIndex: ReadonlyMap<number, OutputState>,
): MessagePartState {
  const state = requireOutputState(event, byId, byIndex);
  const contentIndex = requireIndex(event.content_index, 'content index');
  if (state.kind !== 'message' || state.closed) {
    throw protocolError('Responses stream referenced a non-message output item.');
  }
  const part = state.parts.get(contentIndex);
  if (!part || part.kind !== kind || part.closed || part.streamDone) {
    throw protocolError('Responses stream referenced an unknown or completed message part.');
  }
  return part;
}

function requireFunctionState(
  event: Record<string, unknown>,
  byId: ReadonlyMap<string, OutputState>,
  byIndex: ReadonlyMap<number, OutputState>,
): FunctionOutputState {
  const state = requireOutputState(event, byId, byIndex);
  if (state.kind !== 'function_call' || state.closed || state.argumentsDone) {
    throw protocolError('Responses stream referenced an unknown or completed function call.');
  }
  return state;
}

function finalizeMessagePartStream(
  part: MessagePartState,
  finalValue: unknown,
  label: string,
): void {
  const finalText = requireString(finalValue, label);
  if (part.streamDone || finalText !== part.parts.join('')) {
    throw protocolError(`Responses stream changed completed ${label}.`);
  }
  part.streamDone = true;
}

function validateCompletedMessageItem(
  state: MessageOutputState,
  item: Record<string, unknown>,
): void {
  const content = item.content;
  if (
    item.type !== 'message'
    || item.role !== 'assistant'
    || item.status !== 'completed'
    || !Array.isArray(content)
    || content.length !== state.parts.size
  ) {
    throw protocolError('Responses stream completed a malformed message item.');
  }
  const indexes = [...state.parts.keys()].sort((left, right) => left - right);
  indexes.forEach((index, expected) => {
    if (index !== expected) {
      throw protocolError('Responses stream message content indexes are not contiguous.');
    }
    const partState = state.parts.get(index)!;
    const part = requireRecord(content[index], 'completed message content part');
    const kind = parseContentPartKind(part.type);
    const finalText = kind === 'output_text'
      ? requireString(part.text, 'output text')
      : requireString(part.refusal, 'refusal');
    if (!partState.closed || kind !== partState.kind || finalText !== partState.parts.join('')) {
      throw protocolError('Responses stream changed a completed message item.');
    }
  });
}

function validateCompletedFunctionItem(
  state: FunctionOutputState,
  item: Record<string, unknown>,
): void {
  if (
    item.type !== 'function_call'
    || item.call_id !== state.callId
    || item.name !== state.name
    || item.arguments !== state.argumentParts.join('')
    || (item.status !== undefined && item.status !== 'completed')
    || !state.argumentsDone
  ) {
    throw protocolError('Responses stream completed a malformed function call.');
  }
}

function validateResponseIdentity(
  value: unknown,
  expectedId: string | undefined,
  label: string,
): Record<string, unknown> {
  const response = requireRecord(value, `${label} response`);
  const id = requireIdentifier(response.id, 'response ID');
  if (!expectedId || id !== expectedId) {
    throw protocolError('Responses stream changed its response identity.');
  }
  return response;
}

function requiresTopLevelResponseId(type: unknown): boolean {
  return typeof type === 'string' && (
    type.startsWith('response.output_item.')
    || type.startsWith('response.content_part.')
    || type.startsWith('response.output_text.')
    || type.startsWith('response.refusal.')
    || type.startsWith('response.function_call_arguments.')
    || type.startsWith('response.reasoning_')
  );
}

function validateTopLevelResponseId(value: unknown, expectedId: string | undefined): void {
  // Compatible Responses gateways may omit this redundant field while preserving item identity.
  if (value === undefined) return;
  const id = requireIdentifier(value, 'response ID');
  if (!expectedId || id !== expectedId) {
    throw protocolError('Responses stream event does not belong to the active response.');
  }
}

function parseUsage(value: unknown): ModelUsage {
  const usage = requireRecord(value, 'usage');
  const inputTokens = requireTokenCount(usage.input_tokens, 'input tokens');
  const outputTokens = requireTokenCount(usage.output_tokens, 'output tokens');
  const totalTokens = requireTokenCount(usage.total_tokens, 'total tokens');
  const inputDetails = optionalUsageDetails(usage.input_tokens_details, 'input token details');
  const outputDetails = optionalUsageDetails(usage.output_tokens_details, 'output token details');
  const cachedInputTokens = optionalTokenCount(
    inputDetails?.cached_tokens,
    'cached input tokens',
  );
  const cacheCreationInputTokens = optionalTokenCount(
    inputDetails?.cache_write_tokens,
    'cache creation input tokens',
  );
  const reasoningOutputTokens = optionalTokenCount(
    outputDetails?.reasoning_tokens,
    'reasoning output tokens',
  );
  if (
    inputTokens + outputTokens !== totalTokens
    || (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) > inputTokens
    || (reasoningOutputTokens ?? 0) > outputTokens
  ) {
    throw protocolError('Responses stream emitted inconsistent usage.');
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

function optionalUsageDetails(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return requireRecord(value, label);
}

function optionalTokenCount(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireTokenCount(value, label);
}

function parseContentPartKind(value: unknown): MessagePartState['kind'] {
  if (value === 'output_text' || value === 'refusal') return value;
  throw protocolError('Responses stream emitted an unsupported message content part.');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw protocolError(`Responses ${label} must be an object.`);
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw protocolError(`Responses stream emitted an invalid ${label}.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw protocolError(`Responses stream emitted invalid ${label}.`);
  }
  return value;
}

function requireNonemptyString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!result) throw protocolError(`Responses stream emitted an empty ${label}.`);
  return result;
}

function requireIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw protocolError(`Responses stream emitted an invalid ${label}.`);
  }
  return Number(value);
}

function requireTokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw protocolError(`Responses stream emitted invalid ${label}.`);
  }
  return Number(value);
}

function requireStarted(started: boolean): void {
  if (!started) throw protocolError('Responses stream emitted data before response.created.');
}

function resolveRuntimeConfig(config: OpenAIResponsesConfig): RuntimeConfig {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error(AGENT_API_KEY_EMPTY);
  const model = config.model.trim();
  if (!model) throw new Error(AGENT_MODEL_EMPTY);
  const requestTimeoutMs = config.requestTimeoutMs ?? AGENT_PROVIDER_DEADLINE_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw protocolError('Provider request timeout must be a positive safe integer.');
  }
  const endpoint = config.endpoint ?? OPENAI_RESPONSES_ENDPOINT;
  const expectedOrigin = config.expectedOrigin ?? new URL(endpoint).origin;
  assertAgentProviderExactOrigin(expectedOrigin, endpoint);
  return Object.freeze({
    model,
    apiKey,
    endpoint,
    fetchImpl: config.fetchImpl ?? fetch,
    requestTimeoutMs,
    expectedOrigin,
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

function isOpenAIContextOverflow(body: Uint8Array | null, status: number): boolean {
  const payload = parseErrorPayload(body);
  return isStructuredProviderContextOverflow(payload, 'openai', status);
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
