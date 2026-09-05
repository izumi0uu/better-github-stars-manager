import type { Tag } from '@/types';
import { authStore } from '@/auth/auth-store';
import { messageFor } from '@/i18n';
import { bgCall } from '@/utils/messaging';
import { parseRepoFromPathname } from './repo-path';
import { manualTagNames, visibleTagNames } from '@/tags/tag-model';

/**
 * Repo-page content script. Injects a tag chip beside a repo title on
 * `github.com/{owner}/{repo}`. The title region sits outside the PJAX swap
 * frame, so turbo:load/render + popstate are enough (no MutationObserver).
 */

type RepoChipInjection = {
  document: Document;
  url: string;
  repository: string;
  anchor: HTMLElement;
  el: HTMLElement;
};

type RepoChipRuntime = {
  document: Document;
  sync(): Promise<void>;
  dispose(): void;
};

const pageRuntimes = new WeakMap<Window, RepoChipRuntime>();

/**
 * Inline SVG (shadow root has no React, so lucide-react isn't available);
 * sized/styled to match the lucide set.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

function createIconSvg(name: 'check' | 'pencil'): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries({
    width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })) svg.setAttribute(key, value);
  const pathData = name === 'check'
    ? ['M20 6 9 17l-5-5']
    : ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'];
  for (const d of pathData) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function findAnchor(document: Document): { host: HTMLElement; full_name: string } | null {
  // 1. microdata anchor
  const nameA = document.querySelector<HTMLElement>('strong[itemprop="name"] a[data-pjax]');
  if (nameA) {
    const strong = nameA.closest('strong') ?? nameA.parentElement;
    if (strong) {
      // Derive owner/repo from the breadcrumb author + repo link.
      const authorA = document.querySelector<HTMLElement>('span[itemprop="author"] a');
      const owner = authorA?.textContent?.trim();
      const repo = nameA.textContent?.trim();
      if (owner && repo) return { host: strong, full_name: `${owner}/${repo}` };
    }
  }
  // 2. sr-only h1 fallback ("owner/repo")
  const h1 = document.querySelector<HTMLElement>('h1.sr-only');
  if (h1) {
    const text = h1.textContent?.trim() ?? '';
    if (text.includes('/')) return { host: h1, full_name: text };
  }
  return null;
}

function buildChip(
  document: Document,
  window: Window,
  full_name: string,
  tag: Tag | undefined,
  m = messageFor('en'),
): HTMLElement {
  const host = document.createElement('span');
  host.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-left:8px;vertical-align:middle;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .chip { display:inline-flex; align-items:center; gap:2px; font:12px/1.4 -apple-system,system-ui,sans-serif; }
    /* Black/white tag chip — follows the page's color scheme so it matches
       github.com's own light/dark mode (we don't force our panel theme here). */
    .tag { display:inline-block; padding:1px 7px; border-radius:10px; background:rgba(24,23,23,0.08); color:#181717; cursor:pointer; border:1px solid rgba(24,23,23,0.25); }
    .tag:hover { background:rgba(24,23,23,0.15); }
    .none { color:#57606a; font-style:italic; font-size:11px; }
    .edit { cursor:pointer; color:#57606a; border:1px solid #d0d7de; border-radius:4px; padding:2px; display:inline-flex; align-items:center; line-height:0; }
    .edit svg { display:block; }
    .edit:hover { color:#181717; border-color:#8c959f; }
    .editor { display:flex; gap:4px; align-items:center; }
    .editor input { font:12px monospace; padding:2px 6px; background:#ffffff; color:#181717; border:1px solid #d0d7de; border-radius:4px; width:180px; }
    .editor button { font:11px system-ui; padding:3px; background:#181717; color:#fff; border:0; border-radius:4px; cursor:pointer; display:inline-flex; align-items:center; line-height:0; }
    .editor button svg { display:block; }
    @media (prefers-color-scheme: dark) {
      .tag { background:rgba(255,255,255,0.10); color:#e6edf3; border-color:rgba(255,255,255,0.25); }
      .tag:hover { background:rgba(255,255,255,0.18); }
      .none { color:#8b949e; }
      .edit { color:#8b949e; border-color:#30363d; }
      .edit:hover { color:#e6edf3; border-color:#8b949e; }
      .editor input { background:#0d1117; color:#c9d1d9; border-color:#30363d; }
      .editor button { background:#e6edf3; color:#0d1117; }
    }
  `;
  root.appendChild(style);
  const box = document.createElement('div');
  root.appendChild(box);

  let editing = false;
  let draft = manualTagNames(tag).join(', ');

  function render() {
    const wrap = document.createElement('span');
    wrap.className = 'chip';
    if (editing) {
      const editor = document.createElement('span');
      editor.className = 'editor';
      const input = document.createElement('input');
      input.value = draft;
      input.placeholder = m.tagEditor.bulkPlaceholder;
      input.oninput = () => (draft = input.value);
      const save = document.createElement('button');
      save.replaceChildren(createIconSvg('check'));
      save.setAttribute('aria-label', 'Save');
      save.onclick = async () => {
        const tags = draft.split(',').map((t) => t.trim()).filter(Boolean);
        await bgCall('setTags', { full_name, tags });
        editing = false;
        const got = await bgCall('getTag', { full_name });
        const ts = new Date().toISOString();
        tag = got.tag ?? {
          full_name,
          manualTags: tags,
          autoTags: [],
          dismissedAutoTags: [],
          manualTagsMtime: ts,
          autoTagsMtime: ts,
          dismissedAutoTagsMtime: ts,
          notes: '',
          mtime: ts,
        };
        render();
      };
      editor.appendChild(input);
      editor.appendChild(save);
      wrap.appendChild(editor);
    } else {
      const tags = visibleTagNames(tag);
      if (tags.length === 0) {
        const none = document.createElement('span');
        none.className = 'none';
        none.textContent = m.repoChip.untagged;
        wrap.appendChild(none);
      } else {
        for (const t of tags) {
          const c = document.createElement('span');
          c.className = 'tag';
          c.textContent = t;
          c.title = m.repoChip.filterByTag(t);
          c.onclick = async () => {
            // Open the management page filtered by this tag.
            const u = await bgCall('getUsername');
            const url = u.username
              ? `https://github.com/${u.username}?tab=stars#gsm-tag=${encodeURIComponent(t)}`
              : `https://github.com/stars#gsm-tag=${encodeURIComponent(t)}`;
            window.open(url, '_blank');
          };
          wrap.appendChild(c);
        }
      }
      const edit = document.createElement('span');
      edit.className = 'edit';
      edit.replaceChildren(createIconSvg('pencil'));
      edit.setAttribute('aria-label', m.repoChip.editTags);
      edit.title = m.repoChip.editTags;
      edit.onclick = () => {
        editing = true;
        draft = manualTagNames(tag).join(', ');
        render();
      };
      wrap.appendChild(edit);
    }
    box.replaceChildren(wrap);
  }

  render();
  return host;
}

/**
 * CRXJS may execute the cached content entry again for a WindowProxy whose
 * Document changed. Keep one runtime per Window and reuse it only while its
 * exact Document is still current.
 */
export function installRepoChipRuntime(pageWindow: Window): void {
  const pageDocument = pageWindow.document;
  const existing = pageRuntimes.get(pageWindow);
  if (existing?.document === pageDocument) {
    void existing.sync();
    return;
  }
  existing?.dispose();

  const window = pageWindow;
  const document = pageDocument;
  const { location } = window;
  let active = true;
  let syncGeneration = 0;
  let injection: RepoChipInjection | null = null;

  function disposeInjection(): void {
    const current = injection;
    injection = null;
    current?.el.remove();
  }

  function targetIsCurrent(
    generation: number,
    url: string,
    repository: string,
    anchor: HTMLElement,
  ): boolean {
    if (!active || generation !== syncGeneration || pageWindow.document !== document) return false;
    if (location.href !== url) return false;
    const currentRepo = parseRepoFromPathname(location.pathname);
    if (!currentRepo || `${currentRepo.owner}/${currentRepo.repo}`.toLowerCase() !== repository) return false;
    const currentAnchor = findAnchor(document);
    return currentAnchor?.host === anchor
      && currentAnchor.full_name.toLowerCase() === repository
      && anchor.isConnected;
  }

  async function sync(): Promise<void> {
    if (!active) return;
    const generation = ++syncGeneration;
    const repo = parseRepoFromPathname(location.pathname);
    if (!repo) {
      disposeInjection();
      return;
    }

    const url = location.href;
    const repository = `${repo.owner}/${repo.repo}`.toLowerCase();
    const anchor = findAnchor(document);
    if (injection && (
      injection.document !== document
      || injection.url !== url
      || injection.repository !== repository
      || injection.anchor !== anchor?.host
      || !injection.anchor.isConnected
      || !injection.el.isConnected
      || injection.el.ownerDocument !== document
      || injection.el.parentElement !== injection.anchor.parentElement
    )) {
      disposeInjection();
    }

    if (!anchor || anchor.full_name.toLowerCase() !== repository) {
      disposeInjection();
      return;
    }
    if (injection) return;

    const m = messageFor(await authStore.getLocale());
    if (!targetIsCurrent(generation, url, repository, anchor.host)) return;
    const got = await bgCall('getTag', { full_name: anchor.full_name });
    if (!targetIsCurrent(generation, url, repository, anchor.host)) return;

    const el = buildChip(document, window, anchor.full_name, got.tag ?? undefined, m);
    anchor.host.insertAdjacentElement('afterend', el);
    injection = { document, url, repository, anchor: anchor.host, el };
  }

  function dispose(): void {
    if (!active) return;
    active = false;
    syncGeneration += 1;
    document.removeEventListener('turbo:load', sync);
    document.removeEventListener('turbo:render', sync);
    window.removeEventListener('popstate', sync);
    disposeInjection();
  }

  const runtime = { document, sync, dispose };
  pageRuntimes.set(pageWindow, runtime);
  void sync();
  document.addEventListener('turbo:load', sync);
  document.addEventListener('turbo:render', sync);
  window.addEventListener('popstate', sync);
}

export function onExecute(): void {
  installRepoChipRuntime(window);
}
