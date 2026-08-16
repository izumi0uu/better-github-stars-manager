import { AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE } from '@/api/errors';
import {
  assertAgentTurnTransportIdentifier,
  validateAgentSessionLaunchDigest,
  type AgentSessionLaunchDigest,
} from '@/bgsm-agent/session-transport';
import {
  createAgentSession,
  deleteAgentSession,
  inspectAgentSessionCatalog,
  getOrCreateInitialAgentSession,
  loadAgentSession,
  loadAgentSessionTranscriptPage,
  loadCommittedAgentSessionTurn,
  readAgentSessionRetryDraftCandidate,
} from '@/storage/agent-session-store';
import type { AgentCanonicalSessionCache } from '@/storage/agent-session-cache';
import {
  clearAgentToolCache,
  getAgentStorageUsage,
} from '@/storage/agent-storage-store';

export type BgsmAgentSessionRequest =
  | Readonly<{ type: 'inspectAgentSessionCatalog' }>
  | Readonly<{ type: 'getOrCreateInitialAgentSession' }>
  | Readonly<{ type: 'inspectActiveAgentSessionTurn'; sessionId: string }>
  | Readonly<{ type: 'createAgentSession'; sessionId?: string }>
  | Readonly<{ type: 'loadAgentSession'; sessionId: string }>
  | Readonly<{
      type: 'loadCommittedAgentSessionTurn';
      sessionId: string;
      turnAttemptId: string;
      launchDigest: AgentSessionLaunchDigest;
    }>
  | Readonly<{ type: 'readAgentRetryDraftCandidate'; sessionId: string }>
  | Readonly<{ type: 'dismissAgentSessionRetry'; sessionId: string; turnAttemptId: string }>
  | Readonly<{ type: 'abandonAgentSessionUncertainAttempt'; sessionId: string; turnAttemptId: string }>
  | Readonly<{ type: 'discardDamagedAgentSessionRecovery'; sessionId: string }>
  | Readonly<{
      type: 'loadAgentSessionTranscriptPage';
      sessionId: string;
      beforeSequence: number;
    }>
  | Readonly<{ type: 'deleteAgentSession'; sessionId: string }>
  | Readonly<{ type: 'getAgentStorageUsage' }>
  | Readonly<{ type: 'clearAgentToolCache' }>;

const BGSM_AGENT_SESSION_REQUEST_TYPES: Readonly<Record<BgsmAgentSessionRequest['type'], true>> = {
  inspectAgentSessionCatalog: true,
  getOrCreateInitialAgentSession: true,
  inspectActiveAgentSessionTurn: true,
  createAgentSession: true,
  loadAgentSession: true,
  loadCommittedAgentSessionTurn: true,
  readAgentRetryDraftCandidate: true,
  dismissAgentSessionRetry: true,
  abandonAgentSessionUncertainAttempt: true,
  discardDamagedAgentSessionRecovery: true,
  loadAgentSessionTranscriptPage: true,
  deleteAgentSession: true,
  getAgentStorageUsage: true,
  clearAgentToolCache: true,
};

const BGSM_AGENT_SESSION_FAILURE_CODES: Readonly<Record<string, true>> = {
  agent_session_not_found: true,
  agent_session_revision_conflict: true,
  agent_session_attempt_conflict: true,
  agent_session_corrupt: true,
  agent_session_deletion_blocked: true,
  agent_session_turn_active: true,
  agent_session_turn_lease_mismatch: true,
  agent_storage_capacity_exceeded: true,
  agent_artifact_not_found: true,
  agent_artifact_not_ready: true,
  agent_artifact_corrupt: true,
  agent_artifact_conflict: true,
  agent_artifact_state_conflict: true,
  agent_artifact_access_denied: true,
  [AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE]: true,
};

const BGSM_AGENT_SESSION_FAILURE_DETAIL_KEYS = [
  'sessionId',
  'jobId',
  'turnAttemptId',
  'artifactId',
  'expectedRevision',
  'actualRevision',
  'requiredBytes',
  'availableBytes',
  'hardLimitBytes',
] as const;

export type BgsmAgentSessionFailure = Readonly<{
  code: string;
  details?: Readonly<Record<string, string | number>>;
}>;

