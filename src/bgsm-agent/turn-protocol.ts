import type {
  AgentContextFailureReason,
  AgentErrorCategory,
  AgentStopReason,
  ToolRisk,
} from '@/agent-harness';
import type { AgentSessionCommitResult } from '@/storage/agent-session-store';
import {
  validateBgsmAgentConversationBinding,
  type BgsmAgentConversationBinding,
} from './conversation-binding';
import type { BgsmAgentSessionMessage } from './session';
import {
  assertAgentSessionTransportPayloadSize,
  assertAgentTurnTransportIdentifier,
  validateAgentSessionLaunchIdentity,
  validateAgentTurnOpaqueReferences,
  type AgentActiveTurnTransport,
  type AgentSessionLaunchIdentity,
} from './session-transport';
import type { BgsmAgentOrganizeLibraryHandoff } from './tools';

export const AGENT_ATTEMPT_STATE_LOST_ERROR_CODE = 'agent_attempt_state_lost' as const;
export const AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE =
  'agent_artifact_coverage_stalled' as const;

/** Shared producer/consumer authority for typed Agent Port failures. */
export const AGENT_TURN_ERROR_CODES = Object.freeze([
  'agent_session_not_found',
  'agent_session_revision_conflict',
  'agent_session_attempt_conflict',
  'agent_session_turn_active',
  'agent_session_turn_lease_mismatch',
  'agent_session_corrupt',
  'agent_session_quota_exceeded',
  'agent_storage_capacity_exceeded',
  'agent_artifact_not_found',
  'agent_artifact_not_ready',
  'agent_artifact_corrupt',
  'agent_artifact_conflict',
  'agent_artifact_state_conflict',
  'agent_artifact_access_denied',
  AGENT_ATTEMPT_STATE_LOST_ERROR_CODE,
  AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE,
  'agent_turn_resume_epoch_changed',
] as const);

export type AgentTurnErrorCode = typeof AGENT_TURN_ERROR_CODES[number];

export type BgsmAgentDeliveryIdentity = Readonly<{
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
}>;

export type BgsmAgentTurnLaunch = AgentSessionLaunchIdentity;

type BgsmAgentTurnEventPayload =
  | Readonly<{ type: 'agent_queued' }>
  | Readonly<{ type: 'conversation_bound'; binding: BgsmAgentConversationBinding }>
  | Readonly<{ type: 'agent_start' }>
  | Readonly<{ type: 'turn_start'; step: number }>
  | Readonly<{ type: 'assistant_stream_start'; step: number }>
  | Readonly<{ type: 'assistant_text_delta'; step: number; delta: string }>
  | Readonly<{ type: 'message_update'; message: BgsmAgentSessionMessage }>
  | Readonly<{ type: 'tool_execution_queued'; toolName: string; callId: string }>
  | Readonly<{
      type: 'tool_execution_start';
      toolName: string;
      callId: string;
      risk: ToolRisk;
    }>
  | Readonly<{
      type: 'tool_execution_end';
      toolName: string;
      callId: string;
      risk: ToolRisk;
      ok: boolean;
      writeOutcome: 'not_applicable' | 'committed' | 'failed' | 'unknown';
    }>
  | Readonly<{ type: 'approval_required'; callId: string; summary: string }>
  | Readonly<{ type: 'context_compaction_start' }>
  | Readonly<{
      type: 'context_diagnostic';
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
      action?: 'triggered' | 'summary_retry' | 'fallback' | 'terminal';
      trigger?:
        | 'pre_turn_soft_limit'
        | 'pre_turn_byte_limit'
        | 'completed_tool_envelope_soft_limit'
        | 'completed_tool_envelope_byte_limit'
        | 'forced_completed_tool_envelope'
        | 'tool_result_memory_pressure'
        | 'context_preflight'
        | 'provider_context_overflow'
        | 'provider_request_byte_limit';
      category?:
        | 'succeeded'
        | 'current_turn_too_large'
        | 'no_candidate'
        | 'summary_provider_failed'
        | 'summary_invalid'
        | 'fallback_too_large'
        | 'final_preflight_failed'
        | 'tool_result_memory_limit'
        | 'capability_unresolved'
        | 'provider_context_overflow'
        | 'provider_context_overflow_repeated'
        | 'provider_request_byte_limit'
        | 'provider_request_byte_limit_repeated';
    }>
  | Readonly<{
      type: 'context_compaction_end';
      ok: boolean;
      summarizedMessageCount: number;
    }>
  | Readonly<{ type: 'agent_error'; message: string; category?: AgentErrorCategory }>
  | Readonly<{
      type: 'agent_done';
      reason: AgentStopReason;
      contextFailureReason?: AgentContextFailureReason;
    }>;

export type BgsmAgentTurnEvent = BgsmAgentTurnEventPayload & BgsmAgentDeliveryIdentity;

export type BgsmAgentTurnResult = Readonly<{
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
  reason: AgentStopReason;
  changed: boolean;
  changedCount: number;
  commit: AgentSessionCommitResult | null;
  contextFailureReason?: AgentContextFailureReason;
  organizeLibraryHandoff?: BgsmAgentOrganizeLibraryHandoff;
}>;

