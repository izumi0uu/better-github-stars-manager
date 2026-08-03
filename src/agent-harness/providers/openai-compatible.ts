import {
  AGENT_API_KEY_EMPTY,
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_HOST_PERMISSION_DENIED,
  AGENT_MODEL_EMPTY,
  AGENT_PROVIDER_IDENTITY_CHANGED,
  AGENT_PROVIDER_UNSUPPORTED,
  AGENT_PROVIDER_TIMEOUT,
} from '@/api/errors';
import type { AgentProviderId } from '@/types';
import {
  buildProviderHeaders,
  getProvider,
  normalizeAgentModel,
  normalizeAgentProvider,
  resolveOpenAICompatibleEndpoint,
  type AgentProviderEndpoint,
  type AgentProviderProfile,
} from '../models';
import { assertAgentProviderExactOrigin, hasAgentProviderHostPermission } from '../provider-access';
import { isAgentLivenessManagedSignal } from '../liveness';
import type { ModelMessage } from '../messages';
import {
  AGENT_PROVIDER_DEADLINE_MS,
  AGENT_PROVIDER_PROBE_DEADLINE_MS,
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
  type ProviderRequestInspection,
} from '../provider';
import {
  aggregateModelStream,
  type ModelStreamEvent,
  type ModelStreamObserver,
} from '../provider-stream';
import { decodeSseStream } from '../sse';
import type { AgentToolDefinition } from '../tools';
import { ProtocolValidationError, validateProviderProtocolHistory } from '../protocol';

export type OpenAICompatibleConfig = {
  provider: AgentProviderId;
  baseUrl?: string | null;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  expectedOrigin?: string;
  hostPermissionCheck?: (endpoint: AgentProviderEndpoint) => Promise<boolean>;
  validateRuntimeIdentity?: () => Promise<boolean>;
  now?: () => number;
};

type RuntimeConfig = {
  provider: AgentProviderId;
  endpoint: AgentProviderEndpoint & {
    profile: Extract<AgentProviderProfile, { adapter: 'openai-compatible' }>;
  };
  model: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  expectedOrigin?: string;
  hostPermissionCheck: (endpoint: AgentProviderEndpoint) => Promise<boolean>;
  validateRuntimeIdentity: () => Promise<boolean>;
  now: () => number;
};

type OpenAICompatibleUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  prompt_tokens_details?: unknown;
  completion_tokens_details?: unknown;
};

type OpenAICompatibleStreamToolCall = {
  index?: unknown;
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
};

type OpenAICompatibleStreamChoice = {
  index?: unknown;
  finish_reason?: unknown;
  delta?: {
    content?: unknown;
    refusal?: unknown;
    role?: unknown;
    tool_calls?: unknown;
  };
};

type OpenAICompatibleStreamChunk = {
  choices?: unknown;
  usage?: OpenAICompatibleUsage | null;
  error?: unknown;
};

type PendingOpenAIStreamToolCall = {
  id?: string;
  name?: string;
  started: boolean;
  pendingArgumentDeltas: string[];
};

type RequestDeadline = {
  signal: AbortSignal;
  expiresAt: number;
  readonly timedOut: boolean;
  readonly callerAborted: boolean;
  expireIfNeeded(): void;
  dispose(): void;
};

type PreparedChatCompletion = Readonly<{
  requestBody: string;
  requestBytes: number;
  inspection: ProviderRequestInspection;
  observer?: ModelStreamObserver;
}>;

type OpenAICompatibleConnectionResult = {
  provider: AgentProviderId;
  providerLabel: string;
  model: string;
  latencyMs: number;
  preview: string;
  canonicalOrigin: string;
  completionEndpoint: string;
  profileIdentityVersion: string;
  capabilities: Readonly<{
    textChat: true;
    namedToolRoundTrip: true;
  }>;
};

