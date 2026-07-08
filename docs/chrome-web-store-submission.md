# Chrome Web Store Submission Checklist

This document is the Chrome Web Store-specific submission worksheet for Better GitHub Stars Manager. It is not packaged into the extension ZIP; use it to fill the Chrome Web Store Developer Dashboard and reviewer notes.

## Official References

- [Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing): Chrome listing fields, screenshots, promotional images, homepage URL, and support URL.
- [Privacy Policies](https://developer.chrome.com/docs/webstore/program-policies/privacy/): privacy policy requirements and the Developer Dashboard privacy policy URL field.
- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies): policy source for privacy, spam, disclosure, and user-data review expectations.

## Public URLs

- Homepage: https://github.com/izumi0uu/better-github-stars-manager
- Privacy policy: https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/privacy-policy.md
- Support/issues: https://github.com/izumi0uu/better-github-stars-manager/issues

Note: the privacy policy URL only works after `docs/privacy-policy.md` is committed and pushed to the public repository.

## Package

- Build command: `pnpm build:chrome`
- Package command: `pnpm package:chrome`
- Upload ZIP: `artifacts/chrome/better-github-stars-manager-<version>.zip`
- Compatibility check: `pnpm check:chrome-output`
- Capability ledger: `pnpm capability:chrome`

Before upload, confirm the ZIP root directly contains `manifest.json`.

## Listing Copy

### Store Name

Better GitHub Stars Manager

### Short Description

Organize GitHub stars with search, tags, notes, filters, and optional Gist sync.

### Detailed Description

Better GitHub Stars Manager upgrades GitHub's native stars page into a fast, local-first workspace for heavy stars users.

Use it to:

- load and browse large star collections in a virtualized table
- search across repository name, description, topics, and your own notes
- organize repos with custom tags and notes
- filter by language, tags, and untagged items
- sync only your annotation layer across devices through your own secret GitHub Gist

The extension works only on GitHub and uses GitHub's own APIs. It does not require a separate account or a custom backend.

## Category

Developer Tools

## Graphic Assets

Chrome's listing guide says the Store Listing tab includes a 128x128 store icon, at least one 1280x800 screenshot, a 440x280 small promo tile, and an optional 1400x560 marquee promo tile.

Prepared store screenshots:

- `public/store/screenshots/screenshot-main-stars.png`
- `public/store/screenshots/screenshot-options.png`
- `public/store/screenshots/screenshot-detail-panel.png`

Token tutorial images remain useful for README and onboarding, but they are not the primary store screenshots:

- `public/tutorial/img_01.png`
- `public/tutorial/img_02.png`
- `public/tutorial/img_03.png`

Prepared promo assets derived from `public/poster/img_01.png`:

- `public/store/promo/small-tile.png` (`440x280`)
- `public/store/promo/marquee.png` (`1400x560`)

## Permission Justification

### `storage`

Used to store local configuration, encrypted token material, query state, and annotation data needed by the extension UI.

### `https://github.com/*`

Used to mount the manager UI on GitHub stars pages and repository pages where the repo tag chip appears. The match pattern is broad because MV3 match patterns cannot target query strings such as `?tab=stars`, so the content script matches GitHub pages and then gates at runtime.

### `https://api.github.com/*`

Used to authenticate the provided token, fetch the authenticated user's starred repositories, and optionally sync annotations through the user's own secret GitHub Gist.

## Privacy Practices Notes

Chrome's privacy policy rules require an accurate public privacy policy when the product handles user data, and the policy link must be provided in the Developer Dashboard privacy policy field.

Use `docs/privacy-policy.md` as the canonical policy text. Dashboard answers should stay consistent with these statements:

- User data is used only to provide the extension's core functionality.
- Data is not sold.
- Data is not used for personalized advertising.
- Data is not used for creditworthiness or lending purposes.
- Data is not shared with third-party analytics or ad SDKs.
- Remote services contacted by the extension are limited to GitHub and the GitHub API.
- The extension stores star metadata locally and optionally stores user-created annotations in the user's own secret GitHub Gist.

If the dashboard asks for a Limited Use statement, reuse the language from `docs/privacy-policy.md`.

## Reviewer Test Instructions

1. Open the extension Options page.
2. Paste a GitHub fine-grained personal access token.
3. Grant `Public repositories` repository access.
4. Add `Starring: Read-only` and `Gists: Read and write` for full-feature testing.
5. Save the token and confirm the extension shows the authenticated account.
6. Open `https://github.com/{your-username}?tab=stars`.
7. Click `Sync` to import stars into the local database.
8. Verify that repositories appear, search works, and notes or tags can be added.
9. Click `Push` to create or update the dedicated secret sync Gist, then click `Pull` to fetch it back.

## Pre-Submit Checklist

- `pnpm build:chrome`
- `pnpm check:chrome-output`
- `pnpm package:chrome`
- confirm the ZIP in `artifacts/chrome/` contains `manifest.json` at its root
- confirm the public GitHub repository contains `docs/privacy-policy.md` and the URL opens without authentication
- provide a support email in the Chrome Web Store dashboard
- upload the 128x128 store icon
- upload at least one screenshot sized `1280x800`
- upload the required `440x280` small promotional image
- upload final screenshots that show the real stars-page UI
- paste the privacy policy URL from this document into the listing
- complete the privacy practices questionnaire to match the statements above
- prepare reviewer notes that mention required GitHub token scopes
- confirm the permission disclosures match the current manifest
