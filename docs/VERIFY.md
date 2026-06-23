# Verification Checklist

End-to-end checks that the extension is a working, verifiable product. Logic-level
correctness is covered by `tests/logic.test.ts` (run with `node --experimental-strip-types tests/logic.test.ts`). The checks below verify the Chrome-runtime behavior that can only be confirmed by loading the extension.

## 0. Build & static checks (no Chrome needed)

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build` produces `dist/` with `manifest.json`, two content-script loaders, `service-worker-loader.js`, popup & options HTML
- [ ] `dist/manifest.json` has `manifest_version: 3`, `permissions: ["storage"]`, `host_permissions` for api.github.com + github.com, two content_scripts matching `https://github.com/*`
- [ ] `node --experimental-strip-types tests/logic.test.ts` → "All logic tests passed"

## 1. Load & configure

- [ ] `chrome://extensions` → Developer mode → Load unpacked → `dist/` → extension loads with no errors
- [ ] Service worker registers (click "Inspect views: service worker" → no console errors)
- [ ] Options page opens; paste a fine-grained PAT (scopes: public_repo read + gist read/write) → "Authenticated as @you"
- [ ] Token is stored encrypted: in service worker console, `chrome.storage.local.get(null)` shows `gsm_config.tokenEncrypted` (not the plaintext) and `tokenCryptoMeta`

## 2. First full sync

- [ ] Popup → "Full re-pull all stars" → progress shows "Fetching N pages…"
- [ ] For an account with thousands of stars: completes quickly (one request per ~100-star page, within the 5000/h limit)
- [ ] Service worker console: no 401/403/rate-limit errors
- [ ] IndexedDB (Application tab → IndexedDB → better-github-stars-manager → stars) shows all your starred repos

## 3. Stars management page

- [ ] Navigate to `github.com/{you}?tab=stars` → management panel renders full-screen, native GitHub list is covered
- [ ] Header shows "{filtered} / {total}" with total matching your star count
- [ ] Scroll is smooth through all rows (virtualization: only ~20 DOM rows exist at a time)
- [ ] `/` focuses the search box; typing filters name/desc/topics
- [ ] Language checkboxes in sidebar filter the list
- [ ] Sorting dropdown + ↑/↓ toggle reorders
- [ ] Click a row's tag area → inline editor → type "test, ai" → Enter → chips appear
- [ ] "untagged" checkbox shows only repos with no tags
- [ ] **⚡ Auto-tag** → applies language/topics as tags to filtered repos → chips appear
- [ ] Notes (📝) button → write a note → save → reopen shows it
- [ ] A row's data persists after reload (reload stars page → tags/notes still there)

## 4. Incremental sync

- [ ] Star a new repo on github.com in another tab
- [ ] Return to stars page → "↻ Sync" → new repo appears at top (sorted by starred desc)
- [ ] Only 1–2 API requests fired (check service worker network)

## 5. Rescan / unstar detection

- [ ] Unstar a repo on github.com
- [ ] Stars page → "⟲ Rescan" → local state refreshes cleanly with no console errors
- [ ] Re-star the same repo later → "⟲ Rescan" → any earlier tags/notes revive on that repo

## 6. Gist cross-device sync

- [ ] "⬆ Push" → a secret gist is created (check github.com/{you}?tab=gists); `gsm_config.gistId` set
- [ ] On a second machine (or second Chrome profile) with the same PAT: configure, "⬇ Pull" → tags/notes from device 1 appear
- [ ] Edit different repos on each device, push both, pull on the other → both edits merge (per-repo LWW; different repos never conflict)

## 7. Repo-page tag chip (D4)

- [ ] Navigate to `github.com/{owner}/{repo}` → tag chip appears next to the repo title (after the Public/Private label)
- [ ] Chip shows the repo's tags (or "untagged")
- [ ] Click a tag chip → opens the stars management page filtered by that tag
- [ ] ✎ button → inline edit tags on the repo page → save → chip updates; reload → persists
- [ ] Navigate between repos via GitHub links (Turbo/PJAX) → chip re-injects, no duplicates
- [ ] Navigate to a non-repo page (e.g. github.com/settings) → no chip

## 8. Turbo/navigation robustness

- [ ] Clicking around repo tabs (Code/Issues/Pulls) does not duplicate or drop the chip
- [ ] Browser back/forward re-injects the chip
- [ ] No console errors from the content scripts across navigation

---

## Known limitations

- Gist scope on fine-grained PATs is account-wide (no per-gist isolation); we mitigate by using a dedicated secret gist.
- The management panel is a full-screen overlay on the stars page (by design — replaces the native paginated UI).
- `GitHub native Lists` sync is NOT in MVP (no public API; Phase 2 only).
