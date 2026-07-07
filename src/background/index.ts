import { authStore } from '@/auth/auth-store';
import { githubStarSource } from '@/api/github-star-source';
import { getMessages } from '@/i18n';
import { idbTagStore, resetDirtyForDev } from '@/storage/idb-tag-store';
import { db, liveStarCount } from '@/storage/db';
import { DEV } from '@/dev';
import { queryStars, invalidateCache, type QueryParams, type QueryResult } from './query';
import { countTopicRepoFrequency, reconcileAutoTagAssignments, suggestTags } from '@/ui/suggest';
import { translateError } from '@/api/errors';
import type { AutoTagBulkUpdate } from '@/api/tag-store';
import { addTagNames, dismissedAutoTagNames, manualTagNames, sameTagNames, visibleTagNames } from '@/tags/tag-model';
import { selectActiveBackfillId } from '@/upgrades/backfill-state';
import { createBackfillConfigStore, getBackfillTask } from './backfill-config';
import { createBackfillExecutor } from './backfill-executor';
import { createSerializedRunner } from './serialized-runner';
import type { OnboardingStage, SyncProgress } from '@/types';
import {
  normalizeOnboardingStage,
  stageMarksOnboardingSeen,
} from '@/onboarding/state';

/**
 * Background SW — sync orchestrator and sole owner of the extension-origin
 * IndexedDB. Content scripts/popup/options talk via messages; they never touch
 * IDB directly (content scripts would hit the page's origin DB instead).
 */

type Req =
  | { type: 'syncIncremental' }
  | { type: 'syncFull' }
  | { type: 'syncRescan' }
  | { type: 'autoAssignTags' }
  | { type: 'gistPush' }
  | { type: 'gistPull' }
  | { type: 'getStatus' }
  | { type: 'getDebugStatus' }
  | { type: 'getUsername' }
  | { type: 'getAccount' }
  | { type: 'fetchAccount' }
  | { type: 'query'; params: QueryParams }
  | { type: 'setTags'; full_name: string; tags: string[] }
  | { type: 'setNotes'; full_name: string; notes: string }
  | { type: 'setFavorite'; full_name: string; favorite: boolean }
  | { type: 'removeVisibleTag'; full_name: string; name: string }
  | { type: 'deleteTag'; name: string }
  | { type: 'deleteAllTags' }
  | { type: 'acceptSuggestions'; full_name: string; toAdd: string[] }
  | { type: 'acceptSuggestionsBatch'; items: { full_name: string; toAdd: string[] }[] }
  | { type: 'suggestTags'; full_name: string }
  | { type: 'getTag'; full_name: string }
  | { type: 'listExcluded' }
  | { type: 'markOnboardingSeen' }
  | { type: 'setOnboardingStage'; stage: OnboardingStage }
  | { type: 'markTooltipSeen'; bit: number }
  | { type: 'testConnection' }
  | { type: 'openOptions' }
  | { type: 'devClearLocalData' }
  | { type: 'runBackfill'; id: string }
  | { type: 'deferBackfill'; id: string };

type Res =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

const jobQueue = createSerializedRunner();
let lastProgress: SyncProgress = { phase: 'idle', done: 0, total: null, message: '' };
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const backfillConfig = createBackfillConfigStore(authStore, {
  isBackfillRunning: jobQueue.isRunning,
});

function shouldPersistProgress(prev: SyncProgress, next: SyncProgress): boolean {
  if (prev.phase !== next.phase) return true;
  if (prev.message !== next.message) return true;
  if (prev.total !== next.total) return true;
  if (next.phase === 'idle') return true;
  if (next.total == null) return next.done !== prev.done;
  const step = Math.max(1, Math.ceil(next.total / 25));
  return next.done === 0 || next.done === next.total || next.done - prev.done >= step;
}

async function persistProgressSnapshot(progress: SyncProgress) {
  try {
    await authStore.update({ lastSyncProgress: progress });
  } catch (e) {
    console.warn('[GSM] failed to persist progress snapshot:', e instanceof Error ? e.message : String(e));
  }
}

function scheduleProgressPersist(prev: SyncProgress, next: SyncProgress) {
  if (!shouldPersistProgress(prev, next)) return;
  if (persistTimer) clearTimeout(persistTimer);
  const delay = next.phase === 'idle' ? 0 : 350;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistProgressSnapshot(next);
  }, delay);
}

function setProgress(p: SyncProgress) {
  const prev = lastProgress;
  lastProgress = p;
  scheduleProgressPersist(prev, p);
  chrome.runtime.sendMessage({ type: 'progress', progress: p }).catch(() => {});
}

