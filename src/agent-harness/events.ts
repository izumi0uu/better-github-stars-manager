import type { AgentMessage } from './messages';
import type { ToolRisk } from './tools';

export type AgentErrorCategory =
  | 'authentication'
  | 'configuration'
  | 'permission'
  | 'disclosure'
  | 'capability'
  | 'provider'
  | 'other';

export type AgentContextDiagnosticAction =
  | 'triggered'
  | 'summary_retry'
  | 'fallback'
  | 'terminal';

export type AgentContextDiagnosticTrigger =
  | 'pre_turn_soft_limit'
  | 'pre_turn_byte_limit'
  | 'completed_tool_envelope_soft_limit'
  | 'completed_tool_envelope_byte_limit'
  | 'forced_completed_tool_envelope'
  | 'provider_context_overflow'
  | 'provider_request_byte_limit';

export type AgentContextDiagnosticCategory =
  | 'succeeded'
  | 'current_turn_too_large'
  | 'no_candidate'
  | 'summary_provider_failed'
  | 'summary_invalid'
  | 'fallback_too_large'
  | 'final_preflight_failed'
  | 'capability_unresolved'
  | 'provider_context_overflow'
  | 'provider_context_overflow_repeated'
  | 'provider_request_byte_limit'
  | 'provider_request_byte_limit_repeated';

export type AgentEvent =
  | { type: 'agent_start'; sessionId: string }
  | { type: 'turn_start'; sessionId: string; step: number }
  | { type: 'assistant_stream_start'; sessionId: string; step: number }
  | { type: 'assistant_text_delta'; sessionId: string; step: number; delta: string }
  | { type: 'message_update'; message: AgentMessage }
  | { type: 'tool_execution_queued'; toolName: string; callId: string }
  | { type: 'tool_execution_start'; toolName: string; callId: string; risk: ToolRisk }
  | {
      type: 'tool_execution_end';
      toolName: string;
      callId: string;
      risk: ToolRisk;
      ok: boolean;
      writeOutcome: 'not_applicable' | 'committed' | 'failed' | 'unknown';
    }
  | { type: 'approval_required'; callId: string; summary: string }
  | { type: 'context_compaction_start'; sessionId: string }
  | {
      type: 'context_diagnostic';
      sessionId: string;
      stage: 'preflight' | 'tool_allowance' | 'post_tool' | 'compaction';
      providerWindow: number;
      workingWindow: number;
      softLimit: number;
      hardLimit: number;
      capabilitySource: 'builtin-official' | 'provider-verified' | 'user-declared';
      capabilityRevision: string;
      policyRevision: string;
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
      action?: AgentContextDiagnosticAction;
      trigger?: AgentContextDiagnosticTrigger;
      category?: AgentContextDiagnosticCategory;
    }
  | {
      type: 'context_compaction_end';
      sessionId: string;
      ok: boolean;
      summarizedMessageCount: number;
    }
  | { type: 'agent_error'; sessionId: string; message: string; category?: AgentErrorCategory }
  | {
      type: 'agent_done';
      sessionId: string;
      reason: AgentStopReason;
      contextFailureReason?: AgentContextFailureReason;
    };

export type AgentContextFailureReason =
  | 'capability_unresolved'
  | 'current_turn_too_large'
  | 'no_candidate'
  | 'summary_provider_failed'
  | 'summary_invalid'
  | 'fallback_too_large'
  | 'final_preflight_failed'
  | 'provider_context_overflow'
  | 'provider_context_overflow_repeated'
  | 'provider_request_byte_limit'
  | 'provider_request_byte_limit_repeated';

export type AgentStopReason =
  | 'final_answer'
  | 'approval_required'
  | 'interaction_required'
  | 'protocol_error'
  | 'step_budget_reached'
  | 'context_limit'
  | 'provider_error'
  | 'attempt_state_lost'
  | 'aborted';
