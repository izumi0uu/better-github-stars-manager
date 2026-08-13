import {
  authStore,
  CONFIG_STORAGE_KEY,
  GITHUB_CREDENTIALS_STORAGE_KEY,
} from "@/auth/auth-store";
import { canonicalJson, sha256Base64Url } from '@/agent-harness/canonical-json';
import { githubStarSource } from "@/api/github-star-source";
import {
  fetchGitHubNotifications,
  mutateGitHubNotificationThread,
} from '@/api/github-notifications-source';
import { fetchGitHubWatchScope } from '@/api/github-watch-scope-source';
import { fetchGitHubWatchSubjectDetail } from '@/api/github-watch-subject-source';
import { fetchGitHubRadar } from '@/api/github-radar-source';
import { getMessages } from "@/i18n";
import {
  addBgsmAgentManualTags,
  idbTagStore,
  resetDirtyForDev,
} from "@/storage/idb-tag-store";
import { db } from "@/storage/db";
import * as watchStore from '@/storage/watch-store';
import * as radarStore from '@/storage/radar-store';
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
import { createWatchRefreshCoordinator } from './watch-refresh';
import { createRadarRefreshCoordinator } from './radar-refresh';
import { createRecommendationRefreshCoordinator, createProductionRecommendationLoaders } from './recommendation-refresh';
import { fetchGitHubRecommendations } from '@/api/github-recommendation-source';
import * as recommendationStore from '@/storage/recommendation-store';
import {
  createScheduledRefreshController,
  type ScheduledRefreshKind,
} from './scheduled-refresh';
import { GitHubWatchError, canonicalRepositoryFullName } from '@/watch/watch-model';
import { parseWatchThreadId, parseWatchThreadIds } from '@/watch/watch-contract';
import { RADAR_MAX_FOLLOWING } from '@/radar/radar-model';
import {
  createOrganizeApplyPump,
  type OrganizeApplyPumpLifecycleEvent,
} from "./organize-apply-pump";
import { createOrganizeApplyRecovery } from './organize-apply-recovery';
import { createOrganizeAnalysisRecovery } from './organize-analysis-recovery';
import {
  assertBgsmAgentContextCapabilityFeasible,
  type OrganizeJobRunSnapshot,
} from "@/bgsm-agent";
import {
  createRegisteredAgentProvider,
  describeAgentProviderConnectionFailure,
  testRegisteredAgentProviderConnection,
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
  Star,
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
import { createBgsmAgentTagAssignmentPolicy } from '@/bgsm-agent/tag-assignment-policy';
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
  createOrganizeTagPolicySnapshot,
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
  bindOrganizeJobProvider,
  claimOrganizeApplyChunk,
  checkpointOrganizeAnalysisPage,
  cancelOrganizeJob,
  cancelOrganizePreflight,
  completeOrganizeJobWithoutApply,
  createOrganizeJob,
  createOrganizePreflight,
  dismissTerminalOrganizeJob,
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
  takeControlOrganizeJob,
  type OrganizeAnalysisOutcome,
  type OrganizeSelectionSummary,
} from "@/storage/organize-job-store";
import type { SemanticTaxonomyDto } from "@/bgsm-agent/semantic-dto";
import {
  canReplaceBlockedDurableRun,
  resolveBgsmOrganizeControlRole,
  resolveBgsmOrganizeJobReconnect,
} from "./organize-job-port-lifecycle";
import {
  createBgsmOrganizeJobScheduler,
  type BgsmOrganizeJobScheduler,
} from "./organize-analysis-runner";
import { attachBgsmAgentTurnPort } from "./bgsm-agent-turn-port";
import {
  parseBgsmAgentSessionRequest,
  type BgsmAgentSessionRequest,
} from './bgsm-agent-session-rpc';
import { createBgsmAgentRuntime } from './bgsm-agent-runtime';
import {
  createBgsmOrganizeJobTraceCoordinator,
} from "./organize-job-trace";
import {
  createBgsmOrganizeJobConnectionRegistry,
  type BgsmOrganizeJobConnection,
} from "./organize-job-port";
import {
  validateBgsmOrganizeJobMessageIdentity,
  type BgsmOrganizeJobPresentation,
  type BgsmOrganizeReceiptRow,
  type BgsmOrganizeJobClientMessage,
  type BgsmOrganizeJobDeliveryKind,
  type BgsmOrganizeJobControlFailureReason,
  type BgsmOrganizeJobErrorReason,
  type BgsmOrganizeJobServerMessage,
} from "@/utils/messaging";
import { writeOptionsIntent } from '@/utils/options-intent';

