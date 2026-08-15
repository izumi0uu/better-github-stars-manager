import { createRoot, type Root } from 'react-dom/client';
import { ManagerPanel } from '@/ui/ManagerPanel';
import { I18nProvider } from '@/i18n';
import { authStore, CONFIG_STORAGE_KEY } from '@/auth/auth-store';
import { applyFabLabel } from '@/content/stars-page/fab-label';
import brandMarkUrl from '@/assets/bgsm-brand-mark.svg?url';
import { mountState, pageOwner } from '@/content/stars-page/mount-state';
import { stopEditableKeydownAtShadowBoundary } from '@/content/stars-page/keyboard-boundary';
import {
  isPanelEnabled,
  onPanelToggle,
  resetPanelToggle,
  showPanel,
} from '@/content/stars-page/panel-toggle';
import { signalRecommendationEntry } from '@/utils/recommendation-entry';
import cssText from '@/ui/styles/index.css?inline';

/**
 * Stars-page content script.
 *
 * Mounts the manager panel in a shadow root and keeps Tailwind/preflight scoped
 * with `?inline`; a normal CSS import would leak styles into github.com.
 * The stars-page gate stays runtime-based because MV3 match patterns cannot
 * target query strings. Hiding the panel is session-local only, so a refresh
 * cannot strand the user with an apparently missing extension.
 */
type StarsPageRuntime = {
  document: Document;
  sync(): Promise<void>;
  dispose(): void;
};

const pageRuntimes = new WeakMap<Window, StarsPageRuntime>();

/**
 * CRXJS loads content entries as cached ES modules and calls `onExecute` for
 * every manifest injection. A WindowProxy may survive navigation while its
 * Document changes, so reuse is valid only for the exact current Document.
 */