export type BgsmAgentTurnError = BgsmAgentDeliveryIdentity & Readonly<{
  message: string;
  category?: AgentErrorCategory;
  code?: AgentTurnErrorCode;
}>;

export type BgsmAgentActiveTurn = AgentActiveTurnTransport;

export type BgsmAgentTurnAckDisposition =
  | 'applied'
  | 'no_transition'
  | 'transition_rejected'
  | 'detached';

export type BgsmAgentTurnAck =
  | Readonly<{ disposition: 'applied'; appliedRevision: number }>
  | Readonly<{
      disposition: Exclude<BgsmAgentTurnAckDisposition, 'applied'>;
      appliedRevision: null;
    }>;

type BgsmAgentTurnStartMessage = Readonly<{
  type: 'startBgsmAgentTurn';
  executionEpochId: string;
  resumeOnly?: true;
}> & BgsmAgentTurnLaunch;

type BgsmAgentTurnStopMessage = Readonly<{
  type: 'stopBgsmAgentTurn';
  executionEpochId: string;
}> & BgsmAgentDeliveryIdentity;

type BgsmAgentTurnAcknowledgementMessage = Readonly<{
  type: 'ackBgsmAgentTurnResult';
  executionEpochId: string;
}> & BgsmAgentDeliveryIdentity & BgsmAgentTurnAck;

export type BgsmAgentTurnClientMessage =
  | BgsmAgentTurnStartMessage
  | BgsmAgentTurnStopMessage
  | BgsmAgentTurnAcknowledgementMessage;

type BgsmAgentTurnHelloMessage = Readonly<{
  type: 'bgsmAgentTurnHello';
  executionEpochId: string;
}>;

type BgsmAgentTurnAcknowledgedMessage = Readonly<{
  type: 'bgsmAgentTurnAck';
}> & BgsmAgentDeliveryIdentity & BgsmAgentTurnAck;

export type BgsmAgentTurnPublishedMessage =
  | Readonly<{ type: 'bgsmAgentTurnEvent'; event: BgsmAgentTurnEvent }>
  | Readonly<{ type: 'bgsmAgentTurnResult'; result: BgsmAgentTurnResult }>
  | Readonly<{ type: 'bgsmAgentTurnError'; error: BgsmAgentTurnError }>;

export type BgsmAgentTurnSequencedServerMessage =
  BgsmAgentTurnPublishedMessage & Readonly<{ sequence: number }>;

export type BgsmAgentTurnServerMessage =
  | BgsmAgentTurnHelloMessage
  | BgsmAgentTurnAcknowledgedMessage
  | BgsmAgentTurnSequencedServerMessage;

export function parseAgentTurnErrorCode(value: unknown): AgentTurnErrorCode | null {
  if (typeof value !== 'string') return null;
  return AGENT_TURN_ERROR_CODES.find((code) => code === value) ?? null;
}

export function normalizeAgentTurnErrorCode(error: unknown): AgentTurnErrorCode | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = 'code' in error ? parseAgentTurnErrorCode(error.code) : null;
  if (code !== null) return code;
  return 'name' in error && error.name === 'QuotaExceededError'
    ? 'agent_session_quota_exceeded'
    : undefined;
}

export function parseBgsmAgentTurnClientMessage(value: unknown): BgsmAgentTurnClientMessage {
  if (!isAgentRecord(value)) throw new TypeError('Agent client message must be an object.');

  if (value.type === 'startBgsmAgentTurn') {
    const expectedKeys = [
      'type',
      'executionEpochId',
      'turnAttemptId',
      'sessionId',
      'baseRevision',
      'prompt',
      ...(value.retrySourceAttemptId === undefined ? [] : ['retrySourceAttemptId']),
      ...(value.candidateContract === undefined ? [] : ['candidateContract']),
      ...(value.resumeOnly === undefined ? [] : ['resumeOnly']),
    ];
    assertAgentExactKeys(value, expectedKeys);
    if (value.resumeOnly !== undefined && value.resumeOnly !== true) {
      throw new TypeError('Agent resume-only marker is invalid.');
    }
    assertAgentTurnTransportIdentifier(value.executionEpochId, 'Agent execution epoch ID');
    validateAgentSessionLaunchIdentity({
      turnAttemptId: value.turnAttemptId,
      sessionId: value.sessionId,
      baseRevision: value.baseRevision,
      prompt: value.prompt,
      ...(value.retrySourceAttemptId === undefined
        ? {}
        : { retrySourceAttemptId: value.retrySourceAttemptId }),
      ...(value.candidateContract === undefined
        ? {}
        : { candidateContract: value.candidateContract }),
    });
    assertAgentSessionTransportPayloadSize(value, 'Agent turn start delivery');
    return value as unknown as BgsmAgentTurnClientMessage;
  }

  if (value.type === 'stopBgsmAgentTurn') {
    assertAgentExactKeys(value, [
      'type',
      'executionEpochId',
      'turnAttemptId',
      'sessionId',
      'baseRevision',
    ]);
    validateAgentExecutionDeliveryIdentity(value);
    assertAgentSessionTransportPayloadSize(value, 'Agent turn stop delivery');
    return value as unknown as BgsmAgentTurnClientMessage;
  }

  if (value.type === 'ackBgsmAgentTurnResult') {
    assertAgentExactKeys(value, [
      'type',
      'executionEpochId',
      'turnAttemptId',
      'sessionId',
      'baseRevision',
      'disposition',
      'appliedRevision',
    ]);
    validateAgentExecutionDeliveryIdentity(value);
    validateAgentTurnAcknowledgement(value);
    assertAgentSessionTransportPayloadSize(value, 'Agent turn acknowledgement delivery');
    return value as unknown as BgsmAgentTurnClientMessage;
  }

  throw new TypeError('Unsupported Agent client message type.');
}

