import {
  preflightContextRequest,
  shouldCompact,
  type ContextBudgetPolicy,
  type ProviderUsageAnchor,
} from './compaction';
import { MAX_TURN_TOOL_RESULT_BYTES } from './const';
import {
  observeAgentContentCapture,
  serializeAgentCaptureValue,
} from './content-capture';
import type { AgentContextFailureReason, AgentEvent, AgentStopReason } from './events';
import { type AgentMessage, toModelMessage } from './messages';
import type { PermissionEvaluator } from './permissions';
import {
  ProtocolValidationError,
  validateProviderProtocolHistory,
  validateToolCallEnvelope,
} from './protocol';
import type { ModelProvider, ModelToolCall } from './provider';
import type { SuspendedToolResult } from './suspended-turn';
import {
  type AgentExecutableTool,
  type AgentRequiredBeforeFinalDirective,
  type AgentToolDefinition,
  type AgentToolResultAdmission,
  errorToolResult,
  finalizeToolResult,
  finalizeWriteToolResult,
  type FinalizedToolResult,
  MIN_TOOL_RESULT_ENVELOPE_BYTES,
  serializedToolResultByteLength,
  type ToolResult,
  type ToolResultAllowance,
  ToolResultBudgetError,
} from './tools';
import { emitAgentExecutionTrace as traceExecution } from './trace';
import {
  disposeBestEffort,
  hasRequiredBeforeFinalProgress,
  normalizeOpaqueReferences,
  normalizeRequiredBeforeFinal,
  validateAgentToolResultAdmission,
} from './loop-tool-admission';
import {
  canFitMinimumToolResults,
  exclusiveToolResultAllowance,
  resolveToolResultAllowance,
  toolBudgetLimitingFactor,
  toolResultMemoryPressure,
} from './loop-tool-budget';
import { executeToolCall, type ExecuteToolCallOutcome } from './loop-tool-execution';
import {
  deterministicInputTokens,
  providerPrefixTokens,
  usageAdjustmentTokens,
} from './loop-context-metrics';
import type {
  AgentContextContinuation,
  AgentLoopResult,
  AgentNonterminalContinuationCause,
  AgentNonterminalContinuationResult,
  AgentTerminalLoopResult,
  RunAgentLoopInput,
} from './loop-types';

const EXCLUSIVE_TOOL_ENVELOPE_REQUIRED_MESSAGE =
  'This tool must be requested by itself. Retry it without sibling tool calls.';
const CONTEXT_LIMIT_EXCEEDED_MESSAGE = 'Context limit exceeded.';
const TOOL_RESULT_MEMORY_LIMIT_MESSAGE =
  'The agent could not free enough internal tool-result memory to continue.';
const TOOL_RESULT_ADMISSION_FAILED_MESSAGE = 'Tool result admission failed.';

export type ToolStepLoopState = Readonly<{
  cumulativeToolResultBytes: number;
  latestUsage: ProviderUsageAnchor | undefined;
  requiredBeforeFinal: readonly AgentRequiredBeforeFinalDirective[];
  nonterminalContinuationActive: boolean;
  requiredDirectiveProgressOccurred: boolean;
}>;

type ContextDiagnosticMetrics = Readonly<{
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
}>;

type ToolBoundaryTrigger = Extract<
  Parameters<AgentContextContinuation>[0]['trigger'],
  'completed_tool_envelope' | 'tool_result_memory_pressure' | 'provider_request_byte_limit'
>;