/**
 * Background SW — sync orchestrator and sole owner of the extension-origin
 * IndexedDB. Content scripts/popup/options talk via messages; they never touch
 * IDB directly (content scripts would hit the page's origin DB instead).
 */

type Req = BgsmAgentSessionRequest
  | { type: "syncIncremental" }
  | { type: "syncFull" }
  | { type: "syncRescan" }
  | { type: "autoAssignTags" }
  | { type: "gistPush" }
  | { type: "gistPull" }
  | { type: "getStatus" }
  | { type: "getWatchStatus" }
  | { type: "queryWatchInbox"; unreadOnly?: unknown }
  | { type: "getWatchSubjectDetail"; threadId?: unknown }
  | { type: "getWatchRepositoryDetail"; fullName?: unknown }
  | { type: "refreshWatchInbox" }
  | { type: "markWatchThreadsRead"; threadIds?: unknown }
  | { type: "markWatchThreadsDone"; threadIds?: unknown }
  | { type: "disconnectWatchInbox" }
  | { type: "clearWatchData" }
  | { type: 'getRecommendationStatus' }
  | { type: 'queryRecommendations' }
  | { type: 'refreshRecommendations' }
  | { type: 'refreshRecommendationsOnEntry' }
  | { type: 'clearRecommendations' }
  | { type: "getRadarStatus" }
  | { type: "queryRadar" }
  | { type: "refreshRadar" }
  | { type: "dismissRadarActivities"; activityIds?: unknown }
  | { type: "markRadarActivitiesSeen"; activityIds?: unknown }
  | { type: "radarStarRepository"; fullName?: unknown }
  | { type: "radarAddTag"; fullName?: unknown; tag?: unknown }
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
  | { type: "openOptions"; section?: 'github' | 'watch' }
  | { type: "devClearLocalData" }
  | { type: "runBackfill"; id: string }
  | { type: "deferBackfill"; id: string };

type Res = { ok: true; data?: unknown } | {
  ok: false;
  error: string;
  code?: string;
  details?: unknown;
};

const jobQueue = createSerializedRunner();
const watchRefreshCoordinator = createWatchRefreshCoordinator({
  runSerialized: (operation) => jobQueue.run(operation),
  auth: authStore,
  fetchScope: fetchGitHubWatchScope,
  fetchNotifications: fetchGitHubNotifications,
  mutateNotification: mutateGitHubNotificationThread,
  fetchSubjectDetail: fetchGitHubWatchSubjectDetail,
  loadLiveRepositoryNames: async () => (await db.stars.toArray())
    .filter((star) => !star.tombstone && star.viewer_has_starred !== false)
    .map((star) => star.full_name),
  store: {
    getState: watchStore.getWatchState,
    getRepositories: watchStore.getWatchRepositories,
    queryInbox: watchStore.queryStoredWatchInbox,
    getNotificationThread: watchStore.getWatchNotificationThread,
    reconcileAccount: watchStore.reconcileWatchAccount,
    reconcileLiveStars: watchStore.reconcileWatchLiveStars,
    replaceScope: watchStore.replaceWatchScope,
    recordScopeFailure: watchStore.recordWatchScopeFailure,
    replaceInbox: watchStore.replaceWatchInbox,
    revalidateInbox: watchStore.revalidateWatchInbox,
    recordInboxFailure: watchStore.recordWatchInboxFailure,
    applyThreadMutation: watchStore.applyWatchThreadMutation,
    disconnectInbox: watchStore.disconnectWatchInbox,
    clearData: watchStore.clearWatchData,
  },
  broadcastChanged: broadcastWatchChanged,
});
const radarRefreshCoordinator = createRadarRefreshCoordinator({
  runSerialized: (operation) => jobQueue.run(operation),
  auth: authStore,
  fetchRadar: fetchGitHubRadar,
  store: {
    clearData: radarStore.clearRadarData,
    prepareAccount: radarStore.prepareRadarAccount,
    getState: radarStore.getRadarState,
    commitSnapshot: radarStore.commitRadarSnapshot,
    recordFailure: radarStore.recordRadarFailure,
    listActivities: radarStore.listRadarActivities,
    listSuggestedTags: radarStore.listRadarSuggestedTags,
    dismissActivities: radarStore.dismissRadarActivities,
    markActivitiesSeen: radarStore.markRadarActivitiesSeen,
  },
  broadcastChanged: broadcastRadarChanged,
});
const recommendationRefreshCoordinator = createRecommendationRefreshCoordinator({
  runSerialized: (operation) => jobQueue.run(operation),
  auth: authStore,
  fetchRecommendations: fetchGitHubRecommendations,
  ...createProductionRecommendationLoaders(),
  store: {
    clearData: recommendationStore.clearRecommendationData,
    prepareAccount: recommendationStore.prepareRecommendationAccount,
    getState: recommendationStore.getRecommendationState,
    commitSnapshot: recommendationStore.commitRecommendationSnapshot,
    recordFailure: recommendationStore.recordRecommendationFailure,
    listRecommendations: recommendationStore.listRecommendations,
  },
  broadcastChanged: broadcastRecommendationChanged,
});
function reportScheduledRefreshError(
  kind: ScheduledRefreshKind | 'schedule',
  error: unknown,
): void {
  console.error(
    `[GSM] scheduled ${kind} refresh failed:`,
    error instanceof Error ? error.message : String(error),
  );
}

