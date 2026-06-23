import type { GistPayload, Tag, TagMeta } from '@/types';
import type { CountProgressCallback } from '@/api/tag-store';
import { db } from '@/storage/db';
import { authStore } from '@/auth/auth-store';
import { clearDirty } from '@/storage/idb-tag-store';

/**
 * GistTagStore — cross-device transport for the tag layer (Q5 C2).
 *
 * Gist is the zero-server sync channel (Q2=C). We store ONE gist containing a
 * GistPayload: { v, tags: { [full_name]: {tags,notes,mtime} }, tagMeta, exportedAt }.
 *
 * Merge strategy = per-repo field-level LWW:
 *  - PUSH: serialize the full local tags/tagMeta stores into the gist (the gist is
 *    a complete snapshot, not a diff — simplest correct option at ~600KB).
 *  - PULL: for each repo in the gist, compare its mtime to the local record's mtime;
 *    take whichever is newer. Same for tagMeta. This means two devices editing
 *    DIFFERENT repos never lose data; only same-repo same-instant edits collide
 *    (last writer wins), which is acceptable for this usage pattern.
 *
 * Fine-grained PAT caveat (Q4): gist scope is account-wide (no per-gist isolation).
 * We create a dedicated gist for sync to limit blast radius.
 */

const GIST_FILENAME = 'better-github-stars-manager-tags.json';
const GIST_DESC = 'Better GitHub Stars Manager — tag sync (do not edit)';

function gistHeaders(): Promise<HeadersInit> {
  return authStore.getToken().then((token) => {
    if (!token) throw new Error('No token for Gist sync');
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
  });
}

async function findOrCreateGist(): Promise<string> {
  const cfg = await authStore.getConfig();
  if (cfg.gistId) {
    // Verify it still exists.
    const res = await fetch(`https://api.github.com/gists/${cfg.gistId}`, {
      headers: await gistHeaders(),
    });
    if (res.ok) return cfg.gistId;
    // Gone — fall through to create.
  }
  // Create an empty secret gist.
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: await gistHeaders(),
    body: JSON.stringify({
      description: GIST_DESC,
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({ v: 1, tags: {}, tagMeta: {}, exportedAt: new Date().toISOString() }) } },
    }),
  });
  if (!res.ok) throw new Error(`Could not create Gist: ${res.status}`);
  const body = (await res.json()) as { id: string };
  await authStore.update({ gistId: body.id });
  return body.id;
}

async function readGist(id: string): Promise<GistPayload | null> {
  const res = await fetch(`https://api.github.com/gists/${id}`, { headers: await gistHeaders() });
  if (!res.ok) return null;
  const body = (await res.json()) as { files?: Record<string, { content?: string }> };
  const file = body.files?.[GIST_FILENAME];
  if (!file?.content) return null;
  try {
    return JSON.parse(file.content) as GistPayload;
  } catch {
    return null;
  }
}

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
  async push(dirtyNames: Set<string>, dirtyMeta: boolean, onProgress?: CountProgressCallback): Promise<{ pushed: number; snapshot: number }> {
    if (dirtyNames.size === 0 && !dirtyMeta) return { pushed: 0, snapshot: 0 };
    const pushed = dirtyNames.size + (dirtyMeta ? 1 : 0);
    const id = await findOrCreateGist();
    const { payload, total } = await buildPayload(onProgress);
    const res = await fetch(`https://api.github.com/gists/${id}`, {
      method: 'PATCH',
      headers: await gistHeaders(),
      body: JSON.stringify({
        description: GIST_DESC,
        files: { [GIST_FILENAME]: { content: JSON.stringify(payload) } },
      }),
    });
    if (!res.ok) throw new Error(`Gist push failed: ${res.status}`);
    clearDirty(dirtyNames, dirtyMeta);
    await authStore.update({ gistSyncCursor: payload.exportedAt });
    onProgress?.(total, total);
    return { pushed, snapshot: total };
  },

  /**
   * Pull: read the gist, merge per-repo by mtime (LWW). Returns count of records
   * that were updated locally from the remote.
   */
  async pull(onProgress?: CountProgressCallback): Promise<{ merged: number; total: number }> {
    const cfg = await authStore.getConfig();
    if (!cfg.gistId) {
      // No gist yet — nothing to pull. (First device to sync pushes first.)
      return { merged: 0, total: 0 };
    }
    const remote = await readGist(cfg.gistId);
    if (!remote) return { merged: 0, total: 0 };
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
        const mergedTag: Tag = { full_name, ...remoteTag };
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
    return { merged, total };
  },
};
