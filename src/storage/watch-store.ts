import { db } from '@/storage/db';
import {
  canonicalRepositoryFullName,
  isValidWatchHistoryPage,
  projectWatchInbox,
  type GitHubNotificationThread,
  type GitHubWatchRepository,
  type GitHubWatchStateRecord,
  type WatchInboxProjection,
  type WatchInboxRefreshSnapshot,
  type WatchScopeRefreshSnapshot,
} from '@/watch/watch-model';

const WATCH_STATE_ID = 'singleton' as const;

export interface WatchInboxQueryResult extends WatchInboxProjection {
  state: GitHubWatchStateRecord | null;
}

/**
 * Remove rows that are no longer attributable to the configured GitHub
 * account. This is intentionally idempotent so a later service-worker wake
 * can finish cleanup after a storage listener was interrupted.
 */
export async function reconcileWatchAccount(
  accountLogin: string | null | undefined,
): Promise<boolean> {
  const normalizedLogin = accountLogin?.trim()
    ? normalizeAccountLogin(accountLogin)
    : null;
  return db.transaction(
    'rw',
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const state = await db.watchState.get(WATCH_STATE_ID);
      const rowsPresent = state !== undefined ||
        await db.watchRepositories.count() > 0 ||
        await db.watchNotificationThreads.count() > 0;
      if (normalizedLogin && state?.accountLogin === normalizedLogin) return false;
      if (!rowsPresent) return false;
      await Promise.all([
        db.watchRepositories.clear(),
        db.watchNotificationThreads.clear(),
        db.watchState.clear(),
      ]);
      return true;
    },
  );
}

/**
 * Keep the informational native-Watch snapshot scoped to current live Stars.
 * Notification threads are an independent account-wide Inbox cache and are
 * removed only by a complete remote Notifications traversal.
 */
export async function reconcileWatchLiveStars(
  accountLogin: string | null | undefined,
): Promise<boolean> {
  if (!accountLogin?.trim()) return false;
  const normalizedLogin = normalizeAccountLogin(accountLogin);
  return db.transaction(
    'rw',
    db.stars,
    db.watchRepositories,
    db.watchState,
    async () => {
      const state = await db.watchState.get(WATCH_STATE_ID);
      if (state?.accountLogin !== normalizedLogin) return false;

      const [stars, repositories] = await Promise.all([
        db.stars.toArray(),
        db.watchRepositories.toArray(),
      ]);
      const liveNames = liveRepositoryNames(stars);
      const removedRepositoryNames = repositories
        .filter((repository) => !liveNames.has(repository.full_name))
        .map((repository) => repository.full_name);
      const repositoryCount = repositories.length - removedRepositoryNames.length;
      const stateChanged = state.scope.repositoryCount !== repositoryCount;
      if (!removedRepositoryNames.length && !stateChanged) return false;

      if (removedRepositoryNames.length) {
        await db.watchRepositories.bulkDelete(removedRepositoryNames);
      }
      await db.watchState.put({
        ...state,
        scope: { ...state.scope, repositoryCount },
      });
      return true;
    },
  );
}

function normalizeAccountLogin(login: string): string {
  const normalized = login.trim().toLowerCase();
  if (!normalized) throw new TypeError('Watch account login is required.');
  return normalized;
}

function emptyScope(): WatchScopeRefreshSnapshot {
  return {
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    errorCode: null,
    repositoryCount: 0,
  };
}

function emptyInbox(): WatchInboxRefreshSnapshot {
  return {
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    errorCode: null,
    lastModified: null,
    nextAllowedAt: null,
    candidateCount: 0,
    matchedCount: 0,
    truncated: false,
    newerThan: null,
    historyBefore: null,
    historyNextPage: null,
    historyExhausted: true,
    historyErrorCode: null,
    scanId: null,
    scanStatus: 'pending',
    scanStartedAt: null,
    scanPageCount: 0,
    lastConvergedAt: null,
  };
}

function emptyState(accountLogin: string): GitHubWatchStateRecord {
  return {
    id: WATCH_STATE_ID,
    accountLogin,
    scope: emptyScope(),
    inbox: emptyInbox(),
  };
}