export function parseBgsmAgentTurnServerMessage(value: unknown): BgsmAgentTurnServerMessage {
  if (!isAgentRecord(value)) throw new TypeError('Agent server message must be an object.');

  if (value.type === 'bgsmAgentTurnHello') {
    assertAgentExactKeys(value, ['type', 'executionEpochId']);
    assertAgentTurnTransportIdentifier(value.executionEpochId, 'Agent execution epoch ID');
    assertAgentSessionTransportPayloadSize(value, 'Agent turn hello delivery');
    return value as unknown as BgsmAgentTurnServerMessage;
  }

  if (value.type === 'bgsmAgentTurnAck') {
    assertAgentExactKeys(value, [
      'type',
      'turnAttemptId',
      'sessionId',
      'baseRevision',
      'disposition',
      'appliedRevision',
    ]);
    validateAgentDeliveryIdentity(value);
    validateAgentTurnAcknowledgement(value);
    assertAgentSessionTransportPayloadSize(value, 'Agent turn acknowledgement confirmation');
    return value as unknown as BgsmAgentTurnServerMessage;
  }

  assertAgentSequenceNumber(value.sequence, 'sequence');
  if (value.type === 'bgsmAgentTurnEvent') {
    assertAgentExactKeys(value, ['type', 'sequence', 'event']);
    validateAgentTurnEvent(value.event);
  } else if (value.type === 'bgsmAgentTurnResult') {
    assertAgentExactKeys(value, ['type', 'sequence', 'result']);
    validateAgentTurnResult(value.result);
  } else if (value.type === 'bgsmAgentTurnError') {
    assertAgentExactKeys(value, ['type', 'sequence', 'error']);
    validateAgentTurnError(value.error);
  } else {
    throw new TypeError('Unsupported Agent server message type.');
  }
  assertAgentSessionTransportPayloadSize(value, 'Agent turn server delivery');
  return value as unknown as BgsmAgentTurnServerMessage;
}

function validateAgentExecutionDeliveryIdentity(value: Record<string, unknown>): void {
  assertAgentTurnTransportIdentifier(value.executionEpochId, 'Agent execution epoch ID');
  validateAgentDeliveryIdentity(value);
}

function validateAgentDeliveryIdentity(value: Record<string, unknown>): void {
  assertAgentTurnTransportIdentifier(value.turnAttemptId, 'Agent turn attempt ID');
  assertAgentTurnTransportIdentifier(value.sessionId, 'Agent session ID');
  assertAgentSequenceNumber(value.baseRevision, 'baseRevision');
}

function validateAgentTurnAcknowledgement(value: Record<string, unknown>): void {
  if (value.disposition === 'applied') {
    if (
      !Number.isSafeInteger(value.appliedRevision)
      || Number(value.appliedRevision) !== Number(value.baseRevision) + 1
    ) {
      throw new TypeError('Agent acknowledgement revision is invalid.');
    }
    return;
  }
  if (!['no_transition', 'transition_rejected', 'detached'].includes(String(value.disposition))) {
    throw new TypeError('Agent acknowledgement disposition is invalid.');
  }
  if (value.appliedRevision !== null) {
    throw new TypeError('Agent acknowledgement revision is invalid.');
  }
}

