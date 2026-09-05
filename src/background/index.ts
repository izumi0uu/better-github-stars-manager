import {
  authStore,
  CONFIG_STORAGE_KEY,
  GITHUB_CREDENTIALS_STORAGE_KEY,
} from "@/auth/auth-store";
import { hasAgentPersonalCommunicationsPermission } from '@/auth/agent-data-permission';
import { githubStarSource } from "@/api/github-star-source";
import {
  fetchGitHubNotifications,
  mutateGitHubNotificationThread,
} from '@/api/github-notifications-source';
import { fetchGitHubWatchScope } from '@/api/github-watch-scope-source';
import { fetchGitHubWatchSubjectDetail } from '@/api/github-watch-subject-source';
import {
  fetchGitHubRadar,
  fetchGitHubRadarReconciliationStep,
} from '@/api/github-radar-source';
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
import {
  queryStars,
  invalidateCache,
  resolveLiveLaunchCandidate,
} from "./query";
import type { StarsQueryParams, StarsQueryResult } from '@/stars/stars-query';
import {
  AGENT_DATA_DISCLOSURE_REQUIRED,
  AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED,
  translateError,
} from "@/api/errors";
import {
  addTagNames,
  canonicalTagKey,
  excludedCanonicalTagKeys,
  manualTagNames,
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
import {
  parseWatchAccountLogin,
  parseWatchThreadId,
  parseWatchThreadIds,
  type WatchStatus,
} from '@/watch/watch-contract';
import { RADAR_MAX_FOLLOWING } from '@/radar/radar-model';
import { assertBgsmAgentContextCapabilityFeasible } from "@/bgsm-agent";
import {
  createRegisteredAgentProvider,
  testRegisteredAgentProviderConnection,
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
  OnboardingStage,
  Star,
  SyncProgress,
} from "@/types";
import {
  normalizeOnboardingStage,
  resolveOnboardingStageAfterSync,
  stageMarksOnboardingSeen,
} from "@/onboarding/state";
import { createAgentProviderGate } from "./agent-provider-gate";
import { createBgsmAgentTagAssignmentPolicy } from '@/bgsm-agent/tag-assignment-policy';
import { normalizeStoredTag, type LegacyTagRow } from "@/storage/tag-shape";
import { getActiveOrganizeJob } from "@/storage/organize-job-store";
import { attachBgsmAgentTurnPort } from "./bgsm-agent-turn-port";
import {
  parseBgsmAgentSessionRequest,
  type BgsmAgentSessionRequest,
} from './bgsm-agent-session-rpc';
import { createBgsmAgentRuntime } from './bgsm-agent-runtime';
import { writeOptionsIntent } from '@/utils/options-intent';

import { queryManagerSurfaceBadgeCounts } from './manager-surface-badges';
import { shouldPersistProgress } from './progress-persistence';
import { autoTagAll } from './auto-tag';
import { describeSafeAgentProviderConnectionFailure } from './provider-failure';
import { agentTraceProviderIdentity } from './agent-trace-identity';
import { organizeApplyBlocksAgentWrites } from './organize-run-identity';
import { createOrganizeJobHost } from './organize-job-host';
/**
 * Background SW — sync orchestrator and sole owner of the extension-origin
 * IndexedDB. Content scripts/popup/options talk via messages; they never touch
 * IDB directly (content scripts would hit the page's origin DB instead).
 */

type Req = BgsmAgentSessionRequest
  | { type: "syncOwnedPublicRepositories" }
  | { type: "syncIncremental" }
  | { type: "syncFull"; includeOwnedPublic?: unknown }
  | { type: "syncRescan" }
  | { type: "autoAssignTags" }
  | { type: "gistPush" }
  | { type: "gistPull" }
  | { type: "getStatus" }
  | { type: "queryManagerSurfaceBadges" }
  | { type: "getWatchStatus" }
  | { type: "queryWatchInbox"; unreadOnly?: unknown }
  | { type: "getWatchSubjectDetail"; threadId?: unknown }
  | { type: "getWatchRepositoryDetail"; fullName?: unknown }
  | { type: "refreshWatchInbox" }
  | { type: "loadOlderWatchInbox" }
  | { type: "markWatchInboxLoaded" }
  | { type: "markWatchThreadsRead"; accountLogin?: unknown; threadIds?: unknown }
  | { type: "markWatchThreadsDone"; accountLogin?: unknown; threadIds?: unknown }
  | { type: "disconnectWatchInbox" }
  | { type: "clearWatchData" }
  | { type: 'getRecommendationStatus' }
  | { type: 'queryRecommendations' }
  | { type: 'refreshRecommendations' }
  | { type: 'ignoreRecommendation'; repositoryKey?: unknown; repositoryFullName?: unknown }
  | { type: 'restoreIgnoredRecommendation'; repositoryKey?: unknown }
  | { type: 'refreshRecommendationsOnEntry' }
  | { type: 'clearRecommendations' }
  | { type: "getRadarStatus" }
  | { type: "queryRadar" }
  | { type: "refreshRadar" }
  | { type: "fullReconcileRadar" }
  | { type: "dismissRadarActivities"; activityIds?: unknown }
  | { type: "markRadarActivitiesSeen"; activityIds?: unknown }
  | { type: "radarStarRepository"; fullName?: unknown }
  | { type: "radarAddTag"; fullName?: unknown; tag?: unknown }
  | { type: "getUsername" }
  | { type: "getAccount" }
  | { type: "fetchAccount" }
  | { type: "query"; params: StarsQueryParams }
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
    startInboxScan: watchStore.startWatchInboxScan,
    commitInboxScanBatch: watchStore.commitWatchInboxScanBatch,
    mergeInboxDelta: watchStore.mergeWatchInboxDelta,
    markLoaded: watchStore.markWatchInboxLoaded,
    revalidateInbox: watchStore.revalidateWatchInbox,
    recordInboxFailure: watchStore.recordWatchInboxFailure,
    recordHistoryFailure: watchStore.recordWatchHistoryFailure,
    applyThreadMutation: watchStore.applyWatchThreadMutation,
    disconnectInbox: watchStore.disconnectWatchInbox,
    clearData: watchStore.clearWatchData,
  },
  broadcastChanged: broadcastWatchChanged,
  broadcastStatusChanged: broadcastWatchStatusChanged,
});
const radarRefreshCoordinator = createRadarRefreshCoordinator({
  runSerialized: (operation) => jobQueue.run(operation),
  auth: authStore,
  fetchRadar: fetchGitHubRadar,
  fetchReconciliationStep: fetchGitHubRadarReconciliationStep,
  store: {
    clearData: radarStore.clearRadarData,
    prepareAccount: radarStore.prepareRadarAccount,
    getState: radarStore.getRadarState,
    getReconciliation: radarStore.getRadarReconciliation,
    startReconciliation: radarStore.startRadarReconciliation,
    commitReconciliationStep: radarStore.commitRadarReconciliationStep,
    abandonReconciliation: radarStore.abandonRadarReconciliation,
    commitSnapshot: radarStore.commitRadarSnapshot,
    recordFailure: radarStore.recordRadarFailure,
    listActivities: radarStore.listRadarActivities,
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
    ignoreRepository: recommendationStore.ignoreRecommendation,
    listIgnored: recommendationStore.listIgnoredRepositories,
    restoreIgnored: recommendationStore.restoreIgnoredRecommendation,
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
  refreshWatchScope: () => watchRefreshCoordinator.refreshScope(),
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
  hasDataCollectionPermission: hasAgentPersonalCommunicationsPermission,
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
      port.name !== 'bgsm-agent-dev-evidence' &&
      port.name !== 'bgsm-agent-dev-control'
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
const organizeJobHost = createOrganizeJobHost({
  jobQueue,
  broadcastDataChanged,
  createRuntimeProvider: () => agentProviderGate.createRuntimeProvider(),
  observeExecutionEvent: providerDiagnosticsRuntime
    ? (rootOperationId, event) => {
        providerDiagnosticsRuntime.observeExecutionEvent(rootOperationId, event);
      }
    : null,
});

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

type ManagerBroadcastMessage =
  | { type: 'progress'; progress: SyncProgress }
  | { type: 'watchChanged' | 'watchStatusChanged'; status?: WatchStatus }
  | { type: 'dataChanged' | 'recommendationsChanged' | 'radarChanged' };

function broadcastManagerMessage(message: ManagerBroadcastMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {});
  if (message.type !== 'watchChanged' && message.type !== 'watchStatusChanged') return;

  // The Watch UI is a content script, so tab messaging exposes committed scan
  // progress before the original refresh request sends its final response.
  if (!chrome.tabs?.query || !chrome.tabs.sendMessage) return;
  void chrome.tabs.query({ url: 'https://github.com/*' }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      void chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  }).catch(() => {});
}

function setProgress(p: SyncProgress) {
  const prev = lastProgress;
  lastProgress = p;
  scheduleProgressPersist(prev, p);
  broadcastManagerMessage({ type: "progress", progress: p });
}

function setIdleMessage(message: string) {
  setProgress({ phase: "idle", done: 0, total: null, message });
}

function broadcastDataChanged() {
  invalidateCache();
  broadcastManagerMessage({ type: "dataChanged" });
}

let watchBroadcastTail: Promise<void> = Promise.resolve();

function queueWatchBroadcast(type: 'watchChanged' | 'watchStatusChanged') {
  // Capture at request time so queued delivery preserves phase order.
  const statusPromise = watchRefreshCoordinator.snapshotStatus().catch(() => null);
  watchBroadcastTail = watchBroadcastTail.then(async () => {
    const status = await statusPromise;
    broadcastManagerMessage(status ? { type, status } : { type });
  }).catch(() => {});
}

function broadcastWatchChanged() {
  queueWatchBroadcast('watchChanged');
}

function broadcastWatchStatusChanged() {
  queueWatchBroadcast('watchStatusChanged');
}
function broadcastRecommendationChanged() {
  broadcastManagerMessage({ type: 'recommendationsChanged' });
}

function broadcastDataAndRecommendationsChanged() {
  broadcastDataChanged();
  broadcastRecommendationChanged();
}
function broadcastRadarChanged() {
  broadcastManagerMessage({ type: 'radarChanged' });
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
  const [hasToken, activeOrganizeJob] = await Promise.all([
    authStore.hasToken(),
    getActiveOrganizeJob(),
  ]);
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
  const starsSyncInFlight = jobQueue.isRunning("stars-sync");
  const progressInFlight = starsSyncInFlight || jobQueue.isRunning("progress");
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
    progressInFlight,
    starsSyncInFlight,
    organizeJobActive: !!activeOrganizeJob,
  };
}