const PROBE_TOOL_NAME = 'bgsm_connection_probe';

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
): ExactRequestModelProvider {
  const runtime = resolveRuntimeConfig(config);
  const prepare = (input: Omit<ModelGenerateInput, 'signal'>): ExactPreparedModelRequest => {
    const prepared = prepareChatCompletion(runtime, input);
    let executed = false;
    return Object.freeze({
      serializedRequestBody: prepared.requestBody,
      serializedRequestBytes: prepared.requestBytes,
      inspection: prepared.inspection,
      async execute(signal?: AbortSignal): Promise<ModelResponse> {
        if (executed) throw protocolError('A prepared provider request is single-use.');
        executed = true;
        return executePreparedChatCompletion(runtime, prepared, { signal });
      },
    });
  };
  return {
    inspectRequest: (input) => inspectChatCompletion(runtime, input),
    prepare,
    async generate(input): Promise<ModelResponse> {
      return requestChatCompletion(runtime, {
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
        maxOutputTokens: input.maxOutputTokens,
        signal: input.signal,
        onStreamEvent: input.onStreamEvent,
      });
    },
  };
}

export async function testOpenAICompatibleConnection(
  config: OpenAICompatibleConfig,
): Promise<OpenAICompatibleConnectionResult> {
  const runtime = resolveRuntimeConfig(config);
  const startedAt = Date.now();
  const deadline = createDeadline(
    undefined,
    AGENT_PROVIDER_PROBE_DEADLINE_MS,
    runtime.now,
  );
  const probeTool: AgentToolDefinition = {
    name: PROBE_TOOL_NAME,
    description: 'Return the provided connection-test nonce.',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { nonce: { type: 'string' } },
      required: ['nonce'],
      additionalProperties: false,
    },
  };
  const userMessage: ModelMessage = {
    role: 'user',
    content: `Call ${PROBE_TOOL_NAME} with nonce "bgsm", then acknowledge its result.`,
  };

  try {
    const toolResponse = await requestChatCompletion(runtime, {
      messages: [userMessage],
      tools: [probeTool],
      toolChoice: { name: PROBE_TOOL_NAME },
      maxOutputTokens: 64,
      deadline,
    });
    if (
      toolResponse.finishReason !== 'tool_calls' ||
      toolResponse.toolCalls?.length !== 1 ||
      toolResponse.toolCalls[0].name !== PROBE_TOOL_NAME
    ) {
      throw protocolError('The provider did not complete the named tool capability probe.');
    }
    const probeCall = toolResponse.toolCalls[0];
    if (!isExactProbeArguments(probeCall.arguments)) {
      throw protocolError('The provider returned invalid named tool probe arguments.');
    }
    const acknowledgement = await requestChatCompletion(runtime, {
      messages: [
        userMessage,
        {
          role: 'assistant',
          content: toolResponse.content ?? '',
          toolCalls: [probeCall],
        },
        {
          role: 'tool',
          content: '{"ok":true,"data":{"nonce":"bgsm"}}',
          toolCallId: probeCall.id,
          toolName: probeCall.name,
        },
      ],
      tools: [probeTool],
      toolChoice: 'auto',
      maxOutputTokens: 32,
      deadline,
    });
    const preview = acknowledgement.content?.trim();
    if (
      acknowledgement.finishReason !== 'stop' ||
      acknowledgement.toolCalls?.length ||
      !preview
    ) {
      throw protocolError('The provider returned an empty or invalid probe acknowledgement.');
    }
    return {
      provider: runtime.provider,
      providerLabel: getProvider(runtime.provider).label,
      model: runtime.model,
      latencyMs: Date.now() - startedAt,
      preview,
      canonicalOrigin: runtime.endpoint.canonicalOrigin,
      completionEndpoint: runtime.endpoint.completionEndpoint,
      profileIdentityVersion: runtime.endpoint.profile.identityVersion,
      capabilities: {
        textChat: true,
        namedToolRoundTrip: true,
      },
    };
  } finally {
    deadline.dispose();
  }
}

async function requestChatCompletion(
  config: RuntimeConfig,
  input: {
    messages: ModelMessage[];
    tools: AgentToolDefinition[];
    toolChoice?: ModelToolChoice;
    maxOutputTokens: number;
    signal?: AbortSignal;
    onStreamEvent?: ModelStreamObserver;
    deadline?: RequestDeadline;
  },
): Promise<ModelResponse> {
  const deadline = input.deadline ?? createDeadline(
    input.signal,
    isAgentLivenessManagedSignal(input.signal) ? undefined : config.requestTimeoutMs,
    config.now,
  );
  const ownsDeadline = !input.deadline;
  try {
    throwIfAborted(deadline);
    const prepared = prepareChatCompletion(config, input);
    throwIfAborted(deadline);
    return await executePreparedChatCompletion(config, prepared, { deadline });
  } finally {
    if (ownsDeadline) deadline.dispose();
  }
}

