import type { AgentErrorCategory } from '@/agent-harness';
import type { BgsmAgentTurnResult } from '@/bgsm-agent/turn-protocol';

export type BgsmAgentStatus = Readonly<{
  kind: 'idle' | 'queued' | 'working' | 'compacting' | 'tool' | 'done' | 'stopped' | 'error';
  text: string;
}>;

export type BgsmAgentToolActivity = Readonly<{
  callId: string;
  toolName: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
}>;

export type BgsmAgentActionableContextFailureReason =
  | 'capability_unresolved'
  | 'current_turn_too_large'
  | 'tool_result_memory_limit'
  | 'provider_context_overflow_repeated'
  | 'provider_request_byte_limit_repeated';

export type BgsmAgentContextLimitRecovery = Readonly<{
  prompt: string;
  reason: BgsmAgentActionableContextFailureReason;
}>;

export type AgentTurnPhase =
  | 'idle'
  | 'queued'
  | 'working'
  | 'tool'
  | 'compacting'
  | 'stopping'
  | 'settling_error'
  | 'done'
  | 'stopped'
  | 'failed'
  | 'context_recovery';

export type AgentTurnState = Readonly<{
  phase: AgentTurnPhase;
  running: boolean;
  status: BgsmAgentStatus | null;
  error: string | null;
  errorCategory: AgentErrorCategory | null;
  lastTurnResult: BgsmAgentTurnResult | null;
  contextLimitRecovery: BgsmAgentContextLimitRecovery | null;
  draftRecovery: string | null;
  canRetryLastTurn: boolean;
  toolActivities: readonly BgsmAgentToolActivity[];
  preCompactionStatus: BgsmAgentStatus | null;
}>;

export type AgentTurnAction =
  | Readonly<{ type: 'turn_started'; status: BgsmAgentStatus }>
  | Readonly<{ type: 'status_changed'; status: BgsmAgentStatus | null }>
  | Readonly<{ type: 'tool_activity_updated'; activity: BgsmAgentToolActivity }>
  | Readonly<{ type: 'tool_activity_removed'; callId: string }>
  | Readonly<{
      type: 'error_observed';
      message: string;
      category: AgentErrorCategory;
      status: BgsmAgentStatus;
    }>
  | Readonly<{
      type: 'stop_requested';
      prompt: string;
      canRetry: boolean;
      status: BgsmAgentStatus;
    }>
  | Readonly<{
      type: 'turn_failed';
      result: BgsmAgentTurnResult | null;
      message: string;
      category: AgentErrorCategory;
      status: BgsmAgentStatus;
      prompt: string;
      canRetry: boolean;
    }>
  | Readonly<{
      type: 'context_recovery_required';
      result: BgsmAgentTurnResult;
      recovery: BgsmAgentContextLimitRecovery;
      prompt: string;
      canRetry: boolean;
    }>
  | Readonly<{
      type: 'turn_finished';
      result: BgsmAgentTurnResult;
      prompt: string;
      canRetry: boolean;
      doneStatus: BgsmAgentStatus;
      stoppedStatus: BgsmAgentStatus;
      failureStatus: BgsmAgentStatus;
      failureMessage: string;
      failureCategory: AgentErrorCategory;
    }>
  | Readonly<{ type: 'turn_detached' }>
  | Readonly<{ type: 'compaction_started' }>
  | Readonly<{ type: 'compaction_shown'; status: BgsmAgentStatus }>
  | Readonly<{
      type: 'compaction_finished';
      restore: boolean;
      fallbackStatus: BgsmAgentStatus;
    }>
  | Readonly<{ type: 'context_recovery_dismissed' }>
  | Readonly<{ type: 'session_cleared' }>;

export function createAgentTurnState(): AgentTurnState {
  return {
    phase: 'idle',
    running: false,
    status: null,
    error: null,
    errorCategory: null,
    lastTurnResult: null,
    contextLimitRecovery: null,
    draftRecovery: null,
    canRetryLastTurn: true,
    toolActivities: [],
    preCompactionStatus: null,
  };
}

