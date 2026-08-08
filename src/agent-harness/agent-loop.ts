import {
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_HOST_PERMISSION_DENIED,
  AGENT_PROVIDER_IDENTITY_CHANGED,
} from '@/api/errors';
import {
  DEFAULT_MAX_AGENT_STEPS,
  MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  MAX_TURN_TOOL_RESULT_BYTES,
} from './const';
import {
  estimateUtf8Tokens,
  preflightContextRequest,
  shouldCompact,
  type ContextBudgetPolicy,
  type ProviderUsageAnchor,
} from './compaction';
import type {
  AgentContextFailureReason,
  AgentErrorCategory,
  AgentEvent,
  AgentStopReason,
} from './events';
import { type AgentMessage, toModelMessage } from './messages';
import {
  defaultPermissionEvaluator,
  type PermissionDecision,
  type PermissionEvaluator,
} from './permissions';
import {
  ProtocolValidationError,
  validateProviderProtocolHistory,
  validateToolCallEnvelope,
} from './protocol';
import {
  AgentProviderError,
  publicAgentProviderErrorMessage,
  type ModelProvider,
  type ModelToolCall,
} from './provider';
import { utf8ByteLength } from './results';
import {
  type AgentExecutableTool,
  type AgentRequiredBeforeFinalDirective,
  type AgentToolResultAdmission,
  type AgentToolResultAdmissionHost,
  type AgentToolSuspendOutcome,
  errorToolResult,
  finalizeToolResult,
  finalizeWriteToolResult,
  isAgentToolSuspendOutcome,
  MIN_TOOL_RESULT_ENVELOPE_BYTES,
  MIN_TOOL_RESULT_ENVELOPE_SERIALIZED,
  okToolResult,
  toToolDefinition,
  ToolOutputTooLargeError,
  ToolResultBudgetError,
  type FinalizedToolResult,
  type ToolResult,
  type ToolResultAllowance,
  type ToolRisk,
  serializedToolResultByteLength,
} from './tools';
import type { SuspendedToolResult, SuspendedTurn } from './suspended-turn';
import {
  type AgentExecutionLedger,
  type CanonicalToolEffect,
  type WriteEffectPlan,
} from './execution-ledger';
import {
  emitAgentExecutionTrace as traceExecution,
  inspectAgentTraceProviderRequest as inspectProviderRequestForTrace,
  traceAgentProviderError as traceProviderError,
  traceAgentProviderStreamEvent as traceProviderStreamEvent,
  type AgentExecutionTraceSink,
  type AgentTraceProviderRequestIdentity,
  type AgentTraceProviderIdentity,
} from './trace';
import type { ModelStreamEvent } from './provider-stream';
import {
  observeAgentContentCapture,
  serializeAgentCaptureValue,
  type AgentContentCaptureSink,
} from './content-capture';
import {
  publicAgentLivenessTimeoutMessage,
  type AgentTurnLiveness,
} from './liveness';

export type AgentTerminalLoopResult = {
  sessionId: string;
  messages: AgentMessage[];
  /** Append-only turn transcript; unlike messages, compaction never replaces it. */
  rawMessages?: AgentMessage[];
  reason: AgentStopReason;
  continuation?: undefined;
  contextFailureReason?: AgentContextFailureReason;
  suspension?: AgentLoopSuspensionCandidate;
};

export type AgentNonterminalContinuationCause = 'episode_exhausted' | 'no_progress';

export type AgentNonterminalContinuationCandidate = Readonly<{
  cause: AgentNonterminalContinuationCause;
  projectedMessages: readonly AgentMessage[];
  canonicalRawMessages: readonly AgentMessage[];
  requiredBeforeFinal: readonly AgentRequiredBeforeFinalDirective[];
}>;

export type AgentNonterminalContinuationResult = {
  sessionId: string;
  messages: AgentMessage[];
  rawMessages?: AgentMessage[];
  reason: undefined;
  continuation: AgentNonterminalContinuationCandidate;
  contextFailureReason?: undefined;
  suspension?: undefined;
};

export type AgentLoopResult = AgentTerminalLoopResult | AgentNonterminalContinuationResult;

export type AgentLoopSuspensionCandidate = Readonly<{
  interactionKind: 'scope_selector';
  task: 'prepare_scope_branch';
  assistantEnvelope: SuspendedTurn['assistantEnvelope'];
  completedPrefix: readonly SuspendedToolResult[];
  pendingIndex: number;
  remainingStepBudget: number;
  priorHistory: readonly ReturnType<typeof toModelMessage>[];
}>;

export type RunAgentLoopInput = {
  sessionId: string;
  messages: AgentMessage[];
  /** Opt in to an append-only raw transcript for the current logical turn. */
  rawMessages?: AgentMessage[];
  provider: ModelProvider;
  tools: AgentExecutableTool[];
  emit?: (event: AgentEvent) => void;
  permissions?: PermissionEvaluator;
  maxSteps?: number;
  maxOutputTokens?: number;
  contextHardLimit?: number;
  contextPolicy?: ContextBudgetPolicy;
  executionLedger?: AgentExecutionLedger;
  onToolEnvelopeSettled?: AgentContextContinuation;
  onContextOverflow?: AgentContextContinuation;
  trace?: AgentExecutionTraceSink;
  traceProvider?: AgentTraceProviderIdentity;
  contentCapture?: AgentContentCaptureSink;
  toolResultAdmissionHost?: AgentToolResultAdmissionHost;
  requiredBeforeFinal?: readonly AgentRequiredBeforeFinalDirective[];
  /** Owns ordinary-turn watchdogs and the Provider request signals they create. */
  liveness?: AgentTurnLiveness;
  signal?: AbortSignal;
  idFactory?: () => string;
  now?: () => number;
};

export type AgentContextContinuationTrigger =
  | 'completed_tool_envelope'
  | 'tool_result_memory_pressure'
  | 'context_preflight'
  | 'provider_context_overflow'
  | 'provider_request_byte_limit';

export type AgentContextContinuation = (
  input: Readonly<{
    messages: readonly AgentMessage[];
    /** Present only when the caller opted into the append-only turn transcript. */
    rawMessages?: readonly AgentMessage[];
    step: number;
    trigger: AgentContextContinuationTrigger;
  }>,
) => Promise<
  | Readonly<{ kind: 'ready'; messages: AgentMessage[] }>
  | Readonly<{ kind: 'context_limit'; reason?: AgentContextFailureReason }>
  | Readonly<{ kind: 'aborted' }>
>;

const INVALID_ARGUMENTS_MESSAGE = 'Tool arguments were invalid.';
const PERMISSION_EVALUATION_FAILED_MESSAGE = 'Tool permission evaluation failed.';
const TOOL_EXECUTION_FAILED_MESSAGE = 'Tool execution failed.';
const TOOL_OUTPUT_TOO_LARGE_MESSAGE =
  'Tool output exceeded the available result budget. Request a smaller page.';
const WRITE_EFFECT_PLAN_REQUIRED_MESSAGE =
  'Write execution is unavailable because its replay safety contract is missing.';
const WRITE_REPLAY_BLOCKED_MESSAGE =
  'Write execution is blocked because an earlier outcome is not safely replayable.';
const EXCLUSIVE_TOOL_ENVELOPE_REQUIRED_MESSAGE =
  'This tool must be requested by itself. Retry it without sibling tool calls.';
const CONTEXT_LIMIT_EXCEEDED_MESSAGE = 'Context limit exceeded.';
const TOOL_RESULT_MEMORY_LIMIT_MESSAGE =
  'The agent could not free enough internal tool-result memory to continue.';
const TOOL_RESULT_ADMISSION_FAILED_MESSAGE = 'Tool result admission failed.';
const MAX_AGENT_OPAQUE_VALUE_BYTES = 512;
const MAX_AGENT_OPAQUE_VALUES = 128;