export function installStarsPageRuntime(pageWindow: Window): void {
  const pageDocument = pageWindow.document;
  const current = pageRuntimes.get(pageWindow);
  if (current?.document === pageDocument) {
    void current.sync();
    return;
  }
  if (current) {
    current.dispose();
    resetPanelToggle(pageWindow);
  }

  const window = pageWindow;
  const document = pageDocument;
  const { location } = window;

  function isStarsPage(): boolean {
    return new URLSearchParams(location.search).get('tab') === 'stars';
  }

  // No token means no owner proof; never overlay another user's stars page.
  async function isOwnStars(): Promise<boolean> {
    if (!isStarsPage()) return false;
    const owner = pageOwner(location.pathname);
    if (!owner) return false;
    const me = (await authStore.getUsername())?.toLowerCase();
    return !!me && me === owner;
  }

  // Keep the page scrollbar from tracking GitHub behind the full-screen panel.
  let savedHtmlOverflow: string | null = null;
  let savedBodyOverflow: string | null = null;

  function lockPageScroll(): void {
    if (savedHtmlOverflow === null) savedHtmlOverflow = document.documentElement.style.overflow;
    if (savedBodyOverflow === null) savedBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }

  function unlockPageScroll(): void {
    if (savedHtmlOverflow === null && savedBodyOverflow === null) return;
    document.documentElement.style.overflow = savedHtmlOverflow ?? '';
    document.body.style.overflow = savedBodyOverflow ?? '';
    savedHtmlOverflow = null;
    savedBodyOverflow = null;
  }

  // Keep the React root so ejecting also tears down runtime/progress listeners.
  let panelRoot: Root | null = null;
  let panelHost: HTMLDivElement | null = null;

  function injectPanel(): void {
    if (!isStarsPage()) return;
    if (panelHost?.isConnected) return;
    if (panelRoot) panelRoot.unmount();
    panelRoot = null;
    panelHost = null;
    if (document.getElementById('gsm-manager-host')) return;
    // Full-screen overlay host (kept in the light DOM for positioning); the
    // actual UI + styles live inside its shadow root.
    const host = document.createElement('div');
    host.id = 'gsm-manager-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;';

    lockPageScroll();

    const shadow = host.attachShadow({ mode: 'open' });
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

    // Theme class lives here, not on documentElement, to avoid toggling GitHub.
    const root = document.createElement('div');
    root.id = 'gsm-manager-root';
    root.style.cssText = 'width:100%;height:100%;';
    shadow.appendChild(root);

    // GitHub listens on document; retargeted input keystrokes need a shadow-boundary stop.
    shadow.addEventListener('keydown', stopEditableKeydownAtShadowBoundary);

    const main = document.querySelector('main') ?? document.querySelector('[data-pjax-container]') ?? document.body;
    main.parentElement?.insertBefore(host, main);
    panelHost = host;

    panelRoot = createRoot(root);
    panelRoot.render(
      <I18nProvider>
        <ManagerPanel />
      </I18nProvider>,
    );
  }

  // Unmount first so a half-removed host cannot leave orphaned listeners.
  function ejectPanel(): void {
    panelRoot?.unmount();
    panelRoot = null;
    panelHost?.remove();
    panelHost = null;
    unlockPageScroll();
  }

  // Vanilla shadow-root FAB shown only while the session-local panel hide is active.
  let fabHost: HTMLDivElement | null = null;
  function injectFab(): void {
    if (fabHost?.isConnected) return;
    fabHost = null;
    if (document.getElementById('gsm-fab')) return;

    const host = document.createElement('div');
    host.id = 'gsm-fab';
    host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483000;';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
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
    .btn img { display:block; width:28px; height:28px; object-fit:contain; }
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
    btn.className = 'btn';
    const brandMark = document.createElement('img');
    brandMark.src = brandMarkUrl;
    brandMark.alt = '';
    brandMark.width = 28;
    brandMark.height = 28;
    brandMark.draggable = false;
    brandMark.setAttribute('aria-hidden', 'true');
    brandMark.setAttribute('data-product-brand-mark', '');
    btn.appendChild(brandMark);
    btn.setAttribute('data-tip', 'Better GitHub Stars Manager');
    btn.setAttribute('aria-label', 'Better GitHub Stars Manager');
    btn.onclick = () => showPanel(pageWindow);
    shadow.appendChild(btn);
    document.body.appendChild(host);
    fabHost = host;

    // No React here; localize after mount and let the CSS bubble wait for data-tip.
    void authStore.getLocale()
      .then((locale) => {
        applyFabLabel(btn, locale);
      })
      .catch(() => {
        // Keep the synchronous fallback label when storage is unavailable.
      });
  }

  function ejectFab(): void {
    fabHost?.remove();
    fabHost = null;
  }

  // Drop stale async results across rapid PJAX navigations.
  let active = true;
  let syncGen = 0;
  async function sync(): Promise<void> {
    if (!active) return;
    const gen = ++syncGen;
    try {
      const [isOwn, config] = await Promise.all([isOwnStars(), authStore.getConfig()]);
      if (!active || gen !== syncGen) return; // superseded or replaced
      const state = mountState(
        isOwn,
        isPanelEnabled(config.starsPanelDefaultEnabled, pageWindow),
      );
      if (state === 'panel') {
        injectPanel();
        ejectFab();
      } else if (state === 'fab') {
        ejectPanel();
        injectFab();
      } else {
        ejectPanel();
        ejectFab();
      }
    } catch {
      if (!active || gen !== syncGen) return;
      ejectPanel();
      ejectFab();
    }
  }

  const handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !changes[CONFIG_STORAGE_KEY]) return;
    const oldCfg = changes[CONFIG_STORAGE_KEY].oldValue as
      | { starsPanelDefaultEnabled?: boolean }
      | undefined;
    const newCfg = changes[CONFIG_STORAGE_KEY].newValue as
      | { starsPanelDefaultEnabled?: boolean }
      | undefined;
    if (oldCfg?.starsPanelDefaultEnabled === newCfg?.starsPanelDefaultEnabled) return;
    resetPanelToggle(pageWindow);
    void sync();
  };

  function dispose(): void {
    if (!active) return;
    active = false;
    syncGen += 1;
    document.removeEventListener('turbo:load', sync);
    document.removeEventListener('turbo:render', sync);
    window.removeEventListener('popstate', sync);
    chrome.storage.onChanged.removeListener(handleStorageChange);
    onPanelToggle(() => {}, pageWindow);
    ejectPanel();
    ejectFab();
  }

  const runtime = { document, sync, dispose };
  pageRuntimes.set(pageWindow, runtime);
  onPanelToggle(sync, pageWindow);

  void sync();
  document.addEventListener('turbo:load', sync);
  document.addEventListener('turbo:render', sync);
  window.addEventListener('popstate', sync);
  chrome.storage.onChanged.addListener(handleStorageChange);
}

export function onExecute(): void {
  signalRecommendationEntry();
  installStarsPageRuntime(window);
}
