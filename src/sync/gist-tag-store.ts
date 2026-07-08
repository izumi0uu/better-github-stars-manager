import type { GistPayload, GistPayloadV1, GistPayloadV2, Tag, TagMeta } from '@/types';
import type { CountProgressCallback } from '@/api/tag-store';
import { db } from '@/storage/db';
import { authStore } from '@/auth/auth-store';
import { clearDirty, type DirtySnapshot } from '@/storage/idb-tag-store';
import { GIST_NO_TOKEN, GIST_CREATE_FAILED, GIST_PUSH_FAILED, GIST_PULL_FAILED } from '@/api/errors';
import { normalizeStoredTag, type LegacyTagRow } from '@/storage/tag-shape';

/**
 * Gist as a zero-server cross-device sync channel, storing one tags+tagMeta
 * JSON snapshot. push writes the full snapshot; pull merges tag assignment
 * layers independently so auto-tag reconciliation cannot overwrite newer
 * manual tags from another device.
 *
 * Pull can import the released v1 `tags[]` payload shape. Mixed-version writes
 * from unpublished/development builds are not a supported compatibility mode.
 */

const GIST_FILENAME = 'better-github-stars-manager-tags.json';
const GIST_DESC = 'Better GitHub Stars Manager — tag sync (do not edit)';

function gistHeaders(): Promise<HeadersInit> {
  return authStore.getToken().then((token) => {
    if (!token) throw new Error(GIST_NO_TOKEN);
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
  });
}

async function clearBoundGist(): Promise<void> {
  await authStore.update({ gistId: null, gistSyncCursor: null });
}

async function createGist(): Promise<string> {
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: await gistHeaders(),
    body: JSON.stringify({
      description: GIST_DESC,
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({ v: 2, tags: {}, tagMeta: {}, exportedAt: new Date().toISOString() }) } },
    }),
  });
  if (!res.ok) throw new Error(GIST_CREATE_FAILED);
  const body = (await res.json()) as { id: string };
  await authStore.update({ gistId: body.id });
  return body.id;
}

async function ensureWritableGist(): Promise<{ id: string; recreated: boolean }> {
  const cfg = await authStore.getConfig();
  if (cfg.gistId) {
    const res = await fetch(`https://api.github.com/gists/${cfg.gistId}`, {
      headers: await gistHeaders(),
    });
    if (res.ok) return { id: cfg.gistId, recreated: false };
    if (res.status !== 404) throw new Error(GIST_PUSH_FAILED);
    await clearBoundGist();
  }
  return { id: await createGist(), recreated: true };
}

async function readGist(id: string): Promise<{ payload: GistPayload | null; missing: boolean }> {
  const res = await fetch(`https://api.github.com/gists/${id}`, { headers: await gistHeaders() });
  // 404 = the gist was deleted; 401/403 = token lost Gist access. Surface these
  // instead of silently returning null (which used to look like "0 merged" on Pull).
  if (res.status === 404) {
    await clearBoundGist();
    return { payload: null, missing: true };
  }
  if (!res.ok) throw new Error(GIST_PULL_FAILED);
  const body = (await res.json()) as { files?: Record<string, { content?: string }> };
  const file = body.files?.[GIST_FILENAME];
  if (!file?.content) return { payload: null, missing: false };
  try {
    return { payload: JSON.parse(file.content) as GistPayload, missing: false };
  } catch {
    return { payload: null, missing: false };
  }
}

type PullResult = {
  merged: number;
  total: number;
  missing: boolean;
};