export async function runAgentLoop(input: RunAgentLoopInput): Promise<AgentLoopResult> {
  const emit = input.emit ?? (() => {});
  const permissions = input.permissions ?? defaultPermissionEvaluator;
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
  const now = input.now ?? Date.now;
  const idFactory = input.idFactory ?? randomId;
  const toolMap = new Map(input.tools.map((tool) => [tool.name, tool]));
  const toolDefinitions = input.tools.map(toToolDefinition);
  const maxOutputTokens = input.maxOutputTokens ?? 1024;
  const contextHardLimit = input.contextPolicy?.hardLimit ?? input.contextHardLimit;
  const messages = [...input.messages];
  const tracksRawMessages = input.rawMessages !== undefined;
  const rawMessages = [...(input.rawMessages ?? [])];
  const usedToolCallIds = collectToolCallIds(messages, rawMessages);
  let cumulativeToolResultBytes = toolResultBytesSinceLatestUser(messages);
  let latestUsage: ProviderUsageAnchor | undefined;
  let overflowRecoveryAttempted = false;
  let requestByteRecoveryAttempted = false;
  let continuationEpisode = 0;
  const signal = input.liveness?.signal ?? input.signal;
  let requiredBeforeFinal = normalizeRequiredBeforeFinal(input.requiredBeforeFinal ?? []);
  let nonterminalContinuationActive = requiredBeforeFinal.length > 0;
  const episodeStartedWithRequiredDirectives = requiredBeforeFinal.length > 0;
  let requiredDirectiveProgressOccurred = false;

  const finishAfterAbort = (): AgentLoopResult => {
    const timeoutReason = input.liveness?.timeoutReason;
    if (!timeoutReason) {
      return finishWithRaw('aborted', input.sessionId, messages, emit);
    }
    emit({
      type: 'agent_error',
      sessionId: input.sessionId,
      message: publicAgentLivenessTimeoutMessage(timeoutReason),
      category: 'provider',
    });
    return finishWithRaw('provider_error', input.sessionId, messages, emit);
  };
  const returnContinuation = (
    cause: AgentNonterminalContinuationCause,
  ): AgentNonterminalContinuationResult => {
    const projectedMessages = [...messages];
    const canonicalRawMessages = [...(tracksRawMessages ? rawMessages : messages)];
    return {
      sessionId: input.sessionId,
      messages: projectedMessages,
      ...(tracksRawMessages ? { rawMessages: canonicalRawMessages } : {}),
      reason: undefined,
      continuation: {
        cause,
        projectedMessages,
        canonicalRawMessages,
        requiredBeforeFinal: [...requiredBeforeFinal],
      },
    };
  };

  const continueAfterSettledToolBoundary = async (
    step: number,
    initialTrigger: Extract<
      Parameters<AgentContextContinuation>[0]['trigger'],
      'completed_tool_envelope' | 'tool_result_memory_pressure' | 'provider_request_byte_limit'
    >,
  ): Promise<AgentLoopResult | null> => {
    if (!input.onToolEnvelopeSettled) return null;
    const attempted = new Set<AgentContextContinuationTrigger>();
    let trigger = initialTrigger;
    while (true) {
      attempted.add(trigger);
      if (input.contextPolicy && trigger !== 'completed_tool_envelope') {
        emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
          action: 'triggered',
          trigger,
          ...(trigger === 'provider_request_byte_limit'
            ? { category: 'provider_request_byte_limit' as const }
            : {}),
        });
      }
      const episode = ++continuationEpisode;
      traceExecution(input.trace, {
        kind: 'continuation_started',
        providerStep: step,
        episode,
        attempt: 1,
        reason: trigger,
      });
      let continuation: Awaited<ReturnType<AgentContextContinuation>>;
      try {
        continuation = await input.onToolEnvelopeSettled({
          messages: [...messages],
          ...(tracksRawMessages ? { rawMessages: [...rawMessages] } : {}),
          step,
          trigger,
        });
      } catch (error) {
        const cancelled = signal?.aborted
          || (error instanceof AgentProviderError && error.code === 'caller_abort');
        traceExecution(input.trace, {
          kind: 'continuation_finished',
          providerStep: step,
          episode,
          attempt: 1,
          outcome: cancelled ? 'cancelled' : 'failed',
        });
        if (cancelled) return finishAfterAbort();
        emit({
          type: 'agent_error',
          sessionId: input.sessionId,
          message: publicAgentProviderErrorMessage(error),
          category: providerErrorCategory(error),
        });
        return finishWithRaw('provider_error', input.sessionId, messages, emit);
      }
      if (signal?.aborted || continuation.kind === 'aborted') {
        traceExecution(input.trace, {
          kind: 'continuation_finished',
          providerStep: step,
          episode,
          attempt: 1,
          outcome: 'cancelled',
        });
        return finishAfterAbort();
      }
      if (continuation.kind === 'context_limit') {
        traceExecution(input.trace, {
          kind: 'continuation_finished',
          providerStep: step,
          episode,
          attempt: 1,
          outcome: 'exhausted',
        });
        const reason = continuation.reason ?? (
          trigger === 'tool_result_memory_pressure'
            ? 'tool_result_memory_limit'
            : 'final_preflight_failed'
        );
        emit({
          type: 'agent_error',
          sessionId: input.sessionId,
          message: reason === 'tool_result_memory_limit'
            ? TOOL_RESULT_MEMORY_LIMIT_MESSAGE
            : CONTEXT_LIMIT_EXCEEDED_MESSAGE,
        });
        return finishWithRaw('context_limit', input.sessionId, messages, emit, reason);
      }
      traceExecution(input.trace, {
        kind: 'continuation_finished',
        providerStep: step,
        episode,
        attempt: 1,
        outcome: 'continued',
      });
      messages.splice(0, messages.length, ...continuation.messages);
      cumulativeToolResultBytes = toolResultBytesSinceLatestUser(messages);
      latestUsage = undefined;
      input.liveness?.markAgentProgress();

      const nextPreflight = input.contextPolicy
        ? preflightContextRequest({
            messages: messages.map(toModelMessage),
            toolSchemas: toolDefinitions,
            maxOutputTokens,
          }, input.contextPolicy)
        : null;
      const memoryPressure = input.contextPolicy
        ? toolResultMemoryPressure(input.contextPolicy, cumulativeToolResultBytes)
        : false;
      const bytePressure = input.provider.inspectRequest?.({
        messages: messages.map(toModelMessage),
        tools: toolDefinitions,
        maxOutputTokens,
      }).accepted === false;
      const tokenPressure = input.contextPolicy && nextPreflight
        ? shouldCompact(nextPreflight, input.contextPolicy)
        : false;
      const nextTrigger = memoryPressure && !attempted.has('tool_result_memory_pressure')
        ? 'tool_result_memory_pressure' as const
        : bytePressure && !attempted.has('provider_request_byte_limit')
          ? 'provider_request_byte_limit' as const
          : tokenPressure && !attempted.has('completed_tool_envelope')
            ? 'completed_tool_envelope' as const
            : null;
      if (nextTrigger) {
        trigger = nextTrigger;
        continue;
      }
      if (!memoryPressure && !bytePressure && nextPreflight?.accepted !== false) return null;

      const reason = memoryPressure
        ? 'tool_result_memory_limit' as const
        : bytePressure
          ? 'provider_request_byte_limit' as const
          : 'current_turn_too_large' as const;
      emit({
        type: 'agent_error',
        sessionId: input.sessionId,
        message: reason === 'tool_result_memory_limit'
          ? TOOL_RESULT_MEMORY_LIMIT_MESSAGE
          : CONTEXT_LIMIT_EXCEEDED_MESSAGE,
      });
      if (input.contextPolicy) {
        emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
          action: 'terminal',
          category: reason,
        });
      }
      return finishWithRaw(
        'context_limit',
        input.sessionId,
        messages,
        emit,
        reason,
      );
    }
  };

  emit({ type: 'agent_start', sessionId: input.sessionId });

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      return finishAfterAbort();
    }

    const continuationAtStepStart = requiredBeforeFinal.length > 0;

    emit({ type: 'turn_start', sessionId: input.sessionId, step });

    let modelMessages: ReturnType<typeof toModelMessage>[];
    let response: Awaited<ReturnType<ModelProvider['generate']>>;
    let requestAttempt = 0;
    let preflightRecoveryAttempted = false;
    let bufferedPresentationEvents: AgentEvent[] = [];
    while (true) {
      bufferedPresentationEvents = [];
      requestAttempt += 1;
      const providerRequestIdentity = {
        requestId: `provider_request:${randomId()}`,
        requestKind: 'turn',
        providerStep: step,
        requestAttempt,
      } satisfies AgentTraceProviderRequestIdentity;
      if (signal?.aborted) {
        return finishAfterAbort();
      }
      modelMessages = messages.map(toModelMessage);
      try {
        validateProviderProtocolHistory(modelMessages);
      } catch (error) {
        const message = error instanceof ProtocolValidationError
          ? error.message
          : 'Provider history failed protocol validation.';
        emit({ type: 'agent_error', sessionId: input.sessionId, message });
        return finishWithRaw('protocol_error', input.sessionId, messages, emit);
      }
      const contextPreflight = contextHardLimit === undefined
        ? null
        : preflightContextRequest(
            {
              messages: modelMessages,
              toolSchemas: toolDefinitions,
              maxOutputTokens,
              ...(latestUsage ? { latestUsage } : {}),
            },
            { hardLimit: contextHardLimit },
          );
      if (input.contextPolicy && contextPreflight) {
        emitContextDiagnostic(emit, input.sessionId, 'preflight', input.contextPolicy, {
          inputTokens: contextPreflight.inputTokens,
          deterministicInputTokens: deterministicInputTokens(contextPreflight),
          usageAdjustmentTokens: usageAdjustmentTokens(contextPreflight),
          observedPrefixTokens: providerPrefixTokens(contextPreflight),
        });
      }
      const requestInspection = inspectProviderRequestForTrace(input.trace, input.provider, {
        messages: modelMessages,
        tools: toolDefinitions,
        maxOutputTokens,
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
          const episode = ++continuationEpisode;
          traceExecution(input.trace, {
            kind: 'continuation_started',
            providerStep: step,
            episode,
            attempt: 1,
            reason: 'context_preflight',
          });
          if (input.contextPolicy) {
            emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
              action: 'triggered',
              trigger: 'context_preflight',
            });
          }
          let continuation: Awaited<ReturnType<AgentContextContinuation>>;
          try {
            continuation = await input.onContextOverflow({
              messages: [...messages],
              ...(tracksRawMessages ? { rawMessages: [...rawMessages] } : {}),
              step,
              trigger: 'context_preflight',
            });
          } catch (continuationError) {
            const cancelled = signal?.aborted
              || (continuationError instanceof AgentProviderError
                && continuationError.code === 'caller_abort');
            traceExecution(input.trace, {
              kind: 'continuation_finished',
              providerStep: step,
              episode,
              attempt: 1,
              outcome: cancelled ? 'cancelled' : 'failed',
            });
            if (cancelled) return finishAfterAbort();
            emit({
              type: 'agent_error',
              sessionId: input.sessionId,
              message: publicAgentProviderErrorMessage(continuationError),
              category: providerErrorCategory(continuationError),
            });
            return finishWithRaw('provider_error', input.sessionId, messages, emit);
          }
          if (signal?.aborted || continuation.kind === 'aborted') {
            traceExecution(input.trace, {
              kind: 'continuation_finished',
              providerStep: step,
              episode,
              attempt: 1,
              outcome: 'cancelled',
            });
            return finishAfterAbort();
          }
          if (continuation.kind === 'context_limit') {
            traceExecution(input.trace, {
              kind: 'continuation_finished',
              providerStep: step,
              episode,
              attempt: 1,
              outcome: 'exhausted',
            });
            emit({
              type: 'agent_error',
              sessionId: input.sessionId,
              message: CONTEXT_LIMIT_EXCEEDED_MESSAGE,
            });
            return finishWithRaw(
              'context_limit',
              input.sessionId,
              messages,
              emit,
              continuation.reason ?? 'current_turn_too_large',
            );
          }
          traceExecution(input.trace, {
            kind: 'continuation_finished',
            providerStep: step,
            episode,
            attempt: 1,
            outcome: 'continued',
          });
          messages.splice(0, messages.length, ...continuation.messages);
          cumulativeToolResultBytes = toolResultBytesSinceLatestUser(messages);
          latestUsage = undefined;
          input.liveness?.markAgentProgress();
          continue;
        }
        emit({
          type: 'agent_error',
          sessionId: input.sessionId,
          message: CONTEXT_LIMIT_EXCEEDED_MESSAGE,
        });
        return finishWithRaw(
          'context_limit',
          input.sessionId,
          messages,
          emit,
          'current_turn_too_large',
        );
      }

      let requestLiveness: ReturnType<AgentTurnLiveness['beginProviderRequest']> | undefined;
      try {
        requestLiveness = input.liveness?.beginProviderRequest();
        const requestStartedAt = input.trace ? now() : 0;
        const providerInput = {
          messages: modelMessages,
          tools: toolDefinitions,
          maxOutputTokens,
          onStreamEvent: (event: ModelStreamEvent) => {
            requestLiveness?.observeStreamEvent(event);
            traceProviderStreamEvent(
              input.trace,
              event,
              providerRequestIdentity,
              requestStartedAt,
              now,
            );
            if (event.type === 'response_start') {
              bufferedPresentationEvents.push({
                type: 'assistant_stream_start',
                sessionId: input.sessionId,
                step,
              });
            } else if (event.type === 'text_delta') {
              bufferedPresentationEvents.push({
                type: 'assistant_text_delta',
                sessionId: input.sessionId,
                step,
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
            maxOutputTokens,
          });
        }
        response = prepared
          ? await prepared.execute(requestLiveness?.signal ?? signal)
          : await input.provider.generate({ ...providerInput, signal: requestLiveness?.signal ?? signal });
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
            durationMs: Math.max(0, now() - requestStartedAt),
          });
        }
        overflowRecoveryAttempted = false;
        requestByteRecoveryAttempted = false;
        break;
      } catch (error) {
        traceProviderError(input.trace, error, providerRequestIdentity);
        if (input.liveness?.timeoutReason) {
          return finishAfterAbort();
        }
        if (
          signal?.aborted ||
          (error instanceof AgentProviderError && error.code === 'caller_abort')
        ) {
          return finishAfterAbort();
        }
        if (isProviderRequestByteLimitError(error)) {
          latestUsage = undefined;
          if (!requestByteRecoveryAttempted && input.onContextOverflow) {
            requestByteRecoveryAttempted = true;
            const episode = ++continuationEpisode;
            traceExecution(input.trace, {
              kind: 'continuation_started',
              providerStep: step,
              episode,
              attempt: 1,
              reason: 'provider_request_byte_limit',
            });
            if (input.contextPolicy) {
              emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
                action: 'triggered',
                trigger: 'provider_request_byte_limit',
                category: 'provider_request_byte_limit',
              });
            }
            let continuation: Awaited<ReturnType<AgentContextContinuation>>;
            try {
              continuation = await input.onContextOverflow({
                messages: [...messages],
                ...(tracksRawMessages ? { rawMessages: [...rawMessages] } : {}),
                step,
                trigger: 'provider_request_byte_limit',
              });
            } catch (continuationError) {
              if (
                signal?.aborted
                || (continuationError instanceof AgentProviderError
                  && continuationError.code === 'caller_abort')
              ) {
                traceExecution(input.trace, {
                  kind: 'continuation_finished',
                  providerStep: step,
                  episode,
                  attempt: 1,
                  outcome: 'cancelled',
                });
                return finishAfterAbort();
              }
              traceExecution(input.trace, {
                kind: 'continuation_finished',
                providerStep: step,
                episode,
                attempt: 1,
                outcome: 'failed',
              });
              emit({
                type: 'agent_error',
                sessionId: input.sessionId,
                message: publicAgentProviderErrorMessage(continuationError),
                category: providerErrorCategory(continuationError),
              });
              return finishWithRaw('provider_error', input.sessionId, messages, emit);
            }
            if (signal?.aborted || continuation.kind === 'aborted') {
              traceExecution(input.trace, {
                kind: 'continuation_finished',
                providerStep: step,
                episode,
                attempt: 1,
                outcome: 'cancelled',
              });
              return finishAfterAbort();
            }
            if (continuation.kind === 'context_limit') {
              traceExecution(input.trace, {
                kind: 'continuation_finished',
                providerStep: step,
                episode,
                attempt: 1,
                outcome: 'exhausted',
              });
              emit({
                type: 'agent_error',
                sessionId: input.sessionId,
                message: CONTEXT_LIMIT_EXCEEDED_MESSAGE,
              });
              return finishWithRaw(
                'context_limit',
                input.sessionId,
                messages,
                emit,
                continuation.reason ?? 'final_preflight_failed',
              );
            }
            traceExecution(input.trace, {
              kind: 'continuation_finished',
              providerStep: step,
              episode,
              attempt: 1,
              outcome: 'continued',
            });
            messages.splice(0, messages.length, ...continuation.messages);
            cumulativeToolResultBytes = toolResultBytesSinceLatestUser(messages);
            continue;
          }

          const repeated = requestByteRecoveryAttempted;
          const failureReason = repeated
            ? 'provider_request_byte_limit_repeated' as const
            : 'provider_request_byte_limit' as const;
          emit({
            type: 'agent_error',
            sessionId: input.sessionId,
            message: publicAgentProviderErrorMessage(error),
            category: providerErrorCategory(error),
          });
          if (input.contextPolicy) {
            emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
              action: 'terminal',
              category: failureReason,
            });
          }
          return finishWithRaw(
            'context_limit',
            input.sessionId,
            messages,
            emit,
            failureReason,
          );
        }
        if (error instanceof AgentProviderError && error.code === 'context_overflow') {
          latestUsage = undefined;
          if (!overflowRecoveryAttempted && input.onContextOverflow) {
            overflowRecoveryAttempted = true;
            const episode = ++continuationEpisode;
            traceExecution(input.trace, {
              kind: 'continuation_started',
              providerStep: step,
              episode,
              attempt: 1,
              reason: 'provider_context_overflow',
            });
            if (input.contextPolicy) {
              emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
                action: 'triggered',
                trigger: 'provider_context_overflow',
                category: 'provider_context_overflow',
              });
            }
            let continuation: Awaited<ReturnType<AgentContextContinuation>>;
            try {
              continuation = await input.onContextOverflow({
                messages: [...messages],
                ...(tracksRawMessages ? { rawMessages: [...rawMessages] } : {}),
                step,
                trigger: 'provider_context_overflow',
              });
            } catch (continuationError) {
              if (
                signal?.aborted
                || (continuationError instanceof AgentProviderError
                  && continuationError.code === 'caller_abort')
              ) {
                traceExecution(input.trace, {
                  kind: 'continuation_finished',
                  providerStep: step,
                  episode,
                  attempt: 1,
                  outcome: 'cancelled',
                });
                return finishAfterAbort();
              }
              traceExecution(input.trace, {
                kind: 'continuation_finished',
                providerStep: step,
                episode,
                attempt: 1,
                outcome: 'failed',
              });
              emit({
                type: 'agent_error',
                sessionId: input.sessionId,
                message: publicAgentProviderErrorMessage(continuationError),
                category: providerErrorCategory(continuationError),
              });
              return finishWithRaw('provider_error', input.sessionId, messages, emit);
            }
            if (signal?.aborted || continuation.kind === 'aborted') {
              traceExecution(input.trace, {
                kind: 'continuation_finished',
                providerStep: step,
                episode,
                attempt: 1,
                outcome: 'cancelled',
              });
              return finishAfterAbort();
            }
            if (continuation.kind === 'context_limit') {
              traceExecution(input.trace, {
                kind: 'continuation_finished',
                providerStep: step,
                episode,
                attempt: 1,
                outcome: 'exhausted',
              });
              emit({
                type: 'agent_error',
                sessionId: input.sessionId,
                message: CONTEXT_LIMIT_EXCEEDED_MESSAGE,
              });
              return finishWithRaw(
                'context_limit',
                input.sessionId,
                messages,
                emit,
                continuation.reason ?? 'final_preflight_failed',
              );
            }
            traceExecution(input.trace, {
              kind: 'continuation_finished',
              providerStep: step,
              episode,
              attempt: 1,
              outcome: 'continued',
            });
            messages.splice(0, messages.length, ...continuation.messages);
            cumulativeToolResultBytes = toolResultBytesSinceLatestUser(messages);
            continue;
          }

          const repeated = overflowRecoveryAttempted;
          const failureReason = repeated
            ? 'provider_context_overflow_repeated' as const
            : 'provider_context_overflow' as const;
          emit({
            type: 'agent_error',
            sessionId: input.sessionId,
            message: publicAgentProviderErrorMessage(error),
            category: providerErrorCategory(error),
          });
          if (input.contextPolicy) {
            emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
              action: 'terminal',
              category: failureReason,
            });
          }
          return finishWithRaw(
            'context_limit',
            input.sessionId,
            messages,
            emit,
            failureReason,
          );
        }
        emit({
          type: 'agent_error',
          sessionId: input.sessionId,
          message: publicAgentProviderErrorMessage(error),
          category: providerErrorCategory(error),
        });
        return finishWithRaw('provider_error', input.sessionId, messages, emit);
      } finally {
        requestLiveness?.finish();
      }
    }
    const toolCalls = response.toolCalls ?? [];
    const candidateUsedToolCallIds = new Set(usedToolCallIds);
    try {
      validateToolCallEnvelope(toolCalls, candidateUsedToolCallIds);
    } catch (error) {
      if (continuationAtStepStart) return returnContinuation('no_progress');
      const message = error instanceof ProtocolValidationError
        ? error.message
        : 'Provider tool calls failed protocol validation.';
      emit({ type: 'agent_error', sessionId: input.sessionId, message });
      return finishWithRaw('protocol_error', input.sessionId, messages, emit);
    }
    const violatesExclusiveToolEnvelope = toolCalls.length > 1 && toolCalls.some((call) => (
      toolMap.get(call.name)?.requiresExclusiveEnvelope === true
    ));
    let recoveredToolMemoryBeforeExecution = false;
    if (
      input.contextPolicy
      && toolCalls.length > 0
      && !violatesExclusiveToolEnvelope
      && (
        toolResultMemoryPressure(input.contextPolicy, cumulativeToolResultBytes)
        || !canFitMinimumToolResults(
          input.contextPolicy,
          cumulativeToolResultBytes,
          toolCalls.length,
        )
      )
    ) {
      if (input.onToolEnvelopeSettled) {
        const terminal = await continueAfterSettledToolBoundary(
          step,
          'tool_result_memory_pressure',
        );
        if (terminal) return terminal;
        recoveredToolMemoryBeforeExecution = true;
      }
      if (
        toolResultMemoryPressure(input.contextPolicy, cumulativeToolResultBytes)
        || !canFitMinimumToolResults(
          input.contextPolicy,
          cumulativeToolResultBytes,
          toolCalls.length,
        )
      ) {
        emit({
          type: 'agent_error',
          sessionId: input.sessionId,
          message: TOOL_RESULT_MEMORY_LIMIT_MESSAGE,
        });
        emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
          action: 'terminal',
          category: 'tool_result_memory_limit',
        });
        return finishWithRaw(
          'context_limit',
          input.sessionId,
          messages,
          emit,
          'tool_result_memory_limit',
        );
      }
    }
    for (const toolCall of toolCalls) {
      observeAgentContentCapture(input.contentCapture, (capture) => {
        capture.toolArguments({
          providerStep: step,
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          content: serializeAgentCaptureValue(toolCall.arguments),
        });
      });
      emit({
        type: 'tool_execution_queued',
        toolName: toolCall.name,
        callId: toolCall.id,
      });
      const queuedTool = toolMap.get(toolCall.name);
      if (queuedTool) {
        traceExecution(input.trace, {
          kind: 'tool_queued',
          providerStep: step,
          toolName: queuedTool.name,
          toolCallId: toolCall.id,
          toolClass: queuedTool.risk,
          risk: queuedTool.risk,
        });
      }
    }
    if (signal?.aborted && toolCalls.length === 0) {
      return finishAfterAbort();
    }
    if (
      !input.contextPolicy &&
      toolCalls.length > 0 &&
      cumulativeToolResultBytes + toolCalls.length * MIN_TOOL_RESULT_ENVELOPE_BYTES >
        MAX_TURN_TOOL_RESULT_BYTES
    ) {
      emit({
        type: 'agent_error',
        sessionId: input.sessionId,
        message: 'The model requested more tool calls than the remaining result budget can represent.',
      });
      return finishWithRaw('step_budget_reached', input.sessionId, messages, emit);
    }

    const assistantMessage: AgentMessage | undefined = response.content || toolCalls.length > 0
      ? {
        id: idFactory(),
        role: 'agent',
        content: continuationAtStepStart ? '' : response.content ?? '',
        createdAt: now(),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      }
      : undefined;

    if (toolCalls.length === 0) {
      if (continuationAtStepStart) return returnContinuation('no_progress');
      for (const event of bufferedPresentationEvents) emit(event);
      if (assistantMessage) {
        messages.push(assistantMessage);
        if (tracksRawMessages) rawMessages.push(assistantMessage);
        emit({ type: 'message_update', message: assistantMessage });
      }
      return finishWithRaw('final_answer', input.sessionId, messages, emit);
    }
    if (!assistantMessage) throw new Error('Tool calls require an assistant envelope.');
    const responseUsage = response.usage && !recoveredToolMemoryBeforeExecution
      ? {
          usage: response.usage,
          prefixMessageCount: modelMessages.length + 1,
        } satisfies ProviderUsageAnchor
      : undefined;

    let pendingStopReason: AgentStopReason | undefined;
    const completedPrefix: SuspendedToolResult[] = [];
    const stagedToolMessages: AgentMessage[] = [];
    let stagedToolResultBytes = 0;
    const priorRequiredBeforeFinal = requiredBeforeFinal;
    let nextRequiredBeforeFinal = priorRequiredBeforeFinal;
    const admissionTokens: unknown[] = [];
    const disposals: Array<() => Promise<void>> = [];
    let admissionFailed = false;
    const stagedAdmissions: Array<Readonly<{
      toolCall: ModelToolCall;
      outcome: ExecuteToolCallOutcome;
      originalResult: ToolResult;
      finalized: FinalizedToolResult;
      writeOutcome?: 'committed' | 'failed' | 'unknown';
      tracedTool?: AgentExecutableTool;
      transformed: boolean;
      retainOnNoProgress: boolean;
    }>> = [];
    for (const [index, toolCall] of toolCalls.entries()) {
      let resultAllowance: ToolResultAllowance;
      try {
        resultAllowance = violatesExclusiveToolEnvelope
          ? exclusiveToolResultAllowance()
          : resolveToolResultAllowance({
              policy: input.contextPolicy,
              messages,
              assistantMessage,
              stagedToolMessages,
              pendingToolCalls: toolCalls.slice(index),
              toolDefinitions,
              maxOutputTokens,
              latestUsage: responseUsage,
              cumulativeToolResultBytes: cumulativeToolResultBytes + stagedToolResultBytes,
              provider: input.provider,
              allowMinimumEnvelopeForContinuation: input.onToolEnvelopeSettled !== undefined,
            });
        if (input.contextPolicy) {
          emitContextDiagnostic(emit, input.sessionId, 'tool_allowance', input.contextPolicy, {
            contextRemainingTokens: resultAllowance.contextRemainingTokens,
            toolAllowanceBytes: resultAllowance.maxSerializedBytes,
            toolMemoryRemainingBytes: resultAllowance.memoryRemainingBytes,
            toolProviderResultCeilingBytes: resultAllowance.providerResultCeilingBytes,
            toolBudgetLimitedBy: toolBudgetLimitingFactor(resultAllowance),
          });
        }
      } catch (error) {
        if (!(error instanceof ToolResultBudgetError)) {
          await disposeBestEffort(disposals);
          throw error;
        }
        await disposeBestEffort(disposals);
        const reason = error.limitingFactor === 'provider'
          ? 'provider_request_byte_limit' as const
          : error.limitingFactor === 'context'
            ? 'current_turn_too_large' as const
            : 'tool_result_memory_limit' as const;
        emit({
          type: 'agent_error',
          sessionId: input.sessionId,
          message: reason === 'tool_result_memory_limit'
            ? TOOL_RESULT_MEMORY_LIMIT_MESSAGE
            : CONTEXT_LIMIT_EXCEEDED_MESSAGE,
        });
        if (input.contextPolicy) {
          emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
            action: 'terminal',
            category: reason,
          });
        }
        return finishWithRaw(
          'context_limit',
          input.sessionId,
          messages,
          emit,
          reason,
        );
      }
      let outcome: ExecuteToolCallOutcome;
      if (violatesExclusiveToolEnvelope) {
        outcome = {
          result: errorToolResult(
            'exclusive_tool_envelope_required',
            EXCLUSIVE_TOOL_ENVELOPE_REQUIRED_MESSAGE,
          ),
        };
      } else if (pendingStopReason) {
        outcome = {
          result: stopSiblingResult(pendingStopReason),
        };
      } else if (signal?.aborted) {
        pendingStopReason = 'aborted';
        outcome = {
          result: errorToolResult('tool_execution_aborted', 'Tool execution was aborted.'),
        };
      } else {
        input.liveness?.markAgentProgress();
        outcome = await executeToolCall({
          sessionId: input.sessionId,
          toolCall,
          toolMap,
          permissions,
          executionLedger: input.executionLedger,
          emit,
          trace: input.trace,
          providerStep: step,
          now,
          signal,
          resultAllowance,
        });
        pendingStopReason = outcome.stopReason;
      }

      if (outcome.suspension) {
        await disposeBestEffort(disposals);
        if (continuationAtStepStart) return returnContinuation('no_progress');
        for (const event of bufferedPresentationEvents) emit(event);
        return {
          sessionId: input.sessionId,
          messages,
          ...(tracksRawMessages ? { rawMessages } : {}),
          reason: 'interaction_required',
          suspension: {
            interactionKind: outcome.suspension.interactionKind,
            task: outcome.suspension.task,
            assistantEnvelope: {
              messageId: assistantMessage.id,
              content: assistantMessage.content,
              createdAt: assistantMessage.createdAt,
              finishReason: 'tool_calls',
              toolCalls: toolCalls.map((call, callIndex) => ({ ...call, index: callIndex })),
            },
            completedPrefix,
            pendingIndex: index,
            remainingStepBudget: maxSteps - step - 1,
            priorHistory: modelMessages,
          },
        };
      }
      if (!outcome.result) throw new Error('Tool execution produced no protocol result.');

      const originalResult = outcome.result;
      const writeOutcome = outcome.writeOutcome ?? (
        outcome.executedToolRisk === 'write'
          ? originalResult.ok ? 'committed' : 'unknown'
          : undefined
      );
      const finalizeCandidate = (candidate: ToolResult): FinalizedToolResult => (
        writeOutcome
          ? finalizeWriteToolResult(candidate, resultAllowance, writeOutcome)
          : finalizeToolResult(candidate, resultAllowance)
      );
      const originalFinalized = finalizeCandidate(originalResult);
      if (outcome.ledgerCallId) {
        input.executionLedger?.storeResult(outcome.ledgerCallId, originalFinalized.result);
      }

      const tracedTool = toolMap.get(toolCall.name);
      let finalized = originalFinalized;
      let opaqueReferences: string[] | undefined;
      let transformed = false;
      let retainOnNoProgress = false;
      let proposedAdmission: AgentToolResultAdmission | null = null;
      if (tracedTool && input.toolResultAdmissionHost) {
        try {
          proposedAdmission = await input.toolResultAdmissionHost.afterToolResult({
            sessionId: input.sessionId,
            assistantMessage,
            toolCall,
            result: originalResult,
            risk: tracedTool.risk,
            allowance: resultAllowance,
            requiredBeforeFinal: nextRequiredBeforeFinal,
          });
          if (proposedAdmission) {
            validateAgentToolResultAdmission(proposedAdmission);
            const admittedReferences = normalizeOpaqueReferences(
              proposedAdmission.opaqueReferences ?? [],
            );
            const admittedDirectives = proposedAdmission.requiredBeforeFinal === undefined
              ? undefined
              : normalizeRequiredBeforeFinal(proposedAdmission.requiredBeforeFinal);
            const proposedFinalized = finalizeCandidate(proposedAdmission.result);
            if (proposedFinalized.budgetReduced) {
              await disposeBestEffort(proposedAdmission.dispose ? [proposedAdmission.dispose] : []);
              proposedAdmission = null;
              admissionFailed = true;
              finalized = finalizeToolResult(
                errorToolResult('tool_result_admission_failed', TOOL_RESULT_ADMISSION_FAILED_MESSAGE),
                resultAllowance,
              );
            } else {
              finalized = proposedFinalized;
              transformed = true;
              opaqueReferences = admittedReferences.length > 0 ? admittedReferences : undefined;
              if (admittedDirectives !== undefined) {
                if (
                  continuationAtStepStart
                  && hasRequiredBeforeFinalProgress(nextRequiredBeforeFinal, admittedDirectives)
                ) {
                  requiredDirectiveProgressOccurred = true;
                }
                nextRequiredBeforeFinal = admittedDirectives;
              }
              if (proposedAdmission.admissionToken !== undefined) {
                admissionTokens.push(proposedAdmission.admissionToken);
              }
              if (proposedAdmission.dispose) disposals.push(proposedAdmission.dispose);
              retainOnNoProgress = proposedAdmission.retainOnNoProgress === true
                && proposedFinalized.result.ok
                && proposedAdmission.admissionToken !== undefined
                && typeof input.toolResultAdmissionHost?.admitEnvelope === 'function';
            }
          }
        } catch {
          await disposeBestEffort(proposedAdmission?.dispose ? [proposedAdmission.dispose] : []);
          admissionFailed = true;
          proposedAdmission = null;
          finalized = finalizeToolResult(
            errorToolResult('tool_result_admission_failed', TOOL_RESULT_ADMISSION_FAILED_MESSAGE),
            resultAllowance,
          );
        }
      }

      const message: AgentMessage = {
        id: idFactory(),
        role: 'tool',
        content: finalized.serialized,
        createdAt: now(),
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ...(opaqueReferences ? { opaqueReferences } : {}),
      };
      stagedToolMessages.push(message);
      completedPrefix.push({
        index,
        messageId: message.id,
        callId: toolCall.id,
        toolName: toolCall.name,
        serializedResult: finalized.serialized,
        createdAt: message.createdAt,
      });
      stagedToolResultBytes += finalized.byteLength;
      stagedAdmissions.push({
        toolCall,
        outcome,
        originalResult,
        finalized,
        ...(writeOutcome ? { writeOutcome } : {}),
        ...(tracedTool ? { tracedTool } : {}),
        transformed,
        retainOnNoProgress,
      });
    }

    if (
      signal?.aborted
      && (continuationAtStepStart || stagedAdmissions.some((admission) => admission.transformed))
    ) {
      await disposeBestEffort(disposals);
      return finishAfterAbort();
    }
    if (continuationAtStepStart && admissionFailed) {
      await disposeBestEffort(disposals);
      emit({
        type: 'agent_error',
        sessionId: input.sessionId,
        message: TOOL_RESULT_ADMISSION_FAILED_MESSAGE,
      });
      return finishWithRaw('provider_error', input.sessionId, messages, emit);
    }
    const retainsNoProgressEnvelope = stagedAdmissions.length > 0
      && stagedAdmissions.every((admission) => admission.retainOnNoProgress);
    if (
      continuationAtStepStart
      && !hasRequiredBeforeFinalProgress(priorRequiredBeforeFinal, nextRequiredBeforeFinal)
      && !retainsNoProgressEnvelope
    ) {
      await disposeBestEffort(disposals);
      return returnContinuation('no_progress');
    }

    const settledEnvelope = [assistantMessage, ...stagedToolMessages];
    const projectedMessages = [...messages, ...settledEnvelope];
    const canonicalRawBase = tracksRawMessages ? rawMessages : messages;
    const canonicalRawMessages = continuationAtStepStart
      ? [...canonicalRawBase]
      : [...canonicalRawBase, ...settledEnvelope];
    try {
      if (
        (continuationAtStepStart || stagedAdmissions.some((admission) => admission.transformed))
        && !input.toolResultAdmissionHost?.admitEnvelope
      ) {
        throw new TypeError('Transformed envelopes require a host checkpoint.');
      }
      validateProviderProtocolHistory(projectedMessages.map(toModelMessage));
      await input.toolResultAdmissionHost?.admitEnvelope?.({
        admissionTokens,
        requiredBeforeFinal: nextRequiredBeforeFinal,
        projectedMessages,
        canonicalRawMessages,
        envelopeKind: continuationAtStepStart ? 'internal_continuation' : 'canonical_source',
      });
    } catch {
      await disposeBestEffort(disposals);
      if (signal?.aborted) return finishAfterAbort();
      emit({
        type: 'agent_error',
        sessionId: input.sessionId,
        message: TOOL_RESULT_ADMISSION_FAILED_MESSAGE,
      });
      return finishWithRaw('provider_error', input.sessionId, messages, emit);
    }
    if (continuationAtStepStart || nextRequiredBeforeFinal.length > 0) {
      nonterminalContinuationActive = true;
    }

    for (const toolCall of toolCalls) usedToolCallIds.add(toolCall.id);
    requiredBeforeFinal = nextRequiredBeforeFinal;
    messages.push(...settledEnvelope);
    if (tracksRawMessages && !continuationAtStepStart) rawMessages.push(...settledEnvelope);
    latestUsage = responseUsage;
    cumulativeToolResultBytes += stagedAdmissions.reduce(
      (total, admission) => total + admission.finalized.byteLength,
      0,
    );

    for (const admission of stagedAdmissions) {
      observeAgentContentCapture(input.contentCapture, (capture) => {
        capture.toolResult({
          providerStep: step,
          toolName: admission.toolCall.name,
          toolCallId: admission.toolCall.id,
          content: admission.finalized.serialized,
        });
      });
      if (admission.tracedTool && input.trace) {
        traceExecution(input.trace, {
          kind: 'tool_result_admitted',
          providerStep: step,
          toolName: admission.tracedTool.name,
          toolCallId: admission.toolCall.id,
          originalBytes: serializedToolResultByteLength(admission.originalResult),
          admittedBytes: admission.finalized.byteLength,
          reduction: admission.transformed
            ? 'structural'
            : admission.finalized.budgetReduced ? 'error_envelope' : 'none',
        });
        if (admission.tracedTool.risk === 'write' && admission.writeOutcome) {
          traceExecution(input.trace, {
            kind: 'tool_write_outcome',
            providerStep: step,
            toolName: admission.tracedTool.name,
            toolCallId: admission.toolCall.id,
            effectCount: admission.outcome.effectCount ?? null,
            state: admission.writeOutcome,
          });
        }
        traceExecution(input.trace, {
          kind: 'tool_completed',
          providerStep: step,
          toolName: admission.tracedTool.name,
          toolCallId: admission.toolCall.id,
          outcome: pendingStopReason === 'aborted' || signal?.aborted
            ? 'cancelled'
            : admission.finalized.result.ok ? 'success' : 'error',
          durationMs: admission.outcome.durationMs ?? null,
        });
      }
      if (input.contextPolicy) {
        emitContextDiagnostic(emit, input.sessionId, 'tool_allowance', input.contextPolicy, {
          toolResultBytes: admission.finalized.byteLength,
          toolResultReduced: admission.finalized.budgetReduced,
        });
      }
      if (admission.outcome.executedToolName && admission.outcome.executedToolRisk) {
        emit({
          type: 'tool_execution_end',
          toolName: admission.outcome.executedToolName,
          callId: admission.toolCall.id,
          risk: admission.outcome.executedToolRisk,
          ok: admission.finalized.result.ok,
          writeOutcome: admission.outcome.executedToolRisk === 'write'
            ? admission.writeOutcome ?? 'unknown'
            : 'not_applicable',
        });
        input.liveness?.markAgentProgress();
      }
    }
    if (!continuationAtStepStart) {
      for (const event of bufferedPresentationEvents) emit(event);
      for (const message of settledEnvelope) emit({ type: 'message_update', message });
    }
    if (pendingStopReason && (!continuationAtStepStart || pendingStopReason === 'aborted')) {
      return pendingStopReason === 'aborted'
        ? finishAfterAbort()
        : finishWithRaw(pendingStopReason, input.sessionId, messages, emit);
    }
    if (
      continuationAtStepStart !== (requiredBeforeFinal.length > 0)
      || priorRequiredBeforeFinal.length !== requiredBeforeFinal.length
      || priorRequiredBeforeFinal.some((directive, index) => (
        directive.reference !== requiredBeforeFinal[index]?.reference
      ))
    ) return returnContinuation('episode_exhausted');
    if (input.contextPolicy) {
      const nextModelMessages = messages.map(toModelMessage);
      const nextProjection = preflightContextRequest({
        messages: nextModelMessages,
        toolSchemas: toolDefinitions,
        maxOutputTokens,
        ...(latestUsage ? { latestUsage } : {}),
      }, input.contextPolicy);
      emitContextDiagnostic(emit, input.sessionId, 'post_tool', input.contextPolicy, {
        inputTokens: nextProjection.inputTokens,
        deterministicInputTokens: deterministicInputTokens(nextProjection),
        usageAdjustmentTokens: usageAdjustmentTokens(nextProjection),
        observedPrefixTokens: providerPrefixTokens(nextProjection),
      });
      const nextRequestInspection = input.provider.inspectRequest?.({
        messages: nextModelMessages,
        tools: toolDefinitions,
        maxOutputTokens,
      });
      const bytePressure = nextRequestInspection?.accepted === false;
      const memoryPressure = toolResultMemoryPressure(
        input.contextPolicy,
        cumulativeToolResultBytes,
      );
      if (shouldCompact(nextProjection, input.contextPolicy) || bytePressure || memoryPressure) {
        if (!input.onToolEnvelopeSettled) {
          if (!nextProjection.accepted || bytePressure) {
            if (bytePressure) {
              emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
                action: 'triggered',
                trigger: 'provider_request_byte_limit',
                category: 'provider_request_byte_limit',
              });
            }
            emit({
              type: 'agent_error',
              sessionId: input.sessionId,
              message: CONTEXT_LIMIT_EXCEEDED_MESSAGE,
            });
            return finishWithRaw(
              'context_limit',
              input.sessionId,
              messages,
              emit,
              bytePressure ? 'provider_request_byte_limit' : 'current_turn_too_large',
            );
          }
        } else {
          const trigger = memoryPressure
            ? 'tool_result_memory_pressure' as const
            : bytePressure
              ? 'provider_request_byte_limit' as const
              : 'completed_tool_envelope' as const;
          const terminal = await continueAfterSettledToolBoundary(step, trigger);
          if (terminal) return terminal;
        }
      }
    }
  }

  if (nonterminalContinuationActive) {
    return episodeStartedWithRequiredDirectives && !requiredDirectiveProgressOccurred
      ? returnContinuation('no_progress')
      : returnContinuation('episode_exhausted');
  }
  return finishWithRaw('step_budget_reached', input.sessionId, messages, emit);

  function finishWithRaw(
    reason: AgentStopReason,
    finishedSessionId: string,
    projection: AgentMessage[],
    eventEmitter: (event: AgentEvent) => void,
    contextFailureReason?: AgentContextFailureReason,
  ): AgentTerminalLoopResult {
    return finish(
      reason,
      finishedSessionId,
      projection,
      eventEmitter,
      contextFailureReason,
      tracksRawMessages ? rawMessages : undefined,
    );
  }
}

