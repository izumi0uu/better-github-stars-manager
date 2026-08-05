import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { db } from '@/storage/db';
import { createChromeMock } from '../../helpers/chrome-mock';
import {
  clearWatchData,
  disconnectWatchInbox,
  getWatchRepositories,
  getWatchState,
  queryStoredWatchInbox,
  reconcileWatchAccount,
  reconcileWatchLiveStars,
  recordWatchInboxFailure,
  recordWatchScopeFailure,
  replaceWatchInbox,
  replaceWatchScope,
  revalidateWatchInbox,
} from '@/storage/watch-store';
import type { GitHubNotificationThread } from '@/watch/watch-model';

const chromeMock = createChromeMock();
Object.defineProperty(globalThis, 'chrome', { value: chromeMock.api, configurable: true });

const { CONFIG_STORAGE_KEY } = await import('@/auth/auth-store');
const {
  markDirtyForLocalWrites,
  resetDirtyForDev,
  snapshotDirty,
} = await import('@/storage/idb-tag-store');

const ACCOUNT = 'Idah';
const FIRST = '2026-08-05T01:00:00.000Z';
const SECOND = '2026-08-05T02:00:00.000Z';

function thread(id: string, repositoryFullName = 'owner/repo'): GitHubNotificationThread {
  return {
    id,
    repositoryFullName,
    repositoryHtmlUrl: `https://github.com/${repositoryFullName}`,
    reason: 'subscribed',
    subjectType: 'Issue',
    subjectTitle: `Thread ${id}`,
    subjectApiUrl: `https://api.github.com/repos/${repositoryFullName}/issues/1`,
    subjectHtmlUrl: `https://github.com/${repositoryFullName}/issues/1`,
    unread: true,
    updatedAt: FIRST,
    lastReadAt: null,
    fetchedAt: FIRST,
  };
}

function star(fullName: string, tombstone = false) {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: '',
    language: null,
    stargazers_count: 0,
    topics: [],
    pushed_at: null,
    created_at: null,
    fork: false,
    archived: false,
    starred_at: FIRST,
    tombstone,
    synced_at: FIRST,
  };
}

async function snapshotNonWatchData() {
  const [
    stars,
    tags,
    tagMeta,
    organizeJobs,
    organizeItems,
    organizeTaxonomies,
    organizeApplies,
    organizeApplyRows,
    tagDirtyOutbox,
    storedConfig,
  ] = await Promise.all([
    db.stars.toArray(),
    db.tags.toArray(),
    db.tagMeta.toArray(),
    db.organizeJobs.toArray(),
    db.organizeItems.toArray(),
    db.organizeTaxonomies.toArray(),
    db.organizeApplies.toArray(),
    db.organizeApplyRows.toArray(),
    db.tagDirtyOutbox.toArray(),
    chromeMock.api.storage.local.get(CONFIG_STORAGE_KEY),
  ]);
  return {
    stars,
    tags,
    tagMeta,
    organizeJobs,
    organizeItems,
    organizeTaxonomies,
    organizeApplies,
    organizeApplyRows,
    tagDirtyOutbox,
    config: storedConfig[CONFIG_STORAGE_KEY],
    dirty: snapshotDirty(),
  };
}

