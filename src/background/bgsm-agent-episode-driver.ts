import { canonicalJson } from '@/agent-harness/canonical-json';
import {
  runAgentLoop,
  type AgentContextContinuation,
  type AgentContextFailureReason,
  type AgentEvent,
  type AgentExecutionLedger,
  type AgentExecutionTraceSink,
  type AgentContentCaptureSink,
  type AgentMessage,
  type AgentRequiredBeforeFinalDirective,
  type AgentTerminalLoopResult,
  type AgentTool,
  type AgentToolResultAdmissionHost,
  type AgentTraceProviderIdentity,
  type AgentTurnLiveness,
  type ContextBudgetPolicy,
  type ModelProvider,
  type PermissionEvaluator,
} from '@/agent-harness';
import {
  AgentArtifactCoverageError,
  agentArtifactCoverageDirectives,
  applyAgentArtifactCoverageEvidence,
  createAgentArtifactCoverage,
  validateAgentArtifactContinuationCheckpoint,
  verifyAgentArtifactCoverageRecord,
  type AgentArtifactContinuationCheckpoint,
  type AgentArtifactCoverageRecord,
} from '@/bgsm-agent/artifact-coverage';
import type {
  BgsmAgentArtifactAdmissionAuthority,
  BgsmAgentArtifactReadAuthorization,
} from '@/bgsm-agent/tool-result-externalizer';
import type { BgsmAgentSessionMessage } from '@/bgsm-agent/session';
import type { AgentSessionLaunchDigest } from '@/bgsm-agent/session-transport';
import { AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE } from '@/bgsm-agent/turn-protocol';
import type {
  AgentArtifactCoverageCheckpointProposal,
  AgentArtifactEnvelopeCheckpointResult,
} from '@/storage/agent-session-store';
import type { AgentAttemptCoordinator } from './agent-attempt-coordinator';

const COVERAGE_TOKEN = Symbol('bgsm-agent-artifact-coverage-token');
const CONTINUATION_EPISODE_STEPS = 8;

export const BGSM_AGENT_ARTIFACT_CONTINUATION_PREAMBLE =
  'Host-required exhaustive artifact coverage is pending.';

export type BgsmAgentArtifactAdmissionSnapshot = Readonly<{
  artifactCoverage: readonly AgentArtifactCoverageRecord[];
  artifactContinuation: AgentArtifactContinuationCheckpoint | null;
}>;

export type BgsmAgentArtifactAdmissionRuntime = Readonly<{
  authority: BgsmAgentArtifactAdmissionAuthority;
  authorizeContinuationRead: BgsmAgentArtifactReadAuthorization;
  snapshot(): BgsmAgentArtifactAdmissionSnapshot;
  requiredBeforeFinal(): readonly AgentRequiredBeforeFinalDirective[];
  repromptWasUsed(): boolean;
  nextPendingCoverage(): AgentArtifactCoverageRecord | null;
  checkpointProjection(input: Readonly<{
    projectedMessages: readonly AgentMessage[];
    canonicalRawMessages: readonly AgentMessage[];
    directives: readonly AgentRequiredBeforeFinalDirective[];
  }>): Promise<AgentArtifactContinuationCheckpoint | null>;
  markRepromptUsed(input: Readonly<{
    projectedMessages: readonly AgentMessage[];
    canonicalRawMessages: readonly AgentMessage[];
    directives: readonly AgentRequiredBeforeFinalDirective[];
  }>): Promise<AgentArtifactContinuationCheckpoint>;
}>;

type CoverageAdmissionToken = Readonly<{
  [COVERAGE_TOKEN]: true;
  proposals: readonly AgentArtifactCoverageCheckpointProposal[];
}>;

