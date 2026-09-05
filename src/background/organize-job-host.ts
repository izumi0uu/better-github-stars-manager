import type { AgentExecutionTraceEvent } from '@/agent-harness';
import type { ModelProvider } from '@/agent-harness/provider';
import type { GatedAgentRuntimeProvider } from './agent-provider-gate';
import type { SerializedRunner } from './serialized-runner';
import {
  agentTraceProviderIdentity,
  organizeAnalysisProviderBinding,
} from './agent-trace-identity';
import {
  buildRestoredOrganizeAnalysisState,
  organizeOutcomesForPage,
  sameOrganizeAnalysisRanges,
} from './organize-analysis-projection';
import { createOrganizeAnalysisRecovery } from './organize-analysis-recovery';
import {
  createBgsmOrganizeJobScheduler,
  type BgsmOrganizeJobScheduler,
} from './organize-analysis-runner';
import {
  createOrganizeApplyPump,
  type OrganizeApplyPumpLifecycleEvent,
} from './organize-apply-pump';
import { createOrganizeApplyRecovery } from './organize-apply-recovery';
import {
  createBgsmAgentController,
  type OrganizeRunIdentity,
} from './organize-job-controller';
import {
  createBgsmOrganizeJobConnectionRegistry,
  type BgsmOrganizeJobConnection,
} from './organize-job-port';
import {
  canReplaceBlockedDurableRun,
  resolveBgsmOrganizeControlRole,
  resolveBgsmOrganizeJobReconnect,
} from './organize-job-port-lifecycle';
import { createBgsmOrganizeJobTraceCoordinator } from './organize-job-trace';
import {
  OrganizeControlFailure,
  boundOrganizeJobRunError,
  classifyOrganizeJobRunError,
  classifyOrganizeRestoreFailure,
  durableOrganizePageIdentity,
  durableOrganizeRunIdentity,
  ephemeralOrganizeRunIdentity,
  isTerminalOrganizeJob,
  organizePageAddress,
  readdressOrganizeSnapshot,
  type OrganizePageIdentity,
} from './organize-run-identity';
import {
  buildOrganizeJobPresentation,
  loadFrozenOrganizeTaxonomy,
  loadOrganizeJobRunRepositoryRecords,
  loadOrganizeJobRunTaxonomy,
} from './organize-store-reads';
import { resolveLaunchCandidate } from './query';
import { canonicalJson } from '@/agent-harness/canonical-json';
import {
  createDevOrganizeJobRunTraceFactory,
  reconcileDevOrganizeJobRunProvisionalRoots,
} from '@/agent-observability/organize-job-trace';
import { authStore } from '@/auth/auth-store';
import { type OrganizeJobRunSnapshot } from '@/bgsm-agent';
import {
  issueContinuationCursor,
  resolveContinuationCursor,
} from '@/bgsm-agent/continuation-cursor';
import {
  createOrganizeJobId,
  parseControllerId,
  parseOrganizeJobId,
  parseProposalId,
  parseRunId,
  type OrganizeJobId,
} from '@/bgsm-agent/identity';
import { OrganizeProposalAnalyzer } from '@/bgsm-agent/organize-proposal-analyzer';
import { loadFrozenScopePage } from '@/bgsm-agent/organize-scope-reader';
import {
  createEmptyRunBudgetUsage,
  createOrganizeTagPolicySnapshot,
  createProductionRunBudget,
  type RunBudgetUsage,
} from '@/bgsm-agent/policy';
import {
  createFrozenScopeCursor,
  parsePreflightToken,
} from '@/bgsm-agent/scope';
import { DEV } from '@/dev';
import { db } from '@/storage/db';
import {
  activateOrganizePreflight,
  advanceOrganizeJobRun,
  bindOrganizeJobProvider,
  cancelOrganizeJob,
  cancelOrganizePreflight,
  checkpointOrganizeAnalysisPage,
  claimOrganizeApplyChunk,
  completeOrganizeJobWithoutApply,
  createOrganizeJob,
  createOrganizePreflight,
  dismissTerminalOrganizeJob,
  getActiveOrganizeJob,
  getLatestOrganizeJob,
  getOrganizeApplyProgress,
  getOrganizeJob,
  getOrganizeJobForRun,
  getOrganizePreflightByToken,
  getOrganizeReceiptPageAtOffset,
  getOrganizeReviewPageAtOffset,
  getOrganizeSelectionSummary,
  getReadyOrganizePreflight,
  recoverExpiredOrganizeLeases,
  releaseOrganizeAnalysisPage,
  releaseOrganizeJobLeases,
  requestOrganizeApplyPause,
  reserveOrganizeAnalysisPage,
  reserveOrganizeAnalysisProviderAttempt,
  restoreOrganizeAnalysisCheckpoint,
  resumeOrganizeApply,
  retryOrganizeAnalysisFromFirstFailure,
  sealOrganizeApply,
  setAllOrganizeSelections,
  settleOrganizeApplyChunk,
  splitOrganizeAnalysisPage,
  takeControlOrganizeJob,
  updateOrganizeSelection,
  type OrganizeSelectionSummary,
} from '@/storage/organize-job-store';
import { type OrganizeJobRecord } from '@/types';
import {
  validateBgsmOrganizeJobMessageIdentity,
  type BgsmOrganizeJobClientMessage,
  type BgsmOrganizeJobDeliveryKind,
  type BgsmOrganizeJobErrorReason,
  type BgsmOrganizeJobPresentation,
  type BgsmOrganizeJobServerMessage,
  type BgsmOrganizeReceiptRow,
} from '@/utils/messaging';

/**
 * Durable Organize job host: connection registry, trace coordinator, analysis
 * scheduler, apply pump, port protocol, and the publication helpers that address
 * a reconnected page. These form one late-bound cycle — the controller schedules
 * through the scheduler while the scheduler drives the controller — so they are
 * constructed together inside this factory rather than as module singletons.
 *
 * The host reaches back into the worker only through `deps`, and the worker
 * reaches in only through the two entries this factory returns.
 */
export type OrganizeJobHostDeps = Readonly<{
  /** Shared serialized job queue; Apply chunks must not race a Stars sync. */
  jobQueue: SerializedRunner;
  /** Gated provider factory; enforces disclosure and host permission per run. */
  createRuntimeProvider: () => Promise<GatedAgentRuntimeProvider<ModelProvider>>;
  /** DEV-only execution observer; null in release builds. */
  observeExecutionEvent: ((rootOperationId: string, event: AgentExecutionTraceEvent) => void) | null;
}>;

export type OrganizeJobHost = Readonly<{
  /** Installs both alarm-backed recovery listeners. */
  install: () => void;
  /** Notifies connected Organize pages that an Agent session was deleted. */
  publishAgentSessionDeleted: (deletedSessionId: string) => void;
}>;