function finish(
  reason: AgentStopReason,
  sessionId: string,
  messages: AgentMessage[],
  emit: (event: AgentEvent) => void,
  contextFailureReason?: AgentContextFailureReason,
  rawMessages?: AgentMessage[],
): AgentTerminalLoopResult {
  emit({
    type: 'agent_done',
    sessionId,
    reason,
    ...(contextFailureReason ? { contextFailureReason } : {}),
  });
  return {
    sessionId,
    messages,
    ...(rawMessages ? { rawMessages } : {}),
    reason,
    ...(contextFailureReason ? { contextFailureReason } : {}),
  };
}

function validateAgentToolResultAdmission(admission: AgentToolResultAdmission): void {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
    throw new TypeError('Invalid tool-result admission.');
  }
  const result = admission.result as ToolResult | undefined;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('Invalid admitted tool result.');
  }
  if (result.ok === true) {
    if (!('data' in result)) throw new TypeError('Invalid admitted success result.');
  } else if (
    result.ok !== false
    || !result.error
    || typeof result.error.code !== 'string'
    || typeof result.error.message !== 'string'
  ) {
    throw new TypeError('Invalid admitted error result.');
  }
  if (admission.dispose !== undefined && typeof admission.dispose !== 'function') {
    throw new TypeError('Invalid admission disposer.');
  }
  if (admission.retainOnNoProgress !== undefined && typeof admission.retainOnNoProgress !== 'boolean') {
    throw new TypeError('Invalid no-progress admission marker.');
  }
}