async function buildPayload(onProgress?: CountProgressCallback): Promise<{ payload: GistPayload; total: number }> {
  const total = (await db.tags.count()) + (await db.tagMeta.count());
  const tags: GistPayloadV2['tags'] = {};
  let done = 0;
  const tick = () => onProgress?.(done, total);
  tick();
  await db.tags.each((t) => {
    const normalized = normalizeStoredTag(t as LegacyTagRow);
    tags[normalized.full_name] = {
      manualTags: normalized.manualTags,
      autoTags: normalized.autoTags,
      dismissedAutoTags: normalized.dismissedAutoTags,
      manualTagsMtime: normalized.manualTagsMtime,
      autoTagsMtime: normalized.autoTagsMtime,
      dismissedAutoTagsMtime: normalized.dismissedAutoTagsMtime,
      notes: normalized.notes,
      favorite: normalized.favorite,
      watch: normalized.watch,
      gh_list_id: normalized.gh_list_id,
      mtime: normalized.mtime,
    };
    done++;
    if (done === total || done % 50 === 0) tick();
  });
  const tagMeta: GistPayload['tagMeta'] = {};
  await db.tagMeta.each((m) => {
    const { name: _n, ...rest } = m;
    tagMeta[m.name] = rest;
    done++;
    if (done === total || done % 50 === 0) tick();
  });
  tick();
  return { payload: { v: 2, tags, tagMeta, exportedAt: new Date().toISOString() }, total };
}

export const gistTagStore = {
  /**
   * Push: write the full local snapshot to the gist. Clears the dirty set after.
   * (Full-snapshot push is simpler than diffing and the payload is ~600KB < 1MB.)
   */
  async push(
    dirtySnapshot: DirtySnapshot,
    onProgress?: CountProgressCallback,
  ): Promise<{ pushed: number; snapshot: number; recreated: boolean }> {
    const pushedNames = new Set(dirtySnapshot.names.map(({ name }) => name));
    const pushingMeta = dirtySnapshot.meta;
    const hasLocalChanges = pushedNames.size > 0 || pushingMeta;
    const pushed = pushedNames.size + (pushingMeta ? 1 : 0);
    const { id, recreated } = await ensureWritableGist();
    // Explicit Push still creates/binds a gist when none exists, even if the
    // local snapshot hasn't changed since the last sync. Only skip work when
    // we're already bound to a live gist and there is nothing new to upload.
    if (!hasLocalChanges && !recreated) return { pushed: 0, snapshot: 0, recreated: false };

    const { payload, total } = await buildPayload(onProgress);
    const res = await fetch(`https://api.github.com/gists/${id}`, {
      method: 'PATCH',
      headers: await gistHeaders(),
      body: JSON.stringify({
        description: GIST_DESC,
        files: { [GIST_FILENAME]: { content: JSON.stringify(payload) } },
      }),
    });
    if (!res.ok) throw new Error(GIST_PUSH_FAILED);
    clearDirty(dirtySnapshot);
    await authStore.update({ gistSyncCursor: payload.exportedAt });
    onProgress?.(total, total);
    return { pushed, snapshot: total, recreated };
  },

  /**
   * Pull: read the gist and merge tag assignment layers independently. Notes,
   * favorite, and gh_list_id keep row-level mtime conflict resolution.
   */
  async pull(onProgress?: CountProgressCallback): Promise<PullResult> {
    const cfg = await authStore.getConfig();
    if (!cfg.gistId) {
      // No gist yet — nothing to pull. (First device to sync pushes first.)
      return { merged: 0, total: 0, missing: false };
    }
    const { payload: remote, missing } = await readGist(cfg.gistId);
    if (!remote) return { merged: 0, total: 0, missing };
    const total = Object.keys(remote.tags).length + Object.keys(remote.tagMeta).length;

    let merged = 0;
    let done = 0;
    const tick = () => onProgress?.(done, total);
    tick();

    // Merge each assignment layer independently. Released v1 payloads are
    // adapted at the import boundary; v2 rows must already be explicit layers.
    const remoteTagEntries = Object.entries(remote.tags);
    const localRows = await db.tags.bulkGet(remoteTagEntries.map(([full_name]) => full_name)) as (LegacyTagRow | undefined)[];
    const mergedTags: Tag[] = [];
    for (const [index, [full_name, remoteTag]] of remoteTagEntries.entries()) {
      const localRow = localRows[index];
      const local = localRow ? normalizeStoredTag(localRow) : undefined;
      const remoteNormalized = normalizeGistTag(full_name, remoteTag, remote.v);
      if (!remoteNormalized) {
        done++;
        if (done === total || done % 50 === 0) tick();
        continue;
      }
      if (!local) {
        mergedTags.push(remoteNormalized);
        merged++;
      } else {
        const next = mergeTagRowsByLayer(local, remoteNormalized);
        if (next.changed) {
          mergedTags.push(next.tag);
          merged++;
        }
      }
      done++;
      if (done === total || done % 50 === 0) tick();
    }
    if (mergedTags.length > 0) await db.tags.bulkPut(mergedTags);

    // Merge tagMeta by mtime.
    for (const [name, remoteMeta] of Object.entries(remote.tagMeta)) {
      const local = await db.tagMeta.get(name);
      if (!local || remoteMeta.mtime > local.mtime) {
        const mergedMeta: TagMeta = { name, ...remoteMeta };
        await db.tagMeta.put(mergedMeta);
        merged++;
      }
      done++;
      if (done === total || done % 50 === 0) tick();
    }

    tick();
    return { merged, total, missing: false };
  },
};

