import { db } from '@/storage/db';
import {
  canonicalRepositoryFullName,
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
 * Remove cached Watch rows that no longer belong to the current live-star
 * library. Native watched membership and Inbox threads are independent
 * projections, so each is pruned directly against live Stars.
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
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const state = await db.watchState.get(WATCH_STATE_ID);
      if (state?.accountLogin !== normalizedLogin) return false;

      const [stars, repositories, threads] = await Promise.all([
        db.stars.toArray(),
        db.watchRepositories.toArray(),
        db.watchNotificationThreads.toArray(),
      ]);
      const liveNames = new Set(stars.flatMap((star) => {
        if (star.tombstone || star.viewer_has_starred === false) return [];
        const fullName = canonicalRepositoryFullName(star.full_name);
        return fullName ? [fullName] : [];
      }));
      const removedRepositoryNames = repositories
        .filter((repository) => !liveNames.has(repository.full_name))
        .map((repository) => repository.full_name);
      const removedThreadIds = threads
        .filter((thread) => !liveNames.has(thread.repositoryFullName))
        .map((thread) => thread.id);
      const repositoryCount = repositories.length - removedRepositoryNames.length;
      const matchedCount = threads.length - removedThreadIds.length;
      const stateChanged = state.scope.repositoryCount !== repositoryCount ||
        state.inbox.matchedCount !== matchedCount;
      if (!removedRepositoryNames.length && !removedThreadIds.length && !stateChanged) {
        return false;
      }

      if (removedRepositoryNames.length) {
        await db.watchRepositories.bulkDelete(removedRepositoryNames);
      }
      if (removedThreadIds.length) {
        await db.watchNotificationThreads.bulkDelete(removedThreadIds);
      }
      await db.watchState.put({
        ...state,
        scope: { ...state.scope, repositoryCount },
        inbox: { ...state.inbox, matchedCount },
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

async function replaceAccountIfNeeded(accountLogin: string): Promise<GitHubWatchStateRecord> {
  const normalizedLogin = normalizeAccountLogin(accountLogin);
  const current = await db.watchState.get(WATCH_STATE_ID);
  if (current?.accountLogin === normalizedLogin) return current;

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
  return state?.accountLogin === normalizedLogin ? state : null;
}

export async function countUnreadWatchThreads(
  accountLogin: string | null | undefined,
): Promise<number> {
  if (!accountLogin?.trim()) return 0;
  const normalizedLogin = normalizeAccountLogin(accountLogin);
  return db.transaction('r', db.stars, db.watchNotificationThreads, db.watchState, async () => {
    const state = await db.watchState.get(WATCH_STATE_ID);
    if (state?.accountLogin !== normalizedLogin) return 0;
    const unreadThreads = await db.watchNotificationThreads
      .filter((thread) => thread.unread)
      .toArray();
    if (unreadThreads.length === 0) return 0;
    const repositoryNames = [...new Set(unreadThreads.map((thread) => thread.repositoryFullName))];
    const liveStars = await db.stars
      .where('full_name')
      .anyOfIgnoreCase(repositoryNames)
      .filter((star) => !star.tombstone && star.viewer_has_starred !== false)
      .toArray();
    const liveNames = liveRepositoryNames(liveStars);
    return unreadThreads.reduce(
      (count, thread) => count + (liveNames.has(thread.repositoryFullName) ? 1 : 0),
      0,
    );
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
    return (await db.watchNotificationThreads.get(input.threadId.trim())) ?? null;
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
      return {
        ...projectWatchInbox(
          await db.watchNotificationThreads.toArray(),
          { unreadOnly: input.unreadOnly },
        ),
        state,
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
    const state = await db.watchState.get(WATCH_STATE_ID);
    if (state?.accountLogin !== accountLogin) return 0;
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
      await db.watchState.put({
        ...state,
        inbox: {
          ...state.inbox,
          matchedCount: await db.watchNotificationThreads.count(),
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

export async function replaceWatchInbox(input: {
  accountLogin: string;
  threads: readonly GitHubNotificationThread[];
  attemptedAt: string;
  successfulAt?: string;
  lastModified: string | null;
  nextAllowedAt: string | null;
  candidateCount: number;
  truncated: boolean;
  mode: 'replace' | 'merge';
  requireLiveStars?: boolean;
}): Promise<GitHubWatchStateRecord> {
  const normalizedThreads = normalizeThreads(input.threads);
  return db.transaction(
    'rw',
    db.stars,
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const current = await replaceAccountIfNeeded(input.accountLogin);
      const liveNames = input.requireLiveStars
        ? liveRepositoryNames(await db.stars.toArray())
        : null;
      const publishedThreads = liveNames
        ? normalizedThreads.filter((thread) => liveNames.has(thread.repositoryFullName))
        : normalizedThreads;
      if (input.mode === 'replace') {
        await db.watchNotificationThreads.clear();
      } else if (liveNames) {
        const staleThreadIds = (await db.watchNotificationThreads.toArray())
          .flatMap((thread) => liveNames.has(thread.repositoryFullName) ? [] : [thread.id]);
        if (staleThreadIds.length) await db.watchNotificationThreads.bulkDelete(staleThreadIds);
      }
      if (publishedThreads.length) await db.watchNotificationThreads.bulkPut(publishedThreads);
      const matchedCount = await db.watchNotificationThreads.count();
      const next: GitHubWatchStateRecord = {
        ...current,
        inbox: {
          lastAttemptAt: input.attemptedAt,
          lastSuccessfulAt: input.successfulAt ?? input.attemptedAt,
          errorCode: null,
          lastModified: input.lastModified,
          nextAllowedAt: input.nextAllowedAt,
          candidateCount: input.mode === 'merge'
            ? current.inbox.candidateCount + input.candidateCount
            : input.candidateCount,
          matchedCount,
          truncated: input.mode === 'merge'
            ? current.inbox.truncated || input.truncated
            : input.truncated,
        },
      };
      await db.watchState.put(next);
      return next;
    },
  );
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
    db.stars,
    db.watchRepositories,
    db.watchNotificationThreads,
    db.watchState,
    async () => {
      const current = await replaceAccountIfNeeded(input.accountLogin);
      if (input.requireLiveStars) {
        const liveNames = liveRepositoryNames(await db.stars.toArray());
        const staleThreadIds = (await db.watchNotificationThreads.toArray())
          .flatMap((thread) => liveNames.has(thread.repositoryFullName) ? [] : [thread.id]);
        if (staleThreadIds.length) await db.watchNotificationThreads.bulkDelete(staleThreadIds);
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
      const next: GitHubWatchStateRecord = {
        ...current,
        inbox: {
          ...current.inbox,
          lastAttemptAt: input.attemptedAt,
          errorCode: input.errorCode,
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
