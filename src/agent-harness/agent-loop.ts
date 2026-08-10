import { DEFAULT_MAX_AGENT_STEPS } from './const';
import {
  preflightContextRequest,
  shouldCompact,
  type ContextBudgetPolicy,
  type ProviderUsageAnchor,
} from './compaction';
import type {
  AgentContextFailureReason,
  AgentEvent,
  AgentStopReason,
} from './events';
import { type AgentMessage, toModelMessage } from './messages';
import { defaultPermissionEvaluator } from './permissions';
import { AgentProviderError, publicAgentProviderErrorMessage } from './provider';
import { toToolDefinition } from './tools';
import { emitAgentExecutionTrace as traceExecution } from './trace';
import { publicAgentLivenessTimeoutMessage } from './liveness';
import { normalizeRequiredBeforeFinal } from './loop-tool-admission';
import {
  toolResultBytesSinceLatestUser,
  toolResultMemoryPressure,
} from './loop-tool-budget';
import {
  providerErrorCategory,
  runProviderStep,
} from './loop-provider-step';
import { runToolStep } from './loop-tool-step';
import type {
  AgentContextContinuation,
  AgentContextContinuationTrigger,
  AgentLoopResult,
  AgentNonterminalContinuationCause,
  AgentNonterminalContinuationResult,
  AgentTerminalLoopResult,
  RunAgentLoopInput,
} from './loop-types';

export type {
  AgentContextContinuation,
  AgentContextContinuationTrigger,
  AgentLoopResult,
  AgentLoopSuspensionCandidate,
  AgentNonterminalContinuationCandidate,
  AgentNonterminalContinuationCause,
  AgentNonterminalContinuationResult,
  AgentTerminalLoopResult,
  RunAgentLoopInput,
} from './loop-types';

const CONTEXT_LIMIT_EXCEEDED_MESSAGE = 'Context limit exceeded.';
const TOOL_RESULT_MEMORY_LIMIT_MESSAGE =
  'The agent could not free enough internal tool-result memory to continue.';

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
  let continuationEpisode = 0;
  const signal = input.liveness?.signal ?? input.signal;
  let requiredBeforeFinal = normalizeRequiredBeforeFinal(input.requiredBeforeFinal ?? []);
  let nonterminalContinuationActive = requiredBeforeFinal.length > 0;
  const episodeStartedWithRequiredDirectives = requiredBeforeFinal.length > 0;
  let requiredDirectiveProgressOccurred = false;

  const finishAfterAbort = (): AgentTerminalLoopResult => {
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

    const providerStep = await runProviderStep({
      sessionId: input.sessionId,
      step,
      messages,
      rawMessages,
      tracksRawMessages,
      provider: input.provider,
      toolDefinitions,
      maxOutputTokens,
      contextHardLimit,
      contextPolicy: input.contextPolicy,
      latestUsage,
      cumulativeToolResultBytes,
      continuationEpisode,
      onContextOverflow: input.onContextOverflow,
      trace: input.trace,
      traceProvider: input.traceProvider,
      contentCapture: input.contentCapture,
      liveness: input.liveness,
      signal,
      emit,
      now,
      requestIdFactory: randomId,
      finishAfterAbort,
      finishTerminal: (reason, contextFailureReason) => finishWithRaw(
        reason,
        input.sessionId,
        messages,
        emit,
        contextFailureReason,
      ),
      emitContextDiagnostic: (stage, policy, metrics) => {
        emitContextDiagnostic(emit, input.sessionId, stage, policy, metrics);
      },
      toolResultBytesSinceLatestUser,
    });
    if (providerStep.kind === 'terminal') return providerStep.result;
    const {
      response,
      modelMessages,
      bufferedPresentationEvents,
    } = providerStep;
    latestUsage = providerStep.latestUsage;
    cumulativeToolResultBytes = providerStep.cumulativeToolResultBytes;
    continuationEpisode = providerStep.continuationEpisode;
    const toolStep = await runToolStep({
      input,
      step,
      maxSteps,
      maxOutputTokens,
      response,
      modelMessages,
      bufferedPresentationEvents,
      continuationAtStepStart,
      messages,
      rawMessages,
      tracksRawMessages,
      toolMap,
      toolDefinitions,
      permissions,
      signal,
      now,
      idFactory,
      usedToolCallIds,
      emit,
      readState: () => ({
        cumulativeToolResultBytes,
        latestUsage,
        requiredBeforeFinal,
        nonterminalContinuationActive,
        requiredDirectiveProgressOccurred,
      }),
      commitState: (state) => {
        cumulativeToolResultBytes = state.cumulativeToolResultBytes;
        latestUsage = state.latestUsage;
        requiredBeforeFinal = [...state.requiredBeforeFinal];
        nonterminalContinuationActive = state.nonterminalContinuationActive;
        requiredDirectiveProgressOccurred = state.requiredDirectiveProgressOccurred;
      },
      emitContextDiagnostic: (stage, policy, metrics) => {
        emitContextDiagnostic(emit, input.sessionId, stage, policy, metrics);
      },
      continueAfterSettledToolBoundary,
      finishAfterAbort,
      finishWithRaw: (reason, contextFailureReason) => finishWithRaw(
        reason,
        input.sessionId,
        messages,
        emit,
        contextFailureReason,
      ),
      returnContinuation,
    });
    if (toolStep.kind === 'terminal') return toolStep.result;
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


function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
