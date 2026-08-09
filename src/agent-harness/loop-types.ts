import type { ContextBudgetPolicy } from './compaction';
import type {
  AgentContextFailureReason,
  AgentEvent,
  AgentStopReason,
} from './events';
import type { AgentExecutionLedger } from './execution-ledger';
import type { AgentTurnLiveness } from './liveness';
import type { AgentMessage, toModelMessage } from './messages';
import type { PermissionEvaluator } from './permissions';
import type { ModelProvider } from './provider';
import type { SuspendedToolResult, SuspendedTurn } from './suspended-turn';
import type {
  AgentExecutableTool,
  AgentRequiredBeforeFinalDirective,
  AgentToolResultAdmissionHost,
} from './tools';
import type {
  AgentExecutionTraceSink,
  AgentTraceProviderIdentity,
} from './trace';
import type { AgentContentCaptureSink } from './content-capture';

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
