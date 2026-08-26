import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { db, StarsDB } from '@/storage/db';
import { createChromeMock } from '../../helpers/chrome-mock';
import {
  appendWatchInboxHistory,
  applyWatchThreadMutation,
  commitWatchInboxScanBatch,
  mergeWatchInboxDelta,
  clearWatchData,
  countUnreadWatchThreads,
  disconnectWatchInbox,
  getWatchRepositories,
  getWatchState,
  queryStoredWatchInbox,
  reconcileWatchAccount,
  reconcileWatchLiveStars,
  recordWatchInboxFailure,
  recordWatchHistoryFailure,
  recordWatchScopeFailure,
  startWatchInboxScan,
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

const ACCOUNT = 'OctoCat';
const FIRST = '2026-08-05T01:00:00.000Z';
const SECOND = '2026-08-05T02:00:00.000Z';
const DB_NAME = 'better-github-stars-manager';

function defineLegacyWatchSchema(database: Dexie): void {
  database.version(5).stores({
    stars: 'full_name, language, starred_at, pushed_at, created_at, tombstone',
    tags: 'full_name, mtime',
    tagMeta: 'name, dimension, mtime',
    organizeJobs: 'jobId, &activeSlot, status, updatedAt, originAgentSessionId, sessionId',
    organizeItems: 'id, [jobId+position], [jobId+analysisState], jobId, position, analysisState, leaseExpiresAt',
    organizeTaxonomies: 'jobId',
    organizeApplies: 'applyId, jobId, status',
    organizeApplyRows: 'id, [applyId+position], [applyId+state], applyId, state, leaseExpiresAt',
    tagDirtyOutbox: 'id, kind, updatedAt',
    agentSessions: 'id, updatedAt, createdAt',
    agentMessages: 'id, sessionId, &[sessionId+sequence], [sessionId+turnAttemptId]',
    agentAttempts: 'id, sessionId, &[sessionId+turnAttemptId], [sessionId+state], updatedAt',
    agentAttemptRecoveries: 'id, sessionId, &[sessionId+turnAttemptId], updatedAt',
    agentArtifacts: 'id, sessionId, turnAttemptId, ownerMessageId, storageClass, [sessionId+storageClass], [storageClass+state+lastAccessedAt], [state+createdAt], expiresAt',
    agentArtifactChunks: 'id, artifactId, &[artifactId+index]',
    agentStorageUsage: 'id',
    watchRepositories: 'full_name',
    watchNotificationThreads: 'id, repositoryFullName, updatedAt, [repositoryFullName+updatedAt]',
    watchState: 'id',
    radarActivities: '&id, accountLogin, repositoryKey, starredAt, dismissedAt, [accountLogin+starredAt], [accountLogin+repositoryKey]',
    radarState: '&id, accountLogin, lastSuccessfulAt',
    recommendations: '&id, accountLogin',
    recommendationState: '&id, accountLogin',
    recommendationIgnores: '&id, accountLogin',
  });
}

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

    assert.deepEqual(await getWatchRepositories('octocat'), [{ full_name: 'owner/two' }]);

    await recordWatchScopeFailure({
      accountLogin: ACCOUNT,
      attemptedAt: '2026-08-05T03:00:00.000Z',
      errorCode: 'network_error',
    });

    assert.deepEqual(await getWatchRepositories('OCTOCAT'), [{ full_name: 'owner/two' }]);
    const state = await getWatchState('octocat');
    assert.equal(state?.scope.lastSuccessfulAt, SECOND);
    assert.equal(state?.scope.errorCode, 'network_error');
  });

  it('rolls back scope rows and state without coupling Inbox rows', async () => {
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
      mode: 'replace',
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
      mode: 'replace',
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
          mode: 'replace',
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

  it('keeps Inbox threads when native watched membership changes', async () => {
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
        thread('3', 'custom/repo'),
      ],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: SECOND,
      candidateCount: 3,
      truncated: false,
      mode: 'replace',
    });

    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/two' }],
      attemptedAt: SECOND,
    });

    const result = await queryStoredWatchInbox({ accountLogin: 'octocat', unreadOnly: false });
    assert.deepEqual(result.threads.map((row) => row.id), ['1', '2', '3']);
    assert.equal(result.state?.inbox.matchedCount, 3);
    assert.equal(result.state?.inbox.lastModified, 'Wed, 05 Aug 2026 01:00:00 GMT');
    assert.equal(result.state?.inbox.nextAllowedAt, SECOND);
    assert.equal(result.state?.inbox.errorCode, null);
  });

  it('normalizes malformed active scan progress to pending without hiding cached rows', async () => {
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached-a'), thread('cached-b')],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: SECOND,
      candidateCount: 2,
      truncated: false,
      mode: 'replace',
    });
    const stored = await db.watchState.get('singleton');
    assert.ok(stored);
    const malformedActiveState = {
      ...stored,
      inbox: {
        ...stored.inbox,
        historyBefore: FIRST,
        historyNextPage: null,
        historyExhausted: false,
        scanId: 'scan-with-missing-cursor',
        scanStatus: 'scanning' as const,
        scanStartedAt: FIRST,
        scanPageCount: 7,
      },
    };
    await db.watchState.put(malformedActiveState);

    const normalized = await queryStoredWatchInbox({
      accountLogin: ACCOUNT,
      unreadOnly: false,
    });
    assert.deepEqual(
      normalized.threads.map((row) => row.id).sort(),
      ['cached-a', 'cached-b'],
    );
    assert.equal(normalized.state?.inbox.scanStatus, 'pending');
    assert.equal(normalized.state?.inbox.scanPageCount, 0);

    await db.watchState.put({
      ...malformedActiveState,
      inbox: {
        ...malformedActiveState.inbox,
        historyNextPage: 2,
      },
    });
    const validActiveState = await getWatchState(ACCOUNT);
    assert.equal(validActiveState?.inbox.scanStatus, 'scanning');
    assert.equal(validActiveState?.inbox.scanPageCount, 7);
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
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    await recordWatchInboxFailure({
      accountLogin: ACCOUNT,
      attemptedAt: SECOND,
      errorCode: 'github_unavailable',
    });

    assert.deepEqual((await queryStoredWatchInbox({ accountLogin: 'octocat' })).threads.map((row) => row.id), ['1']);

    await revalidateWatchInbox({
      accountLogin: ACCOUNT,
      attemptedAt: '2026-08-05T03:00:00.000Z',
      nextAllowedAt: '2026-08-05T03:01:00.000Z',
    });

    const result = await queryStoredWatchInbox({ accountLogin: 'octocat' });
    assert.deepEqual(result.threads.map((row) => row.id), ['1']);
    assert.equal(result.state?.inbox.errorCode, null);
    assert.equal(result.state?.inbox.candidateCount, 1);
    assert.equal(result.state?.inbox.truncated, false);
  });

  it('merges a conditional Inbox delta without deleting remotely absent cached rows', async () => {
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('cached')],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });

    const merged = await mergeWatchInboxDelta({
      accountLogin: ACCOUNT,
      expectedLastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      threads: [thread('changed')],
      attemptedAt: SECOND,
      successfulAt: SECOND,
      lastModified: 'Wed, 05 Aug 2026 02:00:00 GMT',
      nextAllowedAt: '2026-08-05T02:01:00.000Z',
    });
    assert.equal(merged.applied, true);

    const stale = await mergeWatchInboxDelta({
      accountLogin: ACCOUNT,
      expectedLastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      threads: [thread('stale')],
      attemptedAt: '2026-08-05T03:00:00.000Z',
      successfulAt: '2026-08-05T03:00:00.000Z',
      lastModified: 'Wed, 05 Aug 2026 03:00:00 GMT',
      nextAllowedAt: '2026-08-05T03:01:00.000Z',
    });
    assert.equal(stale.applied, false);
    const result = await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false });
    assert.deepEqual(result.threads.map((row) => row.id).sort(), ['cached', 'changed']);
    assert.equal(result.state?.inbox.scanStatus, 'complete');
    assert.equal(result.state?.inbox.candidateCount, 2);
    assert.equal(result.state?.inbox.matchedCount, 2);
    assert.equal(result.state?.inbox.lastConvergedAt, FIRST);
    assert.equal(result.state?.inbox.lastModified, 'Wed, 05 Aug 2026 02:00:00 GMT');
  });

  it('starts a new scan without dropping the last converged Inbox', async () => {
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('older')],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    const state = await startWatchInboxScan({
      accountLogin: ACCOUNT,
      scanId: 'scan-new',
      scanStartedAt: SECOND,
      before: SECOND,
      attemptedAt: SECOND,
      lastModified: null,
    });

    const result = await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false });
    assert.deepEqual(result.threads.map((row) => row.id), ['older']);
    assert.equal(state.inbox.matchedCount, 1);
    assert.equal(state.inbox.candidateCount, 0);
    assert.equal(state.inbox.scanStatus, 'scanning');
    assert.equal(state.inbox.historyNextPage, 1);
  });

  it('persists an exact continuation and marks a failed page partial without sweeping', async () => {
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('old')],
      attemptedAt: FIRST,
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    await startWatchInboxScan({
      accountLogin: ACCOUNT,
      scanId: 'scan-history',
      scanStartedAt: SECOND,
      before: SECOND,
      attemptedAt: SECOND,
      lastModified: null,
    });
    const appended = await commitWatchInboxScanBatch({
      accountLogin: ACCOUNT,
      scanId: 'scan-history',
      before: SECOND,
      expectedPage: 1,
      pageCount: 10,
      threads: [thread('new')],
      nextPage: 11,
      attemptedAt: SECOND,
      successfulAt: SECOND,
    });
    assert.equal(appended.applied, true);
    assert.equal(appended.state?.inbox.historyNextPage, 11);
    assert.equal(appended.state?.inbox.scanStatus, 'scanning');

    await recordWatchHistoryFailure({
      accountLogin: ACCOUNT,
      historyBefore: SECOND,
      historyPage: 11,
      errorCode: 'rate_limited',
    });
    const failed = await getWatchState(ACCOUNT);
    assert.equal(failed?.inbox.errorCode, 'rate_limited');
    assert.equal(failed?.inbox.historyErrorCode, 'rate_limited');
    assert.equal(failed?.inbox.historyNextPage, 11);
    assert.equal(failed?.inbox.scanStatus, 'partial');
    assert.deepEqual(
      (await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false })).threads
        .map((row) => row.id).sort(),
      ['new', 'old'],
    );
  });

  it('rejects malformed history cursors before committing Watch state', async () => {
    const replaceInput = {
      accountLogin: ACCOUNT,
      threads: [thread('1')],
      attemptedAt: FIRST,
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: true,
      historyBefore: FIRST,
      mode: 'replace' as const,
    };
    await assert.rejects(
      replaceWatchInbox({ ...replaceInput, historyNextPage: 1.5 }),
      /positive safe integer/u,
    );
    await replaceWatchInbox({ ...replaceInput, historyNextPage: 11 });

    await assert.rejects(appendWatchInboxHistory({
      accountLogin: ACCOUNT,
      historyBefore: FIRST,
      historyPage: 11,
      threads: [thread('2')],
      candidateCount: 1,
      nextPage: 12.5,
    }), /positive safe integer/u);
    await assert.rejects(appendWatchInboxHistory({
      accountLogin: ACCOUNT,
      historyBefore: FIRST,
      historyPage: 1.5,
      threads: [thread('2')],
      candidateCount: 1,
      nextPage: 13,
    }), /positive safe integer/u);

    assert.equal((await getWatchState(ACCOUNT))?.inbox.historyNextPage, 11);
  });

  it('keeps unstarred Inbox rows and prunes only after a complete remote scan', async () => {
    await db.stars.put(star('owner/keep'));
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('keep', 'owner/keep'), thread('remove', 'owner/remove')],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 2,
      truncated: false,
      mode: 'replace',
    });
    await startWatchInboxScan({
      accountLogin: ACCOUNT,
      scanId: 'scan-1',
      scanStartedAt: SECOND,
      before: SECOND,
      attemptedAt: SECOND,
      lastModified: null,
    });
    const partial = await commitWatchInboxScanBatch({
      accountLogin: ACCOUNT,
      scanId: 'scan-1',
      before: SECOND,
      expectedPage: 1,
      pageCount: 10,
      threads: [thread('keep', 'owner/keep'), thread('outside', 'owner/outside')],
      nextPage: 11,
      attemptedAt: SECOND,
      successfulAt: SECOND,
    });

    assert.equal(partial.applied, true);
    assert.deepEqual(
      (await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false })).threads
        .map((row) => row.id).sort(),
      ['keep', 'outside', 'remove'],
    );
    const complete = await commitWatchInboxScanBatch({
      accountLogin: ACCOUNT,
      scanId: 'scan-1',
      before: SECOND,
      expectedPage: 11,
      pageCount: 1,
      threads: [],
      nextPage: null,
      attemptedAt: SECOND,
      successfulAt: SECOND,
    });

    assert.equal(complete.applied, true);
    assert.deepEqual(
      (await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false })).threads
        .map((row) => row.id).sort(),
      ['keep', 'outside'],
    );
    assert.equal(complete.state?.inbox.candidateCount, 2);
    assert.equal(complete.state?.inbox.matchedCount, 2);
    assert.equal(complete.state?.inbox.scanStatus, 'complete');
  });

  it('rolls back converging scan upserts and unseen-row deletion when the state commit fails', async () => {
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('kept', 'owner/keep'), thread('unseen', 'owner/unseen')],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: null,
      candidateCount: 2,
      truncated: false,
      mode: 'replace',
    });
    await startWatchInboxScan({
      accountLogin: ACCOUNT,
      scanId: 'scan-rollback',
      scanStartedAt: SECOND,
      before: SECOND,
      attemptedAt: SECOND,
      lastModified: null,
    });
    const before = {
      threads: await db.watchNotificationThreads.orderBy('id').toArray(),
      state: await db.watchState.get('singleton'),
    };
    const stateWrite = vi.spyOn(db.watchState, 'put')
      .mockRejectedValueOnce(new Error('converging state commit failed'));

    try {
      await assert.rejects(
        () => commitWatchInboxScanBatch({
          accountLogin: ACCOUNT,
          scanId: 'scan-rollback',
          before: SECOND,
          expectedPage: 1,
          pageCount: 1,
          threads: [
            { ...thread('kept', 'owner/keep'), subjectTitle: 'Updated kept thread' },
            thread('inserted', 'owner/inserted'),
          ],
          nextPage: null,
          attemptedAt: SECOND,
          successfulAt: SECOND,
        }),
        /converging state commit failed/u,
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

  it('commits read and done notification mutations only for the bound account', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('1'), thread('2')],
      attemptedAt: FIRST,
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 2,
      truncated: false,
      mode: 'replace',
    });

    assert.equal(await applyWatchThreadMutation({
      accountLogin: ACCOUNT,
      threadIds: ['1'],
      action: 'read',
    }), 1);
    let stored = await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false });
    assert.deepEqual(stored.threads.map((row) => [row.id, row.unread]), [
      ['1', false],
      ['2', true],
    ]);
    assert.equal(stored.state?.inbox.matchedCount, 2);

    assert.equal(await applyWatchThreadMutation({
      accountLogin: 'another-user',
      threadIds: ['1'],
      action: 'done',
    }), 0);
    stored = await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false });
    assert.deepEqual(stored.threads.map((row) => [row.id, row.unread]), [
      ['1', false],
      ['2', true],
    ]);
    assert.equal(stored.state?.inbox.matchedCount, 2);

    assert.equal(await applyWatchThreadMutation({
      accountLogin: ACCOUNT,
      threadIds: ['1', '2'],
      action: 'done',
    }), 2);
    stored = await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false });
    assert.equal(stored.totalCount, 0);
    assert.equal(stored.state?.inbox.matchedCount, 0);

  });

  it('counts every unread Inbox row for the bound account', async () => {
    await db.stars.put(star('Owner/Repo'));
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [
        thread('1'),
        { ...thread('2'), unread: false },
        thread('3', 'outside/not-starred'),
      ],
      attemptedAt: FIRST,
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 3,
      truncated: false,
      mode: 'replace',
    });

    assert.equal(await countUnreadWatchThreads('octocat'), 2);
    assert.equal(await countUnreadWatchThreads('another-user'), 0);

    await applyWatchThreadMutation({
      accountLogin: ACCOUNT,
      threadIds: ['1'],
      action: 'read',
    });
    assert.equal(await countUnreadWatchThreads(ACCOUNT), 1);
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
      mode: 'replace',
    });

    await disconnectWatchInbox('OCTOCAT');
    assert.deepEqual(await getWatchRepositories('octocat'), [{ full_name: 'owner/repo' }]);
    assert.equal((await queryStoredWatchInbox({ accountLogin: 'octocat' })).threads.length, 0);

    await replaceWatchScope({
      accountLogin: 'another-user',
      repositories: [{ full_name: 'other/repo' }],
      attemptedAt: SECOND,
    });
    assert.equal(await getWatchState('octocat'), null);
    assert.deepEqual(await getWatchRepositories('another-user'), [{ full_name: 'other/repo' }]);
  });

  it('fences a partial scan across account cutover and removes the prior account data', async () => {
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'old-account/private' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [thread('old-saved', 'old-account/private')],
      attemptedAt: FIRST,
      lastModified: null,
      nextAllowedAt: null,
      candidateCount: 1,
      truncated: false,
      mode: 'replace',
    });
    await startWatchInboxScan({
      accountLogin: ACCOUNT,
      scanId: 'scan-old-account',
      scanStartedAt: SECOND,
      before: SECOND,
      attemptedAt: SECOND,
      lastModified: null,
    });
    await commitWatchInboxScanBatch({
      accountLogin: ACCOUNT,
      scanId: 'scan-old-account',
      before: SECOND,
      expectedPage: 1,
      pageCount: 10,
      threads: [thread('old-partial', 'old-account/other')],
      nextPage: 11,
      attemptedAt: SECOND,
      successfulAt: SECOND,
    });
    await recordWatchHistoryFailure({
      accountLogin: ACCOUNT,
      historyBefore: SECOND,
      historyPage: 11,
      errorCode: 'network_error',
    });
    assert.equal((await getWatchState(ACCOUNT))?.inbox.scanStatus, 'partial');

    const newBoundary = '2026-08-05T03:00:00.000Z';
    await startWatchInboxScan({
      accountLogin: 'SecondUser',
      scanId: 'scan-new-account',
      scanStartedAt: newBoundary,
      before: newBoundary,
      attemptedAt: newBoundary,
      lastModified: null,
    });
    const afterCutover = {
      repositories: await db.watchRepositories.toArray(),
      threads: await db.watchNotificationThreads.toArray(),
      state: await db.watchState.get('singleton'),
    };
    assert.deepEqual(afterCutover.repositories, []);
    assert.deepEqual(afterCutover.threads, []);
    assert.equal(afterCutover.state?.accountLogin, 'seconduser');
    assert.equal(afterCutover.state?.inbox.scanId, 'scan-new-account');

    const staleAccountCommit = await commitWatchInboxScanBatch({
      accountLogin: ACCOUNT,
      scanId: 'scan-old-account',
      before: SECOND,
      expectedPage: 11,
      pageCount: 1,
      threads: [thread('stale-old-account', 'old-account/private')],
      nextPage: null,
      attemptedAt: newBoundary,
      successfulAt: newBoundary,
    });
    const reboundCommit = await commitWatchInboxScanBatch({
      accountLogin: 'SecondUser',
      scanId: 'scan-old-account',
      before: SECOND,
      expectedPage: 11,
      pageCount: 1,
      threads: [thread('rebound-old-account', 'old-account/private')],
      nextPage: null,
      attemptedAt: newBoundary,
      successfulAt: newBoundary,
    });

    assert.equal(staleAccountCommit.applied, false);
    assert.equal(reboundCommit.applied, false);
    assert.deepEqual(
      {
        repositories: await db.watchRepositories.toArray(),
        threads: await db.watchNotificationThreads.toArray(),
        state: await db.watchState.get('singleton'),
      },
      afterCutover,
    );

    const currentAccountCommit = await commitWatchInboxScanBatch({
      accountLogin: 'SecondUser',
      scanId: 'scan-new-account',
      before: newBoundary,
      expectedPage: 1,
      pageCount: 1,
      threads: [thread('new-account', 'new-account/public')],
      nextPage: null,
      attemptedAt: newBoundary,
      successfulAt: newBoundary,
    });
    assert.equal(currentAccountCommit.applied, true);
    assert.deepEqual(
      (await db.watchNotificationThreads.toArray()).map((row) => row.id),
      ['new-account'],
    );
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
      mode: 'replace',
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
        originAgentSessionId: 'session:preserved',
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
      mode: 'replace',
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

  it('prunes native scope but preserves Inbox rows when a star becomes a tombstone', async () => {
    await db.stars.bulkPut([
      star('owner/repo'),
      star('owner/other'),
      star('custom/repo'),
    ]);
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/repo' }, { full_name: 'owner/other' }],
      attemptedAt: FIRST,
    });
    await replaceWatchInbox({
      accountLogin: ACCOUNT,
      threads: [
        thread('keep', 'owner/repo'),
        thread('remove', 'owner/other'),
        thread('custom', 'custom/repo'),
      ],
      attemptedAt: FIRST,
      lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
      nextAllowedAt: null,

      candidateCount: 3,
      truncated: false,
      mode: 'replace',
    });
    await db.stars.put(star('owner/other', true));

    assert.equal(await reconcileWatchLiveStars(ACCOUNT), true);
    assert.deepEqual(await getWatchRepositories(ACCOUNT), [{ full_name: 'owner/repo' }]);
    assert.deepEqual(
      (await queryStoredWatchInbox({ accountLogin: ACCOUNT, unreadOnly: false })).threads
        .map((item) => item.id).sort(),
      ['custom', 'keep', 'remove'],
    );
    const state = await getWatchState(ACCOUNT);
    assert.equal(state?.scope.repositoryCount, 1);
    assert.equal(state?.inbox.matchedCount, 3);
    assert.equal(await reconcileWatchLiveStars(ACCOUNT), false);
  });

  it('upgrades a v5 Watch snapshot to pending without losing account rows or visit watermark', async () => {
    const visitWatermark = '2026-08-04T23:30:00.000Z';
    const legacyThreads = [
      thread('legacy-a', 'legacy/private'),
      {
        ...thread('legacy-b', 'legacy/public'),
        updatedAt: SECOND,
        fetchedAt: SECOND,
      },
    ];

    await db.close();
    await Dexie.delete(DB_NAME);
    const legacy = new Dexie(DB_NAME);
    defineLegacyWatchSchema(legacy);
    try {
      await legacy.open();
      await legacy.table('watchRepositories').put({ full_name: 'legacy/private' });
      await legacy.table('watchNotificationThreads').bulkPut(legacyThreads);
      await legacy.table('watchState').put({
        id: 'singleton',
        accountLogin: ACCOUNT.toLowerCase(),
        scope: {
          lastAttemptAt: FIRST,
          lastSuccessfulAt: FIRST,
          errorCode: null,
          repositoryCount: 1,
        },
        inbox: {
          lastAttemptAt: FIRST,
          lastSuccessfulAt: FIRST,
          errorCode: 'invalid_pagination',
          lastModified: 'Wed, 05 Aug 2026 01:00:00 GMT',
          nextAllowedAt: SECOND,
          candidateCount: 99,
          matchedCount: 99,
          truncated: true,
          newerThan: visitWatermark,
          historyBefore: FIRST,
          historyNextPage: 11,
          historyExhausted: false,
          historyErrorCode: 'invalid_pagination',
        },
      });
    } finally {
      legacy.close();
    }

    const upgraded = new StarsDB();
    try {
      await upgraded.open();
      assert.equal(upgraded.verno, 7);
      assert.deepEqual(
        await upgraded.watchRepositories.toArray(),
        [{ full_name: 'legacy/private' }],
      );
      assert.deepEqual(
        await upgraded.watchNotificationThreads.orderBy('id').toArray(),
        legacyThreads,
      );

      const state = await upgraded.watchState.get('singleton');
      assert.equal(state?.accountLogin, ACCOUNT.toLowerCase());
      assert.deepEqual(state?.scope, {
        lastAttemptAt: FIRST,
        lastSuccessfulAt: FIRST,
        errorCode: null,
        repositoryCount: 1,
      });
      assert.equal(state?.inbox.newerThan, visitWatermark);
      assert.equal(state?.inbox.errorCode, null);
      assert.equal(state?.inbox.lastModified, null);
      assert.equal(state?.inbox.nextAllowedAt, null);
      assert.equal(state?.inbox.historyBefore, null);
      assert.equal(state?.inbox.historyNextPage, null);
      assert.equal(state?.inbox.historyExhausted, true);
      assert.equal(state?.inbox.historyErrorCode, null);
      assert.equal(state?.inbox.scanId, null);
      assert.equal(state?.inbox.scanStatus, 'pending');
      assert.equal(state?.inbox.scanStartedAt, null);
      assert.equal(state?.inbox.scanPageCount, 0);
      assert.equal(state?.inbox.lastConvergedAt, null);
      assert.equal(state?.inbox.candidateCount, legacyThreads.length);
      assert.equal(state?.inbox.matchedCount, legacyThreads.length);
      assert.equal(state?.inbox.truncated, false);
    } finally {
      upgraded.close();
    }
  });

  it('prunes owned public repositories that are not starred from Watch scope', async () => {
    await db.stars.bulkPut([
      star('owner/starred'),
      { ...star('owner/not-starred'), viewer_has_starred: false },
    ]);
    await replaceWatchScope({
      accountLogin: ACCOUNT,
      repositories: [{ full_name: 'owner/starred' }, { full_name: 'owner/not-starred' }],
      attemptedAt: FIRST,
    });

    assert.equal(await reconcileWatchLiveStars(ACCOUNT), true);
    assert.deepEqual(await getWatchRepositories(ACCOUNT), [{ full_name: 'owner/starred' }]);
  });
});
