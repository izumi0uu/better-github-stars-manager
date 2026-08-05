import {
  TOKEN_REJECTED,
  TOKEN_STARS_FORBIDDEN,
  TOKEN_GISTS_FORBIDDEN,
  TOKEN_PROFILE_STATUS,
  TOKEN_PROFILE_BAD_SHAPE,
  TOKEN_PROFILE_NETWORK,
  TOKEN_STARS_STATUS,
  TOKEN_STARS_NETWORK,
  TOKEN_GISTS_STATUS,
  TOKEN_GISTS_NETWORK,
  TOKEN_GIST_PROBE_BAD_SHAPE,
  TOKEN_GIST_CLEANUP_STATUS,
  TOKEN_GIST_CLEANUP_NETWORK,
  TOKEN_WATCHING_FORBIDDEN,
  TOKEN_WATCHING_BAD_SHAPE,
  TOKEN_WATCHING_STATUS,
  TOKEN_WATCHING_NETWORK,
  WATCH_TOKEN_REJECTED,
  WATCH_TOKEN_ACCOUNT_MISMATCH,
  WATCH_TOKEN_PROFILE_STATUS,
  WATCH_TOKEN_PROFILE_BAD_SHAPE,
  WATCH_TOKEN_PROFILE_NETWORK,
  WATCH_TOKEN_NOTIFICATIONS_FORBIDDEN,
  WATCH_TOKEN_NOTIFICATIONS_STATUS,
  WATCH_TOKEN_NOTIFICATIONS_NETWORK,
  WATCH_TOKEN_NOTIFICATIONS_BAD_SHAPE,
} from '@/api/errors';

type FetchLike = typeof fetch;

export interface TokenProbeIdentity {
  login: string;
  avatarUrl: string | null;
  displayName: string | null;
  scopesHeader: string;
  watching: TokenWatchingCapability;
}

export type TokenWatchingCapability =
  | { available: true }
  | { available: false; errorCode: string };

const API = 'https://api.github.com';

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
}

async function fetchWithCode(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  networkCode: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new Error(networkCode);
  }
}

/**
 * Probe the non-destructive GitHub capabilities before a token is persisted:
 * authenticate, read /user/starred, create a secret gist, then prove the probe
 * gist was actually cleaned up. Starring writes are enforced by the unstar call.
 */
