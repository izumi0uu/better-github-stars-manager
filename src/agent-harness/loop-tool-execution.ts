import type { AgentEvent, AgentStopReason } from './events';
import type { PermissionDecision, PermissionEvaluator } from './permissions';
import type { ModelToolCall } from './provider';
import {
  type AgentExecutableTool,
  type AgentToolSuspendOutcome,
  type ToolResult,
  type ToolResultAllowance,
  type ToolRisk,
  errorToolResult,
  isAgentToolSuspendOutcome,
  okToolResult,
  ToolOutputTooLargeError,
} from './tools';
import type {
  AgentExecutionLedger,
  CanonicalToolEffect,
  WriteEffectPlan,
} from './execution-ledger';
import {
  emitAgentExecutionTrace as traceExecution,
  type AgentExecutionTraceSink,
} from './trace';

const INVALID_ARGUMENTS_MESSAGE = 'Tool arguments were invalid.';
const PERMISSION_EVALUATION_FAILED_MESSAGE = 'Tool permission evaluation failed.';
const TOOL_EXECUTION_FAILED_MESSAGE = 'Tool execution failed.';
const TOOL_OUTPUT_TOO_LARGE_MESSAGE =
  'Tool output exceeded the available result budget. Request a smaller page.';
const WRITE_EFFECT_PLAN_REQUIRED_MESSAGE =
  'Write execution is unavailable because its replay safety contract is missing.';
const WRITE_REPLAY_BLOCKED_MESSAGE =
  'Write execution is blocked because an earlier outcome is not safely replayable.';

export type ExecuteToolCallOutcome = {
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

export async function executeToolCall(input: {
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

function traceDuration(startedAt: number | null, now: () => number): number | undefined {
  return startedAt === null ? undefined : Math.max(0, now() - startedAt);
}
