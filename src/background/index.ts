import { authStore, CONFIG_STORAGE_KEY } from "@/auth/auth-store";
import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import { githubStarSource } from "@/api/github-star-source";
import { getMessages } from "@/i18n";
import {
  addBgsmAgentManualTags,
  idbTagStore,
  resetDirtyForDev,
} from "@/storage/idb-tag-store";
import { db } from "@/storage/db";
import { DEV } from "@/dev";
import { attachDevTracePort } from '@/agent-observability/dev-port';
import { createDevAgentTurnTraceFactory } from '@/agent-observability/agent-turn-trace';
import { createDevRawCaptureCoordinator } from '@/agent-observability/raw-capture';
import { scrubAgentProviderConnectionFailure } from '@/agent-observability/redaction';
import {
  createDevOrganizeJobRunTraceFactory,
  reconcileDevOrganizeJobRunProvisionalRoots,
} from '@/agent-observability/organize-job-trace';
import {
  queryStars,
  invalidateCache,
  resolveLaunchCandidate,
  resolveLiveLaunchCandidate,
  type QueryParams,
  type QueryResult,
} from "./query";
import { countTopicRepoFrequency, reconcileAutoTagAssignments, suggestTags } from "@/ui/suggest";
import type { AutoTagBulkUpdate } from "@/api/tag-store";
import { translateError } from "@/api/errors";
import {
  addTagNames,
  canonicalTagKey,
  dismissedAutoTagNames,
  excludedCanonicalTagKeys,
  manualTagNames,
  sameTagNames,
  visibleTagNames,
} from "@/tags/tag-model";
import { selectActiveBackfillId } from "@/upgrades/backfill-state";
import { createBackfillConfigStore, getBackfillTask } from "./backfill-config";
import { createBackfillExecutor } from "./backfill-executor";
import {
  createQueuedAgentGlobalTagDeletionWriter,
  createQueuedAgentManualTagWriter,
  createQueuedAgentVisibleTagRemovalWriter,
} from "./agent-manual-tag-writer";
import { createSerializedRunner } from "./serialized-runner";
import {
  createOrganizeApplyPump,
  type OrganizeApplyPumpLifecycleEvent,
} from "./organize-apply-pump";
import { createOrganizeApplyRecovery } from './organize-apply-recovery';
import { createOrganizeAnalysisRecovery } from './organize-analysis-recovery';
import {
  BGSM_AGENT_MAX_OUTPUT_TOKENS,
  assertBgsmAgentContextCapabilityFeasible,
  buildBgsmAgentSystemPrompt,
  buildBgsmAgentTerminalPayload,
  compactBgsmAgentCompletedToolEnvelope,
  createBgsmAgentPromptScope,
  createRepositoryCodeRefAuthority,
  createBgsmAgentTools,
  createBgsmTurnAuthorization,
  hasSuccessfulRepositoryCodeToolHistory,
  analyzeBgsmPromptIntent,
  prepareBgsmAgentTurn,
  selectBgsmAgentRawTurnNewMessages,
  type BgsmAgentActiveProjection,
  type BgsmAgentCompactionCheckpoint,
  type BgsmAgentOrganizeLibraryAction,
  type BgsmAgentOrganizeLibraryHandoff,
  type RepositoryCodeRefAuthority,
  type BgsmAgentTurnInput,
  type OrganizeJobRunSnapshot,
} from "@/bgsm-agent";
import {
  AgentExecutionLedger,
  createAgentTurnLiveness,
  createRegisteredAgentProvider,
  describeAgentProviderConnectionFailure,
  emitAgentExecutionTrace,
  publicAgentLivenessTimeoutMessage,
  runAgentLoop,
  resolveContextBudgetPolicy,
  testRegisteredAgentProviderConnection,
  type AgentEvent,
  type AgentContextFailureReason,
  type AgentExecutionTraceSink,
  type AgentStopReason,
  type AgentTool,
  type AgentTraceProviderIdentity,
} from "@/agent-harness";
import { hasAgentProviderHostPermission } from "@/agent-harness/provider-access";
import type { AgentProviderConnectionResult } from '@/agent-harness/provider-registry';
import {
  createProviderDiagnosticsRuntime,
  type ProviderDiagnosticsRuntime,
} from '@/agent-observability/provider-monitor-runtime';
import type {
  AgentCustomProviderProtocol,
  AgentProviderId,
  OrganizeItemRecord,
  OrganizeJobRecord,
  OnboardingStage,
  SyncProgress,
} from "@/types";
import {
  normalizeOnboardingStage,
  stageMarksOnboardingSeen,
} from "@/onboarding/state";
import { createAgentProviderGate } from "./agent-provider-gate";
import {
  createBgsmAgentController,
  type OrganizeRunIdentity,
} from "./organize-job-controller";
import { OrganizeProposalAnalyzer } from "@/bgsm-agent/organize-proposal-analyzer";
import {
  issueContinuationCursor,
  resolveContinuationCursor,
} from "@/bgsm-agent/continuation-cursor";
import {
  createFrozenScope,
  createFrozenScopeCursor,
  parsePreflightToken,
  parseScopeFingerprintV1,
} from "@/bgsm-agent/scope";
import {
  createOrganizeJobId,
  parseControllerId,
  parseOrganizeJobId,
  parseProposalId,
  parseRunId,
  type OrganizeJobId,
} from "@/bgsm-agent/identity";
import {
  parseSourceFingerprintV1,
  parseTaxonomyFingerprintV1,
  type ActionableProposalRow,
  type NonActionableAnalysisOutcome,
} from "@/bgsm-agent/proposal";
import {
  restoreOrganizeJobRunAnalysisState,
  type OrganizeJobRunAnalysisState,
  type OrganizeJobRunPagePosition,
} from "@/bgsm-agent/organize-job";
import {
  createEmptyRunBudgetUsage,
  createProductionRunBudget,
  type RunBudget,
  type RunBudgetUsage,
} from "@/bgsm-agent/policy";
import {
  loadFrozenScopePage,
  type SemanticRepositoryRecord,
} from "@/bgsm-agent/organize-scope-reader";
import {
  buildSemanticTaxonomyFromStorage,
  buildSemanticPolicyTaxonomyFromStorage,
  fingerprintSemanticTaxonomy,
} from "@/bgsm-agent/semantic-dto";
import { normalizeStoredTag, type LegacyTagRow } from "@/storage/tag-shape";
import {
  activateOrganizePreflight,
  advanceOrganizeJobRun,
  attachOrganizeJob,
  bindOrganizeJobProvider,
  claimOrganizeApplyChunk,
  checkpointOrganizeAnalysisPage,
  cancelOrganizeJob,
  cancelOrganizePreflight,
  completeOrganizeJobWithoutApply,
  createOrganizeJob,
  createOrganizePreflight,
  dismissOrganizeReceipt,
  getOrganizeApplyProgress,
  getActiveOrganizeJob,
  getOrganizeCoverage,
  getOrganizeJob,
  getOrganizeJobForRun,
  getOrganizePreflightByToken,
  getLatestOrganizeJob,
  getReadyOrganizePreflight,
  getOrganizeReviewPageAtOffset,
  getOrganizeReceiptPageAtOffset,
  getOrganizeSelectionSummary,
  getOrganizeTaxonomy,
  recoverExpiredOrganizeLeases,
  releaseOrganizeJobLeases,
  releaseOrganizeAnalysisPage,
  requestOrganizeApplyPause,
  resumeOrganizeApply,
  retryOrganizeAnalysisFromFirstFailure,
  reserveOrganizeAnalysisPage,
  reserveOrganizeAnalysisProviderAttempt,
  restoreOrganizeAnalysisCheckpoint,
  sealOrganizeApply,
  setAllOrganizeSelections,
  settleOrganizeApplyChunk,
  splitOrganizeAnalysisPage,
  updateOrganizeSelection,
  type OrganizeAnalysisOutcome,
  type OrganizeSelectionSummary,
} from "@/storage/organize-job-store";
import type { SemanticTaxonomyDto } from "@/bgsm-agent/semantic-dto";
import {
  canReplaceBlockedDurableRun,
  resolveBgsmOrganizeJobReconnect,
  settleBgsmOrganizeJobDisconnect,
} from "./organize-job-port-lifecycle";
import {
  createBgsmOrganizeJobScheduler,
  type BgsmOrganizeJobScheduler,
} from "./organize-analysis-runner";
import {
  attachBgsmAgentTurnPort,
  createBgsmAgentTurnRegistry,
} from "./bgsm-agent-turn-port";
import {
  createBgsmOrganizeJobTraceCoordinator,
} from "./organize-job-trace";
import {
  createBgsmOrganizeJobConnectionRegistry,
  type BgsmOrganizeJobConnection,
} from "./organize-job-port";
import { resolveBgsmAgentConversation } from "./bgsm-agent-conversation";
import {
  validateBgsmOrganizeJobMessageIdentity,
  type BgsmOrganizeJobPresentation,
  type BgsmOrganizeReceiptRow,
  type BgsmOrganizeJobClientMessage,
  type BgsmOrganizeJobDeliveryKind,
  type BgsmOrganizeJobErrorReason,
  type BgsmOrganizeJobServerMessage,
} from "@/utils/messaging";

/**
 * Background SW — sync orchestrator and sole owner of the extension-origin
 * IndexedDB. Content scripts/popup/options talk via messages; they never touch
 * IDB directly (content scripts would hit the page's origin DB instead).
 */

type Req =
  | { type: "syncIncremental" }
  | { type: "syncFull" }
  | { type: "syncRescan" }
  | { type: "autoAssignTags" }
  | { type: "gistPush" }
  | { type: "gistPull" }
  | { type: "getStatus" }
  | { type: "getUsername" }
  | { type: "getAccount" }
  | { type: "fetchAccount" }
  | { type: "query"; params: QueryParams }
  | { type: "setTags"; full_name: string; tags: string[] }
  | { type: "setNotes"; full_name: string; notes: string }
  | { type: "setFavorite"; full_name: string; favorite: boolean }
  | { type: "markUnstarred"; full_name: string }
  | { type: "removeVisibleTag"; full_name: string; name: string }
  | { type: "deleteTag"; name: string }
  | { type: "deleteAllTags" }
  | { type: "acceptSuggestions"; full_name: string; toAdd: string[] }
  | {
      type: "acceptSuggestionsBatch";
      items: { full_name: string; toAdd: string[] }[];
    }
  | { type: "suggestTags"; full_name: string }
  | { type: "getTag"; full_name: string }
  | { type: "listExcluded" }
  | { type: "markOnboardingSeen" }
  | { type: "setOnboardingStage"; stage: OnboardingStage }
  | { type: "markTooltipSeen"; bit: number }
  | { type: "testConnection" }
  | {
      type: "testAgentProviderConnection";
      provider?: AgentProviderId;
      protocol?: AgentCustomProviderProtocol | null;
      baseUrl?: string | null;
      model?: string;
      declaredContextWindow?: number | null;
      workingContextWindow?: number | null;
      apiKey?: string;
    }
  | { type: "openOptions" }
  | { type: "devClearLocalData" }
  | { type: "runBackfill"; id: string }
  | { type: "deferBackfill"; id: string };