function normalizeOpaqueReferences(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_AGENT_OPAQUE_VALUES) {
    throw new TypeError('Invalid opaque references.');
  }
  const normalized = values.map((value) => normalizeOpaqueValue(value));
  normalized.sort();
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index] === normalized[index - 1]) {
      throw new TypeError('Duplicate opaque reference.');
    }
  }
  return normalized;
}

function normalizeRequiredBeforeFinal(
  values: readonly AgentRequiredBeforeFinalDirective[],
): AgentRequiredBeforeFinalDirective[] {
  if (!Array.isArray(values) || values.length > MAX_AGENT_OPAQUE_VALUES) {
    throw new TypeError('Invalid required-before-final directives.');
  }
  const normalized = values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Invalid required-before-final directive.');
    }
    if (value.requiredBeforeFinal !== true) {
      throw new TypeError('Invalid required-before-final directive marker.');
    }
    return {
      reference: normalizeOpaqueValue(value.reference),
      progressToken: normalizeOpaqueValue(value.progressToken),
      requiredBeforeFinal: true as const,
    };
  });
  normalized.sort((left, right) => (
    left.reference < right.reference ? -1 : left.reference > right.reference ? 1 : 0
  ));
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index]?.reference === normalized[index - 1]?.reference) {
      throw new TypeError('Duplicate required-before-final directive.');
    }
  }
  return normalized;
}