function setIdleMessage(message: string) {
  setProgress({ phase: 'idle', done: 0, total: null, message });
}

function broadcastDataChanged() {
  invalidateCache();
  chrome.runtime.sendMessage({ type: 'dataChanged' }).catch(() => {});
}

async function clearLocalDataForDev() {
  if (!DEV) throw new Error('DEV_ONLY');
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  lastProgress = { phase: 'idle', done: 0, total: null, message: '' };
  resetDirtyForDev();
  await db.delete();
  await db.open();
  await chrome.storage.local.clear();
  invalidateCache();
  broadcastDataChanged();
  return {
    cleared: ['IndexedDB:better-github-stars-manager', 'chrome.storage.local'],
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
    progress: lastProgress.phase === 'idle' && !lastProgress.message ? cfg.lastSyncProgress : lastProgress,
    hasToken,
    onboardingStage,
    seenOnboarding: stageMarksOnboardingSeen(onboardingStage),
    seenTooltips: cfg.seenTooltips,
    backfills,
    activeBackfillId: selectActiveBackfillId(backfills),
    inFlight: jobQueue.isRunning(),
  };
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
): Promise<{ tagged: number }> {
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
  return { tagged };
}

async function performFullSyncJob() {
  const m = await getLocaleMessages();
  setProgress({ phase: 'full', done: 0, total: null, message: m.background.fetchingPages(1) });
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
    const langMetas = await db.tagMeta.where('dimension').equals('language').toArray();
    const toRemove = new Set(langMetas.map((m) => m.name));
    if (toRemove.size === 0) {
      await authStore.update({ langTagMigrationDone: true });
      return;
    }
    // Load all tag rows once, then iterate with awaited writes so each setTags
    // (which awaits IDB) completes before the next. Yield to the event loop every
    // 200 changed repos so the SW message channel / keepAlive can breathe on large
    // libraries — a long unbroken write chain can starve the SW's 30s lifecycle.
    const allTags = await db.tags.toArray();
    let changed = 0;
    for (const t of allTags) {
      const manualTags = manualTagNames(t);
      const next = manualTags.filter((x) => !toRemove.has(x));
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
    console.error('[GSM] language-tag migration failed (will retry):', e instanceof Error ? e.message : String(e));
  }
}

async function setStoredOnboardingStage(stage: OnboardingStage): Promise<void> {
  await authStore.update({
    onboardingStage: stage,
    seenOnboarding: stageMarksOnboardingSeen(stage),
  });
}

