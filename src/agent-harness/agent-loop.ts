import {
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_HOST_PERMISSION_DENIED,
  AGENT_PROVIDER_IDENTITY_CHANGED,
} from '@/api/errors';
import {
  DEFAULT_MAX_AGENT_STEPS,
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

export type AgentLoopResult = {
  sessionId: string;
  messages: AgentMessage[];
  /** Append-only turn transcript; unlike messages, compaction never replaces it. */
  rawMessages?: AgentMessage[];
  reason: AgentStopReason;
  contextFailureReason?: AgentContextFailureReason;
  suspension?: AgentLoopSuspensionCandidate;
};

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
  /** Owns ordinary-turn watchdogs and the Provider request signals they create. */
  liveness?: AgentTurnLiveness;
  signal?: AbortSignal;
  idFactory?: () => string;
  now?: () => number;
};

export type AgentContextContinuation = (
  input: Readonly<{
    messages: readonly AgentMessage[];
    /** Present only when the caller opted into the append-only turn transcript. */
    rawMessages?: readonly AgentMessage[];
    step: number;
    trigger:
      | 'completed_tool_envelope'
      | 'provider_context_overflow'
      | 'provider_request_byte_limit';
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
const CONTEXT_LIMIT_EXCEEDED_MESSAGE = 'Context limit exceeded.';

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
  let cumulativeToolResultBytes = toolResultBytesSinceLatestUser(
    tracksRawMessages ? rawMessages : messages,
  );
  let latestUsage: ProviderUsageAnchor | undefined;
  let overflowRecoveryAttempted = false;
  let requestByteRecoveryAttempted = false;
  let continuationEpisode = 0;
  const signal = input.liveness?.signal ?? input.signal;

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

  emit({ type: 'agent_start', sessionId: input.sessionId });

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      return finishAfterAbort();
    }

    emit({ type: 'turn_start', sessionId: input.sessionId, step });

    let modelMessages: ReturnType<typeof toModelMessage>[];
    let response: Awaited<ReturnType<ModelProvider['generate']>>;
    let requestAttempt = 0;
    while (true) {
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
              emit({ type: 'assistant_stream_start', sessionId: input.sessionId, step });
            } else if (event.type === 'text_delta') {
              emit({
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
    try {
      validateToolCallEnvelope(toolCalls, usedToolCallIds);
    } catch (error) {
      const message = error instanceof ProtocolValidationError
        ? error.message
        : 'Provider tool calls failed protocol validation.';
      emit({ type: 'agent_error', sessionId: input.sessionId, message });
      return finishWithRaw('protocol_error', input.sessionId, messages, emit);
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
        content: response.content ?? '',
        createdAt: now(),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      }
      : undefined;

    if (toolCalls.length === 0) {
      if (assistantMessage) {
        messages.push(assistantMessage);
        if (tracksRawMessages) rawMessages.push(assistantMessage);
        emit({ type: 'message_update', message: assistantMessage });
      }
      return finishWithRaw('final_answer', input.sessionId, messages, emit);
    }
    if (!assistantMessage) throw new Error('Tool calls require an assistant envelope.');
    const responseUsage = response.usage
      ? {
          usage: response.usage,
          prefixMessageCount: modelMessages.length + 1,
        } satisfies ProviderUsageAnchor
      : undefined;

    let pendingStopReason: AgentStopReason | undefined;
    const completedPrefix: SuspendedToolResult[] = [];
    const stagedToolMessages: AgentMessage[] = [];
    for (const [index, toolCall] of toolCalls.entries()) {
      let resultAllowance: ToolResultAllowance;
      try {
        resultAllowance = resolveToolResultAllowance({
          policy: input.contextPolicy,
          messages,
          assistantMessage,
          stagedToolMessages,
          pendingToolCalls: toolCalls.slice(index),
          toolDefinitions,
          maxOutputTokens,
          latestUsage: responseUsage,
          cumulativeToolResultBytes,
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
        if (!(error instanceof ToolResultBudgetError)) throw error;
        emit({
          type: 'agent_error',
          sessionId: input.sessionId,
          message: 'The model requested more tool calls than the remaining result budget can represent.',
        });
        return finishWithRaw(
          'context_limit',
          input.sessionId,
          messages,
          emit,
          'current_turn_too_large',
        );
      }
      let outcome: ExecuteToolCallOutcome;
      if (pendingStopReason) {
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

      const writeOutcome = outcome.writeOutcome ?? (
        outcome.executedToolRisk === 'write'
          ? outcome.result.ok ? 'committed' : 'unknown'
          : undefined
      );
      const finalized = writeOutcome
        ? finalizeWriteToolResult(outcome.result, resultAllowance, writeOutcome)
        : finalizeToolResult(outcome.result, resultAllowance);
      observeAgentContentCapture(input.contentCapture, (capture) => {
        capture.toolResult({
          providerStep: step,
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          content: finalized.serialized,
        });
      });
      const tracedTool = toolMap.get(toolCall.name);
      if (tracedTool && input.trace) {
        traceExecution(input.trace, {
          kind: 'tool_result_admitted',
          providerStep: step,
          toolName: tracedTool.name,
          toolCallId: toolCall.id,
          originalBytes: serializedToolResultByteLength(outcome.result),
          admittedBytes: finalized.byteLength,
          reduction: finalized.budgetReduced ? 'error_envelope' : 'none',
        });
        if (tracedTool.risk === 'write' && writeOutcome) {
          traceExecution(input.trace, {
            kind: 'tool_write_outcome',
            providerStep: step,
            toolName: tracedTool.name,
            toolCallId: toolCall.id,
            effectCount: outcome.effectCount ?? null,
            state: writeOutcome,
          });
        }
        traceExecution(input.trace, {
          kind: 'tool_completed',
          providerStep: step,
          toolName: tracedTool.name,
          toolCallId: toolCall.id,
          outcome: pendingStopReason === 'aborted' || signal?.aborted
            ? 'cancelled'
            : finalized.result.ok ? 'success' : 'error',
          durationMs: outcome.durationMs ?? null,
        });
      }
      if (input.contextPolicy) {
        emitContextDiagnostic(emit, input.sessionId, 'tool_allowance', input.contextPolicy, {
          toolResultBytes: finalized.byteLength,
          toolResultReduced: finalized.budgetReduced,
        });
      }
      cumulativeToolResultBytes += finalized.byteLength;
      if (outcome.ledgerCallId) {
        input.executionLedger?.storeResult(outcome.ledgerCallId, finalized.result);
      }

      if (outcome.executedToolName && outcome.executedToolRisk) {
        emit({
          type: 'tool_execution_end',
          toolName: outcome.executedToolName,
          callId: toolCall.id,
          risk: outcome.executedToolRisk,
          ok: finalized.result.ok,
          writeOutcome: outcome.executedToolRisk === 'write'
            ? writeOutcome ?? 'unknown'
            : 'not_applicable',
        });
        input.liveness?.markAgentProgress();
      }

      const message: AgentMessage = {
        id: idFactory(),
        role: 'tool',
        content: finalized.serialized,
        createdAt: now(),
        toolCallId: toolCall.id,
        toolName: toolCall.name,
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
    }
    const settledEnvelope = [assistantMessage, ...stagedToolMessages];
    messages.push(...settledEnvelope);
    if (tracksRawMessages) rawMessages.push(...settledEnvelope);
    latestUsage = responseUsage;
    for (const message of settledEnvelope) emit({ type: 'message_update', message });
    if (pendingStopReason) {
      return pendingStopReason === 'aborted'
        ? finishAfterAbort()
        : finishWithRaw(pendingStopReason, input.sessionId, messages, emit);
    }
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
      if (shouldCompact(nextProjection, input.contextPolicy) || bytePressure) {
        if (bytePressure) {
          emitContextDiagnostic(emit, input.sessionId, 'compaction', input.contextPolicy, {
            action: 'triggered',
            trigger: 'provider_request_byte_limit',
            category: 'provider_request_byte_limit',
          });
        }
        if (!input.onToolEnvelopeSettled) {
          if (!nextProjection.accepted || bytePressure) {
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
          const trigger = bytePressure
            ? 'provider_request_byte_limit' as const
            : 'completed_tool_envelope' as const;
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
            traceExecution(input.trace, {
              kind: 'continuation_finished',
              providerStep: step,
              episode,
              attempt: 1,
              outcome: signal?.aborted ? 'cancelled' : 'failed',
            });
            throw error;
          }
          if (signal?.aborted) {
            traceExecution(input.trace, {
              kind: 'continuation_finished',
              providerStep: step,
              episode,
              attempt: 1,
              outcome: 'cancelled',
            });
            return finishAfterAbort();
          }
          if (continuation.kind === 'aborted') {
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
          latestUsage = undefined;
          input.liveness?.markAgentProgress();
        }
      }
    }
  }

  return finishWithRaw('step_budget_reached', input.sessionId, messages, emit);

  function finishWithRaw(
    reason: AgentStopReason,
    finishedSessionId: string,
    projection: AgentMessage[],
    eventEmitter: (event: AgentEvent) => void,
    contextFailureReason?: AgentContextFailureReason,
  ): AgentLoopResult {
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
): AgentLoopResult {
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
    if (maxSerializedBytes < MIN_TOOL_RESULT_ENVELOPE_BYTES) throw new ToolResultBudgetError();
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
  // boundary to compact. Memory exhaustion remains terminal before execution.
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
  if (maxSerializedBytes < MIN_TOOL_RESULT_ENVELOPE_BYTES) throw new ToolResultBudgetError();
  return {
    maxSerializedBytes,
    contextRemainingTokens,
    memoryRemainingBytes,
    ...(providerResultCeilingBytes === undefined ? {} : { providerResultCeilingBytes }),
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
