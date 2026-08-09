import type { AgentMessage, AgentRequiredBeforeFinalDirective } from '@/agent-harness';
import {
  AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION,
  validateAgentArtifactContinuationCheckpoint,
  type AgentArtifactContinuationCheckpoint,
} from '@/bgsm-agent/artifact-coverage';
import type { BgsmAgentSessionMessage } from '@/bgsm-agent/session';
import { assertAgentTurnTransportIdentifier } from '@/bgsm-agent/session-transport';

export type AgentArtifactContinuationControl = Readonly<{
  schemaVersion: typeof AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION;
  directives: readonly AgentRequiredBeforeFinalDirective[];
  nonProgressRepromptUsed: boolean;
  updatedAt: number;
}>;

export type AgentAttemptRecoveryRecord = Readonly<{
  id: string;
  schemaVersion: typeof AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION;
  sessionId: string;
  turnAttemptId: string;
  projectedMessages: readonly AgentMessage[];
  canonicalRawMessages: readonly BgsmAgentSessionMessage[];
  updatedAt: number;
}>;

export type AgentAttemptRecoveryIdentity = Readonly<{
  id: string;
  sessionId: string;
  turnAttemptId: string;
}>;

export function splitAgentArtifactContinuation(
  continuation: AgentArtifactContinuationCheckpoint,
  identity: AgentAttemptRecoveryIdentity,
): Readonly<{
  control: AgentArtifactContinuationControl;
  recovery: AgentAttemptRecoveryRecord;
}> {
  validateAgentArtifactContinuationCheckpoint(continuation);
  validateAgentAttemptRecoveryIdentity(identity);
  const control: AgentArtifactContinuationControl = {
    schemaVersion: continuation.schemaVersion,
    directives: structuredClone(continuation.directives),
    nonProgressRepromptUsed: continuation.nonProgressRepromptUsed,
    updatedAt: continuation.updatedAt,
  };
  const recovery: AgentAttemptRecoveryRecord = {
    id: identity.id,
    schemaVersion: continuation.schemaVersion,
    sessionId: identity.sessionId,
    turnAttemptId: identity.turnAttemptId,
    projectedMessages: structuredClone(continuation.projectedMessages),
    canonicalRawMessages: structuredClone(continuation.canonicalRawMessages),
    updatedAt: continuation.updatedAt,
  };
  validateAgentArtifactContinuationControl(control);
  validateAgentAttemptRecoveryRecord(recovery);
  return { control, recovery };
}

export function joinAgentArtifactContinuation(
  control: AgentArtifactContinuationControl,
  recovery: AgentAttemptRecoveryRecord,
  identity: AgentAttemptRecoveryIdentity,
): AgentArtifactContinuationCheckpoint {
  validateAgentArtifactContinuationControl(control);
  validateAgentAttemptRecoveryRecord(recovery);
  validateAgentAttemptRecoveryIdentity(identity);
  if (
    recovery.id !== identity.id
    || recovery.sessionId !== identity.sessionId
    || recovery.turnAttemptId !== identity.turnAttemptId
  ) throw new TypeError('Agent attempt recovery identity does not match its parent attempt.');
  if (
    recovery.schemaVersion !== control.schemaVersion
    || recovery.updatedAt !== control.updatedAt
  ) throw new TypeError('Agent attempt recovery does not match its continuation control.');
  const continuation: AgentArtifactContinuationCheckpoint = {
    schemaVersion: control.schemaVersion,
    projectedMessages: recovery.projectedMessages,
    canonicalRawMessages: recovery.canonicalRawMessages,
    directives: control.directives,
    nonProgressRepromptUsed: control.nonProgressRepromptUsed,
    updatedAt: control.updatedAt,
  };
  validateAgentArtifactContinuationCheckpoint(continuation);
  return structuredClone(continuation);
}

export function validateAgentArtifactContinuationControl(
  value: unknown,
): asserts value is AgentArtifactContinuationControl {
  assertObject(value, 'Agent artifact continuation control');
  if (!hasExactKeys(value, [
    'directives',
    'nonProgressRepromptUsed',
    'schemaVersion',
    'updatedAt',
  ])) throw new TypeError('Agent artifact continuation control has unexpected fields.');
  const continuation = {
    schemaVersion: value.schemaVersion,
    projectedMessages: [],
    canonicalRawMessages: [],
    directives: value.directives,
    nonProgressRepromptUsed: value.nonProgressRepromptUsed,
    updatedAt: value.updatedAt,
  } as unknown as AgentArtifactContinuationCheckpoint;
  validateAgentArtifactContinuationCheckpoint(continuation);
}

export function validateAgentAttemptRecoveryRecord(
  value: unknown,
): asserts value is AgentAttemptRecoveryRecord {
  assertObject(value, 'Agent attempt recovery');
  if (!hasExactKeys(value, [
    'canonicalRawMessages',
    'id',
    'projectedMessages',
    'schemaVersion',
    'sessionId',
    'turnAttemptId',
    'updatedAt',
  ])) throw new TypeError('Agent attempt recovery has unexpected fields.');
  assertAttemptStorageId(value.id);
  assertAgentTurnTransportIdentifier(value.sessionId, 'Agent attempt recovery session ID');
  assertAgentTurnTransportIdentifier(value.turnAttemptId, 'Agent attempt recovery ID');
  if (value.schemaVersion !== AGENT_ARTIFACT_COVERAGE_SCHEMA_VERSION) {
    throw new TypeError('Agent attempt recovery schema version is unsupported.');
  }
  if (!Array.isArray(value.projectedMessages) || !Array.isArray(value.canonicalRawMessages)) {
    throw new TypeError('Agent attempt recovery messages must be arrays.');
  }
  assertTimestamp(value.updatedAt, 'Agent attempt recovery update time');
}

function validateAgentAttemptRecoveryIdentity(value: AgentAttemptRecoveryIdentity): void {
  assertAttemptStorageId(value.id);
  assertAgentTurnTransportIdentifier(value.sessionId, 'Agent attempt recovery session ID');
  assertAgentTurnTransportIdentifier(value.turnAttemptId, 'Agent attempt recovery ID');
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertAttemptStorageId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^aat:v1:[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError('Agent attempt recovery storage key is malformed.');
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
}
