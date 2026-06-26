import type { Tag } from '@/types';
import { authStore } from '@/auth/auth-store';
import { messageFor } from '@/i18n';
import { bgCall } from '@/utils/messaging';

/**
 * Repo-page content script. Injects a tag chip beside a repo title on
 * `github.com/{owner}/{repo}`. The title region sits outside the PJAX swap
 * frame, so turbo:load/render + popstate are enough (no MutationObserver).
 */

const injected = new Map<string, { el: HTMLElement; rerender: () => void }>(); // url → host element, for idempotency

/**
 * Inline SVG (shadow root has no React, so lucide-react isn't available);
 * sized/styled to match the lucide set.
 */
function iconSvg(name: 'check' | 'pencil'): string {
  const common = 'width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (name === 'check') return `<svg ${common}><path d="M20 6 9 17l-5-5"/></svg>`;
  return `<svg ${common}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
}

function parseRepoFromUrl(): { owner: string; repo: string } | null {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\/|$)/);
  if (!m) return null;
  const [, owner, repo] = m;
  // Exclude non-repo top-level paths.
  const exclude = new Set(['settings', 'orgs', 'users', 'search', 'explore', 'notifications', 'login', 'signup', 'stars', 'dashboard', 'marketplace', 'pulls', 'issues', 'trending', 'collections', 'topics', 'events', 'sponsors', 'about', 'features', 'security', 'customer-stories', 'readme', 'enterprise', 'team', 'pricing', 'site', 'resources', 'apps', 'developer', 'copilot', 'freecoursecenter', 'forks', 'network', 'graphs']);
  if (exclude.has(owner)) return null;
  if (repo.includes('.')) return null; // e.g. /about.html — not a repo
  return { owner, repo };
}

function findAnchor(): { host: HTMLElement; full_name: string } | null {
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

function buildChip(full_name: string, tag: Tag | undefined, m = messageFor('en')): { el: HTMLElement; rerender: () => void } {
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
  let draft = (tag?.tags ?? []).join(', ');

  function render() {
    box.innerHTML = '';
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
      save.innerHTML = iconSvg('check');
      save.setAttribute('aria-label', 'Save');
      save.onclick = async () => {
        const tags = draft.split(',').map((t) => t.trim()).filter(Boolean);
        await bgCall('setTags', { full_name, tags });
        editing = false;
        const got = await bgCall<{ tag: Tag | null }>('getTag', { full_name });
        tag = got.tag ?? { full_name, tags, notes: '', mtime: new Date().toISOString() };
        render();
      };
      editor.appendChild(input);
      editor.appendChild(save);
      wrap.appendChild(editor);
    } else {
      const tags = tag?.tags ?? [];
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
            const u = await bgCall<{ username: string | null }>('getUsername');
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
      edit.innerHTML = iconSvg('pencil');
      edit.setAttribute('aria-label', m.repoChip.editTags);
      edit.title = m.repoChip.editTags;
      edit.onclick = () => {
        editing = true;
        draft = (tag?.tags ?? []).join(', ');
        render();
      };
      wrap.appendChild(edit);
    }
    box.appendChild(wrap);
  }

  return { el: host, rerender: render };
}

async function inject() {
  const repo = parseRepoFromUrl();
  if (!repo) return cleanup();
  const anchor = findAnchor();
  if (!anchor) return; // not a repo page (yet)

  const url = location.href;
  // Idempotent: if we already injected for this URL, skip.
  if (injected.has(url)) return;

  const m = messageFor(await authStore.getLocale());
  const got = await bgCall<{ tag: Tag | null }>('getTag', { full_name: anchor.full_name });
  const { el, rerender } = buildChip(anchor.full_name, got.tag ?? undefined, m);
  anchor.host.insertAdjacentElement('afterend', el);
  injected.set(url, { el, rerender });
}

function cleanup() {
  // Remove chips when navigating away from repo pages.
  for (const [url, entry] of injected) {
    if (!location.pathname.match(/^\/[^/]+\/[^/]+/)) {
      entry.el.remove();
      injected.delete(url);
    }
  }
}

// Initial + Turbo/PJAX re-injection. No MutationObserver is needed because the
// title area sits outside the swap frame.
inject();
document.addEventListener('turbo:load', inject);
document.addEventListener('turbo:render', inject);
window.addEventListener('popstate', inject);
