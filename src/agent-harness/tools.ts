import {
  MAX_GENERIC_TOOL_ERROR_RESULT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  MAX_TURN_TOOL_RESULT_BYTES,
} from './const';
import {
  errorToolResult,
  okToolResult,
  serializeBoundedToolResult,
  type ToolResult,
  utf8ByteLength,
} from './results';
import type { WriteEffectPlan } from './execution-ledger';

export { errorToolResult, okToolResult } from './results';
export type { ToolResult } from './results';

export type ToolRisk = 'read' | 'suggest' | 'write';

export type ToolExecutionContext = {
  sessionId: string;
  callId: string;
  resultAllowance?: ToolResultAllowance;
  signal?: AbortSignal;
  /** Called immediately before a delegated writer can mutate durable state. */
  markWriteStarted?: () => void;
};

export type ToolResultAllowance = Readonly<{
  maxSerializedBytes: number;
  contextRemainingTokens: number;
  memoryRemainingBytes: number;
  /** Maximum serialized result bytes admitted by the exact Provider projection. */
  providerResultCeilingBytes?: number;
}>;

export type AgentToolSuspendOutcome = Readonly<{
  type: 'suspend';
  interactionKind: 'scope_selector';
  task: 'prepare_scope_branch';
}>;

export type AgentInteractionCapability = Readonly<{
  interactionKind: 'scope_selector';
  task: 'prepare_scope_branch';
}>;

export type AgentToolDefinition = {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters?: Record<string, unknown>;
};

export type AgentTool<TArgs = unknown, TResult = unknown> = {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters?: Record<string, unknown>;
  validate?: (input: unknown) => TArgs;
  writeEffectPlan?: WriteEffectPlan<any, any>;
  execute(args: TArgs, context: ToolExecutionContext): Promise<TResult>;
};

export type AgentInteractionTool<TArgs = unknown, TResult = unknown> = Omit<
  AgentTool<TArgs, TResult>,
  'execute'
> & {
  interaction: AgentInteractionCapability;
  execute(
    args: TArgs,
    context: ToolExecutionContext,
  ): Promise<TResult | AgentToolSuspendOutcome>;
};

export type AgentExecutableTool = AgentTool | AgentInteractionTool;

export function isAgentToolSuspendOutcome(
  value: unknown,
  capability: AgentInteractionCapability | undefined,
): value is AgentToolSuspendOutcome {
  if (!capability) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<AgentToolSuspendOutcome>;
  const keys = Object.keys(value).sort();
  return keys.length === 3 &&
    keys[0] === 'interactionKind' &&
    keys[1] === 'task' &&
    keys[2] === 'type' &&
    candidate.type === 'suspend' &&
    candidate.interactionKind === capability.interactionKind &&
    candidate.task === capability.task;
}

export class ToolOutputTooLargeError extends Error {
  constructor(message = 'Tool output could not be represented within the configured limit.') {
    super(message);
    this.name = 'ToolOutputTooLargeError';
  }
}

const RESULT_BUDGET_ERROR = errorToolResult(
  'tool_output_too_large',
  'Tool output exceeded the available result budget. Request a smaller page.',
);

export const MIN_TOOL_RESULT_ENVELOPE_SERIALIZED = JSON.stringify(RESULT_BUDGET_ERROR);
export const MIN_TOOL_RESULT_ENVELOPE_BYTES = utf8ByteLength(
  MIN_TOOL_RESULT_ENVELOPE_SERIALIZED,
);

export type FinalizedToolResult = {
  result: ToolResult;
  serialized: string;
  byteLength: number;
  budgetReduced: boolean;
};

export type WriteToolOutcome = 'committed' | 'failed' | 'unknown';

export class ToolResultBudgetError extends Error {
  constructor() {
    super('Insufficient turn budget for a required tool-result envelope.');
    this.name = 'ToolResultBudgetError';
  }
}

export function toToolDefinition(tool: AgentExecutableTool): AgentToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
  };
}

export function serializedToolResultByteLength(result: ToolResult): number {
  const serialized = JSON.stringify(result);
  if (typeof serialized !== 'string') throw new TypeError('Tool result did not serialize to JSON.');
  return utf8ByteLength(serialized);
}

export function finalizeToolResult(
  candidate: ToolResult,
  allowanceOrCumulativeBytes: ToolResultAllowance | number = 0,
  reservedBytes = 0,
): FinalizedToolResult {
  const allowance = typeof allowanceOrCumulativeBytes === 'number'
    ? legacyToolResultAllowance(allowanceOrCumulativeBytes, reservedBytes)
    : allowanceOrCumulativeBytes;
  validateToolResultAllowance(allowance);
  const finalized = serializeBoundedToolResult(candidate);
  if (
    finalized.fallbackReason !== 'too_large' &&
    finalized.byteLength <= allowance.maxSerializedBytes
  ) {
    return { ...finalized, budgetReduced: false };
  }

  const fallback = serializeBoundedToolResult(RESULT_BUDGET_ERROR, {
    successBytes: allowance.maxSerializedBytes,
    errorBytes: Math.min(allowance.maxSerializedBytes, MAX_GENERIC_TOOL_ERROR_RESULT_BYTES),
  });
  if (fallback.byteLength > allowance.maxSerializedBytes) {
    throw new ToolResultBudgetError();
  }
  return { ...fallback, budgetReduced: true };
}

export function finalizeWriteToolResult(
  candidate: ToolResult,
  allowance: ToolResultAllowance,
  outcome: WriteToolOutcome,
): FinalizedToolResult {
  const finalized = finalizeToolResult(candidate, allowance);
  const preservesOutcome = outcome === 'committed'
    ? finalized.result.ok && !finalized.budgetReduced
    : outcome === 'failed'
      ? !finalized.result.ok && !finalized.budgetReduced
      : false;
  if (preservesOutcome) return finalized;

  const receipt = outcome === 'committed'
    ? okToolResult({ writeOutcome: 'committed' as const })
    : outcome === 'failed'
      ? errorToolResult('write_failed', 'Write did not commit.')
      : errorToolResult(
          'write_outcome_unknown',
          'Write outcome is unknown; do not retry automatically.',
        );
  const serialized = serializeBoundedToolResult(receipt, {
    successBytes: allowance.maxSerializedBytes,
    errorBytes: allowance.maxSerializedBytes,
  });
  if (serialized.fallbackReason || serialized.byteLength > allowance.maxSerializedBytes) {
    throw new ToolResultBudgetError();
  }
  return { ...serialized, budgetReduced: true };
}

function legacyToolResultAllowance(
  cumulativeBytes: number,
  reservedBytes: number,
): ToolResultAllowance {
  const maxSerializedBytes = Math.min(
    MAX_TOOL_RESULT_BYTES,
    Math.max(0, MAX_TURN_TOOL_RESULT_BYTES - cumulativeBytes - reservedBytes),
  );
  return {
    maxSerializedBytes,
    contextRemainingTokens: Number.MAX_SAFE_INTEGER,
    memoryRemainingBytes: maxSerializedBytes,
  };
}

function validateToolResultAllowance(allowance: ToolResultAllowance): void {
  for (const value of [
    allowance.maxSerializedBytes,
    allowance.contextRemainingTokens,
    allowance.memoryRemainingBytes,
    allowance.providerResultCeilingBytes,
  ]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('Tool result allowance must contain non-negative safe integers.');
    }
  }
  if (allowance.maxSerializedBytes > allowance.memoryRemainingBytes) {
    throw new RangeError('Tool result allowance cannot exceed its memory remainder.');
  }
}
