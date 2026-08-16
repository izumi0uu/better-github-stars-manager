import {
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED,
  AGENT_HOST_PERMISSION_DENIED,
  AGENT_PROVIDER_IDENTITY_CHANGED,
} from '@/api/errors';
import {
  preflightContextRequest,
  type ContextBudgetPolicy,
  type ProviderUsageAnchor,
} from './compaction';
import {
  type AgentContextFailureReason,
  type AgentErrorCategory,
  type AgentEvent,
  type AgentStopReason,
} from './events';
import { type AgentMessage, type ModelMessage, toModelMessage } from './messages';
import {
  ProtocolValidationError,
  validateProviderProtocolHistory,
} from './protocol';
import {
  AgentProviderError,
  publicAgentProviderErrorMessage,
  type ModelProvider,
  type ModelResponse,
} from './provider';
import type { ModelStreamEvent } from './provider-stream';
import type { AgentToolDefinition } from './tools';
import {
  emitAgentExecutionTrace as traceExecution,
  inspectAgentTraceProviderRequest as inspectProviderRequestForTrace,
  traceAgentProviderError as traceProviderError,
  traceAgentProviderStreamEvent as traceProviderStreamEvent,
  type AgentExecutionTraceSink,
  type AgentTraceProviderIdentity,
  type AgentTraceProviderRequestIdentity,
} from './trace';
import {
  observeAgentContentCapture,
  type AgentContentCaptureSink,
} from './content-capture';
import type { AgentTurnLiveness } from './liveness';
import type {
  AgentContextContinuation,
  AgentContextContinuationTrigger,
  AgentTerminalLoopResult,
} from './loop-types';
import {
  deterministicInputTokens,
  providerPrefixTokens,
  usageAdjustmentTokens,
} from './loop-context-metrics';

const CONTEXT_LIMIT_EXCEEDED_MESSAGE = 'Context limit exceeded.';

type ContextDiagnosticMetrics = Readonly<{
  inputTokens?: number;
  deterministicInputTokens?: number;
  usageAdjustmentTokens?: number;
  observedPrefixTokens?: number | null;
  action?: NonNullable<Extract<AgentEvent, { type: 'context_diagnostic' }>['action']>;
  trigger?: NonNullable<Extract<AgentEvent, { type: 'context_diagnostic' }>['trigger']>;
  category?: NonNullable<Extract<AgentEvent, { type: 'context_diagnostic' }>['category']>;
}>;

type ProviderStepInput = Readonly<{
  sessionId: string;
  step: number;
  messages: AgentMessage[];
  rawMessages: readonly AgentMessage[];
  tracksRawMessages: boolean;
  provider: ModelProvider;
  toolDefinitions: AgentToolDefinition[];
  maxOutputTokens: number;
  contextHardLimit: number | undefined;
  contextPolicy: ContextBudgetPolicy | undefined;
  latestUsage: ProviderUsageAnchor | undefined;
  cumulativeToolResultBytes: number;
  continuationEpisode: number;
  onContextOverflow: AgentContextContinuation | undefined;
  trace: AgentExecutionTraceSink | undefined;
  traceProvider: AgentTraceProviderIdentity | undefined;
  contentCapture: AgentContentCaptureSink | undefined;
  liveness: AgentTurnLiveness | undefined;
  signal: AbortSignal | undefined;
  emit: (event: AgentEvent) => void;
  now: () => number;
  requestIdFactory: () => string;
  finishAfterAbort: () => AgentTerminalLoopResult;
  finishTerminal: (
    reason: AgentStopReason,
    contextFailureReason?: AgentContextFailureReason,
  ) => AgentTerminalLoopResult;
  emitContextDiagnostic: (
    stage: Extract<AgentEvent, { type: 'context_diagnostic' }>['stage'],
    policy: ContextBudgetPolicy,
    metrics: ContextDiagnosticMetrics,
  ) => void;
  toolResultBytesSinceLatestUser: (messages: readonly AgentMessage[]) => number;
}>;

