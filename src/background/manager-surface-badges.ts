import { authStore } from '@/auth/auth-store';
import * as radarStore from '@/storage/radar-store';
import * as watchStore from '@/storage/watch-store';
import type { ManagerSurfaceBadgeCounts } from '@/runtime/manager-runtime';

const EMPTY_MANAGER_SURFACE_BADGE_COUNTS: ManagerSurfaceBadgeCounts = Object.freeze({
  watchUnreadCount: 0,
  radarUnseenCount: 0,
});

type GitHubCredentialSnapshot = Awaited<ReturnType<typeof authStore.getGitHubCredentialSnapshot>>;

function badgeAccountLogin(snapshot: GitHubCredentialSnapshot): string | null {
  const login = snapshot.accountLogin?.trim();
  return login ? login.toLocaleLowerCase('en-US') : null;
}

function badgeCredentialUnchanged(
  previous: GitHubCredentialSnapshot,
  current: GitHubCredentialSnapshot,
): boolean {
  return badgeAccountLogin(previous) === badgeAccountLogin(current)
    && previous.mainIdentity === current.mainIdentity
    && Boolean(previous.mainToken) === Boolean(current.mainToken);
}

/**
 * Badge counts are read twice around the store reads and discarded when the
 * credential or window changed in between, so a mid-flight account switch never
 * publishes another account's unread counts.
 */
export async function queryManagerSurfaceBadgeCounts(): Promise<ManagerSurfaceBadgeCounts> {
  const [credential, config] = await Promise.all([
    authStore.getGitHubCredentialSnapshot(),
    authStore.getConfig(),
  ]);
  const accountLogin = badgeAccountLogin(credential);
  if (!accountLogin || !credential.mainToken) return EMPTY_MANAGER_SURFACE_BADGE_COUNTS;

  const countedAt = Date.now();
  const [watchUnreadCount, radarUnseenCount] = await Promise.all([
    watchStore.countUnreadWatchThreads(accountLogin),
    radarStore.countUnseenRadarActivities(accountLogin, countedAt, config.radarWindowDays),
  ]);
  const [latestCredential, latestConfig] = await Promise.all([
    authStore.getGitHubCredentialSnapshot(),
    authStore.getConfig(),
  ]);
  if (
    !badgeCredentialUnchanged(credential, latestCredential)
    || config.radarWindowDays !== latestConfig.radarWindowDays
  ) return EMPTY_MANAGER_SURFACE_BADGE_COUNTS;
  return { watchUnreadCount, radarUnseenCount };
}