function normalizeWatchState(state: GitHubWatchStateRecord): GitHubWatchStateRecord {
  const inbox = state.inbox as Partial<WatchInboxRefreshSnapshot>;
  const historyBefore = inbox.historyBefore ?? null;
  const historyNextPage = inbox.historyNextPage ?? null;
  const storedStatus = inbox.scanStatus;
  const hasCurrentScanShape = (
    (storedStatus === 'scanning' || storedStatus === 'partial')
    && typeof inbox.scanId === 'string'
    && inbox.scanId.length > 0
    && typeof inbox.scanStartedAt === 'string'
    && historyBefore !== null
    && historyNextPage !== null
    && isValidWatchHistoryPage(historyNextPage)
  );
  const scanStatus: WatchInboxRefreshSnapshot['scanStatus'] = storedStatus === 'complete'
    ? 'complete'
    : hasCurrentScanShape ? storedStatus : 'pending';
  return {
    ...state,
    inbox: {
      ...emptyInbox(),
      ...inbox,
      newerThan: inbox.newerThan ?? null,
      lastModified: scanStatus === 'pending' ? null : inbox.lastModified ?? null,
      nextAllowedAt: scanStatus === 'pending' ? null : inbox.nextAllowedAt ?? null,
      truncated: scanStatus === 'scanning' || scanStatus === 'partial',
      historyBefore: scanStatus === 'pending' ? null : historyBefore,
      historyNextPage: scanStatus === 'pending' ? null : historyNextPage,
      historyExhausted: scanStatus === 'complete' || scanStatus === 'pending',
      historyErrorCode: scanStatus === 'pending' ? null : inbox.historyErrorCode ?? null,
      scanId: hasCurrentScanShape ? inbox.scanId! : null,
      scanStatus,
      scanStartedAt: hasCurrentScanShape ? inbox.scanStartedAt! : null,
      scanPageCount: scanStatus !== 'pending'
        && Number.isSafeInteger(inbox.scanPageCount) && inbox.scanPageCount! >= 0
        ? inbox.scanPageCount!
        : 0,
      lastConvergedAt: inbox.lastConvergedAt ?? null,
    },
  };
}

async function replaceAccountIfNeeded(accountLogin: string): Promise<GitHubWatchStateRecord> {
  const normalizedLogin = normalizeAccountLogin(accountLogin);
  const current = await db.watchState.get(WATCH_STATE_ID);
  if (current?.accountLogin === normalizedLogin) return normalizeWatchState(current);

  // Tables without their account-bound state are orphaned and must never be
  // adopted by the next account that writes a refresh result.
  await Promise.all([
    db.watchRepositories.clear(),
    db.watchNotificationThreads.clear(),
  ]);
  return emptyState(normalizedLogin);
}

function normalizeRepositories(
  repositories: readonly GitHubWatchRepository[],
): GitHubWatchRepository[] {
  const names = new Set<string>();
  for (const repository of repositories) {
    const fullName = canonicalRepositoryFullName(repository.full_name);
    if (!fullName) throw new TypeError('Watch snapshot contains an invalid repository.');
    names.add(fullName);
  }
  return [...names].sort().map((full_name) => ({ full_name }));
}

function normalizeThreads(
  threads: readonly GitHubNotificationThread[],
): GitHubNotificationThread[] {
  const byId = new Map<string, GitHubNotificationThread>();
  for (const thread of threads) {
    if (!thread.id.trim()) throw new TypeError('Watch snapshot contains an invalid thread id.');
    const repositoryFullName = canonicalRepositoryFullName(thread.repositoryFullName);
    if (!repositoryFullName) throw new TypeError('Watch snapshot contains an invalid thread repository.');
    byId.set(thread.id, { ...thread, repositoryFullName });
  }
  return [...byId.values()];
}

function publicThread(thread: GitHubNotificationThread): GitHubNotificationThread {
  const visible = { ...thread };
  delete visible.scanId;
  return visible;
}

function liveRepositoryNames(stars: readonly { full_name: string; tombstone: boolean; viewer_has_starred?: boolean }[]): Set<string> {
  return new Set(stars.flatMap((star) => {
    if (star.tombstone || star.viewer_has_starred === false) return [];
    const fullName = canonicalRepositoryFullName(star.full_name);
    return fullName ? [fullName] : [];
  }));
}

export async function getWatchState(
  accountLogin: string | null | undefined,
): Promise<GitHubWatchStateRecord | null> {
  if (!accountLogin?.trim()) return null;
  const normalizedLogin = normalizeAccountLogin(accountLogin);
  const state = await db.watchState.get(WATCH_STATE_ID);
  return state?.accountLogin === normalizedLogin ? normalizeWatchState(state) : null;
}