type Res = { ok: true; data?: unknown } | {
  ok: false;
  error: string;
  details?: unknown;
};

const jobQueue = createSerializedRunner();
const agentManualTagWriter = createQueuedAgentManualTagWriter({
  runSerialized: (operation, runOptions) => jobQueue.run(operation, runOptions),
  isBlocked: async () => organizeApplyBlocksAgentWrites(await getActiveOrganizeJob()),
  write: addBgsmAgentManualTags,
});
const agentVisibleTagRemovalWriter = createQueuedAgentVisibleTagRemovalWriter({
  runSerialized: (operation, runOptions) => jobQueue.run(operation, runOptions),
  isBlocked: async () => organizeApplyBlocksAgentWrites(await getActiveOrganizeJob()),
  write: (changes) => idbTagStore.removeVisibleTagsBulk(changes),
});
const agentGlobalTagDeletionWriter = createQueuedAgentGlobalTagDeletionWriter({
  runSerialized: (operation, runOptions) => jobQueue.run(operation, runOptions),
  isBlocked: async () => organizeApplyBlocksAgentWrites(await getActiveOrganizeJob()),
  write: (tags) => idbTagStore.deleteTagsEverywhere(tags),
});
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
    broadcastDataChanged();
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
let lastProgress: SyncProgress = {
  phase: "idle",
  done: 0,
  total: null,
  message: "",
};
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const backfillConfig = createBackfillConfigStore(authStore, {
  isBackfillRunning: jobQueue.isRunning,
});
const agentProviderGate = createAgentProviderGate({
  auth: authStore,
  hasHostPermission: hasAgentProviderHostPermission,
  testConnection: testRegisteredAgentProviderConnection,
  createProvider: createRegisteredAgentProvider,
  assertContextCapabilityFeasible: assertBgsmAgentContextCapabilityFeasible,
});
// MV3 service workers forbid dynamic import(); DEV folds to a compile-time
// constant, so the release build tree-shakes this entire runtime away.
const providerDiagnosticsRuntime: ProviderDiagnosticsRuntime | null = DEV
  ? createProviderDiagnosticsRuntime()
  : null;
if (DEV) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[CONFIG_STORAGE_KEY]) {
      providerDiagnosticsRuntime?.recordConfigurationChanged();
    }
  });
}
const organizeJobRunConnections = createBgsmOrganizeJobConnectionRegistry<chrome.runtime.Port>();
let organizeJobRunMutationTail: Promise<void> = Promise.resolve();
let pendingDurableOrganizeJobId: OrganizeJobId | null = null;
const MAX_REPOSITORY_CODE_REF_AUTHORITIES = 64;
const repositoryCodeRefAuthorities = new Map<string, {
  scopeFingerprint: string;
  authority: RepositoryCodeRefAuthority;
}>();
const organizeJobRunCursorAuthKey = `organize-cursor-auth:${crypto.randomUUID()}`;
const organizeJobRunExecutionEpochId = `organize-job-epoch:v1:${crypto.randomUUID()}`;
const devRawCaptureCoordinator = DEV
  ? createDevRawCaptureCoordinator({
      getConfiguredSecrets: async () => Promise.all([
        authStore.getToken(),
        authStore.getAgentApiKey(),
      ]),
    })
  : null;
