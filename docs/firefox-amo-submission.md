# Firefox AMO Submission Checklist

This document is the Firefox Add-ons (AMO)-specific submission worksheet for Better GitHub Stars Manager. It separates AMO review requirements from Chrome Web Store and Microsoft Edge Partner Center fields.

## Official References

- [Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/): when bundled or generated extension code requires source upload, README build instructions, lockfile, and reproducible build details.
- [Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/): AMO review policies for submissions, permissions, remote code, source review, and data transmission consent.
- [AMO Developer Hub](https://addons.mozilla.org/developers/): upload and manage listed Firefox add-ons.

## Public URLs

- Homepage: https://github.com/izumi0uu/better-github-stars-manager
- Privacy policy: https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/privacy-policy.md
- Support/issues: https://github.com/izumi0uu/better-github-stars-manager/issues

Note: the privacy policy URL only works after `docs/privacy-policy.md` is committed and pushed to the public repository.

## Package

- Build command: `pnpm build:firefox`
- Package command: `pnpm package:firefox`
- Lint command: `pnpm lint:firefox`
- Compatibility check: `pnpm check:firefox-output`
- Capability ledger: `pnpm capability:firefox`
- Upload ZIP: `artifacts/firefox/better-github-stars-manager-firefox-<version>.zip`

Before upload, confirm the ZIP root directly contains `manifest.json`.

## Listing Copy

### Name

Better GitHub Stars Manager

### Summary

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

## Source Code Submission

AMO reviewers must be able to read the extension code. Firefox's source-code guide says bundled, minified, transpiled, or generated extension code can require source upload with clear build instructions. This project uses Vite and TypeScript, so prepare a source package for every AMO version unless AMO explicitly waives it.

The source package should include:

- repository source needed to build the submitted ZIP
- `package.json`
- `pnpm-lock.yaml`
- `scripts/build-firefox-extension.mjs`
- `scripts/package-firefox-extension.mjs`
- `scripts/check-firefox-output-contracts.mjs`
- a README for reviewers with OS, Node/pnpm versions, install steps, and exact build commands

Suggested reviewer build README content:

```text
Build environment used by project:
- package manager: pnpm 10.33.2
- runtime: Node compatible with the repository's package manager and TypeScript/Vite toolchain

Commands:
pnpm install --frozen-lockfile
pnpm build:firefox
pnpm check:firefox-output
pnpm package:firefox

Expected extension directory: dist-firefox
Expected package: artifacts/firefox/better-github-stars-manager-firefox-<version>.zip
```

If reviewer build output differs from the uploaded ZIP, do not submit until the difference is explained or the build is made reproducible.

## Firefox-Specific Manifest Notes

The Firefox build converts the Chrome MV3 service worker into a Firefox-compatible background script entry and adds `browser_specific_settings.gecko`.

Current Firefox data collection declaration in `scripts/build-firefox-extension.mjs`:

- `authenticationInfo`
- `websiteActivity`
- `websiteContent`

Keep this declaration aligned with `docs/privacy-policy.md` and the AMO data collection answers.

## Permission Justification

### `storage`

Used to store local configuration, encrypted token material, query state, and annotation data needed by the extension UI.

### `https://github.com/*`

Used to mount the manager UI on GitHub stars pages and repository pages where the repo tag chip appears. The match pattern is broad because extension match patterns cannot target query strings such as `?tab=stars`, so the content script matches GitHub pages and then gates at runtime.

### `https://api.github.com/*`

Used to authenticate the provided token, fetch the authenticated user's starred repositories, and optionally sync annotations through the user's own secret GitHub Gist.

## Data Transmission And Consent Notes

AMO policy says add-ons must limit data transmission to what is necessary for functionality, disclose transmitted data, and provide consent/control unless the add-on qualifies for the applicable built-in or implicit consent path.

Use `docs/privacy-policy.md` as the canonical policy text. AMO answers should stay consistent with these statements:

- Remote services contacted by the extension are limited to GitHub and the GitHub API.
- GitHub token use is user-provided and required for authenticated GitHub API features.
- Star metadata is fetched from GitHub for local display and filtering.
- Tags and notes are local unless the user explicitly uses Push or Pull sync.
- Optional Gist sync stores annotations in the user's own secret GitHub Gist.
- No analytics SDK, ad network, third-party tracking service, or developer-operated server receives extension data.

For Firefox versions or review paths that require explicit in-product data transmission consent, the consent copy must clearly state the GitHub API/Gist transmission and the impact of declining sync.

## Reviewer Test Instructions

1. Load the submitted Firefox build.
2. Open the extension Options page.
3. Paste a GitHub fine-grained personal access token.
4. Grant `Public repositories` repository access.
5. Add `Starring: Read-only` and `Gists: Read and write` for full-feature testing.
6. Save the token and confirm the extension shows the authenticated account.
7. Open `https://github.com/{your-username}?tab=stars`.
8. Click `Sync` to import stars into the local database.
9. Verify that repositories appear, search works, and notes or tags can be added.
10. Click `Push` to create or update the dedicated secret sync Gist, then click `Pull` to fetch it back.

## Pre-Submit Checklist

- `pnpm build:firefox`
- `pnpm check:firefox-output`
- `pnpm lint:firefox`
- `pnpm package:firefox`
- confirm the ZIP in `artifacts/firefox/` contains `manifest.json` at its root
- confirm `dist-firefox/manifest.json` contains the expected `browser_specific_settings.gecko` block
- prepare a source package with `pnpm-lock.yaml` and reviewer build README
- confirm the public GitHub repository contains `docs/privacy-policy.md` and the URL opens without authentication
- paste or link the privacy policy in AMO metadata when requested
- complete AMO data collection answers to match the Firefox manifest and privacy policy
- provide reviewer notes that mention required GitHub token scopes
- confirm no remote code is loaded or executed
- confirm permission disclosures match the Firefox manifest