export async function countUnreadWatchThreads(
  accountLogin: string | null | undefined,
): Promise<number> {
  if (!accountLogin?.trim()) return 0;
  const normalizedLogin = normalizeAccountLogin(accountLogin);
  return db.transaction('r', db.watchNotificationThreads, db.watchState, async () => {
    const state = await db.watchState.get(WATCH_STATE_ID);
    if (state?.accountLogin !== normalizedLogin) return 0;
    return db.watchNotificationThreads.filter((thread) => thread.unread).count();
  });
}

export async function getWatchRepositories(
  accountLogin: string | null | undefined,
): Promise<GitHubWatchRepository[]> {
  if (!accountLogin?.trim()) return [];
  const normalizedLogin = normalizeAccountLogin(accountLogin);
  return db.transaction('r', db.watchRepositories, db.watchState, async () => {
    const state = await db.watchState.get(WATCH_STATE_ID);
    if (state?.accountLogin !== normalizedLogin) return [];
    return db.watchRepositories.orderBy('full_name').toArray();
  });
}

/** Read one cached thread only when it belongs to the current Watch account. */
export async function getWatchNotificationThread(input: {
  accountLogin: string | null | undefined;
  threadId: string;
}): Promise<GitHubNotificationThread | null> {
  if (!input.accountLogin?.trim() || !/^\d{1,32}$/u.test(input.threadId.trim())) return null;
  const normalizedLogin = normalizeAccountLogin(input.accountLogin);
  return db.transaction('r', db.watchNotificationThreads, db.watchState, async () => {
    const state = await db.watchState.get(WATCH_STATE_ID);
    if (state?.accountLogin !== normalizedLogin) return null;
    const thread = await db.watchNotificationThreads.get(input.threadId.trim());
    return thread ? publicThread(thread) : null;
  });
}

export async function queryStoredWatchInbox(input: {
  accountLogin: string | null | undefined;
  unreadOnly?: boolean;
}): Promise<WatchInboxQueryResult> {
  if (!input.accountLogin?.trim()) {
    return { ...projectWatchInbox([], { unreadOnly: input.unreadOnly }), state: null };
  }
  const normalizedLogin = normalizeAccountLogin(input.accountLogin);
  return db.transaction(
    'r',
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const state = await db.watchState.get(WATCH_STATE_ID);
      if (state?.accountLogin !== normalizedLogin) {
        return { ...projectWatchInbox([], { unreadOnly: input.unreadOnly }), state: null };
      }
      const storedThreads = await db.watchNotificationThreads.toArray();
      return {
        ...projectWatchInbox(storedThreads.map(publicThread), { unreadOnly: input.unreadOnly }),
        state: normalizeWatchState(state),
      };
    },
  );
}

export async function applyWatchThreadMutation(input: {
  accountLogin: string;
  threadIds: readonly string[];
  action: 'read' | 'done';
}): Promise<number> {
  const accountLogin = normalizeAccountLogin(input.accountLogin);
  const threadIds = [...new Set(input.threadIds.map((id) => id.trim()))];
  if (threadIds.length === 0 || threadIds.some((id) => !/^\d{1,32}$/u.test(id))) {
    throw new TypeError('Watch thread mutation contains an invalid thread id.');
  }
  return db.transaction('rw', db.watchNotificationThreads, db.watchState, async () => {
    const storedState = await db.watchState.get(WATCH_STATE_ID);
    if (storedState?.accountLogin !== accountLogin) return 0;
    const state = normalizeWatchState(storedState);
    const rows = (await db.watchNotificationThreads.bulkGet(threadIds))
      .filter((row): row is GitHubNotificationThread => row !== undefined);
    if (input.action === 'done') {
      if (rows.length) await db.watchNotificationThreads.bulkDelete(rows.map((row) => row.id));
    } else {
      const unreadRows = rows.filter((row) => row.unread);
      if (unreadRows.length) {
        await db.watchNotificationThreads.bulkPut(unreadRows.map((row) => ({
          ...row,
          unread: false,
        })));
      }
      if (unreadRows.length === 0) return 0;
      return unreadRows.length;
    }
    if (rows.length) {
      const scanWasActive = state.inbox.scanStatus === 'scanning'
        || state.inbox.scanStatus === 'partial';
      await db.watchState.put({
        ...state,
        inbox: {
          ...state.inbox,
          matchedCount: await db.watchNotificationThreads.count(),
          ...(scanWasActive ? {
            errorCode: null,
            lastModified: null,
            nextAllowedAt: null,
            candidateCount: 0,
            truncated: false,
            historyBefore: null,
            historyNextPage: null,
            historyExhausted: true,
            historyErrorCode: null,
            scanId: null,
            scanStatus: 'pending' as const,
            scanStartedAt: null,
            scanPageCount: 0,
          } : {}),
        },
      });
    }
    return rows.length;
  });
}