export async function createBgsmAgentArtifactAdmissionRuntime(input: Readonly<{
  sessionId: string;
  turnAttemptId: string;
  launchDigest: AgentSessionLaunchDigest;
  coordinator: Pick<
    AgentAttemptCoordinator,
    'checkpointArtifactEnvelope' | 'markArtifactRepromptUsed'
  >;
  initialCoverage?: readonly AgentArtifactCoverageRecord[];
  initialContinuation?: AgentArtifactContinuationCheckpoint | null;
  now?: () => number;
}>): Promise<BgsmAgentArtifactAdmissionRuntime> {
  const now = input.now ?? Date.now;
  let artifactCoverage = [...(input.initialCoverage ?? [])];
  let artifactContinuation = input.initialContinuation ?? null;
  await Promise.all(artifactCoverage.map(verifyAgentArtifactCoverageRecord));
  validateContinuationAgainstCoverage(artifactCoverage, artifactContinuation);

  const issuedTokens = new Set<CoverageAdmissionToken>();
  const knownRecords = new Map<string, AgentArtifactCoverageRecord>();
  rememberCoverage(artifactCoverage);

  const checkpoint = async (
    proposals: readonly AgentArtifactCoverageCheckpointProposal[],
    projectedMessages: readonly AgentMessage[],
    canonicalRawMessages: readonly AgentMessage[],
    directives: readonly AgentRequiredBeforeFinalDirective[],
    nonProgressRepromptUsed: boolean,
  ): Promise<AgentArtifactEnvelopeCheckpointResult> => {
    const continuation = directives.length === 0
      ? null
      : continuationCheckpoint({
          projectedMessages,
          canonicalRawMessages,
          directives,
          nonProgressRepromptUsed,
          updatedAt: now(),
        });
    const result = await input.coordinator.checkpointArtifactEnvelope({
      sessionId: input.sessionId,
      turnAttemptId: input.turnAttemptId,
      launchDigest: input.launchDigest,
      proposals,
      continuation,
    });
    artifactCoverage = [...result.artifactCoverage];
    artifactContinuation = result.artifactContinuation;
    knownRecords.clear();
    rememberCoverage(artifactCoverage);
    return result;
  };

  const issue = (
    proposals: readonly AgentArtifactCoverageCheckpointProposal[],
    resultingCoverage: readonly AgentArtifactCoverageRecord[],
  ): CoverageAdmissionToken => {
    const token: CoverageAdmissionToken = Object.freeze({
      [COVERAGE_TOKEN]: true,
      proposals: [...proposals],
    });
    issuedTokens.add(token);
    rememberCoverage(resultingCoverage);
    return token;
  };

  const authority: BgsmAgentArtifactAdmissionAuthority = Object.freeze({
    async startCoverage(startInput) {
      assertAttemptIdentity(startInput.sessionId, startInput.turnAttemptId);
      const base = coverageForDirectives(startInput.requiredBeforeFinal);
      const record = await createAgentArtifactCoverage({
        artifactId: startInput.artifact.artifactId,
        sourceToolCallId: startInput.sourceToolCallId,
        expectedBytes: startInput.artifact.byteLength,
        artifactSha256: startInput.artifact.artifactSha256,
        integrityManifestSha256: startInput.artifact.integrityManifestSha256,
      });
      if (base.some((candidate) => candidate.coverageId === record.coverageId)) {
        throw new AgentArtifactCoverageError('Artifact coverage source was already admitted.');
      }
      const resultingCoverage = [...base, record];
      const token = issue([{ kind: 'start', record }], resultingCoverage);
      return {
        requiredBeforeFinal: agentArtifactCoverageDirectives(resultingCoverage),
        admissionToken: token,
      };
    },
    async admitInspection(inspectionInput) {
      assertAttemptIdentity(inspectionInput.sessionId, inspectionInput.turnAttemptId);
      if (
        inspectionInput.artifactId !== inspectionInput.evidence.artifactId
        || inspectionInput.accessKind !== inspectionInput.evidence.readKind
      ) throw new AgentArtifactCoverageError('Artifact inspection evidence identity is inconsistent.');

      const base = coverageForDirectives(inspectionInput.requiredBeforeFinal);
      let proposals: AgentArtifactCoverageCheckpointProposal[];
      let resultingCoverage: AgentArtifactCoverageRecord[];
      const pending = base.find((record) => record.state === 'pending');
      if (pending) {
        if (pending.artifactId !== inspectionInput.artifactId) {
          throw new AgentArtifactCoverageError('Artifact continuation targeted the wrong obligation.');
        }
        const applied = await applyAgentArtifactCoverageEvidence(
          pending,
          inspectionInput.evidence,
        );
        proposals = [{
          kind: 'evidence',
          coverageId: pending.coverageId,
          evidence: inspectionInput.evidence,
        }];
        resultingCoverage = base.map((record) => (
          record.coverageId === pending.coverageId ? applied.record : record
        ));
      } else {
        const record = await createAgentArtifactCoverage({
          artifactId: inspectionInput.artifactId,
          sourceToolCallId: inspectionInput.sourceToolCallId,
          expectedBytes: inspectionInput.evidence.artifactBytes,
          artifactSha256: inspectionInput.evidence.artifactSha256,
          integrityManifestSha256: inspectionInput.evidence.integrityManifestSha256,
        });
        const applied = await applyAgentArtifactCoverageEvidence(
          record,
          inspectionInput.evidence,
        );
        proposals = [
          { kind: 'start', record },
          {
            kind: 'evidence',
            coverageId: record.coverageId,
            evidence: inspectionInput.evidence,
          },
        ];
        resultingCoverage = [...base, applied.record];
      }
      const token = issue(proposals, resultingCoverage);
      return {
        requiredBeforeFinal: agentArtifactCoverageDirectives(resultingCoverage),
        admissionToken: token,
      };
    },
    async admitEnvelope(envelopeInput) {
      const tokens = envelopeInput.admissionTokens.map(requireIssuedToken);
      if (new Set(tokens).size !== tokens.length) {
        issuedTokens.clear();
        throw new AgentArtifactCoverageError('Artifact coverage admission token was repeated.');
      }
      const proposals = tokens.flatMap((token) => token.proposals);
      try {
        await checkpoint(
          proposals,
          envelopeInput.projectedMessages,
          envelopeInput.canonicalRawMessages,
          envelopeInput.requiredBeforeFinal,
          artifactContinuation?.nonProgressRepromptUsed ?? false,
        );
      } finally {
        issuedTokens.clear();
      }
    },
  });

  const runtime: BgsmAgentArtifactAdmissionRuntime = Object.freeze({
    authority,
    authorizeContinuationRead(readInput) {
      if (readInput.sessionId !== input.sessionId) return false;
      const pending = artifactCoverage.find((record) => record.state === 'pending');
      if (!pending || readInput.arguments.artifactId !== pending.artifactId) return false;
      const argumentKeys = Object.keys(readInput.arguments).sort();
      if (pending.bytesDelivered === 0) {
        return argumentKeys.length === 1 && argumentKeys[0] === 'artifactId';
      }
      return pending.expectedCursor !== null
        && argumentKeys.length === 2
        && argumentKeys[0] === 'artifactId'
        && argumentKeys[1] === 'cursor'
        && readInput.arguments.cursor === pending.expectedCursor;
    },
    snapshot() {
      return {
        artifactCoverage: [...artifactCoverage],
        artifactContinuation: artifactContinuation
          ? cloneContinuation(artifactContinuation)
          : null,
      };
    },
    requiredBeforeFinal() {
      return artifactContinuation ? [...artifactContinuation.directives] : [];
    },
    repromptWasUsed() {
      return artifactContinuation?.nonProgressRepromptUsed ?? false;
    },
    nextPendingCoverage() {
      return artifactCoverage.find((record) => record.state === 'pending') ?? null;
    },
    async checkpointProjection(projectionInput) {
      const result = await checkpoint(
        [],
        projectionInput.projectedMessages,
        projectionInput.canonicalRawMessages,
        projectionInput.directives,
        artifactContinuation?.nonProgressRepromptUsed ?? false,
      );
      return result.artifactContinuation;
    },
    async markRepromptUsed(repromptInput) {
      if (!artifactContinuation || artifactContinuation.nonProgressRepromptUsed) {
        throw new AgentArtifactCoverageError('Artifact continuation re-prompt was already consumed.');
      }
      const continuation = continuationCheckpoint({
        projectedMessages: repromptInput.projectedMessages,
        canonicalRawMessages: repromptInput.canonicalRawMessages,
        directives: repromptInput.directives,
        nonProgressRepromptUsed: true,
        updatedAt: now(),
      });
      const persisted = await input.coordinator.markArtifactRepromptUsed({
        sessionId: input.sessionId,
        turnAttemptId: input.turnAttemptId,
        launchDigest: input.launchDigest,
        continuation,
      });
      artifactContinuation = persisted;
      return cloneContinuation(persisted);
    },
  });

  return runtime;

  function assertAttemptIdentity(sessionId: string, turnAttemptId: string): void {
    if (sessionId !== input.sessionId || turnAttemptId !== input.turnAttemptId) {
      throw new AgentArtifactCoverageError('Artifact admission targeted a different attempt.');
    }
  }

  function rememberCoverage(records: readonly AgentArtifactCoverageRecord[]): void {
    for (const record of records) {
      knownRecords.set(`${record.coverageId}\u0000${record.progressToken}`, record);
    }
  }

  function coverageForDirectives(
    directives: readonly AgentRequiredBeforeFinalDirective[],
  ): AgentArtifactCoverageRecord[] {
    const selected = new Map<string, AgentArtifactCoverageRecord>();
    for (const directive of directives) {
      const record = knownRecords.get(`${directive.reference}\u0000${directive.progressToken}`);
      if (!record || record.state !== 'pending') {
        throw new AgentArtifactCoverageError('Required artifact directive is not known to this attempt.');
      }
      selected.set(record.coverageId, record);
    }
    const result = artifactCoverage.map((record) => selected.get(record.coverageId) ?? record);
    for (const directive of directives) {
      const record = selected.get(directive.reference)!;
      if (!result.some((candidate) => candidate.coverageId === record.coverageId)) result.push(record);
    }
    const expected = agentArtifactCoverageDirectives(result);
    if (canonicalJson(expected) !== canonicalJson([...directives])) {
      throw new AgentArtifactCoverageError('Required artifact directives do not match admission state.');
    }
    return result;
  }

  function requireIssuedToken(value: unknown): CoverageAdmissionToken {
    if (!value || typeof value !== 'object' || !issuedTokens.has(value as CoverageAdmissionToken)) {
      throw new AgentArtifactCoverageError('Artifact coverage admission token is invalid or stale.');
    }
    return value as CoverageAdmissionToken;
  }
}

