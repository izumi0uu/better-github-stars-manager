import { authStore } from '@/auth/auth-store';
import { githubStarSource } from '@/api/github-star-source';
import { getMessages } from '@/i18n';
import { idbTagStore } from '@/storage/idb-tag-store';
import { db, liveStarCount } from '@/storage/db';
import { queryStars, invalidateCache, type QueryParams, type QueryResult } from './query';
import { suggestTags } from '@/ui/suggest';
import { translateError } from '@/api/errors';
import type { SyncProgress, Star } from '@/types';

/**
 * Background service worker — the sync orchestrator AND the sole owner of the
 * IndexedDB (extension origin). Content scripts/popup/options talk to it via
 * messages; they never touch IDB directly (content scripts would hit the page's
 * origin IDB instead — a different database).
 * Incremental sync is kicked off when the stars-page UI mounts; there is no
 * background polling or alarm-based sync loop.
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
  | { type: 'deleteTag'; name: string }
  | { type: 'acceptSuggestions'; full_name: string; toAdd: string[] }
  | { type: 'acceptSuggestionsBatch'; items: { full_name: string; toAdd: string[] }[] }
  | { type: 'suggestTags'; full_name: string }
  | { type: 'getTag'; full_name: string }
  | { type: 'listExcluded' }
  | { type: 'markOnboardingSeen' }
  | { type: 'markTooltipSeen'; bit: number }
  | { type: 'testConnection' };

type Res =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

let inFlight: Promise<unknown> | null = null;
let lastProgress: SyncProgress = { phase: 'idle', done: 0, total: null, message: '' };

function setProgress(p: SyncProgress) {
  lastProgress = p;
  chrome.runtime.sendMessage({ type: 'progress', progress: p }).catch(() => {});
}

function setIdleMessage(message: string) {
  setProgress({ phase: 'idle', done: 0, total: null, message });
}

function broadcastDataChanged() {
  invalidateCache();
  chrome.runtime.sendMessage({ type: 'dataChanged' }).catch(() => {});
}

async function getLocaleMessages() {
  return getMessages(await authStore.getLocale());
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight) await inFlight.catch(() => {});
  const p = fn();
  inFlight = p;
  try {
    return await p;
  } finally {
    if (inFlight === p) inFlight = null;
  }
}

/**
 * Auto-tag every star from its language + topics. Pure-local: no API calls —
 * it only reads star.language/star.topics (already in IDB from sync) and writes
 * the tags store. Idempotent (suggestTags dedupes against existing tags, and we
 * only write when the merged set actually grew). Preserves notes (setTags
 * spreads existing). This runs automatically after every sync so tags are
 * always populated without a manual button press; the button is a manual refresh.
 *
 * Dimensions: each newly-suggested tag gets a tagMeta row with dimension
 * 'language' (the repo's primary language) or 'topic' (a GitHub topic), so the
 * sidebar groups tags into Language / Topic sections. We only CREATE meta — we
 * never overwrite an existing row (a manual dimension or a delete-tombstone is
 * preserved).
 *
 * Resurrection guard: names in the excluded set (tagMeta.excluded tombstones left
 * by deleteTag) are passed to suggestTags and skipped, so deleting a tag actually
 * sticks across syncs.
 */
async function autoTagAll(): Promise<{ tagged: number }> {
  const stars = await db.stars.toArray();
  const excluded = new Set(await idbTagStore.listExcluded());
  // Names that already have a tagMeta row — load once so ensureDimensionMeta can
  // skip them without a per-tag getMeta (autoTagAll runs after every sync).
  const knownMeta = new Set((await idbTagStore.listTagMeta()).map((m) => m.name));
  let tagged = 0;
  for (const star of stars) {
    const existing = (await idbTagStore.get(star.full_name))?.tags ?? [];
    const toAdd = suggestTags(star, existing, excluded);
    let merged = existing;
    if (toAdd.length > 0) {
      merged = Array.from(new Set([...existing, ...toAdd]));
      if (merged.length !== existing.length) {
        await idbTagStore.setTags(star.full_name, merged);
        tagged++;
      }
    }
    // Ensure a dimension meta row for every language/topic-derived tag this repo
    // carries (not just the ones added this pass — backfills existing tags too, so
    // users who already had auto-tags before dimensions shipped get grouped). We
    // only CREATE meta when none exists — never clobber a manual dimension or a
    // delete-tombstone. Language (repo's single language) → 'language'; topics → 'topic'.
    // Runs even when nothing new was added, so pre-existing tags get backfilled.
    await ensureDimensionMeta(star, merged, knownMeta);
  }
  return { tagged };
}

/**
 * For a repo's tag set, create tagMeta dimension rows for any language/topic tag
 * that lacks one. Language → 'language', each GitHub topic → 'topic'. Skips names
 * already in `knownMeta` (existing dimension OR a delete tombstone). Mutates
 * `knownMeta` to include anything it creates, so later repos don't re-check them.
 * Idempotent and cheap (no per-tag DB read).
 */
async function ensureDimensionMeta(star: Star, names: string[], knownMeta: Set<string>): Promise<void> {
  const derived: { name: string; dimension: string }[] = [];
  if (star.language && names.includes(star.language)) {
    derived.push({ name: star.language, dimension: 'language' });
  }
  for (const t of star.topics) {
    if (names.includes(t)) derived.push({ name: t, dimension: 'topic' });
  }
  if (derived.length === 0) return;
  const ts = new Date().toISOString();
  for (const { name, dimension } of derived) {
    if (knownMeta.has(name)) continue;
    await idbTagStore.upsertMeta({ name, dimension, color: null, excluded: false, mtime: ts });
    knownMeta.add(name);
  }
}