function validateAgentTurnEvent(value: unknown): asserts value is BgsmAgentTurnEvent {
  if (!isAgentRecord(value)) throw new TypeError('Agent event must be an object.');
  validateAgentDeliveryIdentity(value);
  const base = ['type', 'turnAttemptId', 'sessionId', 'baseRevision'];
  let keys: string[];
  switch (value.type) {
    case 'agent_queued':
    case 'agent_start':
      keys = base;
      break;
    case 'conversation_bound':
      keys = [...base, 'binding'];
      validateBgsmAgentConversationBinding(value.binding);
      break;
    case 'turn_start':
    case 'assistant_stream_start':
      keys = [...base, 'step'];
      assertAgentSequenceNumber(value.step, 'step');
      break;
    case 'assistant_text_delta':
      keys = [...base, 'step', 'delta'];
      assertAgentSequenceNumber(value.step, 'step');
      assertAgentText(value.delta, 'delta', 256 * 1024, false);
      break;
    case 'message_update':
      keys = [...base, 'message'];
      validateAgentSessionMessage(value.message, 'live');
      break;
    case 'tool_execution_queued':
      keys = [...base, 'toolName', 'callId'];
      assertAgentText(value.toolName, 'toolName', 256, true);
      assertAgentText(value.callId, 'callId', 512, true);
      break;
    case 'tool_execution_start':
      keys = [...base, 'toolName', 'callId', 'risk'];
      assertAgentText(value.toolName, 'toolName', 256, true);
      assertAgentText(value.callId, 'callId', 512, true);
      validateToolRisk(value.risk);
      break;
    case 'tool_execution_end':
      keys = [...base, 'toolName', 'callId', 'risk', 'ok', 'writeOutcome'];
      assertAgentText(value.toolName, 'toolName', 256, true);
      assertAgentText(value.callId, 'callId', 512, true);
      validateToolRisk(value.risk);
      if (typeof value.ok !== 'boolean') throw new TypeError('Agent tool result is invalid.');
      if (!['not_applicable', 'committed', 'failed', 'unknown'].includes(String(value.writeOutcome))) {
        throw new TypeError('Agent tool write outcome is invalid.');
      }
      if ((value.risk === 'write') === (value.writeOutcome === 'not_applicable')) {
        throw new TypeError('Agent tool write outcome does not match its risk.');
      }
      break;
    case 'approval_required':
      keys = [...base, 'callId', 'summary'];
      assertAgentText(value.callId, 'callId', 512, true);
      assertAgentText(value.summary, 'summary', 4_096, true);
      break;
    case 'context_compaction_start':
      keys = base;
      break;
    case 'context_diagnostic':
      keys = [
        ...base,
        'stage',
        'providerWindow',
        'workingWindow',
        'softLimit',
        'hardLimit',
        'capabilitySource',
        'capabilityRevision',
        'policyRevision',
        ...(value.inputTokens === undefined ? [] : ['inputTokens']),
        ...(value.deterministicInputTokens === undefined ? [] : ['deterministicInputTokens']),
        ...(value.usageAdjustmentTokens === undefined ? [] : ['usageAdjustmentTokens']),
        ...(value.observedPrefixTokens === undefined ? [] : ['observedPrefixTokens']),
        ...(value.contextRemainingTokens === undefined ? [] : ['contextRemainingTokens']),
        ...(value.toolAllowanceBytes === undefined ? [] : ['toolAllowanceBytes']),
        ...(value.toolMemoryRemainingBytes === undefined ? [] : ['toolMemoryRemainingBytes']),
        ...(value.toolProviderResultCeilingBytes === undefined
          ? []
          : ['toolProviderResultCeilingBytes']),
        ...(value.toolBudgetLimitedBy === undefined ? [] : ['toolBudgetLimitedBy']),
        ...(value.toolResultBytes === undefined ? [] : ['toolResultBytes']),
        ...(value.toolResultReduced === undefined ? [] : ['toolResultReduced']),
        ...(value.action === undefined ? [] : ['action']),
        ...(value.trigger === undefined ? [] : ['trigger']),
        ...(value.category === undefined ? [] : ['category']),
      ];
      if (!['preflight', 'tool_allowance', 'post_tool', 'compaction'].includes(String(value.stage))) {
        throw new TypeError('Agent context diagnostic stage is invalid.');
      }
      for (const field of ['providerWindow', 'workingWindow', 'softLimit', 'hardLimit'] as const) {
        assertAgentSequenceNumber(value[field], field);
      }
      if (!['builtin-official', 'provider-verified', 'user-declared'].includes(String(value.capabilitySource))) {
        throw new TypeError('Agent context capability source is invalid.');
      }
      assertAgentText(value.capabilityRevision, 'capabilityRevision', 512, true);
      assertAgentText(value.policyRevision, 'policyRevision', 1_024, true);
      for (const field of [
        'inputTokens',
        'deterministicInputTokens',
        'usageAdjustmentTokens',
        'contextRemainingTokens',
        'toolAllowanceBytes',
        'toolMemoryRemainingBytes',
        'toolProviderResultCeilingBytes',
        'toolResultBytes',
      ] as const) {
        if (value[field] !== undefined) assertAgentSequenceNumber(value[field], field);
      }
      if (value.observedPrefixTokens !== undefined && value.observedPrefixTokens !== null) {
        assertAgentSequenceNumber(value.observedPrefixTokens, 'observedPrefixTokens');
      }
      if (
        value.toolBudgetLimitedBy !== undefined
        && !['context', 'memory', 'provider', 'multiple'].includes(String(value.toolBudgetLimitedBy))
      ) {
        throw new TypeError('Agent tool budget limiting factor is invalid.');
      }
      if (value.toolResultReduced !== undefined && typeof value.toolResultReduced !== 'boolean') {
        throw new TypeError('Agent tool result reduction flag is invalid.');
      }
      if (
        value.action !== undefined
        && !['triggered', 'summary_retry', 'fallback', 'terminal'].includes(String(value.action))
      ) {
        throw new TypeError('Agent context diagnostic action is invalid.');
      }
      if (value.trigger !== undefined && ![
        'pre_turn_soft_limit',
        'pre_turn_byte_limit',
        'completed_tool_envelope_soft_limit',
        'completed_tool_envelope_byte_limit',
        'forced_completed_tool_envelope',
        'tool_result_memory_pressure',
        'context_preflight',
        'provider_context_overflow',
        'provider_request_byte_limit',
      ].includes(String(value.trigger))) {
        throw new TypeError('Agent compaction trigger is invalid.');
      }
      if (value.category !== undefined && ![
        'succeeded',
        'current_turn_too_large',
        'no_candidate',
        'summary_provider_failed',
        'summary_invalid',
        'fallback_too_large',
        'final_preflight_failed',
        'tool_result_memory_limit',
        'capability_unresolved',
        'provider_context_overflow',
        'provider_context_overflow_repeated',
        'provider_request_byte_limit',
        'provider_request_byte_limit_repeated',
      ].includes(String(value.category))) {
        throw new TypeError('Agent context diagnostic category is invalid.');
      }
      break;
    case 'context_compaction_end':
      keys = [...base, 'ok', 'summarizedMessageCount'];
      if (typeof value.ok !== 'boolean') throw new TypeError('Agent compaction result is invalid.');
      assertAgentSequenceNumber(value.summarizedMessageCount, 'summarizedMessageCount');
      break;
    case 'agent_error':
      keys = [...base, 'message', ...(value.category === undefined ? [] : ['category'])];
      assertAgentText(value.message, 'message', 4_096, true);
      validateAgentErrorCategory(value.category);
      break;
    case 'agent_done':
      keys = [
        ...base,
        'reason',
        ...(value.contextFailureReason === undefined ? [] : ['contextFailureReason']),
      ];
      validateAgentContextFailureShape(value.reason, value.contextFailureReason);
      break;
    default:
      throw new TypeError('Unsupported Agent event type.');
  }
  assertAgentExactKeys(value, keys);
}

