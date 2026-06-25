/**
 * Pure decision function for the stars-page content script. Kept in its own
 * module (no React/CSS/DOM imports) so tests can import it cleanly.
 */

export type MountState = 'panel' | 'fab' | 'none';

/**
 * Lowercased owner login from a stars URL — `/<login>` (profile tab) or
 * `/users/<login>` (canonical) — or null for non-owner paths (`/stars`,
 * `/orgs`, repo paths, …). Caller compares to the authenticated user.
 */
export function pageOwner(pathname: string): string | null {
  const users = pathname.match(/^\/users\/([^/]+)/i);
  if (users) {
    const login = users[1].toLowerCase();
    return RESERVED.has(login) ? null : login;
  }
  const profile = pathname.match(/^\/([^/]+)\/?$/i);
  if (profile) {
    const login = profile[1].toLowerCase();
    return RESERVED.has(login) ? null : login;
  }
  return null;
}

// App routes that look like a login but aren't.
const RESERVED = new Set([
  'stars', 'orgs', 'settings', 'notifications', 'search', 'explore',
  'login', 'signup', 'sessions', 'marketplace', 'trending', 'collections',
  'topics', 'events', 'about', 'pricing', 'security', 'contact', 'customer-stories',
]);

/**
 * panel: own stars page + enabled → mount.
 * fab:   own stars page + disabled → floating re-mount button (native list shows underneath).
 * none:  not own stars page (someone else's, or not a stars page) → retract.
 *
 * `isOwnStars` = tab=stars AND owner==me, precomputed by the async caller so
 * this stays pure/synchronous/testable.
 */
export function mountState(isOwnStars: boolean, enabled: boolean): MountState {
  if (!isOwnStars) return 'none';
  return enabled ? 'panel' : 'fab';
}
