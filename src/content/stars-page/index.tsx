import { createRoot, type Root } from 'react-dom/client';
import { ManagerPanel } from '@/ui/ManagerPanel';
import { I18nProvider, messageFor } from '@/i18n';
import { authStore } from '@/auth/auth-store';
import { mountState, pageOwner } from '@/content/stars-page/mount-state';
import { isPanelEnabled, onPanelToggle, showPanel } from '@/content/stars-page/panel-toggle';
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
 *
 * The panel can be temporarily retracted via the toolbar "hide panel" button —
 * the native GitHub stars list is then visible with a floating "show panel"
 * button (the FAB) to re-mount it. This hide is a SESSION-LOCAL preview only:
 * the toggle lives in a module-level variable that resets to `true` (panel on)
 * whenever the content script re-runs (full page load / new tab). Refreshing or
 * re-entering the stars page therefore always lands on the panel — never a
 * stuck hidden state. (We deliberately do NOT persist it: a persisted "hidden"
 * would make the extension appear missing on next visit.)
 */
// Cheap URL pre-filter; the full owner==me check is in isOwnStars().
function isStarsPage(): boolean {
  return new URLSearchParams(location.search).get('tab') === 'stars';
}

// tab=stars AND owner==me. No token → false: the panel is useless without one,
// and a logged-out browser must not overlay a stranger's stars page.
async function isOwnStars(): Promise<boolean> {
  if (!isStarsPage()) return false;
  const owner = pageOwner(location.pathname);
  if (!owner) return false;
  const me = (await authStore.getUsername())?.toLowerCase();
  return !!me && me === owner;
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

// --- Panel lifecycle ---
// `panelRoot` is kept so the React tree (and its chrome.runtime.onMessage /
// onProgress listeners) is explicitly torn down on eject. Previously the root
// reference was discarded, so navigating stars→away→stars leaked one listener
// stack per cycle.
let panelRoot: Root | null = null;

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

  // GitHub's site-wide `s`/`/` shortcuts live on `document`; a keystroke inside
  // this shadow root is retargeted to the host there, so GitHub's "am I in a
  // field?" guard fails and it steals focus from our inputs. Stop the event at
  // the shadow boundary — but only for editable fields, so `/` on the body still
  // reaches ManagerPanel's window listener (the `/`→focus-search shortcut).
  shadow.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) e.stopPropagation();
  }, true);

  // Insert the host, hiding GitHub's native chrome behind the overlay.
  const main = document.querySelector('main') ?? document.querySelector('[data-pjax-container]') ?? document.body;
  main.parentElement?.insertBefore(host, main);

  panelRoot = createRoot(root);
  panelRoot.render(
    <I18nProvider>
      <ManagerPanel />
    </I18nProvider>,
  );
}

// State-based eject: unmount the React tree FIRST, regardless of whether the
// host still exists, so a half-removed state (host gone, root still alive) can
// never leave orphaned listeners. Only then clear the host and unlock scroll.
function ejectPanel(): void {
  panelRoot?.unmount();
  panelRoot = null;
  document.getElementById('gsm-manager-host')?.remove();
  unlockPageScroll();
}

