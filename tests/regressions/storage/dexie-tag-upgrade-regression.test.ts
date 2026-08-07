import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import { beforeEach, describe, it } from 'vitest';
import { StarsDB } from '@/storage/db';

const DB_NAME = 'better-github-stars-manager';
const LEGACY_MTIME = '2026-06-22T10:00:00.000Z';

function defineLegacySchema(db: Dexie, version: 1 | 2): void {
  db.version(1).stores({
    stars: 'full_name, language, starred_at, pushed_at, tombstone',
    tags: 'full_name, *tags, mtime',
    tagMeta: 'name, dimension, mtime',
  });
  if (version === 2) {
    db.version(2).stores({
      stars: 'full_name, language, starred_at, pushed_at, tombstone',
      tags: 'full_name, *tags, mtime',
      tagMeta: 'name, dimension, mtime',
    });
  }
}

async function seedLegacyTagDb(version: 1 | 2): Promise<void> {
  const legacy = new Dexie(DB_NAME);
  defineLegacySchema(legacy, version);
  await legacy.open();
  await legacy.table('tags').put({
    full_name: 'owner/legacy',
    tags: ['ui', 'react', 'ui', ''],
    notes: 'keep notes',
    favorite: true,
    mtime: LEGACY_MTIME,
    gh_list_id: 42,
  });
  await legacy.close();
}

beforeEach(async () => {
  await Dexie.delete(DB_NAME);
});

describe('Dexie tag schema upgrades', () => {
  for (const version of [1, 2] as const) {
    it(`migrates released v${version} legacy tags into manual tag layers`, async () => {
      await seedLegacyTagDb(version);

      const current = new StarsDB();
      try {
        await current.open();
        const row = await current.tags.get('owner/legacy');

        assert.ok(row);
        assert.deepEqual(row.manualTags, ['ui', 'react']);
        assert.deepEqual(row.autoTags, []);
        assert.deepEqual(row.dismissedAutoTags, []);
        assert.equal(row.manualTagsMtime, LEGACY_MTIME);
        assert.equal(row.autoTagsMtime, LEGACY_MTIME);
        assert.equal(row.dismissedAutoTagsMtime, LEGACY_MTIME);
        assert.equal(row.notes, 'keep notes');
        assert.equal(row.favorite, true);
        assert.equal(row.mtime, LEGACY_MTIME);
        assert.equal(row.gh_list_id, 42);
        assert.equal('tags' in row, false);
        assert.equal(current.tags.schema.indexes.some((index) => index.name === 'tags'), false);
        assert.deepEqual(
          current.tables.map((table) => table.name).sort(),
          [
            'agentArtifactChunks',
            'agentArtifacts',
            'agentAttempts',
            'agentMessages',
            'agentSessions',
            'agentStorageUsage',
            'organizeApplies',
            'organizeApplyRows',
            'organizeItems',
            'organizeJobs',
            'organizeTaxonomies',
            'stars',
            'tagDirtyOutbox',
            'tagMeta',
            'tags',
          ].sort(),
        );
        assert.equal(await current.organizeJobs.count(), 0);
        assert.equal(await current.tagDirtyOutbox.count(), 0);
        assert.equal(await current.agentSessions.count(), 0);
        assert.equal(await current.agentAttempts.count(), 0);
        assert.equal(await current.agentMessages.count(), 0);
        assert.equal(await current.agentArtifacts.count(), 0);
        assert.equal(await current.agentArtifactChunks.count(), 0);
        assert.equal(await current.agentStorageUsage.count(), 0);
        assert.equal(
          current.organizeJobs.schema.indexes.some(
            (index) => index.name === 'originAgentSessionId',
          ),
          true,
        );
        assert.equal(
          current.organizeJobs.schema.indexes.some(
            (index) => index.name === 'sessionId',
          ),
          true,
        );
        assert.equal(
          current.agentMessages.schema.indexes.some(
            (index) => index.name === '[sessionId+sequence]' && index.unique,
          ),
          true,
        );
        assert.equal(
          current.agentArtifactChunks.schema.indexes.some(
            (index) => index.name === '[artifactId+index]' && index.unique,
          ),
          true,
        );
        assert.equal(
          current.agentAttempts.schema.indexes.some(
            (index) => index.name === '[sessionId+turnAttemptId]' && index.unique,
          ),
          true,
        );
      } finally {
        await current.close();
        await Dexie.delete(DB_NAME);
      }
    });
  }
});