export async function replaceWatchScope(input: {
  accountLogin: string;
  repositories: readonly GitHubWatchRepository[];
  attemptedAt: string;
  successfulAt?: string;
}): Promise<GitHubWatchStateRecord> {
  const repositories = normalizeRepositories(input.repositories);
  return db.transaction(
    'rw',
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const current = await replaceAccountIfNeeded(input.accountLogin);
      await db.watchRepositories.clear();
      if (repositories.length) await db.watchRepositories.bulkPut(repositories);
      const next: GitHubWatchStateRecord = {
        ...current,
        scope: {
          lastAttemptAt: input.attemptedAt,
          lastSuccessfulAt: input.successfulAt ?? input.attemptedAt,
          errorCode: null,
          repositoryCount: repositories.length,
        },
      };
      await db.watchState.put(next);
      return next;
    },
  );
}

export async function recordWatchScopeFailure(input: {
  accountLogin: string;
  attemptedAt: string;
  errorCode: string;
}): Promise<GitHubWatchStateRecord> {
  return db.transaction(
    'rw',
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const current = await replaceAccountIfNeeded(input.accountLogin);
      const next: GitHubWatchStateRecord = {
        ...current,
        scope: {
          ...current.scope,
          lastAttemptAt: input.attemptedAt,
          errorCode: input.errorCode,
        },
      };
      await db.watchState.put(next);
      return next;
    },
  );
}

export async function startWatchInboxScan(input: {
  accountLogin: string;
  scanId: string;
  scanStartedAt: string;
  before: string;
  attemptedAt: string;
  lastModified: string | null;
}): Promise<GitHubWatchStateRecord> {
  const scanId = input.scanId.trim();
  if (!scanId) throw new TypeError('Watch scan id is required.');
  if (!Number.isFinite(Date.parse(input.scanStartedAt)) || !Number.isFinite(Date.parse(input.before))) {
    throw new TypeError('Watch scan boundary is invalid.');
  }
  return db.transaction(
    'rw',
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const current = await replaceAccountIfNeeded(input.accountLogin);
      const next: GitHubWatchStateRecord = {
        ...current,
        inbox: {
          ...current.inbox,
          lastAttemptAt: input.attemptedAt,
          errorCode: null,
          lastModified: input.lastModified,
          nextAllowedAt: null,
          candidateCount: 0,
          matchedCount: await db.watchNotificationThreads.count(),
          truncated: true,
          historyBefore: input.before,
          historyNextPage: 1,
          historyExhausted: false,
          historyErrorCode: null,
          scanId,
          scanStatus: 'scanning',
          scanStartedAt: input.scanStartedAt,
          scanPageCount: 0,
        },
      };
      await db.watchState.put(next);
      return next;
    },
  );
}