async function handle(req: Req): Promise<Res> {
  try {
    switch (req.type) {
      case 'syncIncremental': {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken())) return { ok: false, error: m.background.noToken };
        const result = await run(async () => {
          setProgress({ phase: 'incremental', done: 0, total: null, message: m.background.incrementalSyncing });
          return githubStarSource.syncIncremental();
        });
        broadcastDataChanged();
        setIdleMessage(m.background.incrementalDone(result.added));
        return { ok: true, data: { ...result, tagged: 0 } };
      }
      case 'syncFull': {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken())) return { ok: false, error: m.background.noToken };
        const result = await performFullSync();
        return { ok: true, data: { ...result, tagged: 0 } };
      }
      case 'syncRescan': {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken())) return { ok: false, error: m.background.noToken };
        const result = await run(async () => {
          setProgress({ phase: 'rescan', done: 0, total: null, message: m.background.rescanningPages(1) });
          return githubStarSource.syncRescan((p) => setProgress(p));
        });
        broadcastDataChanged();
        setIdleMessage(m.background.rescanDone(result.tombstoned, result.revived));
        return { ok: true, data: result };
      }
      case 'autoAssignTags': {
        const m = await getLocaleMessages();
        const t = await run(async () => {
          setProgress({ phase: 'incremental', done: 0, total: null, message: m.background.autoAssignTagging });
          return autoTagAll(m.background.autoAssignTagging, (p) => setProgress(p), 'incremental');
        });
        broadcastDataChanged();
        setIdleMessage(m.background.autoAssignDone(t.tagged));
        return { ok: true, data: t };
      }
      case 'gistPush': {
        const m = await getLocaleMessages();
        const r = await run(async () => {
          setProgress({ phase: 'gist', done: 0, total: null, message: m.background.pushingTags });
          const result = await idbTagStore.syncPush((done, total) => {
            setProgress({ phase: 'gist', done, total, message: m.background.pushingTags });
          });
          if (result.pushed > 0) setIdleMessage(m.background.gistPushDone(result.pushed));
          else if (result.recreated) setIdleMessage(m.background.gistPushRecreated);
          else setIdleMessage(m.background.gistPushNoChanges);
          return result;
        });
        return { ok: true, data: r };
      }
      case 'gistPull': {
        const m = await getLocaleMessages();
        const r = await run(async () => {
          setProgress({ phase: 'gist', done: 0, total: null, message: m.background.pullingTags });
          return idbTagStore.syncPull((done, total) => {
            setProgress({ phase: 'gist', done, total, message: m.background.pullingTags });
          });
        });
        broadcastDataChanged();
        if (r.missing) setIdleMessage(m.background.gistPullMissing);
        else setIdleMessage(m.background.gistPullDone(r.merged, r.total));
        return { ok: true, data: r };
      }
      case 'getStatus':
        return { ok: true, data: await getStatusPayload() };
      case 'getDebugStatus': {
        const cfg = await authStore.getConfig();
        const [hasToken, starCount, liveCount, sample] = await Promise.all([
          authStore.hasToken(),
          db.stars.count(),
          liveStarCount(),
          db.stars.orderBy('starred_at').reverse().first(),
        ]);
        return {
          ok: true,
          data: {
            hasUsableToken: hasToken,
            hasStoredCipher: !!cfg.tokenEncrypted,
            hasCryptoMeta: !!cfg.tokenCryptoMeta,
            username: cfg.username,
            lastSyncStarredAt: cfg.lastSyncStarredAt,
            gistId: cfg.gistId,
            starCount,
            liveStarCount: liveCount,
            tombstoneCount: Math.max(0, starCount - liveCount),
            newestSample: sample?.full_name ?? null,
          },
        };
      }
      case 'getUsername':
        return { ok: true, data: { username: await authStore.getUsername() } };
      case 'getAccount':
        return { ok: true, data: await authStore.getAccount() };
      case 'fetchAccount': {
        // Backfill avatar/displayName; no-op without token.
        const token = await authStore.getToken();
        if (!token) return { ok: true, data: await authStore.getAccount() };
        try {
          const res = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
            cache: 'no-store',
          });
          if (!res.ok) return { ok: true, data: await authStore.getAccount() };
          const body = (await res.json()) as { login?: string; avatar_url?: string; name?: string | null };
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
      case 'query':
        return { ok: true, data: await queryStars(req.params) as QueryResult };
      case 'runBackfill': {
        const m = await getLocaleMessages();
        const task = getBackfillTask(req.id);
        if (!task) return { ok: false, error: m.background.unknownBackfill(req.id) };
        if (task.kind !== 'full_sync') return { ok: false, error: m.background.unsupportedBackfillKind(task.kind) };
        if (!(await authStore.hasToken())) return { ok: false, error: m.background.noToken };
        return await backfillExecutor.runBackfill(task, (error) => translateError(error, m));
      }
      case 'deferBackfill': {
        const m = await getLocaleMessages();
        const task = getBackfillTask(req.id);
        if (!task) return { ok: false, error: m.background.unknownBackfill(req.id) };
        await backfillConfig.setBackfillState(task.id, (current, now) => {
          if (current?.status === 'done') return current;
          return {
            status: 'deferred',
            queuedAt: current?.queuedAt ?? now,
            lastAttemptAt: current?.lastAttemptAt ?? null,
            completedAt: null,
            error: current?.error ?? null,
          };
        });
        return { ok: true, data: { id: task.id } };
      }
      case 'setTags':
        await idbTagStore.setTags(req.full_name, req.tags);
        broadcastDataChanged();
        return { ok: true };
      case 'setNotes':
        await idbTagStore.setNotes(req.full_name, req.notes);
        broadcastDataChanged();
        return { ok: true };
      case 'setFavorite':
        await idbTagStore.setFavorite(req.full_name, req.favorite);
        broadcastDataChanged();
        return { ok: true, data: { favorite: req.favorite } };
      case 'removeVisibleTag': {
        const r = await idbTagStore.removeVisibleTag(req.full_name, req.name);
        broadcastDataChanged();
        return { ok: true, data: r };
      }
      case 'deleteTag': {
        // Remove this tag from every repo that has it and leave a tombstone.
        const r = await idbTagStore.deleteTag(req.name);
        broadcastDataChanged();
        return { ok: true, data: r };
      }
      case 'deleteAllTags': {
        const r = await run(() => idbTagStore.deleteAllTags());
        broadcastDataChanged();
        return { ok: true, data: r };
      }
      case 'acceptSuggestions': {
        const existingTag = await idbTagStore.get(req.full_name);
        const existing = manualTagNames(existingTag);
        const merged = addTagNames(existing, req.toAdd);
        await idbTagStore.setTags(req.full_name, merged);
        broadcastDataChanged();
        return { ok: true, data: { tags: visibleTagNames(await idbTagStore.get(req.full_name)) } };
      }
      case 'suggestTags': {
        return { ok: true };
      }
      case 'testConnection': {
        // Diagnostic: pull one page of /user/starred, return raw status+headers, never throws.
        const token = await authStore.getToken();
        if (!token) return { ok: false, error: (await getLocaleMessages()).background.noToken };
        try {
          const res = await fetch('https://api.github.com/user/starred?per_page=1&page=1', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.star+json' },
            cache: 'no-store',
          });
          const body = res.status === 200 ? await res.json() : null;
          return {
            ok: true,
            data: {
              status: res.status,
              statusText: res.statusText,
              remaining: res.headers.get('x-ratelimit-remaining'),
              limit: res.headers.get('x-ratelimit-limit'),
              scopes: res.headers.get('x-oauth-scopes'),
              itemCount: Array.isArray(body) ? body.length : 0,
              sample: Array.isArray(body) && body[0] ? body[0].full_name : null,
            },
          };
        } catch (e) {
          return { ok: false, error: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      case 'openOptions': {
        // Content scripts have a restricted chrome.runtime without openOptionsPage, so they ask the background.
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      }
      case 'devClearLocalData': {
        const result = await run(clearLocalDataForDev);
        return { ok: true, data: result };
      }
      case 'getTag': {
        return { ok: true, data: { tag: (await idbTagStore.get(req.full_name)) ?? null } };
      }
      case 'listExcluded':
        return { ok: true, data: await idbTagStore.listExcluded() };
      case 'markOnboardingSeen':
        await setStoredOnboardingStage('done');
        return { ok: true };
      case 'setOnboardingStage':
        await setStoredOnboardingStage(req.stage);
        return { ok: true };
      case 'markTooltipSeen': {
        const cur = (await authStore.getConfig()).seenTooltips;
        await authStore.update({ seenTooltips: cur | req.bit });
        return { ok: true, data: { seenTooltips: cur | req.bit } };
      }
      case 'acceptSuggestionsBatch': {
        let n = 0;
        for (const item of req.items) {
          if (item.toAdd.length === 0) continue;
          const existing = manualTagNames(await idbTagStore.get(item.full_name));
          const merged = addTagNames(existing, item.toAdd);
          if (merged.length !== existing.length) {
            await idbTagStore.setTags(item.full_name, merged);
            n++;
          }
        }
        broadcastDataChanged();
        return { ok: true, data: { count: n } };
      }
    }
  } catch (e) {
    const msg = translateError(e, await getLocaleMessages());
    setProgress({ phase: 'idle', done: 0, total: null, message: `${msg}` });
    return { ok: false, error: msg };
  }
}

