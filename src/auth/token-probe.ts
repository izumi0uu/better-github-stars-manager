import {
  TOKEN_REJECTED,
  TOKEN_PROFILE_STATUS,
  TOKEN_PROFILE_BAD_SHAPE,
  TOKEN_PROFILE_NETWORK,
  TOKEN_REPO_MISSING,
  TOKEN_GIST_MISSING,
  TOKEN_NOTIFICATIONS_MISSING,
} from '@/api/errors';

type FetchLike = typeof fetch;

export interface TokenProbeIdentity {
  login: string;
  avatarUrl: string | null;
  displayName: string | null;
  scopesHeader: string;
}

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
 * Probe a classic PAT before persisting it: authenticate against /user, then
 * read the `x-oauth-scopes` header to require repo, gist, and notifications.
 *
 * Fine-grained tokens do not set `x-oauth-scopes`, so they're rejected here —
 * the extension only supports classic PATs.
 */
export async function probeTokenCapabilities(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenProbeIdentity> {
  const auth = authHeaders(token);
  const profile = await fetchWithCode(
    fetchImpl,
    `${API}/user`,
    { headers: auth, cache: 'no-store' },
    TOKEN_PROFILE_NETWORK,
  );
  if (profile.status === 401) throw new Error(TOKEN_REJECTED);
  if (!profile.ok) throw new Error(`${TOKEN_PROFILE_STATUS}${profile.status}`);

  const scopesHeader = profile.headers.get('x-oauth-scopes');
  if (scopesHeader === null) throw new Error(TOKEN_REJECTED);
  const scopes = new Set(
    scopesHeader
      .toLowerCase()
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  if (!scopes.has('repo')) throw new Error(TOKEN_REPO_MISSING);
  if (!scopes.has('gist')) throw new Error(TOKEN_GIST_MISSING);
  if (!scopes.has('notifications')) throw new Error(TOKEN_NOTIFICATIONS_MISSING);

  const body = (await profile.json()) as { login?: string; avatar_url?: string; name?: string | null };
  if (!body.login) throw new Error(TOKEN_PROFILE_BAD_SHAPE);
  return {
    login: body.login,
    avatarUrl: body.avatar_url ?? null,
    displayName: body.name ?? null,
    scopesHeader: scopesHeader.toLowerCase(),
  };
}