export function createOrganizeJobHost(deps: OrganizeJobHostDeps): OrganizeJobHost {
  const { jobQueue } = deps;

  const organizeApplyPump = createOrganizeApplyPump({
    runSerialized: (fn) => jobQueue.run(fn),
    claim: (applyId) => claimOrganizeApplyChunk(applyId, 100, {
      ownerId: `apply-worker:${applyId}`,
    }),
    settle: async (applyId, leaseToken) => {
      const settled = await settleOrganizeApplyChunk({ applyId, leaseToken });
      return {
        complete: settled.complete,
        rows: settled.rows.flatMap((row) => (
          row.state === "changed" ||
          row.state === "unchanged" ||
          row.state === "skipped" ||
          row.state === "failed"
            ? [{ position: row.position, state: row.state }]
            : []
        )),
      };
    },
    onProgress: (jobId) => publishOrganizeJobState(jobId),
    onComplete: () => {
      void organizeApplyRecovery.reconcile();
    },
    onFailure: recoverOrganizeApplyPumpFailure,
    onLifecycle: recordOrganizeApplyPumpLifecycle,
    shouldRestart: async (applyId) => {
      const apply = await db.organizeApplies.get(applyId);
      if (!apply || apply.status !== "sealed") return false;
      const job = await getOrganizeJob(apply.jobId);
      return job?.status === "apply_sealed";
    },
  });
  const organizeApplyRecovery = createOrganizeApplyRecovery({
    createAlarm: async (name, delayInMinutes) => {
      await chrome.alarms.create(name, { delayInMinutes });
    },
    clearAlarm: async (name) => {
      await chrome.alarms.clear(name);
    },
    addAlarmListener: (listener) => {
      chrome.alarms.onAlarm.addListener((alarm) => listener(alarm.name));
    },
    getRecoverableApply: async () => {
      const job = await getActiveOrganizeJob();
      if (
        !job?.applyId ||
        (job.status !== 'apply_sealed' && job.status !== 'applying')
      ) return null;
      return Object.freeze({ applyId: job.applyId, status: job.status });
    },
    recoverExpiredLeases: async () => {
      await recoverExpiredOrganizeLeases(Date.now());
    },
    isRunning: (applyId) => organizeApplyPump.isRunning(applyId),
    pump: (applyId) => organizeApplyPump.pump(applyId),
    onError: (error) => {
      console.error(
        '[GSM] organize Apply recovery failed:',
        error instanceof Error ? error.message : String(error),
      );
    },
  });

  const organizeJobRunConnections = createBgsmOrganizeJobConnectionRegistry<chrome.runtime.Port>();
  let organizeJobRunMutationTail: Promise<void> = Promise.resolve();
  let pendingDurableOrganizeJobId: OrganizeJobId | null = null;
  const organizeJobRunCursorAuthKey = `organize-cursor-auth:${crypto.randomUUID()}`;
  const organizeJobRunExecutionEpochId = `organize-job-epoch:v1:${crypto.randomUUID()}`;

  const organizeJobRunTraceCoordinator = createBgsmOrganizeJobTraceCoordinator({
    executionEpochId: organizeJobRunExecutionEpochId,
    traceFactory: DEV ? createDevOrganizeJobRunTraceFactory() : undefined,
  });
  if (DEV) {
    void db.organizeJobs.toArray().then(async (durableJobs) => {
      await reconcileDevOrganizeJobRunProvisionalRoots({
        executionEpochId: organizeJobRunExecutionEpochId,
        durableJobIds: new Set(durableJobs.map((job) => job.jobId)),
      });
      for (const job of durableJobs) {
        const jobId = parseOrganizeJobId(job.jobId);
        organizeJobRunTraceCoordinator.resume(jobId);
        organizeJobRunTraceCoordinator.recordDurableState(jobId, {
          revision: job.revision,
          source: 'restore',
        });
        if (job.status === 'completed') {
          if (job.applyId) {
            recordOrganizeJobPresentation(job, await buildOrganizeJobPresentation(job));
          } else {
            organizeJobRunTraceCoordinator.completeNoChanges(jobId);
          }
          continue;
        }
        if (job.status === 'cancelled') {
          organizeJobRunTraceCoordinator.cancelFamily(jobId, 'durable_cancelled', 'runtime');
        }
      }
    }).catch(() => {
      // Development reconciliation is observational and cannot block background startup.
    });
  }
  let organizeJobRunScheduler: BgsmOrganizeJobScheduler;
  const organizeJobRunController = createBgsmAgentController({
    resolveCandidate: () => resolveLaunchCandidate({ kind: 'all_live_stars' }),
    scheduleRun: (identity) => {
      const scheduled = organizeJobRunScheduler.schedule(identity);
      void scheduled.catch((error: unknown) => {
        console.error(
          '[GSM] OrganizeJobRun controller schedule failed:',
          error instanceof Error ? error.message : String(error),
        );
      });
      return scheduled;
    },
    onPreflightState: (event) => organizeJobRunTraceCoordinator.recordPreflight(event),
    emit: (event) => {
      if (event.type === "run_terminal") {
        try {
          const context = organizeJobRunController.getExecutionContext(event);
          if (pendingDurableOrganizeJobId === context.jobId) pendingDurableOrganizeJobId = null;
        } catch {
          // A released run has already settled any pending durable reservation.
        }
      }
      void postOrganizeOwnerMessage(event.runId, event.generation, (page) => ({
        type: 'bgsmOrganizeJobRunEvent',
        event: Object.freeze({ ...event, ...page }),
      }), { allowTerminal: event.type === 'run_terminal' });
    },
  });
  const organizeAnalysisRecovery = createOrganizeAnalysisRecovery({
    createAlarm: async (name, delayInMinutes) => {
      await chrome.alarms.create(name, { delayInMinutes });
    },
    clearAlarm: async (name) => {
      await chrome.alarms.clear(name);
    },
    addAlarmListener: (listener) => {
      chrome.alarms.onAlarm.addListener((alarm) => listener(alarm.name));
    },
    getRecoverableAnalysis: async () => {
      const job = await getActiveOrganizeJob();
      return job?.status === 'analyzing'
        ? Object.freeze({ jobId: job.jobId, status: job.status })
        : null;
    },
    recoverExpiredLeases: async () => {
      await recoverExpiredOrganizeLeases(Date.now());
      await publishLatestOrganizeJobState();
    },
    isRunning: async (jobId) => {
      const job = await getOrganizeJob(jobId);
      return !!job && organizeJobRunScheduler.isRunning(parseRunId(job.runId));
    },
    pump: async (jobId) => {
      const job = await getOrganizeJob(jobId);
      if (!job || job.status !== 'analyzing') return;
      const snapshot = await restoreDurableOrganizeJob({
        controllerId: parseControllerId(job.controllerId),
        sessionId: job.sessionId,
        runId: parseRunId(job.runId),
        generation: job.generation,
      }, { force: true, schedule: false });
      if (!snapshot || snapshot.state !== 'analyzing') return;
      await organizeJobRunScheduler.schedule({
        controllerId: snapshot.controllerId,
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        generation: snapshot.generation,
      });
    },
    onError: (error) => {
      console.error(
        '[GSM] organize analysis recovery failed:',
        error instanceof Error ? error.message : String(error),
      );
    },
  });
  organizeJobRunScheduler = createBgsmOrganizeJobScheduler({
    controller: organizeJobRunController,
    publishSnapshot(snapshot, parent) {
      if (parent) {
        organizeJobRunTraceCoordinator.recordGeneration(
          organizeJobRunController.getExecutionContext(snapshot).jobId,
          snapshot,
          {
            state: "prepared",
            cause: "continuation",
            parentRunId: parent.runId,
            parentGeneration: parent.generation,
          },
        );
      }
      void postOrganizeOwnerMessage(snapshot.runId, snapshot.generation, (page) => ({
        type: 'bgsmOrganizeJobRunSnapshot',
        snapshot: Object.freeze({ ...snapshot, ...page }),
      }));
    },
    publishAnalysisProgress(identity, processed, total) {
      void postOrganizeOwnerMessage(identity.runId, identity.generation, (page) => ({
        type: 'bgsmOrganizeJobAnalysisProgress',
        ...identity,
        ...page,
        processed,
        total,
      }));
    },
    automaticContinuationFailed(identity, error) {
      void postOrganizeOwnerError(
        identity,
        'internal_error',
        error instanceof Error ? error.message : 'Automatic OrganizeJobRun continuation failed.',
      );
    },
    async providerSetupFailed(identity, error) {
      const job = await getOrganizeJobForRun(identity.runId, identity.generation);
      const usage = job?.usage as Partial<RunBudgetUsage> | undefined;
      if (
        job?.status === 'analyzing'
        && job.preflight?.state === 'consumed'
        && job.nextFrozenIndex === 0
        && usage?.consumedFrozenPositions === 0
      ) {
        await cancelOrganizeJob(job.jobId);
        await publishOrganizeJobState(job.jobId);
        if (pendingDurableOrganizeJobId === job.jobId) pendingDurableOrganizeJobId = null;
        await organizeAnalysisRecovery.reconcile();
      }
      console.error(
        '[GSM] OrganizeJobRun provider setup failed:',
        error instanceof Error ? error.message : 'Unknown provider setup failure.',
      );
    },
    executionFailed(_identity, error) {
      console.error(
        '[GSM] OrganizeJobRun scheduler failed:',
        error instanceof Error ? error.message : 'Unknown scheduler failure.',
      );
    },
    heartbeat(identity) {
      const snapshot = organizeJobRunController.getSnapshot(identity);
      void postOrganizeOwnerMessage(identity.runId, identity.generation, (page) => ({
        type: 'bgsmOrganizeJobRunSnapshot',
        snapshot: Object.freeze({ ...snapshot, ...page }),
      }));
    },
    async createAnalyzer(identity) {
      const runtime = await deps.createRuntimeProvider();
      const context = organizeJobRunController.getExecutionContext(identity);
      const analyzer = new OrganizeProposalAnalyzer({
        provider: runtime.provider,
        traceProvider: agentTraceProviderIdentity(
          runtime,
          runtime.contextCapability.capabilityRevision,
        ),
        trace: DEV ? {
          emit(event) {
            deps.observeExecutionEvent?.(context.jobId, event);
          },
        } : undefined,
      });
      return Object.assign(analyzer, {
        providerBinding: await organizeAnalysisProviderBinding(runtime),
      });
    },
    async validateDurableProviderBinding({ identity, providerBinding }) {
      const job = await getOrganizeJobForRun(identity.runId, identity.generation);
      if (!job) return;
      if (job.providerBinding === null || job.providerBinding === undefined) {
        const bound = await bindOrganizeJobProvider({
          jobId: job.jobId,
          runId: identity.runId,
          generation: identity.generation,
          providerBinding,
        });
        await publishOrganizeJobState(bound.jobId);
        return;
      }
      if (
        canonicalJson(job.providerBinding) !== canonicalJson(providerBinding)
      ) {
        throw new TypeError('The AI service or model changed while durable analysis was suspended.');
      }
    },
    async initializeDurableRun({ identity, state, continuation, parentIdentity, providerBinding }) {
      if (state.frozenScope.kind !== "all_live_stars") {
        throw new TypeError("OrganizeJobRun only accepts the whole starred library.");
      }
      const context = organizeJobRunController.getExecutionContext(identity);
      const current = await getOrganizeJobForRun(identity.runId, identity.generation);
      if (current) {
        if (current.jobId !== context.jobId) {
          throw new TypeError("OrganizeJobRun durable identity does not match its preallocated job.");
        }
        if (pendingDurableOrganizeJobId === context.jobId) pendingDurableOrganizeJobId = null;
        await publishOrganizeJobState(current.jobId);
        await organizeAnalysisRecovery.arm();
        return;
      }
      const active = await getActiveOrganizeJob();
      if (!active) {
        if (continuation) throw new TypeError("Durable organize continuation has no active job.");
        const taxonomyBundle = await loadOrganizeJobRunTaxonomy();
        const created = await createOrganizeJob({
          jobId: context.jobId,
          controllerId: identity.controllerId,
          sessionId: identity.sessionId,
          runId: identity.runId,
          generation: identity.generation,
          proposalId: state.proposalId,
          frozenScope: {
            kind: state.frozenScope.kind,
            label: state.frozenScope.label,
            filterSnapshot: state.frozenScope.filterSnapshot,
            repositoryIds: [...state.frozenScope.repositoryIds],
            capturedAt: state.frozenScope.capturedAt,
            fingerprint: state.frozenScope.fingerprint,
          },
          taskInstruction: context.taskInstruction,
          tagPolicy: state.tagPolicy,
          taxonomy: {
            fingerprint: taxonomyBundle.fingerprint,
            snapshot: {
              taxonomy: taxonomyBundle.taxonomy,
              policyTaxonomy: taxonomyBundle.policyTaxonomy,
            },
          },
          budget: state.budget,
          usage: state.usage,
          providerBinding,
        });
        await publishOrganizeJobState(created.jobId);
        if (pendingDurableOrganizeJobId === context.jobId) pendingDurableOrganizeJobId = null;
        await organizeAnalysisRecovery.arm();
        return;
      }
      if (active.jobId !== context.jobId) {
        throw new TypeError("Another whole-library organize job is already active.");
      }
      if (active.frozenScope.fingerprint !== state.frozenScope.fingerprint) {
        throw new TypeError("Another whole-library organize job is already active.");
      }
      const advanced = await advanceOrganizeJobRun({
        jobId: active.jobId,
        runId: identity.runId,
        generation: identity.generation,
        proposalId: state.proposalId,
        budget: state.budget,
        usage: state.usage,
        providerBinding,
        startFrozenIndex: state.nextFrozenIndex,
        analysisPendingRanges: state.analysisPendingRanges,
        expectedParent: parentIdentity ?? undefined,
      });
      if (pendingDurableOrganizeJobId === context.jobId) pendingDurableOrganizeJobId = null;
      await publishOrganizeJobState(advanced.jobId);
      await organizeAnalysisRecovery.arm();
    },
    async reserveDurablePage({ identity, state, previousUsage, startFrozenIndex, endFrozenIndexExclusive }) {
      const reserved = await mutateCurrentOrganizeRun(identity, undefined, (job) => (
        reserveOrganizeAnalysisPage({
          jobId: job.jobId,
          runId: identity.runId,
          generation: identity.generation,
          expectedRevision: job.revision,
          startFrozenIndex,
          endFrozenIndexExclusive,
          previousUsage,
          usage: state.usage,
          lease: {
            ownerId: `scheduler:${identity.runId}:${identity.generation}`,
          },
        })
      ));
      if (!reserved) return null;
      await publishOrganizeJobState(reserved.job.jobId);
      return {
        leaseToken: reserved.leaseToken,
        jobId: reserved.job.jobId,
        revision: reserved.job.revision,
      };
    },
    async reserveDurableProviderAttempt({ identity, state, previousUsage, attempt, reservedAt, lease }) {
      const reserved = await mutateCurrentOrganizeRun(identity, lease.jobId, (job) => (
        reserveOrganizeAnalysisProviderAttempt({
          jobId: job.jobId,
          runId: identity.runId,
          generation: identity.generation,
          expectedRevision: job.revision,
          leaseToken: lease.leaseToken,
          previousUsage,
          usage: state.usage,
          serializedRequestBytes: attempt.serializedRequestBytes,
          requestedOutputTokens: attempt.requestedOutputTokens,
          reservedAt,
        })
      ));
      await publishOrganizeJobState(reserved.job.jobId);
      return { ...lease, jobId: reserved.job.jobId, revision: reserved.job.revision };
    },
    async releaseDurablePage({ identity, lease }) {
      const jobId = lease.jobId ?? (await getOrganizeJobForRun(identity.runId, identity.generation))?.jobId;
      if (!jobId) return;
      const released = await releaseOrganizeAnalysisPage({
        jobId,
        leaseToken: lease.leaseToken,
      });
      if (released) await publishOrganizeJobState(jobId);
    },
    async checkpointDurablePage({ identity, state, positions, lease }) {
      const checkpoint = await mutateCurrentOrganizeRun(identity, lease.jobId, (job) => (
        checkpointOrganizeAnalysisPage({
          jobId: job.jobId,
          runId: identity.runId,
          generation: identity.generation,
          expectedRevision: job.revision,
          leaseToken: lease.leaseToken,
          expectedNextFrozenIndex: state.nextFrozenIndex,
          outcomes: organizeOutcomesForPage(state, positions),
          usage: state.usage,
          analysisPendingRanges: state.analysisPendingRanges,
        })
      ));
      await publishOrganizeJobState(checkpoint.job.jobId);
      await organizeAnalysisRecovery.reconcile();
    },
    async splitDurablePage({ identity, state, lease }) {
      const split = await mutateCurrentOrganizeRun(identity, lease.jobId, (job) => (
        splitOrganizeAnalysisPage({
          jobId: job.jobId,
          runId: identity.runId,
          generation: identity.generation,
          expectedRevision: job.revision,
          leaseToken: lease.leaseToken,
        })
      ));
      if (!sameOrganizeAnalysisRanges(split.pendingRanges, state.analysisPendingRanges)) {
        throw new TypeError('Durable organize split worklist diverged from scheduler state.');
      }
      await publishOrganizeJobState(split.job.jobId);
    },
    async registerDurableReview({ identity, proposal }) {
      const job = await getOrganizeJobForRun(identity.runId, identity.generation);
      if (!job || job.status !== "review") {
        throw new TypeError("Durable organize review is not ready.");
      }
      organizeJobRunController.registerDurableProposal(identity, proposal);
      await publishOrganizeJobState(job.jobId);
      return true;
    },
    async completeDurableWithoutProposal({ identity }) {
      const job = await getOrganizeJobForRun(identity.runId, identity.generation);
      if (!job) throw new TypeError("Durable organize job is unavailable for completion.");
      const completed = await completeOrganizeJobWithoutApply(job.jobId);
      await organizeAnalysisRecovery.reconcile();
      const jobId = parseOrganizeJobId(completed.jobId);
      organizeJobRunTraceCoordinator.recordDurableState(jobId, {
        revision: completed.revision,
        source: "mutation",
      });
      organizeJobRunTraceCoordinator.recordReview(jobId, {
        runId: completed.runId,
        generation: completed.generation,
        revision: completed.revision,
        state: "ready",
        actionableRepositories: 0,
        selectedRepositories: 0,
        selectedActions: 0,
        rowOffset: null,
        rowCount: 0,
        nextRowOffset: null,
      });
      organizeJobRunTraceCoordinator.completeNoChanges(jobId);
      await publishOrganizeJobState(completed.jobId);
    },
    async loadPage({ identity, state, startFrozenIndex, endFrozenIndexExclusive }) {
      const taxonomyBundle = await loadFrozenOrganizeTaxonomy(identity);
      const page = await loadFrozenScopePage({
        runId: identity.runId,
        generation: identity.generation,
        frozenScope: state.frozenScope,
        cursor: createFrozenScopeCursor(identity.runId, identity.generation, startFrozenIndex),
        limit: endFrozenIndexExclusive - startFrozenIndex,
        excludedTagNames: taxonomyBundle.policyTaxonomy.entries
          .filter((entry) => entry.excluded)
          .map((entry) => entry.name),
        load: loadOrganizeJobRunRepositoryRecords,
      });
      return {
        positions: page.positions,
        taxonomy: taxonomyBundle.taxonomy,
        policyTaxonomy: taxonomyBundle.policyTaxonomy,
        taxonomyFingerprint: taxonomyBundle.fingerprint,
      };
    },
    issueContinuationCursor: (identity, nextFrozenIndex) => issueContinuationCursor(
      createFrozenScopeCursor(identity.runId, identity.generation, nextFrozenIndex),
      organizeJobRunCursorAuthKey,
    ),
    createProposalId: () => parseProposalId(`proposal:v1:${crypto.randomUUID()}`),
    trace(event) {
      const context = organizeJobRunController.getExecutionContext(event.identity);
      if (event.type === "watchdog_state") {
        organizeJobRunTraceCoordinator.recordWatchdog(context.jobId, {
          watchdog: event.watchdog,
          state: event.state,
          limitMs: event.limitMs,
        });
        return;
      }
      const shared = {
        runId: event.identity.runId,
        generation: event.identity.generation,
        batchStart: event.batchStart,
        batchEnd: event.batchEnd,
      };
      if (event.type === "batch_state") {
        organizeJobRunTraceCoordinator.recordBatch(context.jobId, {
          ...shared,
          repositoryCount: event.repositoryCount,
          localOnlyCount: event.localOnlyCount,
          providerCount: event.providerCount,
          state: event.state,
        });
        return;
      }
      organizeJobRunTraceCoordinator.recordProviderAttempt(context.jobId, {
        ...shared,
        attempt: event.attempt,
        state: event.state,
        requestBytes: event.requestBytes,
        requestedOutputTokens: event.requestedOutputTokens,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens,
        reasonCode: event.reasonCode,
      });
    },
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "bgsm-agent-organize-job") return;
    let portConnection: BgsmOrganizeJobConnection<chrome.runtime.Port> | null = null;

    const bindOrAcceptPort = (identity: Readonly<{
      controllerId: BgsmOrganizeJobClientMessage['controllerId'];
      sessionId: string;
    }>): boolean => {
      const bound = organizeJobRunConnections.bind(port, {
        controllerId: identity.controllerId,
        sessionId: identity.sessionId,
      });
      if (bound.status === 'identity_mismatch') {
        port.disconnect();
        return false;
      }
      if (bound.status === 'stale') return false;
      portConnection = bound.connection;
      if (bound.status === 'bound') {
        safeOrganizeJobRunPost(port, {
          type: 'bgsmOrganizeJobRunConnectionReady',
          controllerId: identity.controllerId,
          sessionId: identity.sessionId,
        });
      }
      return true;
    };

    const releasePortConnection = (): void => {
      const connection = portConnection;
      if (connection) organizeJobRunConnections.release(connection);
    };

    const handleOrganizeJobRunMessage = async (message: BgsmOrganizeJobClientMessage) => {
      try {
        validateBgsmOrganizeJobMessageIdentity(message);
      } catch {
        port.disconnect();
        return;
      }
      if (!bindOrAcceptPort(message)) return;

      try {
        if (message.type === "requestBgsmOrganizeJobPreflight") {
          const jobId = createOrganizeJobId();
          organizeJobRunTraceCoordinator.begin(jobId);
          let result;
          try {
            const activeJobPromise = getActiveOrganizeJob();
            const resultPromise = organizeJobRunController.issuePreflight(message, {
              requestId: message.requestId,
              jobId,
            });
            const [activeJob, resolved] = await Promise.all([activeJobPromise, resultPromise]);
            if (
              (
                pendingDurableOrganizeJobId
                || (activeJob && !canReplaceBlockedDurableRun(activeJob, message))
              )
            ) {
              organizeJobRunController.cancelPreflight(message, message.requestId);
              throw new TypeError("An active OrganizeJobRun already exists.");
            }
            result = resolved;
            if (result.status === "ready" && result.preflightToken) {
              const context = organizeJobRunController.getPreflightContext(
                message,
                result.preflightToken,
              );
              const [taxonomyBundle, config] = await Promise.all([
                loadOrganizeJobRunTaxonomy(),
                authStore.getConfig(),
              ]);
              await createOrganizePreflight({
                jobId: context.jobId,
                controllerId: message.controllerId,
                sessionId: message.sessionId,
                runId: parseRunId(`run:v1:${crypto.randomUUID()}`),
                generation: 1,
                frozenScope: {
                  kind: context.frozenScope.kind,
                  label: context.frozenScope.label,
                  filterSnapshot: context.frozenScope.filterSnapshot,
                  repositoryIds: [...context.frozenScope.repositoryIds],
                  capturedAt: context.frozenScope.capturedAt,
                  fingerprint: context.frozenScope.fingerprint,
                },
                taskInstruction: message.taskInstruction,
                tagPolicy: createOrganizeTagPolicySnapshot(config),
                taxonomy: {
                  fingerprint: taxonomyBundle.fingerprint,
                  snapshot: {
                    taxonomy: taxonomyBundle.taxonomy,
                    policyTaxonomy: taxonomyBundle.policyTaxonomy,
                  },
                },
                budget: createProductionRunBudget(),
                usage: createEmptyRunBudgetUsage(),
                preflightToken: result.preflightToken,
                requestId: message.requestId,
                expiresAt: context.expiresAt,
              });
              await publishLatestOrganizeJobState();
            }
          } catch (error) {
            if (
              error instanceof Error &&
              /preflight request is stale/u.test(error.message) &&
              !organizeJobRunController.findReadyPreflight(message)
            ) return;
            organizeJobRunTraceCoordinator.failPreflight(jobId);
            throw error;
          }
          const responsePort = currentOrganizeJobRunPort(message.controllerId, message.sessionId) ?? port;
          if (result.status === "ready" && result.preflightToken) {
            safeOrganizeJobRunPost(responsePort, {
              type: "bgsmOrganizeJobRunPreflightResult",
              controllerId: message.controllerId,
              sessionId: message.sessionId,
              requestId: message.requestId,
              status: "ready",
              preflightToken: result.preflightToken,
              label: result.label,
              count: result.count,
            });
          } else {
            safeOrganizeJobRunPost(responsePort, {
              type: "bgsmOrganizeJobRunPreflightResult",
              controllerId: message.controllerId,
              sessionId: message.sessionId,
              requestId: message.requestId,
              status: "no_work",
              preflightToken: null,
              label: result.label,
              count: 0,
            });
          }
          return;
        }
        if (message.type === "startBgsmOrganizeJob") {
          const preflight = await getOrganizePreflightByToken(message.preflightToken);
          if (!preflight) throw new TypeError("OrganizeJobRun preflight token is invalid or stale.");
          let replacedJob: Awaited<ReturnType<typeof getActiveOrganizeJob>> = undefined;
          let reservedPendingDurableJob = false;
          if (preflight.frozenScope.kind === "all_live_stars") {
            const active = await getActiveOrganizeJob();
            const sameStartedJob = active?.jobId === preflight.jobId;
            if (
              (active && !sameStartedJob && !canReplaceBlockedDurableRun(active, message))
              || (pendingDurableOrganizeJobId && pendingDurableOrganizeJobId !== preflight.jobId)
            ) {
              throw new TypeError("An active OrganizeJobRun already exists.");
            }
            replacedJob = sameStartedJob ? undefined : active;
            if (!sameStartedJob) {
              pendingDurableOrganizeJobId = parseOrganizeJobId(preflight.jobId);
              reservedPendingDurableJob = true;
            }
          }
          let activated;
          try {
            if (replacedJob) {
              const runId = parseRunId(replacedJob.runId);
              organizeJobRunScheduler.abort(runId);
              const inMemory = organizeJobRunController.findSnapshotByRun(
                runId,
                replacedJob.generation,
              );
              if (inMemory) organizeJobRunController.stopRun(ephemeralOrganizeRunIdentity(inMemory));
              if (!await cancelOrganizeJob(replacedJob.jobId)) {
                throw new TypeError('Blocked OrganizeJobRun replacement could not cancel the previous job.');
              }
              await publishOrganizeJobState(replacedJob.jobId);
              organizeJobRunScheduler.release(runId);
              organizeJobRunTraceCoordinator.cancelFamily(
                parseOrganizeJobId(replacedJob.jobId),
                "user_stopped",
                "user",
              );
            }
            activated = await activateOrganizePreflight({
              preflightToken: message.preflightToken,
              controllerId: message.controllerId,
              sessionId: message.sessionId,
              taskInstruction: message.taskInstruction,
            });
          } finally {
            if (reservedPendingDurableJob && pendingDurableOrganizeJobId === preflight.jobId) {
              pendingDurableOrganizeJobId = null;
            }
            reservedPendingDurableJob = false;
          }
          const acknowledged = organizeJobRunController.acknowledgePreflightStarted(
            message,
            message.preflightToken,
          );
          if (!acknowledged && activated.disposition === 'started') {
            organizeJobRunTraceCoordinator.recordPreflight({
              jobId: parseOrganizeJobId(activated.job.jobId),
              state: 'started',
              repositoryCount: activated.job.itemCount,
            });
          }
          const runIdentity = {
            controllerId: message.controllerId,
            sessionId: message.sessionId,
            runId: parseRunId(activated.job.runId),
            generation: activated.job.generation,
          };
          const snapshot = await restoreDurableOrganizeJob(runIdentity, {
            schedule: false,
          });
          if (!snapshot) throw new TypeError('Durable OrganizeJobRun could not be restored after start.');
          if (activated.disposition === 'started') {
            organizeJobRunTraceCoordinator.recordGeneration(
              parseOrganizeJobId(activated.job.jobId),
              snapshot,
              {
                state: "frozen",
                cause: "initial",
                parentRunId: null,
                parentGeneration: null,
              },
            );
            await organizeAnalysisRecovery.arm();
            void organizeJobRunScheduler.schedule(runIdentity).catch((error: unknown) => {
              console.error(
                '[GSM] OrganizeJobRun schedule failed:',
                error instanceof Error ? error.message : String(error),
              );
            });
          }
          safeOrganizeJobRunPost(port, {
            type: 'bgsmOrganizeJobRunSnapshot',
            snapshot: readdressOrganizeSnapshot(snapshot, message),
          }, {
            kind: 'authoritative_snapshot',
            durableRevision: activated.job.revision,
          });
          await publishOrganizeJobState(activated.job.jobId, 'authoritative_snapshot');
          return;
        }
        if (message.type === 'cancelBgsmOrganizeJobPreflight') {
          organizeJobRunController.cancelPreflight(message, message.requestId);
          await cancelOrganizePreflight(message);
          await publishLatestOrganizeJobState();
          return;
        }
        if (message.type === 'requestBgsmActiveOrganizeJob') {
          const job = await getActiveOrganizeJob() ?? await getLatestOrganizeJob();
          const snapshot = job && !isTerminalOrganizeJob(job)
            ? await restoreDurableOrganizeJob(durableOrganizeRunIdentity(job))
            : null;
          if (snapshot) {
            safeOrganizeJobRunPost(port, {
              type: 'bgsmOrganizeJobRunSnapshot',
              snapshot: readdressOrganizeSnapshot(snapshot, message),
            }, {
              kind: 'authoritative_snapshot',
              durableRevision: job?.revision ?? null,
            });
          }
          await replayOrganizeJobRunInMemoryAuthority(port, message);
          await publishLatestOrganizeJobState('authoritative_snapshot');
          return;
        }
        if (message.type === 'takeControlBgsmOrganizeJob') {
          const job = await requireOrganizeRunRead(message);
          if (job.revision !== message.expectedRevision) {
            throw new OrganizeControlFailure('revision_conflict');
          }
          if (isTerminalOrganizeJob(job)) throw new OrganizeControlFailure('job_unavailable');
          if (organizeJobRunConnections.hasLivePort(durableOrganizePageIdentity(job))) {
            throw new OrganizeControlFailure('owner_connected');
          }
          const takeover = takeControlOrganizeJob({
            jobId: job.jobId,
            controllerId: message.controllerId,
            sessionId: message.sessionId,
            expectedRevision: message.expectedRevision,
          });
          const updated = await takeover;
          await publishOrganizeJobState(updated.jobId);
          return;
        }
        if (message.type === 'requestBgsmOrganizeJobSnapshot') {
          const job = await requireOrganizeRunRead(message);
          const restored = await restoreDurableOrganizeJob(durableOrganizeRunIdentity(job));
          const execution = organizeJobRunController.findSnapshotByRun(
            message.runId,
            message.generation,
          ) ?? restored;
          if (execution) {
            await resolveBgsmOrganizeJobReconnect({
              identity: ephemeralOrganizeRunIdentity(execution),
              page: message,
              controller: organizeJobRunController,
              post: (response) => safeOrganizeJobRunPost(port, response, {
                kind: 'authoritative_snapshot',
                durableRevision: job.revision,
              }),
            });
          }
          await publishOrganizeJobState(job.jobId, 'authoritative_snapshot');
          await replayOrganizeJobRunInMemoryAuthority(port, message);
          return;
        }
        if (message.type === "requestBgsmOrganizeReviewPage") {
          const job = await requireOrganizeRunRead(message);
          await postOrganizeReviewPage(port, message, job, message.requestId, message.rowOffset, message.limit);
          return;
        }
        if (message.type === "updateBgsmOrganizeSelection") {
          const job = await requireOrganizeOwnerMutation(message);
          const updated = await updateOrganizeSelection({
            jobId: job.jobId,
            expectedRevision: message.expectedRevision,
            selections: message.selections,
          });
          await recordOrganizeSelection(updated, job.revision, "partial", message.selections.length);
          await publishOrganizeJobState(updated.jobId);
          await postOrganizeReviewPage(port, message, updated, message.requestId, message.rowOffset, 100);
          return;
        }
        if (message.type === "setAllBgsmOrganizeSelections") {
          const job = await requireOrganizeOwnerMutation(message);
          const updated = await setAllOrganizeSelections({
            jobId: job.jobId,
            expectedRevision: message.expectedRevision,
            selected: message.selected,
          });
          const selection = await getOrganizeSelectionSummary(updated.jobId);
          await recordOrganizeSelection(
            updated,
            job.revision,
            "all",
            selection.actionableRepositories,
            selection,
          );
          await publishOrganizeJobState(updated.jobId);
          await postOrganizeReviewPage(port, message, updated, message.requestId, message.rowOffset, 100);
          return;
        }
        if (message.type === "applyBgsmOrganizeSelection") {
          const apply = await jobQueue.run(async () => {
            const job = await requireOrganizeOwnerMutation(message);
            return sealOrganizeApply(job.jobId, message.expectedRevision);
          });
          await publishOrganizeJobState(apply.jobId);
          void pumpOrganizeApply(apply.applyId);
          return;
        }
        if (message.type === "resumeBgsmOrganizeApply") {
          const job = await requireOrganizeOwnerMutation(message);
          const resumed = await resumeOrganizeApply(job.jobId, message.expectedRevision);
          await publishOrganizeJobState(resumed.jobId, 'live', 'resumed');
          void pumpOrganizeApply(resumed.applyId!);
          return;
        }
        if (message.type === 'dismissBgsmTerminalOrganizeJob') {
          const job = await requireOrganizeTerminalDismiss(message);
          const progress = job.applyId ? await getOrganizeApplyProgress(job.applyId) : undefined;
          if (await dismissTerminalOrganizeJob({
            jobId: job.jobId,
            expectedRevision: message.expectedRevision,
          })) {
            if (job.applyId && progress) {
              organizeJobRunTraceCoordinator.recordReceipt(parseOrganizeJobId(job.jobId), {
                applyId: job.applyId,
                state: 'dismissed',
                total: progress.total,
                changed: progress.changed,
                unchanged: progress.unchanged,
                skipped: progress.skipped,
                failed: progress.failed,
                rowOffset: null,
                rowCount: 0,
                nextRowOffset: null,
                filter: null,
              });
            }
            await publishLatestOrganizeJobState();
          }
          return;
        }
        if (message.type === "requestBgsmOrganizeReceiptPage") {
          const job = await requireOrganizeRunRead(message);
          if (job.applyId !== message.applyId) throw new TypeError("Receipt does not belong to this organize job.");
          await postOrganizeReceiptPage(
            port,
            message,
            job,
            message.requestId,
            message.rowOffset,
            message.limit,
            message.filter,
          );
          return;
        }
        if (message.type === 'stopBgsmOrganizeJob') {
          const durableJob = await requireOrganizeOwnerMutation(message);
          await restoreDurableOrganizeJob(durableOrganizeRunIdentity(durableJob));
          const execution = requireOrganizeExecution(durableJob);
          if (['apply_sealed', 'applying', 'paused'].includes(durableJob.status)) {
            const paused = await requestOrganizeApplyPause(durableJob.jobId);
            await publishOrganizeJobState(
              paused.jobId,
              'live',
              paused.status === 'paused' ? 'paused' : 'pause_requested',
            );
            safeOrganizeJobRunPost(port, {
              type: 'bgsmOrganizeJobRunResult',
              controllerId: message.controllerId,
              sessionId: message.sessionId,
              runId: message.runId,
              generation: message.generation,
              snapshot: readdressOrganizeSnapshot(
                organizeJobRunController.getSnapshot(ephemeralOrganizeRunIdentity(execution)),
                message,
              ),
            }, { durableRevision: paused.revision });
            return;
          }
          organizeJobRunScheduler.abort(execution.runId);
          const snapshot = organizeJobRunController.stopRun(ephemeralOrganizeRunIdentity(execution));
          if (await cancelOrganizeJob(durableJob.jobId)) {
            organizeJobRunTraceCoordinator.cancelFamily(
              parseOrganizeJobId(durableJob.jobId),
              'user_stopped',
              'user',
            );
            await publishOrganizeJobState(durableJob.jobId);
          }
          safeOrganizeJobRunPost(port, {
            type: 'bgsmOrganizeJobRunResult',
            controllerId: message.controllerId,
            sessionId: message.sessionId,
            runId: message.runId,
            generation: message.generation,
            snapshot: readdressOrganizeSnapshot(snapshot, message),
          });
          return;
        }
        if (message.type === 'continueBgsmOrganizeJob') {
          const organizeJob = await requireOrganizeOwnerMutation(message);
          const restored = await restoreDurableOrganizeJob(durableOrganizeRunIdentity(organizeJob));
          const execution = organizeJobRunController.findSnapshotByRun(
            message.runId,
            message.generation,
          ) ?? restored;
          if (!execution) throw new OrganizeControlFailure('job_unavailable');
          if (['frozen', 'prepared', 'checking_provider', 'analyzing'].includes(execution.state)) {
            safeOrganizeJobRunPost(port, {
              type: 'bgsmOrganizeJobRunSnapshot',
              snapshot: readdressOrganizeSnapshot(execution, message),
            }, {
              kind: 'authoritative_snapshot',
              durableRevision: organizeJob.revision,
            });
            await publishOrganizeJobState(organizeJob.jobId, 'authoritative_snapshot');
            return;
          }
          organizeJobRunController.getSnapshot(ephemeralOrganizeRunIdentity(execution));
          const parentState = organizeJobRunScheduler.getState(message.runId);
          if (
            !parentState
            || (
              parentState.status !== 'analysis_blocked'
              && parentState.status !== 'budget_exhausted'
              && parentState.stopReason !== 'proposal_limit'
            )
          ) {
            postOrganizeJobRunError(port, message, 'stale_generation', 'Continuation authority is stale.');
            return;
          }
          const cursor = await resolveContinuationCursor(message.continuationCursor, {
            runId: message.runId,
            generation: message.generation,
            scopeCount: parentState.frozenScope.count,
            minimumNextFrozenIndex: parentState.status === 'analysis_blocked'
              ? parentState.startFrozenIndex
              : parentState.nextFrozenIndex,
            authKey: organizeJobRunCursorAuthKey,
          });
          if (organizeJob.status === 'analysis_blocked') {
            const retried = await retryOrganizeAnalysisFromFirstFailure(organizeJob.jobId);
            await publishOrganizeJobState(retried.jobId);
          }
          await organizeJobRunScheduler.continueRun(
            ephemeralOrganizeRunIdentity(execution),
            cursor.nextFrozenIndex,
            message.continuationCursor,
          );
          return;
        }
        if (message.type === 'disconnectBgsmOrganizeJob') {
          releasePortConnection();
          await publishLatestOrganizeJobState();
          return;
        }
        postOrganizeJobRunError(port, message, "invalid_message", "Unsupported OrganizeJobRun interaction command.");
      } catch (error) {
        postOrganizeJobRunError(
          port,
          message,
          classifyOrganizeJobRunError(error),
          error instanceof Error ? error.message : "BGSM OrganizeJobRun failed.",
        );
        if (
          message.type === 'requestBgsmActiveOrganizeJob'
          && error instanceof TypeError
          && error.message === INVALID_ORGANIZE_CHECKPOINT_DISCARDED_MESSAGE
        ) {
          await publishLatestOrganizeJobState('authoritative_snapshot');
        }
      }
    };

    port.onMessage.addListener((message: BgsmOrganizeJobClientMessage) => {
      organizeJobRunMutationTail = organizeJobRunMutationTail.then(
        () => handleOrganizeJobRunMessage(message),
        () => handleOrganizeJobRunMessage(message),
      );
    });
    port.onDisconnect.addListener(() => {
      const settle = async (): Promise<void> => {
        const connection = organizeJobRunConnections.markDisconnected(port);
        if (!connection) return;
        releasePortConnection();
        await publishLatestOrganizeJobState();
      };
      organizeJobRunMutationTail = organizeJobRunMutationTail.then(settle, settle);
    });
  });

  function safeOrganizeJobRunPost(
    port: chrome.runtime.Port | undefined,
    message: BgsmOrganizeJobServerMessage,
    delivery: Readonly<{
      kind?: BgsmOrganizeJobDeliveryKind;
      durableRevision?: number | null;
    }> = {},
  ): void {
    if (!port) return;
    organizeJobRunConnections.post(port, message, delivery);
  }

  function currentOrganizeJobRunPort(
    controllerId: BgsmOrganizeJobClientMessage['controllerId'],
    sessionId: string,
  ): chrome.runtime.Port | undefined {
    return organizeJobRunConnections.current({ controllerId, sessionId })?.port;
  }

  async function postOrganizeOwnerMessage(
    runId: OrganizeRunIdentity['runId'],
    generation: number,
    createMessage: (page: OrganizePageIdentity) => BgsmOrganizeJobServerMessage,
    options: Readonly<{ allowTerminal?: boolean }> = {},
  ): Promise<void> {
    const job = await getOrganizeJobForRun(runId, generation);
    if (!job || (isTerminalOrganizeJob(job) && !options.allowTerminal)) return;
    const page = durableOrganizePageIdentity(job);
    const port = currentOrganizeJobRunPort(page.controllerId, page.sessionId);
    safeOrganizeJobRunPost(port, createMessage(page), { durableRevision: job.revision });
  }

  async function postOrganizeOwnerError(
    identity: OrganizeRunIdentity,
    reason: BgsmOrganizeJobErrorReason,
    detail: string,
  ): Promise<void> {
    await postOrganizeOwnerMessage(identity.runId, identity.generation, (page) => ({
      type: 'bgsmOrganizeJobRunError',
      ...page,
      runId: identity.runId,
      generation: identity.generation,
      reason,
      message: boundOrganizeJobRunError(detail),
    }));
  }

  async function replayOrganizeJobRunInMemoryAuthority(
    port: chrome.runtime.Port,
    identity: Readonly<{
      controllerId: BgsmOrganizeJobClientMessage['controllerId'];
      sessionId: string;
      runId?: OrganizeRunIdentity['runId'];
      generation?: number;
    }>,
  ): Promise<void> {
    const inMemoryPreflight = organizeJobRunController.findReadyPreflight(identity);
    const durablePreflight = inMemoryPreflight
      ? null
      : await getReadyOrganizePreflight(identity);
    const preflight = inMemoryPreflight ?? (durablePreflight?.preflight ? {
      requestId: durablePreflight.preflight.requestId,
      preflightToken: parsePreflightToken(durablePreflight.preflight.token),
      label: durablePreflight.frozenScope.label,
      count: durablePreflight.itemCount,
    } : null);
    if (preflight) {
      safeOrganizeJobRunPost(port, {
        type: 'bgsmOrganizeJobRunPreflightResult',
        controllerId: identity.controllerId,
        sessionId: identity.sessionId,
        requestId: preflight.requestId,
        status: 'ready',
        preflightToken: preflight.preflightToken,
        label: preflight.label,
        count: preflight.count,
      }, { kind: 'replay' });
    }
  }

  function postOrganizeJobRunError(
    port: chrome.runtime.Port,
    identity: Pick<BgsmOrganizeJobClientMessage, "controllerId" | "sessionId"> & Partial<OrganizeRunIdentity> & Readonly<{
      requestId?: string;
    }>,
    reason: BgsmOrganizeJobErrorReason,
    detail: string,
  ): void {
    const controlMessage = reason === 'not_owner'
      ? 'This page does not control the Organize run.'
      : reason === 'owner_connected'
        ? 'The controlling page is connected.'
        : reason === 'revision_conflict'
          ? 'The Organize run changed.'
          : reason === 'already_started'
            ? 'An Organize run is already active.'
            : reason === 'job_unavailable'
              ? 'The Organize run is unavailable.'
              : detail;
    safeOrganizeJobRunPost(port, {
      type: 'bgsmOrganizeJobRunError',
      controllerId: identity.controllerId,
      sessionId: identity.sessionId,
      runId: identity.runId ?? null,
      generation: identity.generation ?? null,
      reason,
      message: boundOrganizeJobRunError(controlMessage),
      ...(identity.requestId ? { requestId: identity.requestId } : {}),
    });
  }

  async function publishOrganizeJobState(
    jobId: string,
    deliveryKind: BgsmOrganizeJobDeliveryKind = 'live',
    applyStateOverride?: 'resumed' | 'pause_requested' | 'paused',
  ): Promise<void> {
    const job = await getOrganizeJob(jobId);
    if (!job || job.status === 'preflight_ready') {
      publishOrganizeNoJobState();
      return;
    }
    organizeJobRunTraceCoordinator.recordDurableState(parseOrganizeJobId(job.jobId), {
      revision: job.revision,
      source: deliveryKind === 'authoritative_snapshot' ? 'reconnect' : 'mutation',
    });
    const presentation = await buildOrganizeJobPresentation(job);
    recordOrganizeJobPresentation(job, presentation, applyStateOverride);
    const ownerConnected = organizeJobRunConnections.hasLivePort(durableOrganizePageIdentity(job));
    organizeJobRunConnections.fanOut((connection) => ({
      type: 'bgsmOrganizeJobState',
      ...connection.identity,
      presentation,
      role: resolveBgsmOrganizeControlRole({
        page: connection.identity,
        job,
        ownerConnected,
      }),
    }), { kind: deliveryKind, durableRevision: job.revision });
  }

  async function publishLatestOrganizeJobState(
    deliveryKind: BgsmOrganizeJobDeliveryKind = 'live',
  ): Promise<void> {
    const job = await getActiveOrganizeJob() ?? await getLatestOrganizeJob();
    if (!job || job.status === 'preflight_ready') {
      publishOrganizeNoJobState();
      return;
    }
    await publishOrganizeJobState(job.jobId, deliveryKind);
  }

  function publishOrganizeNoJobState(): void {
    organizeJobRunConnections.fanOut((connection) => ({
      type: 'bgsmOrganizeJobState',
      ...connection.identity,
      presentation: null,
      role: null,
    }), { kind: 'authoritative_snapshot', durableRevision: null });
  }

  function publishAgentSessionDeleted(deletedSessionId: string): void {
    organizeJobRunConnections.fanOut((connection) => ({
      type: 'bgsmAgentSessionDeleted',
      ...connection.identity,
      deletedSessionId,
    }));
  }

  function recordOrganizeJobPresentation(
    job: OrganizeJobRecord,
    presentation: BgsmOrganizeJobPresentation,
    applyStateOverride?: 'resumed' | 'pause_requested' | 'paused',
  ): void {
    const jobId = parseOrganizeJobId(job.jobId);
    if (job.status === 'review') {
      organizeJobRunTraceCoordinator.recordReview(jobId, {
        runId: job.runId,
        generation: job.generation,
        revision: job.revision,
        state: 'ready',
        actionableRepositories: presentation.coverage.actionable,
        selectedRepositories: presentation.selectedRepositories,
        selectedActions: presentation.selectedActions,
        rowOffset: null,
        rowCount: 0,
        nextRowOffset: null,
      });
    }
    if (!presentation.apply || !job.applyId) return;
    const applyState = applyStateOverride
      ?? (job.status === 'completed' ? 'completed' : job.status === 'paused' ? 'paused' : 'sealed');
    organizeJobRunTraceCoordinator.recordApply(jobId, {
      applyId: job.applyId,
      executionId: null,
      revision: job.revision,
      state: applyState,
      total: presentation.apply.total,
      settled: presentation.apply.settled,
      changed: presentation.apply.changed,
      unchanged: presentation.apply.unchanged,
      skipped: presentation.apply.skipped,
      failed: presentation.apply.failed,
    });
    if (job.status !== 'completed') return;
    organizeJobRunTraceCoordinator.recordReceipt(jobId, {
      applyId: job.applyId,
      state: 'available',
      total: presentation.apply.total,
      changed: presentation.apply.changed,
      unchanged: presentation.apply.unchanged,
      skipped: presentation.apply.skipped,
      failed: presentation.apply.failed,
      rowOffset: null,
      rowCount: 0,
      nextRowOffset: null,
      filter: null,
    }, { state: 'completed', reasonCode: 'apply_completed' });
  }

  async function recordOrganizeSelection(
    job: OrganizeJobRecord,
    previousRevision: number,
    mode: 'partial' | 'all',
    affectedRepositories: number,
    knownSummary?: OrganizeSelectionSummary,
  ): Promise<void> {
    const selection = knownSummary ?? await getOrganizeSelectionSummary(job.jobId);
    organizeJobRunTraceCoordinator.recordSelection(parseOrganizeJobId(job.jobId), {
      runId: job.runId,
      generation: job.generation,
      previousRevision,
      revision: job.revision,
      mode,
      affectedRepositories,
      selectedRepositories: selection.selectedRepositories,
      selectedActions: selection.selectedActions,
    });
  }

  type OrganizeRunRequest = OrganizePageIdentity & Readonly<{
    runId: OrganizeRunIdentity['runId'];
    generation: number;
    jobId?: string;
    expectedRevision?: number;
  }>;

  async function requireOrganizeRunRead(message: OrganizeRunRequest): Promise<OrganizeJobRecord> {
    const job = message.jobId
      ? await getOrganizeJob(message.jobId)
      : await getOrganizeJobForRun(message.runId, message.generation);
    if (
      !job
      || (message.jobId !== undefined && job.jobId !== message.jobId)
      || job.runId !== message.runId
      || job.generation !== message.generation
    ) throw new OrganizeControlFailure('job_unavailable');
    return job;
  }

  async function requireOrganizeOwnerMutation(message: OrganizeRunRequest): Promise<OrganizeJobRecord> {
    const job = await requireOrganizeRunRead(message);
    if (message.expectedRevision !== undefined && job.revision !== message.expectedRevision) {
      throw new OrganizeControlFailure('revision_conflict');
    }
    if (isTerminalOrganizeJob(job)) throw new OrganizeControlFailure('job_unavailable');
    if (job.controllerId !== message.controllerId || job.sessionId !== message.sessionId) {
      throw new OrganizeControlFailure('not_owner');
    }
    if (!organizeJobRunConnections.hasLivePort(message)) {
      throw new OrganizeControlFailure('not_owner');
    }
    return job;
  }

  async function requireOrganizeTerminalDismiss(message: OrganizePageIdentity & Readonly<{
    jobId: string;
    expectedRevision: number;
  }>): Promise<OrganizeJobRecord> {
    const job = await getOrganizeJob(message.jobId);
    if (!job) throw new OrganizeControlFailure('job_unavailable');
    if (job.revision !== message.expectedRevision) throw new OrganizeControlFailure('revision_conflict');
    if (!isTerminalOrganizeJob(job)) throw new OrganizeControlFailure('job_unavailable');
    return job;
  }

  function requireOrganizeExecution(job: OrganizeJobRecord): OrganizeJobRunSnapshot {
    const execution = organizeJobRunController.findSnapshotByRun(
      parseRunId(job.runId),
      job.generation,
    );
    if (!execution) throw new OrganizeControlFailure('job_unavailable');
    return execution;
  }

  async function mutateCurrentOrganizeRun<Result>(
    identity: Pick<OrganizeRunIdentity, 'runId' | 'generation'>,
    expectedJobId: string | undefined,
    mutation: (job: OrganizeJobRecord) => Promise<Result>,
  ): Promise<Result> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await getOrganizeJobForRun(identity.runId, identity.generation);
      if (!job || (expectedJobId !== undefined && job.jobId !== expectedJobId)) {
        throw new TypeError('Durable organize execution is unavailable.');
      }
      try {
        return await mutation(job);
      } catch (error) {
        const revisionConflict = error instanceof TypeError
          && /Organize job revision is stale/u.test(error.message);
        if (!revisionConflict || attempt === 2) throw error;
      }
    }
    throw new TypeError('Durable organize execution revision could not be reconciled.');
  }

  async function postOrganizeReviewPage(
    port: chrome.runtime.Port,
    pageIdentity: OrganizePageIdentity,
    job: OrganizeJobRecord,
    requestId: string,
    rowOffset: number,
    limit: number,
  ): Promise<void> {
    if (job.status !== 'review') throw new TypeError('Organize review is not available.');
    const [page, selection] = await Promise.all([
      getOrganizeReviewPageAtOffset(job.jobId, rowOffset, limit),
      getOrganizeSelectionSummary(job.jobId),
    ]);
    safeOrganizeJobRunPost(port, {
      type: 'bgsmOrganizeReviewPage',
      ...organizePageAddress(pageIdentity),
      runId: parseRunId(job.runId),
      generation: job.generation,
      requestId,
      jobId: job.jobId,
      revision: page.revision,
      proposalId: parseProposalId(job.proposalId),
      totalRows: selection.actionableRepositories,
      selectedRepositories: selection.selectedRepositories,
      selectedActions: selection.selectedActions,
      rowOffset: page.rowOffset,
      rows: page.rows.map((row) => ({
        position: row.position,
        proposalRowId: `${job.proposalId}:row:${row.position}`,
        repositoryId: row.fullName,
        proposedActions: row.proposedActions,
        selected: row.selected,
      })),
      nextRowOffset: page.nextRowOffset,
    }, { durableRevision: page.revision });
    organizeJobRunTraceCoordinator.recordReview(parseOrganizeJobId(job.jobId), {
      runId: job.runId,
      generation: job.generation,
      revision: page.revision,
      state: 'page_delivered',
      actionableRepositories: selection.actionableRepositories,
      selectedRepositories: selection.selectedRepositories,
      selectedActions: selection.selectedActions,
      rowOffset: page.rowOffset,
      rowCount: page.rows.length,
      nextRowOffset: page.nextRowOffset,
    });
  }

  async function postOrganizeReceiptPage(
    port: chrome.runtime.Port,
    pageIdentity: OrganizePageIdentity,
    job: OrganizeJobRecord,
    requestId: string,
    rowOffset: number,
    limit: number,
    filter: 'all' | 'changed_or_failed',
  ): Promise<void> {
    if (!job.applyId) throw new TypeError('Organize job has no Apply receipt.');
    const [page, progress] = await Promise.all([
      getOrganizeReceiptPageAtOffset(job.applyId, rowOffset, limit, filter),
      getOrganizeApplyProgress(job.applyId),
    ]);
    if (!page || !progress) throw new TypeError('Organize receipt is unavailable.');
    safeOrganizeJobRunPost(port, {
      type: 'bgsmOrganizeReceiptPage',
      ...organizePageAddress(pageIdentity),
      runId: parseRunId(job.runId),
      generation: job.generation,
      requestId,
      applyId: job.applyId,
      rowOffset: page.rowOffset,
      rows: page.rows.map((row) => {
        if (row.state === 'pending' || row.state === 'leased') {
          throw new TypeError('Pending Apply rows cannot enter a receipt page.');
        }
        return {
          position: row.position,
          proposalRowId: `${job.proposalId}:row:${row.position}`,
          repositoryId: row.fullName,
          outcome: row.state,
          reason: row.outcomeReason as BgsmOrganizeReceiptRow['reason'],
        };
      }),
      nextRowOffset: page.nextRowOffset,
    }, { durableRevision: job.revision });
    organizeJobRunTraceCoordinator.recordReceipt(parseOrganizeJobId(job.jobId), {
      applyId: job.applyId,
      state: 'page_delivered',
      total: progress.total,
      changed: progress.changed,
      unchanged: progress.unchanged,
      skipped: progress.skipped,
      failed: progress.failed,
      rowOffset: page.rowOffset,
      rowCount: page.rows.length,
      nextRowOffset: page.nextRowOffset,
      filter,
    });
  }

  const tracedOrganizeApplyExecutions = new Set<string>();

  function recordOrganizeApplyPumpLifecycle(event: OrganizeApplyPumpLifecycleEvent): void {
    if (event.type === 'attempt_started' || !event.jobId) return;
    const jobId = parseOrganizeJobId(event.jobId);
    if (event.type === 'chunk_claimed') {
      if (!tracedOrganizeApplyExecutions.has(event.executionId)) {
        tracedOrganizeApplyExecutions.add(event.executionId);
        organizeJobRunTraceCoordinator.recordApply(jobId, {
          applyId: event.applyId,
          executionId: event.executionId,
          revision: null,
          state: 'attempt_started',
          total: null,
          settled: null,
          changed: null,
          unchanged: null,
          skipped: null,
          failed: null,
        });
      }
      organizeJobRunTraceCoordinator.recordApplyChunk(jobId, {
        applyId: event.applyId,
        executionId: event.executionId,
        chunkSequence: event.chunkSequence,
        state: 'claimed',
        positionStart: event.positionStart,
        positionEnd: event.positionEnd,
        rowCount: event.rowCount,
        maxAttemptCount: event.maxAttemptCount,
        changed: 0,
        unchanged: 0,
        skipped: 0,
        failed: 0,
        complete: null,
      });
      return;
    }
    if (event.type === 'chunk_settled') {
      organizeJobRunTraceCoordinator.recordApplyChunk(jobId, {
        applyId: event.applyId,
        executionId: event.executionId,
        chunkSequence: event.chunkSequence,
        state: 'settled',
        positionStart: event.positionStart,
        positionEnd: event.positionEnd,
        rowCount: event.rowCount,
        maxAttemptCount: null,
        changed: event.changed,
        unchanged: event.unchanged,
        skipped: event.skipped,
        failed: event.failed,
        complete: event.complete,
      });
      return;
    }
    const state = event.type === 'attempt_idle'
      ? 'attempt_idle'
      : event.type === 'attempt_completed'
        ? 'attempt_completed'
        : 'attempt_failed';
    organizeJobRunTraceCoordinator.recordApply(jobId, {
      applyId: event.applyId,
      executionId: event.executionId,
      revision: null,
      state,
      total: null,
      settled: null,
      changed: null,
      unchanged: null,
      skipped: null,
      failed: null,
    });
    tracedOrganizeApplyExecutions.delete(event.executionId);
  }

  function pumpOrganizeApply(applyId: string): Promise<void> {
    return organizeApplyRecovery.start(applyId);
  }

  async function recoverOrganizeApplyPumpFailure(input: Readonly<{
    applyId: string;
    jobId: string | null;
    error: unknown;
  }>): Promise<void> {
    const apply = await db.organizeApplies.get(input.applyId);
    const jobId = input.jobId ?? apply?.jobId ?? null;
    if (!jobId) return;
    const current = await getOrganizeJob(jobId);
    if (!current || !['apply_sealed', 'applying', 'paused'].includes(current.status)) return;

    await releaseOrganizeJobLeases(jobId);
    const released = await getOrganizeJob(jobId);
    const paused = released?.status === 'paused'
      ? released
      : await requestOrganizeApplyPause(jobId);
    await publishOrganizeJobState(jobId);

    const port = currentOrganizeJobRunPort(parseControllerId(paused.controllerId), paused.sessionId);
    if (port) {
      postOrganizeJobRunError(port, {
        controllerId: paused.controllerId as BgsmOrganizeJobClientMessage['controllerId'],
        sessionId: paused.sessionId,
        runId: parseRunId(paused.runId),
        generation: paused.generation,
      }, 'internal_error', 'Tag application paused after a local storage error. Continue to retry the remaining repositories.');
    }
    console.error(
      '[GSM] organize Apply paused after failure:',
      input.error instanceof Error ? input.error.message : String(input.error),
    );
  }

  const organizeJobRestoreFlights = new Map<
    string,
    Promise<OrganizeJobRunSnapshot | null>
  >();
  const INVALID_ORGANIZE_CHECKPOINT_DISCARDED_MESSAGE =
    'Stored OrganizeJobRun checkpoint was invalid and has been discarded. Start analysis again.';

  async function restoreDurableOrganizeJob(
    identity: OrganizeRunIdentity,
    options: Readonly<{
      force?: boolean;
      schedule?: boolean;
      coordinated?: boolean;
    }> = {},
  ): Promise<OrganizeJobRunSnapshot | null> {
    const found = await getOrganizeJobForRun(identity.runId, identity.generation);
    if (!found || ![
      'analyzing',
      'analysis_blocked',
      'review',
      'apply_sealed',
      'applying',
      'paused',
    ].includes(found.status)) return null;

    const existing = organizeJobRunController.findSnapshotByRun(identity.runId, identity.generation);
    if (!options.force && existing) {
      const poisonedBlockedRetry = found.status === 'analyzing'
        && existing.state === 'analysis_blocked';
      if (!poisonedBlockedRetry) return existing;
    }

    if (!options.coordinated) {
      const activeFlight = organizeJobRestoreFlights.get(found.jobId);
      if (activeFlight) return activeFlight;
      const flight = restoreDurableOrganizeJob(durableOrganizeRunIdentity(found), {
        ...options,
        coordinated: true,
      }).finally(() => {
        if (organizeJobRestoreFlights.get(found.jobId) === flight) {
          organizeJobRestoreFlights.delete(found.jobId);
        }
      });
      organizeJobRestoreFlights.set(found.jobId, flight);
      return flight;
    }

    const restoredJobId = parseOrganizeJobId(found.jobId);
    organizeJobRunTraceCoordinator.resume(restoredJobId);
    organizeJobRunTraceCoordinator.recordRestore(restoredJobId, {
      state: 'started',
      reasonCode: null,
    });
    try {
      organizeJobRunScheduler.abort(parseRunId(found.runId));
      organizeJobRunScheduler.release(parseRunId(found.runId));
      await releaseOrganizeJobLeases(found.jobId);
      const restored = await restoreOrganizeAnalysisCheckpoint(found.jobId);
      const state = buildRestoredOrganizeAnalysisState(
        restored.job,
        restored.items,
        restored.taxonomy.fingerprint,
      );
      await publishOrganizeJobState(found.jobId);
      const runIdentity = durableOrganizeRunIdentity(restored.job);
      const continuationCursor = state.status === 'analysis_blocked'
        ? await issueContinuationCursor(
            createFrozenScopeCursor(state.runId, state.generation, restored.resumeFrozenIndex),
            organizeJobRunCursorAuthKey,
          )
        : null;
      const snapshot = organizeJobRunController.restoreAnalysisRun({
        jobId: restoredJobId,
        identity: runIdentity,
        state,
        taskInstruction: restored.job.taskInstruction,
        continuationCursor,
      });
      organizeJobRunTraceCoordinator.recordRestore(restoredJobId, {
        state: 'succeeded',
        reasonCode: null,
      });
      organizeJobRunTraceCoordinator.recordGeneration(restoredJobId, snapshot, {
        state: 'restored',
        cause: 'restore',
        parentRunId: null,
        parentGeneration: null,
      });
      organizeJobRunScheduler.seedRestoredState(runIdentity.runId, state);
      if (state.status === 'analyzing' && options.schedule !== false) {
        void organizeJobRunScheduler.schedule(runIdentity).catch((error: unknown) => {
          console.error(
            '[GSM] Restored OrganizeJobRun schedule failed:',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
      if (restored.job.applyId && ['apply_sealed', 'applying'].includes(restored.job.status)) {
        void pumpOrganizeApply(restored.job.applyId);
      }
      return snapshot;
    } catch (error) {
      const reasonCode = classifyOrganizeRestoreFailure(error);
      organizeJobRunTraceCoordinator.recordRestore(restoredJobId, {
        state: 'failed',
        reasonCode,
      });
      if (
        reasonCode === 'checkpoint_invariant'
        && found.applyId === null
        && (found.status === 'analyzing' || found.status === 'analysis_blocked')
        && await cancelOrganizeJob(found.jobId)
      ) {
        const cancelled = await getOrganizeJob(found.jobId);
        if (!cancelled || !await dismissTerminalOrganizeJob({
          jobId: found.jobId,
          expectedRevision: cancelled.revision,
        })) {
          throw new TypeError('Invalid OrganizeJobRun checkpoint cleanup did not commit.');
        }
        organizeJobRunScheduler.abort(parseRunId(found.runId));
        organizeJobRunScheduler.release(parseRunId(found.runId));
        if (pendingDurableOrganizeJobId === found.jobId) pendingDurableOrganizeJobId = null;
        organizeJobRunTraceCoordinator.cancelFamily(
          restoredJobId,
          'checkpoint_invalid_discarded',
          'runtime',
        );
        throw new TypeError(INVALID_ORGANIZE_CHECKPOINT_DISCARDED_MESSAGE);
      }
      await organizeJobRunTraceCoordinator.flush(restoredJobId);
      throw error;
    }
  }

  return Object.freeze({
    install: () => {
      organizeAnalysisRecovery.install();
      organizeApplyRecovery.install();
    },
    publishAgentSessionDeleted,
  });
}