function prepareChatCompletion(
  config: RuntimeConfig,
  input: Pick<
    ModelGenerateInput,
    'messages' | 'tools' | 'toolChoice' | 'maxOutputTokens' | 'onStreamEvent'
  >,
): PreparedChatCompletion {
  const serialized = serializeChatCompletion(config, input);
  assertProviderRequestInspectionAccepted(serialized.inspection);
  return serialized;
}

function inspectChatCompletion(
  config: RuntimeConfig,
  input: ModelRequestShape,
): ProviderRequestInspection {
  return serializeChatCompletion(config, input).inspection;
}

function serializeChatCompletion(
  config: RuntimeConfig,
  input: Pick<
    ModelGenerateInput,
    'messages' | 'tools' | 'toolChoice' | 'maxOutputTokens' | 'onStreamEvent'
  >,
): PreparedChatCompletion {
  assertAgentProviderExactOrigin(
    config.expectedOrigin ?? config.endpoint.canonicalOrigin,
    config.endpoint.completionEndpoint,
  );
  validateOutputBudget(input.maxOutputTokens);
  try {
    validateProviderProtocolHistory(input.messages);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new AgentProviderError(error.code, error.message);
    }
    throw error;
  }
  let messages: ReturnType<typeof toApiMessage>[];
  let serializedHistory: string;
  try {
    messages = input.messages.map(toApiMessage);
    serializedHistory = stringifyProviderJson(messages, 'history');
  } catch (error) {
    throw normalizeSerializationError(error, 'history');
  }
  const historyBytes = utf8Bytes(serializedHistory);
  let requestBody: string;
  try {
    const tools = input.tools.length > 0 ? input.tools.map(toApiTool) : undefined;
    const toolChoice = serializeToolChoice(input.toolChoice, input.tools);
    const requestValue: Record<string, unknown> = {
      model: config.model,
      messages,
      tools,
      tool_choice: toolChoice,
      stream: true,
      ...(config.provider === 'custom-openai-compatible'
        ? {}
        : { stream_options: { include_usage: true } }),
      [config.endpoint.profile.outputTokenField]: input.maxOutputTokens,
    };
    requestBody = stringifyProviderJson(requestValue, 'request');
  } catch (error) {
    throw normalizeSerializationError(error, 'request');
  }
  const requestBytes = utf8Bytes(requestBody);
  return Object.freeze({
    requestBody,
    requestBytes,
    inspection: inspectProviderRequestBytes(historyBytes, requestBytes),
    ...(input.onStreamEvent ? { observer: input.onStreamEvent } : {}),
  });
}

async function executePreparedChatCompletion(
  config: RuntimeConfig,
  prepared: PreparedChatCompletion,
  input: Readonly<{ signal?: AbortSignal; deadline?: RequestDeadline }>,
): Promise<ModelResponse> {
  const deadline = input.deadline ?? createDeadline(
    input.signal,
    isAgentLivenessManagedSignal(input.signal) ? undefined : config.requestTimeoutMs,
    config.now,
  );
  const ownsDeadline = !input.deadline;
  try {
    throwIfAborted(deadline);
    if (!await waitForAuthorityCheck(
      config.hostPermissionCheck(config.endpoint),
      deadline,
    )) {
      throw new Error(AGENT_HOST_PERMISSION_DENIED);
    }
    throwIfAborted(deadline);
    if (!await waitForAuthorityCheck(
      config.validateRuntimeIdentity(),
      deadline,
    )) {
      throw new Error(AGENT_PROVIDER_IDENTITY_CHANGED);
    }
    throwIfAborted(deadline);
    assertAgentProviderExactOrigin(
      config.expectedOrigin ?? config.endpoint.canonicalOrigin,
      config.endpoint.completionEndpoint,
    );

    let response: Response;
    try {
      response = await config.fetchImpl.call(
        globalThis,
        config.endpoint.completionEndpoint,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
            ...buildProviderHeaders(config.provider),
          },
          body: prepared.requestBody,
          signal: deadline.signal,
        },
      );
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
      throwIfAborted(deadline);
      throw new AgentProviderError(
        'protocol_error',
        'Provider streaming response must use text/event-stream.',
      );
    }
    if (!response.body) {
      throw new AgentProviderError('parse_error', 'Provider stream body is empty.');
    }
    try {
      const result = await aggregateModelStream(
        openAIChatStreamEvents(response.body, deadline.signal),
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
    if (ownsDeadline) deadline.dispose();
  }
}

