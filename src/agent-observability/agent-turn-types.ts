import type {
  AgentEvent,
  AgentExecutionTraceSink,
} from '@/agent-harness';
import type {
  DevTraceEventDataByKind,
  DevTraceTerminalState,
} from './contracts';

export type AgentTurnTraceStart = Readonly<{
  rootOperationId: string;
  sessionId: string;
  turnAttemptId: string;
  baseRevision: number;
  executionEpochId: string;
  startedAt: number;
  resumeExisting?: boolean;
}>;

export type AgentTurnTrace = Readonly<{
  execution: AgentExecutionTraceSink;
  recordAgentEvent(event: AgentEvent): void;
  recordDelivery(input: Readonly<{
    connectionEpochId: string;
    deliverySequence: number;
    deliveryKind: 'live' | 'replay' | 'authoritative_snapshot';
  }>): void;
  recordAcknowledgement(input: DevTraceEventDataByKind['result_acknowledged']): void;
  recordCancellation(source: 'user' | 'port' | 'runtime' | 'scenario'): void;
  recordAttemptRejected(reason: DevTraceEventDataByKind['attempt_rejected']['reason']): void;
  recordDisconnect(input: DevTraceEventDataByKind['port_disconnected']): void;
  finish(state: DevTraceTerminalState, reasonCode: string | null): void;
  flush(): Promise<void>;
}>;

export type AgentTurnTraceFactory = (input: AgentTurnTraceStart) => AgentTurnTrace;
