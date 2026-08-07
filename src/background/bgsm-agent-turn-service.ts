import { canonicalJson } from '@/agent-harness/canonical-json';
import {
  AgentExecutionLedger,
  createAgentTurnLiveness,
  emitAgentExecutionTrace,
  publicAgentLivenessTimeoutMessage,
  resolveContextBudgetPolicy,
  type AgentContentCaptureSink,
  type AgentEvent,
  type AgentExecutionTraceSink,
  type AgentMessage,
  type AgentTool,
  type AgentTraceProviderIdentity,
} from '@/agent-harness';
import {
  BGSM_AGENT_MAX_OUTPUT_TOKENS,
  buildBgsmAgentSystemPrompt,
  buildBgsmAgentTerminalPayload,
  compactBgsmAgentCompletedToolEnvelope,
  createBgsmAgentArtifactContinuationToolRegistry,
  createBgsmAgentArtifactEvidenceHandoff,
  createBgsmAgentPromptScope,
  createBgsmAgentToolRegistry,
  createBgsmAgentToolResultExternalizer,
  createBgsmTurnAuthorization,
  createRepositoryCodeRefAuthority,
  hasSuccessfulRepositoryCodeToolHistory,
  prepareBgsmAgentTurn,
  type BgsmAgentActiveProjection,
  type BgsmAgentConversationBinding,
  type BgsmAgentOrganizeLibraryAction,
  type BgsmAgentOrganizeLibraryHandoff,
  type BgsmAgentSessionMessage,
  type BgsmAgentSessionTransition,
  type BgsmAgentTurnInput,
  type RepositoryCodeRefAuthority,
} from '@/bgsm-agent';
import type {
  BgsmAgentTurnLaunch,
  BgsmAgentTurnResult,
} from '@/bgsm-agent/turn-protocol';
import { digestAgentSessionLaunch } from '@/bgsm-agent/session-transport';
import {
  loadCanonicalAgentSession,
  loadCommittedAgentSessionTurn,
  type AgentSessionCommitResult,
  type AgentSessionTerminalOutcome,
} from '@/storage/agent-session-store';
import type { AgentCanonicalSessionCache } from '@/storage/agent-session-cache';
import type {
  AgentProviderId,
  OrganizeJobRecord,
} from '@/types';
import type {
  AgentGlobalTagDeletionWriter,
  AgentManualTagWriter,
  AgentVisibleTagRemovalWriter,
} from './agent-manual-tag-writer';
import type { AgentAttemptCoordinator } from './agent-attempt-coordinator';
import type { PreparedGatedAgentRuntimeProvider } from './agent-provider-gate';
import { createBgsmAgentArtifactStorageAdapter } from './agent-artifact-service';
import {
  BgsmAgentArtifactCoverageStalledError,
  buildBgsmAgentArtifactContinuationMessages,
  createBgsmAgentArtifactAdmissionRuntime,
  runBgsmAgentEpisodes,
  type BgsmAgentArtifactAdmissionRuntime,
} from './bgsm-agent-episode-driver';
import { resolveBgsmAgentConversation } from './bgsm-agent-conversation';

const MAX_REPOSITORY_CODE_REF_AUTHORITIES = 64;

type BgsmAgentConversationResolver = Parameters<
  typeof resolveBgsmAgentConversation
>[1]['resolveCandidate'];

export type BgsmAgentTurnRunOptions = Readonly<{
  emit?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  bind?: (binding: BgsmAgentConversationBinding) => void;
  trace?: AgentExecutionTraceSink;
  contentCapture?: AgentContentCaptureSink;
}>;

export type BgsmAgentTurnService = Readonly<{
  run(
    launch: BgsmAgentTurnLaunch,
    options: BgsmAgentTurnRunOptions,
  ): Promise<BgsmAgentTurnResult>;
}>;

export type BgsmAgentTurnServiceDependencies = Readonly<{
  attemptCoordinator: AgentAttemptCoordinator;
  sessionCache?: AgentCanonicalSessionCache;
  prepareRuntimeProvider(): Promise<PreparedGatedAgentRuntimeProvider>;
  invalidateProviderCapability(fingerprint: string): Promise<boolean>;
  resolveLiveCandidate: BgsmAgentConversationResolver;
  getActiveOrganizeJob(): Promise<OrganizeJobRecord | undefined>;
  isOrganizeApplyBlockingWrites(job: OrganizeJobRecord | undefined): boolean;
  assignManualTags: AgentManualTagWriter;
  removeVisibleTags: AgentVisibleTagRemovalWriter;
  deleteTagsEverywhere: AgentGlobalTagDeletionWriter;
  broadcastDataChanged(): void;
  providerTraceIdentity(
    provider: Readonly<{
      providerId: AgentProviderId;
      endpoint: Readonly<{ profile: Readonly<{ protocol: string }> }>;
    }>,
    modelCapabilityRevision: string,
  ): AgentTraceProviderIdentity;
}>;