function validateAgentTurnResult(value: unknown): asserts value is BgsmAgentTurnResult {
  if (!isAgentRecord(value)) throw new TypeError('Agent result must be an object.');
  assertAgentSessionTransportPayloadSize(value, 'Agent turn result');
  validateAgentDeliveryIdentity(value);
  const keys = [
    'turnAttemptId',
    'sessionId',
    'baseRevision',
    'reason',
    'changed',
    'changedCount',
    'commit',
    ...(value.contextFailureReason === undefined ? [] : ['contextFailureReason']),
    ...(value.organizeLibraryHandoff === undefined ? [] : ['organizeLibraryHandoff']),
  ];
  assertAgentExactKeys(value, keys);
  validateAgentContextFailureShape(value.reason, value.contextFailureReason);
  if (typeof value.changed !== 'boolean') throw new TypeError('Agent changed flag is invalid.');
  assertAgentSequenceNumber(value.changedCount, 'changedCount');
  if ((Number(value.changedCount) > 0) !== value.changed) {
    throw new TypeError('Agent changed count does not match its changed flag.');
  }
  if (value.commit !== null) validateAgentSessionCommitResult(value.commit, value);
  if (value.organizeLibraryHandoff !== undefined) {
    if (!isAgentRecord(value.organizeLibraryHandoff)) {
      throw new TypeError('Agent organize-library handoff is invalid.');
    }
    assertAgentExactKeys(value.organizeLibraryHandoff, ['type', 'action', 'instruction']);
    if (value.organizeLibraryHandoff.type !== 'organize_whole_library') {
      throw new TypeError('Agent organize-library handoff type is invalid.');
    }
    if (
      value.organizeLibraryHandoff.action !== 'request_confirmation'
      && value.organizeLibraryHandoff.action !== 'start_analysis'
    ) {
      throw new TypeError('Agent organize-library handoff action is invalid.');
    }
    assertAgentText(
      value.organizeLibraryHandoff.instruction,
      'organizeLibraryHandoff.instruction',
      512 * 1024,
      true,
    );
  }
  if (value.organizeLibraryHandoff !== undefined && value.commit === null) {
    throw new TypeError('Agent organize-library handoff requires a durable commit.');
  }
}

function validateAgentSessionCommitResult(
  value: unknown,
  result: Record<string, unknown>,
): asserts value is AgentSessionCommitResult {
  if (!isAgentRecord(value)) throw new TypeError('Agent commit receipt must be an object.');
  assertAgentExactKeys(value, [
    'session',
    'summary',
    'turnAttemptId',
    'idempotent',
    'appliedRevision',
    'digest',
    'launchDigest',
    'outcome',
    'transcript',
    'presentationMessages',
  ]);
  assertAgentText(value.turnAttemptId, 'commit.turnAttemptId', 512, true);
  if (value.turnAttemptId !== result.turnAttemptId) {
    throw new TypeError('Agent commit receipt belongs to another attempt.');
  }
  if (typeof value.idempotent !== 'boolean') {
    throw new TypeError('Agent commit idempotency flag is invalid.');
  }
  assertAgentSequenceNumber(value.appliedRevision, 'commit.appliedRevision');
  if (!/^asd:v1:[A-Za-z0-9_-]{43}$/u.test(String(value.digest))) {
    throw new TypeError('Agent commit transition digest is invalid.');
  }
  if (!/^asl:v1:[A-Za-z0-9_-]{43}$/u.test(String(value.launchDigest))) {
    throw new TypeError('Agent commit launch digest is invalid.');
  }
  validateAgentSessionMetadata(value.session, result, Number(value.appliedRevision));
  validateAgentSessionSummary(value.summary, result);
  validateAgentSessionTranscript(value.transcript, result);
  validateAgentSessionPresentation(value.presentationMessages);
  validateAgentTerminalOutcome(value.outcome, result);
}

