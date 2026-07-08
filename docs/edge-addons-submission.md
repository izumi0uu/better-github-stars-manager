# Microsoft Edge Add-ons Submission Checklist

This document is the Microsoft Edge Add-ons-specific submission worksheet for Better GitHub Stars Manager. Use it to fill Microsoft Partner Center fields; it is not packaged into the extension ZIP.

## Official References

- [Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension): Partner Center upload flow, Privacy page, Store listings page, screenshots, and asset fields.
- [Developer policies for the Microsoft Edge Add-ons store](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies): review policy source for disclosures, permissions, and certification expectations.
- [Best practices for extensions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/best-practices): least-privilege and extension quality guidance referenced from the Partner Center flow.

## Public URLs

- Homepage: https://github.com/izumi0uu/better-github-stars-manager
- Privacy policy: https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/privacy-policy.md
- Support/issues: https://github.com/izumi0uu/better-github-stars-manager/issues

Note: the privacy policy URL only works after `docs/privacy-policy.md` is committed and pushed to the public repository.

## Package

Microsoft Edge accepts Chromium extension packages. Use the Chrome build unless an Edge-specific manifest transform is added later.

- Build command: `pnpm build:chrome`
- Package command: `pnpm package:chrome`
- Compatibility check: `pnpm check:chrome-output`
- Capability ledger: `pnpm capability:chrome`
- Upload ZIP: `artifacts/chrome/better-github-stars-manager-<version>.zip`

Before upload, confirm the ZIP root directly contains `manifest.json`.

## Privacy Page

Partner Center's Privacy page contains these sections: Single Purpose, Permission justification, Are you using remote code?, Data usage, and Privacy policy. Microsoft states that incomplete, misleading, or inaccurate disclosures can delay certification or cause rejection.

### Single Purpose

Better GitHub Stars Manager helps users organize their own GitHub starred repositories with local search, filters, tags, notes, and optional user-controlled GitHub Gist sync.

### Permission Justification

#### `storage`

Used to store local configuration, encrypted token material, query state, and annotation data needed by the extension UI.

#### `https://github.com/*`

Used to mount the manager UI on GitHub stars pages and repository pages where the repo tag chip appears. The match pattern is broad because MV3 match patterns cannot target query strings such as `?tab=stars`, so the content script matches GitHub pages and then gates at runtime.

#### `https://api.github.com/*`

Used to authenticate the provided token, fetch the authenticated user's starred repositories, and optionally sync annotations through the user's own secret GitHub Gist.

### Remote Code

Select `No, I am not using remote code` if the submitted package matches the current codebase. Manifest V3 does not permit remotely hosted executable code, and the extension should remain self-contained.

### Data Usage

Use `docs/privacy-policy.md` as the canonical policy text. Partner Center answers should stay consistent with these statements:

- User data is used only to provide the extension's core functionality.
- Data is not sold.
- Data is not used for personalized advertising.
- Data is not used for creditworthiness or lending purposes.
- Data is not shared with third-party analytics or ad SDKs.
- Remote services contacted by the extension are limited to GitHub and the GitHub API.
- The extension stores star metadata locally and optionally stores user-created annotations in the user's own secret GitHub Gist.

### Privacy Policy URL

Paste the public `docs/privacy-policy.md` URL from this document. Microsoft says a privacy policy URL is required if the extension collects privacy information and that the policy must explain how data is collected, used, and disclosed.

## Store Listing

### Extension Name

Better GitHub Stars Manager

### Short Description

Organize GitHub stars with search, tags, notes, filters, and optional Gist sync.

### Description

Better GitHub Stars Manager upgrades GitHub's native stars page into a fast, local-first workspace for heavy stars users.

Use it to:

- load and browse large star collections in a virtualized table
- search across repository name, description, topics, and your own notes
- organize repos with custom tags and notes
- filter by language, tags, and untagged items
- sync only your annotation layer across devices through your own secret GitHub Gist

The extension works only on GitHub and uses GitHub's own APIs. It does not require a separate account or a custom backend.

## Listing Assets

Microsoft's listing docs mark Description and Extension logo as required for each language in the ZIP package. They also list a 440x280 small promotional tile, 1400x560 large promotional tile, and up to six screenshots sized 640x480 or 1280x800.

Prepared store screenshots:

- `public/store/screenshots/screenshot-main-stars.png`
- `public/store/screenshots/screenshot-options.png`
- `public/store/screenshots/screenshot-detail-panel.png`

Prepared promo assets derived from `public/poster/img_01.png`:

- `public/store/promo/small-tile.png` (`440x280`)
- `public/store/promo/marquee.png` (`1400x560`)

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
- fill Partner Center Single Purpose with the text above
- fill Partner Center permission justifications for each manifest permission and host permission
- select `No` for remote code if the package remains self-contained
- complete Data usage answers to match `docs/privacy-policy.md`
- paste the privacy policy URL from this document into Partner Center
- upload the extension logo for each listed language
- upload final screenshots that show the real stars-page UI
- provide reviewer notes that mention required GitHub token scopes
- confirm permission disclosures match the current manifest
