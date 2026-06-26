import type { GistPayload, Tag, TagMeta } from '@/types';
import type { CountProgressCallback } from '@/api/tag-store';
import { db } from '@/storage/db';
import { authStore } from '@/auth/auth-store';
import { clearDirty } from '@/storage/idb-tag-store';
import { GIST_NO_TOKEN, GIST_CREATE_FAILED, GIST_PUSH_FAILED, GIST_PULL_FAILED } from '@/api/errors';

/**
 * Gist as a zero-server cross-device sync channel, storing one tags+tagMeta
 * JSON snapshot. push writes the full snapshot; pull merges per-repo by mtime
 * LWW (newer wins).
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
      files: { [GIST_FILENAME]: { content: JSON.stringify({ v: 1, tags: {}, tagMeta: {}, exportedAt: new Date().toISOString() }) } },
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
  const tags: GistPayload['tags'] = {};
  let done = 0;
  const tick = () => onProgress?.(done, total);
  tick();
  await db.tags.each((t) => {
    const { full_name: _fn, ...rest } = t;
    tags[t.full_name] = rest;
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
  return { payload: { v: 1, tags, tagMeta, exportedAt: new Date().toISOString() }, total };
}

export const gistTagStore = {
  /**
   * Push: write the full local snapshot to the gist. Clears the dirty set after.
   * (Full-snapshot push is simpler than diffing and the payload is ~600KB < 1MB.)
   */
  async push(
    dirtyNames: Set<string>,
    dirtyMeta: boolean,
    onProgress?: CountProgressCallback,
  ): Promise<{ pushed: number; snapshot: number; recreated: boolean }> {
    const hasLocalChanges = dirtyNames.size > 0 || dirtyMeta;
    const pushed = dirtyNames.size + (dirtyMeta ? 1 : 0);
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
    clearDirty(dirtyNames, dirtyMeta);
    await authStore.update({ gistSyncCursor: payload.exportedAt });
    onProgress?.(total, total);
    return { pushed, snapshot: total, recreated };
  },

  /**
   * Pull: read the gist and merge each record by `mtime`. Returns the count of
   * records
   * that were updated locally from the remote.
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

    // Merge tags per-repo by mtime.
    for (const [full_name, remoteTag] of Object.entries(remote.tags)) {
      const local = await db.tags.get(full_name);
      const remoteMtime = remoteTag.mtime;
      if (!local || remoteMtime > local.mtime) {
        const mergedTag: Tag = { full_name, ...remoteTag, favorite: remoteTag.favorite ?? false };
        await db.tags.put(mergedTag);
        merged++;
      }
      done++;
      if (done === total || done % 50 === 0) tick();
    }

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