async function handle(req: Req): Promise<Res> {
  try {
    switch (req.type) {
      case 'syncIncremental': {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken())) return { ok: false, error: m.background.noToken };
        setProgress({ phase: 'incremental', done: 0, total: null, message: m.background.incrementalSyncing });
        const r = await run(() => githubStarSource.syncIncremental());
        const t = await autoTagAll();
        broadcastDataChanged();
        setIdleMessage(m.background.incrementalDone(r.added, t.tagged));
        return { ok: true, data: { ...r, autoTagged: t.tagged } };
      }
      case 'syncFull': {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken())) return { ok: false, error: m.background.noToken };
        const r = await run(() => githubStarSource.syncFull((p) => setProgress(p)));
        const t = await autoTagAll();
        broadcastDataChanged();
        setIdleMessage(m.background.fullDone(t.tagged));
        return { ok: true, data: { ...r, autoTagged: t.tagged } };
      }
      case 'syncRescan': {
        const m = await getLocaleMessages();
        if (!(await authStore.hasToken())) return { ok: false, error: m.background.noToken };
        const r = await run(() => githubStarSource.syncRescan((p) => setProgress(p)));
        const t = await autoTagAll();
        broadcastDataChanged();
        setIdleMessage(m.background.rescanDone(t.tagged));
        return { ok: true, data: { ...r, autoTagged: t.tagged } };
      }
      case 'autoAssignTags': {
        const m = await getLocaleMessages();
        const t = await autoTagAll();
        broadcastDataChanged();
        setIdleMessage(m.background.autoAssignDone(t.tagged));
        return { ok: true, data: t };
      }
      case 'gistPush': {
        const m = await getLocaleMessages();
        setProgress({ phase: 'gist', done: 0, total: null, message: m.background.pushingTags });
        const r = await idbTagStore.syncPush((done, total) => {
          setProgress({ phase: 'gist', done, total, message: m.background.pushingTags });
        });
        setIdleMessage(r.pushed > 0 ? m.background.gistPushDone(r.pushed) : m.background.gistPushNoChanges);
        return { ok: true, data: r };
      }
      case 'gistPull': {
        const m = await getLocaleMessages();
        setProgress({ phase: 'gist', done: 0, total: null, message: m.background.pullingTags });
        const r = await idbTagStore.syncPull((done, total) => {
          setProgress({ phase: 'gist', done, total, message: m.background.pullingTags });
        });
        broadcastDataChanged();
        setIdleMessage(m.background.gistPullDone(r.merged, r.total));
        return { ok: true, data: r };
      }
      case 'getStatus':
        return { ok: true, data: { progress: lastProgress, hasToken: await authStore.hasToken(), seenOnboarding: (await authStore.getConfig()).seenOnboarding, seenTooltips: (await authStore.getConfig()).seenTooltips } };
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
        // Backfill account identity (avatar/displayName) for users who verified
        // before those fields were captured. One authenticated GET /user; the
        // result is persisted so it never refetches. No-op + returns cached
        // account if there's no usable token.
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
      case 'setTags':
        await idbTagStore.setTags(req.full_name, req.tags);
        broadcastDataChanged();
        return { ok: true };
      case 'setNotes':
        await idbTagStore.setNotes(req.full_name, req.notes);
        broadcastDataChanged();
        return { ok: true };
      case 'deleteTag': {
        // Remove this tag from every repo that has it (+ drop its meta).
        const r = await idbTagStore.deleteTag(req.name);
        broadcastDataChanged();
        return { ok: true, data: r };
      }
      case 'acceptSuggestions': {
        const existing = (await idbTagStore.get(req.full_name))?.tags ?? [];
        const merged = Array.from(new Set([...existing, ...req.toAdd]));
        await idbTagStore.setTags(req.full_name, merged);
        broadcastDataChanged();
        return { ok: true, data: { tags: merged } };
      }
      case 'suggestTags': {
        return { ok: true };
      }
      case 'testConnection': {
        // Diagnostic: fetch one page of /user/starred and return the raw HTTP
        // status + key headers, so the UI can show EXACTLY what GitHub returned
        // (instead of a stuck spinner). Never throws — returns ok:false with detail.
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
      case 'getTag': {
        return { ok: true, data: { tag: (await idbTagStore.get(req.full_name)) ?? null } };
      }
      case 'listExcluded':
        return { ok: true, data: await idbTagStore.listExcluded() };
      case 'markOnboardingSeen':
        await authStore.update({ seenOnboarding: true });
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
          const existing = (await idbTagStore.get(item.full_name))?.tags ?? [];
          const merged = Array.from(new Set([...existing, ...item.toAdd]));
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
    // Reset progress to idle on failure so the UI doesn't stay stuck on
    // "Fetching N pages…" when a sync throws (e.g. bad token, network).
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
});

/**
 * Startup self-check: runs whenever the service worker wakes. Prints a single
 * diagnostic line to the SW console so the user (opening "Inspect views:
 * service worker") immediately sees token presence, GitHub HTTP status, and the
 * live row count in the DB — without clicking anything. Throttled to once per
 * 30s to avoid spamming on frequent SW wakeups.
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