if (DEV) {
  chrome.runtime.onConnect.addListener((port) => {
    if (
      port.name !== 'bgsm-agent-dev-evidence-v1' &&
      port.name !== 'bgsm-agent-dev-control-v1'
    ) return;
    attachDevTracePort(port, {
      rawCapture: devRawCaptureCoordinator ?? undefined,
      providerMonitor: {
        async start(state) {
          if (!providerDiagnosticsRuntime) throw new Error('Provider diagnostics runtime is unavailable.');
          return providerDiagnosticsRuntime.monitor.start(state);
        },
        async stop() {
          if (!providerDiagnosticsRuntime) throw new Error('Provider diagnostics runtime is unavailable.');
          return providerDiagnosticsRuntime.monitor.stop();
        },
        async status() {
          if (!providerDiagnosticsRuntime) throw new Error('Provider diagnostics runtime is unavailable.');
          return providerDiagnosticsRuntime.monitor.status();
        },
      },
    });
  });
}
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
    const port = currentOrganizeJobRunPort(event.controllerId, event.sessionId);
    safeOrganizeJobRunPost(port, { type: "bgsmOrganizeJobRunEvent", event });
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
    const port = currentOrganizeJobRunPort(snapshot.controllerId, snapshot.sessionId);
    safeOrganizeJobRunPost(port, { type: "bgsmOrganizeJobRunSnapshot", snapshot });
  },
  publishAnalysisProgress(identity, processed, total) {
    const port = currentOrganizeJobRunPort(identity.controllerId, identity.sessionId);
    safeOrganizeJobRunPost(port, {
      type: 'bgsmOrganizeJobAnalysisProgress',
      ...identity,
      processed,
      total,
    });
  },
  automaticContinuationFailed(identity, error) {
    const port = currentOrganizeJobRunPort(identity.controllerId, identity.sessionId);
    if (!port) return;
    postOrganizeJobRunError(
      port,
      identity,
      "internal_error",
      error instanceof Error ? error.message : "Automatic OrganizeJobRun continuation failed.",
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
    const port = currentOrganizeJobRunPort(identity.controllerId, identity.sessionId);
    if (!port) return;
    safeOrganizeJobRunPost(port, {
      type: "bgsmOrganizeJobRunSnapshot",
      snapshot: organizeJobRunController.getSnapshot(identity),
    });
  },
  async createAnalyzer(identity) {
    const runtime = await agentProviderGate.createRuntimeProvider();
    const context = organizeJobRunController.getExecutionContext(identity);
    const analyzer = new OrganizeProposalAnalyzer({
      provider: runtime.provider,
      traceProvider: agentTraceProviderIdentity(
        runtime,
        runtime.contextCapability.capabilityRevision,
      ),
      trace: DEV ? {
        emit(event) {
          providerDiagnosticsRuntime?.observeExecutionEvent(context.jobId, event);
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
      await bindOrganizeJobProvider({
        jobId: job.jobId,
        runId: identity.runId,
        generation: identity.generation,
        providerBinding,
      });
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
      controllerId: identity.controllerId,
      sessionId: identity.sessionId,
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
    const job = await getOrganizeJobForRun(identity.runId, identity.generation);
    if (!job) throw new TypeError("Durable organize job is unavailable for this run.");
    const reserved = await reserveOrganizeAnalysisPage({
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
    });
    return reserved && {
      leaseToken: reserved.leaseToken,
      jobId: job.jobId,
      revision: reserved.job.revision,
    };
  },
  async reserveDurableProviderAttempt({ identity, state, previousUsage, attempt, reservedAt, lease }) {
    const jobId = lease.jobId ?? (await getOrganizeJobForRun(identity.runId, identity.generation))?.jobId;
    if (!jobId) throw new TypeError("Durable organize job is unavailable for provider reservation.");
    const reserved = await reserveOrganizeAnalysisProviderAttempt({
      jobId,
      runId: identity.runId,
      generation: identity.generation,
      expectedRevision: lease.revision,
      leaseToken: lease.leaseToken,
      previousUsage,
      usage: state.usage,
      serializedRequestBytes: attempt.serializedRequestBytes,
      requestedOutputTokens: attempt.requestedOutputTokens,
      reservedAt,
    });
    return { ...lease, revision: reserved.job.revision };
  },
  async releaseDurablePage({ identity, lease }) {
    const jobId = lease.jobId ?? (await getOrganizeJobForRun(identity.runId, identity.generation))?.jobId;
    if (!jobId) return;
    await releaseOrganizeAnalysisPage({
      jobId,
      leaseToken: lease.leaseToken,
    });
  },
  async checkpointDurablePage({ identity, state, positions, lease }) {
    const jobId = lease.jobId ?? (await getOrganizeJobForRun(identity.runId, identity.generation))?.jobId;
    if (!jobId) throw new TypeError("Durable organize job is unavailable for checkpointing.");
    const checkpoint = await checkpointOrganizeAnalysisPage({
      jobId,
      runId: identity.runId,
      generation: identity.generation,
      expectedRevision: lease.revision,
      leaseToken: lease.leaseToken,
      expectedNextFrozenIndex: state.nextFrozenIndex,
      outcomes: organizeOutcomesForPage(state, positions),
      usage: state.usage,
      analysisPendingRanges: state.analysisPendingRanges,
    });
    await publishOrganizeJobState(checkpoint.job.jobId);
    await organizeAnalysisRecovery.reconcile();
  },
  async splitDurablePage({ identity, state, lease }) {
    const jobId = lease.jobId ?? (await getOrganizeJobForRun(identity.runId, identity.generation))?.jobId;
    if (!jobId) throw new TypeError("Durable organize job is unavailable for batch splitting.");
    const split = await splitOrganizeAnalysisPage({
      jobId,
      runId: identity.runId,
      generation: identity.generation,
      expectedRevision: lease.revision,
      leaseToken: lease.leaseToken,
    });
    if (!sameOrganizeAnalysisRanges(split.pendingRanges, state.analysisPendingRanges)) {
      throw new TypeError("Durable organize split worklist diverged from scheduler state.");
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
async function loadOrganizeJobRunRepositoryRecords(repositoryIds: readonly string[]) {
  const [stars, tags] = await Promise.all([
    db.stars.bulkGet([...repositoryIds]),
    idbTagStore.getMany([...repositoryIds]),
  ]);
  const records = new Map<string, SemanticRepositoryRecord>();
  repositoryIds.forEach((repositoryId, index) => {
    const star = stars[index];
    if (star) records.set(repositoryId, { star, tag: tags.get(repositoryId) ?? null });
  });
  return records;
}

async function loadOrganizeJobRunTaxonomy() {
  const [rawTags, tagMeta] = await Promise.all([db.tags.toArray(), db.tagMeta.toArray()]);
  const tags = rawTags.map((rawTag) => normalizeStoredTag(rawTag as LegacyTagRow));
  const taxonomy = buildSemanticTaxonomyFromStorage(tagMeta, tags);
  const policyTaxonomy = buildSemanticPolicyTaxonomyFromStorage(tagMeta, tags);
  return Object.freeze({
    taxonomy,
    policyTaxonomy,
    fingerprint: await fingerprintSemanticTaxonomy(policyTaxonomy),
  });
}

type StoredOrganizeTaxonomy = Readonly<{
  taxonomy: SemanticTaxonomyDto;
  policyTaxonomy: SemanticTaxonomyDto;
}>;

async function loadFrozenOrganizeTaxonomy(identity: OrganizeRunIdentity) {
  const job = await getOrganizeJobForRun(identity.runId, identity.generation);
  if (!job) throw new TypeError("Durable organize job is unavailable for taxonomy loading.");
  const stored = await getOrganizeTaxonomy(job.jobId);
  if (!stored || !isStoredOrganizeTaxonomy(stored.snapshot)) {
    throw new TypeError("Durable organize taxonomy snapshot is invalid.");
  }
  return Object.freeze({
    taxonomy: stored.snapshot.taxonomy,
    policyTaxonomy: stored.snapshot.policyTaxonomy,
    fingerprint: stored.fingerprint as Awaited<ReturnType<typeof fingerprintSemanticTaxonomy>>,
  });
}

function isStoredOrganizeTaxonomy(value: unknown): value is StoredOrganizeTaxonomy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return !!record.taxonomy && typeof record.taxonomy === "object" &&
    !!record.policyTaxonomy && typeof record.policyTaxonomy === "object";
}

function organizeOutcomesForPage(
  state: OrganizeJobRunAnalysisState,
  positions: readonly OrganizeJobRunPagePosition[],
): readonly OrganizeAnalysisOutcome[] {
  const actionable = new Map(state.actionableProposalRows.map((row) => [row.frozenIndex, row]));
  const nonActionable = new Map(
    state.nonActionableAnalysisOutcomes.map((row) => [row.frozenIndex, row]),
  );
  return positions.map((position): OrganizeAnalysisOutcome => {
    const proposal = actionable.get(position.frozenIndex);
    if (proposal) {
      return {
        position: position.frozenIndex,
        state: "actionable",
        sourceFingerprint: proposal.sourceFingerprint,
        proposedActions: proposal.actions,
      };
    }
    const outcome = nonActionable.get(position.frozenIndex);
    if (!outcome) throw new TypeError("Finalized organize page is missing a row outcome.");
    return {
      position: position.frozenIndex,
      state: outcome.kind === "analysis_failed" ? "failed" : outcome.kind,
      failure: outcome.kind === "analysis_failed" ? "provider_failed" : null,
    };
  });
}

function sameOrganizeAnalysisRanges(
  left: readonly Readonly<{
    startFrozenIndex: number;
    endFrozenIndexExclusive: number;
    depth: number;
  }>[],
  right: readonly Readonly<{
    startFrozenIndex: number;
    endFrozenIndexExclusive: number;
    depth: number;
  }>[],
): boolean {
  return left.length === right.length && left.every((range, index) => {
    const other = right[index];
    return other !== undefined
      && range.startFrozenIndex === other.startFrozenIndex
      && range.endFrozenIndexExclusive === other.endFrozenIndexExclusive
      && range.depth === other.depth;
  });
}

function shouldPersistProgress(
  prev: SyncProgress,
  next: SyncProgress,
): boolean {
  if (prev.phase !== next.phase) return true;
  if (prev.message !== next.message) return true;
  if (prev.total !== next.total) return true;
  if (next.phase === "idle") return true;
  if (next.total == null) return next.done !== prev.done;
  const step = Math.max(1, Math.ceil(next.total / 25));
  return (
    next.done === 0 || next.done === next.total || next.done - prev.done >= step
  );
}

async function persistProgressSnapshot(progress: SyncProgress) {
  try {
    await authStore.update({ lastSyncProgress: progress });
  } catch (e) {
    console.warn(
      "[GSM] failed to persist progress snapshot:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

function scheduleProgressPersist(prev: SyncProgress, next: SyncProgress) {
  if (!shouldPersistProgress(prev, next)) return;
  if (persistTimer) clearTimeout(persistTimer);
  const delay = next.phase === "idle" ? 0 : 350;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistProgressSnapshot(next);
  }, delay);
}

function setProgress(p: SyncProgress) {
  const prev = lastProgress;
  lastProgress = p;
  scheduleProgressPersist(prev, p);
  chrome.runtime.sendMessage({ type: "progress", progress: p }).catch(() => {});
}

function setIdleMessage(message: string) {
  setProgress({ phase: "idle", done: 0, total: null, message });
}

function broadcastDataChanged() {
  invalidateCache();
  chrome.runtime.sendMessage({ type: "dataChanged" }).catch(() => {});
}

type BgsmAgentTurnResult = {
  turnAttemptId: string;
  sessionId: string;
  baseRevision: number;
  reason: AgentStopReason;
  changed: boolean;
  changedCount: number;
  newMessages: ReturnType<typeof selectBgsmAgentRawTurnNewMessages>;
  candidateCheckpoint?: BgsmAgentCompactionCheckpoint;
  candidateActiveProjection?: BgsmAgentActiveProjection | null;
  contextFailureReason?: AgentContextFailureReason;
  organizeLibraryHandoff?: BgsmAgentOrganizeLibraryHandoff;
};

async function clearLocalDataForDev() {
  if (!DEV) throw new Error("DEV_ONLY");
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  lastProgress = { phase: "idle", done: 0, total: null, message: "" };
  resetDirtyForDev();
  await db.delete();
  await db.open();
  await chrome.storage.local.clear();
  invalidateCache();
  broadcastDataChanged();
  return {
    cleared: ["IndexedDB:better-github-stars-manager", "chrome.storage.local"],
  };
}

async function getLocaleMessages() {
  return getMessages(await authStore.getLocale());
}

/**
 * Auto-tag every star from its topics (NOT language — language is a sidebar
 * filter, not a tag; full rationale in suggest.ts). Pure-local, idempotent,
 * preserves notes. Excluded names are skipped so deleted tags don't resurrect.
 */
async function autoTagAll(
  progressLabel: string,
  onProgress?: (p: SyncProgress) => void,
  phase: SyncProgress['phase'] = 'incremental',
): Promise<{ tagged: number; remainingUntagged: number }> {
  const cfg = await authStore.getConfig();
  const stars = await db.stars.toArray();
  const excluded = new Set(await idbTagStore.listExcluded());
  const existingTags = await idbTagStore.getMany(stars.map((star) => star.full_name));
  const topicRepoCounts = countTopicRepoFrequency(stars);
  const plans: AutoTagBulkUpdate[] = [];
  const total = stars.length;
  console.log(
    '[GSM] autoTag START | stars:',
    total,
    '| excluded:',
    excluded.size,
    '| phase:',
    phase,
    '| limit:',
    cfg.maxTagsPerRepo,
    '| minRepoCount:',
    cfg.minTopicRepoCount,
  );
  for (let i = 0; i < stars.length; i++) {
    const star = stars[i];
    const existing = existingTags.get(star.full_name);
    const manualTags = manualTagNames(existing);
    const dismissed = dismissedAutoTagNames(existing);
    const nextAutoTags = suggestTags(star, [...manualTags, ...dismissed], excluded, {
      limit: cfg.maxTagsPerRepo,
      minRepoCount: cfg.minTopicRepoCount,
      topicRepoCounts,
    });
    plans.push({ full_name: star.full_name, autoTags: nextAutoTags });
    const done = i + 1;
    if (onProgress && (done === 1 || done === total || done % 100 === 0)) {
      onProgress({
        phase,
        done,
        total,
        message: progressLabel,
      });
    }
    if (done % 100 === 0) await Promise.resolve();
  }
  const updates = reconcileAutoTagAssignments(plans, cfg.minTopicRepoCount)
    .filter((plan) => !sameTagNames(existingTags.get(plan.full_name)?.autoTags ?? [], plan.autoTags));
  const { updated: tagged } =
    updates.length > 0 ? await idbTagStore.setAutoTagsBulk(updates) : { updated: 0 };
  console.log('[GSM] autoTag END | newly tagged:', tagged, 'of', total);
  const afterTags = await idbTagStore.getMany(stars.map((star) => star.full_name));
  let remainingUntagged = 0;
  for (const star of stars) {
    if (star.tombstone) continue;
    const row = afterTags.get(star.full_name);
    const hasManual = (row?.manualTags?.length ?? 0) > 0;
    const hasAuto = (row?.autoTags?.length ?? 0) > 0;
    if (!hasManual && !hasAuto) remainingUntagged += 1;
  }
  return { tagged, remainingUntagged };
}

async function runBgsmAgentTurn(
  input: BgsmAgentTurnInput,
  options: {
    emit?: (event: AgentEvent) => void;
    signal?: AbortSignal;
    bind?: (binding: import('@/bgsm-agent').BgsmAgentConversationBinding) => void;
    trace?: AgentExecutionTraceSink;
    contentCapture?: import('@/agent-harness').AgentContentCaptureSink;
  } = {},
): Promise<BgsmAgentTurnResult> {
  const { prompt, sessionId, baseRevision, turnAttemptId } = input;
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
    options.signal?.addEventListener("abort", abortFromOptions, { once: true });
  }
  try {
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
        newMessages: [],
      };
    };
    const preparedRuntimeProvider = await agentProviderGate.prepareRuntimeProvider();
    if (liveness.signal.aborted) return terminalAfterAbort();
    const conversation = await resolveBgsmAgentConversation(input, {
      providerFingerprint: preparedRuntimeProvider.fingerprint,
      resolveCandidate: (candidate) => resolveLiveLaunchCandidate(candidate),
    });
    if (liveness.signal.aborted) return terminalAfterAbort();
    const promptIntent = analyzeBgsmPromptIntent(prompt);
    const hasRepositoryCodeHistory = hasSuccessfulRepositoryCodeToolHistory(input.history);
    const repositoryCodeAccess = promptIntent.capabilities.repositoryCodeSearch
      || hasRepositoryCodeHistory;
    const repositoryCodeReadOnly = promptIntent.capabilities.repositoryCodeSearch
      || hasRepositoryCodeHistory;
    options.bind?.(conversation.binding);
    const runtimeProvider = preparedRuntimeProvider.create();
    let changed = false;
    let changedCount = 0;
    const authorization = createBgsmTurnAuthorization({
      ...promptIntent.capabilities,
      repositoryCodeSearch: repositoryCodeAccess,
      repositoryCodeReadOnly,
    });
    const repositoryScope = conversation.repositoryIds;
    const scopeLabel = conversation.binding.label;
    const scopeFingerprint = conversation.binding.scopeFingerprint;
    const conversationScope = createBgsmAgentPromptScope({
      kind: conversation.binding.candidateContract.kind,
      label: scopeLabel,
      repositoryIds: repositoryScope,
    });
    const executionLedger = new AgentExecutionLedger();
    let organizeLibraryHandoffRequested: BgsmAgentOrganizeLibraryAction | null = null;
    const repositoryCodeRefAuthority = repositoryCodeAccess
      ? repositoryCodeRefAuthorityFor(
          sessionId,
          scopeFingerprint,
        )
      : undefined;
    const activeOrganizeJob = await getActiveOrganizeJob();
    const organizeApplyActive = organizeApplyBlocksAgentWrites(activeOrganizeJob);
    if (liveness.signal.aborted) return terminalAfterAbort();
    const tools = authorization.wrapTools(createBgsmAgentTools({
      repositoryScope,
      scopeFingerprint,
      scopeLabel,
      enableRepositoryCodeSearch: repositoryCodeAccess,
      repositoryCodeRefAuthority,
      enableRepositoryNotes: promptIntent.capabilities.repositoryNotes,
      enableOrganizeLibraryHandoff: !repositoryCodeReadOnly,
      requestOrganizeLibraryHandoff: async (action) => {
        const currentOrganizeJob = await getActiveOrganizeJob();
        if (currentOrganizeJob) {
          return {
            status: 'blocked_by_existing_job',
            activeJobStatus: currentOrganizeJob.status,
          };
        }
        organizeLibraryHandoffRequested ??= action;
        return { status: 'accepted' };
      },
      assignManualTags: agentManualTagWriter,
      removeVisibleTags: agentVisibleTagRemovalWriter,
      deleteTagsEverywhere: agentGlobalTagDeletionWriter,
    }).filter((tool) => (
      tool.risk !== 'write'
      || (
        !repositoryCodeReadOnly
        && !organizeApplyActive
        && isDirectBgsmAgentTagWriteTool(tool.name)
      )
    ))).map((tool) =>
      wrapWriteTrackingTool(tool, (count) => {
        changed = true;
        changedCount += count;
      }),
    );

    const systemPrompt = buildBgsmAgentSystemPrompt({
      conversationScope,
      repositoryCodeReadOnly,
    });
    const provider = runtimeProvider.provider;
    const profile = resolveContextBudgetPolicy({
      capability: runtimeProvider.contextCapability,
      configuredWorkingWindow: runtimeProvider.workingContextWindow,
      requestedOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    const traceProvider = agentTraceProviderIdentity(runtimeProvider, profile.capabilityRevision);
    const prepared = await prepareBgsmAgentTurn({
      turn: input,
      systemPrompt,
      provider,
      tools,
      profile,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      liveness,
      signal: liveness.signal,
      emit: options.emit,
      trace: options.trace,
      traceProvider,
      contentCapture: options.contentCapture,
    });
    if (prepared.kind === "context_limit") {
      return {
        turnAttemptId,
        sessionId,
        baseRevision,
        reason: "context_limit",
        changed: false,
        changedCount: 0,
        newMessages: [],
        contextFailureReason: prepared.reason,
      };
    }
    if (prepared.kind === "aborted") {
      return terminalAfterAbort();
    }
    let activeCheckpoint = prepared.candidateCheckpoint ?? input.checkpoint;
    let checkpointToCommit = prepared.candidateCheckpoint;
    // A projection inherited from the previous session turn is already present
    // in `prepared.messages`; only a split in this raw turn may be fed back to
    // the active-turn compactor.
    let activeTurnProjection: BgsmAgentActiveProjection | undefined;
    let candidateActiveProjection: BgsmAgentActiveProjection | null | undefined =
      prepared.candidateCheckpoint ? null : undefined;
    const initialRawMessages = [prepared.messages.at(-1)!];
    if (
      initialRawMessages[0]?.role !== 'user'
      || initialRawMessages[0].content !== input.prompt
    ) {
      throw new TypeError('Cubby Provider projection must retain the original user prompt.');
    }
    const continueAfterContextPressure = async (
      continuation: Readonly<{
        messages: readonly import('@/agent-harness').AgentMessage[];
        rawMessages?: readonly import('@/agent-harness').AgentMessage[];
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
      const compacted = await compactBgsmAgentCompletedToolEnvelope({
        turn: input,
        systemPrompt,
        provider,
        tools,
        profile,
        maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
        currentProjectedMessages: [...continuation.messages],
        currentCheckpoint: activeCheckpoint,
        currentActiveProjection: activeTurnProjection,
        rawMessages: continuation.rawMessages,
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
          compacted.candidateCheckpoint &&
          compacted.candidateCheckpoint.summarizedMessageCount
            > (activeCheckpoint?.summarizedMessageCount ?? 0)
        ) {
          activeCheckpoint = compacted.candidateCheckpoint;
          checkpointToCommit = compacted.candidateCheckpoint;
        }
        if (compacted.activeProjection) {
          activeTurnProjection = compacted.activeProjection;
          candidateActiveProjection = compacted.activeProjection;
        }
        return { kind: 'ready' as const, messages: compacted.messages };
      }
      return compacted;
    };
    let result = await runAgentLoop({
      sessionId,
      provider,
      tools,
      emit: options.emit,
      liveness,
      signal: liveness.signal,
      permissions: authorization.permissions,
      maxSteps: 8,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      contextPolicy: profile,
      executionLedger,
      trace: options.trace,
      traceProvider,
      contentCapture: options.contentCapture,
      onToolEnvelopeSettled: continueAfterContextPressure,
      onContextOverflow: continueAfterContextPressure,
      messages: prepared.messages,
      rawMessages: initialRawMessages,
    });

    if (changed) broadcastDataChanged();

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
      await authStore.invalidateAgentProviderCapability(preparedRuntimeProvider.fingerprint);
    }
    const effectiveInput = activeCheckpoint
      ? { ...input, checkpoint: activeCheckpoint }
      : input;
    return {
      turnAttemptId,
      sessionId: result.sessionId,
      baseRevision,
      reason: effectiveReason,
      changed,
      changedCount,
      ...(contextFailureReason ? { contextFailureReason } : {}),
      ...(organizeLibraryHandoff ? { organizeLibraryHandoff } : {}),
      ...buildBgsmAgentTerminalPayload(
        { ...result, reason: effectiveReason },
        effectiveInput,
        checkpointToCommit,
        candidateActiveProjection,
      ),
    };
  } finally {
    options.signal?.removeEventListener("abort", abortFromOptions);
    liveness.dispose();
  }
}

function agentTraceProviderIdentity(
  provider: Readonly<{
    providerId: AgentProviderId;
    endpoint: Readonly<{ profile: Readonly<{ protocol: string }> }>;
  }>,
  modelCapabilityRevision: string,
): AgentTraceProviderIdentity {
  const providerClass = provider.providerId === 'custom-openai-compatible'
    ? 'custom'
    : provider.providerId;
  const protocol = provider.endpoint.profile.protocol === 'chat-completions'
    ? 'chat_completions'
    : provider.endpoint.profile.protocol === 'anthropic-messages'
      ? 'anthropic_messages'
      : 'responses';
  return Object.freeze({ providerClass, protocol, modelCapabilityRevision });
}

async function organizeAnalysisProviderBinding(provider: Readonly<{
  providerId: AgentProviderId;
  model: string;
  endpoint: Readonly<{
    completionEndpoint: string;
    profile: Readonly<{ protocol: string }>;
  }>;
  contextCapability: Readonly<{ capabilityRevision: string }>;
}>) {
  return Object.freeze({
    version: 1,
    provider: provider.providerId,
    model: provider.model,
    protocol: provider.endpoint.profile.protocol,
    capabilityRevision: provider.contextCapability.capabilityRevision,
    endpointFingerprint: `endpoint:v1:${await sha256Base64Url(provider.endpoint.completionEndpoint)}`,
  });
}

function repositoryCodeRefAuthorityFor(
  sessionId: string,
  scopeFingerprint: string,
): RepositoryCodeRefAuthority {
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
}

function wrapWriteTrackingTool(
  tool: AgentTool,
  markChanged: (count: number) => void,
): AgentTool {
  if (tool.risk !== "write") return tool;
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
  if (!result || typeof result !== "object") return 1;
  const value = result as {
    changed?: unknown;
    removed?: unknown;
    assignmentsRemoved?: unknown;
    requestedTags?: unknown;
  };
  if (typeof value.changed === "number") return Math.max(0, value.changed);
  if (typeof value.assignmentsRemoved === "number") {
    const requestedTags = typeof value.requestedTags === "number"
      ? value.requestedTags
      : 0;
    return Math.max(0, value.assignmentsRemoved, requestedTags);
  }
  if (typeof value.changed === "boolean") return value.changed ? 1 : 0;
  if (typeof value.removed === "boolean") return value.removed ? 1 : 0;
  if (typeof value.removed === "number") return Math.max(0, value.removed);
  return 1;
}

function isDirectBgsmAgentTagWriteTool(toolName: string): boolean {
  return toolName === 'assign_repo_tags'
    || toolName === 'remove_repo_tags'
    || toolName === 'delete_tags_everywhere';
}

function organizeApplyBlocksAgentWrites(job: OrganizeJobRecord | undefined): boolean {
  return !!job && ['apply_sealed', 'applying', 'paused'].includes(job.status);
}

const run = jobQueue.run;
const BACKFILL_STATUS_RECONCILE_MS = 30_000;
let lastStatusBackfillReconcileAt = 0;

async function getStatusConfigAndBackfills() {
  const now = Date.now();
  if (now - lastStatusBackfillReconcileAt >= BACKFILL_STATUS_RECONCILE_MS) {
    lastStatusBackfillReconcileAt = now;
    const backfills = await backfillConfig.reconcileStoredBackfills();
    const cfg = await authStore.getConfig();
    return { cfg, backfills };
  }
  const cfg = await authStore.getConfig();
  return { cfg, backfills: cfg.backfills };
}

async function getStatusPayload() {
  const { cfg, backfills } = await getStatusConfigAndBackfills();
  const hasToken = await authStore.hasToken();
  const onboardingStage = normalizeOnboardingStage(
    cfg.onboardingStage,
    cfg.seenOnboarding,
    hasToken,
  );
  if (
    onboardingStage !== cfg.onboardingStage ||
    stageMarksOnboardingSeen(onboardingStage) !== cfg.seenOnboarding
  ) {
    await authStore.update({
      onboardingStage,
      seenOnboarding: stageMarksOnboardingSeen(onboardingStage),
    });
  }
  return {
    progress:
      lastProgress.phase === "idle" && !lastProgress.message
        ? cfg.lastSyncProgress
        : lastProgress,
    hasToken,
    onboardingStage,
    seenOnboarding: stageMarksOnboardingSeen(onboardingStage),
    seenTooltips: cfg.seenTooltips,
    backfills,
    activeBackfillId: selectActiveBackfillId(backfills),
    inFlight: jobQueue.isRunning(),
  };
}

async function performFullSyncJob() {
  const m = await getLocaleMessages();
  setProgress({
    phase: "full",
    done: 0,
    total: null,
    message: m.background.fetchingPages(1),
  });
  const result = await githubStarSource.syncFull((p) => setProgress(p));
  broadcastDataChanged();
  setIdleMessage(m.background.fullDone(result.added));
  return result;
}

async function performFullSync() {
  return run(performFullSyncJob);
}

const backfillExecutor = createBackfillExecutor({
  jobQueue,
  setBackfillState: backfillConfig.setBackfillState,
  performFullSyncJob,
});

/**
 * One-shot migration: strip auto-derived `language` tags (language is now a
 * filter, not a tag). Uses setTags (bumps mtime → rides next gistPush) and
 * deliberately writes NO excluded tombstone — that would forbid manual re-adding;
 * we only want to stop auto-deriving. Flag + skip-already-cleaned → idempotent
 * and re-runnable; the flag flips only after the full pass succeeds.
 */
async function migrateLanguageTags(): Promise<void> {
  try {
    const cfg = await authStore.getConfig();
    if (cfg.langTagMigrationDone) return;
    const tagMetas = await db.tagMeta.toArray();
    const langMetas = tagMetas.filter((meta) => meta.dimension === "language");
    const toRemove = new Set(langMetas.map((meta) => canonicalTagKey(meta.name)));
    if (toRemove.size === 0) {
      await authStore.update({ langTagMigrationDone: true });
      return;
    }
    // Load all tag rows once, then iterate with awaited writes so each setTags
    // (which awaits IDB) completes before the next. Yield to the event loop every
    // 200 changed repos so the SW message channel / keepAlive can breathe on large
    // libraries — a long unbroken write chain can starve the SW's 30s lifecycle.
    const allTags = await db.tags.toArray();
    const excludedTagKeys = excludedCanonicalTagKeys(tagMetas);
    let changed = 0;
    for (const t of allTags) {
      const manualTags = manualTagNames(t);
      const next = manualTags.filter((name) => {
        const key = canonicalTagKey(name);
        return !toRemove.has(key) && !excludedTagKeys.has(key);
      });
      if (next.length === manualTags.length) continue; // already clean
      // setTags bumps mtime + marks dirty → next gistPush propagates the cleanup.
      await idbTagStore.setTags(t.full_name, next);
      if (++changed % 200 === 0) await Promise.resolve();
    }
    await authStore.update({ langTagMigrationDone: true });
    invalidateCache();
    broadcastDataChanged();
  } catch (e) {
    // Flag stays false → retries next SW wakeup. Never throw: must not block SW.
    console.error(
      "[GSM] language-tag migration failed (will retry):",
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function setStoredOnboardingStage(stage: OnboardingStage): Promise<void> {
  await authStore.update({
    onboardingStage: stage,
    seenOnboarding: stageMarksOnboardingSeen(stage),
  });
}

function recordProviderProbeStarted(requestId: string, startedAt: number): Promise<void> {
  return Promise.resolve(providerDiagnosticsRuntime?.recordProbeStarted(requestId, startedAt))
    .then(() => undefined)
    .catch(() => undefined);
}

function recordProviderProbeSucceeded(
  requestId: string,
  startedAt: number,
  result: AgentProviderConnectionResult,
): void {
  providerDiagnosticsRuntime?.recordProbeSucceeded(requestId, startedAt, result);
}

function recordProviderProbeFailure(
  requestId: string,
  startedAt: number,
  error: unknown,
): void {
  providerDiagnosticsRuntime?.recordProbeFailure(requestId, startedAt, error);
}

async function describeSafeAgentProviderConnectionFailure(error: unknown) {
  const failure = describeAgentProviderConnectionFailure(error);
  const settledSecrets = await Promise.allSettled([
    authStore.getToken(),
    authStore.getAgentApiKey(),
  ]);
  const secrets = settledSecrets.flatMap((result) => (
    result.status === "fulfilled" && result.value ? [result.value] : []
  ));
  return scrubAgentProviderConnectionFailure(failure, secrets);
}

async function handle(req: Req): Promise<Res> {
  try {
    switch (req.type) {
      case "syncIncremental": {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken()))
          return { ok: false, error: m.background.noToken };
        const result = await run(async () => {
          setProgress({
            phase: "incremental",
            done: 0,
            total: null,
            message: m.background.incrementalSyncing,
          });
          return githubStarSource.syncIncremental();
        });
        broadcastDataChanged();
        setIdleMessage(m.background.incrementalDone(result.added));
        return { ok: true, data: { ...result, tagged: 0 } };
      }
      case "syncFull": {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken()))
          return { ok: false, error: m.background.noToken };
        const result = await performFullSync();
        return { ok: true, data: { ...result, tagged: 0 } };
      }
      case "syncRescan": {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken()))
          return { ok: false, error: m.background.noToken };
        const result = await run(async () => {
          setProgress({
            phase: "rescan",
            done: 0,
            total: null,
            message: m.background.rescanningPages(1),
          });
          return githubStarSource.syncRescan((p) => setProgress(p));
        });
        broadcastDataChanged();
        setIdleMessage(
          m.background.rescanDone(result.tombstoned, result.revived),
        );
        return { ok: true, data: result };
      }
      case "autoAssignTags": {
        const m = await getLocaleMessages();
        const t = await run(async () => {
          setProgress({
            phase: "incremental",
            done: 0,
            total: null,
            message: m.background.autoAssignTagging,
          });
          return autoTagAll(
            m.background.autoAssignTagging,
            (p) => setProgress(p),
            "incremental",
          );
        });
        broadcastDataChanged();
        setIdleMessage(m.background.autoAssignDone(t.tagged));
        return { ok: true, data: t };
      }
      case "gistPush": {
        const m = await getLocaleMessages();
        const r = await run(async () => {
          setProgress({
            phase: "gist",
            done: 0,
            total: null,
            message: m.background.pushingTags,
          });
          const result = await idbTagStore.syncPush((done, total) => {
            setProgress({
              phase: "gist",
              done,
              total,
              message: m.background.pushingTags,
            });
          });
          if (result.pushed > 0)
            setIdleMessage(m.background.gistPushDone(result.pushed));
          else if (result.recreated)
            setIdleMessage(m.background.gistPushRecreated);
          else setIdleMessage(m.background.gistPushNoChanges);
          return result;
        });
        return { ok: true, data: r };
      }
      case "gistPull": {
        const m = await getLocaleMessages();
        const r = await run(async () => {
          setProgress({
            phase: "gist",
            done: 0,
            total: null,
            message: m.background.pullingTags,
          });
          return idbTagStore.syncPull((done, total) => {
            setProgress({
              phase: "gist",
              done,
              total,
              message: m.background.pullingTags,
            });
          });
        });
        broadcastDataChanged();
        if (r.missing) setIdleMessage(m.background.gistPullMissing);
        else setIdleMessage(m.background.gistPullDone(r.merged, r.total));
        return { ok: true, data: r };
      }
      case "getStatus":
        return { ok: true, data: await getStatusPayload() };
      case "getUsername":
        return { ok: true, data: { username: await authStore.getUsername() } };
      case "getAccount":
        return { ok: true, data: await authStore.getAccount() };
      case "fetchAccount": {
        // Backfill avatar/displayName; no-op without token.
        const token = await authStore.getToken();
        if (!token) return { ok: true, data: await authStore.getAccount() };
        try {
          const res = await fetch("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
            cache: "no-store",
          });
          if (!res.ok) return { ok: true, data: await authStore.getAccount() };
          const body = (await res.json()) as {
            login?: string;
            avatar_url?: string;
            name?: string | null;
          };
          await authStore.update({
            username: body.login ?? (await authStore.getUsername()),
            avatarUrl: body.avatar_url ?? null,
            displayName: body.name ?? null,
          });
          return { ok: true, data: await authStore.getAccount() };
        } catch {
          return { ok: true, data: await authStore.getAccount() };
        }
      }
      case "query":
        return {
          ok: true,
          data: (await queryStars(req.params)) as QueryResult,
        };
      case "runBackfill": {
        const m = await getLocaleMessages();
        const task = getBackfillTask(req.id);
        if (!task)
          return { ok: false, error: m.background.unknownBackfill(req.id) };
        if (task.kind !== "full_sync")
          return {
            ok: false,
            error: m.background.unsupportedBackfillKind(task.kind),
          };
        if (!(await authStore.hasToken()))
          return { ok: false, error: m.background.noToken };
        return await backfillExecutor.runBackfill(task, (error) =>
          translateError(error, m),
        );
      }
      case "deferBackfill": {
        const m = await getLocaleMessages();
        const task = getBackfillTask(req.id);
        if (!task)
          return { ok: false, error: m.background.unknownBackfill(req.id) };
        await backfillConfig.setBackfillState(task.id, (current, now) => {
          if (current?.status === "done") return current;
          return {
            status: "deferred",
            queuedAt: current?.queuedAt ?? now,
            lastAttemptAt: current?.lastAttemptAt ?? null,
            completedAt: null,
            error: current?.error ?? null,
          };
        });
        return { ok: true, data: { id: task.id } };
      }
      case "setTags":
        await run(() => idbTagStore.setTags(req.full_name, req.tags));
        broadcastDataChanged();
        return { ok: true };
      case "setNotes":
        await run(() => idbTagStore.setNotes(req.full_name, req.notes));
        broadcastDataChanged();
        return { ok: true };
      case "setFavorite":
        await run(() => idbTagStore.setFavorite(req.full_name, req.favorite));
        broadcastDataChanged();
        return { ok: true, data: { favorite: req.favorite } };
      case "markUnstarred": {
        const result = await run(async () => {
          const star = await db.stars.get(req.full_name);
          if (!star) return null;
          await githubStarSource.unstar(req.full_name);
          await db.stars.put({ ...star, tombstone: true });
          return { full_name: req.full_name, tombstone: true };
        });
        if (!result)
          return { ok: false, error: `Unknown repo: ${req.full_name}` };
        broadcastDataChanged();
        return { ok: true, data: result };
      }
      case "removeVisibleTag": {
        const r = await run(() => idbTagStore.removeVisibleTag(req.full_name, req.name));
        broadcastDataChanged();
        return { ok: true, data: r };
      }
      case "deleteTag": {
        // Remove this tag from every repo that has it and leave a tombstone.
        const r = await run(() => idbTagStore.deleteTag(req.name));
        broadcastDataChanged();
        return { ok: true, data: r };
      }
      case "deleteAllTags": {
        const r = await run(() => idbTagStore.deleteAllTags());
        broadcastDataChanged();
        return { ok: true, data: r };
      }
      case "acceptSuggestions": {
        const tags = await run(async () => {
          const excludedTagKeys = new Set(
            (await idbTagStore.listExcluded()).map(canonicalTagKey),
          );
          const existingTag = await idbTagStore.get(req.full_name);
          const existing = manualTagNames(existingTag)
            .filter((name) => !excludedTagKeys.has(canonicalTagKey(name)));
          const additions = req.toAdd
            .filter((name) => !excludedTagKeys.has(canonicalTagKey(name)));
          const merged = addTagNames(existing, additions);
          await idbTagStore.setTags(req.full_name, merged);
          return visibleTagNames(await idbTagStore.get(req.full_name));
        });
        broadcastDataChanged();
        return {
          ok: true,
          data: { tags },
        };
      }
      case "suggestTags": {
        return { ok: true };
      }
      case "testConnection": {
        // Diagnostic: pull one page of /user/starred, return raw status+headers, never throws.
        const token = await authStore.getToken();
        if (!token)
          return {
            ok: false,
            error: (await getLocaleMessages()).background.noToken,
          };
        try {
          const res = await fetch(
            "https://api.github.com/user/starred?per_page=1&page=1",
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github.star+json",
              },
              cache: "no-store",
            },
          );
          const body = res.status === 200 ? await res.json() : null;
          return {
            ok: true,
            data: {
              status: res.status,
              statusText: res.statusText,
              remaining: res.headers.get("x-ratelimit-remaining"),
              limit: res.headers.get("x-ratelimit-limit"),
              scopes: res.headers.get("x-oauth-scopes"),
              itemCount: Array.isArray(body) ? body.length : 0,
              sample: Array.isArray(body) && body[0] ? body[0].full_name : null,
            },
          };
        } catch (e) {
          return {
            ok: false,
            error: `fetch failed: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      case "testAgentProviderConnection": {
        const probeStartedAt = Date.now();
        const probeRequestId = `provider_probe:${crypto.randomUUID()}`;
        const probeStartObserved = recordProviderProbeStarted(probeRequestId, probeStartedAt);
        try {
          const result = await agentProviderGate.testConnection(req);
          void probeStartObserved.then(() => recordProviderProbeSucceeded(
            probeRequestId,
            probeStartedAt,
            result,
          ));
          return { ok: true, data: result };
        } catch (error) {
          void probeStartObserved.then(() => recordProviderProbeFailure(
            probeRequestId,
            probeStartedAt,
            error,
          ));
          const [messages, details] = await Promise.all([
            getLocaleMessages(),
            describeSafeAgentProviderConnectionFailure(error),
          ]);
          return {
            ok: false,
            error: translateError(error, messages),
            details,
          };
        }
      }
      case "openOptions": {
        // Content scripts have a restricted chrome.runtime without openOptionsPage, so they ask the background.
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      }
      case "devClearLocalData": {
        const result = await run(clearLocalDataForDev);
        return { ok: true, data: result };
      }
      case "getTag": {
        return {
          ok: true,
          data: { tag: (await idbTagStore.get(req.full_name)) ?? null },
        };
      }
      case "listExcluded":
        return { ok: true, data: await idbTagStore.listExcluded() };
      case "markOnboardingSeen":
        await setStoredOnboardingStage("done");
        return { ok: true };
      case "setOnboardingStage":
        await setStoredOnboardingStage(req.stage);
        return { ok: true };
      case "markTooltipSeen": {
        const cur = (await authStore.getConfig()).seenTooltips;
        await authStore.update({ seenTooltips: cur | req.bit });
        return { ok: true, data: { seenTooltips: cur | req.bit } };
      }
      case "acceptSuggestionsBatch": {
        const n = await run(async () => {
          const excludedTagKeys = new Set(
            (await idbTagStore.listExcluded()).map(canonicalTagKey),
          );
          let updated = 0;
          for (const item of req.items) {
            if (item.toAdd.length === 0) continue;
            const existing = manualTagNames(
              await idbTagStore.get(item.full_name),
            ).filter((name) => !excludedTagKeys.has(canonicalTagKey(name)));
            const additions = item.toAdd
              .filter((name) => !excludedTagKeys.has(canonicalTagKey(name)));
            const merged = addTagNames(existing, additions);
            if (merged.length !== existing.length) {
              await idbTagStore.setTags(item.full_name, merged);
              updated++;
            }
          }
          return updated;
        });
        broadcastDataChanged();
        return { ok: true, data: { count: n } };
      }
    }
    return { ok: false, error: 'Unsupported background request.' };
  } catch (e) {
    const msg = translateError(e, await getLocaleMessages());
    setProgress({ phase: "idle", done: 0, total: null, message: `${msg}` });
    return { ok: false, error: msg };
  }
}

chrome.runtime.onMessage.addListener((req: Req, _sender, sendResponse) => {
  handle(req).then(sendResponse);
  return true; // async response
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bgsm-agent-organize-job") return;
  let portConnection: BgsmOrganizeJobConnection<chrome.runtime.Port> | null = null;
  let portIdentity: { controllerId: BgsmOrganizeJobClientMessage['controllerId']; sessionId: string } | null = null;
  let disconnectSettled = false;

  const bindOrAcceptPort = (identity: Readonly<{
    controllerId: BgsmOrganizeJobClientMessage['controllerId'];
    sessionId: string;
  }>): boolean => {
    const bound = organizeJobRunConnections.bind(port, identity);
    if (bound.status === 'identity_mismatch') {
      port.disconnect();
      return false;
    }
    if (bound.status === 'stale') return false;
    portConnection = bound.connection;
    portIdentity = { controllerId: identity.controllerId, sessionId: identity.sessionId };
    if (bound.status === 'bound') {
      safeOrganizeJobRunPost(port, {
        type: 'bgsmOrganizeJobRunConnectionReady',
        controllerId: identity.controllerId,
        sessionId: identity.sessionId,
      }, { kind: 'authoritative_snapshot' });
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
            const taxonomyBundle = await loadOrganizeJobRunTaxonomy();
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
            const replacedIdentity = {
              controllerId: message.controllerId,
              sessionId: message.sessionId,
              runId: parseRunId(replacedJob.runId),
              generation: replacedJob.generation,
            };
            organizeJobRunScheduler.abort(replacedIdentity.runId);
            const inMemory = organizeJobRunController.findLatestSnapshot(replacedIdentity);
            if (
              inMemory?.runId === replacedIdentity.runId
              && inMemory.generation === replacedIdentity.generation
            ) {
              organizeJobRunController.stopRun(replacedIdentity);
            }
            if (!await cancelOrganizeJob(replacedJob.jobId)) {
              throw new TypeError("Blocked OrganizeJobRun replacement could not cancel the previous job.");
            }
            organizeJobRunScheduler.release(replacedIdentity.runId);
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
        safeOrganizeJobRunPost(port, { type: "bgsmOrganizeJobRunSnapshot", snapshot }, {
          kind: 'authoritative_snapshot',
          durableRevision: activated.job.revision,
        });
        await publishOrganizeJobState(
          activated.job.jobId,
          port,
          'authoritative_snapshot',
        );
        return;
      }
      if (message.type === "cancelBgsmOrganizeJobPreflight") {
        organizeJobRunController.cancelPreflight(message, message.requestId);
        await cancelOrganizePreflight(message);
        return;
      }
      if (message.type === "requestBgsmActiveOrganizeJob") {
        const snapshot = await restoreDurableOrganizeJob(message);
        if (snapshot) {
          const job = await getOrganizeJobForRun(snapshot.runId, snapshot.generation);
          safeOrganizeJobRunPost(port, { type: "bgsmOrganizeJobRunSnapshot", snapshot }, {
            kind: 'authoritative_snapshot',
            durableRevision: job?.revision ?? null,
          });
          if (job) await publishOrganizeJobState(job.jobId, port, 'authoritative_snapshot');
        }
        await replayOrganizeJobRunInMemoryAuthority(port, message);
        return;
      }
      if (message.type === "requestBgsmOrganizeJobSnapshot") {
        try {
          organizeJobRunController.getSnapshot(message);
        } catch {
          await restoreDurableOrganizeJob(message);
        }
        const job = await getOrganizeJobForRun(message.runId, message.generation);
        await resolveBgsmOrganizeJobReconnect({
          identity: message,
          controller: organizeJobRunController,
          post: (response) => safeOrganizeJobRunPost(port, response, {
            kind: 'authoritative_snapshot',
            durableRevision: job?.revision ?? null,
          }),
        });
        if (job) await publishOrganizeJobState(job.jobId, port, 'authoritative_snapshot');
        await replayOrganizeJobRunInMemoryAuthority(port, message);
        return;
      }
      if (message.type === "requestBgsmOrganizeReviewPage") {
        const job = await requireOrganizeMessageJob(message);
        await postOrganizeReviewPage(port, job, message.requestId, message.rowOffset, message.limit);
        return;
      }
      if (message.type === "updateBgsmOrganizeSelection") {
        const job = await requireOrganizeMessageJob(message);
        const updated = await updateOrganizeSelection({
          jobId: job.jobId,
          expectedRevision: message.expectedRevision,
          selections: message.selections,
        });
        await recordOrganizeSelection(updated, job.revision, "partial", message.selections.length);
        await publishOrganizeJobState(updated.jobId, port);
        await postOrganizeReviewPage(port, updated, message.requestId, message.rowOffset, 100);
        return;
      }
      if (message.type === "setAllBgsmOrganizeSelections") {
        const job = await requireOrganizeMessageJob(message);
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
        await publishOrganizeJobState(updated.jobId, port);
        await postOrganizeReviewPage(port, updated, message.requestId, message.rowOffset, 100);
        return;
      }
      if (message.type === "applyBgsmOrganizeSelection") {
        const apply = await jobQueue.run(async () => {
          const job = await requireOrganizeMessageJob(message);
          return sealOrganizeApply(job.jobId, message.expectedRevision);
        });
        await publishOrganizeJobState(apply.jobId, port);
        void pumpOrganizeApply(apply.applyId);
        return;
      }
      if (message.type === "resumeBgsmOrganizeApply") {
        const job = await requireOrganizeMessageJob(message);
        const resumed = await resumeOrganizeApply(job.jobId, message.expectedRevision);
        await publishOrganizeJobState(resumed.jobId, port, "live", "resumed");
        void pumpOrganizeApply(resumed.applyId!);
        return;
      }
      if (message.type === "dismissBgsmOrganizeReceipt") {
        const job = await requireOrganizeMessageJob(message);
        if (job.status !== "completed" || job.applyId !== message.applyId) {
          throw new TypeError("Organize receipt dismissal authority is stale.");
        }
        const progress = await getOrganizeApplyProgress(message.applyId);
        if (!progress) throw new TypeError("Organize receipt is unavailable.");
        if (await dismissOrganizeReceipt(message.applyId)) {
          organizeJobRunTraceCoordinator.recordReceipt(parseOrganizeJobId(job.jobId), {
            applyId: message.applyId,
            state: "dismissed",
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
        return;
      }
      if (message.type === "requestBgsmOrganizeReceiptPage") {
        const job = await requireOrganizeMessageJob(message);
        if (job.applyId !== message.applyId) throw new TypeError("Receipt does not belong to this organize job.");
        await postOrganizeReceiptPage(
          port,
          job,
          message.requestId,
          message.rowOffset,
          message.limit,
          message.filter,
        );
        return;
      }
      if (message.type === "stopBgsmOrganizeJob") {
        await restoreDurableOrganizeJob(message);
        const durableJob = await getOrganizeJobForRun(message.runId, message.generation);
        if (durableJob && ['apply_sealed', 'applying', 'paused'].includes(durableJob.status)) {
          const paused = await requestOrganizeApplyPause(durableJob.jobId);
          await publishOrganizeJobState(
            paused.jobId,
            port,
            "live",
            paused.status === "paused" ? "paused" : "pause_requested",
          );
          safeOrganizeJobRunPost(port, {
            type: "bgsmOrganizeJobRunResult",
            controllerId: message.controllerId,
            sessionId: message.sessionId,
            runId: message.runId,
            generation: message.generation,
            snapshot: organizeJobRunController.getSnapshot(message),
          }, { durableRevision: paused.revision });
          return;
        }
        organizeJobRunScheduler.abort(message.runId);
        const snapshot = organizeJobRunController.stopRun(message);
        if (durableJob && await cancelOrganizeJob(durableJob.jobId)) {
          organizeJobRunTraceCoordinator.cancelFamily(
            parseOrganizeJobId(durableJob.jobId),
            "user_stopped",
            "user",
          );
        }
        safeOrganizeJobRunPost(port, {
          type: "bgsmOrganizeJobRunResult",
          controllerId: message.controllerId,
          sessionId: message.sessionId,
          runId: message.runId,
          generation: message.generation,
          snapshot,
        });
        return;
      }
      if (message.type === "continueBgsmOrganizeJob") {
        const restored = await restoreDurableOrganizeJob(message);
        if (restored && ['frozen', 'prepared', 'checking_provider', 'analyzing'].includes(restored.state)) {
          const restoredJob = await getOrganizeJobForRun(restored.runId, restored.generation);
          safeOrganizeJobRunPost(port, { type: "bgsmOrganizeJobRunSnapshot", snapshot: restored }, {
            kind: "authoritative_snapshot",
            durableRevision: restoredJob?.revision ?? null,
          });
          if (restoredJob) {
            await publishOrganizeJobState(restoredJob.jobId, port, "authoritative_snapshot");
          }
          return;
        }
        // Validate the parent authority before retrying the durable suffix. A stale
        // command must not leave the job marked analyzing without a child runner.
        organizeJobRunController.getSnapshot(message);
        const parentState = organizeJobRunScheduler.getState(message.runId);
        if (
          !parentState ||
          (
            parentState.status !== "analysis_blocked" &&
            parentState.status !== "budget_exhausted" &&
            parentState.stopReason !== "proposal_limit"
          )
        ) {
          postOrganizeJobRunError(port, message, "stale_generation", "Continuation authority is stale.");
          return;
        }
        const cursor = await resolveContinuationCursor(message.continuationCursor, {
          runId: message.runId,
          generation: message.generation,
          scopeCount: parentState.frozenScope.count,
          minimumNextFrozenIndex: parentState.status === "analysis_blocked"
            ? parentState.startFrozenIndex
            : parentState.nextFrozenIndex,
          authKey: organizeJobRunCursorAuthKey,
        });
        const organizeJob = await getOrganizeJobForRun(message.runId, message.generation);
        if (organizeJob?.status === "analysis_blocked") {
          await retryOrganizeAnalysisFromFirstFailure(organizeJob.jobId);
        }
        await organizeJobRunScheduler.continueRun(
          message,
          cursor.nextFrozenIndex,
          message.continuationCursor,
        );
        return;
      }
      if (message.type === "disconnectBgsmOrganizeJob") {
        disconnectSettled = true;
        if (await shouldPreserveDurableOrganizeController(message)) {
          releasePortConnection();
          return;
        }
        await settleBgsmOrganizeJobDisconnect({
          identity: message,
          controller: organizeJobRunController,
          abortRun: (runId) => organizeJobRunScheduler.abort(parseRunId(runId)),
          releaseRuns: (runIds) => {
            for (const runId of runIds) organizeJobRunScheduler.release(parseRunId(runId));
          },
          post: (result) => safeOrganizeJobRunPost(port, result),
        });
        releasePortConnection();
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
    }
  };

  port.onMessage.addListener((message: BgsmOrganizeJobClientMessage) => {
    if (
      message.type === "requestBgsmOrganizeJobPreflight" ||
      message.type === "cancelBgsmOrganizeJobPreflight"
    ) {
      void handleOrganizeJobRunMessage(message);
      return;
    }
    organizeJobRunMutationTail = organizeJobRunMutationTail.then(
      () => handleOrganizeJobRunMessage(message),
      () => handleOrganizeJobRunMessage(message),
    );
  });
  port.onDisconnect.addListener(() => {
    const connection = organizeJobRunConnections.markDisconnected(port);
    if (!connection) return;
    if (!organizeJobRunConnections.ownsIdentity(connection) || disconnectSettled || !portIdentity) {
      releasePortConnection();
      return;
    }
    disconnectSettled = true;
    const settle = async (): Promise<void> => {
      if (!organizeJobRunConnections.ownsIdentity(connection)) return;
      try {
        if (!await shouldPreserveDurableOrganizeController(portIdentity!)) {
          if (!organizeJobRunConnections.ownsIdentity(connection)) return;
          await settleBgsmOrganizeJobDisconnect({
            identity: portIdentity!,
            controller: organizeJobRunController,
            abortRun: (runId) => organizeJobRunScheduler.abort(parseRunId(runId)),
            releaseRuns: (runIds) => {
              for (const runId of runIds) organizeJobRunScheduler.release(parseRunId(runId));
            },
          });
        }
      } finally {
        releasePortConnection();
      }
    };
    void organizeJobRunMutationTail.then(settle, settle);
  });
});

const bgsmAgentTurnRegistry = createBgsmAgentTurnRegistry({
  runTurn: (input, options) => runBgsmAgentTurn(input, options),
  translateError: async (error) => translateError(error, await getLocaleMessages()),
  traceFactory: DEV ? createDevAgentTurnTraceFactory({
    observeExecutionEvent: ({ rootOperationId, event }) => {
      providerDiagnosticsRuntime?.observeExecutionEvent(rootOperationId, event);
    },
  }) : undefined,
  contentCaptureFactory: DEV && devRawCaptureCoordinator
    ? (input) => devRawCaptureCoordinator.beginRoot(input)
    : undefined,
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bgsm-agent") return;
  attachBgsmAgentTurnPort(port, bgsmAgentTurnRegistry);
});

chrome.runtime.onConnect.addListener((port) => {
  if (DEV || port.name === "bgsm-agent" || port.name === "bgsm-agent-organize-job") return;
  // Release builds fail closed for undeclared extension Port protocols.
  port.disconnect();
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
  safeOrganizeJobRunPost(port, {
    type: "bgsmOrganizeJobRunError",
    controllerId: identity.controllerId,
    sessionId: identity.sessionId,
    runId: identity.runId ?? null,
    generation: identity.generation ?? null,
    reason,
    message: boundOrganizeJobRunError(detail),
    ...(identity.requestId ? { requestId: identity.requestId } : {}),
  });
}

function classifyOrganizeJobRunError(error: unknown): BgsmOrganizeJobErrorReason {
  const message = error instanceof Error ? error.message : "";
  if (/already consumed/u.test(message)) return "preflight_replayed";
  if (/preflight.*stale|stale.*preflight/u.test(message)) return "preflight_stale";
  if (/preflight/u.test(message)) return "preflight_invalid";
  if (/active OrganizeJobRun/u.test(message)) return "already_started";
  if (/stale|does not belong/u.test(message)) return "stale_generation";
  return "internal_error";
}

function boundOrganizeJobRunError(detail: string): string {
  const value = detail.trim() || "BGSM OrganizeJobRun failed.";
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= 4_096) return value;
  let bounded = "";
  for (const codePoint of value) {
    if (encoder.encode(bounded + codePoint).byteLength > 4_096) break;
    bounded += codePoint;
  }
  return bounded;
}

async function shouldPreserveDurableOrganizeController(identity: Readonly<{
  controllerId: BgsmOrganizeJobClientMessage['controllerId'];
  sessionId: string;
}>): Promise<boolean> {
  const job = await getActiveOrganizeJob();
  if (job && job.controllerId === identity.controllerId && job.sessionId === identity.sessionId) {
    return true;
  }
  return !!await getReadyOrganizePreflight(identity);
}

async function buildOrganizeJobPresentation(
  job: OrganizeJobRecord,
): Promise<BgsmOrganizeJobPresentation> {
  if (job.status === 'preflight_ready') {
    throw new TypeError('A preflight cannot be presented as an active organize job.');
  }
  const [coverage, selection, apply] = await Promise.all([
    getOrganizeCoverage(job.jobId),
    getOrganizeSelectionSummary(job.jobId),
    job.applyId ? getOrganizeApplyProgress(job.applyId) : Promise.resolve(undefined),
  ]);
  return Object.freeze({
    controllerId: job.controllerId as BgsmOrganizeJobPresentation['controllerId'],
    sessionId: job.sessionId,
    runId: parseRunId(job.runId),
    generation: job.generation,
    jobId: job.jobId,
    revision: job.revision,
    status: job.status,
    scopeLabel: job.frozenScope.label,
    scopeCount: job.itemCount,
    capturedAt: job.frozenScope.capturedAt,
    proposalId: parseProposalId(job.proposalId),
    coverage: Object.freeze({
      total: coverage.total,
      analyzed: coverage.analyzed,
      actionable: coverage.actionable,
      unchanged: coverage.unchanged,
      insufficientEvidence: coverage.insufficientEvidence,
      missing: coverage.missing,
      tombstoned: coverage.tombstoned,
      analysisFailed: coverage.failed,
    }),
    selectedRepositories: selection.selectedRepositories,
    selectedActions: selection.selectedActions,
    apply: apply ? Object.freeze({ ...apply }) : null,
  });
}

async function publishOrganizeJobState(
  jobId: string,
  explicitPort?: chrome.runtime.Port,
  deliveryKind: BgsmOrganizeJobDeliveryKind = 'live',
  applyStateOverride?: 'resumed' | 'pause_requested' | 'paused',
): Promise<void> {
  const job = await getOrganizeJob(jobId);
  if (!job) return;
  organizeJobRunTraceCoordinator.recordDurableState(parseOrganizeJobId(job.jobId), {
    revision: job.revision,
    source: deliveryKind === 'authoritative_snapshot' ? 'reconnect' : 'mutation',
  });
  const presentation = await buildOrganizeJobPresentation(job);
  recordOrganizeJobPresentation(job, presentation, applyStateOverride);
  const port = explicitPort ?? currentOrganizeJobRunPort(parseControllerId(job.controllerId), job.sessionId);
  safeOrganizeJobRunPost(port, {
    type: 'bgsmOrganizeJobState',
    controllerId: presentation.controllerId,
    sessionId: presentation.sessionId,
    runId: presentation.runId,
    generation: presentation.generation,
    presentation,
  }, { kind: deliveryKind, durableRevision: job.revision });
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

async function requireOrganizeMessageJob(message: Readonly<{
  controllerId: BgsmOrganizeJobClientMessage['controllerId'];
  sessionId: string;
  runId: OrganizeRunIdentity['runId'];
  generation: number;
  jobId: string;
}>): Promise<OrganizeJobRecord> {
  const job = await getOrganizeJob(message.jobId);
  if (
    !job ||
    job.controllerId !== message.controllerId ||
    job.sessionId !== message.sessionId ||
    job.runId !== message.runId ||
    job.generation !== message.generation
  ) throw new TypeError('Organize job authority is stale.');
  return job;
}

async function postOrganizeReviewPage(
  port: chrome.runtime.Port,
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
    controllerId: job.controllerId as BgsmOrganizeJobPresentation['controllerId'],
    sessionId: job.sessionId,
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
    controllerId: job.controllerId as BgsmOrganizeJobPresentation['controllerId'],
    sessionId: job.sessionId,
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

async function restoreDurableOrganizeJob(identity: Readonly<{
  controllerId: BgsmOrganizeJobClientMessage['controllerId'];
  sessionId: string;
  runId?: OrganizeRunIdentity['runId'];
  generation?: number;
}>, options: Readonly<{
  force?: boolean;
  schedule?: boolean;
  coordinated?: boolean;
}> = {}): Promise<OrganizeJobRunSnapshot | null> {
  const existing = organizeJobRunController.findLatestSnapshot(identity);
  if (
    !options.force &&
    existing &&
    (identity.runId === undefined ||
      (existing.runId === identity.runId && existing.generation === identity.generation))
  ) {
    const durable = await getOrganizeJobForRun(existing.runId, existing.generation);
    const poisonedBlockedRetry = durable?.status === 'analyzing'
      && existing.state === 'analysis_blocked';
    if (!poisonedBlockedRetry) return existing;
  }

  const found = identity.runId
    ? await getOrganizeJobForRun(identity.runId, identity.generation)
    : await getActiveOrganizeJob() ?? await getLatestOrganizeJob();
  if (!found || ![
    'analyzing',
    'analysis_blocked',
    'review',
    'apply_sealed',
    'applying',
    'paused',
    'completed',
  ].includes(found.status) || (found.status === 'completed' && !found.applyId)) return null;
  const requestedByOwner = found.controllerId === identity.controllerId &&
    found.sessionId === identity.sessionId;
  if (
    !requestedByOwner &&
    currentOrganizeJobRunPort(parseControllerId(found.controllerId), found.sessionId)
  ) {
    throw new TypeError('An active OrganizeJobRun is already connected in another tab.');
  }

  if (!options.coordinated) {
    const activeFlight = organizeJobRestoreFlights.get(found.jobId);
    if (activeFlight) {
      const snapshot = await activeFlight;
      if (
        !snapshot ||
        (snapshot.controllerId === identity.controllerId && snapshot.sessionId === identity.sessionId)
      ) return snapshot;
      return restoreDurableOrganizeJob(identity, { ...options });
    }
    const flight = restoreDurableOrganizeJob(identity, {
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
    const attached = await attachOrganizeJobForController(restored.job, identity);
    const state = buildRestoredOrganizeAnalysisState(
      attached,
      restored.items,
      restored.taxonomy.fingerprint,
    );
    const runIdentity: OrganizeRunIdentity = {
      controllerId: identity.controllerId,
      sessionId: identity.sessionId,
      runId: parseRunId(restored.job.runId),
      generation: restored.job.generation,
    };
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
    organizeJobRunTraceCoordinator.recordGeneration(
      restoredJobId,
      snapshot,
      {
        state: "restored",
        cause: "restore",
        parentRunId: null,
        parentGeneration: null,
      },
    );
    organizeJobRunScheduler.seedRestoredState(runIdentity.runId, state);
    if (state.status === 'analyzing' && options.schedule !== false) {
      void organizeJobRunScheduler.schedule(runIdentity).catch((error: unknown) => {
        console.error(
          '[GSM] Restored OrganizeJobRun schedule failed:',
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    if (attached.applyId && ['apply_sealed', 'applying'].includes(attached.status)) {
      void pumpOrganizeApply(attached.applyId);
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
      organizeJobRunScheduler.abort(parseRunId(found.runId));
      organizeJobRunScheduler.release(parseRunId(found.runId));
      if (pendingDurableOrganizeJobId === found.jobId) pendingDurableOrganizeJobId = null;
      organizeJobRunTraceCoordinator.cancelFamily(
        restoredJobId,
        'checkpoint_invalid_discarded',
        'runtime',
      );
      throw new TypeError(
        'Stored OrganizeJobRun checkpoint was invalid and has been discarded. Start analysis again.',
      );
    }
    await organizeJobRunTraceCoordinator.flush(restoredJobId);
    throw error;
  }
}

function classifyOrganizeRestoreFailure(
  error: unknown,
): 'checkpoint_invariant' | 'checkpoint_missing' | 'storage_unavailable' | 'unknown' {
  const message = error instanceof Error ? error.message : '';
  if (
    error instanceof TypeError
    || error instanceof RangeError
    || /invalid|malformed|stale|contiguous|FrozenScope|ledger|fingerprint/u.test(message)
  ) return 'checkpoint_invariant';
  if (/missing|Unknown organize job/u.test(message)) return 'checkpoint_missing';
  const name = error instanceof Error ? error.name : '';
  if (/Database|Transaction|Quota|Abort|InvalidState|UnknownError/u.test(name)) {
    return 'storage_unavailable';
  }
  return 'unknown';
}

async function attachOrganizeJobForController(
  job: OrganizeJobRecord,
  identity: Pick<OrganizeRunIdentity, 'controllerId' | 'sessionId'>,
) {
  return attachOrganizeJob({
    jobId: job.jobId,
    controllerId: identity.controllerId,
    sessionId: identity.sessionId,
    expectedRevision: job.revision,
  });
}

function buildRestoredOrganizeAnalysisState(
  job: OrganizeJobRecord,
  items: readonly OrganizeItemRecord[],
  taxonomyFingerprintValue: string,
): OrganizeJobRunAnalysisState {
  if (job.frozenScope.kind !== 'all_live_stars' || typeof job.frozenScope.filterSnapshot !== 'string') {
    throw new TypeError('Stored organize FrozenScope is invalid.');
  }
  const runId = parseRunId(job.runId);
  const proposalId = parseProposalId(job.proposalId);
  const taxonomyFingerprint = items.find((row) => row.analysisState === 'actionable')
    ? parseTaxonomyFingerprintV1(taxonomyFingerprintValue)
    : null;
  const analyzed = items
    .filter((row) => row.analysisState !== 'pending' && row.analysisState !== 'leased')
    .map((row) => ({
      frozenIndex: row.position,
      repositoryId: row.fullName,
      classification: row.analysisState === 'actionable' ? 'actionable' as const : 'non_actionable' as const,
    }));
  const nonActionable: NonActionableAnalysisOutcome[] = items.flatMap((row) => {
    if (row.analysisState === 'pending' || row.analysisState === 'leased' || row.analysisState === 'actionable') {
      return [];
    }
    return [{
      frozenIndex: row.position,
      repositoryId: row.fullName,
      kind: row.analysisState === 'failed' ? 'analysis_failed' as const : row.analysisState,
    }];
  });
  const actionable: ActionableProposalRow[] = items.flatMap((row) => {
    if (row.analysisState !== 'actionable') return [];
    if (!taxonomyFingerprint || !row.sourceFingerprint) {
      throw new TypeError('Stored actionable organize row is missing sealed fingerprints.');
    }
    return [{
      proposalRowId: `${proposalId}:row:${row.position}`,
      frozenIndex: row.position,
      repositoryId: row.fullName,
      sourceFingerprint: parseSourceFingerprintV1(row.sourceFingerprint),
      taxonomyFingerprint,
      actions: row.proposedActions,
    }];
  });
  return restoreOrganizeJobRunAnalysisState({
    runId,
    generation: job.generation,
    proposalId,
    frozenScope: createFrozenScope({
      kind: 'all_live_stars',
      label: job.frozenScope.label,
      filterSnapshot: job.frozenScope.filterSnapshot,
      repositoryIds: job.frozenScope.repositoryIds,
      capturedAt: job.frozenScope.capturedAt,
      fingerprint: parseScopeFingerprintV1(job.frozenScope.fingerprint),
    }),
    budget: job.budget as RunBudget,
    usage: job.usage as RunBudgetUsage,
    nextFrozenIndex: job.nextFrozenIndex,
    analysisPendingRanges: job.analysisPendingRanges ?? [],
    status: ['review', 'apply_sealed', 'applying', 'paused', 'completed'].includes(job.status)
      ? 'review'
      : job.status === 'analysis_blocked'
        ? 'analysis_blocked'
        : 'analyzing',
    analyzedFrozenPositions: analyzed,
    nonActionableAnalysisOutcomes: nonActionable,
    actionableProposalRows: actionable,
  });
}

organizeAnalysisRecovery.install();
organizeApplyRecovery.install();

chrome.runtime.onInstalled.addListener(() => {
  setProgress({ phase: "idle", done: 0, total: null, message: "" });
  void backfillConfig.reconcileStoredBackfills().catch(() => {});
});

/**
 * Connection self-check on SW wake (30s throttle to avoid wake-spam).
 */
let lastSelfCheck = 0;
async function selfCheck() {
  const now = Date.now();
  if (now - lastSelfCheck < 30_000) return;
  lastSelfCheck = now;
  const hasToken = await authStore.hasToken();
  const starCount = await db.stars.count();
  if (!hasToken) {
    console.log(
      "[GSM] no token configured | DB stars:",
      starCount,
      "| → open Options to add a PAT",
    );
    return;
  }
  try {
    const token = await authStore.getToken();
    const res = await fetch(
      "https://api.github.com/user/starred?per_page=1&page=1",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.star+json",
        },
        cache: "no-store",
      },
    );
    const body = res.status === 200 ? await res.json() : null;
    const sample =
      Array.isArray(body) && body[0]?.repo?.full_name
        ? body[0].repo.full_name
        : null;
    console.log(
      `[GSM] connection: HTTP ${res.status} | rate ${res.headers.get("x-ratelimit-remaining")}/${res.headers.get("x-ratelimit-limit")} | DB stars: ${starCount} | sample: ${sample ?? "—"}`,
    );
  } catch (e) {
    console.log(
      "[GSM] self-check fetch failed:",
      e instanceof Error ? e.message : String(e),
      "| DB stars:",
      starCount,
    );
  }
}
selfCheck();
void backfillConfig.reconcileStoredBackfills().catch(() => {});
void run(migrateLanguageTags);
void authStore
  .getConfig()
  .then((cfg) => {
    if (
      !jobQueue.isRunning() &&
      lastProgress.phase === "idle" &&
      !lastProgress.message
    ) {
      lastProgress = cfg.lastSyncProgress ?? lastProgress;
    }
  })
  .catch(() => {});