function validateAgentSessionMetadata(
  value: unknown,
  result: Record<string, unknown>,
  appliedRevision: number,
): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent session metadata must be an object.');
  assertAgentExactKeys(value, [
    'id',
    'revision',
    ...(value.compaction === undefined ? [] : ['compaction']),
    ...(value.activeProjections === undefined ? [] : ['activeProjections']),
    ...(value.binding === undefined ? [] : ['binding']),
  ]);
  assertAgentText(value.id, 'commit.session.id', 512, true);
  assertAgentSequenceNumber(value.revision, 'commit.session.revision');
  if (
    value.id !== result.sessionId
    || Number(value.revision) < appliedRevision
    || appliedRevision <= Number(result.baseRevision)
  ) {
    throw new TypeError('Agent commit revision identity is invalid.');
  }
  if (value.compaction !== undefined) validateAgentCheckpoint(value.compaction);
  if (value.activeProjections !== undefined) {
    if (!Array.isArray(value.activeProjections)) {
      throw new TypeError('Agent session active projections are invalid.');
    }
    value.activeProjections.forEach(validateAgentActiveProjection);
  }
  if (value.binding !== undefined) validateBgsmAgentConversationBinding(value.binding);
}

function validateAgentSessionSummary(value: unknown, result: Record<string, unknown>): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent session summary must be an object.');
  assertAgentExactKeys(value, ['id', 'title', 'createdAt', 'updatedAt']);
  assertAgentText(value.id, 'commit.summary.id', 512, true);
  assertAgentText(value.title, 'commit.summary.title', 512, false);
  assertAgentSequenceNumber(value.createdAt, 'commit.summary.createdAt');
  assertAgentSequenceNumber(value.updatedAt, 'commit.summary.updatedAt');
  if (value.id !== result.sessionId || Number(value.updatedAt) < Number(value.createdAt)) {
    throw new TypeError('Agent session summary identity is invalid.');
  }
}

function validateAgentSessionTranscript(value: unknown, result: Record<string, unknown>): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent transcript page must be an object.');
  assertAgentExactKeys(value, ['sessionId', 'messages', 'nextBeforeSequence']);
  assertAgentText(value.sessionId, 'commit.transcript.sessionId', 512, true);
  if (value.sessionId !== result.sessionId || !Array.isArray(value.messages)) {
    throw new TypeError('Agent transcript page identity is invalid.');
  }
  value.messages.forEach((message) => validateAgentSessionMessage(message, 'durable'));
  if (value.nextBeforeSequence !== null) {
    assertAgentSequenceNumber(value.nextBeforeSequence, 'commit.transcript.nextBeforeSequence');
    if (Number(value.nextBeforeSequence) < 1) {
      throw new TypeError('Agent transcript cursor is invalid.');
    }
  }
}

function validateAgentSessionPresentation(value: unknown): void {
  if (!Array.isArray(value)) throw new TypeError('Agent turn presentation is invalid.');
  let priorSequence = 0;
  const seenIds = new Set<string>();
  for (const message of value) {
    if (!isAgentRecord(message)) throw new TypeError('Agent presentation message is invalid.');
    assertAgentExactKeys(message, ['sequence', 'id', 'role', 'content', 'createdAt']);
    assertAgentSequenceNumber(message.sequence, 'commit.presentation.sequence');
    assertAgentText(message.id, 'commit.presentation.id', 512, true);
    assertAgentText(message.content, 'commit.presentation.content', 512 * 1024, false);
    assertAgentSequenceNumber(message.createdAt, 'commit.presentation.createdAt');
    if (
      Number(message.sequence) <= priorSequence
      || seenIds.has(String(message.id))
      || (message.role !== 'user' && message.role !== 'agent')
    ) {
      throw new TypeError('Agent presentation messages are not canonical.');
    }
    priorSequence = Number(message.sequence);
    seenIds.add(String(message.id));
  }
}