export function parseBgsmAgentSessionRequest(value: unknown): BgsmAgentSessionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const type = request.type;
  if (
    typeof type !== 'string'
    || BGSM_AGENT_SESSION_REQUEST_TYPES[type as BgsmAgentSessionRequest['type']] !== true
  ) return null;

  const requestType = type as BgsmAgentSessionRequest['type'];
  try {
    switch (requestType) {
      case 'inspectAgentSessionCatalog':
      case 'getOrCreateInitialAgentSession':
      case 'getAgentStorageUsage':
      case 'clearAgentToolCache':
        assertExactRequestKeys(request, ['type']);
        return { type: requestType } as BgsmAgentSessionRequest;
      case 'createAgentSession': {
        const expectedKeys = request.sessionId === undefined ? ['type'] : ['type', 'sessionId'];
        assertExactRequestKeys(request, expectedKeys);
        if (request.sessionId === undefined) return { type: requestType };
        assertAgentTurnTransportIdentifier(request.sessionId, 'Agent session ID');
        return { type: requestType, sessionId: request.sessionId };
      }
      case 'inspectActiveAgentSessionTurn':
      case 'loadAgentSession':
      case 'readAgentRetryDraftCandidate':
      case 'discardDamagedAgentSessionRecovery':
      case 'deleteAgentSession':
        assertExactRequestKeys(request, ['type', 'sessionId']);
        assertAgentTurnTransportIdentifier(request.sessionId, 'Agent session ID');
        return { type: requestType, sessionId: request.sessionId };
      case 'dismissAgentSessionRetry':
      case 'abandonAgentSessionUncertainAttempt':
        assertExactRequestKeys(request, ['type', 'sessionId', 'turnAttemptId']);
        assertAgentTurnTransportIdentifier(request.sessionId, 'Agent session ID');
        assertAgentTurnTransportIdentifier(request.turnAttemptId, 'Agent turn attempt ID');
        return {
          type: requestType,
          sessionId: request.sessionId,
          turnAttemptId: request.turnAttemptId,
        };
      case 'loadCommittedAgentSessionTurn':
        assertExactRequestKeys(request, ['type', 'sessionId', 'turnAttemptId', 'launchDigest']);
        assertAgentTurnTransportIdentifier(request.sessionId, 'Agent session ID');
        assertAgentTurnTransportIdentifier(request.turnAttemptId, 'Agent turn attempt ID');
        validateAgentSessionLaunchDigest(request.launchDigest);
        return {
          type: requestType,
          sessionId: request.sessionId,
          turnAttemptId: request.turnAttemptId,
          launchDigest: request.launchDigest,
        };
      case 'loadAgentSessionTranscriptPage':
        assertExactRequestKeys(request, ['type', 'sessionId', 'beforeSequence']);
        assertAgentTurnTransportIdentifier(request.sessionId, 'Agent session ID');
        if (!Number.isSafeInteger(request.beforeSequence) || Number(request.beforeSequence) <= 0) {
          throw new TypeError('Agent transcript cursor must be a positive safe integer.');
        }
        return {
          type: requestType,
          sessionId: request.sessionId,
          beforeSequence: Number(request.beforeSequence),
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function assertExactRequestKeys(
  request: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(request).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) throw new TypeError('Agent session request keys are invalid.');
}

/**
 * Restricts durable Agent failures to the stable, serializable details the UI
 * already understands. Provider strings and arbitrary storage error fields stay
 * at the background localization boundary.
 */
export function describeBgsmAgentSessionFailure(error: unknown): BgsmAgentSessionFailure | null {
  if (!error || typeof error !== 'object') return null;

  const value = error as Record<string, unknown>;
  if (value.name === 'QuotaExceededError') {
    return { code: 'agent_session_quota_exceeded' };
  }

  const code = value.code;
  if (typeof code !== 'string' || BGSM_AGENT_SESSION_FAILURE_CODES[code] !== true) {
    return null;
  }

  const details = Object.fromEntries(
    BGSM_AGENT_SESSION_FAILURE_DETAIL_KEYS.flatMap((key) => {
      const detail = value[key];
      return typeof detail === 'string' || typeof detail === 'number'
        ? [[key, detail] as const]
        : [];
    }),
  );
  return {
    code,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

export type BgsmAgentSessionRpcOperations = Readonly<{
  inspectCatalog(): Promise<unknown>;
  getOrCreateInitialSession(): Promise<unknown>;
  createSession(sessionId?: string): Promise<unknown>;
  loadSession(sessionId: string): Promise<unknown>;
  loadCommittedTurn(input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
    launchDigest: AgentSessionLaunchDigest;
  }>): Promise<unknown>;
  readRetryDraft(sessionId: string): Promise<unknown>;
  loadTranscriptPage(sessionId: string, beforeSequence: number): Promise<unknown>;
  deleteSession(input: Readonly<{
    sessionId: string;
    executionEpochId: string;
  }>): Promise<boolean>;
  getStorageUsage(): Promise<unknown>;
  clearToolCache(): Promise<unknown>;
}>;

export type BgsmAgentSessionRpcDependencies = Readonly<{
  executionEpochId: string;
  sessionCache?: AgentCanonicalSessionCache;
  inspectActiveTurn(sessionId: string): unknown | null;
  inspectDurableTurn(sessionId: string): Promise<unknown | null>;
  dismissRetry(input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
  }>): Promise<boolean>;
  abandonUncertainAttempt(input: Readonly<{
    sessionId: string;
    turnAttemptId: string;
  }>): Promise<boolean>;
  discardDamagedRecovery(sessionId: string): Promise<number>;
  notifySessionDeleted(sessionId: string): void;
  operations?: Partial<BgsmAgentSessionRpcOperations>;
}>;

export type BgsmAgentSessionRpcRouter = Readonly<{
  handle(request: unknown): Promise<unknown>;
  describeFailure(error: unknown): BgsmAgentSessionFailure | null;
}>;

const productionOperations: Omit<BgsmAgentSessionRpcOperations, 'deleteSession'> = Object.freeze({
  inspectCatalog: inspectAgentSessionCatalog,
  getOrCreateInitialSession: getOrCreateInitialAgentSession,
  createSession: (sessionId) => createAgentSession(
    sessionId ? { idFactory: () => sessionId } : undefined,
  ),
  loadSession: loadAgentSession,
  loadCommittedTurn: loadCommittedAgentSessionTurn,
  readRetryDraft: readAgentSessionRetryDraftCandidate,
  loadTranscriptPage: loadAgentSessionTranscriptPage,
  getStorageUsage: getAgentStorageUsage,
  clearToolCache: clearAgentToolCache,
});

/**
 * Routes only the Agent session command family. The Chrome response envelope,
 * translation, progress reset, and listener lifetime remain in index.ts.
 */
export function createBgsmAgentSessionRpcRouter(
  dependencies: BgsmAgentSessionRpcDependencies,
): BgsmAgentSessionRpcRouter {
  const operations: BgsmAgentSessionRpcOperations = {
    inspectCatalog: dependencies.operations?.inspectCatalog ?? productionOperations.inspectCatalog,
    getOrCreateInitialSession: dependencies.operations?.getOrCreateInitialSession
      ?? productionOperations.getOrCreateInitialSession,
    createSession: dependencies.operations?.createSession ?? productionOperations.createSession,
    loadSession: dependencies.operations?.loadSession ?? productionOperations.loadSession,
    loadCommittedTurn: dependencies.operations?.loadCommittedTurn
      ?? productionOperations.loadCommittedTurn,
    readRetryDraft: dependencies.operations?.readRetryDraft ?? productionOperations.readRetryDraft,
    loadTranscriptPage: dependencies.operations?.loadTranscriptPage
      ?? productionOperations.loadTranscriptPage,
    deleteSession: dependencies.operations?.deleteSession
      ?? (({ sessionId, executionEpochId }) => deleteAgentSession(sessionId, {
        executionEpochId,
        cache: dependencies.sessionCache,
      })),
    getStorageUsage: dependencies.operations?.getStorageUsage ?? productionOperations.getStorageUsage,
    clearToolCache: dependencies.operations?.clearToolCache ?? productionOperations.clearToolCache,
  };

  const handle = async (requestValue: unknown): Promise<unknown> => {
    const request = parseBgsmAgentSessionRequest(requestValue);
    if (!request) throw new TypeError('Agent session request is invalid.');
    switch (request.type) {
      case 'inspectAgentSessionCatalog':
        return operations.inspectCatalog();
      case 'getOrCreateInitialAgentSession':
        return operations.getOrCreateInitialSession();
      case 'inspectActiveAgentSessionTurn':
        return dependencies.inspectActiveTurn(request.sessionId)
          ?? dependencies.inspectDurableTurn(request.sessionId);
      case 'createAgentSession':
        return operations.createSession(request.sessionId);
      case 'loadAgentSession':
        return operations.loadSession(request.sessionId);
      case 'loadCommittedAgentSessionTurn':
        return operations.loadCommittedTurn(request);
      case 'readAgentRetryDraftCandidate':
        return operations.readRetryDraft(request.sessionId);
      case 'dismissAgentSessionRetry':
        return dependencies.dismissRetry(request);
      case 'abandonAgentSessionUncertainAttempt':
        return dependencies.abandonUncertainAttempt(request);
      case 'discardDamagedAgentSessionRecovery':
        return dependencies.discardDamagedRecovery(request.sessionId);
      case 'loadAgentSessionTranscriptPage':
        return operations.loadTranscriptPage(request.sessionId, request.beforeSequence);
      case 'deleteAgentSession': {
        const deleted = await operations.deleteSession({
          sessionId: request.sessionId,
          executionEpochId: dependencies.executionEpochId,
        });
        if (deleted) dependencies.notifySessionDeleted(request.sessionId);
        return { deleted };
      }
      case 'getAgentStorageUsage':
        return operations.getStorageUsage();
      case 'clearAgentToolCache':
        return operations.clearToolCache();
      default:
        return assertNever(request);
    }
  };

  return Object.freeze({
    handle,
    describeFailure: describeBgsmAgentSessionFailure,
  });
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported Agent session request: ${String(value)}`);
}