export async function commitWatchInboxScanBatch(input: {
  accountLogin: string;
  scanId: string;
  before: string;
  expectedPage: number;
  pageCount: number;
  threads: readonly GitHubNotificationThread[];
  nextPage: number | null;
  attemptedAt: string;
  successfulAt: string;
  lastModified?: string | null;
  nextAllowedAt?: string | null;
}): Promise<{ state: GitHubWatchStateRecord | null; applied: boolean }> {
  if (!isValidWatchHistoryPage(input.expectedPage)) {
    throw new TypeError('Watch scan page must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 1) {
    throw new TypeError('Watch scan page count must be a positive safe integer.');
  }
  if (input.nextPage !== null && !isValidWatchHistoryPage(input.nextPage)) {
    throw new TypeError('Watch next scan page must be a positive safe integer.');
  }
  const accountLogin = normalizeAccountLogin(input.accountLogin);
  const scanId = input.scanId.trim();
  if (!scanId) throw new TypeError('Watch scan id is required.');
  const normalizedThreads = normalizeThreads(input.threads).map((thread) => ({
    ...thread,
    scanId,
  }));
  return db.transaction('rw', db.watchNotificationThreads, db.watchState, async () => {
    const storedState = await db.watchState.get(WATCH_STATE_ID);
    if (storedState?.accountLogin !== accountLogin) return { state: null, applied: false };
    const current = normalizeWatchState(storedState);
    if (
      current.inbox.scanId !== scanId
      || (current.inbox.scanStatus !== 'scanning' && current.inbox.scanStatus !== 'partial')
      || current.inbox.historyBefore !== input.before
      || current.inbox.historyNextPage !== input.expectedPage
    ) return { state: current, applied: false };

    if (normalizedThreads.length) await db.watchNotificationThreads.bulkPut(normalizedThreads);
    const candidateCount = await db.watchNotificationThreads
      .filter((thread) => thread.scanId === scanId)
      .count();
    const converged = input.nextPage === null;
    if (converged) {
      const unseenIds = await db.watchNotificationThreads
        .filter((thread) => thread.scanId !== scanId)
        .primaryKeys();
      if (unseenIds.length) await db.watchNotificationThreads.bulkDelete(unseenIds);
    }
    const matchedCount = await db.watchNotificationThreads.count();
    const next: GitHubWatchStateRecord = {
      ...current,
      inbox: {
        ...current.inbox,
        lastAttemptAt: input.attemptedAt,
        lastSuccessfulAt: input.successfulAt,
        errorCode: null,
        lastModified: input.lastModified === undefined
          ? current.inbox.lastModified
          : input.lastModified,
        nextAllowedAt: input.nextAllowedAt === undefined
          ? current.inbox.nextAllowedAt
          : input.nextAllowedAt,
        candidateCount,
        matchedCount,
        truncated: !converged,
        historyBefore: input.before,
        historyNextPage: input.nextPage,
        historyExhausted: converged,
        historyErrorCode: null,
        scanId: converged ? null : scanId,
        scanStatus: converged ? 'complete' : 'scanning',
        scanStartedAt: converged ? null : current.inbox.scanStartedAt,
        scanPageCount: current.inbox.scanPageCount + input.pageCount,
        lastConvergedAt: converged ? input.successfulAt : current.inbox.lastConvergedAt,
      },
    };
    await db.watchState.put(next);
    return { state: next, applied: true };
  });
}

/** Merge a conditional 200 response without treating its delta as a full snapshot. */
export async function mergeWatchInboxDelta(input: {
  accountLogin: string;
  expectedLastModified: string;
  threads: readonly GitHubNotificationThread[];
  attemptedAt: string;
  successfulAt: string;
  lastModified: string;
  nextAllowedAt: string;
}): Promise<{ state: GitHubWatchStateRecord | null; applied: boolean }> {
  const accountLogin = normalizeAccountLogin(input.accountLogin);
  const expectedLastModified = input.expectedLastModified.trim();
  const lastModified = input.lastModified.trim();
  if (!expectedLastModified || !lastModified) {
    throw new TypeError('Watch delta validators are required.');
  }
  const normalizedThreads = normalizeThreads(input.threads).map(publicThread);
  return db.transaction('rw', db.watchNotificationThreads, db.watchState, async () => {
    const storedState = await db.watchState.get(WATCH_STATE_ID);
    if (storedState?.accountLogin !== accountLogin) return { state: null, applied: false };
    const current = normalizeWatchState(storedState);
    if (
      current.inbox.scanStatus !== 'complete'
      || current.inbox.lastModified?.trim() !== expectedLastModified
    ) return { state: current, applied: false };

    if (normalizedThreads.length) await db.watchNotificationThreads.bulkPut(normalizedThreads);
    const matchedCount = await db.watchNotificationThreads.count();
    const next: GitHubWatchStateRecord = {
      ...current,
      inbox: {
        ...current.inbox,
        lastAttemptAt: input.attemptedAt,
        lastSuccessfulAt: input.successfulAt,
        errorCode: null,
        lastModified,
        nextAllowedAt: input.nextAllowedAt,
        candidateCount: matchedCount,
        matchedCount,
        truncated: false,
        historyErrorCode: null,
      },
    };
    await db.watchState.put(next);
    return { state: next, applied: true };
  });
}

export async function replaceWatchInbox(input: {
  accountLogin: string;
  threads: readonly GitHubNotificationThread[];
  attemptedAt: string;
  successfulAt?: string;
  lastModified: string | null;
  nextAllowedAt: string | null;
  candidateCount: number;
  truncated: boolean;
  historyBefore?: string;
  historyNextPage?: number | null;
  resetHistory?: boolean;
  mode: 'replace' | 'merge';
  requireLiveStars?: boolean;
}): Promise<GitHubWatchStateRecord> {
  if (
    input.historyNextPage !== undefined
    && input.historyNextPage !== null
    && !isValidWatchHistoryPage(input.historyNextPage)
  ) {
    throw new TypeError('Watch next history page must be a positive safe integer.');
  }
  const normalizedThreads = normalizeThreads(input.threads);
  return db.transaction(
    'rw',
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const current = await replaceAccountIfNeeded(input.accountLogin);
      if (input.mode === 'replace') await db.watchNotificationThreads.clear();
      const successfulAt = input.successfulAt ?? input.attemptedAt;
      const historyBefore = input.historyBefore ?? successfulAt;
      const historyNextPage = input.historyNextPage ?? null;
      const scanId = historyNextPage === null ? null : `legacy:${historyBefore}`;
      const rows = scanId
        ? normalizedThreads.map((thread) => ({ ...thread, scanId }))
        : normalizedThreads;
      if (rows.length) await db.watchNotificationThreads.bulkPut(rows);
      const matchedCount = await db.watchNotificationThreads.count();
      const complete = historyNextPage === null;
      const next: GitHubWatchStateRecord = {
        ...current,
        inbox: {
          lastAttemptAt: input.attemptedAt,
          lastSuccessfulAt: successfulAt,
          errorCode: null,
          lastModified: input.lastModified,
          nextAllowedAt: input.nextAllowedAt,
          candidateCount: matchedCount,
          matchedCount,
          truncated: !complete,
          newerThan: current.inbox.newerThan,
          historyBefore,
          historyNextPage,
          historyExhausted: complete,
          historyErrorCode: null,
          scanId,
          scanStatus: complete ? 'complete' : 'scanning',
          scanStartedAt: complete ? null : historyBefore,
          scanPageCount: rows.length > 0 ? 1 : 0,
          lastConvergedAt: complete ? successfulAt : current.inbox.lastConvergedAt,
        },
      };
      await db.watchState.put(next);
      return next;
    },
  );
}

