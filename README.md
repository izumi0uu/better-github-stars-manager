# Better GitHub Stars Manager

A Chrome extension (MV3) that turns your GitHub stars page into a searchable, taggable,
filterable management surface — built for accounts with **thousands** of starred repos.

It injects a full management UI into `github.com/{user}?tab=stars` (replacing the native
paginated card list with a virtualized table of *all* your stars) and a tag chip into
every `github.com/{owner}/{repo}` page.

> Personal-first, zero-server. No backend, no OAuth. You bring a fine-grained PAT.

---

## What it does

- **Pull all your stars** into a local IndexedDB (authenticated `/user/starred`, one request per ~100-star page).
- **Incremental sync** on every visit to the stars page (1–2 requests, stops at the last-seen cursor).
- **Full rescan** to detect unstars → soft-deleted (tombstoned) but your tags/notes are preserved.
- **Virtualized table** of all stars (no pagination, scroll smoothly through thousands of rows).
- **Filter**: by language, by tag (any/all), full-text over name/description/topics, "untagged only".
- **Sort**: by starred date, repo update date, star count, or name.
- **Tag + note** any repo inline. Tags auto-group in the sidebar by dimension — a repo's primary language lands under **Language**, its GitHub topics under **Topic**, manual tags stay ungrouped.
- **Auto-suggest tags** from each repo's `language` and `topics` (one-click or batch).
- **Persistent delete**: removing a tag drops it from every repo and keeps it gone across syncs (a tombstone blocks auto-suggest from resurrecting it) — re-add it manually to undo.
- **Cross-device sync** of your tag/notes layer via a private GitHub Gist (per-repo last-write-wins merge).
- **Tag chip** on every repo page: shows your tags, click to filter, pencil icon to edit inline.

## What it deliberately does NOT do yet

| Feature | Why deferred |
|---|---|
| **GitHub native "Lists" sync** | No public API; only DOM-automation or reverse-engineered internal endpoints (high fragility, ToS medium). Verified partial-feasible. Reserved: `Tag.gh_list_id` field + `TagStore.syncToGitHubLists()` slot. |
| **OAuth + backend** | Conflicts with zero-server personal-first scope. |
| **Star/unstar writes** | Unstar is destructive; out of scope for now. |
| **Background polling sync** | MV3 alarms ≥30min; low value for an on-demand management tool. |

---

## Install (dev / unpacked)

```bash
pnpm install
pnpm build          # outputs dist/
```

Then in Chrome:
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Click the extension icon → **Options** (or right-click → Options).
4. Create a **fine-grained PAT** at <https://github.com/settings/personal-access-tokens/new>:
   - Repository access: **All public repositories**
   - Permissions: **Account → Public Repositories (read)**, **Account → Gists (read/write)**
5. Paste the token in Options → **Save & verify**. You should see "Authenticated as @you".

> Classic tokens also work if they have `public_repo` + `gist` scopes.

## Use

1. Open `https://github.com/{you}?tab=stars` — the management panel takes over.
2. First visit: click **Sync** (or it auto-syncs incrementally). For a fresh account run **full sync** once via the popup.
3. Search `/`, filter by language/tag, click a row's tags to edit, **Auto assign tags** to bulk-apply suggestions.
4. Visit any `github.com/{owner}/{repo}` — your tag chip appears next to the repo name.
5. Use **Push** / **Pull** to sync tags across devices via Gist (auto-created on first push).

---

## Architecture

```
UI (content scripts / popup / options)
  └─ messages ──► background service worker (OWNS IndexedDB)
                    ├─ StarSource  → GET /user/starred  (GitHub API)
                    ├─ TagStore    → IndexedDB tags/tagMeta + Gist LWW sync
                    └─ query engine → filter/sort/facet, returns windows to UI
```

**Critical design decision:** all IndexedDB access lives in the background (extension
origin). Content scripts cannot share the extension's IDB (they'd see the page's origin
IDB — a different database), so the UI never touches `db` directly; it queries via
messages and the background broadcasts `dataChanged` to refresh.

Data model: three IDB stores — `stars` (GitHub metadata, rebuildable, not synced),
`tags` (your annotations, Gist-synced with per-repo timestamp conflict resolution),
`tagMeta` (tag dimension/color). Light config (encrypted token, cursors) lives in
`chrome.storage.local`.

## Verify it works

See [`docs/VERIFY.md`](docs/VERIFY.md) for the end-to-end verification checklist.

## Tech stack

Vite + CRXJS · React 18 + TypeScript · @tanstack/react-virtual · Dexie (IndexedDB) ·
Zustand · Web Crypto (token encryption).

## Run logic tests

```bash
node --experimental-strip-types tests/logic.test.ts
```
