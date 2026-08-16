# Opera Add-ons submission reference

[简体中文](../zh/opera-addons-submission.md)

This reference explains the decisions, package evidence, listing material, and manual steps required before Better GitHub Stars Manager can be submitted to Opera Add-ons. It does not claim that the current Chromium package satisfies Opera review policy or that a submission has been uploaded, reviewed, or published.

## Evidence limits

Keep these states separate:

1. **Chromium candidate**: a verified Chrome package proves its Chromium manifest and package closure, not Opera policy compliance
2. **Opera target decision**: the maintainer must approve either full feature parity or a restricted Opera build
3. **Opera smoke**: a sideloaded run proves only the exercised scenarios and platform
4. **Upload**: only the authenticated Opera upload form can accept a package
5. **Review and publication**: Opera moderators decide acceptance and publication

The README must keep Opera marked as “Coming soon” until a public listing URL is directly observed.

## Register the developer account

Opera Add-ons requires an Opera Account and an authenticated session in the extensions repository. Public documentation does not state a developer registration fee.

Before submission:

- verify the account email and publisher identity in the authenticated portal
- use a publisher name you have the right to display
- accept the current Opera Add-ons terms
- record any portal-only account or package requirement encountered during the draft

Do not infer private portal state from public documentation.

## Public URLs

Use public pages that require no authentication:

- [Project homepage](https://github.com/izumi0uu/better-github-stars-manager)
- [Browser-neutral privacy policy](https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/en/privacy-policy.md)
- [Support and issue tracker](https://github.com/izumi0uu/better-github-stars-manager/issues)

The existing policy describes direct GitHub, Gist, and AI Provider data flows. It does not resolve whether Opera moderators accept those flows under the current external-data rule.

## Choose the Opera product scope

Opera's acceptance criteria prohibit sending private data to an external store. Better GitHub Stars Manager can send private notes to the user's secret Gist and scoped task data to the AI Provider the user selects. The extension discloses these transfers and does not use a developer-operated backend, but the public Opera policy does not explain whether user-directed Gist and AI services qualify for an exception.

Choose one target before final packaging:

### Full-parity target

Keep Stars, Gist sync, Watch, Radar, Cubby, and Organize. Submit this target only after Opera gives written guidance that the user-directed transfers and controls satisfy its policy.

### Restricted local-first target

Remove every feature that sends private notes, prompts, or task data to an external store:

- disable Gist Push and Pull
- disable Cubby and Organize Provider traffic
- remove built-in AI Provider host permissions
- remove optional compatible-Provider and loopback host permissions
- update listing copy, privacy text, tests, and screenshots to match the reduced product

A restricted target is a separate product contract, not a listing-only change. Implement and verify it before packaging.

## Candidate store copy

Do not paste final copy into Opera until the product scope is approved. The full-parity candidate below matches the current shared implementation.

### Name

Better GitHub Stars Manager

### Packaged manifest description

Manage your GitHub starred repos: tag, note, filter, search across thousands of stars. UI injected into the stars page.

This is package evidence, not a submission-ready Opera summary. The final clause is a sentence fragment. If Opera derives the listing summary from the manifest, update `package.json`, rebuild the package, and rerun package verification before upload.

### Portal summary

Better GitHub Stars Manager helps you search, filter, tag, and annotate starred GitHub repositories in a local-first workspace.

Use this copy only when the authenticated Opera form exposes a separate editable summary field. Confirm the saved portal value before submission.

### Description

Better GitHub Stars Manager turns GitHub's stars page into a local-first workspace for browsing and organizing starred repositories.

The main interface appears as a searchable, virtualized repository table inside GitHub's Stars page. Its toolbar provides search plus language and tag filters, while repository rows expose tags and private notes. The popup and Options page provide setup and configuration.

Use it to:

- browse and search large star collections
- filter repositories by language and tags
- add local tags and private notes
- view optional Watch Inbox and Following activity
- sync annotations through your own secret GitHub Gist when enabled
- run Cubby through the AI service and exact origin you select when enabled

The extension sends GitHub and Gist requests directly to GitHub. Optional Cubby requests go directly to the selected AI service. The developer operates no proxy or custom backend.

The MV3 background service worker handles GitHub and optional Provider requests. Long-running Organize analysis can continue in the background and resume after worker suspension; already-approved Apply work can also resume. Tags change only after you select suggestions and choose **Apply**.

If the approved Opera target removes Gist or AI features, remove every corresponding statement before submission.

### Category

Productivity

### License

MIT License

Choose the repository's MIT license explicitly. Opera's publishing guide states that leaving the license unspecified applies a different default license.

## Package contract

Opera supports Chromium extension architecture and the `chrome.*` namespace for supported APIs. Opera has also announced that new store uploads must use Manifest V3 (MV3).

A full-parity candidate starts from the verified Chromium artifact:

```text
artifacts/better-github-stars-manager-<version>.zip
```

The ZIP root must directly contain `manifest.json`. The candidate must contain:

- `manifest_version: 3`
- a packaged MV3 background service worker
- all popup, Options, content-script, icon, and runtime assets
- no external JavaScript
- no unused development or source-only files
- only permissions required by the approved Opera target

The public Opera architecture page describes Chromium ZIP and CRX formats, but the authenticated upload form is the source of truth for the accepted file type. Do not rename a ZIP to `.crx` without validating the current form.

The repository does not yet produce a separately verified Opera target or Opera-labelled release evidence.

## Make the code reviewable

Opera's acceptance criteria reject first-party code that reviewers cannot inspect. The production Vite output is minified, so the submission must include a public, readable source path and exact reproduction instructions.

Provide one of these sources:

- an immutable Git tag that contains the exact submitted source and lockfile
- an Opera-specific reviewer source archive generated from the exact submitted commit

The Firefox reviewer source ZIP is not a substitute because its generated instructions and expected output target Firefox. An Opera source package must rebuild the submitted Opera or Chromium bytes.

Document:

- operating system used for the reproducibility check
- Node.js version
- pnpm version from `package.json`
- `pnpm install --frozen-lockfile`
- the exact target build and package commands
- the expected package name and SHA-256 checksum
- any difference between first-party source and unchanged third-party libraries

Do not include Git metadata, dependencies, build outputs, credentials, personal paths, private data, or external work-item text in a reviewer source archive.

## Prepare Opera-specific screenshots

Current Chrome screenshots use 1280×800 and exceed Opera's documented 800×600 maximum. The existing 640×400 disclosure screenshot fits the pixel bounds but does not prove the core flow in Opera.

Capture at least two screenshots in a clean Opera profile:

1. the Stars manager with search, filters, and tags
2. the Options or popup flow that matches the approved Opera product scope

Use these image requirements:

- 612×408 preferred
- 800×600 maximum
- white background where practical
- default Opera UI
- no unrelated tabs, extensions, or customizations
- no interlaced PNGs
- no personal account data, private repositories, notes, prompts, or credentials

Do not mechanically resize a Chrome screenshot and call it Opera runtime evidence.

## Review the manifest and permissions

Review the exact packaged manifest against the approved Opera target. The shared full-parity candidate currently requests:

- `storage` and `alarms`
- `https://github.com/*`
- `https://api.github.com/*`
- built-in OpenAI, OpenRouter, and Anthropic hosts
- optional `https://*/*` and loopback hosts for user-configured compatible Providers

For every permission:

- identify the visible feature that requires it
- remove it when the approved Opera target excludes that feature
- describe background actions in the listing
- ensure no `update_url`, Chrome store identifier, or browser-specific claim remains

Opera rejects redundant permissions and unnecessary manifest entries.

## Run Opera smoke coverage

Sideload the exact candidate in a clean Opera profile and test the approved feature set. At minimum:

1. open the popup and Options
2. save and verify a dedicated GitHub Classic PAT
3. load `https://github.com/your_username_here?tab=stars`
4. run Full Sync
5. verify search, filters, tags, notes, and repository chip behavior
6. exercise Watch and Radar if they remain in the Opera target
7. exercise Gist and AI disclosure only if Opera approved those data flows
8. deny optional permissions and verify unrelated features remain usable
9. suspend or reload the background runtime and verify recovery
10. inspect extension and page consoles for uncaught errors

Opera states that moderators test on Windows, macOS, and Linux. Record platform coverage honestly. A passing macOS smoke does not prove Windows or Linux behavior.

## Explain data handling without overclaiming

The listing and privacy answers must name every transfer that remains in the approved target:

- GitHub identity and repository metadata requested from GitHub
- local tags, notes, preferences, Watch records, and Cubby records
- optional annotation data sent to the user's secret Gist
- optional Cubby task data sent to the selected AI Provider
- no developer-operated proxy, analytics, advertising SDK, or custom backend

Do not claim that all data stays on the device when Gist or Cubby remains enabled. Do not claim full Opera parity until the target passes policy review and runtime smoke coverage.

## Provide reviewer credentials privately

Use dedicated, minimum-scope, revocable credentials. Keep every secret out of source files, documentation, screenshots, logs, ZIPs, and release evidence.

The full reviewer path uses a GitHub Classic PAT with:

```text
repo,gist,notifications,read:user
```

Reduce the credential scopes when the restricted Opera target removes a dependent feature. Provide AI credentials only if the approved target includes Cubby and Opera moderators request that path.

After review:

- revoke or rotate every review credential
- delete the review Gist
- remove any synthetic external data

## Submit manually

Opera does not document a developer publishing API. Plan a manual first submission and manual updates unless the authenticated portal exposes a supported workflow.

1. Sign in to the [Opera extensions repository](https://addons.opera.com/extensions/)
2. Open the [Upload Extensions form](https://addons.opera.com/developer/upload/)
3. Upload the package format accepted by the current form
4. Enter the approved name, category, license, summary, and description
5. Add the support page and public privacy policy
6. Upload Opera-specific screenshots and icons
7. Provide the exact source and build instructions requested by the form or reviewer channel
8. Review every field on the final confirmation page
9. Submit for moderation
10. Track the result under [Submitted extensions](https://addons.opera.com/developer/)

If Opera rejects the package, preserve the reviewer message outside product code and translate it into a generic product requirement. After verifying the fix, submit the corrected version through the portal path shown for that product.

## Pre-submission checklist

- [ ] an Opera Account can access the developer portal
- [ ] the maintainer approved full parity or a restricted Opera target
- [ ] written Opera guidance covers Gist and AI transfers, or those features are absent
- [ ] the exact source commit and package version are recorded
- [ ] the package uses MV3 and contains no external JavaScript
- [ ] every permission belongs to the approved target
- [ ] the submitted summary is a complete sentence; if Opera reads it from the manifest, the package was rebuilt with compliant text
- [ ] the detailed description covers UI appearance and background Organize and Apply recovery
- [ ] readable source and reproducible build instructions match the submitted bytes
- [ ] Opera-specific screenshots satisfy the documented dimensions
- [ ] the approved feature set passed a real Opera smoke test
- [ ] Windows, macOS, and Linux coverage is recorded without inference
- [ ] listing and privacy copy match the submitted target
- [ ] reviewer credentials are private and revocable
- [ ] the README still says “Coming soon” until a public listing URL is observed

## Opera official references

- [Opera extension publishing guidelines](https://help.opera.com/en/extensions/publishing-guidelines/)
- [Opera Add-ons acceptance criteria](https://help.opera.com/en/extensions/acceptance-criteria/)
- [Opera extension architecture](https://help.opera.com/en/extensions/architecture-overview/)
- [Opera extension manifest reference](https://help.opera.com/en/extensions/manifest/)
- [Opera extension API reference](https://help.opera.com/en/extensions/apis/)
- [Opera MV2 and MV3 transition statement](https://blogs.opera.com/news/2025/09/mv2-extensions-opera/)