function validateAgentTerminalOutcome(value: unknown, result: Record<string, unknown>): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent terminal outcome must be an object.');
  assertAgentExactKeys(value, [
    'reason',
    'changed',
    'changedCount',
    'writeSettlement',
    ...(value.contextFailureReason === undefined ? [] : ['contextFailureReason']),
    ...(value.organizeLibraryAction === undefined ? [] : ['organizeLibraryAction']),
    ...(value.handoffAnchor === undefined ? [] : ['handoffAnchor']),
  ]);
  validateAgentContextFailureShape(value.reason, value.contextFailureReason);
  if (typeof value.changed !== 'boolean') throw new TypeError('Agent outcome changed flag is invalid.');
  assertAgentSequenceNumber(value.changedCount, 'commit.outcome.changedCount');
  if (
    value.writeSettlement !== 'none'
    && value.writeSettlement !== 'all_failed'
    && value.writeSettlement !== 'unsafe'
  ) throw new TypeError('Agent outcome write settlement is invalid.');
  if (value.changed && value.writeSettlement !== 'unsafe') {
    throw new TypeError('Agent changed outcome must have an unsafe write settlement.');
  }
  if (value.organizeLibraryAction !== undefined && ![
    'request_confirmation',
    'start_analysis',
  ].includes(String(value.organizeLibraryAction))) {
    throw new TypeError('Agent outcome organize action is invalid.');
  }
  if (value.handoffAnchor !== undefined) {
    if (!isAgentRecord(value.handoffAnchor)) throw new TypeError('Agent handoff anchor is invalid.');
    assertAgentExactKeys(value.handoffAnchor, ['messageId', 'createdAt']);
    if (value.handoffAnchor.messageId !== null) {
      assertAgentText(
        value.handoffAnchor.messageId,
        'commit.outcome.handoffAnchor.messageId',
        512,
        true,
      );
    }
    assertAgentSequenceNumber(
      value.handoffAnchor.createdAt,
      'commit.outcome.handoffAnchor.createdAt',
    );
  }
  const handoff = isAgentRecord(result.organizeLibraryHandoff)
    ? result.organizeLibraryHandoff
    : null;
  if (
    value.reason !== result.reason
    || value.changed !== result.changed
    || value.changedCount !== result.changedCount
    || (value.contextFailureReason ?? null) !== (result.contextFailureReason ?? null)
    || (value.organizeLibraryAction ?? null) !== (handoff?.action ?? null)
    || ((value.organizeLibraryAction === undefined) !== (value.handoffAnchor === undefined))
  ) {
    throw new TypeError('Agent terminal outcome does not match its delivery.');
  }
}

function validateAgentTurnError(value: unknown): asserts value is BgsmAgentTurnError {
  if (!isAgentRecord(value)) throw new TypeError('Agent error must be an object.');
  validateAgentDeliveryIdentity(value);
  assertAgentExactKeys(value, [
    'turnAttemptId',
    'sessionId',
    'baseRevision',
    'message',
    ...(value.category === undefined ? [] : ['category']),
    ...(value.code === undefined ? [] : ['code']),
  ]);
  assertAgentText(value.message, 'message', 4_096, true);
  validateAgentErrorCategory(value.category);
  if (value.code !== undefined) {
    assertAgentText(value.code, 'code', 128, true);
    if (parseAgentTurnErrorCode(value.code) === null) {
      throw new TypeError('Agent error code is invalid.');
    }
  }
}

/**
 * Live loop messages have no durable sequence yet; transcript messages do.
 * Keeping the modes explicit prevents transient delivery from masquerading as
 * canonical history while still validating artifact-backed tool rows.
 */
function validateAgentSessionMessage(value: unknown, mode: 'live' | 'durable'): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent session message must be an object.');
  const baseKeys = [
    ...(mode === 'durable' ? ['sequence'] : []),
    'id',
    'role',
    'content',
    'createdAt',
  ];
  if (mode === 'durable') assertAgentSequenceNumber(value.sequence, 'message.sequence');
  assertAgentText(value.id, 'message.id', 512, true);
  assertAgentText(value.content, 'message.content', 512 * 1024, false);
  if (!Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0) {
    throw new TypeError('Agent session message timestamp is invalid.');
  }
  if (value.role === 'user') {
    assertAgentExactKeys(value, baseKeys);
    return;
  }
  if (value.role === 'agent') {
    const keys = value.toolCalls === undefined ? baseKeys : [...baseKeys, 'toolCalls'];
    assertAgentExactKeys(value, keys);
    if (value.toolCalls !== undefined) {
      if (!Array.isArray(value.toolCalls) || value.toolCalls.length === 0 || value.toolCalls.length > 64) {
        throw new TypeError('Agent message tool calls are invalid.');
      }
      value.toolCalls.forEach(validateAgentToolCall);
    }
    return;
  }
  if (value.role === 'tool') {
    assertAgentExactKeys(value, [
      ...baseKeys,
      'toolCallId',
      'toolName',
      ...(value.opaqueReferences === undefined ? [] : ['opaqueReferences']),
    ]);
    assertAgentText(value.toolCallId, 'message.toolCallId', 512, true);
    assertAgentText(value.toolName, 'message.toolName', 256, true);
    if (value.opaqueReferences !== undefined) {
      validateAgentTurnOpaqueReferences(value.opaqueReferences);
    }
    return;
  }
  throw new TypeError('Agent session message role is invalid.');
}