/**
 * Owns one background Agent turn, including its per-attempt artifact machinery
 * and the bounded in-memory repository-code reference authority cache.
 */
export function createBgsmAgentTurnService(
  dependencies: BgsmAgentTurnServiceDependencies,
): BgsmAgentTurnService {
  const repositoryCodeRefAuthorities = new Map<string, {
    scopeFingerprint: string;
    authority: RepositoryCodeRefAuthority;
  }>();

  const repositoryCodeRefAuthorityFor = (
    sessionId: string,
    scopeFingerprint: string,
  ): RepositoryCodeRefAuthority => {
    const existing = repositoryCodeRefAuthorities.get(sessionId);
    if (existing?.scopeFingerprint === scopeFingerprint) {
      repositoryCodeRefAuthorities.delete(sessionId);
      repositoryCodeRefAuthorities.set(sessionId, existing);
      return existing.authority;
    }

    const authority = createRepositoryCodeRefAuthority();
    repositoryCodeRefAuthorities.set(sessionId, { scopeFingerprint, authority });
    while (repositoryCodeRefAuthorities.size > MAX_REPOSITORY_CODE_REF_AUTHORITIES) {
      const oldestSessionId = repositoryCodeRefAuthorities.keys().next().value as string | undefined;
      if (oldestSessionId === undefined) break;
      repositoryCodeRefAuthorities.delete(oldestSessionId);
    }
    return authority;
  };

  const run = async (
    launch: BgsmAgentTurnLaunch,
    options: BgsmAgentTurnRunOptions,
  ): Promise<BgsmAgentTurnResult> => {
    const { prompt, sessionId, baseRevision, turnAttemptId } = launch;
    const replayLaunchDigest = await digestAgentSessionLaunch(launch);
    const committed = await loadCommittedAgentSessionTurn({
      sessionId,
      turnAttemptId,
      launchDigest: replayLaunchDigest,
    });
    if (committed) return resultFromCommit(launch, committed);
    const canonicalSession = await loadCanonicalAgentSession(sessionId, dependencies.sessionCache);
    const recoveryClass = hasSuccessfulRepositoryCodeToolHistory(canonicalSession.messages)
      ? 'statically_read_only'
      : 'write_capable_or_unknown';
    const { launchDigest, admission } = await dependencies.attemptCoordinator.admit(
      launch,
      recoveryClass,
    );
    if (admission.kind === 'replay') return resultFromCommit(launch, admission.commit);
    let changed = false;
    let changedCount = 0;
    let executionLedger: AgentExecutionLedger | null = null;
    let attemptSettled = false;
    let artifactAdmissionRuntime: BgsmAgentArtifactAdmissionRuntime | null = null;
    const controller = new AbortController();
    const liveness = createAgentTurnLiveness({
      signal: controller.signal,
      onTimeout: (reason) => controller.abort(reason),
      onWatchdogState: (event) => emitAgentExecutionTrace(options.trace, {
        kind: 'watchdog_state',
        ...event,
      }),
    });
    const abortFromOptions = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abortFromOptions();
    } else {
      options.signal?.addEventListener('abort', abortFromOptions, { once: true });
    }
    try {
      const settleWithoutTransition = async (
        result: BgsmAgentTurnResult,
        coverageFailureCode?: string,
      ): Promise<BgsmAgentTurnResult> => {
        if (!attemptSettled) {
          await dependencies.attemptCoordinator.settleWithoutTransition({
            turnAttemptId,
            sessionId,
            launchDigest,
            outcome: {
              reason: result.reason,
              changed,
              changedCount,
              writeSettlement: changed
                ? 'unsafe'
                : executionLedger?.writeSettlement() ?? 'none',
              ...(result.contextFailureReason
                ? { contextFailureReason: result.contextFailureReason }
                : {}),
            },
            ...(coverageFailureCode ? { coverageFailureCode } : {}),
          });
          attemptSettled = true;
        }
        return result;
      };
      const terminalAfterAbort = (): BgsmAgentTurnResult => {
        const timeoutReason = liveness.timeoutReason;
        if (timeoutReason) {
          options.emit?.({
            type: 'agent_error',
            sessionId,
            message: publicAgentLivenessTimeoutMessage(timeoutReason),
            category: 'provider',
          });
        }
        return {
          turnAttemptId,
          sessionId,
          baseRevision,
          reason: timeoutReason ? 'provider_error' : 'aborted',
          changed: false,
          changedCount: 0,
          commit: null,
        };
      };
      if (canonicalSession.revision !== baseRevision) {
        throw new TypeError('Cubby durable session changed after turn admission.');
      }
      if (!canonicalSession.binding && !launch.candidateContract) {
        throw new TypeError('A new Cubby conversation requires a scope candidate.');
      }
      const input: BgsmAgentTurnInput = {
        turnAttemptId,
        sessionId,
        baseRevision,
        prompt,
        history: canonicalSession.messages,
        ...(canonicalSession.compaction
          ? { checkpoint: canonicalSession.compaction }
          : {}),
        ...(canonicalSession.activeProjections?.length
          ? { activeProjections: canonicalSession.activeProjections }
          : {}),
        ...(canonicalSession.binding
          ? { binding: canonicalSession.binding }
          : { candidateContract: launch.candidateContract! }),
      };
      const preparedRuntimeProvider = await dependencies.prepareRuntimeProvider();
      if (liveness.signal.aborted) return settleWithoutTransition(terminalAfterAbort());
      const conversation = await resolveBgsmAgentConversation(input, {
        providerFingerprint: preparedRuntimeProvider.fingerprint,
        resolveCandidate: dependencies.resolveLiveCandidate,
      });
      if (liveness.signal.aborted) return settleWithoutTransition(terminalAfterAbort());
      const repositoryCodeReadOnly = recoveryClass === 'statically_read_only';
      options.bind?.(conversation.binding);
      const runtimeProvider = preparedRuntimeProvider.create();
      const authorization = createBgsmTurnAuthorization({ repositoryCodeReadOnly });
      const repositoryScope = conversation.repositoryIds;
      const scopeLabel = conversation.binding.label;
      const scopeFingerprint = conversation.binding.scopeFingerprint;
      const conversationScope = createBgsmAgentPromptScope({
        kind: conversation.binding.candidateContract.kind,
        label: scopeLabel,
        repositoryIds: repositoryScope,
      });
      const ledger = new AgentExecutionLedger();
      executionLedger = ledger;
      let organizeLibraryHandoffRequested: BgsmAgentOrganizeLibraryAction | null = null;
      const repositoryCodeRefAuthority = repositoryCodeRefAuthorityFor(
        sessionId,
        scopeFingerprint,
      );
      const activeOrganizeJob = await dependencies.getActiveOrganizeJob();
      const organizeApplyActive = dependencies.isOrganizeApplyBlockingWrites(activeOrganizeJob);
      if (liveness.signal.aborted) return settleWithoutTransition(terminalAfterAbort());
      const durableAttempt = recoveryClass === 'statically_read_only'
        ? await dependencies.attemptCoordinator.inspectActive(sessionId)
        : null;
      if (
        recoveryClass === 'statically_read_only'
        && (!durableAttempt || canonicalJson(durableAttempt.launch) !== canonicalJson(launch))
      ) throw new TypeError('Cubby durable read-only attempt does not match its admitted launch.');
      const artifactStorage = createBgsmAgentArtifactStorageAdapter();
      const artifactEvidenceHandoff = createBgsmAgentArtifactEvidenceHandoff();
      artifactAdmissionRuntime = await createBgsmAgentArtifactAdmissionRuntime({
        sessionId,
        turnAttemptId,
        launchDigest,
        coordinator: dependencies.attemptCoordinator,
        initialCoverage: durableAttempt?.artifactCoverage ?? [],
        initialContinuation: durableAttempt?.artifactContinuation ?? null,
      });
      const toolRegistry = createBgsmAgentToolRegistry({
        repositoryScope,
        scopeFingerprint,
        scopeLabel,
        enableRepositoryCodeSearch: true,
        repositoryCodeRefAuthority,
        enableRepositoryNotes: true,
        enableOrganizeLibraryHandoff: !repositoryCodeReadOnly,
        enableTagWrites: !repositoryCodeReadOnly && !organizeApplyActive,
        requestOrganizeLibraryHandoff: async (action) => {
          const currentOrganizeJob = await dependencies.getActiveOrganizeJob();
          if (currentOrganizeJob) {
            return {
              status: 'blocked_by_existing_job',
              activeJobStatus: currentOrganizeJob.status,
            };
          }
          organizeLibraryHandoffRequested ??= action;
          return { status: 'accepted' };
        },
        assignManualTags: dependencies.assignManualTags,
        removeVisibleTags: dependencies.removeVisibleTags,
        deleteTagsEverywhere: dependencies.deleteTagsEverywhere,
        artifactReader: artifactStorage.artifactReader,
        artifactEvidenceHandoff,
      });
      const ordinaryTools = authorization.wrapTools([...toolRegistry.getActiveTools()]).map((tool) =>
        wrapWriteTrackingTool(tool, (count) => {
          changed = true;
          changedCount += count;
        }),
      );
      const continuationRegistry = createBgsmAgentArtifactContinuationToolRegistry({
        artifactReader: artifactStorage.artifactReader,
        artifactEvidenceHandoff,
        authorize: artifactAdmissionRuntime.authorizeContinuationRead,
      });
      const continuationTools = authorization.wrapTools([
        ...continuationRegistry.getActiveTools(),
      ]);
      const toolResultAdmissionHost = createBgsmAgentToolResultExternalizer({
        turnAttemptId,
        artifactStore: artifactStorage.artifactStore,
        artifactDisposer: artifactStorage.artifactDisposer,
        evidenceHandoff: artifactEvidenceHandoff,
        admissionAuthority: artifactAdmissionRuntime.authority,
      });

      const systemPrompt = buildBgsmAgentSystemPrompt({
        conversationScope,
        repositoryCodeReadOnly,
        activeToolNames: toolRegistry.getActiveToolNames(),
      });
      const provider = runtimeProvider.provider;
      const profile = resolveContextBudgetPolicy({
        capability: runtimeProvider.contextCapability,
        configuredWorkingWindow: runtimeProvider.workingContextWindow,
        requestedOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      });
      const traceProvider = dependencies.providerTraceIdentity(
        runtimeProvider,
        profile.capabilityRevision,
      );
      const recoveredContinuation = artifactAdmissionRuntime.snapshot().artifactContinuation;
      const prepared = recoveredContinuation
        ? {
            kind: 'ready' as const,
            messages: [...recoveredContinuation.projectedMessages],
            candidateCheckpoint: undefined,
            activeProjection: undefined,
          }
        : await prepareBgsmAgentTurn({
            turn: input,
            systemPrompt,
            provider,
            tools: ordinaryTools,
            profile,
            maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
            liveness,
            signal: liveness.signal,
            emit: options.emit,
            trace: options.trace,
            traceProvider,
            contentCapture: options.contentCapture,
          });
      if (prepared.kind === 'context_limit') {
        return settleWithoutTransition({
          turnAttemptId,
          sessionId,
          baseRevision,
          reason: 'context_limit',
          changed: false,
          changedCount: 0,
          commit: null,
          contextFailureReason: prepared.reason,
        });
      }
      if (prepared.kind === 'aborted') {
        return settleWithoutTransition(terminalAfterAbort());
      }
      let activeCheckpoint = prepared.candidateCheckpoint ?? input.checkpoint;
      let checkpointToCommit = prepared.candidateCheckpoint;
      // A projection inherited from the previous session turn is already present
      // in `prepared.messages`; only a split in this raw turn may be fed back to
      // the active-turn compactor.
      let activeTurnProjection: BgsmAgentActiveProjection | undefined;
      let candidateActiveProjection: BgsmAgentActiveProjection | null | undefined =
        prepared.candidateCheckpoint ? null : undefined;
      const initialRawMessages = recoveredContinuation
        ? [...recoveredContinuation.canonicalRawMessages]
        : [prepared.messages.at(-1)!];
      if (
        initialRawMessages[0]?.role !== 'user'
        || initialRawMessages[0].content !== input.prompt
      ) {
        throw new TypeError('Cubby Provider projection must retain the original user prompt.');
      }
      const createContinueAfterContextPressure = (
        episodeTools: readonly AgentTool[],
      ) => async (
        continuation: Readonly<{
          messages: readonly AgentMessage[];
          rawMessages?: readonly AgentMessage[];
          trigger:
            | 'completed_tool_envelope'
            | 'tool_result_memory_pressure'
            | 'context_preflight'
            | 'provider_context_overflow'
            | 'provider_request_byte_limit';
          step: number;
        }>,
      ) => {
        if (!continuation.rawMessages) {
          throw new TypeError('Cubby continuation requires an append-only raw turn transcript.');
        }
        const artifactProjectionOnly = artifactAdmissionRuntime?.nextPendingCoverage() !== null;
        let compactionRawMessages = continuation.rawMessages;
        if (artifactProjectionOnly) {
          const currentUser = continuation.rawMessages[0];
          const currentUserIndex = currentUser
            ? continuation.messages.findIndex((message) => message.id === currentUser.id)
            : -1;
          if (currentUser?.role !== 'user' || currentUserIndex < 0) {
            throw new TypeError('Artifact continuation projection lost its canonical user boundary.');
          }
          compactionRawMessages = continuation.messages.slice(currentUserIndex);
        }
        const compacted = await compactBgsmAgentCompletedToolEnvelope({
          turn: input,
          systemPrompt,
          provider,
          tools: [...episodeTools],
          profile,
          maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
          currentProjectedMessages: [...continuation.messages],
          currentCheckpoint: activeCheckpoint,
          ...(artifactProjectionOnly ? {} : { currentActiveProjection: activeTurnProjection }),
          rawMessages: compactionRawMessages,
          force: true,
          trigger: continuation.trigger,
          liveness,
          signal: liveness.signal,
          emit: options.emit,
          trace: options.trace,
          traceProvider,
          contentCapture: options.contentCapture,
          providerStep: continuation.step,
        });
        if (compacted.kind === 'ready') {
          if (
            compacted.candidateCheckpoint
            && compacted.candidateCheckpoint.summarizedMessageCount
              > (activeCheckpoint?.summarizedMessageCount ?? 0)
          ) {
            activeCheckpoint = compacted.candidateCheckpoint;
            checkpointToCommit = compacted.candidateCheckpoint;
          }
          if (compacted.activeProjection && !artifactProjectionOnly) {
            activeTurnProjection = compacted.activeProjection;
            candidateActiveProjection = compacted.activeProjection;
          }
          const pendingCoverage = artifactAdmissionRuntime?.nextPendingCoverage();
          const messages = artifactProjectionOnly && pendingCoverage
            ? buildBgsmAgentArtifactContinuationMessages(
                compacted.messages,
                systemPrompt,
                pendingCoverage,
                artifactAdmissionRuntime?.repromptWasUsed() ?? false,
              )
            : compacted.messages;
          return { kind: 'ready' as const, messages };
        }
        return compacted;
      };
      const result = await runBgsmAgentEpisodes({
        sessionId,
        systemPrompt,
        provider,
        ordinaryTools,
        continuationTools,
        admissionHost: toolResultAdmissionHost,
        admissionRuntime: artifactAdmissionRuntime,
        createContextContinuation: createContinueAfterContextPressure,
        messages: prepared.messages,
        rawMessages: initialRawMessages,
        emit: options.emit,
        liveness,
        signal: liveness.signal,
        permissions: authorization.permissions,
        maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
        contextPolicy: profile,
        executionLedger: ledger,
        trace: options.trace,
        traceProvider,
        contentCapture: options.contentCapture,
      });

      if (changed) dependencies.broadcastDataChanged();
      if (artifactAdmissionRuntime.snapshot().artifactCoverage.some((record) => record.state !== 'complete')) {
        return settleWithoutTransition({
          turnAttemptId,
          sessionId,
          baseRevision,
          reason: result.reason,
          changed,
          changedCount,
          commit: null,
          ...(result.contextFailureReason
            ? { contextFailureReason: result.contextFailureReason }
            : {}),
        }, result.reason);
      }

      const organizeLibraryHandoff = organizeLibraryHandoffRequested && result.reason !== 'aborted'
        ? Object.freeze({
            type: 'organize_whole_library' as const,
            action: organizeLibraryHandoffRequested,
            instruction: prompt,
          })
        : undefined;
      const effectiveReason = organizeLibraryHandoff ? 'final_answer' : result.reason;
      const contextFailureReason = organizeLibraryHandoff
        ? undefined
        : result.contextFailureReason;
      if (
        contextFailureReason === 'provider_context_overflow'
        || contextFailureReason === 'provider_context_overflow_repeated'
      ) {
        await dependencies.invalidateProviderCapability(preparedRuntimeProvider.fingerprint);
      }
      const effectiveInput = activeCheckpoint
        ? { ...input, checkpoint: activeCheckpoint }
        : input;
      const terminalPayload = buildBgsmAgentTerminalPayload(
        { ...result, reason: effectiveReason },
        effectiveInput,
        checkpointToCommit,
        candidateActiveProjection,
      );
      const transition: BgsmAgentSessionTransition = {
        sessionId,
        baseRevision,
        messageDelta: terminalPayload.newMessages,
        ...(checkpointToCommit ? { candidateCheckpoint: checkpointToCommit } : {}),
        ...(candidateActiveProjection === undefined
          ? {}
          : { candidateActiveProjection }),
        binding: conversation.binding,
      };
      const handoffAnchor = organizeLibraryHandoff
        ? selectHandoffAnchor(terminalPayload.newMessages)
        : undefined;
      const outcome: AgentSessionTerminalOutcome = {
        reason: effectiveReason,
        changed,
        changedCount,
        writeSettlement: changed ? 'unsafe' : ledger.writeSettlement(),
        ...(contextFailureReason ? { contextFailureReason } : {}),
        ...(organizeLibraryHandoff
          ? {
              organizeLibraryAction: organizeLibraryHandoff.action,
              handoffAnchor,
            }
          : {}),
      };
      const commit = await dependencies.attemptCoordinator.commit({
        turnAttemptId,
        transition,
        launchDigest,
        outcome,
      });
      attemptSettled = true;
      return resultFromCommit(
        launch,
        commit,
        organizeLibraryHandoff,
      );
    } catch (error) {
      if (!attemptSettled) {
        await dependencies.attemptCoordinator.settleWithoutTransition({
          turnAttemptId,
          sessionId,
          launchDigest,
          outcome: {
            reason: 'provider_error',
            changed,
            changedCount,
            writeSettlement: changed
              ? 'unsafe'
              : executionLedger?.writeSettlement() ?? 'none',
          },
          ...(error instanceof BgsmAgentArtifactCoverageStalledError
            ? { coverageFailureCode: error.code }
            : {}),
        });
        attemptSettled = true;
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abortFromOptions);
      liveness.dispose();
    }
  };

  return Object.freeze({ run });
}

