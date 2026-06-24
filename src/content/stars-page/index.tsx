import { createRoot } from 'react-dom/client';
import { ManagerPanel } from '@/ui/ManagerPanel';
import { I18nProvider } from '@/i18n';
import cssText from '@/ui/styles.css?inline';

/**
 * Stars-page content script.
 *
 * Injects a full-screen management panel that replaces the native starred list
 * with a virtualized table. It mounts inside a shadow root so the extension's
 * Tailwind/preflight CSS (loaded via `?inline` → `adoptedStyleSheets`) is fully
 * isolated from `github.com`'s light DOM.
 *
 * `?inline` is critical: a normal `import './styles.css'` would be picked up by
 * CRXJS's content-script CSS plugin and injected into the page `<head>`, which
 * would leak preflight across GitHub. `?inline` returns the CSS string only, so
 * it can stay inside the shadow boundary.
 *
 * MV3 match patterns cannot target query strings, so the script gates on `?tab=stars`.
 */
function isStarsPage(): boolean {
  return new URLSearchParams(location.search).get('tab') === 'stars';
}

// --- Page scroll lock ---
// The panel is a full-screen fixed overlay. If the underlying page body keeps
// scrolling, its scrollbar thumb tracks the page (not the panel's virtual list),
// which looks broken. We lock html+body overflow while the panel is mounted and
// restore the original values when it's removed (e.g. navigating away from
// ?tab=stars). Idempotent: re-locking stores the already-saved originals only once.
let savedHtmlOverflow: string | null = null;
let savedBodyOverflow: string | null = null;

function lockPageScroll(): void {
  if (savedHtmlOverflow === null) savedHtmlOverflow = document.documentElement.style.overflow;
  if (savedBodyOverflow === null) savedBodyOverflow = document.body.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
}

function unlockPageScroll(): void {
  document.documentElement.style.overflow = savedHtmlOverflow ?? '';
  document.body.style.overflow = savedBodyOverflow ?? '';
  savedHtmlOverflow = null;
  savedBodyOverflow = null;
}

function injectPanel(): void {
  if (!isStarsPage()) return;
  if (document.getElementById('gsm-manager-host')) return; // idempotent

  // Full-screen overlay host (kept in the light DOM for positioning); the
  // actual UI + styles live inside its shadow root.
  const host = document.createElement('div');
  host.id = 'gsm-manager-host';
  host.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483000;';

  // Lock the underlying page scroll. The panel is a full-screen fixed overlay,
  // so the page body should NOT scroll — if it can, its scrollbar shows a thumb
  // that tracks the page (not the panel's virtual list), which looks broken.
  // We pin html+body to overflow:hidden for the panel's lifetime.
  lockPageScroll();

  const shadow = host.attachShadow({ mode: 'open' });
  // Adopt the Tailwind CSS into the shadow root (isolated from the page).
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    // Fallback: older browsers without constructable stylesheets.
    const styleEl = document.createElement('style');
    styleEl.textContent = cssText;
    shadow.appendChild(styleEl);
  }

  // Inner root carries the theme class (.dark / none) — NOT documentElement,
  // which would toggle github.com's own dark mode.
  const root = document.createElement('div');
  root.id = 'gsm-manager-root';
  root.style.cssText = 'width:100%;height:100%;';
  shadow.appendChild(root);

  // Insert the host, hiding GitHub's native chrome behind the overlay.
  const main = document.querySelector('main') ?? document.querySelector('[data-pjax-container]') ?? document.body;
  main.parentElement?.insertBefore(host, main);

  createRoot(root).render(
    <I18nProvider>
      <ManagerPanel />
    </I18nProvider>,
  );
}

// GitHub uses Turbo/PJAX; re-inject on navigation. If we navigated AWAY from
// the stars page, remove the overlay and restore page scrolling.
function sync(): void {
  const host = document.getElementById('gsm-manager-host');
  if (isStarsPage()) {
    injectPanel();
  } else if (host) {
    host.remove();
    unlockPageScroll();
  }
}

sync();
document.addEventListener('turbo:load', sync);
document.addEventListener('turbo:render', sync);
window.addEventListener('popstate', sync);