export function reduceAgentTurn(
  state: AgentTurnState,
  action: AgentTurnAction,
): AgentTurnState {
  switch (action.type) {
    case 'turn_started':
      return {
        ...createAgentTurnState(),
        phase: 'queued',
        running: true,
        status: action.status,
      };
    case 'status_changed':
      return state.error
        ? state
        : {
            ...state,
            phase: phaseForStatus(action.status, state.running),
            status: action.status,
          };
    case 'tool_activity_updated':
      return {
        ...state,
        toolActivities: upsertToolActivity(state.toolActivities, action.activity),
      };
    case 'tool_activity_removed':
      return {
        ...state,
        toolActivities: state.toolActivities.filter((activity) => activity.callId !== action.callId),
      };
    case 'error_observed':
      return {
        ...state,
        phase: 'settling_error',
        status: action.status,
        error: action.message,
        errorCategory: action.category,
        toolActivities: failOpenToolActivities(state.toolActivities),
      };
    case 'stop_requested':
      return {
        ...state,
        phase: 'stopping',
        status: action.status,
        draftRecovery: action.prompt,
        canRetryLastTurn: action.canRetry,
        toolActivities: failOpenToolActivities(state.toolActivities),
        preCompactionStatus: null,
      };
    case 'turn_failed':
      return {
        ...state,
        phase: 'failed',
        running: false,
        status: action.status,
        error: action.message,
        errorCategory: action.category,
        lastTurnResult: action.result,
        contextLimitRecovery: null,
        draftRecovery: action.prompt,
        canRetryLastTurn: action.canRetry,
        toolActivities: failOpenToolActivities(state.toolActivities),
        preCompactionStatus: null,
      };
    case 'context_recovery_required':
      return {
        ...state,
        phase: 'context_recovery',
        running: false,
        status: null,
        error: null,
        errorCategory: null,
        lastTurnResult: action.result,
        contextLimitRecovery: action.recovery,
        draftRecovery: action.prompt,
        canRetryLastTurn: action.canRetry,
        toolActivities: failOpenToolActivities(state.toolActivities),
        preCompactionStatus: null,
      };
    case 'turn_finished':
      return settleTurn(state, action);
    case 'turn_detached':
      return {
        ...state,
        phase: state.error ? 'failed' : state.status?.kind === 'stopped' ? 'stopped' : 'idle',
        running: false,
        preCompactionStatus: null,
      };
    case 'compaction_started':
      return state.preCompactionStatus
        ? state
        : { ...state, preCompactionStatus: state.status };
    case 'compaction_shown':
      return { ...state, phase: 'compacting', status: action.status };
    case 'compaction_finished':
      return {
        ...state,
        phase: action.restore
          ? phaseForStatus(state.preCompactionStatus ?? action.fallbackStatus, state.running)
          : state.phase,
        status: action.restore
          ? state.preCompactionStatus ?? action.fallbackStatus
          : state.status,
        preCompactionStatus: null,
      };
    case 'context_recovery_dismissed':
      return {
        ...state,
        phase: 'idle',
        contextLimitRecovery: null,
        status: null,
      };
    case 'session_cleared':
      return createAgentTurnState();
  }
}

function settleTurn(
  state: AgentTurnState,
  action: Extract<AgentTurnAction, { type: 'turn_finished' }>,
): AgentTurnState {
  const toolActivities = failOpenToolActivities(state.toolActivities);
  if (state.error) {
    return {
      ...state,
      phase: 'failed',
      running: false,
      lastTurnResult: action.result,
      draftRecovery: state.draftRecovery ?? action.prompt,
      canRetryLastTurn: action.canRetry,
      toolActivities,
      preCompactionStatus: null,
    };
  }
  if (action.result.reason === 'final_answer') {
    return {
      ...state,
      phase: 'done',
      running: false,
      status: action.doneStatus,
      error: null,
      errorCategory: null,
      lastTurnResult: action.result,
      contextLimitRecovery: null,
      draftRecovery: null,
      canRetryLastTurn: true,
      toolActivities,
      preCompactionStatus: null,
    };
  }
  if (action.result.reason === 'aborted') {
    return {
      ...state,
      phase: 'stopped',
      running: false,
      status: action.stoppedStatus,
      error: null,
      errorCategory: null,
      lastTurnResult: action.result,
      contextLimitRecovery: null,
      draftRecovery: action.prompt,
      canRetryLastTurn: action.canRetry,
      toolActivities,
      preCompactionStatus: null,
    };
  }
  return {
    ...state,
    phase: 'failed',
    running: false,
    status: action.failureStatus,
    error: action.failureMessage,
    errorCategory: action.failureCategory,
    lastTurnResult: action.result,
    contextLimitRecovery: null,
    draftRecovery: action.prompt,
    canRetryLastTurn: action.canRetry,
    toolActivities,
    preCompactionStatus: null,
  };
}

function phaseForStatus(status: BgsmAgentStatus | null, running: boolean): AgentTurnPhase {
  if (!status) return running ? 'working' : 'idle';
  switch (status.kind) {
    case 'idle':
      return 'idle';
    case 'queued':
      return 'queued';
    case 'working':
      return 'working';
    case 'tool':
      return 'tool';
    case 'compacting':
      return 'compacting';
    case 'done':
      return 'done';
    case 'stopped':
      return running ? 'stopping' : 'stopped';
    case 'error':
      return running ? 'settling_error' : 'failed';
  }
}

function upsertToolActivity(
  activities: readonly BgsmAgentToolActivity[],
  next: BgsmAgentToolActivity,
): readonly BgsmAgentToolActivity[] {
  const index = activities.findIndex((activity) => activity.callId === next.callId);
  if (index === -1) return [...activities, next];
  return activities.map((activity, activityIndex) => (
    activityIndex === index ? next : activity
  ));
}

function failOpenToolActivities(
  activities: readonly BgsmAgentToolActivity[],
): readonly BgsmAgentToolActivity[] {
  return activities.map((activity) => (
    activity.state === 'queued' || activity.state === 'running'
      ? { ...activity, state: 'failed' }
      : activity
  ));
}