export async function markWatchInboxLoaded(input: {
  accountLogin: string;
  loadedAt: string;
}): Promise<GitHubWatchStateRecord | null> {
  const accountLogin = normalizeAccountLogin(input.accountLogin);
  const loadedAtMs = Date.parse(input.loadedAt);
  if (!Number.isFinite(loadedAtMs)) throw new TypeError('Watch load time is invalid.');
  return db.transaction('rw', db.watchState, async () => {
    const storedState = await db.watchState.get(WATCH_STATE_ID);
    if (storedState?.accountLogin !== accountLogin) return null;
    const current = normalizeWatchState(storedState);
    const currentMs = Date.parse(current.inbox.newerThan ?? '');
    const newerThan = Number.isFinite(currentMs) && currentMs > loadedAtMs
      ? current.inbox.newerThan
      : new Date(loadedAtMs).toISOString();
    if (current.inbox.newerThan === newerThan) return current;
    const next: GitHubWatchStateRecord = {
      ...current,
      inbox: { ...current.inbox, newerThan },
    };
    await db.watchState.put(next);
    return next;
  });
}

export async function appendWatchInboxHistory(input: {
  accountLogin: string;
  historyBefore: string;
  historyPage: number;
  threads: readonly GitHubNotificationThread[];
  candidateCount: number;
  nextPage: number | null;
  requireLiveStars?: boolean;
}): Promise<{
  state: GitHubWatchStateRecord | null;
  addedCount: number;
  applied: boolean;
}> {
  if (!isValidWatchHistoryPage(input.historyPage)) {
    throw new TypeError('Watch history page must be a positive safe integer.');
  }
  if (input.nextPage !== null && !isValidWatchHistoryPage(input.nextPage)) {
    throw new TypeError('Watch next history page must be a positive safe integer.');
  }
  const state = await getWatchState(input.accountLogin);
  if (!state?.inbox.scanId) return { state, addedCount: 0, applied: false };
  const beforeCount = await db.watchNotificationThreads.count();
  const committed = await commitWatchInboxScanBatch({
    accountLogin: input.accountLogin,
    scanId: state.inbox.scanId,
    before: input.historyBefore,
    expectedPage: input.historyPage,
    pageCount: 1,
    threads: input.threads,
    nextPage: input.nextPage,
    attemptedAt: state.inbox.lastAttemptAt ?? input.historyBefore,
    successfulAt: state.inbox.lastSuccessfulAt ?? input.historyBefore,
  });
  const afterCount = committed.applied
    ? await db.watchNotificationThreads.count()
    : beforeCount;
  return {
    state: committed.state,
    addedCount: Math.max(0, afterCount - beforeCount),
    applied: committed.applied,
  };
}

