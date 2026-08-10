import { authStore } from '@/auth/auth-store';

export function isUnstarElement(target: HTMLElement): boolean {
  let current: HTMLElement | null = target;
  while (current && current !== document.body) {
    if (current instanceof HTMLFormElement && current.action?.includes('/unstar')) return true;
    const aria = (current.getAttribute('aria-label') || '').toLowerCase();
    const value = (current.getAttribute('value') || '').toLowerCase();
    const hydro = (current.getAttribute('data-hydro-click') || '').toLowerCase();
    const ga = (current.getAttribute('data-ga-click') || '').toLowerCase();

    if (
      aria.includes('unstar') ||
      value === 'unstar' ||
      hydro.includes('unstar') ||
      ga.includes('unstar')
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

export function extractRepoFullName(el: HTMLElement | null): string | null {
  let current: HTMLElement | null = el;
  while (current && current !== document.body) {
    if (current instanceof HTMLFormElement && current.action) {
      const url = new URL(current.action, location.origin);
      const match = url.pathname.match(/^\/([^\/]+\/[^\/]+)\/(?:unstar|star)$/);
      if (match) return match[1];
    }
    const actionAttr = current.getAttribute('action') || current.getAttribute('data-action') || '';
    const matchAttr = actionAttr.match(/^\/([^\/]+\/[^\/]+)\/(?:unstar|star)$/);
    if (matchAttr) return matchAttr[1];

    const repoAttr = current.getAttribute('data-repo') || current.getAttribute('data-repository');
    if (repoAttr && repoAttr.includes('/')) return repoAttr;

    current = current.parentElement;
  }

  const pageMatch = location.pathname.match(/^\/([^\/]+\/[^\/]+)(?:\/|$)/);
  if (pageMatch) {
    const firstSegment = pageMatch[1].split('/')[0].toLowerCase();
    if (!['settings', 'orgs', 'users', 'notifications', 'search', 'features', 'pricing', 'explore'].includes(firstSegment)) {
      return pageMatch[1];
    }
  }
  return null;
}

export function setupNativeStarListener(): void {
  let listening = false;

  const handleNativeAction = (target: HTMLElement) => {
    if (!isUnstarElement(target)) return;
    const fullName = extractRepoFullName(target);
    if (fullName) {
      void authStore.hasToken().then((hasToken) => {
        if (hasToken) {
          void chrome.runtime.sendMessage({ type: 'markUnstarred', full_name: fullName }).catch(() => {});
        }
      });
    }
  };

  if (!listening) {
    listening = true;
    document.addEventListener('click', (e) => {
      if (e.target instanceof HTMLElement) {
        handleNativeAction(e.target);
      }
    }, true);

    document.addEventListener('submit', (e) => {
      if (e.target instanceof HTMLElement) {
        handleNativeAction(e.target);
      }
    }, true);
  }
}