function validateAgentToolCall(value: unknown): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent tool call must be an object.');
  assertAgentExactKeys(value, ['id', 'name', 'arguments']);
  assertAgentText(value.id, 'toolCall.id', 512, true);
  assertAgentText(value.name, 'toolCall.name', 256, true);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value.arguments);
  } catch {
    throw new TypeError('Agent tool call arguments are not serializable.');
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 256 * 1024) {
    throw new RangeError('Agent tool call arguments are too large.');
  }
}

function validateAgentCheckpoint(value: unknown): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent checkpoint must be an object.');
  assertAgentExactKeys(value, [
    'schemaVersion',
    'summary',
    'summarizedMessageCount',
    'summarizedThroughMessageId',
  ]);
  if (value.schemaVersion !== 1) throw new TypeError('Agent checkpoint version is invalid.');
  assertAgentText(value.summary, 'checkpoint.summary', 64 * 1024, true);
  if (!Number.isSafeInteger(value.summarizedMessageCount) || Number(value.summarizedMessageCount) <= 0) {
    throw new TypeError('Agent checkpoint message count is invalid.');
  }
  assertAgentText(value.summarizedThroughMessageId, 'checkpoint.cursor', 512, true);
}

function validateAgentActiveProjection(value: unknown): void {
  if (!isAgentRecord(value)) throw new TypeError('Agent active projection must be an object.');
  assertAgentExactKeys(value, [
    'schemaVersion',
    'currentUserMessageId',
    'summarizedThroughMessageId',
    'retainedSuffixFirstMessageId',
    'rawMessageCountAtCreation',
    'rawTailMessageIdAtCreation',
    'capabilityRevision',
    'policyRevision',
    'summary',
  ]);
  if (value.schemaVersion !== 1) throw new TypeError('Agent active projection version is invalid.');
  assertAgentText(value.currentUserMessageId, 'active projection user cursor', 512, true);
  assertAgentText(value.summarizedThroughMessageId, 'active projection summary cursor', 512, true);
  if (value.retainedSuffixFirstMessageId !== null) {
    assertAgentText(value.retainedSuffixFirstMessageId, 'active projection suffix cursor', 512, true);
  }
  if (!Number.isSafeInteger(value.rawMessageCountAtCreation) || Number(value.rawMessageCountAtCreation) <= 0) {
    throw new TypeError('Agent active projection raw message count is invalid.');
  }
  assertAgentText(value.rawTailMessageIdAtCreation, 'active projection raw tail cursor', 512, true);
  assertAgentText(value.capabilityRevision, 'active projection capability revision', 512, true);
  assertAgentText(value.policyRevision, 'active projection policy revision', 512, true);
  assertAgentText(value.summary, 'active projection summary', 64 * 1024, true);
}

function validateAgentErrorCategory(value: unknown): void {
  if (value === undefined) return;
  if (![
    'authentication',
    'configuration',
    'permission',
    'disclosure',
    'capability',
    'provider',
    'other',
  ].includes(String(value))) {
    throw new TypeError('Agent error category is invalid.');
  }
}

function validateToolRisk(value: unknown): asserts value is ToolRisk {
  if (!['read', 'suggest', 'write'].includes(String(value))) {
    throw new TypeError('Agent tool risk is invalid.');
  }
}

function validateAgentStopReason(value: unknown): void {
  if (![
    'final_answer',
    'approval_required',
    'interaction_required',
    'protocol_error',
    'step_budget_reached',
    'context_limit',
    'provider_error',
    'attempt_state_lost',
    'aborted',
  ].includes(String(value))) {
    throw new TypeError('Agent stop reason is invalid.');
  }
}

function validateAgentContextFailureReason(
  value: unknown,
): asserts value is AgentContextFailureReason {
  if (![
    'capability_unresolved',
    'current_turn_too_large',
    'no_candidate',
    'summary_provider_failed',
    'summary_invalid',
    'fallback_too_large',
    'final_preflight_failed',
    'tool_result_memory_limit',
    'provider_context_overflow',
    'provider_context_overflow_repeated',
    'provider_request_byte_limit',
    'provider_request_byte_limit_repeated',
  ].includes(String(value))) {
    throw new TypeError('Agent context failure reason is invalid.');
  }
}

function validateAgentContextFailureShape(
  reason: unknown,
  contextFailureReason: unknown,
): void {
  validateAgentStopReason(reason);
  if (reason === 'context_limit') {
    if (contextFailureReason === undefined) {
      throw new TypeError('Agent context-limit reason requires a failure reason.');
    }
    validateAgentContextFailureReason(contextFailureReason);
    return;
  }
  if (contextFailureReason !== undefined) {
    throw new TypeError('Agent context failure reason requires a context-limit stop.');
  }
}

function assertAgentText(
  value: unknown,
  field: string,
  maxBytes: number,
  requireNonempty: boolean,
): void {
  if (typeof value !== 'string' || (requireNonempty && value.length === 0)) {
    throw new TypeError(`Agent ${field} is invalid.`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RangeError(`Agent ${field} is too large.`);
  }
}

function assertAgentSequenceNumber(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`Agent ${field} is invalid.`);
  }
}

function assertAgentExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError('Agent Port message has unexpected fields.');
  }
}

function isAgentRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