export type ProviderStepResult =
  | Readonly<{
      kind: 'response';
      response: ModelResponse;
      modelMessages: ModelMessage[];
      bufferedPresentationEvents: AgentEvent[];
      latestUsage?: ProviderUsageAnchor;
      cumulativeToolResultBytes: number;
      continuationEpisode: number;
    }>
  | Readonly<{
      kind: 'terminal';
      result: AgentTerminalLoopResult;
    }>;

type ProviderRecoveryTrigger = Extract<
  AgentContextContinuationTrigger,
  'context_preflight' | 'provider_context_overflow' | 'provider_request_byte_limit'
>;

type ProviderRecoveryResult =
  | Readonly<{
      kind: 'continued';
      cumulativeToolResultBytes: number;
      continuationEpisode: number;
    }>
  | Readonly<{
      kind: 'terminal';
      result: AgentTerminalLoopResult;
    }>;

export async function runProviderStep(input: ProviderStepInput): Promise<ProviderStepResult> {
  let latestUsage = input.latestUsage;
  let cumulativeToolResultBytes = input.cumulativeToolResultBytes;
  let continuationEpisode = input.continuationEpisode;
  let overflowRecoveryAttempted = false;
  let requestByteRecoveryAttempted = false;
  let preflightRecoveryAttempted = false;
  let requestAttempt = 0;

  const recoverContext = async (
    trigger: ProviderRecoveryTrigger,
    defaultFailureReason: AgentContextFailureReason,
    markProgress: boolean,
  ): Promise<ProviderRecoveryResult> => {
    const continuation = input.onContextOverflow;
    if (!continuation) {
      throw new Error('Provider context recovery requires a continuation handler.');
    }
    const episode = ++continuationEpisode;
    traceExecution(input.trace, {
      kind: 'continuation_started',
      providerStep: input.step,
      episode,
      attempt: 1,
      reason: trigger,
    });
    if (input.contextPolicy) {
      input.emitContextDiagnostic('compaction', input.contextPolicy, {
        action: 'triggered',
        trigger,
        ...(trigger === 'provider_context_overflow' || trigger === 'provider_request_byte_limit'
          ? { category: trigger }
          : {}),
      });
    }

    let result: Awaited<ReturnType<AgentContextContinuation>>;
    try {
      result = await continuation({
        messages: [...input.messages],
        ...(input.tracksRawMessages ? { rawMessages: [...input.rawMessages] } : {}),
        step: input.step,
        trigger,
      });
    } catch (error) {
      const cancelled = input.signal?.aborted
        || (error instanceof AgentProviderError && error.code === 'caller_abort');
      traceExecution(input.trace, {
        kind: 'continuation_finished',
        providerStep: input.step,
        episode,
        attempt: 1,
        outcome: cancelled ? 'cancelled' : 'failed',
      });
      if (cancelled) {
        return { kind: 'terminal', result: input.finishAfterAbort() };
      }
      input.emit({
        type: 'agent_error',
        sessionId: input.sessionId,
        message: publicAgentProviderErrorMessage(error),
        category: providerErrorCategory(error),
      });
      return { kind: 'terminal', result: input.finishTerminal('provider_error') };
    }

    if (input.signal?.aborted || result.kind === 'aborted') {
      traceExecution(input.trace, {
        kind: 'continuation_finished',
        providerStep: input.step,
        episode,
        attempt: 1,
        outcome: 'cancelled',
      });
      return { kind: 'terminal', result: input.finishAfterAbort() };
    }
    if (result.kind === 'context_limit') {
      traceExecution(input.trace, {
        kind: 'continuation_finished',
        providerStep: input.step,
        episode,
        attempt: 1,
        outcome: 'exhausted',
      });
      input.emit({
        type: 'agent_error',
        sessionId: input.sessionId,
        message: CONTEXT_LIMIT_EXCEEDED_MESSAGE,
      });
      return {
        kind: 'terminal',
        result: input.finishTerminal('context_limit', result.reason ?? defaultFailureReason),
      };
    }

    traceExecution(input.trace, {
      kind: 'continuation_finished',
      providerStep: input.step,
      episode,
      attempt: 1,
      outcome: 'continued',
    });
    input.messages.splice(0, input.messages.length, ...result.messages);
    cumulativeToolResultBytes = input.toolResultBytesSinceLatestUser(input.messages);
    latestUsage = undefined;
    if (markProgress) input.liveness?.markAgentProgress();
    return {
      kind: 'continued',
      cumulativeToolResultBytes,
      continuationEpisode,
    };
  };

  while (true) {
    const bufferedPresentationEvents: AgentEvent[] = [];
    requestAttempt += 1;
    const providerRequestIdentity = {
      requestId: `provider_request:${input.requestIdFactory()}`,
      requestKind: 'turn',
      providerStep: input.step,
      requestAttempt,
    } satisfies AgentTraceProviderRequestIdentity;
    if (input.signal?.aborted) {
      return { kind: 'terminal', result: input.finishAfterAbort() };
    }

    const modelMessages = input.messages.map(toModelMessage);
    try {
      validateProviderProtocolHistory(modelMessages);
    } catch (error) {
      const message = error instanceof ProtocolValidationError
        ? error.message
        : 'Provider history failed protocol validation.';
      input.emit({ type: 'agent_error', sessionId: input.sessionId, message });
      return { kind: 'terminal', result: input.finishTerminal('protocol_error') };
    }

    const contextPreflight = input.contextHardLimit === undefined
      ? null
      : preflightContextRequest(
          {
            messages: modelMessages,
            toolSchemas: input.toolDefinitions,
            maxOutputTokens: input.maxOutputTokens,
            ...(latestUsage ? { latestUsage } : {}),
          },
          { hardLimit: input.contextHardLimit },
        );
    if (input.contextPolicy && contextPreflight) {
      input.emitContextDiagnostic('preflight', input.contextPolicy, {
        inputTokens: contextPreflight.inputTokens,
        deterministicInputTokens: deterministicInputTokens(contextPreflight),
        usageAdjustmentTokens: usageAdjustmentTokens(contextPreflight),
        observedPrefixTokens: providerPrefixTokens(contextPreflight),
      });
    }
    const requestInspection = inspectProviderRequestForTrace(input.trace, input.provider, {
      messages: modelMessages,
      tools: input.toolDefinitions,
      maxOutputTokens: input.maxOutputTokens,
    });
    if (input.contextPolicy && contextPreflight && requestInspection) {
      traceExecution(input.trace, {
        kind: 'context_preflight',
        ...providerRequestIdentity,
        workingWindowTokens: input.contextPolicy.workingWindow,
        reserveTokens: Math.max(
          0,
          input.contextPolicy.workingWindow - input.contextPolicy.hardLimit,
        ),
        estimatedInputTokens: contextPreflight.inputTokens,
        requestBytes: requestInspection.serializedRequestBytes,
        historyBytes: requestInspection.serializedHistoryBytes,
        decision: !contextPreflight.accepted
          ? 'irreducible'
          : requestInspection.accepted ? 'admit' : 'reduce',
        reasonCode: !contextPreflight.accepted
          ? 'current_turn_too_large'
          : requestInspection.failure ?? null,
      });
    }
    if (contextPreflight && !contextPreflight.accepted) {
      if (!preflightRecoveryAttempted && input.onContextOverflow) {
        preflightRecoveryAttempted = true;
        const recovery = await recoverContext(
          'context_preflight',
          'current_turn_too_large',
          true,
        );
        if (recovery.kind === 'terminal') return recovery;
        cumulativeToolResultBytes = recovery.cumulativeToolResultBytes;
        continuationEpisode = recovery.continuationEpisode;
        continue;
      }
      input.emit({
        type: 'agent_error',
        sessionId: input.sessionId,
        message: CONTEXT_LIMIT_EXCEEDED_MESSAGE,
      });
      return {
        kind: 'terminal',
        result: input.finishTerminal('context_limit', 'current_turn_too_large'),
      };
    }

    let requestLiveness: ReturnType<AgentTurnLiveness['beginProviderRequest']> | undefined;
    try {
      requestLiveness = input.liveness?.beginProviderRequest();
      const requestStartedAt = input.trace ? input.now() : 0;
      const providerInput = {
        messages: modelMessages,
        tools: input.toolDefinitions,
        maxOutputTokens: input.maxOutputTokens,
        onStreamEvent: (event: ModelStreamEvent) => {
          requestLiveness?.observeStreamEvent(event);
          traceProviderStreamEvent(
            input.trace,
            event,
            providerRequestIdentity,
            requestStartedAt,
            input.now,
          );
          if (event.type === 'response_start') {
            bufferedPresentationEvents.push({
              type: 'assistant_stream_start',
              sessionId: input.sessionId,
              step: input.step,
            });
          } else if (event.type === 'text_delta') {
            bufferedPresentationEvents.push({
              type: 'assistant_text_delta',
              sessionId: input.sessionId,
              step: input.step,
              delta: event.delta,
            });
          }
        },
      } satisfies Omit<Parameters<ModelProvider['generate']>[0], 'signal'>;
      observeAgentContentCapture(input.contentCapture, (capture) => {
        capture.providerPrompt(providerRequestIdentity, modelMessages);
      });
      const prepared = input.provider.prepare?.(providerInput);
      const effectiveInspection = prepared?.inspection ?? requestInspection;
      if (input.traceProvider && effectiveInspection) {
        traceExecution(input.trace, {
          kind: 'provider_request_prepared',
          ...providerRequestIdentity,
          ...input.traceProvider,
          requestBytes: effectiveInspection.serializedRequestBytes,
          historyBytes: effectiveInspection.serializedHistoryBytes,
          estimatedInputTokens: contextPreflight?.inputTokens ?? null,
          maxOutputTokens: input.maxOutputTokens,
        });
      }
      const response = prepared
        ? await prepared.execute(requestLiveness?.signal ?? input.signal)
        : await input.provider.generate({
            ...providerInput,
            signal: requestLiveness?.signal ?? input.signal,
          });
      requestLiveness?.observeResponse();
      observeAgentContentCapture(input.contentCapture, (capture) => {
        capture.providerResponse(providerRequestIdentity, response);
      });
      if (input.trace && response.usage) {
        traceExecution(input.trace, {
          kind: 'provider_usage',
          ...providerRequestIdentity,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          source: 'provider',
        });
      }
      if (isSilentProviderContextOverflow(response, input.contextPolicy?.providerWindow)) {
        throw new AgentProviderError(
          'context_overflow',
          'AI provider request exceeded the model context window.',
        );
      }
      if (response.finishReason === 'length') {
        throw new AgentProviderError(
          'protocol_error',
          'Provider stream ended before a complete response.',
        );
      }
      if (input.trace) {
        traceExecution(input.trace, {
          kind: 'provider_finished',
          ...providerRequestIdentity,
          finishReason: response.finishReason || 'unknown',
          durationMs: Math.max(0, input.now() - requestStartedAt),
        });
      }
      return {
        kind: 'response',
        response,
        modelMessages,
        bufferedPresentationEvents,
        ...(latestUsage ? { latestUsage } : {}),
        cumulativeToolResultBytes,
        continuationEpisode,
      };
    } catch (error) {
      traceProviderError(input.trace, error, providerRequestIdentity);
      if (input.liveness?.timeoutReason) {
        return { kind: 'terminal', result: input.finishAfterAbort() };
      }
      if (
        input.signal?.aborted
        || (error instanceof AgentProviderError && error.code === 'caller_abort')
      ) {
        return { kind: 'terminal', result: input.finishAfterAbort() };
      }
      if (isProviderRequestByteLimitError(error)) {
        latestUsage = undefined;
        if (!requestByteRecoveryAttempted && input.onContextOverflow) {
          requestByteRecoveryAttempted = true;
          const recovery = await recoverContext(
            'provider_request_byte_limit',
            'final_preflight_failed',
            false,
          );
          if (recovery.kind === 'terminal') return recovery;
          cumulativeToolResultBytes = recovery.cumulativeToolResultBytes;
          continuationEpisode = recovery.continuationEpisode;
          continue;
        }

        const repeated = requestByteRecoveryAttempted;
        const failureReason = repeated
          ? 'provider_request_byte_limit_repeated' as const
          : 'provider_request_byte_limit' as const;
        input.emit({
          type: 'agent_error',
          sessionId: input.sessionId,
          message: publicAgentProviderErrorMessage(error),
          category: providerErrorCategory(error),
        });
        if (input.contextPolicy) {
          input.emitContextDiagnostic('compaction', input.contextPolicy, {
            action: 'terminal',
            category: failureReason,
          });
        }
        return {
          kind: 'terminal',
          result: input.finishTerminal('context_limit', failureReason),
        };
      }
      if (error instanceof AgentProviderError && error.code === 'context_overflow') {
        latestUsage = undefined;
        if (!overflowRecoveryAttempted && input.onContextOverflow) {
          overflowRecoveryAttempted = true;
          const recovery = await recoverContext(
            'provider_context_overflow',
            'final_preflight_failed',
            false,
          );
          if (recovery.kind === 'terminal') return recovery;
          cumulativeToolResultBytes = recovery.cumulativeToolResultBytes;
          continuationEpisode = recovery.continuationEpisode;
          continue;
        }

        const repeated = overflowRecoveryAttempted;
        const failureReason = repeated
          ? 'provider_context_overflow_repeated' as const
          : 'provider_context_overflow' as const;
        input.emit({
          type: 'agent_error',
          sessionId: input.sessionId,
          message: publicAgentProviderErrorMessage(error),
          category: providerErrorCategory(error),
        });
        if (input.contextPolicy) {
          input.emitContextDiagnostic('compaction', input.contextPolicy, {
            action: 'terminal',
            category: failureReason,
          });
        }
        return {
          kind: 'terminal',
          result: input.finishTerminal('context_limit', failureReason),
        };
      }
      input.emit({
        type: 'agent_error',
        sessionId: input.sessionId,
        message: publicAgentProviderErrorMessage(error),
        category: providerErrorCategory(error),
      });
      return { kind: 'terminal', result: input.finishTerminal('provider_error') };
    } finally {
      requestLiveness?.finish();
    }
  }
}

export function providerErrorCategory(error: unknown): AgentErrorCategory {
  if (error instanceof AgentProviderError) {
    if (error.code === 'context_overflow') return 'capability';
    return error.status === 401 || error.status === 403 ? 'authentication' : 'provider';
  }
  const code = error instanceof Error ? error.message : '';
  if (code === AGENT_DATA_DISCLOSURE_REQUIRED) return 'disclosure';
  if (
    code === AGENT_HOST_PERMISSION_DENIED ||
    code === AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED
  ) return 'permission';
  if (code === AGENT_PROVIDER_IDENTITY_CHANGED) return 'capability';
  return 'provider';
}

function isProviderRequestByteLimitError(error: unknown): error is AgentProviderError {
  return error instanceof AgentProviderError && (
    error.code === 'provider_history_too_large'
    || error.code === 'provider_request_too_large'
  );
}

function isSilentProviderContextOverflow(
  response: ModelResponse,
  contextWindow: number | undefined,
): boolean {
  if (!contextWindow || !response.usage) return false;
  if (response.finishReason === 'stop') {
    return response.usage.inputTokens > contextWindow;
  }
  return response.finishReason === 'length'
    && response.usage.outputTokens === 0
    && response.usage.inputTokens >= contextWindow * 0.99;
}