const scheduledRefreshController = createScheduledRefreshController({
  getAlarm: (name) => chrome.alarms.get(name),
  createAlarm: (name, info) => chrome.alarms.create(name, info),
  clearAlarm: (name) => chrome.alarms.clear(name),
  addAlarmListener: (listener) => {
    chrome.alarms.onAlarm.addListener((alarm) => listener(alarm.name));
  },
  refreshWatchInbox: () => watchRefreshCoordinator.refreshInbox(),
  refreshWatchScope: () => watchRefreshCoordinator.refresh(),
  refreshRadar: () => radarRefreshCoordinator.refresh(),
  refreshRecommendationsIfDue: () => recommendationRefreshCoordinator.refreshAtScheduledBoundary(),
  nextRecommendationRefreshAt: (nowMillis) => recommendationRefreshCoordinator.nextDailyRefreshAt(nowMillis),
  onError: reportScheduledRefreshError,
});
scheduledRefreshController.install();

function ensureScheduledRefreshes(): Promise<void> {
  return scheduledRefreshController.ensure().catch((error) => {
    reportScheduledRefreshError('schedule', error);
  });
}

async function reconcileScheduledRefreshes(): Promise<void> {
  await ensureScheduledRefreshes();
  try {
    await recommendationRefreshCoordinator.refreshIfDue();
  } catch (error) {
    reportScheduledRefreshError('recommendations', error);
  }
  await ensureScheduledRefreshes();
}

