# Microsoft Edge Add-ons submission reference

[简体中文](../zh/edge-addons-submission.md)

This reference explains how to prepare and submit Better GitHub Stars Manager to Microsoft Edge Add-ons. It records the package, listing, privacy, test, and publication requirements without claiming that Partner Center has accepted or published a submission.

## Evidence limits

Treat each external state separately:

1. **Local package**: a deterministic Chromium ZIP, checksum, and release evidence prove only the local package structure
2. **Edge smoke**: a sideloaded run proves only the scenarios exercised in that Microsoft Edge build
3. **Partner Center draft**: an uploaded package proves only that Partner Center accepted the draft
4. **Certification**: Microsoft decides whether the extension satisfies Edge Add-ons policies
5. **Publication**: only a public Edge Add-ons listing URL proves publication

Do not replace the README placeholder until the public listing URL is directly observed.

## Register the developer account

Microsoft Edge Add-ons uses the Microsoft Partner Center. Registration requires a Microsoft account (MSA) as the Partner Center Primary Owner.

Before enrollment:

- choose **Individual** or **Company** deliberately because the account type cannot be changed after enrollment
- choose the account country or region deliberately because it becomes read-only
- reserve a publisher display name that you have the right to use
- expect additional legal and contact verification for a Company account

Microsoft states that Edge extension registration has no fee. A work or school account cannot directly enroll as the Primary Owner; link organization access after the MSA enrollment when needed.

## Public URLs

Use public pages that require no authentication:

- [Project homepage](https://github.com/izumi0uu/better-github-stars-manager)
- [Support and issue tracker](https://github.com/izumi0uu/better-github-stars-manager/issues)
- Edge-specific privacy policy: not published yet

The current browser-neutral policy describes product behavior, but Microsoft policy says the submitted privacy policy should primarily refer to Microsoft Edge. Publish and review an Edge-specific policy before submission.

## Store listing copy

The following copy describes the full current product. Partner Center content is unverified until you inspect the saved draft.

### Extension name

Better GitHub Stars Manager

### Short description

Manage your GitHub starred repos: tag, note, filter, search across thousands of stars. UI injected into the stars page.

This is the packaged description from `package.json`, passed through `manifest.config.ts`. Changing it requires a new package upload.

### Detailed description

Better GitHub Stars Manager turns GitHub's stars page into a local-first workspace for browsing and organizing starred repositories.

Use it to:

- browse large star collections in a virtualized table
- search repository names, descriptions, topics, and your notes
- organize repositories with custom tags and notes
- filter by language, tags, and untagged status
- sync only your annotation layer through your own secret GitHub Gist
- view GitHub Notifications for currently starred repositories through the optional Watch Inbox
- discover Following activity and deterministic repository recommendations
- use your own OpenAI, OpenRouter, Anthropic, or compatible AI service with Cubby

Ordinary Cubby prompts can authorize bounded tag changes. Full-library Organize freezes the library scope, prepares additive tag suggestions, and changes tags only after you select suggestions and choose **Apply**.

GitHub, Watch Inbox, and Gist requests go directly to GitHub. Optional Cubby requests go directly to the selected AI service and exact configured origin. The developer operates no proxy or custom backend.

### Suggested category

Choose Developer Tools when Partner Center offers it. Otherwise choose the closest productivity category and record the exact saved value in the release checklist.

### Suggested search terms

Use no more than seven search terms and 21 total words:

- GitHub stars
- repository manager
- tags
- notes
- developer tools
- Watch Inbox
- AI assistant

## Chromium package contract

The full-parity Edge candidate uses the same verified Chromium package as Chrome. The package must come from the exact clean release commit and must not be copied from an older artifact directory.

Expected artifact:

```text
artifacts/better-github-stars-manager-<version>.zip
```

The ZIP root must directly contain `manifest.json`. The packaged manifest must contain:

- `manifest_version: 3`
- a module `background.service_worker`
- `storage` and `alarms`
- required GitHub and built-in AI Provider host permissions
- optional host permissions for user-configured compatible providers
- popup, Options, content-script, icon, and web-accessible-resource paths that resolve inside the ZIP
- no `update_url`
- no remote executable code

Microsoft documents broad Chrome extension compatibility, but package compatibility is not runtime evidence. Review the APIs against the current Edge support list and sideload the exact package before submission.

### Restricted Edge target

A restricted Edge package is not the shared Chromium artifact. The repository currently has no `build:edge` or `package:edge` script, Edge-specific manifest transform, target-labelled package, or Edge release evidence. Until those boundaries exist and pass verification, no restricted Edge artifact exists.

If Microsoft does not approve the current AI and Gist transfers, implement the restricted target as a separate product contract before upload:

- disable Gist Push and Pull, Cubby, and Organize Provider traffic in the product, not only in listing copy
- remove built-in AI Provider hosts and optional compatible-Provider and loopback permissions from its packaged manifest
- add target-aware build, manifest, packaging, checksum, reproducibility, and release-evidence steps while keeping Chrome output unchanged
- update Edge listing copy, privacy policy, screenshots, permission answers, reviewer credentials, and smoke scenarios to match the reduced feature set
- verify the exact restricted package in Edge and run the relevant Chrome regression checks

Do not submit the shared Chrome ZIP as a restricted Edge package.

## Generate release evidence

Run the Chromium release pipeline from a clean checkout after recording the approved candidate, current public, and prior-upload versions. Follow the commands and release-evidence rules in the [Chrome Web Store submission reference](./chrome-web-store-submission.md).

Before upload, confirm:

- the final evidence names the intended source commit
- `source.dirty` is `false`
- `package.releaseReady` is `true`
- the ZIP checksum matches its `.sha256` file
- the ZIP manifest reports the approved version
- the existing Chrome package still passes its required smoke coverage

The repository does not currently publish Edge packages through CI.

## Run a real Edge smoke test

Sideload the exact `dist/` output in `edge://extensions` with Developer mode enabled. Use a new Edge profile and synthetic or dedicated review data.

Exercise these scenarios:

1. Open the popup and Options page
2. Save and verify one dedicated GitHub Classic PAT
3. Open `https://github.com/your_username_here?tab=stars`
4. Run Full Sync and verify search, filters, tags, and notes
5. Open a repository page and verify the repository tag chip
6. Enable Watch Inbox and verify the capability check and refresh flow
7. Open Following Radar and verify the `read:user` capability path
8. Accept the AI data disclosure for one Provider and exact origin
9. Test one built-in Provider and one custom Provider host-permission denial path
10. Start, review, and apply one bounded Organize job
11. Reload the extension pages and verify recovery after service-worker suspension
12. Inspect page and service-worker consoles for uncaught errors

Record the Edge version, operating system, source commit, package checksum, and observed result. Do not record credentials, authentication headers, personal account data, or private repository content.

## Prepare listing assets

Partner Center accepts assets separately from the extension package.

| Asset | Edge requirement | Repository candidate |
| --- | --- | --- |
| Extension logo | square, at least 128×128; 300×300 recommended | `public/icons/icon-128.png` |
| Small promotional tile | optional, 440×280 | `store-assets/chrome-web-store/small-promo-440x280.png` |
| Large promotional tile | optional, 1400×560 | `store-assets/promo/marquee.png` |
| Screenshots | optional, up to six; 640×480 or 1280×800 | `store-assets/chrome-web-store/*-1280x800.png` |

Inspect every uploaded image in Partner Center. Repository files do not prove upload order, locale assignment, certification, or public rendering.

## Complete the privacy page

Partner Center requires a single-purpose statement, permission justifications, remote-code answer, data-use declarations, and a privacy policy.

### Single-purpose statement

Organize GitHub starred repositories inside GitHub with local search, filters, tags, notes, optional user-controlled sync, and an optional user-configured AI assistant.

### Permission justifications

Use these facts when Partner Center asks about each packaged permission:

- `storage`: stores lightweight configuration and encrypted credentials in extension storage; bulk repository, annotation, Watch, Cubby, and Organize records remain in local IndexedDB
- `alarms`: schedules recovery for durable Organize analysis and approved Apply work after the MV3 service worker suspends
- `https://github.com/*`: mounts the Stars manager and repository tag chip on GitHub pages
- `https://api.github.com/*`: verifies the Classic PAT and serves Stars, Watch, Notifications, Following, public code search, and optional Gist sync
- built-in AI Provider hosts: tests and runs Cubby only after the user selects the Provider and accepts the disclosure
- optional `https://*/*` and loopback hosts: connects only to the exact compatible Provider origin that the user enters and explicitly allows

### Remote code answer

Answer **No** only after confirming the final ZIP contains every executable dependency and does not fetch or execute remote scripts. Provider responses are data, not extension code.

### Data handling

Select every current Partner Center data category that matches the shipped behavior. Include local processing where the form requires it. Keep the answers aligned with:

- GitHub account identity and Classic PAT authentication
- starred-repository, watched-repository, and notification metadata
- tags and private notes
- optional secret Gist sync
- optional Cubby prompts, scoped repository metadata, code snippets, notes, and Provider responses
- local conversation, recovery, artifact, and Organize records

Do not claim that the extension handles no user data.

## Resolve Edge-specific policy blockers

Microsoft's policy requires explicit opt-in before third-party sharing and an in-product way to rescind that permission. The extension already gates Provider traffic on a Provider-and-origin disclosure acceptance, but the current UI does not expose a dedicated revocation control.

Opt-in and revocation are necessary but not sufficient. The public policy also limits third-party sharing to specified permitted purposes, and it does not clearly confirm that user-selected AI inference or secret Gist sync fits that limit. Obtain written Microsoft guidance for both flows. If guidance is unavailable, implement and verify the restricted Edge target above before upload; the current shared Chrome ZIP is not a fallback.

Before submission:

- publish an Edge-specific privacy policy that primarily refers to Microsoft Edge
- add an explicit control such as **Disable AI sharing** or **Revoke consent**
- stop all later Provider traffic when the user revokes consent
- keep Stars, Watch, Radar, local organization, and GitHub API features available
- document how users disable Gist sync and remove the secret Gist
- verify the packaged behavior matches the policy and Partner Center answers

Treat these items as submission blockers, not listing polish.

## Provide certification notes

Store test credentials only in Partner Center's private certification notes. Never add credentials to source files, documentation, screenshots, logs, ZIPs, or release evidence.

Use a dedicated, minimum-scope, revocable GitHub Classic PAT for the full reviewer path:

```text
repo,gist,notifications,read:user
```

Explain which scopes enable optional Watch Inbox and Following Radar behavior. Provide a dedicated AI Provider credential only when certification needs to exercise Cubby. Revoke or rotate every credential and delete the review Gist after certification.

For a restricted Edge target, omit AI credentials and the `gist` scope unless another approved feature requires them.

## Submit through Partner Center

Complete the first submission manually:

1. Open the [Edge developer dashboard](https://partner.microsoft.com/dashboard/microsoftedge/public/login)
2. Choose **Create new extension**
3. Upload the verified package for the approved Edge target
4. Set visibility and markets under **Availability**
5. Complete category, website, support, and mature-content fields under **Properties**
6. Complete the single purpose, permissions, remote code, data use, and privacy policy under **Privacy**
7. Complete every language under **Store listings**
8. Add private test steps under **Notes for certification**
9. Resolve every package and form validation error
10. Submit the draft for certification

Record upload, certification, and publication as separate external states.

## Automate later updates only

Microsoft's Update REST API can upload and publish package updates after the first product exists. It cannot create a new product or update listing metadata.

Do not add API credentials until the first listing is published and the manual fields are verified. Store the Client ID and API key as repository secrets, never in tracked files.

## Pre-submission checklist

- [ ] Partner Center enrollment is verified
- [ ] the exact source commit is clean and approved
- [ ] the Chromium release gate produced a fresh final ZIP
- [ ] the ZIP root contains `manifest.json`
- [ ] the package contains no `update_url` or remote executable code
- [ ] a real Edge smoke test passed on the exact package
- [ ] an Edge-specific privacy policy is public without authentication
- [ ] explicit AI opt-in and revocation controls are present and tested
- [ ] written Microsoft guidance covers AI and Gist transfers, or a restricted Edge target is implemented and verified
- [ ] any restricted target has its own build, manifest transform, package, release evidence, listing, privacy, and smoke proof
- [ ] permission and data answers match the final manifest and policy
- [ ] listing copy and images match the shipped product
- [ ] reviewer credentials exist only in private certification notes
- [ ] the README still says “Coming soon” until the public listing URL is observed

## Microsoft official references

- [Register as a Microsoft Edge extension developer](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)
- [Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- [Microsoft Edge Add-ons developer policies](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)
- [Port a Chrome extension to Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension)
- [Microsoft Edge extension API support](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)
- [Use the Update REST API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)
