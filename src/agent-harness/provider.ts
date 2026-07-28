import type { ModelMessage } from './messages';
import type { ModelStreamObserver } from './provider-stream';
import type { AgentToolDefinition } from './tools';

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ModelToolChoice = 'auto' | 'required' | Readonly<{ name: string }>;

export type ModelResponse = {
  content?: string;
  toolCalls?: ModelToolCall[];
  finishReason?: string;
  refusal?: string;
  usage?: ModelUsage;
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Input-token subsets already included in inputTokens. */
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Output-token subset already included in outputTokens. */
  reasoningOutputTokens?: number;
};

export type ModelGenerateInput = {
  messages: ModelMessage[];
  tools: AgentToolDefinition[];
  toolChoice?: ModelToolChoice;
  maxOutputTokens: number;
  signal?: AbortSignal;
  onStreamEvent?: ModelStreamObserver;
};

export type ModelRequestShape = Pick<
  ModelGenerateInput,
  'messages' | 'tools' | 'toolChoice' | 'maxOutputTokens'
>;

export type ProviderRequestByteFailure =
  | 'provider_history_too_large'
  | 'provider_request_too_large';

export type ProviderRequestInspection = Readonly<{
  serializedHistoryBytes: number;
  serializedRequestBytes: number;
  historyByteLimit: number;
  requestByteLimit: number;
  accepted: boolean;
  failure?: ProviderRequestByteFailure;
}>;

export type PreparedModelRequest = Readonly<{
  serializedRequestBody: string;
  serializedRequestBytes: number;
  inspection?: ProviderRequestInspection;
  execute(signal?: AbortSignal): Promise<ModelResponse>;
}>;

export type ModelProvider = {
  generate(input: ModelGenerateInput): Promise<ModelResponse>;
  /** Synchronously inspects the exact adapter projection without sending it. */
  inspectRequest?(input: ModelRequestShape): ProviderRequestInspection;
  /** Synchronously prepares without I/O; each returned request is single-use. */
  prepare?(input: Omit<ModelGenerateInput, 'signal'>): PreparedModelRequest;
};

export type ExactPreparedModelRequest = Omit<PreparedModelRequest, 'inspection'> & Readonly<{
  inspection: ProviderRequestInspection;
}>;

/** Production adapters expose exact byte admission for the body they will send. */
export type ExactRequestModelProvider = Omit<ModelProvider, 'inspectRequest' | 'prepare'> & {
  inspectRequest(input: ModelRequestShape): ProviderRequestInspection;
  prepare(input: Omit<ModelGenerateInput, 'signal'>): ExactPreparedModelRequest;
};

export const MAX_PROVIDER_HISTORY_BYTES = 512 * 1024;
export const MAX_PROVIDER_REQUEST_BYTES = 768 * 1024;
export const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
export const MAX_PROVIDER_ERROR_BYTES = 4 * 1024;
export const MAX_PROVIDER_OUTPUT_TOKENS = 8192;
export const AGENT_PROVIDER_DEADLINE_MS = 45_000;
export const AGENT_PROVIDER_PROBE_DEADLINE_MS = 20_000;

export function inspectProviderRequestBytes(
  serializedHistoryBytes: number,
  serializedRequestBytes: number,
): ProviderRequestInspection {
  const failure = serializedHistoryBytes > MAX_PROVIDER_HISTORY_BYTES
    ? 'provider_history_too_large' as const
    : serializedRequestBytes > MAX_PROVIDER_REQUEST_BYTES
      ? 'provider_request_too_large' as const
      : undefined;
  return Object.freeze({
    serializedHistoryBytes,
    serializedRequestBytes,
    historyByteLimit: MAX_PROVIDER_HISTORY_BYTES,
    requestByteLimit: MAX_PROVIDER_REQUEST_BYTES,
    accepted: failure === undefined,
    ...(failure ? { failure } : {}),
  });
}