export type RunBgsmAgentEpisodesInput = Readonly<{
  sessionId: string;
  systemPrompt: string;
  messages: readonly AgentMessage[];
  rawMessages: readonly AgentMessage[];
  provider: ModelProvider;
  ordinaryTools: readonly AgentTool[];
  continuationTools: readonly AgentTool[];
  admissionHost: AgentToolResultAdmissionHost;
  admissionRuntime: BgsmAgentArtifactAdmissionRuntime;
  createContextContinuation: (tools: readonly AgentTool[]) => AgentContextContinuation;
  emit?: (event: AgentEvent) => void;
  liveness?: AgentTurnLiveness;
  signal?: AbortSignal;
  permissions?: PermissionEvaluator;
  maxOutputTokens?: number;
  contextPolicy?: ContextBudgetPolicy;
  executionLedger?: AgentExecutionLedger;
  trace?: AgentExecutionTraceSink;
  traceProvider?: AgentTraceProviderIdentity;
  contentCapture?: AgentContentCaptureSink;
  idFactory?: () => string;
  now?: () => number;
}>;

/** Runs bounded generic-loop episodes until one logical BGSM turn is terminal. */
export async function runBgsmAgentEpisodes(
  input: RunBgsmAgentEpisodesInput,
): Promise<AgentTerminalLoopResult> {
  let projectedMessages = [...input.messages];
  let canonicalRawMessages = [...input.rawMessages];
  let directives = [...input.admissionRuntime.requiredBeforeFinal()];
  let emittedStart = false;
  let emittedDone = false;
  const emit = (event: AgentEvent) => {
    if (event.type === 'agent_start') {
      if (emittedStart) return;
      emittedStart = true;
    }
    if (event.type === 'agent_done') {
      if (emittedDone) return;
      emittedDone = true;
    }
    input.emit?.(event);
  };

  while (true) {
    const pending = input.admissionRuntime.nextPendingCoverage();
    if ((pending === null) !== (directives.length === 0)) {
      throw new AgentArtifactCoverageError('Artifact continuation directives lost durable coverage state.');
    }
    const continuationMode = pending !== null;
    const tools = continuationMode ? input.continuationTools : input.ordinaryTools;
    const episodeMessages = continuationMode
      ? buildBgsmAgentArtifactContinuationMessages(
          projectedMessages,
          input.systemPrompt,
          pending,
          input.admissionRuntime.repromptWasUsed(),
        )
      : withSystemPrompt(projectedMessages, input.systemPrompt);
    const contextContinuation = input.createContextContinuation(tools);
    const result = await runAgentLoop({
      sessionId: input.sessionId,
      provider: input.provider,
      tools: [...tools],
      messages: episodeMessages,
      rawMessages: canonicalRawMessages,
      requiredBeforeFinal: directives,
      toolResultAdmissionHost: input.admissionHost,
      onToolEnvelopeSettled: contextContinuation,
      onContextOverflow: contextContinuation,
      maxSteps: CONTINUATION_EPISODE_STEPS,
      emit,
      ...(input.liveness ? { liveness: input.liveness } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      ...(input.contextPolicy ? { contextPolicy: input.contextPolicy } : {}),
      ...(input.executionLedger ? { executionLedger: input.executionLedger } : {}),
      ...(input.trace ? { trace: input.trace } : {}),
      ...(input.traceProvider ? { traceProvider: input.traceProvider } : {}),
      ...(input.contentCapture ? { contentCapture: input.contentCapture } : {}),
      ...(input.idFactory ? { idFactory: input.idFactory } : {}),
      ...(input.now ? { now: input.now } : {}),
    });

    if (!result.continuation) {
      if (
        result.reason === 'final_answer'
        && input.admissionRuntime.snapshot().artifactCoverage.some((record) => record.state !== 'complete')
      ) throw new AgentArtifactCoverageError('Final answer bypassed required artifact coverage.');
      return result;
    }

    projectedMessages = [...result.continuation.projectedMessages];
    canonicalRawMessages = [...result.continuation.canonicalRawMessages];
    directives = [...result.continuation.requiredBeforeFinal];

    if (result.continuation.cause === 'no_progress') {
      if (input.admissionRuntime.repromptWasUsed()) {
        throw new BgsmAgentArtifactCoverageStalledError();
      }
      const persisted = await input.admissionRuntime.markRepromptUsed({
        projectedMessages,
        canonicalRawMessages,
        directives,
      });
      directives = [...persisted.directives];
      continue;
    }

    const pendingAfterBoundary = input.admissionRuntime.nextPendingCoverage();
    if (
      directives.length === 0
      || !continuationMode
      || pendingAfterBoundary?.coverageId !== pending?.coverageId
    ) continue;
    const reduced = await contextContinuation({
      messages: projectedMessages,
      rawMessages: canonicalRawMessages,
      step: CONTINUATION_EPISODE_STEPS - 1,
      trigger: 'completed_tool_envelope',
    });
    if (reduced.kind === 'ready') {
      projectedMessages = [...reduced.messages];
      const persisted = await input.admissionRuntime.checkpointProjection({
        projectedMessages,
        canonicalRawMessages,
        directives,
      });
      if (!persisted) {
        throw new AgentArtifactCoverageError('Artifact continuation checkpoint cleared before coverage completed.');
      }
      directives = [...persisted.directives];
      continue;
    }
    const reason: AgentContextFailureReason = reduced.kind === 'context_limit'
      ? reduced.reason ?? 'final_preflight_failed'
      : 'final_preflight_failed';
    const terminalReason = reduced.kind === 'aborted' ? 'aborted' as const : 'context_limit' as const;
    emit({
      type: 'agent_done',
      sessionId: input.sessionId,
      reason: terminalReason,
      ...(terminalReason === 'context_limit' ? { contextFailureReason: reason } : {}),
    });
    return {
      sessionId: input.sessionId,
      messages: projectedMessages,
      rawMessages: canonicalRawMessages,
      reason: terminalReason,
      ...(terminalReason === 'context_limit' ? { contextFailureReason: reason } : {}),
    };
  }
}

export class BgsmAgentArtifactCoverageStalledError extends Error {
  readonly code = AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE;

  constructor() {
    super(AGENT_ARTIFACT_COVERAGE_STALLED_ERROR_CODE);
    this.name = 'BgsmAgentArtifactCoverageStalledError';
  }
}

export function buildBgsmAgentArtifactContinuationMessages(
  messages: readonly AgentMessage[],
  systemPrompt: string,
  coverage: AgentArtifactCoverageRecord,
  reprompt: boolean,
): AgentMessage[] {
  const argumentsJson = coverage.bytesDelivered === 0
    ? JSON.stringify({ artifactId: coverage.artifactId })
    : JSON.stringify({ artifactId: coverage.artifactId, cursor: coverage.expectedCursor });
  const instruction = [
    BGSM_AGENT_ARTIFACT_CONTINUATION_PREAMBLE,
    reprompt
      ? 'The previous response made no coverage progress; this is the only constrained re-prompt.'
      : 'Continue the exact durable cursor chain now.',
    `Call read_agent_artifact exactly once with these exact arguments: ${argumentsJson}`,
    'Within this episode, each newer host-returned non-null nextCursor supersedes the cursor printed above and must be reused exactly.',
    'Do not add prose, sibling tool calls, byteOffset, search, or a guessed cursor.',
    'After the tool returns nextCursor null, the host will permit one final answer.',
  ].join('\n');
  return withSystemPrompt(messages, `${systemPrompt}\n\n${instruction}`);
}

function withSystemPrompt(messages: readonly AgentMessage[], content: string): AgentMessage[] {
  const projected = messages.map((message) => ({ ...message }));
  if (projected[0]?.role !== 'system') {
    throw new AgentArtifactCoverageError('Artifact continuation projection lost its leading system message.');
  }
  projected[0] = { ...projected[0], content };
  return projected;
}

function continuationCheckpoint(input: Readonly<{
  projectedMessages: readonly AgentMessage[];
  canonicalRawMessages: readonly AgentMessage[];
  directives: readonly AgentRequiredBeforeFinalDirective[];
  nonProgressRepromptUsed: boolean;
  updatedAt: number;
}>): AgentArtifactContinuationCheckpoint {
  const canonicalRawMessages = input.canonicalRawMessages.map((message) => {
    if (message.role === 'system') {
      throw new AgentArtifactCoverageError('Canonical artifact continuation cannot contain a system message.');
    }
    return { ...message } as BgsmAgentSessionMessage;
  });
  const checkpoint: AgentArtifactContinuationCheckpoint = {
    schemaVersion: 1,
    projectedMessages: input.projectedMessages.map((message) => ({ ...message })),
    canonicalRawMessages,
    directives: [...input.directives],
    nonProgressRepromptUsed: input.nonProgressRepromptUsed,
    updatedAt: input.updatedAt,
  };
  validateAgentArtifactContinuationCheckpoint(checkpoint);
  return checkpoint;
}

function validateContinuationAgainstCoverage(
  coverage: readonly AgentArtifactCoverageRecord[],
  continuation: AgentArtifactContinuationCheckpoint | null,
): void {
  const directives = agentArtifactCoverageDirectives(coverage);
  if (directives.length === 0) {
    if (continuation !== null) {
      throw new AgentArtifactCoverageError('Artifact continuation exists without pending coverage.');
    }
    return;
  }
  if (!continuation) {
    throw new AgentArtifactCoverageError('Pending artifact coverage lacks a continuation checkpoint.');
  }
  validateAgentArtifactContinuationCheckpoint(continuation);
  if (canonicalJson(directives) !== canonicalJson(continuation.directives)) {
    throw new AgentArtifactCoverageError('Artifact continuation directives do not match coverage.');
  }
}

function cloneContinuation(
  checkpoint: AgentArtifactContinuationCheckpoint,
): AgentArtifactContinuationCheckpoint {
  return {
    ...checkpoint,
    projectedMessages: checkpoint.projectedMessages.map((message) => ({ ...message })),
    canonicalRawMessages: checkpoint.canonicalRawMessages.map((message) => ({ ...message })),
    directives: checkpoint.directives.map((directive) => ({ ...directive })),
  };
}
