import {
  AgentProviderError,
  type ModelProvider,
  type ModelRequestShape,
  type ProviderRequestInspection,
} from './provider';
import type { ModelStreamEvent } from './provider-stream';
import { utf8ByteLength } from './results';
import type { AgentLivenessWatchdogEvent } from './liveness';

export type AgentTraceProviderClass = 'openai' | 'openrouter' | 'anthropic' | 'custom';

export type AgentTraceProviderProtocol =
  | 'chat_completions'
  | 'responses'
  | 'anthropic_messages';

export type AgentTraceProviderIdentity = Readonly<{
  providerClass: AgentTraceProviderClass;
  protocol: AgentTraceProviderProtocol;
  modelCapabilityRevision: string;
}>;

export type AgentTraceProviderRequestKind =
  | 'turn'
  | 'historical_summary'
  | 'active_turn_summary'
  | 'organize_analysis';

export type AgentTraceProviderRequestIdentity = Readonly<{
  requestId: string;
  requestKind: AgentTraceProviderRequestKind;
  providerStep: number | null;
  requestAttempt: number;
}>;

type ToolTraceIdentity = Readonly<{
  providerStep: number;
  toolName: string;
  toolCallId: string;
}>;

export type AgentExecutionTraceEvent =
  | (AgentTraceProviderRequestIdentity & AgentTraceProviderIdentity & Readonly<{
      kind: 'provider_request_prepared';
      requestBytes: number;
      historyBytes: number;
      estimatedInputTokens: number | null;
      maxOutputTokens: number;
    }>)
  | (AgentTraceProviderRequestIdentity & Readonly<{
      kind: 'provider_response_started';
      latencyMs: number;
    }>)
  | (AgentTraceProviderRequestIdentity & Readonly<{
      kind: 'provider_stream_item';
      streamClass:
        | 'text'
        | 'refusal'
        | 'tool_start'
        | 'tool_arguments'
        | 'tool_end'
        | 'usage'
        | 'response_end';
      utf8Bytes: number;
    }>)
  | (AgentTraceProviderRequestIdentity & Readonly<{
      kind: 'provider_usage';
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      source: 'provider' | 'estimated';
    }>)
  | (AgentTraceProviderRequestIdentity & Readonly<{
      kind: 'provider_finished';
      finishReason: string;
      durationMs: number;
    }>)
  | (AgentTraceProviderRequestIdentity & Readonly<{
      kind: 'provider_error';
      code: string;
      status: number | null;
      retryable: boolean;
      overflow: boolean;
    }>)
  | (ToolTraceIdentity & Readonly<{
      kind: 'tool_queued';
      toolClass: 'read' | 'suggest' | 'write';
      risk: 'read' | 'suggest' | 'write';
    }>)
  | (ToolTraceIdentity & Readonly<{
      kind: 'tool_authorized';
      decision: 'allow' | 'deny' | 'confirm';
    }>)
  | (ToolTraceIdentity & Readonly<{
      kind: 'tool_started';
      attempt: number;
    }>)
  | (ToolTraceIdentity & Readonly<{
      kind: 'tool_result_admitted';
      originalBytes: number;
      admittedBytes: number;
      reduction: 'none' | 'structural' | 'error_envelope';
    }>)
  | (ToolTraceIdentity & Readonly<{
      kind: 'tool_completed';
      outcome: 'success' | 'error' | 'cancelled';
      durationMs: number | null;
    }>)
  | (ToolTraceIdentity & Readonly<{
      kind: 'tool_write_outcome';
      effectCount: number | null;
      state: 'committed' | 'unchanged' | 'failed' | 'unknown';
    }>)
  | (AgentTraceProviderRequestIdentity & Readonly<{
      kind: 'context_preflight';
      workingWindowTokens: number;
      reserveTokens: number;
      estimatedInputTokens: number;
      requestBytes: number;
      historyBytes: number;
      decision: 'admit' | 'reduce' | 'irreducible';
      reasonCode: string | null;
    }>)
  | Readonly<{
      kind: 'continuation_started';
      providerStep: number;
      episode: number;
      attempt: number;
      reason: string;
    }>
  | Readonly<{
      kind: 'continuation_finished';
      providerStep: number;
      episode: number;
      attempt: number;
      outcome: 'continued' | 'failed' | 'cancelled' | 'exhausted';
    }>
  | (AgentLivenessWatchdogEvent & Readonly<{ kind: 'watchdog_state' }>);