function normalizeOpaqueValue(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || utf8ByteLength(value) > MAX_AGENT_OPAQUE_VALUE_BYTES
  ) {
    throw new TypeError('Invalid opaque admission value.');
  }
  return value;
}

function hasRequiredBeforeFinalProgress(
  previous: readonly AgentRequiredBeforeFinalDirective[],
  next: readonly AgentRequiredBeforeFinalDirective[],
): boolean {
  const nextByReference = new Map(next.map((directive) => [directive.reference, directive]));
  return previous.some((directive) => (
    nextByReference.get(directive.reference)?.progressToken !== directive.progressToken
  ));
}

async function disposeBestEffort(disposals: readonly (() => Promise<void>)[]): Promise<void> {
  for (const dispose of disposals) {
    try {
      await dispose();
    } catch {
      // The host owns its cleanup backstop; admission must not surface disposal failures.
    }
  }
}

type ExecuteToolCallOutcome = {
  result?: ToolResult;
  suspension?: AgentToolSuspendOutcome;
  executedToolName?: string;
  executedToolRisk?: ToolRisk;
  writeOutcome?: 'committed' | 'failed' | 'unknown';
  ledgerCallId?: string;
  stopReason?: AgentStopReason;
  durationMs?: number;
  effectCount?: number;
};