describe('Watch snapshot storage', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await chromeMock.api.storage.local.clear();
    resetDirtyForDev();
  });

  afterAll(async () => {
    resetDirtyForDev();
    await db.close();
  });

  it('atomically replaces a successful scope and preserves it after failure', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'Owner/One' }, { full_name: 'owner/two' }],
      attemptedAt: FIRST,
    });
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/two' }],
      attemptedAt: SECOND,
    });

    assert.deepEqual(await getWatchRepositories('idah'), [{ full_name: 'owner/two' }]);

    await recordWatchScopeFailure({
      accountLogin: ACCOUNT,
      attemptedAt: '2026-08-05T03:00:00.000Z',
      errorCode: 'network_error',
    });

    assert.deepEqual(await getWatchRepositories('IDAH'), [{ full_name: 'owner/two' }]);
    const state = await getWatchState('idah');
    assert.equal(state?.scope.lastSuccessfulAt, SECOND);
    assert.equal(state?.scope.errorCode, 'network_error');
  });

  it('rolls back scope rows, pruned Inbox rows, and state when the scope checkpoint fails', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/one' }, { full_name: 'owner/two' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('1', 'owner/one'), thread('2', 'owner/two')],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: SECOND,
      candidateCount: 2,
      truncated: false,
    });
    const before = {
      repositories: await db.watchRepositories.orderBy('full_name').toArray(),
      threads: await db.watchNotificationThreads.orderBy('id').toArray(),
      state: await db.watchState.get('singleton'),
    };
    const stateWrite = vi.spyOn(db.watchState, 'put')
      .mockRejectedValueOnce(new Error('scope state checkpoint failed'));

    try {
      await assert.rejects(
        () => replaceWatchScope({
          accountLogin: ACCOUNT,
          repositories: [{ full_name: 'owner/two' }, { full_name: 'owner/three' }],
          attemptedAt: SECOND,
        }),
        /scope state checkpoint failed/u,
      );
    } finally {
      stateWrite.mockRestore();
    }

    assert.deepEqual(
      {
        repositories: await db.watchRepositories.orderBy('full_name').toArray(),
        threads: await db.watchNotificationThreads.orderBy('id').toArray(),
        state: await db.watchState.get('singleton'),
      },
      before,
    );
  });

  it('rolls back Inbox rows and state when the Inbox checkpoint fails', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/one' }, { full_name: 'owner/two' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('1', 'owner/one'), thread('2', 'owner/two')],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: SECOND,
      candidateCount: 2,
      truncated: false,
    });
    const before = {
      threads: await db.watchNotificationThreads.orderBy('id').toArray(),
      state: await db.watchState.get('singleton'),
    };
    const stateWrite = vi.spyOn(db.watchState, 'put')
      .mockRejectedValueOnce(new Error('Inbox state checkpoint failed'));

    try {
      await assert.rejects(
        () => replaceWatchInbox({
          accountLogin: ACCOUNT,
          threads: [thread('replacement', 'owner/two')],
          attemptedAt: SECOND,
          lastModified: 'Wed, 05 Aug 2026 02:00:00 GMT',
          nextAllowedAt: '2026-08-05T03:00:00.000Z',
          candidateCount: 1,
          truncated: true,
        }),
        /Inbox state checkpoint failed/u,
      );
    } finally {
      stateWrite.mockRestore();
    }

    assert.deepEqual(
      {
        threads: await db.watchNotificationThreads.orderBy('id').toArray(),
        state: await db.watchState.get('singleton'),
      },
      before,
    );
  });

  it('removes cached Inbox threads outside a newly successful scope', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/one' }, { full_name: 'owner/two' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [
        thread('1', 'owner/one'),
        thread('2', 'owner/two'),
        thread('3', 'outside/scope'),
      ],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: SECOND,
      candidateCount: 3,
      truncated: false,
    });

    const initial = await queryStoredWatchInbox({ accountLogin: 'idah', unreadOnly: false });
    assert.deepEqual(initial.threads.map((row) => row.id), ['1', '2']);
    assert.equal(initial.state?.inbox.matchedCount, 2);

    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/two' }],
      attemptedAt: SECOND,
    });

    const result = await queryStoredWatchInbox({ accountLogin: 'idah', unreadOnly: false });
    assert.deepEqual(result.threads.map((row) => row.id), ['2']);
    assert.equal(result.state?.inbox.matchedCount, 1);
    assert.equal(result.state?.inbox.lastModified, null);
    assert.equal(result.state?.inbox.nextAllowedAt, null);
    assert.equal(result.state?.inbox.errorCode, 'scope_changed');
    assert.deepEqual(await db.watchNotificationThreads.toCollection().primaryKeys(), ['2']);
  });

  it('keeps the last Inbox on failure and 304-style revalidation', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('1')],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: SECOND,
      candidateCount: 2,
      truncated: true,
    });
    await recordWatchInboxFailure({
      accountLogin: ACCOUNT,
      attemptedAt: SECOND,
      errorCode: 'github_unavailable',
    });

    assert.deepEqual((await queryStoredWatchInbox({ accountLogin: 'idah' })).threads.map((row) => row.id), ['1']);

    await revalidateWatchInbox({
      accountLogin: ACCOUNT,
      attemptedAt: '2026-08-05T03:00:00.000Z',
      nextAllowedAt: '2026-08-05T03:01:00.000Z',
    });

    const result = await queryStoredWatchInbox({ accountLogin: 'idah' });
    assert.deepEqual(result.threads.map((row) => row.id), ['1']);
    assert.equal(result.state?.inbox.errorCode, null);
    assert.equal(result.state?.inbox.candidateCount, 2);
    assert.equal(result.state?.inbox.truncated, true);
  });

  it('isolates account changes and lets disconnect clear only private Inbox data', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('1')],
      attemptedAt: FIRST,
      lastModified: null,
      nextAllowedAt: SECOND,
      candidateCount: 1,
      truncated: false,
    });

    await disconnectWatchInbox('IDAH');
    assert.deepEqual(await getWatchRepositories('idah'), [{ full_name: 'owner/repo' }]);
    assert.equal((await queryStoredWatchInbox({ accountLogin: 'idah' })).threads.length, 0);

    await replaceWatchScope({
      accountLogin: 'another-user',
      repositories: [{ full_name: 'other/repo' }],
      attemptedAt: SECOND,
    });
    assert.equal(await getWatchState('idah'), null);
    assert.deepEqual(await getWatchRepositories('another-user'), [{ full_name: 'other/repo' }]);
  });

  it('never rebinds mismatched or orphaned rows to another account', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'alice/private' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('private', 'alice/private')],
      attemptedAt: FIRST,
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
    });

    await disconnectWatchInbox('bob');
    assert.equal(await db.watchRepositories.count(), 0);
    assert.equal(await db.watchNotificationThreads.count(), 0);
    assert.equal(await db.watchState.count(), 0);

    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'alice/private' }],
      attemptedAt: FIRST,
    });
    await db.watchState.clear();
    await recordWatchScopeFailure({
      accountLogin: 'bob',
      attemptedAt: SECOND,
      errorCode: 'network_error',
    });
    assert.deepEqual(await getWatchRepositories('bob'), []);
    assert.equal(await db.watchRepositories.count(), 0);

    await db.watchRepositories.put({ full_name: 'alice/private' });
    await db.watchState.clear();
    await disconnectWatchInbox(null);
    assert.equal(await db.watchRepositories.count(), 0);
  });

  it('clears only Watch data while preserving annotations, Agent stores, and Gist state', async () => {
    await Promise.all([
      db.stars.put({
        full_name: 'owner/repo',
        html_url: 'https://github.com/owner/repo',
        description: '',
        language: null,
        stargazers_count: 1,
        topics: [],
        pushed_at: null,
        created_at: null,
        fork: false,
        archived: false,
        starred_at: FIRST,
        tombstone: false,
        synced_at: FIRST,
      }),
      db.tags.put({
        full_name: 'owner/repo',
        manualTags: ['preserved'],
        autoTags: ['agent'],
        dismissedAutoTags: [],
        manualTagsMtime: FIRST,
        autoTagsMtime: FIRST,
        dismissedAutoTagsMtime: FIRST,
        notes: 'Keep this annotation.',
        favorite: true,
        mtime: FIRST,
      }),
      db.tagMeta.put({
        name: 'preserved',
        dimension: 'topic',
        color: '#123456',
        excluded: false,
        mtime: FIRST,
      }),
      db.organizeJobs.put({
        jobId: 'job:preserved',
        activeSlot: 'active',
        controllerId: 'controller:preserved',
        sessionId: 'session:preserved',
        runId: 'run:v1:preserved',
        generation: 1,
        proposalId: 'proposal:v1:preserved',
        frozenScope: {
          kind: 'all_stars',
          label: 'All stars',
          filterSnapshot: {},
          repositoryIds: ['owner/repo'],
          capturedAt: 1,
          fingerprint: 'scope:preserved',
        },
        taskInstruction: 'Preserve this Agent job.',
        budget: { maxBatches: 1 },
        usage: { batches: 0 },
        nextFrozenIndex: 1,
        analysisPendingRanges: [],
        providerBinding: null,
        status: 'apply_sealed',
        preflight: null,
        revision: 1,
        itemCount: 1,
        applyId: 'apply:preserved',
        pauseRequested: false,
        createdAt: 1,
        updatedAt: 2,
        completedAt: null,
        cancelledAt: null,
      }),
      db.organizeItems.put({
        id: 'job:preserved:0',
        jobId: 'job:preserved',
        position: 0,
        fullName: 'owner/repo',
        analysisState: 'actionable',
        proposedActions: [{
          kind: 'add_existing_tag',
          tag: 'preserved',
          evidence: 'Stored evidence.',
        }],
        approvedActions: [{
          kind: 'add_existing_tag',
          tag: 'preserved',
          evidence: 'Stored evidence.',
        }],
        proposedAdditions: ['preserved'],
        sourceFingerprint: 'source:preserved',
        selected: true,
        retryCount: 0,
        failure: null,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        analyzedAt: 2,
      }),
      db.organizeTaxonomies.put({
        jobId: 'job:preserved',
        fingerprint: 'taxonomy:preserved',
        snapshot: { entries: ['preserved'] },
        createdAt: 1,
      }),
      db.organizeApplies.put({
        applyId: 'apply:preserved',
        jobId: 'job:preserved',
        sourceRevision: 1,
        expectedTaxonomyFingerprint: 'taxonomy:preserved',
        status: 'sealed',
        rowCount: 1,
        createdAt: 2,
        updatedAt: 2,
        completedAt: null,
      }),
      db.organizeApplyRows.put({
        id: 'apply:preserved:0',
        applyId: 'apply:preserved',
        jobId: 'job:preserved',
        position: 0,
        fullName: 'owner/repo',
        approvedActions: [{
          kind: 'add_existing_tag',
          tag: 'preserved',
          evidence: 'Stored evidence.',
        }],
        approvedAdditions: ['preserved'],
        sourceFingerprint: 'source:preserved',
        taxonomyFingerprint: 'taxonomy:preserved',
        state: 'pending',
        outcomeReason: null,
        attemptCount: 0,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        settledAt: null,
      }),
      db.tagDirtyOutbox.put({
        id: 'tag:owner/repo',
        kind: 'tag',
        key: 'owner/repo',
        version: 'dirty:preserved',
        updatedAt: FIRST,
      }),
      chromeMock.api.storage.local.set({
        [CONFIG_STORAGE_KEY]: {
          gistId: 'gist:preserved',
          gistSyncCursor: SECOND,
        },
      }),
    ]);
    markDirtyForLocalWrites(['owner/repo'], true);
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('private')],
      attemptedAt: FIRST,
      lastModified: null,
      nextAllowedAt: SECOND,
      candidateCount: 1,
      truncated: false,
    });
    const before = await snapshotNonWatchData();

    await clearWatchData();

    assert.deepEqual(await snapshotNonWatchData(), before);
    assert.equal(await db.watchRepositories.count(), 0);
    assert.equal(await db.watchNotificationThreads.count(), 0);
    assert.equal(await db.watchState.count(), 0);
  });

  it('reconciles only stale account-bound Watch rows and is idempotent after a worker restart', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: FIRST,
    });

    assert.equal(await reconcileWatchAccount('another-user'), true);
    assert.equal(await db.watchState.count(), 0);
    assert.equal(await reconcileWatchAccount('another-user'), false);

    await replaceWatchScope({
      accountLogin: 'another-user',
      repositories: [{ full_name: 'other/repo' }],
      attemptedAt: SECOND,
    });
    assert.equal(await reconcileWatchAccount('another-user'), false);
    assert.deepEqual(await getWatchRepositories('another-user'), [{ full_name: 'other/repo' }]);
  });

  it('prunes cached scope and private threads when a star becomes a tombstone', async () => {
    await db.stars.bulkPut([star('owner/repo'), star('owner/other')]);
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }, { full_name: 'owner/other' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('keep', 'owner/repo'), thread('remove', 'owner/other')],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 2,
      truncated: false,
    });
    await db.stars.put(star('owner/other', true));

    assert.equal(await reconcileWatchLiveStars(ACCOUNT), true);
    assert.deepEqual(await getWatchRepositories(ACCOUNT), [{ full_name: 'owner/repo' }]);
    assert.deepEqual(
      (await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false })).threads
        .map((item) => item.id),
      ['keep'],
    );
    const state = await getWatchState(ACCOUNT);
    assert.equal(state?.scope.repositoryCount, 1);
    assert.equal(state?.inbox.matchedCount, 1);
    assert.equal(await reconcileWatchLiveStars(ACCOUNT), false);
  });
});