type ToolStepInput = Readonly<{
  input: RunAgentLoopInput;
  step: number;
  maxSteps: number;
  maxOutputTokens: number;
  response: Awaited<ReturnType<ModelProvider['generate']>>;
  modelMessages: ReturnType<typeof toModelMessage>[];
  bufferedPresentationEvents: readonly AgentEvent[];
  continuationAtStepStart: boolean;
  messages: AgentMessage[];
  rawMessages: AgentMessage[];
  tracksRawMessages: boolean;
  toolMap: Map<string, AgentExecutableTool>;
  toolDefinitions: readonly AgentToolDefinition[];
  permissions: PermissionEvaluator;
  signal?: AbortSignal;
  now: () => number;
  idFactory: () => string;
  usedToolCallIds: Set<string>;
  emit: (event: AgentEvent) => void;
  readState: () => ToolStepLoopState;
  commitState: (state: ToolStepLoopState) => void;
  emitContextDiagnostic: (
    stage: Extract<AgentEvent, { type: 'context_diagnostic' }>['stage'],
    policy: ContextBudgetPolicy,
    metrics: ContextDiagnosticMetrics,
  ) => void;
  continueAfterSettledToolBoundary: (
    step: number,
    trigger: ToolBoundaryTrigger,
  ) => Promise<AgentLoopResult | null>;
  finishAfterAbort: () => AgentLoopResult;
  finishWithRaw: (
    reason: AgentStopReason,
    contextFailureReason?: AgentContextFailureReason,
  ) => AgentTerminalLoopResult;
  returnContinuation: (
    cause: AgentNonterminalContinuationCause,
  ) => AgentNonterminalContinuationResult;
}>;

export type ToolStepResult = Readonly<
  | { kind: 'continue' }
  | { kind: 'terminal'; result: AgentLoopResult }
>;