void reconcileScheduledRefreshes();
chrome.runtime.onStartup.addListener(() => {
  void reconcileScheduledRefreshes();
});
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
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  // The dedicated credential record owns the single Classic PAT identity.
  const credentialsChange = changes[GITHUB_CREDENTIALS_STORAGE_KEY];
  const accountChange = credentialsChange ?? changes[CONFIG_STORAGE_KEY];
  if (!accountChange || !watchMainAccountChanged(accountChange)) return;

  // The coordinator clears account-bound Watch data through the shared queue.
  void watchRefreshCoordinator.reconcileAccount().catch(() => {});
  broadcastDataChanged();
  void radarRefreshCoordinator.reconcileAccount()
    .then(broadcastRadarChanged)
    .catch(() => {});
  void recommendationRefreshCoordinator.reconcileAccount()
    .then(reconcileScheduledRefreshes)
    .catch(() => {});
});
const organizeJobRunConnections = createBgsmOrganizeJobConnectionRegistry<chrome.runtime.Port>();
let organizeJobRunMutationTail: Promise<void> = Promise.resolve();
let pendingDurableOrganizeJobId: OrganizeJobId | null = null;
const organizeJobRunCursorAuthKey = `organize-cursor-auth:${crypto.randomUUID()}`;
const organizeJobRunExecutionEpochId = `organize-job-epoch:v1:${crypto.randomUUID()}`;
const devRawCaptureCoordinator = DEV
  ? createDevRawCaptureCoordinator({
      getConfiguredSecrets: async () => Promise.all([
        authStore.getToken(),
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

function broadcastWatchChanged() {
  chrome.runtime.sendMessage({ type: 'watchChanged' }).catch(() => {});
}
function broadcastRecommendationChanged() {
  chrome.runtime.sendMessage({ type: 'recommendationsChanged' }).catch(() => {});
}

function broadcastDataAndRecommendationsChanged() {
  broadcastDataChanged();
  broadcastRecommendationChanged();
}
function broadcastRadarChanged() {
  chrome.runtime.sendMessage({ type: 'radarChanged' }).catch(() => {});
}

async function findLiveStarByCanonicalName(repository: string): Promise<Star | null> {
  return (await db.stars
    .filter((star) => (
      !star.tombstone
      && star.viewer_has_starred !== false
      && canonicalRepositoryFullName(star.full_name) === repository
    ))
    .first()) ?? null;
}

async function reconcileWatchScopeAfterStarsChange(): Promise<void> {
  try {
    if (await watchStore.reconcileWatchLiveStars(await authStore.getUsername())) {
      broadcastWatchChanged();
    }
  } catch {
    // Watch is optional; a local cleanup failure must not fail a Stars mutation.
  }
}

function watchAccountLogin(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const username = (config as { username?: unknown }).username;
  if (typeof username !== 'string') return null;
  const normalized = username.trim().toLowerCase();
  return normalized || null;
}

function watchMainAccountChanged(change: { oldValue?: unknown; newValue?: unknown }): boolean {
  const previous = watchAccountLogin(change.oldValue);
  const next = watchAccountLogin(change.newValue);
  return previous !== next && (previous !== null || next !== null);
}

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
  const stars = (await db.stars.toArray()).filter((star) => (
    !star.tombstone && star.viewer_has_starred !== false
  ));
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
  await reconcileWatchScopeAfterStarsChange();
  broadcastDataAndRecommendationsChanged();
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
  const agentSessionRequest = parseBgsmAgentSessionRequest(req);
  try {
    if (agentSessionRequest) {
      return { ok: true, data: await bgsmAgentRuntime.sessionRpc.handle(agentSessionRequest) };
    }
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
          const syncResult = await githubStarSource.syncIncremental();
          await reconcileWatchScopeAfterStarsChange();
          return syncResult;
        });
        broadcastDataAndRecommendationsChanged();
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
          const syncResult = await githubStarSource.syncRescan((p) => setProgress(p));
          await reconcileWatchScopeAfterStarsChange();
          return syncResult;
        });
        broadcastDataAndRecommendationsChanged();
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
      case 'getWatchStatus': {
        const m = await getLocaleMessages();
        try {
          return { ok: true, data: await watchRefreshCoordinator.getStatus() };
        } catch {
          return { ok: false, error: m.background.watchStatusUnavailable };
        }
      }
      case 'queryWatchInbox': {
        const m = await getLocaleMessages();
        if (req.unreadOnly !== undefined && typeof req.unreadOnly !== 'boolean') {
          return { ok: false, error: m.background.watchInboxQueryInvalid };
        }
        const unreadOnly = req.unreadOnly ?? true;
        try {
          return { ok: true, data: await watchRefreshCoordinator.queryInbox(unreadOnly) };
        } catch {
          return { ok: false, error: m.background.watchInboxUnavailable };
        }
      }
      case 'getWatchSubjectDetail': {
        const m = await getLocaleMessages();
        const threadId = parseWatchThreadId(req.threadId);
        if (!threadId) return { ok: false, error: m.background.watchSubjectDetailInvalid };
        try {
          return { ok: true, data: await watchRefreshCoordinator.getSubjectDetail(threadId) };
        } catch (error) {
          const code = error instanceof GitHubWatchError ? error.code : 'invalid_response';
          return {
            ok: false,
            error: m.background.watchSubjectDetailError(code),
            code,
            details: error instanceof GitHubWatchError && error.status !== undefined
              ? { status: error.status }
              : undefined,
          };
        }
      }
      case 'getWatchRepositoryDetail': {
        const m = await getLocaleMessages();
        const fullName = canonicalRepositoryFullName(req.fullName);
        if (!fullName) return { ok: false, error: m.background.watchRepositoryInvalid };
        try {
          const star = await db.stars
            .filter((row) => !row.tombstone && row.full_name.toLowerCase() === fullName)
            .first();
          return {
            ok: true,
            data: {
              star: star ?? null,
              tag: star ? (await idbTagStore.get(star.full_name)) ?? null : null,
            },
          };
        } catch {
          return { ok: false, error: m.background.watchRepositoryDetailUnavailable };
        }
      }
      case 'refreshWatchInbox': {
        const m = await getLocaleMessages();
        try {
          return { ok: true, data: await watchRefreshCoordinator.refresh() };
        } catch {
          return { ok: false, error: m.background.watchRefreshFailed };
        }
      }
      case 'markWatchThreadsRead':
      case 'markWatchThreadsDone': {
        const m = await getLocaleMessages();
        const threadIds = parseWatchThreadIds(req.threadIds);
        if (!threadIds) return { ok: false, error: m.background.watchThreadActionInvalid };
        try {
          return {
            ok: true,
            data: req.type === 'markWatchThreadsRead'
              ? await watchRefreshCoordinator.markThreadsRead(threadIds)
              : await watchRefreshCoordinator.markThreadsDone(threadIds),
          };
        } catch {
          return { ok: false, error: m.background.watchThreadActionFailed };
        }
      }
      case 'disconnectWatchInbox': {
        const m = await getLocaleMessages();
        try {
          return { ok: true, data: await watchRefreshCoordinator.disconnectInbox() };
        } catch {
          return { ok: false, error: m.background.watchDisconnectFailed };
        }
      }
      case 'clearWatchData': {
        const m = await getLocaleMessages();
        try {
          return { ok: true, data: await watchRefreshCoordinator.clearData() };
        } catch {
          return { ok: false, error: m.background.watchDataClearFailed };
        }
      }
      case 'getRecommendationStatus':
        return { ok: true, data: await recommendationRefreshCoordinator.getStatus() };
      case 'queryRecommendations':
        return { ok: true, data: await recommendationRefreshCoordinator.query() };
      case 'refreshRecommendations': {
        const result = await recommendationRefreshCoordinator.refresh();
        await ensureScheduledRefreshes();
        return { ok: true, data: result };
      }
      case 'refreshRecommendationsOnEntry': {
        const first = await recommendationRefreshCoordinator.refreshFirstEligible();
        const result = first ?? await recommendationRefreshCoordinator.refreshIfDue();
        if (result?.published) await ensureScheduledRefreshes();
        return { ok: true, data: result };
      }
      case 'clearRecommendations': {
        const result = await recommendationRefreshCoordinator.clear();
        await ensureScheduledRefreshes();
        return { ok: true, data: result };
      }
      case 'getRadarStatus':
        return { ok: true, data: await radarRefreshCoordinator.getStatus() };
      case 'queryRadar':
        return { ok: true, data: await radarRefreshCoordinator.query() };
      case 'refreshRadar':
        return { ok: true, data: await radarRefreshCoordinator.refresh() };
      case 'dismissRadarActivities': {
        if (
          !Array.isArray(req.activityIds)
          || req.activityIds.length === 0
          || req.activityIds.length > RADAR_MAX_FOLLOWING
          || req.activityIds.some((id) => typeof id !== 'string' || !id || id.length > 512)
        ) return { ok: false, error: 'Invalid Radar dismissal request.' };
        return {
          ok: true,
          data: await radarRefreshCoordinator.dismiss(req.activityIds as string[]),
        };
      }
      case 'markRadarActivitiesSeen': {
        if (
          !Array.isArray(req.activityIds)
          || req.activityIds.length === 0
          || req.activityIds.length > RADAR_MAX_FOLLOWING
          || req.activityIds.some((id) => typeof id !== 'string' || !id || id.length > 512)
        ) return { ok: false, error: 'Invalid Radar seen request.' };
        return {
          ok: true,
          data: await radarRefreshCoordinator.markSeen(req.activityIds as string[]),
        };
      }
      case 'radarStarRepository': {
        const repository = canonicalRepositoryFullName(req.fullName);
        if (!repository) return { ok: false, error: 'Invalid Radar repository.' };
        const star = await run(async () => {
          const existing = await findLiveStarByCanonicalName(repository);
          if (existing) return existing;
          const created = await githubStarSource.star(repository);
          await reconcileWatchScopeAfterStarsChange();
          return created;
        });
        broadcastDataAndRecommendationsChanged();
        broadcastRadarChanged();
        return { ok: true, data: star };
      }
      case 'radarAddTag': {
        const repository = canonicalRepositoryFullName(req.fullName);
        const additions = typeof req.tag === 'string' ? addTagNames([], [req.tag]) : [];
        if (!repository || additions.length !== 1) {
          return { ok: false, error: 'Invalid Radar tag request.' };
        }
        const result = await run(async () => {
          const existingStar = await findLiveStarByCanonicalName(repository);
          const star = existingStar ?? await githubStarSource.star(repository);
          if (!existingStar) await reconcileWatchScopeAfterStarsChange();
          const existing = manualTagNames(await idbTagStore.get(star.full_name));
          const tags = addTagNames(existing, additions);
          await idbTagStore.setTags(star.full_name, tags);
          return { star, tags };
        });
        broadcastDataChanged();
        broadcastRadarChanged();
        return { ok: true, data: result };
      }
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
          data: (await queryStars({
            ...req.params,
            accountLogin: await authStore.getUsername(),
          })) as QueryResult,
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
          if (!star || star.viewer_has_starred === false) return null;
          await githubStarSource.unstar(req.full_name);
          await db.stars.put({ ...star, tombstone: true });
          await reconcileWatchScopeAfterStarsChange();
          return { full_name: req.full_name, tombstone: true };
        });
        if (!result)
          return { ok: false, error: `Unknown repo: ${req.full_name}` };
        broadcastDataAndRecommendationsChanged();
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
        if (
          req.section !== undefined
          && req.section !== 'github'
          && req.section !== 'watch'
        ) return { ok: false, error: 'Unsupported Options section.' };
        if (req.section !== undefined) {
          await writeOptionsIntent(req.section);
        }
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
    const agentSessionFailure = bgsmAgentRuntime.sessionRpc.describeFailure(e);
    if (!agentSessionRequest) {
      setProgress({ phase: "idle", done: 0, total: null, message: `${msg}` });
    }
    return {
      ok: false,
      error: msg,
      ...(agentSessionFailure ?? {}),
    };
  }
}




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