export function assertProviderRequestInspectionAccepted(
  inspection: ProviderRequestInspection,
): void {
  if (inspection.accepted) return;
  if (inspection.failure === 'provider_history_too_large') {
    throw new AgentProviderError(
      inspection.failure,
      `Provider protocol history exceeds the ${inspection.historyByteLimit}-byte limit.`,
    );
  }
  throw new AgentProviderError(
    'provider_request_too_large',
    `Provider request exceeds the ${inspection.requestByteLimit}-byte limit.`,
  );
}

export type AgentProviderErrorCode =
  | 'caller_abort'
  | 'timeout'
  | 'provider_response_too_large'
  | 'network_error'
  | 'http_error'
  | 'context_overflow'
  | 'parse_error'
  | 'protocol_error'
  | 'provider_history_too_large'
  | 'provider_request_too_large'
  | 'provider_serialization_error';

export class AgentProviderError extends Error {
  readonly code: AgentProviderErrorCode;
  readonly status?: number;

  constructor(code: AgentProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AgentProviderError';
    this.code = code;
    this.status = status;
  }
}
export function publicAgentProviderErrorMessage(error: unknown): string {
  if (!(error instanceof AgentProviderError)) return 'AI provider request failed.';
  switch (error.code) {
    case 'caller_abort':
      return 'AI provider request was stopped.';
    case 'timeout':
      return 'AI provider request timed out.';
    case 'provider_response_too_large':
      return 'AI provider response exceeded the supported size.';
    case 'provider_history_too_large':
    case 'provider_request_too_large':
      return 'AI provider request exceeded the supported size.';
    case 'parse_error':
    case 'protocol_error':
      return 'AI provider returned an invalid response.';
    case 'provider_serialization_error':
      return 'AI provider request could not be prepared safely.';
    case 'http_error':
      return error.status === undefined
        ? 'AI provider rejected the request.'
        : `AI provider rejected the request (${error.status}).`;
    case 'context_overflow':
      return 'AI provider request exceeded the model context window.';
    case 'network_error':
      return 'AI provider network request failed.';
  }
}

const OPENAI_CONTEXT_OVERFLOW_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'max_tokens',
]);
const ANTHROPIC_CONTEXT_OVERFLOW_CODES = new Set([
  'model_context_window_exceeded',
  'request_too_large',
]);
const CONTEXT_OVERFLOW_MESSAGE_PATTERNS = [
  /prompt is too long/i,
  /request exceeds the maximum size/i,
  /input is too long for requested model/i,
  /exceeds (?:the )?(?:model(?:'?s)? )?(?:maximum )?context (?:length|window)/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /maximum context length is \d+ tokens/i,
  /reduce the length of the messages/i,
  /exceeds the maximum allowed input length/i,
  /exceeds the available context size/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
];
const NON_OVERFLOW_MESSAGE_PATTERNS = [
  /throttl/i,
  /rate limit/i,
  /too many requests/i,
  /(?:daily|monthly|account|organization) token (?:limit|quota)/i,
  /(?:quota|credit|billing|balance)/i,
  /\b(?:tpm|rpm)\b/i,
];

export function isStructuredProviderContextOverflow(
  payload: unknown,
  family: 'openai' | 'anthropic',
  status?: number,
): boolean {
  if (status === 413) return true;
  if (!isPlainRecord(payload)) return false;
  const nestedError = isPlainRecord(payload.error) ? payload.error : undefined;
  const codes = family === 'anthropic'
    ? ANTHROPIC_CONTEXT_OVERFLOW_CODES
    : OPENAI_CONTEXT_OVERFLOW_CODES;
  if ([payload.code, payload.type, nestedError?.code, nestedError?.type]
    .some((value) => typeof value === 'string' && codes.has(value))) {
    return true;
  }
  const messages = [payload.message, nestedError?.message]
    .filter((value): value is string => typeof value === 'string');
  if (messages.some((message) => NON_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(message)))) {
    return false;
  }
  return messages.some((message) => (
    CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  ));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class MockProvider implements ModelProvider {
  private readonly responses: ModelResponse[];

  constructor(responses: ModelResponse[] = []) {
    this.responses = [...responses];
  }

  async generate(): Promise<ModelResponse> {
    return this.responses.shift() ?? { content: 'No mock response configured.' };
  }
}