export async function runToolStep(input: ToolStepInput): Promise<ToolStepResult> {
  const toolCalls = input.response.toolCalls ?? [];
  const candidateUsedToolCallIds = new Set(input.usedToolCallIds);
  try {
    validateToolCallEnvelope(toolCalls, candidateUsedToolCallIds);
  } catch (error) {
    if (input.continuationAtStepStart) return terminal(input.returnContinuation('no_progress'));
    const message = error instanceof ProtocolValidationError
      ? error.message
      : 'Provider tool calls failed protocol validation.';
    input.emit({ type: 'agent_error', sessionId: input.input.sessionId, message });
    return terminal(input.finishWithRaw('protocol_error'));
  }

  const violatesExclusiveToolEnvelope = toolCalls.length > 1 && toolCalls.some((call) => (
    input.toolMap.get(call.name)?.requiresExclusiveEnvelope === true
  ));
  let state = input.readState();
  let recoveredToolMemoryBeforeExecution = false;
  if (
    input.input.contextPolicy
    && toolCalls.length > 0
    && !violatesExclusiveToolEnvelope
    && (
      toolResultMemoryPressure(input.input.contextPolicy, state.cumulativeToolResultBytes)
      || !canFitMinimumToolResults(
        input.input.contextPolicy,
        state.cumulativeToolResultBytes,
        toolCalls.length,
      )
    )
  ) {
    if (input.input.onToolEnvelopeSettled) {
      const result = await input.continueAfterSettledToolBoundary(
        input.step,
        'tool_result_memory_pressure',
      );
      if (result) return terminal(result);
      state = input.readState();
      recoveredToolMemoryBeforeExecution = true;
    }
    if (
      toolResultMemoryPressure(input.input.contextPolicy, state.cumulativeToolResultBytes)
      || !canFitMinimumToolResults(
        input.input.contextPolicy,
        state.cumulativeToolResultBytes,
        toolCalls.length,
      )
    ) {
      input.emit({
        type: 'agent_error',
        sessionId: input.input.sessionId,
        message: TOOL_RESULT_MEMORY_LIMIT_MESSAGE,
      });
      input.emitContextDiagnostic('compaction', input.input.contextPolicy, {
        action: 'terminal',
        category: 'tool_result_memory_limit',
      });
      return terminal(input.finishWithRaw('context_limit', 'tool_result_memory_limit'));
    }
  }

  for (const toolCall of toolCalls) {
    observeAgentContentCapture(input.input.contentCapture, (capture) => {
      capture.toolArguments({
        providerStep: input.step,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        content: serializeAgentCaptureValue(toolCall.arguments),
      });
    });
    input.emit({ type: 'tool_execution_queued', toolName: toolCall.name, callId: toolCall.id });
    const queuedTool = input.toolMap.get(toolCall.name);
    if (queuedTool) {
      traceExecution(input.input.trace, {
        kind: 'tool_queued',
        providerStep: input.step,
        toolName: queuedTool.name,
        toolCallId: toolCall.id,
        toolClass: queuedTool.risk,
        risk: queuedTool.risk,
      });
    }
  }
  if (input.signal?.aborted && toolCalls.length === 0) {
    return terminal(input.finishAfterAbort());
  }
  if (
    !input.input.contextPolicy
    && toolCalls.length > 0
    && state.cumulativeToolResultBytes + toolCalls.length * MIN_TOOL_RESULT_ENVELOPE_BYTES
      > MAX_TURN_TOOL_RESULT_BYTES
  ) {
    input.emit({
      type: 'agent_error',
      sessionId: input.input.sessionId,
      message: 'The model requested more tool calls than the remaining result budget can represent.',
    });
    return terminal(input.finishWithRaw('step_budget_reached'));
  }

  const assistantMessage: AgentMessage | undefined = input.response.content || toolCalls.length > 0
    ? {
        id: input.idFactory(),
        role: 'agent',
        content: input.continuationAtStepStart ? '' : input.response.content ?? '',
        createdAt: input.now(),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      }
    : undefined;

  if (toolCalls.length === 0) {
    if (input.continuationAtStepStart) return terminal(input.returnContinuation('no_progress'));
    for (const event of input.bufferedPresentationEvents) input.emit(event);
    if (assistantMessage) {
      input.messages.push(assistantMessage);
      if (input.tracksRawMessages) input.rawMessages.push(assistantMessage);
      input.emit({ type: 'message_update', message: assistantMessage });
    }
    return terminal(input.finishWithRaw('final_answer'));
  }
  if (!assistantMessage) throw new Error('Tool calls require an assistant envelope.');
  const responseUsage = input.response.usage && !recoveredToolMemoryBeforeExecution
    ? {
        usage: input.response.usage,
        prefixMessageCount: input.modelMessages.length + 1,
      } satisfies ProviderUsageAnchor
    : undefined;

  let pendingStopReason: AgentStopReason | undefined;
  const completedPrefix: SuspendedToolResult[] = [];
  const stagedToolMessages: AgentMessage[] = [];
  let stagedToolResultBytes = 0;
  const priorRequiredBeforeFinal = state.requiredBeforeFinal;
  let nextRequiredBeforeFinal = priorRequiredBeforeFinal;
  let requiredDirectiveProgressOccurred = state.requiredDirectiveProgressOccurred;
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
            policy: input.input.contextPolicy,
            messages: input.messages,
            assistantMessage,
            stagedToolMessages,
            pendingToolCalls: toolCalls.slice(index),
            toolDefinitions: input.toolDefinitions,
            maxOutputTokens: input.maxOutputTokens,
            latestUsage: responseUsage,
            cumulativeToolResultBytes: state.cumulativeToolResultBytes + stagedToolResultBytes,
            provider: input.input.provider,
            allowMinimumEnvelopeForContinuation:
              input.input.onToolEnvelopeSettled !== undefined,
          });
      if (input.input.contextPolicy) {
        input.emitContextDiagnostic('tool_allowance', input.input.contextPolicy, {
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
      input.emit({
        type: 'agent_error',
        sessionId: input.input.sessionId,
        message: reason === 'tool_result_memory_limit'
          ? TOOL_RESULT_MEMORY_LIMIT_MESSAGE
          : CONTEXT_LIMIT_EXCEEDED_MESSAGE,
      });
      if (input.input.contextPolicy) {
        input.emitContextDiagnostic('compaction', input.input.contextPolicy, {
          action: 'terminal',
          category: reason,
        });
      }
      return terminal(input.finishWithRaw('context_limit', reason));
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
      outcome = { result: stopSiblingResult(pendingStopReason) };
    } else if (input.signal?.aborted) {
      pendingStopReason = 'aborted';
      outcome = {
        result: errorToolResult('tool_execution_aborted', 'Tool execution was aborted.'),
      };
    } else {
      input.input.liveness?.markAgentProgress();
      outcome = await executeToolCall({
        sessionId: input.input.sessionId,
        toolCall,
        toolMap: input.toolMap,
        permissions: input.permissions,
        executionLedger: input.input.executionLedger,
        emit: input.emit,
        trace: input.input.trace,
        providerStep: input.step,
        now: input.now,
        signal: input.signal,
        resultAllowance,
      });
      pendingStopReason = outcome.stopReason;
    }

    if (outcome.suspension) {
      await disposeBestEffort(disposals);
      if (input.continuationAtStepStart) {
        return terminal(input.returnContinuation('no_progress'));
      }
      for (const event of input.bufferedPresentationEvents) input.emit(event);
      return terminal({
        sessionId: input.input.sessionId,
        messages: input.messages,
        ...(input.tracksRawMessages ? { rawMessages: input.rawMessages } : {}),
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
          remainingStepBudget: input.maxSteps - input.step - 1,
          priorHistory: input.modelMessages,
        },
      });
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
      input.input.executionLedger?.storeResult(outcome.ledgerCallId, originalFinalized.result);
    }

    const tracedTool = input.toolMap.get(toolCall.name);
    let finalized = originalFinalized;
    let opaqueReferences: string[] | undefined;
    let transformed = false;
    let retainOnNoProgress = false;
    let proposedAdmission: AgentToolResultAdmission | null = null;
    if (tracedTool && input.input.toolResultAdmissionHost) {
      try {
        proposedAdmission = await input.input.toolResultAdmissionHost.afterToolResult({
          sessionId: input.input.sessionId,
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
              errorToolResult(
                'tool_result_admission_failed',
                TOOL_RESULT_ADMISSION_FAILED_MESSAGE,
              ),
              resultAllowance,
            );
          } else {
            finalized = proposedFinalized;
            transformed = true;
            opaqueReferences = admittedReferences.length > 0 ? admittedReferences : undefined;
            if (admittedDirectives !== undefined) {
              if (
                input.continuationAtStepStart
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
              && typeof input.input.toolResultAdmissionHost?.admitEnvelope === 'function';
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
      id: input.idFactory(),
      role: 'tool',
      content: finalized.serialized,
      createdAt: input.now(),
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
    input.signal?.aborted
    && (
      input.continuationAtStepStart
      || stagedAdmissions.some((admission) => admission.transformed)
    )
  ) {
    await disposeBestEffort(disposals);
    return terminal(input.finishAfterAbort());
  }
  if (input.continuationAtStepStart && admissionFailed) {
    await disposeBestEffort(disposals);
    input.emit({
      type: 'agent_error',
      sessionId: input.input.sessionId,
      message: TOOL_RESULT_ADMISSION_FAILED_MESSAGE,
    });
    return terminal(input.finishWithRaw('provider_error'));
  }
  const retainsNoProgressEnvelope = stagedAdmissions.length > 0
    && stagedAdmissions.every((admission) => admission.retainOnNoProgress);
  if (
    input.continuationAtStepStart
    && !hasRequiredBeforeFinalProgress(priorRequiredBeforeFinal, nextRequiredBeforeFinal)
    && !retainsNoProgressEnvelope
  ) {
    await disposeBestEffort(disposals);
    return terminal(input.returnContinuation('no_progress'));
  }

  const settledEnvelope = [assistantMessage, ...stagedToolMessages];
  const projectedMessages = [...input.messages, ...settledEnvelope];
  const canonicalRawBase = input.tracksRawMessages ? input.rawMessages : input.messages;
  const canonicalRawMessages = input.continuationAtStepStart
    ? [...canonicalRawBase]
    : [...canonicalRawBase, ...settledEnvelope];
  try {
    if (
      (
        input.continuationAtStepStart
        || stagedAdmissions.some((admission) => admission.transformed)
      )
      && !input.input.toolResultAdmissionHost?.admitEnvelope
    ) {
      throw new TypeError('Transformed envelopes require a host checkpoint.');
    }
    validateProviderProtocolHistory(projectedMessages.map(toModelMessage));
    await input.input.toolResultAdmissionHost?.admitEnvelope?.({
      admissionTokens,
      requiredBeforeFinal: nextRequiredBeforeFinal,
      projectedMessages,
      canonicalRawMessages,
      envelopeKind: input.continuationAtStepStart
        ? 'internal_continuation'
        : 'canonical_source',
    });
  } catch {
    await disposeBestEffort(disposals);
    if (input.signal?.aborted) return terminal(input.finishAfterAbort());
    input.emit({
      type: 'agent_error',
      sessionId: input.input.sessionId,
      message: TOOL_RESULT_ADMISSION_FAILED_MESSAGE,
    });
    return terminal(input.finishWithRaw('provider_error'));
  }

  const nonterminalContinuationActive = state.nonterminalContinuationActive
    || input.continuationAtStepStart
    || nextRequiredBeforeFinal.length > 0;
  for (const toolCall of toolCalls) input.usedToolCallIds.add(toolCall.id);
  input.messages.push(...settledEnvelope);
  if (input.tracksRawMessages && !input.continuationAtStepStart) {
    input.rawMessages.push(...settledEnvelope);
  }
  state = {
    cumulativeToolResultBytes: state.cumulativeToolResultBytes
      + stagedAdmissions.reduce(
        (total, admission) => total + admission.finalized.byteLength,
        0,
      ),
    latestUsage: responseUsage,
    requiredBeforeFinal: nextRequiredBeforeFinal,
    nonterminalContinuationActive,
    requiredDirectiveProgressOccurred,
  };
  input.commitState(state);

  for (const admission of stagedAdmissions) {
    observeAgentContentCapture(input.input.contentCapture, (capture) => {
      capture.toolResult({
        providerStep: input.step,
        toolName: admission.toolCall.name,
        toolCallId: admission.toolCall.id,
        content: admission.finalized.serialized,
      });
    });
    if (admission.tracedTool && input.input.trace) {
      traceExecution(input.input.trace, {
        kind: 'tool_result_admitted',
        providerStep: input.step,
        toolName: admission.tracedTool.name,
        toolCallId: admission.toolCall.id,
        originalBytes: serializedToolResultByteLength(admission.originalResult),
        admittedBytes: admission.finalized.byteLength,
        reduction: admission.transformed
          ? 'structural'
          : admission.finalized.budgetReduced ? 'error_envelope' : 'none',
      });
      if (admission.tracedTool.risk === 'write' && admission.writeOutcome) {
        traceExecution(input.input.trace, {
          kind: 'tool_write_outcome',
          providerStep: input.step,
          toolName: admission.tracedTool.name,
          toolCallId: admission.toolCall.id,
          effectCount: admission.outcome.effectCount ?? null,
          state: admission.writeOutcome,
        });
      }
      traceExecution(input.input.trace, {
        kind: 'tool_completed',
        providerStep: input.step,
        toolName: admission.tracedTool.name,
        toolCallId: admission.toolCall.id,
        outcome: pendingStopReason === 'aborted' || input.signal?.aborted
          ? 'cancelled'
          : admission.finalized.result.ok ? 'success' : 'error',
        durationMs: admission.outcome.durationMs ?? null,
      });
    }
    if (input.input.contextPolicy) {
      input.emitContextDiagnostic('tool_allowance', input.input.contextPolicy, {
        toolResultBytes: admission.finalized.byteLength,
        toolResultReduced: admission.finalized.budgetReduced,
      });
    }
    if (admission.outcome.executedToolName && admission.outcome.executedToolRisk) {
      input.emit({
        type: 'tool_execution_end',
        toolName: admission.outcome.executedToolName,
        callId: admission.toolCall.id,
        risk: admission.outcome.executedToolRisk,
        ok: admission.finalized.result.ok,
        writeOutcome: admission.outcome.executedToolRisk === 'write'
          ? admission.writeOutcome ?? 'unknown'
          : 'not_applicable',
      });
      input.input.liveness?.markAgentProgress();
    }
  }
  if (!input.continuationAtStepStart) {
    for (const event of input.bufferedPresentationEvents) input.emit(event);
    for (const message of settledEnvelope) input.emit({ type: 'message_update', message });
  }
  if (pendingStopReason && (!input.continuationAtStepStart || pendingStopReason === 'aborted')) {
    return terminal(
      pendingStopReason === 'aborted'
        ? input.finishAfterAbort()
        : input.finishWithRaw(pendingStopReason),
    );
  }
  if (
    input.continuationAtStepStart !== (nextRequiredBeforeFinal.length > 0)
    || priorRequiredBeforeFinal.length !== nextRequiredBeforeFinal.length
    || priorRequiredBeforeFinal.some((directive, index) => (
      directive.reference !== nextRequiredBeforeFinal[index]?.reference
    ))
  ) {
    return terminal(input.returnContinuation('episode_exhausted'));
  }

  if (input.input.contextPolicy) {
    const nextModelMessages = input.messages.map(toModelMessage);
    const nextProjection = preflightContextRequest({
      messages: nextModelMessages,
      toolSchemas: input.toolDefinitions,
      maxOutputTokens: input.maxOutputTokens,
      ...(state.latestUsage ? { latestUsage: state.latestUsage } : {}),
    }, input.input.contextPolicy);
    input.emitContextDiagnostic('post_tool', input.input.contextPolicy, {
      inputTokens: nextProjection.inputTokens,
      deterministicInputTokens: deterministicInputTokens(nextProjection),
      usageAdjustmentTokens: usageAdjustmentTokens(nextProjection),
      observedPrefixTokens: providerPrefixTokens(nextProjection),
    });
    const nextRequestInspection = input.input.provider.inspectRequest?.({
      messages: nextModelMessages,
      tools: [...input.toolDefinitions],
      maxOutputTokens: input.maxOutputTokens,
    });
    const bytePressure = nextRequestInspection?.accepted === false;
    const memoryPressure = toolResultMemoryPressure(
      input.input.contextPolicy,
      state.cumulativeToolResultBytes,
    );
    if (shouldCompact(nextProjection, input.input.contextPolicy) || bytePressure || memoryPressure) {
      if (!input.input.onToolEnvelopeSettled) {
        if (!nextProjection.accepted || bytePressure) {
          if (bytePressure) {
            input.emitContextDiagnostic('compaction', input.input.contextPolicy, {
              action: 'triggered',
              trigger: 'provider_request_byte_limit',
              category: 'provider_request_byte_limit',
            });
          }
          input.emit({
            type: 'agent_error',
            sessionId: input.input.sessionId,
            message: CONTEXT_LIMIT_EXCEEDED_MESSAGE,
          });
          return terminal(input.finishWithRaw(
            'context_limit',
            bytePressure ? 'provider_request_byte_limit' : 'current_turn_too_large',
          ));
        }
      } else {
        const trigger = memoryPressure
          ? 'tool_result_memory_pressure' as const
          : bytePressure
            ? 'provider_request_byte_limit' as const
            : 'completed_tool_envelope' as const;
        const result = await input.continueAfterSettledToolBoundary(input.step, trigger);
        if (result) return terminal(result);
      }
    }
  }

  return { kind: 'continue' };
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

function terminal(result: AgentLoopResult): ToolStepResult {
  return { kind: 'terminal', result };
}