async function performFullSyncJob(includeOwnedPublic = true) {
  const m = await getLocaleMessages();
  setProgress({
    phase: "full",
    done: 0,
    total: null,
    message: m.background.fetchingPages(1),
  });
  const result = includeOwnedPublic
    ? await githubStarSource.syncFull((p) => setProgress(p))
    : await githubStarSource.syncFull((p) => setProgress(p), { includeOwnedPublic: false });
  await reconcileWatchScopeAfterStarsChange();
  broadcastDataAndRecommendationsChanged();
  await finalizeTrackedOnboardingSync();
  setIdleMessage(m.background.fullDone(result.added));
  return result;
}

async function performFullSync(includeOwnedPublic = true) {
  return run(() => performFullSyncJob(includeOwnedPublic), { kind: "stars-sync" });
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

async function finalizeTrackedOnboardingSync(): Promise<void> {
  const config = await authStore.getConfig();
  if (config.onboardingStage !== "syncing") return;
  const [hasToken, grandTotal] = await Promise.all([
    authStore.hasToken(),
    db.stars.count(),
  ]);
  await setStoredOnboardingStage(resolveOnboardingStageAfterSync(hasToken, grandTotal));
}

async function failTrackedOnboardingSync(): Promise<void> {
  try {
    const config = await authStore.getConfig();
    if (config.onboardingStage !== "syncing") return;
    await setStoredOnboardingStage("sync_failed");
  } catch (error) {
    console.error(
      "[GSM] failed to persist onboarding sync failure:",
      error instanceof Error ? error.message : String(error),
    );
  }
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


async function handle(req: Req): Promise<Res> {
  const agentSessionRequest = parseBgsmAgentSessionRequest(req);
  try {
    if (agentSessionRequest) {
      return { ok: true, data: await bgsmAgentRuntime.sessionRpc.handle(agentSessionRequest) };
    }
    switch (req.type) {
      case "syncOwnedPublicRepositories": {
        if (!(await authStore.hasToken())) {
          return { ok: false, error: (await getLocaleMessages()).background.noToken };
        }
        const result = await run(async () => {
          const syncResult = await githubStarSource.syncOwnedPublicRepositories();
          broadcastDataAndRecommendationsChanged();
          return syncResult;
        }, { kind: "stars-sync" });
        return { ok: true, data: result };
      }

      case "syncIncremental": {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken())) {
          await failTrackedOnboardingSync();
          return { ok: false, error: m.background.noToken };
        }
        const result = await run(async () => {
          setProgress({
            phase: "incremental",
            done: 0,
            total: null,
            message: m.background.incrementalSyncing,
          });
          const syncResult = await githubStarSource.syncIncremental();
          await reconcileWatchScopeAfterStarsChange();
          broadcastDataAndRecommendationsChanged();
          await finalizeTrackedOnboardingSync();
          setIdleMessage(m.background.incrementalDone(syncResult.added));
          return syncResult;
        }, { kind: "stars-sync" });
        return { ok: true, data: { ...result, tagged: 0 } };
      }
      case "syncFull": {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken())) {
          await failTrackedOnboardingSync();
          return { ok: false, error: m.background.noToken };
        }
        if (req.includeOwnedPublic !== undefined && typeof req.includeOwnedPublic !== "boolean") {
          return { ok: false, error: "Invalid full-sync options" };
        }
        const result = await performFullSync(req.includeOwnedPublic ?? true);
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
          broadcastDataAndRecommendationsChanged();
          setIdleMessage(
            m.background.rescanDone(syncResult.tombstoned, syncResult.revived),
          );
          return syncResult;
        }, { kind: "stars-sync" });
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
          const result = await autoTagAll(
            m.background.autoAssignTagging,
            (p) => setProgress(p),
            "incremental",
          );
          broadcastDataChanged();
          setIdleMessage(m.background.autoAssignDone(result.tagged));
          return result;
        }, { kind: "progress" });
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
        }, { kind: "progress" });
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
          const result = await idbTagStore.syncPull((done, total) => {
            setProgress({
              phase: "gist",
              done,
              total,
              message: m.background.pullingTags,
            });
          });
          broadcastDataChanged();
          if (result.missing) setIdleMessage(m.background.gistPullMissing);
          else setIdleMessage(m.background.gistPullDone(result.merged, result.total));
          return result;
        }, { kind: "progress" });
        return { ok: true, data: r };
      }
      case "getStatus":
        return { ok: true, data: await getStatusPayload() };
      case "queryManagerSurfaceBadges":
        return { ok: true, data: await queryManagerSurfaceBadgeCounts() };
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
      case 'loadOlderWatchInbox': {
        const m = await getLocaleMessages();
        try {
          return { ok: true, data: await watchRefreshCoordinator.loadOlder() };
        } catch {
          return { ok: false, error: m.background.watchRefreshFailed };
        }
      }
      case 'markWatchInboxLoaded': {
        const m = await getLocaleMessages();
        try {
          return { ok: true, data: await watchRefreshCoordinator.markLoaded() };
        } catch {
          return { ok: false, error: m.background.watchInboxUnavailable };
        }
      }

      case 'markWatchThreadsRead':
      case 'markWatchThreadsDone': {
        const m = await getLocaleMessages();
        const accountLogin = parseWatchAccountLogin(req.accountLogin);
        const threadIds = parseWatchThreadIds(req.threadIds);
        if (!accountLogin || !threadIds) {
          return { ok: false, error: m.background.watchThreadActionInvalid };
        }
        const mutation = { accountLogin, threadIds };
        try {
          return {
            ok: true,
            data: req.type === 'markWatchThreadsRead'
              ? await watchRefreshCoordinator.markThreadsRead(mutation)
              : await watchRefreshCoordinator.markThreadsDone(mutation),
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
      case 'ignoreRecommendation': {
        const repositoryKey = canonicalRepositoryFullName(req.repositoryKey);
        if (!repositoryKey) return { ok: false, error: 'Invalid recommendation repository.' };
        const repositoryFullName = typeof req.repositoryFullName === 'string'
          && canonicalRepositoryFullName(req.repositoryFullName) === repositoryKey
          ? req.repositoryFullName
          : undefined;
        await recommendationRefreshCoordinator.ignoreRepository(repositoryKey, repositoryFullName);
        return { ok: true, data: null };
      }
      case 'restoreIgnoredRecommendation': {
        const repositoryKey = canonicalRepositoryFullName(req.repositoryKey);
        if (!repositoryKey) return { ok: false, error: 'Invalid recommendation repository.' };
        await recommendationRefreshCoordinator.restoreIgnored(repositoryKey);
        return { ok: true, data: null };
      }
      case 'getRadarStatus':
        return { ok: true, data: await radarRefreshCoordinator.getStatus() };
      case 'queryRadar':
        return { ok: true, data: await radarRefreshCoordinator.query() };
      case 'refreshRadar':
        return { ok: true, data: await radarRefreshCoordinator.refresh('auto') };
      case 'fullReconcileRadar':
        return { ok: true, data: await radarRefreshCoordinator.fullReconcile() };
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
          })) as StarsQueryResult,
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
          const code = error instanceof Error && (
            error.message === AGENT_DATA_DISCLOSURE_REQUIRED ||
            error.message === AGENT_PERSONAL_COMMUNICATIONS_PERMISSION_REQUIRED
          )
            ? error.message
            : undefined;
          return {
            ok: false,
            error: translateError(error, messages),
            ...(code ? { code } : {}),
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
    if (req.type === "syncIncremental" || req.type === "syncFull") {
      await failTrackedOnboardingSync();
    }
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
  notifySessionDeleted: organizeJobHost.publishAgentSessionDeleted,
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

organizeJobHost.install();

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

