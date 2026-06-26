import { authStore } from '@/auth/auth-store';
import { githubStarSource } from '@/api/github-star-source';
import { getMessages } from '@/i18n';
import { idbTagStore } from '@/storage/idb-tag-store';
import { db, liveStarCount } from '@/storage/db';
import { queryStars, invalidateCache, type QueryParams, type QueryResult } from './query';
import { suggestTags } from '@/ui/suggest';
import { translateError } from '@/api/errors';
import type { SyncProgress } from '@/types';

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
  | { type: 'deleteTag'; name: string }
  | { type: 'acceptSuggestions'; full_name: string; toAdd: string[] }
  | { type: 'acceptSuggestionsBatch'; items: { full_name: string; toAdd: string[] }[] }
  | { type: 'suggestTags'; full_name: string }
  | { type: 'getTag'; full_name: string }
  | { type: 'listExcluded' }
  | { type: 'markOnboardingSeen' }
  | { type: 'markTooltipSeen'; bit: number }
  | { type: 'testConnection' }
  | { type: 'openOptions' };

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
 * Auto-tag every star from its topics (NOT language — language is a sidebar
 * filter, not a tag; full rationale in suggest.ts). Pure-local, idempotent,
 * preserves notes. Runs after each sync; excluded names are skipped so deleted
 * tags don't resurrect.
 */
async function autoTagAll(): Promise<{ tagged: number }> {
  const stars = await db.stars.toArray();
  const excluded = new Set(await idbTagStore.listExcluded());
  let tagged = 0;
  for (const star of stars) {
    const existing = (await idbTagStore.get(star.full_name))?.tags ?? [];
    const toAdd = suggestTags(star, existing, excluded);
    if (toAdd.length > 0) {
      const merged = Array.from(new Set([...existing, ...toAdd]));
      if (merged.length !== existing.length) {
        await idbTagStore.setTags(star.full_name, merged);
        tagged++;
      }
    }
  }
  return { tagged };
}

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
      const next = t.tags.filter((x) => !toRemove.has(x));
      if (next.length === t.tags.length) continue; // already clean
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
        if (r.pushed > 0) setIdleMessage(m.background.gistPushDone(r.pushed));
        else if (r.recreated) setIdleMessage(m.background.gistPushRecreated);
        else setIdleMessage(m.background.gistPushNoChanges);
        return { ok: true, data: r };
      }
      case 'gistPull': {
        const m = await getLocaleMessages();
        setProgress({ phase: 'gist', done: 0, total: null, message: m.background.pullingTags });
        const r = await idbTagStore.syncPull((done, total) => {
          setProgress({ phase: 'gist', done, total, message: m.background.pullingTags });
        });
        broadcastDataChanged();
        if (r.missing) setIdleMessage(m.background.gistPullMissing);
        else setIdleMessage(m.background.gistPullDone(r.merged, r.total));
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
migrateLanguageTags();
