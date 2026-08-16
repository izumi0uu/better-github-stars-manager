# Firefox Add-ons (AMO) submission reference

[简体中文](../zh/firefox-amo-submission.md)

This reference collects the Firefox Add-ons (AMO) listing copy, the packaged Firefox manifest contract, data-collection answers, reviewer build instructions, and the local release evidence for Better GitHub Stars Manager. It does not claim that a package is uploaded, signed, under review, approved, or published.

## Evidence limits

Local preparation and this document do not upload, sign, submit for review, obtain approval, or publish anything:

1. **Local package**: the deterministic Firefox ZIP, checksum, reviewer source package, and evidence prove only local package structure and reproducibility
2. **Upload**: only the AMO Developer Hub accepts the package for a submission
3. **Signing**: AMO signs distributed packages; no local step signs a package
4. **Review and approval**: only AMO reviewers decide reviewability and approval
5. **Publication**: only AMO changes the listing state; the README keeps the Firefox entry as “Coming soon” until an AMO listing URL is directly observed

None of these states implies a later state.

## Public URLs

- [Project homepage](https://github.com/izumi0uu/better-github-stars-manager)
- [Privacy policy](https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/en/privacy-policy.md)
- [Support and issue tracker](https://github.com/izumi0uu/better-github-stars-manager/issues)

The privacy URL is usable only after the reviewed policy is public and retrievable without authentication.

## Store listing copy

This copy describes the current implementation. It is not evidence that AMO contains this text.

### Name

Better GitHub Stars Manager

### Summary

Organize GitHub stars with search, tags, notes, filters, Watch Inbox, optional Gist sync, and a local-first AI assistant.

### Detailed description

Better GitHub Stars Manager turns GitHub's stars page into a local-first workspace for browsing and organizing starred repositories.

Use it to:

- browse large star collections in a virtualized table
- search repository names, descriptions, topics, and your notes
- organize repositories with custom tags and notes
- filter by language, tags, and untagged status
- sync only your annotation layer through your own secret GitHub Gist
- view GitHub Notifications for currently starred repositories through the optional Watch Inbox, with a separate informational count for watched repositories
- use your own OpenAI, OpenRouter, Anthropic, or compatible AI service with Cubby

Ordinary Cubby prompts can authorize bounded tag changes. Every write remains limited by current-turn local evidence, operation limits, and the current write policy.

Full-library Organize is a separate workflow. It freezes the library scope, prepares additive tag suggestions, lets you select suggestions in Review, and changes tags only when you choose **Apply**.

GitHub, Watch Inbox, and Gist requests go directly to GitHub. Optional Cubby requests go directly to the selected AI service and exact configured origin. The developer operates no proxy or custom backend.

### Suggested category

Developer Tools

## Packaged Firefox manifest contract

The Firefox production output is derived from the exact current Chrome production inventory; only browser-specific manifest fields change. The packaged manifest:

- `manifest_version`: 3
- background: a module `background.scripts` entry, with no `background.service_worker`
- `browser_specific_settings.gecko.id`: `{5aeb7340-40e6-428d-9566-f3cacbe06352}` — permanent add-on ID; never change it and never reuse it for a different add-on
- `browser_specific_settings.gecko.strict_min_version`: `140.0`
- required permissions: `storage`, `alarms`
- required host permissions: `https://github.com/*`, `https://api.github.com/*`, `https://api.openai.com/*`, `https://openrouter.ai/*`, `https://api.anthropic.com/*`
- optional host permissions: `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`
- required data-collection permissions: `authenticationInfo`, `websiteActivity`, `websiteContent`
- optional data-collection permission: `personalCommunications`
- content scripts match `https://github.com/*` (stars page and repository chip)

The ZIP root must directly contain `manifest.json`. Chrome-only keys are rejected from the Firefox artifact.

## Data collection answers

Required categories:

| Category | Product meaning |
| --- | --- |
| `authenticationInfo` | GitHub account identity and the encrypted Classic PAT used for authenticated GitHub API requests |
| `websiteActivity` | Activity on the GitHub pages the extension manages: starred-repository metadata, watched-repository membership, and optional notification metadata |
| `websiteContent` | Page content the extension reads and updates: repository pages, the stars table, tags, and notes |

Optional category:

| Category | Product meaning |
| --- | --- |
| `personalCommunications` | Cubby conversation messages and task data sent to the AI service you select |

Consent and control:

- One explicit disclosure action records the versioned acceptance of the selected provider and exact origin before any provider traffic
- On Firefox, the same user action first requests `chrome.permissions.request({ data_collection: ['personalCommunications'] })`, and acceptance is recorded only when granted
- Firefox checks `chrome.permissions.contains({ data_collection: ['personalCommunications'] })` before provider traffic; Chrome treats the Firefox-only permission as not applicable
- Declining or revoking the permission disables only Agent/Cubby Provider traffic; Stars, sync, Watch, Radar, local organization, and GitHub API use remain usable
- Host-access controls are independent of the data-collection permission; granting or denying one does not grant or deny the other

## Remote code policy

- The extension ships no remote executable code: all runtime code is bundled and version-pinned in the ZIP by the local build
- The extension never loads or executes code from a remote URL
- Release evidence includes an explicit remote-executable-code exclusion proof

## Reviewed `web-ext` warnings

`pnpm lint:firefox` runs the pinned `web-ext@10.6.0` linter and accepts exactly five reviewed warnings. Any error, notice, new warning, missing warning, changed warning owner, or changed warning text fails the command.

- One `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` warning belongs to `manifest.json`. This release is desktop-only because it does not declare `browser_specific_settings.gecko_android`. Firefox Desktop 140 supports the declared data-collection permissions; Firefox for Android support is outside this release. Adding Android support requires a separately validated Android minimum of at least 142.
- Two `UNSAFE_VAR_ASSIGNMENT` warnings in `assets/recommendation-entry-*.js` come from the pinned React DOM 18.3.1 renderer. Repository-owned `src/` code contains no `innerHTML` assignment, `document.write`, or `dangerouslySetInnerHTML` sink.
- Two `UNSAFE_VAR_ASSIGNMENT` warnings in `assets/mermaid-*.js` come from the pinned `streamdown@2.5.0` dependency and its `mermaid@11.16.0` renderer. Mermaid retains its default `securityLevel: 'strict'` sanitization and bundled DOMPurify; repository-owned code does not call those sinks directly.

These warnings do not waive the remote-code policy. The release packager separately rejects remote executable-code patterns and the lint gate rejects any warning outside this exact reviewed set.

## Artifact inventory

Build output root: `dist-firefox/`. Release artifacts: `artifacts/firefox/`. Replace `<version>` with the exact approved release version.

| Artifact | Meaning |
| --- | --- |
| `better-github-stars-manager-firefox-<version>.zip` | extension package with `manifest.json` at the ZIP root |
| `better-github-stars-manager-firefox-<version>.zip.sha256` | extension package checksum |
| `release-evidence-<version>.provisional.json` | immutable provisional evidence labelled `browserTarget: 'firefox'`, still `releaseReady: false` |
| `release-evidence-<version>.json` | final release evidence |
| `agent-release-gate-evidence.json` | release-gate evidence |
| `better-github-stars-manager-firefox-<version>-source.zip` | reviewer source package |
| `better-github-stars-manager-firefox-<version>-source.zip.sha256` | reviewer source package checksum |

The deterministic inventory, ZIP, and checksum logic is shared with the Chrome target. `web-ext build` is not the release packager; `web-ext lint` is an additional Firefox validation only.

## Reviewer build instructions

Environment:

- package manager: pnpm 10.33.2 (the repository `packageManager` field)
- Node 24.10.0 was used for the reproducibility proof; the pinned `web-ext` tool requires Node 20 or later
- `web-ext` pinned exactly at `10.6.0` as a devDependency, invoked through pnpm only (never `pnpm dlx` or `npx`)

Commands:

```sh
pnpm install --frozen-lockfile
pnpm build:firefox
pnpm check:firefox-output
pnpm lint:firefox
GSM_APPROVED_RELEASE_VERSION=<version> pnpm package:firefox
FIREFOX_EXECUTABLE=/path/to/current/firefox pnpm test:smoke:firefox
FIREFOX_140_EXECUTABLE=/path/to/firefox-140 \
FIREFOX_STABLE_EXECUTABLE=/path/to/current/firefox \
pnpm test:verify-firefox
```

- `build:firefox` produces `dist-firefox/` with the transformed manifest
- `check:firefox-output` validates the Firefox manifest fields and required entry files; `package:firefox` enforces complete manifest-resource closure and rejects Chrome-only or development residue
- `lint:firefox` runs the pinned `web-ext@10.6.0` lint
- `package:firefox` requires the explicitly approved package version, then emits the extension ZIP, checksum, provisional evidence, and reviewer source package in `artifacts/firefox/`
- `test:smoke:firefox` runs the shared runtime smoke against `FIREFOX_EXECUTABLE` with the current pinned Puppeteer driver
- `test:verify-firefox` requires the explicit `FIREFOX_140_EXECUTABLE` and `FIREFOX_STABLE_EXECUTABLE` roles for dual-version evidence. The Firefox 140 role uses the repository-pinned `puppeteer-firefox-140` alias because current Puppeteer no longer supports Firefox 140. Never claim Firefox 140 ran unless the executed binary reports version 140.x.

Expected results: `artifacts/firefox/better-github-stars-manager-firefox-<version>.zip`, its `.zip.sha256`, the reviewer source ZIP, and its checksum. Verify the ZIP root contains `manifest.json` and that `dist-firefox/manifest.json` contains the Gecko block above.

The reviewer source ZIP contains clean tracked build inputs, the lockfile, and a generated reviewer README with the exact Node/pnpm commands above. It contains no tokens, account data, build output, personal paths, external work-item text, or VCS metadata. The tracked `scripts/deterministic-zip.mjs` writer produces both ZIPs with fixed metadata, and Node.js `node:crypto` creates and verifies their SHA-256 sidecars; the build does not depend on host `zip`, `unzip`, or checksum utilities. If reviewer build output differs from the uploaded ZIP, do not submit until the difference is explained or the build is made reproducible.

## Version approval prerequisite

Before final local verification, record the explicitly approved package version and the directly observed current-public and prior-upload versions for the release decision. `GSM_VERSION_APPROVAL` must be JSON with exactly `approvedCandidateVersion`, `observedCurrentPublicVersion`, and `observedPriorUploadVersion`. The candidate must equal `package.json` and be strictly newer than both observed versions. Missing, extra, stale, or invented values fail closed.

## Local release pipeline

Run the final pipeline only from the exact intended source after it has been committed cleanly. Start with a fresh `artifacts/firefox/` directory; a prior standalone `package:firefox` run is package-inspection evidence, not reusable finalization input.

Replace every angle-bracket placeholder with a release-specific observed value or executable path, then run:

```sh
export GSM_PACKAGE_TARGET=firefox
export GSM_BROWSER_TARGET=firefox
export GSM_VERSION_APPROVAL='{"approvedCandidateVersion":"<version>","observedCurrentPublicVersion":"<observed-version>","observedPriorUploadVersion":"<observed-version>"}'
export FIREFOX_140_EXECUTABLE=/path/to/firefox-140
export FIREFOX_STABLE_EXECUTABLE=/path/to/current/firefox
export PUPPETEER_HEADLESS=true
pnpm verify:agent-runtime
pnpm verify:agent-release-gates
```

The runtime verifier runs the complete Vitest and regression suites, the production Firefox build, runtime/extension scenarios, the stable-browser smoke, the distinct Firefox 140 and stable matrix, package-input stability checks, and deterministic Firefox packaging. Runtime evidence records SHA-256 executable identities rather than local executable paths. The release-gate verifier consumes those unchanged artifacts, writes final evidence, then writes the gate marker; it does not rebuild or mutate provisional evidence.

Neither command uploads, signs, submits, publishes, or proves AMO review state. Live reviewer credentials, AMO form values, upload, signing, review, listing visibility, and cleanup remain manual observations.

## Permission explanations

### `storage`

Provides the host browser's extension-storage area (`chrome.storage.local`) for lightweight configuration and the encrypted GitHub Classic PAT and AI-service credentials, plus query or UI state. Star and annotation data, Watch snapshots, Cubby's bounded conversation/recovery/artifact ledger, and separately bounded Organize records use extension-local IndexedDB. A transient `chrome.storage.session` value routes Watch recovery to the relevant Options section and is consumed immediately.

### `alarms`

Schedules recovery work for durable full-library Organize analysis and approved Apply operations after the Firefox event-page background script suspends. The extension creates and clears named alarms as work becomes recoverable or settles.

### `https://github.com/*`

Mounts the manager on GitHub stars and repository pages. Manifest match patterns cannot target a query string such as `?tab=stars`, so the content script matches GitHub pages and gates its behavior at runtime.

### `https://api.github.com/*`

Authenticates the provided token, fetches starred and watched repositories, fetches Notifications only after Watch Inbox is enabled, performs requested bounded public-code search, and syncs annotations through the user's own secret Gist.

### `https://api.openai.com/*`, `https://openrouter.ai/*`, `https://api.anthropic.com/*`

Allow a user who configures OpenAI, OpenRouter, or Anthropic to test the connection and run Cubby directly against that service.

### Optional custom AI-service hosts

`https://*/*`, `http://localhost/*`, and `http://127.0.0.1/*` are optional host permissions because a custom compatible origin is not known at install time. Options requests access only after an explicit **Allow access** action, and the credential and request remain bound to the exact configured canonical origin, including its port. Denied optional access makes no Provider request.

### Data-collection permissions

See [Data collection answers](#data-collection-answers). `authenticationInfo`, `websiteActivity`, and `websiteContent` are required; `personalCommunications` is optional and requested only inside the explicit Cubby consent action.

## Reviewer evidence inventory

Before submission, collect and reconcile:

- package-input fingerprint inventory for the Firefox target
- manifest closure validation against the module `background.scripts` entry
- ZIP-root `manifest.json` and resource closure
- extension and source-package checksums (`.sha256`)
- provisional and final evidence labelled `browserTarget: 'firefox'` with event-page background identity
- remote-executable-code exclusion proof
- reviewer-source artifact evidence
- Firefox runtime smoke and release-verification evidence, containing bounded facts only (no credentials, authentication headers, or raw Provider request and response bodies)

## Reviewer test instructions

Use a dedicated, least-privilege, revocable GitHub **Classic PAT** and AI-service credentials, and provide them to AMO only through the private reviewer notes channel. Never commit credentials to source, Markdown, screenshots, logs, ZIP files, or evidence.

The review PAT uses the current product scope set:

```text
repo,gist,notifications,read:user
```

`repo` and `gist` are required for the full core experience. `notifications` enables Watch Inbox and `read:user` enables Following Radar; omitting either must leave unrelated features usable. Do not grant organization administration, workflow, repository deletion, key, audit-log, enterprise, package, or Webhook administration scopes.

1. Install the submitted ZIP in a fresh Firefox profile. Confirm that Firefox identifies the extension by the permanent ID `{5aeb7340-40e6-428d-9566-f3cacbe06352}`. Extension pages use a profile-generated `moz-extension://<runtime-uuid>/...` origin; the runtime UUID is not the permanent Gecko ID.
2. Open Options, paste the dedicated Classic PAT, and select **Save & verify**; confirm the authenticated account appears.
3. Open `https://github.com/<your-username>?tab=stars`, run **Full Sync**, and verify stars, search, filters, notes, and manual tags work locally.
4. Open **Watch** and confirm the existing Classic PAT is checked without requesting a second credential; refresh and confirm only notifications for currently starred repositories appear, with a separate informational count for watched repositories. Turn Watch off and confirm cached threads are removed while Stars remains usable.
5. Open **Following Radar** and confirm it loads with `read:user`; omit that capability only in a separate negative test if needed.
6. Use **Push** and **Pull** to verify the dedicated secret Gist sync path.
7. In Options, select the AI service, confirm the disclosure names the selected service and exact origin, then click the explicit consent action. On Firefox this first prompts for the optional `personalCommunications` data permission; confirm the prompt names only that category.
8. Enter the model and dedicated AI-service key from reviewer notes, run **Test connection**, and confirm a bounded Cubby task uses only the selected provider.
9. Negative consent: in a fresh profile, deny the `personalCommunications` prompt. Confirm Stars, sync, Watch, Radar, and local organization remain usable, no Provider request is sent, and no disclosure acceptance is recorded.
10. For a custom compatible origin, use **Allow access** (a host permission, separate from the data permission) and verify that denying access sends no request.
11. Ask Cubby for one ordinary bounded tag change and confirm only the prompt-authorized, locally evidenced change is applied.
12. Reload after a committed turn and confirm the conversation remains available. Exercise **Retry** only after a visible retryable failure.
13. Clear the re-fetchable tool cache in Options and confirm final answers and conversation history remain.
14. Open Cubby on two GitHub pages and start full-library Organize on one page; confirm the second page is read-only until the owner disconnects and you explicitly choose **Take control**. Select suggestions in Review, choose **Apply**, and confirm both pages converge on the terminal receipt.
15. Delete the origin conversation and confirm the terminal Organize result remains reviewable, then choose **Dismiss**.
16. Confirm requests target the selected origin. Inspect release diagnostics and evidence for bounded facts only, with no credentials, authentication headers, or raw Provider request and response bodies.
17. Delete the dedicated review Gist and revoke or rotate all reviewer credentials after review.

Do not place credential values or cleanup secrets in this document.

## Pre-submit checklist

- `pnpm build:firefox` succeeds, and `dist-firefox/manifest.json` contains the Gecko block and `background.scripts` with no `background.service_worker`
- `pnpm check:firefox-output`, `pnpm lint:firefox` (pinned `web-ext@10.6.0`, exactly five reviewed warnings and no errors/notices), and `pnpm package:firefox` succeed
- `pnpm test:smoke:firefox` and `pnpm test:verify-firefox` pass on the executed Firefox version; Firefox 140 proof requires a binary reporting version 140.x
- ZIP root directly contains `manifest.json`
- extension and reviewer-source checksums match the generated `.sha256` files
- reviewer source package contains the lockfile and reviewer README and rebuilds the ZIP
- the public repository contains the reviewed privacy policy, and the URL opens without authentication
- AMO data-collection answers match the packaged manifest and the privacy policy
- remote-code answer is “none”: the package loads no remote executable code
- permission justifications match the packaged manifest
- reviewer notes name the required GitHub token scopes and carry dedicated credentials only through the private channel
- README still shows Firefox as “Coming soon”; replace it only after an AMO listing URL is directly observed

## Official Mozilla references

- [Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)
- [Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
- [AMO Developer Hub](https://addons.mozilla.org/developers/)