async function executeToolCall(input: {
  sessionId: string;
  toolCall: ModelToolCall;
  toolMap: Map<string, AgentExecutableTool>;
  permissions: PermissionEvaluator;
  executionLedger?: AgentExecutionLedger;
  emit: (event: AgentEvent) => void;
  trace?: AgentExecutionTraceSink;
  providerStep: number;
  now: () => number;
  signal?: AbortSignal;
  resultAllowance: ToolResultAllowance;
}): Promise<ExecuteToolCallOutcome> {
  const tool = input.toolMap.get(input.toolCall.name);
  if (!tool) {
    return {
      result: errorToolResult('unknown_tool', `Unknown tool: ${input.toolCall.name}`),
    };
  }

  let args: unknown;
  try {
    args = tool.validate ? tool.validate(input.toolCall.arguments) : input.toolCall.arguments;
  } catch {
    return {
      result: errorToolResult('invalid_arguments', INVALID_ARGUMENTS_MESSAGE),
    };
  }

  let executionArgs = args;
  let ledgerWrite: {
    plan: WriteEffectPlan<unknown, unknown>;
    effects: readonly CanonicalToolEffect[];
    selectedEffects: readonly CanonicalToolEffect[];
  } | undefined;
  if (input.executionLedger && tool.risk === 'write') {
    const plan = tool.writeEffectPlan as WriteEffectPlan<unknown, unknown> | undefined;
    if (!plan) {
      return {
        result: errorToolResult('write_effect_plan_required', WRITE_EFFECT_PLAN_REQUIRED_MESSAGE),
      };
    }
    let effects: readonly CanonicalToolEffect[];
    try {
      effects = plan.canonicalEffects(args);
      if (effects.length === 0) throw new TypeError('Write effects must not be empty.');
    } catch {
      return {
        result: errorToolResult('invalid_arguments', INVALID_ARGUMENTS_MESSAGE),
      };
    }
    const inspection = input.executionLedger.inspect({
      callId: input.toolCall.id,
      toolName: tool.name,
      args,
      effects,
    });
    if (inspection.kind === 'conflict') {
      return {
        result: errorToolResult(
          'tool_call_conflict',
          'A tool call ID was reused with different arguments.',
        ),
        stopReason: 'protocol_error',
      };
    }
    if (inspection.kind === 'blocked') {
      return {
        result: errorToolResult('write_replay_blocked', WRITE_REPLAY_BLOCKED_MESSAGE),
      };
    }
    if (inspection.kind === 'replay_call') {
      return {
        result: inspection.result,
        writeOutcome: inspection.state === 'committed' ? 'committed' : 'failed',
        effectCount: effects.length,
      };
    }
    if (inspection.kind === 'replay_effects') {
      if (!plan.replayResult) {
        return {
          result: errorToolResult('write_replay_blocked', WRITE_REPLAY_BLOCKED_MESSAGE),
        };
      }
      let replayData: unknown;
      try {
        replayData = plan.replayResult(args);
      } catch {
        return {
          result: errorToolResult('write_replay_blocked', WRITE_REPLAY_BLOCKED_MESSAGE),
        };
      }
      input.executionLedger.authorize({
        callId: input.toolCall.id,
        toolName: tool.name,
        args,
        effects,
        selectedEffects: [],
      });
      input.executionLedger.settle(input.toolCall.id, 'committed');
      return {
        result: okToolResult(replayData),
        writeOutcome: 'committed',
        ledgerCallId: input.toolCall.id,
        effectCount: effects.length,
      };
    }
    if (inspection.committedEffects.length > 0) {
      if (!plan.selectEffects) {
        return {
          result: errorToolResult('write_replay_blocked', WRITE_REPLAY_BLOCKED_MESSAGE),
        };
      }
      try {
        executionArgs = plan.selectEffects(args, inspection.newEffects);
      } catch {
        return {
          result: errorToolResult('invalid_arguments', INVALID_ARGUMENTS_MESSAGE),
        };
      }
    }
    ledgerWrite = {
      plan,
      effects,
      selectedEffects: inspection.newEffects,
    };
  }

  let decision: PermissionDecision;
  try {
    decision = await input.permissions(tool, executionArgs, {
      sessionId: input.sessionId,
      toolCall: input.toolCall,
    });
  } catch {
    if (input.signal?.aborted) return abortedToolOutcome();
    return {
      result: errorToolResult(
        'permission_evaluation_failed',
        PERMISSION_EVALUATION_FAILED_MESSAGE,
      ),
    };
  }
  if (input.signal?.aborted) return abortedToolOutcome();

  if (decision.type === 'deny') {
    traceExecution(input.trace, {
      kind: 'tool_authorized',
      providerStep: input.providerStep,
      toolName: tool.name,
      toolCallId: input.toolCall.id,
      decision: 'deny',
    });
    return {
      result: errorToolResult('permission_denied', decision.reason),
    };
  }

  if (decision.type === 'approval_required') {
    traceExecution(input.trace, {
      kind: 'tool_authorized',
      providerStep: input.providerStep,
      toolName: tool.name,
      toolCallId: input.toolCall.id,
      decision: 'confirm',
    });
    input.emit({
      type: 'approval_required',
      callId: input.toolCall.id,
      summary: decision.summary,
    });
    return {
      result: errorToolResult('approval_required', decision.summary),
      stopReason: 'approval_required',
    };
  }

  traceExecution(input.trace, {
    kind: 'tool_authorized',
    providerStep: input.providerStep,
    toolName: tool.name,
    toolCallId: input.toolCall.id,
    decision: 'allow',
  });

  if (ledgerWrite && input.executionLedger) {
    input.executionLedger.authorize({
      callId: input.toolCall.id,
      toolName: tool.name,
      args,
      effects: ledgerWrite.effects,
      selectedEffects: ledgerWrite.selectedEffects,
    });
  }
  if (input.signal?.aborted) {
    if (ledgerWrite) input.executionLedger?.settle(input.toolCall.id, 'failed');
    return {
      ...abortedToolOutcome(),
      ...(ledgerWrite ? { ledgerCallId: input.toolCall.id, writeOutcome: 'failed' as const } : {}),
    };
  }

  input.emit({
    type: 'tool_execution_start',
    toolName: tool.name,
    callId: input.toolCall.id,
    risk: tool.risk,
  });
  const toolStartedAt = input.trace ? input.now() : null;
  traceExecution(input.trace, {
    kind: 'tool_started',
    providerStep: input.providerStep,
    toolName: tool.name,
    toolCallId: input.toolCall.id,
    attempt: 1,
  });

  let writeStarted = false;
  const markWriteStarted = () => {
    if (!ledgerWrite || writeStarted) return;
    writeStarted = true;
    input.executionLedger?.markStarted(input.toolCall.id);
  };
  if (ledgerWrite?.plan.startBoundary !== 'delegated') markWriteStarted();

  try {
    const data = await tool.execute(executionArgs, {
      sessionId: input.sessionId,
      callId: input.toolCall.id,
      resultAllowance: input.resultAllowance,
      signal: input.signal,
      ...(ledgerWrite ? { markWriteStarted } : {}),
    });
    if (input.signal?.aborted && (!ledgerWrite || !writeStarted)) {
      if (ledgerWrite) input.executionLedger?.settle(input.toolCall.id, 'failed');
      return {
        ...abortedToolOutcome(tool.name, tool.risk),
        ...(ledgerWrite ? { ledgerCallId: input.toolCall.id, writeOutcome: 'failed' as const } : {}),
        durationMs: traceDuration(toolStartedAt, input.now),
        ...(ledgerWrite ? { effectCount: ledgerWrite.effects.length } : {}),
      };
    }
    const interaction = 'interaction' in tool ? tool.interaction : undefined;
    if (isAgentToolSuspendOutcome(data, interaction)) {
      return {
        suspension: data,
        executedToolName: tool.name,
        executedToolRisk: tool.risk,
        durationMs: traceDuration(toolStartedAt, input.now),
        ...(ledgerWrite ? { effectCount: ledgerWrite.effects.length } : {}),
      };
    }
    const writeOutcome = ledgerWrite
      ? ledgerWrite.plan.classifyResult?.(data) ?? 'committed'
      : undefined;
    if (ledgerWrite && writeOutcome) {
      input.executionLedger?.settle(input.toolCall.id, writeOutcome);
    }
    const result = okToolResult(data);
    return {
      result,
      executedToolName: tool.name,
      executedToolRisk: tool.risk,
      ...(writeOutcome ? {
        writeOutcome,
        ledgerCallId: input.toolCall.id,
        effectCount: ledgerWrite?.effects.length ?? 0,
      } : {}),
      durationMs: traceDuration(toolStartedAt, input.now),
      ...(input.signal?.aborted ? { stopReason: 'aborted' as const } : {}),
    };
  } catch (error) {
    const writeOutcome = ledgerWrite
      ? writeStarted ? 'unknown' as const : 'failed' as const
      : undefined;
    if (ledgerWrite && writeOutcome) {
      input.executionLedger?.settle(input.toolCall.id, writeOutcome);
    }
    if (input.signal?.aborted) {
      return {
        result: errorToolResult('tool_execution_aborted', 'Tool execution was aborted.'),
        executedToolName: tool.name,
        executedToolRisk: tool.risk,
        ...(writeOutcome ? {
          writeOutcome,
          ledgerCallId: input.toolCall.id,
          effectCount: ledgerWrite?.effects.length ?? 0,
        } : {}),
        stopReason: 'aborted',
        durationMs: traceDuration(toolStartedAt, input.now),
      };
    }
    const outputTooLarge = error instanceof ToolOutputTooLargeError;
    return {
      result: errorToolResult(
        outputTooLarge ? 'tool_output_too_large' : 'tool_execution_failed',
        outputTooLarge ? TOOL_OUTPUT_TOO_LARGE_MESSAGE : TOOL_EXECUTION_FAILED_MESSAGE,
      ),
      executedToolName: tool.name,
      executedToolRisk: tool.risk,
      ...(writeOutcome ? {
        writeOutcome,
        ledgerCallId: input.toolCall.id,
        effectCount: ledgerWrite?.effects.length ?? 0,
      } : {}),
      durationMs: traceDuration(toolStartedAt, input.now),
    };
  }
}