export async function recordWatchHistoryFailure(input: {
  accountLogin: string;
  historyBefore: string;
  historyPage: number;
  errorCode: string;
}): Promise<GitHubWatchStateRecord | null> {
  const accountLogin = normalizeAccountLogin(input.accountLogin);
  return db.transaction('rw', db.watchState, async () => {
    const storedState = await db.watchState.get(WATCH_STATE_ID);
    if (storedState?.accountLogin !== accountLogin) return null;
    const current = normalizeWatchState(storedState);
    if (
      current.inbox.historyExhausted
      || current.inbox.historyBefore !== input.historyBefore
      || current.inbox.historyNextPage !== input.historyPage
    ) return current;
    const next: GitHubWatchStateRecord = {
      ...current,
      inbox: {
        ...current.inbox,
        errorCode: input.errorCode,
        historyErrorCode: input.errorCode,
        scanStatus: current.inbox.scanStatus === 'scanning'
          ? 'partial'
          : current.inbox.scanStatus,
      },
    };
    await db.watchState.put(next);
    return next;
  });
}

export async function revalidateWatchInbox(input: {
  accountLogin: string;
  attemptedAt: string;
  successfulAt?: string;
  nextAllowedAt: string | null;
  lastModified?: string | null;
  requireLiveStars?: boolean;
}): Promise<GitHubWatchStateRecord> {
  return db.transaction(
    'rw',
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const current = await replaceAccountIfNeeded(input.accountLogin);
      if (current.inbox.scanStatus !== 'complete') {
        throw new TypeError('Watch Inbox can only accept 304 after convergence.');
      }
      const next: GitHubWatchStateRecord = {
        ...current,
        inbox: {
          ...current.inbox,
          lastAttemptAt: input.attemptedAt,
          lastSuccessfulAt: input.successfulAt ?? input.attemptedAt,
          errorCode: null,
          lastModified: input.lastModified === undefined
            ? current.inbox.lastModified
            : input.lastModified,
          nextAllowedAt: input.nextAllowedAt,
          matchedCount: await db.watchNotificationThreads.count(),
        },
      };
      await db.watchState.put(next);
      return next;
    },
  );
}

export async function recordWatchInboxFailure(input: {
  accountLogin: string;
  attemptedAt: string;
  errorCode: string;
}): Promise<GitHubWatchStateRecord> {
  return db.transaction(
    'rw',
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const current = await replaceAccountIfNeeded(input.accountLogin);
      const scanWasActive = current.inbox.scanStatus === 'scanning'
        || current.inbox.scanStatus === 'partial';
      const next: GitHubWatchStateRecord = {
        ...current,
        inbox: {
          ...current.inbox,
          lastAttemptAt: input.attemptedAt,
          errorCode: input.errorCode,
          historyErrorCode: scanWasActive ? input.errorCode : current.inbox.historyErrorCode,
          scanStatus: scanWasActive ? 'partial' : current.inbox.scanStatus,
        },
      };
      await db.watchState.put(next);
      return next;
    },
  );
}

export async function disconnectWatchInbox(
  accountLogin: string | null | undefined,
): Promise<void> {
  const normalizedLogin = accountLogin?.trim()
    ? normalizeAccountLogin(accountLogin)
    : null;
  await db.transaction(
    'rw',
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const state = await db.watchState.get(WATCH_STATE_ID);
      if (!normalizedLogin || state?.accountLogin !== normalizedLogin) {
        await Promise.all([
          db.watchRepositories.clear(),
          db.watchNotificationThreads.clear(),
          db.watchState.clear(),
        ]);
        return;
      }
      await db.watchNotificationThreads.clear();
      await db.watchState.put({ ...state, inbox: emptyInbox() });
    },
  );
}

export async function clearWatchData(): Promise<void> {
  await db.transaction(
    'rw',
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      await Promise.all([
        db.watchRepositories.clear(),
        db.watchNotificationThreads.clear(),
        db.watchState.clear(),
      ]);
    },
  );
}