// --- Floating "show panel" button (FAB) ---
// Shown only when the panel is disabled but we're still on the stars page, so
// the user has an in-page way to re-mount the panel. Vanilla DOM + inline SVG +
// open shadow root (styles sealed in the shadow boundary → already insulated
// from GitHub's CSS; `open` keeps it inspectable/debuggable). No React/Tailwind.
function injectFab(): void {
  if (document.getElementById('gsm-fab')) return; // idempotent

  const host = document.createElement('div');
  host.id = 'gsm-fab';
  host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483000;';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  // Neutral palette that reads on both GitHub light/dark. The button is a
  // translucent dark pill with a white glyph; a prefers-color-scheme tweak
  // lifts contrast slightly in dark mode.
  style.textContent = `
    :host { all: initial; }
    .btn {
      display:inline-flex; align-items:center; justify-content:center;
      position:relative;
      width:44px; height:44px; border:0; border-radius:9999px;
      background:rgba(20,23,28,0.92); color:#ffffff;
      box-shadow:0 6px 18px rgba(0,0,0,0.28);
      cursor:pointer; transition:transform .12s ease, background .12s ease;
    }
    .btn:hover { background:rgba(20,23,28,1); transform:translateY(-1px); }
    .btn:active { transform:translateY(0); }
    .btn svg { display:block; }
    /* CSS-only tooltip. The native title attribute has a fixed ~1-2s system
       delay we cannot shorten; this shows ~immediately. Opens to the LEFT since
       the FAB sits in the bottom-right corner. Only rendered once data-tip is
       set, so the brief pre-locale-resolve window shows no bubble. */
    .btn[data-tip]::after {
      content: attr(data-tip);
      position:absolute; right:calc(100% + 10px); top:50%; transform:translateY(-50%);
      white-space:nowrap;
      background:rgba(20,23,28,0.92); color:#ffffff;
      font:12px/1.4 -apple-system,system-ui,sans-serif;
      padding:5px 9px; border-radius:6px;
      box-shadow:0 4px 12px rgba(0,0,0,0.25);
      opacity:0; pointer-events:none;
      transition:opacity .12s ease; transition-delay:0s;
    }
    .btn[data-tip]:hover::after { opacity:1; transition-delay:.08s; }
    @media (prefers-color-scheme: dark) {
      .btn { background:rgba(255,255,255,0.14); color:#e6edf3; box-shadow:0 6px 18px rgba(0,0,0,0.5); }
      .btn:hover { background:rgba(255,255,255,0.22); }
      .btn[data-tip]::after { background:rgba(255,255,255,0.92); color:#0d1117; box-shadow:0 4px 12px rgba(0,0,0,0.5); }
    }
  `;
  shadow.appendChild(style);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn'; // picks up the .btn rule above (cursor:pointer, pill bg, hover…)
  btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>`;
  btn.onclick = showPanel;
  shadow.appendChild(btn);
  document.body.appendChild(host);

  // Localize the tooltip/aria-label to the extension's name (the FAB is a
  // generic re-mount affordance, so the product name is the most recognizable
  // label). Vanilla DOM → can't use the React useI18n hook, so read the locale
  // and look up the string. The CSS bubble reads `data-tip` (NOT the native
  // `title`, whose ~1–2s system delay we can't shorten); `aria-label` keeps it
  // accessible to screen readers. Read asynchronously; until it resolves the
  // bubble simply isn't rendered.
  void authStore.getLocale().then((locale) => {
    const label = messageFor(locale).popup.title;
    if (!document.getElementById('gsm-fab')) return; // gone already
    btn.setAttribute('data-tip', label);
    btn.setAttribute('aria-label', label);
  });
}

function ejectFab(): void {
  document.getElementById('gsm-fab')?.remove();
}

// --- Sync ---
// Async because isOwnStars() awaits getUsername(); a generation counter drops
// stale resolutions across rapid PJAX navigations (turbo:load→render→popstate).
let syncGen = 0;
async function sync(): Promise<void> {
  const gen = ++syncGen;
  const isOwn = await isOwnStars();
  if (gen !== syncGen) return; // superseded by a newer navigation
  const state = mountState(isOwn, isPanelEnabled());
  if (state === 'panel') {
    injectPanel();
    ejectFab();
  } else if (state === 'fab') {
    ejectPanel();
    injectFab();
  } else {
    // Not own stars page: retract both.
    ejectPanel();
    ejectFab();
  }
}

// Let the toolbar "hide panel" button (inside the React ManagerPanel) and the
// FAB "show panel" button drive this module's sync without importing the
// side-effectful entry — see panel-toggle.ts.
onPanelToggle(sync);

sync();
document.addEventListener('turbo:load', sync);
document.addEventListener('turbo:render', sync);
window.addEventListener('popstate', sync);