function resolveToolResultAllowance(input: Readonly<{
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

function canFitMinimumToolResults(
  policy: Pick<ContextBudgetPolicy, 'memoryResultCeilingBytes'>,
  cumulativeToolResultBytes: number,
  pendingToolCallCount: number,
): boolean {
  return cumulativeToolResultBytes
    + pendingToolCallCount * MIN_TOOL_RESULT_ENVELOPE_BYTES
    <= policy.memoryResultCeilingBytes;
}

function toolResultMemoryPressure(
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

function exclusiveToolResultAllowance(): ToolResultAllowance {
  return {
    maxSerializedBytes: MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
    contextRemainingTokens: Number.MAX_SAFE_INTEGER,
    memoryRemainingBytes: MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
    providerResultCeilingBytes: MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  };
}

function abortedToolOutcome(
  executedToolName?: string,
  executedToolRisk?: ToolRisk,
): ExecuteToolCallOutcome & { stopReason: 'aborted' } {
  return {
    result: errorToolResult('tool_execution_aborted', 'Tool execution was aborted.'),
    ...(executedToolName ? { executedToolName } : {}),
    ...(executedToolRisk ? { executedToolRisk } : {}),
    stopReason: 'aborted',
  };
}

function stopSiblingResult(reason: AgentStopReason): ToolResult {
  if (reason === 'approval_required') {
    return errorToolResult(
      'not_executed_due_to_approval',
      'Tool was not executed because an earlier call requires approval.',
    );
  }
  return errorToolResult(
    'not_executed_due_to_abort',
    'Tool was not executed because the turn was aborted.',
  );
}

function toolResultBytesSinceLatestUser(messages: readonly AgentMessage[]): number {
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

function collectToolCallIds(
  messages: readonly AgentMessage[],
  rawMessages: readonly AgentMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of [...messages, ...rawMessages]) {
    for (const call of message.toolCalls ?? []) ids.add(call.id);
  }
  return ids;
}

function providerErrorCategory(error: unknown): AgentErrorCategory {
  if (error instanceof AgentProviderError) {
    if (error.code === 'context_overflow') return 'capability';
    return error.status === 401 || error.status === 403 ? 'authentication' : 'provider';
  }
  const code = error instanceof Error ? error.message : '';
  if (code === AGENT_DATA_DISCLOSURE_REQUIRED) return 'disclosure';
  if (code === AGENT_HOST_PERMISSION_DENIED) return 'permission';
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
  response: Awaited<ReturnType<ModelProvider['generate']>>,
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

function providerPrefixTokens(estimate: object): number | null {
  return 'providerPrefixTokens' in estimate &&
    (typeof estimate.providerPrefixTokens === 'number' || estimate.providerPrefixTokens === null)
    ? estimate.providerPrefixTokens
    : null;
}

function deterministicInputTokens(estimate: { inputTokens: number }): number {
  return 'deterministicInputTokens' in estimate &&
    typeof estimate.deterministicInputTokens === 'number'
    ? estimate.deterministicInputTokens
    : estimate.inputTokens;
}

function usageAdjustmentTokens(estimate: { inputTokens: number }): number {
  return Math.max(0, estimate.inputTokens - deterministicInputTokens(estimate));
}

function toolBudgetLimitingFactor(
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

function emitContextDiagnostic(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  stage: Extract<AgentEvent, { type: 'context_diagnostic' }>['stage'],
  policy: ContextBudgetPolicy,
  metrics: Readonly<{
    inputTokens?: number;
    deterministicInputTokens?: number;
    usageAdjustmentTokens?: number;
    observedPrefixTokens?: number | null;
    contextRemainingTokens?: number;
    toolAllowanceBytes?: number;
    toolMemoryRemainingBytes?: number;
    toolProviderResultCeilingBytes?: number;
    toolBudgetLimitedBy?: 'context' | 'memory' | 'provider' | 'multiple';
    toolResultBytes?: number;
    toolResultReduced?: boolean;
    action?: NonNullable<Extract<AgentEvent, { type: 'context_diagnostic' }>['action']>;
    trigger?: NonNullable<Extract<AgentEvent, { type: 'context_diagnostic' }>['trigger']>;
    category?: NonNullable<Extract<AgentEvent, { type: 'context_diagnostic' }>['category']>;
  }>,
): void {
  emit({
    type: 'context_diagnostic',
    sessionId,
    stage,
    providerWindow: policy.providerWindow,
    workingWindow: policy.workingWindow,
    softLimit: policy.softLimit,
    hardLimit: policy.hardLimit,
    capabilitySource: policy.capabilitySource,
    capabilityRevision: policy.capabilityRevision,
    policyRevision: policy.policyRevision,
    ...metrics,
  });
}

function traceDuration(startedAt: number | null, now: () => number): number | undefined {
  return startedAt === null ? undefined : Math.max(0, now() - startedAt);
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