const bgsmAgentRuntime = createBgsmAgentRuntime({
  prepareRuntimeProvider: () => agentProviderGate.prepareRuntimeProvider(),
  invalidateProviderCapability: (fingerprint) => authStore.invalidateAgentProviderCapability(fingerprint),
  resolveLiveCandidate: (contract) => authStore.getUsername()
    .then((accountLogin) => resolveLiveLaunchCandidate(contract, undefined, accountLogin)),
  getActiveOrganizeJob,
  isOrganizeApplyBlockingWrites: organizeApplyBlocksAgentWrites,
  createTagAssignmentPolicy: async () => createBgsmAgentTagAssignmentPolicy(
    await authStore.getConfig(),
    async () => {
      const [stars, storedTags, tagMeta] = await Promise.all([
        db.stars.toArray(),
        db.tags.toArray(),
        db.tagMeta.toArray(),
      ]);
      return {
        stars,
        tags: storedTags.map((tag) => normalizeStoredTag(tag as LegacyTagRow)),
        tagMeta,
      };
    },
  ),
  assignManualTags: agentManualTagWriter,
  removeVisibleTags: agentVisibleTagRemovalWriter,
  deleteTagsEverywhere: agentGlobalTagDeletionWriter,
  broadcastDataChanged,
  providerTraceIdentity: agentTraceProviderIdentity,
  translateError: async (error) => translateError(error, await getLocaleMessages()),
  traceFactory: DEV ? createDevAgentTurnTraceFactory({
    observeExecutionEvent: ({ rootOperationId, event }) => {
      providerDiagnosticsRuntime?.observeExecutionEvent(rootOperationId, event);
    },
  }) : undefined,
  contentCaptureFactory: DEV && devRawCaptureCoordinator
    ? (input) => devRawCaptureCoordinator.beginRoot(input)
    : undefined,
  notifySessionDeleted: publishAgentSessionDeleted,
});
chrome.runtime.onMessage.addListener((req: Req, _sender, sendResponse) => {
  handle(req).then(sendResponse);
  return true; // async response
});


chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bgsm-agent") return;
  attachBgsmAgentTurnPort(port, bgsmAgentRuntime.turnRegistry);
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

type OrganizePageIdentity = Readonly<{
  controllerId: BgsmOrganizeJobClientMessage['controllerId'];
  sessionId: string;
}>;

class OrganizeControlFailure extends Error {
  readonly reason: BgsmOrganizeJobControlFailureReason;

  constructor(reason: BgsmOrganizeJobControlFailureReason) {
    super(reason);
    this.name = 'OrganizeControlFailure';
    this.reason = reason;
  }
}

function isTerminalOrganizeJob(job: Pick<OrganizeJobRecord, 'status'>): boolean {
  return job.status === 'completed' || job.status === 'cancelled';
}

function durableOrganizePageIdentity(job: Pick<OrganizeJobRecord, 'controllerId' | 'sessionId'>): OrganizePageIdentity {
  return { controllerId: parseControllerId(job.controllerId), sessionId: job.sessionId };
}

function durableOrganizeRunIdentity(
  job: Pick<OrganizeJobRecord, 'controllerId' | 'sessionId' | 'runId' | 'generation'>,
): OrganizeRunIdentity {
  return {
    ...durableOrganizePageIdentity(job),
    runId: parseRunId(job.runId),
    generation: job.generation,
  };
}