export type AgentExecutionTraceSink = Readonly<{
  emit(event: AgentExecutionTraceEvent): void;
}>;

export function emitAgentExecutionTrace(
  trace: AgentExecutionTraceSink | undefined,
  event: AgentExecutionTraceEvent,
): void {
  if (!trace) return;
  try {
    trace.emit(event);
  } catch {
    // Development observation cannot change Agent execution.
  }
}

export function inspectAgentTraceProviderRequest(
  trace: AgentExecutionTraceSink | undefined,
  provider: ModelProvider,
  request: ModelRequestShape,
): ProviderRequestInspection | undefined {
  if (!trace) return undefined;
  try {
    return provider.inspectRequest?.(request);
  } catch {
    return undefined;
  }
}

export function traceAgentProviderStreamEvent(
  trace: AgentExecutionTraceSink | undefined,
  event: ModelStreamEvent,
  identity: AgentTraceProviderRequestIdentity,
  requestStartedAt: number,
  now: () => number,
): void {
  if (!trace || event.type === 'error') return;
  if (event.type === 'response_start') {
    emitAgentExecutionTrace(trace, {
      kind: 'provider_response_started',
      ...identity,
      latencyMs: Math.max(0, now() - requestStartedAt),
    });
    return;
  }
  emitAgentExecutionTrace(trace, {
    kind: 'provider_stream_item',
    ...identity,
    ...streamTraceItem(event),
  });
}

export function traceAgentProviderError(
  trace: AgentExecutionTraceSink | undefined,
  error: unknown,
  identity: AgentTraceProviderRequestIdentity,
): void {
  const providerError = error instanceof AgentProviderError ? error : null;
  emitAgentExecutionTrace(trace, {
    kind: 'provider_error',
    ...identity,
    code: providerError?.code ?? 'unknown',
    status: providerError?.status ?? null,
    retryable: isRetryableProviderFailure(providerError),
    overflow: providerError?.code === 'context_overflow',
  });
}

function streamTraceItem(
  event: Exclude<ModelStreamEvent, { type: 'response_start' | 'error' }>,
): Pick<
  Extract<AgentExecutionTraceEvent, { kind: 'provider_stream_item' }>,
  'streamClass' | 'utf8Bytes'
> {
  switch (event.type) {
    case 'text_delta':
      return { streamClass: 'text', utf8Bytes: utf8ByteLength(event.delta) };
    case 'refusal_delta':
      return { streamClass: 'refusal', utf8Bytes: utf8ByteLength(event.delta) };
    case 'tool_call_start':
      return {
        streamClass: 'tool_start',
        utf8Bytes: utf8ByteLength(event.id) + utf8ByteLength(event.name),
      };
    case 'tool_call_arguments_delta':
      return { streamClass: 'tool_arguments', utf8Bytes: utf8ByteLength(event.delta) };
    case 'tool_call_end':
      return { streamClass: 'tool_end', utf8Bytes: 0 };
    case 'usage':
      return { streamClass: 'usage', utf8Bytes: 0 };
    case 'response_end':
      return { streamClass: 'response_end', utf8Bytes: 0 };
  }
}

function isRetryableProviderFailure(error: AgentProviderError | null): boolean {
  if (!error) return false;
  if (error.code === 'network_error' || error.code === 'timeout') return true;
  return error.code === 'http_error'
    && error.status !== undefined
    && (error.status === 408 || error.status === 429 || error.status >= 500);
}
