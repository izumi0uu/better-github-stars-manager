export const EXCLUDED_TOP_LEVEL_PATHS = new Set([
  'settings',
  'orgs',
  'users',
  'search',
  'explore',
  'notifications',
  'login',
  'signup',
  'stars',
  'dashboard',
  'marketplace',
  'pulls',
  'issues',
  'trending',
  'collections',
  'topics',
  'events',
  'sponsors',
  'about',
  'features',
  'security',
  'customer-stories',
  'readme',
  'enterprise',
  'team',
  'pricing',
  'site',
  'resources',
  'apps',
  'developer',
  'copilot',
  'freecoursecenter',
  'forks',
  'network',
  'graphs',
]);

export function parseRepoFromPathname(pathname: string): { owner: string; repo: string } | null {
  const match = pathname.match(/^\/([^/]+)\/([^/]+?)(?:\/|$)/);
  if (!match) return null;
  const [, owner, repo] = match;
  if (EXCLUDED_TOP_LEVEL_PATHS.has(owner)) return null;
  return { owner, repo };
}