chrome.runtime.onMessage.addListener((req: Req, _sender, sendResponse) => {
  handle(req).then(sendResponse);
  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => {
  setProgress({ phase: 'idle', done: 0, total: null, message: '' });
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
    console.log('[GSM] no token configured | DB stars:', starCount, '| → open Options to add a PAT');
    return;
  }
  try {
    const token = await authStore.getToken();
    const res = await fetch('https://api.github.com/user/starred?per_page=1&page=1', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.star+json' },
      cache: 'no-store',
    });
    const body = res.status === 200 ? await res.json() : null;
    const sample = Array.isArray(body) && body[0]?.repo?.full_name ? body[0].repo.full_name : null;
    console.log(
      `[GSM] connection: HTTP ${res.status} | rate ${res.headers.get('x-ratelimit-remaining')}/${res.headers.get('x-ratelimit-limit')} | DB stars: ${starCount} | sample: ${sample ?? '—'}`,
    );
  } catch (e) {
    console.log('[GSM] self-check fetch failed:', e instanceof Error ? e.message : String(e), '| DB stars:', starCount);
  }
}
selfCheck();
void backfillConfig.reconcileStoredBackfills().catch(() => {});
migrateLanguageTags();
void authStore.getConfig().then((cfg) => {
  if (!jobQueue.isRunning() && lastProgress.phase === 'idle' && !lastProgress.message) {
    lastProgress = cfg.lastSyncProgress ?? lastProgress;
  }
}).catch(() => {});