function resolveRuntimeConfig(config: OpenAICompatibleConfig): RuntimeConfig {
  const provider = normalizeAgentProvider(config.provider);
  const endpoint = resolveOpenAICompatibleEndpoint(provider, config.baseUrl);
  if (endpoint.profile.adapter !== 'openai-compatible') {
    throw new Error(AGENT_PROVIDER_UNSUPPORTED);
  }
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error(AGENT_API_KEY_EMPTY);
  const model = normalizeAgentModel(provider, config.model);
  if (!model.trim()) throw new Error(AGENT_MODEL_EMPTY);
  return {
    provider,
    endpoint: endpoint as RuntimeConfig['endpoint'],
    model,
    apiKey,
    fetchImpl: config.fetchImpl ?? fetch,
    requestTimeoutMs: config.requestTimeoutMs ?? AGENT_PROVIDER_DEADLINE_MS,
    expectedOrigin: config.expectedOrigin,
    validateRuntimeIdentity: config.validateRuntimeIdentity ?? (async () => true),
    now: config.now ?? Date.now,
    hostPermissionCheck: config.hostPermissionCheck ?? (async (candidate) => {
      if (candidate.provider !== 'custom-openai-compatible') return true;
      if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
      return hasAgentProviderHostPermission(
        candidate.provider,
        candidate.canonicalBaseUrl,
      );
    }),
  };
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
  const timer = timeoutMs === undefined ? null : setTimeout(() => {
    expire();
  }, timeoutMs);
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
  if (deadline.timedOut) {
    return new AgentProviderError('timeout', AGENT_PROVIDER_TIMEOUT);
  }
  if (deadline.callerAborted || deadline.signal.aborted) {
    return new AgentProviderError('caller_abort', 'AI provider request was aborted.');
  }
  if (error instanceof AgentProviderError) return error;
  return new AgentProviderError('network_error', 'AI provider network request failed.');
}
function isAuthorityFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return error.message === AGENT_DATA_DISCLOSURE_REQUIRED ||
    error.message === AGENT_HOST_PERMISSION_DENIED ||
    error.message === AGENT_PROVIDER_IDENTITY_CHANGED;
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


function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('Content-Type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase() === 'text/event-stream';
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
      // Cancellation may still be settling; ownership has already been released by cancel().
    }
  }
  if (overflowed) return null;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function assertDeclaredResponseLength(response: Response): void {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (!Number.isFinite(declaredLength) || declaredLength <= MAX_PROVIDER_RESPONSE_BYTES) return;
  void response.body?.cancel().catch(() => undefined);
  throw new AgentProviderError(
    'provider_response_too_large',
    `Provider response exceeds the ${MAX_PROVIDER_RESPONSE_BYTES}-byte limit.`,
  );
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

function toApiMessage(message: ModelMessage) {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments ?? {}),
        },
      })),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  return { role: message.role, content: message.content };
}

function toApiTool(tool: AgentToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    },
  };
}

function serializeToolChoice(
  choice: ModelToolChoice | undefined,
  tools: AgentToolDefinition[],
): unknown {
  if (tools.length === 0) {
    if (choice && choice !== 'auto') {
      throw protocolError('Tool choice requires at least one tool definition.');
    }
    return undefined;
  }
  const resolved = choice ?? 'auto';
  if (resolved === 'auto' || resolved === 'required') return resolved;
  const name = resolved.name.trim();
  if (!name || !tools.some((tool) => tool.name === name)) {
    throw protocolError('Named tool choice must match a declared tool.');
  }
  return { type: 'function', function: { name } };
}

function validateOutputBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PROVIDER_OUTPUT_TOKENS) {
    throw protocolError(`Output-token budget must be between 1 and ${MAX_PROVIDER_OUTPUT_TOKENS}.`);
  }
}

async function* openAIChatStreamEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  const toolCalls = new Map<number, PendingOpenAIStreamToolCall>();
  let finishReason: string | undefined;
  let sawUsage = false;
  let sawProviderTerminal = false;

  yield { type: 'response_start' };
  for await (const event of decodeSseStream(body, { signal })) {
    const eventData = event.data.trim();
    if (!eventData) continue;
    if (eventData === '[DONE]') {
      sawProviderTerminal = true;
      break;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      throw new AgentProviderError('parse_error', 'Provider stream event is not valid JSON.');
    }
    if (!isPlainRecord(payload)) {
      throw protocolError('Provider stream event must be a JSON object.');
    }
    const chunk = payload as OpenAICompatibleStreamChunk;
    if ('error' in chunk && chunk.error != null) {
      if (isStructuredProviderContextOverflow(payload, 'openai')) {
        throw contextOverflowError();
      }
      throw protocolError('Provider returned an error event with a successful HTTP status.');
    }
    if (!Array.isArray(chunk.choices)) {
      throw protocolError('Provider stream event is missing choices.');
    }
    if (chunk.choices.length === 0) {
      if (chunk.usage == null) {
        throw protocolError('Provider stream emitted an empty choice event without usage.');
      }
      if (finishReason === undefined) {
        throw protocolError('Provider stream emitted usage before its finish reason.');
      }
      if (sawUsage) {
        throw protocolError('Provider stream emitted usage more than once.');
      }
      sawUsage = true;
      yield { type: 'usage', usage: parseStreamUsage(chunk.usage) };
      continue;
    }
    if (chunk.usage != null) {
      throw protocolError('Provider stream usage event must not contain choices.');
    }
    if (finishReason !== undefined || sawUsage) {
      throw protocolError('Provider stream emitted choice data after its finish reason.');
    }
    if (chunk.choices.length !== 1 || !isPlainRecord(chunk.choices[0])) {
      throw protocolError('Provider stream must contain exactly one choice.');
    }
    const choice = chunk.choices[0] as OpenAICompatibleStreamChoice;
    if (choice.index !== undefined && choice.index !== 0) {
      throw protocolError('Provider stream returned an unexpected choice index.');
    }
    if (!isPlainRecord(choice.delta)) {
      throw protocolError('Provider stream choice is missing its delta object.');
    }
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== 'assistant') {
      throw protocolError('Provider stream returned an unexpected message role.');
    }
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') {
        throw protocolError('Provider stream content delta has an invalid shape.');
      }
      if (delta.content.length > 0) yield { type: 'text_delta', delta: delta.content };
    }
    if (delta.refusal !== undefined && delta.refusal !== null) {
      if (typeof delta.refusal !== 'string') {
        throw protocolError('Provider stream refusal delta has an invalid shape.');
      }
      if (delta.refusal.length > 0) yield { type: 'refusal_delta', delta: delta.refusal };
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) {
        throw protocolError('Provider stream tool-call deltas have an invalid shape.');
      }
      for (const value of delta.tool_calls) {
        if (!isPlainRecord(value)) {
          throw protocolError('Provider stream returned a malformed tool-call delta.');
        }
        const toolCall = value as OpenAICompatibleStreamToolCall;
        const index = parseStreamToolIndex(toolCall.index);
        const pending = toolCalls.get(index) ?? {
          started: false,
          pendingArgumentDeltas: [],
        };
        toolCalls.set(index, pending);
        if (toolCall.type !== undefined && toolCall.type !== 'function') {
          throw protocolError('Provider stream returned an unsupported tool-call type.');
        }
        pending.id = mergeStreamToolIdentifier(pending.id, toolCall.id, 'ID');
        pending.name = mergeStreamToolIdentifier(
          pending.name,
          toolCall.function?.name,
          'name',
        );
        const argumentsDelta = toolCall.function?.arguments;
        if (argumentsDelta !== undefined) {
          if (typeof argumentsDelta !== 'string') {
            throw protocolError('Provider stream tool arguments delta has an invalid shape.');
          }
          if (argumentsDelta.length > 0) {
            pending.pendingArgumentDeltas.push(argumentsDelta);
          }
        }
        if (!pending.started && pending.id && pending.name) {
          pending.started = true;
          yield { type: 'tool_call_start', index, id: pending.id, name: pending.name };
        }
        if (pending.started) {
          for (const argumentDelta of pending.pendingArgumentDeltas) {
            yield { type: 'tool_call_arguments_delta', index, delta: argumentDelta };
          }
          pending.pendingArgumentDeltas = [];
        }
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== 'string' || finishReason !== undefined) {
        throw protocolError('Provider stream emitted an invalid finish reason.');
      }
      finishReason = choice.finish_reason;
    }
  }

  if (!sawProviderTerminal) {
    throw protocolError('Provider stream ended without data: [DONE].');
  }
  if (finishReason === undefined) {
    throw protocolError('Provider stream ended without a finish reason.');
  }
  for (const [index, pending] of [...toolCalls.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    if (!pending.started || pending.pendingArgumentDeltas.length > 0) {
      throw protocolError('Provider stream ended with incomplete tool-call identity.');
    }
    yield { type: 'tool_call_end', index };
  }
  yield { type: 'response_end', finishReason };
}

function parseStreamToolIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw protocolError('Provider stream returned an invalid tool-call index.');
  }
  return Number(value);
}

function mergeStreamToolIdentifier(
  current: string | undefined,
  value: unknown,
  label: 'ID' | 'name',
): string | undefined {
  if (value === undefined) return current;
  if (typeof value !== 'string' || !value.trim()) {
    throw protocolError(`Provider stream tool-call ${label} has an invalid shape.`);
  }
  const resolved = value.trim();
  if (current !== undefined && current !== resolved) {
    throw protocolError(`Provider stream tool-call ${label} changed between deltas.`);
  }
  return resolved;
}

function parseStreamUsage(usage: NonNullable<OpenAICompatibleStreamChunk['usage']>) {
  const inputTokens = normalizeTokenCount(usage.prompt_tokens);
  const outputTokens = normalizeTokenCount(usage.completion_tokens);
  const totalTokens = normalizeTokenCount(usage.total_tokens);
  const promptDetails = normalizeOptionalUsageDetails(
    usage.prompt_tokens_details,
    'prompt token details',
  );
  const completionDetails = normalizeOptionalUsageDetails(
    usage.completion_tokens_details,
    'completion token details',
  );
  const cachedInputTokens = normalizeOptionalTokenCount(
    promptDetails?.cached_tokens,
    'cached input tokens',
  );
  const cacheCreationInputTokens = normalizeOptionalTokenCount(
    promptDetails?.cache_write_tokens,
    'cache creation input tokens',
  );
  const reasoningOutputTokens = normalizeOptionalTokenCount(
    completionDetails?.reasoning_tokens,
    'reasoning output tokens',
  );
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    totalTokens !== inputTokens + outputTokens
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

function normalizeOptionalUsageDetails(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainRecord(value)) throw protocolError(`Provider stream emitted invalid ${label}.`);
  return value;
}

function normalizeOptionalTokenCount(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const count = normalizeTokenCount(value);
  if (count === null) throw protocolError(`Provider stream emitted invalid ${label}.`);
  return count;
}

function isExactProbeArguments(value: unknown): value is { nonce: 'bgsm' } {
  return isPlainRecord(value) &&
    Object.keys(value).length === 1 &&
    value.nonce === 'bgsm';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function normalizeTokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
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

function protocolError(message: string): AgentProviderError {
  return new AgentProviderError('protocol_error', boundUtf8(message, MAX_PROVIDER_ERROR_BYTES));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = '...';
  let result = '';
  for (const character of value) {
    if (utf8Bytes(result + character + suffix) > maxBytes) break;
    result += character;
  }
  return result + suffix;
}