function readdressOrganizeSnapshot(
  snapshot: OrganizeJobRunSnapshot,
  page: OrganizePageIdentity,
): OrganizeJobRunSnapshot {
  return Object.freeze({ ...snapshot, ...organizePageAddress(page) });
}

function organizePageAddress(page: OrganizePageIdentity): OrganizePageIdentity {
  return { controllerId: page.controllerId, sessionId: page.sessionId };
}

function ephemeralOrganizeRunIdentity(
  snapshot: Pick<OrganizeJobRunSnapshot, 'controllerId' | 'sessionId' | 'runId' | 'generation'>,
): OrganizeRunIdentity {
  return {
    controllerId: snapshot.controllerId,
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    generation: snapshot.generation,
  };
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

function classifyOrganizeJobRunError(error: unknown): BgsmOrganizeJobErrorReason {
  if (error instanceof OrganizeControlFailure) return error.reason;
  const message = error instanceof Error ? error.message : '';
  if (/already consumed/u.test(message)) return 'preflight_replayed';
  if (/preflight.*stale|stale.*preflight/u.test(message)) return 'preflight_stale';
  if (/preflight/u.test(message)) return 'preflight_invalid';
  if (/active OrganizeJobRun/u.test(message)) return 'already_started';
  if (/revision is stale/u.test(message)) return 'revision_conflict';
  if (/stale|does not belong/u.test(message)) return 'stale_generation';
  return 'internal_error';
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
    originAgentSessionId: job.originAgentSessionId,
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
    tagPolicy: createOrganizeTagPolicySnapshot(job.tagPolicy),
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
  void reconcileScheduledRefreshes();
});

/**
 * Development-only connection self-check (30s throttle to avoid wake-spam).
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
    console.log(
      `[GSM] connection: HTTP ${res.status} | rate ${res.headers.get("x-ratelimit-remaining")}/${res.headers.get("x-ratelimit-limit")} | DB stars: ${starCount}`,
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
if (DEV) {
  void selfCheck();
}
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