function resultFromCommit(
  launch: BgsmAgentTurnLaunch,
  commit: AgentSessionCommitResult,
  handoff?: BgsmAgentOrganizeLibraryHandoff,
): BgsmAgentTurnResult {
  const outcome = commit.outcome;
  const organizeLibraryHandoff = outcome.organizeLibraryAction
    ? handoff ?? {
        type: 'organize_whole_library' as const,
        action: outcome.organizeLibraryAction,
        instruction: launch.prompt,
      }
    : undefined;
  return {
    turnAttemptId: launch.turnAttemptId,
    sessionId: launch.sessionId,
    baseRevision: launch.baseRevision,
    reason: outcome.reason,
    changed: outcome.changed,
    changedCount: outcome.changedCount,
    commit,
    ...(outcome.contextFailureReason
      ? { contextFailureReason: outcome.contextFailureReason }
      : {}),
    ...(organizeLibraryHandoff ? { organizeLibraryHandoff } : {}),
  };
}

function selectHandoffAnchor(
  messages: readonly BgsmAgentSessionMessage[],
): AgentSessionTerminalOutcome['handoffAnchor'] {
  const assistant = [...messages]
    .reverse()
    .find((message) => message.role === 'agent' && message.content.trim().length > 0);
  return {
    messageId: assistant?.id ?? null,
    createdAt: assistant?.createdAt ?? Date.now(),
  };
}

function wrapWriteTrackingTool(
  tool: AgentTool,
  markChanged: (count: number) => void,
): AgentTool {
  if (tool.risk !== 'write') return tool;
  return {
    ...tool,
    async execute(args, context) {
      const result = await tool.execute(args, context);
      const changedCount = toolResultChangedCount(result);
      if (changedCount > 0) markChanged(changedCount);
      return result;
    },
  };
}

function toolResultChangedCount(result: unknown): number {
  if (!result || typeof result !== 'object') return 1;
  const value = result as {
    changed?: unknown;
    removed?: unknown;
    assignmentsRemoved?: unknown;
    requestedTags?: unknown;
  };
  if (typeof value.changed === 'number') return Math.max(0, value.changed);
  if (typeof value.assignmentsRemoved === 'number') {
    const requestedTags = typeof value.requestedTags === 'number'
      ? value.requestedTags
      : 0;
    return Math.max(0, value.assignmentsRemoved, requestedTags);
  }
  if (typeof value.changed === 'boolean') return value.changed ? 1 : 0;
  if (typeof value.removed === 'boolean') return value.removed ? 1 : 0;
  if (typeof value.removed === 'number') return Math.max(0, value.removed);
  return 1;
}