function normalizeGistTag(
  full_name: string,
  remoteTag: GistPayloadV1['tags'][string] | GistPayloadV2['tags'][string],
  version: GistPayload['v'],
): Tag | null {
  if (version === 1) return normalizeStoredTag({ full_name, ...remoteTag });
  const row = remoteTag as Partial<GistPayloadV2['tags'][string]>;
  if (!isStringArray(row.manualTags)) return null;
  if (!isStringArray(row.autoTags)) return null;
  if (!isStringArray(row.dismissedAutoTags)) return null;
  if (
    typeof row.manualTagsMtime !== 'string' ||
    typeof row.autoTagsMtime !== 'string' ||
    typeof row.dismissedAutoTagsMtime !== 'string' ||
    typeof row.notes !== 'string' ||
    typeof row.mtime !== 'string' ||
    (row.favorite !== undefined && typeof row.favorite !== 'boolean') ||
    (row.watch !== undefined && !isGistWatchIntent(row.watch)) ||
    (row.gh_list_id !== undefined && row.gh_list_id !== null && typeof row.gh_list_id !== 'number')
  ) {
    return null;
  }
  return normalizeStoredTag({
    full_name,
    manualTags: row.manualTags,
    autoTags: row.autoTags,
    dismissedAutoTags: row.dismissedAutoTags,
    manualTagsMtime: row.manualTagsMtime,
    autoTagsMtime: row.autoTagsMtime,
    dismissedAutoTagsMtime: row.dismissedAutoTagsMtime,
    notes: row.notes,
    favorite: row.favorite,
    watch: row.watch,
    gh_list_id: row.gh_list_id,
    mtime: row.mtime,
  });
}


function isGistWatchIntent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { enabled?: unknown; reasons?: unknown };
  return typeof candidate.enabled === 'boolean' && isStringArray(candidate.reasons);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function mergeTagRowsByLayer(local: Tag, remote: Tag): { tag: Tag; changed: boolean } {
  let changed = false;
  const next: Tag = { ...local };

  if (remote.manualTagsMtime > local.manualTagsMtime) {
    next.manualTags = remote.manualTags;
    next.manualTagsMtime = remote.manualTagsMtime;
    changed = true;
  }
  if (remote.autoTagsMtime > local.autoTagsMtime) {
    next.autoTags = remote.autoTags;
    next.autoTagsMtime = remote.autoTagsMtime;
    changed = true;
  }
  if (remote.dismissedAutoTagsMtime > local.dismissedAutoTagsMtime) {
    next.dismissedAutoTags = remote.dismissedAutoTags;
    next.dismissedAutoTagsMtime = remote.dismissedAutoTagsMtime;
    changed = true;
  }
  if (remote.mtime > local.mtime) {
    next.notes = remote.notes;
    next.favorite = remote.favorite;
    next.watch = remote.watch;
    next.gh_list_id = remote.gh_list_id;
    next.mtime = remote.mtime;
    changed = true;
  }

  const normalized = normalizeStoredTag(next);
  return { tag: normalized, changed };
}
