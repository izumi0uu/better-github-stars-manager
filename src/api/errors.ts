import type { MessageCatalog } from '@/i18n';

/**
 * Errors are thrown at their origin as stable code strings; `translateError`
 * maps those codes to localized i18n copy, and `unknown(raw)` passes the
 * original through so nothing is silently lost.
 */

// Auth / token-probe codes (thrown by auth-store.setToken).
export const TOKEN_EMPTY = 'TOKEN_EMPTY';
export const TOKEN_REJECTED = 'TOKEN_REJECTED';
export const TOKEN_STARS_FORBIDDEN = 'TOKEN_STARS_FORBIDDEN';
export const TOKEN_GISTS_FORBIDDEN = 'TOKEN_GISTS_FORBIDDEN';
/** Followed by the HTTP status, e.g. `TOKEN_PROFILE_STATUS:403`. */
export const TOKEN_PROFILE_STATUS = 'TOKEN_PROFILE_STATUS:';
export const TOKEN_PROFILE_BAD_SHAPE = 'TOKEN_PROFILE_BAD_SHAPE';
export const TOKEN_PROFILE_NETWORK = 'TOKEN_PROFILE_NETWORK';
/** Followed by the HTTP status, e.g. `TOKEN_STARS_STATUS:403`. */
export const TOKEN_STARS_STATUS = 'TOKEN_STARS_STATUS:';
export const TOKEN_STARS_NETWORK = 'TOKEN_STARS_NETWORK';
/** Followed by the HTTP status, e.g. `TOKEN_GISTS_STATUS:500`. */
export const TOKEN_GISTS_STATUS = 'TOKEN_GISTS_STATUS:';
export const TOKEN_GISTS_NETWORK = 'TOKEN_GISTS_NETWORK';
export const TOKEN_GIST_PROBE_BAD_SHAPE = 'TOKEN_GIST_PROBE_BAD_SHAPE';
/** Followed by the HTTP status, e.g. `TOKEN_GIST_CLEANUP_STATUS:500`. */
export const TOKEN_GIST_CLEANUP_STATUS = 'TOKEN_GIST_CLEANUP_STATUS:';
export const TOKEN_GIST_CLEANUP_NETWORK = 'TOKEN_GIST_CLEANUP_NETWORK';

// Sync / stars-fetch codes (thrown by github-star-source.ts).
export const GH_TOKEN_REJECTED = 'GH_TOKEN_REJECTED';
export const GH_RATE_LIMIT = 'GH_RATE_LIMIT';
export const GH_FORBIDDEN = 'GH_FORBIDDEN';
/** Followed by the page number, e.g. `GH_TIMEOUT:3`. */
export const GH_TIMEOUT = 'GH_TIMEOUT:';
/** Followed by the underlying network detail. */
export const GH_NETWORK = 'GH_NETWORK:';
/** Followed by the HTTP status, e.g. `GH_PAGE_STATUS:502`. */
export const GH_PAGE_STATUS = 'GH_PAGE_STATUS:';
export const GH_NO_TOKEN = 'GH_NO_TOKEN';
export const GH_BAD_SHAPE = 'GH_BAD_SHAPE';

// Gist codes (thrown by gist-tag-store.ts).
export const GIST_NO_TOKEN = 'GIST_NO_TOKEN';
export const GIST_CREATE_FAILED = 'GIST_CREATE_FAILED';
export const GIST_PUSH_FAILED = 'GIST_PUSH_FAILED';
export const GIST_PULL_FAILED = 'GIST_PULL_FAILED';

/** Map a thrown value to a localized, human-friendly string. Pure. */
export function translateError(e: unknown, m: MessageCatalog): string {
  const raw = e instanceof Error ? e.message : String(e);

  // Auth / probe codes.
  if (raw === TOKEN_EMPTY) return m.errors.tokenEmpty;
  if (raw === TOKEN_REJECTED) return m.errors.tokenRejected;
  if (raw === TOKEN_STARS_FORBIDDEN) return m.errors.tokenStarsForbidden;
  if (raw === TOKEN_GISTS_FORBIDDEN) return m.errors.tokenGistsForbidden;
  if (raw.startsWith(TOKEN_PROFILE_STATUS)) return m.errors.tokenProfileStatus(raw.slice(TOKEN_PROFILE_STATUS.length));
  if (raw === TOKEN_PROFILE_BAD_SHAPE) return m.errors.tokenProfileBadShape;
  if (raw === TOKEN_PROFILE_NETWORK) return m.errors.tokenProfileNetwork;
  if (raw.startsWith(TOKEN_STARS_STATUS)) return m.errors.tokenStarsStatus(raw.slice(TOKEN_STARS_STATUS.length));
  if (raw === TOKEN_STARS_NETWORK) return m.errors.tokenStarsNetwork;
  if (raw.startsWith(TOKEN_GISTS_STATUS)) return m.errors.tokenGistsStatus(raw.slice(TOKEN_GISTS_STATUS.length));
  if (raw === TOKEN_GISTS_NETWORK) return m.errors.tokenGistsNetwork;
  if (raw === TOKEN_GIST_PROBE_BAD_SHAPE) return m.errors.tokenGistProbeBadShape;
  if (raw.startsWith(TOKEN_GIST_CLEANUP_STATUS)) return m.errors.tokenGistCleanupStatus(raw.slice(TOKEN_GIST_CLEANUP_STATUS.length));
  if (raw === TOKEN_GIST_CLEANUP_NETWORK) return m.errors.tokenGistCleanupNetwork;

  // Sync / stars-fetch codes.
  if (raw === GH_TOKEN_REJECTED) return m.errors.ghTokenRejected;
  if (raw === GH_RATE_LIMIT) return m.errors.ghRateLimit;
  if (raw === GH_FORBIDDEN) return m.errors.ghForbidden;
  if (raw.startsWith(GH_TIMEOUT)) return m.errors.ghTimeout(Number(raw.slice(GH_TIMEOUT.length)) || 0);
  if (raw.startsWith(GH_NETWORK)) return m.errors.ghNetwork(raw.slice(GH_NETWORK.length));
  if (raw.startsWith(GH_PAGE_STATUS)) return m.errors.ghPageStatus(raw.slice(GH_PAGE_STATUS.length));
  if (raw === GH_NO_TOKEN) return m.errors.ghNoToken;
  if (raw === GH_BAD_SHAPE) return m.errors.ghBadShape;

  // Gist codes.
  if (raw === GIST_NO_TOKEN) return m.errors.gistNoToken;
  if (raw === GIST_CREATE_FAILED) return m.errors.gistCreateFailed;
  if (raw === GIST_PUSH_FAILED) return m.errors.gistPushFailed;
  if (raw === GIST_PULL_FAILED) return m.errors.gistPullFailed;

  // Passthrough — keep the raw tail so nothing is silently lost.
  return m.errors.unknown(raw);
}