export async function probeTokenCapabilities(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenProbeIdentity> {
  const auth = authHeaders(token);

  const profile = await fetchWithCode(fetchImpl, `${API}/user`, { headers: auth }, TOKEN_PROFILE_NETWORK);
  if (profile.status === 401) throw new Error(TOKEN_REJECTED);
  if (!profile.ok) throw new Error(`${TOKEN_PROFILE_STATUS}${profile.status}`);
  const scopesHeader = (profile.headers.get('x-oauth-scopes') ?? '').toLowerCase();
  const body = (await profile.json()) as { login?: string; avatar_url?: string; name?: string | null };
  if (!body.login) throw new Error(TOKEN_PROFILE_BAD_SHAPE);

  const stars = await fetchWithCode(
    fetchImpl,
    `${API}/user/starred?per_page=1&page=1`,
    { headers: { ...auth, Accept: 'application/vnd.github.star+json' }, cache: 'no-store' },
    TOKEN_STARS_NETWORK,
  );
  if (stars.status === 401) throw new Error(TOKEN_REJECTED);
  if (stars.status === 403) throw new Error(TOKEN_STARS_FORBIDDEN);
  if (!stars.ok) throw new Error(`${TOKEN_STARS_STATUS}${stars.status}`);

  const probe = await fetchWithCode(
    fetchImpl,
    `${API}/gists`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'gsm-permission-probe',
        public: false,
        files: { '.gsm-probe': { content: 'delete me' } },
      }),
    },
    TOKEN_GISTS_NETWORK,
  );
  if (probe.status === 401) throw new Error(TOKEN_REJECTED);
  if (probe.status === 403 || probe.status === 404) throw new Error(TOKEN_GISTS_FORBIDDEN);
  if (!probe.ok) throw new Error(`${TOKEN_GISTS_STATUS}${probe.status}`);
  const probeBody = (await probe.json()) as { id?: string };
  if (!probeBody.id) throw new Error(TOKEN_GIST_PROBE_BAD_SHAPE);

  const cleanup = await fetchWithCode(
    fetchImpl,
    `${API}/gists/${probeBody.id}`,
    { method: 'DELETE', headers: auth },
    TOKEN_GIST_CLEANUP_NETWORK,
  );
  if (cleanup.status === 401) throw new Error(TOKEN_REJECTED);
  if (cleanup.status === 403 || cleanup.status === 404) throw new Error(TOKEN_GISTS_FORBIDDEN);
  if (!cleanup.ok) throw new Error(`${TOKEN_GIST_CLEANUP_STATUS}${cleanup.status}`);

  let watching: TokenWatchingCapability;
  try {
    const response = await fetchImpl(`${API}/user/subscriptions?per_page=1&page=1`, {
      headers: auth,
      cache: 'no-store',
    });
    if (response.ok) {
      try {
        watching = Array.isArray(await response.json())
          ? { available: true }
          : { available: false, errorCode: TOKEN_WATCHING_BAD_SHAPE };
      } catch {
        watching = { available: false, errorCode: TOKEN_WATCHING_BAD_SHAPE };
      }
    } else if (response.status === 403) {
      watching = { available: false, errorCode: TOKEN_WATCHING_FORBIDDEN };
    } else {
      watching = { available: false, errorCode: `${TOKEN_WATCHING_STATUS}${response.status}` };
    }
  } catch {
    watching = { available: false, errorCode: TOKEN_WATCHING_NETWORK };
  }

  return {
    login: body.login,
    avatarUrl: body.avatar_url ?? null,
    displayName: body.name ?? null,
    scopesHeader,
    watching,
  };
}

export async function probeWatchNotificationsToken(
  token: string,
  expectedLogin: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ login: string }> {
  const auth = authHeaders(token);
  const profile = await fetchWithCode(
    fetchImpl,
    `${API}/user`,
    { headers: auth, cache: 'no-store' },
    WATCH_TOKEN_PROFILE_NETWORK,
  );
  if (profile.status === 401) throw new Error(WATCH_TOKEN_REJECTED);
  if (!profile.ok) throw new Error(`${WATCH_TOKEN_PROFILE_STATUS}${profile.status}`);
  let profileBody: unknown;
  try {
    profileBody = await profile.json();
  } catch {
    throw new Error(WATCH_TOKEN_PROFILE_BAD_SHAPE);
  }
  const login = profileBody && typeof profileBody === 'object' && !Array.isArray(profileBody)
    ? (profileBody as { login?: unknown }).login
    : null;
  if (typeof login !== 'string' || !login.trim()) {
    throw new Error(WATCH_TOKEN_PROFILE_BAD_SHAPE);
  }
  if (login.trim().toLowerCase() !== expectedLogin.trim().toLowerCase()) {
    throw new Error(WATCH_TOKEN_ACCOUNT_MISMATCH);
  }

  const notifications = await fetchWithCode(
    fetchImpl,
    `${API}/notifications?all=true&per_page=1`,
    { headers: auth, cache: 'no-store' },
    WATCH_TOKEN_NOTIFICATIONS_NETWORK,
  );
  if (notifications.status === 401) throw new Error(WATCH_TOKEN_REJECTED);
  if (notifications.status === 403 || notifications.status === 404) {
    throw new Error(WATCH_TOKEN_NOTIFICATIONS_FORBIDDEN);
  }
  if (!notifications.ok) {
    throw new Error(`${WATCH_TOKEN_NOTIFICATIONS_STATUS}${notifications.status}`);
  }
  let notificationsBody: unknown;
  try {
    notificationsBody = await notifications.json();
  } catch {
    throw new Error(WATCH_TOKEN_NOTIFICATIONS_BAD_SHAPE);
  }
  if (!Array.isArray(notificationsBody)) {
    throw new Error(WATCH_TOKEN_NOTIFICATIONS_BAD_SHAPE);
  }
  return { login: login.trim() };
}
