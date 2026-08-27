# Microsoft Edge Add-ons submission reference

[简体中文](../zh/edge-addons-submission.md)

This reference describes the complete Microsoft Edge target for Better GitHub Stars Manager. The Edge target is a build, package, browser-proof, and store-listing identity over the shared source tree; it ships the same full product as Chrome and Firefox. This reference covers local package preparation, runtime evidence, listing copy, privacy answers, and reviewer instructions. It does not claim that a package has been uploaded, accepted, certified, reviewed, or published.

## Evidence boundaries

Keep these states separate:

1. A deterministic ZIP, checksum, and provisional evidence file prove only the local package contract.
2. A passing full-product smoke run proves only its recorded scenarios against the fingerprinted `dist-edge/` input.
3. A run under non-Edge Chromium is local contract evidence only and is never Microsoft Edge release proof.
4. An upload receipt would prove only that Partner Center accepted a draft package.
5. Only Microsoft can certify the extension, and only an observed public Microsoft Edge Add-ons URL proves publication.

Leave the README listing as **Coming soon** until the public listing URL is directly observed.

## Product contract

The Edge target keeps the complete Chrome-equivalent product:

- GitHub Stars sync, search, filters, tags, notes, favorites, and repository chips
- Watch Inbox and Following Radar
- deterministic Auto Tags
- Gist Push and Gist Pull through your own secret GitHub Gist, with the same verified create/delete probe used by Chrome
- Cubby, the local-first AI assistant, with built-in OpenAI, OpenRouter, and Anthropic Providers and user-configured custom compatible Providers
- Provider-backed full-library Organize with Review and Apply
- the popup and Options pages
- direct GitHub page and API access

Edge is a release, store, and browser identity only; it is never a product capability switch. Chrome and Firefox behavior remain unchanged. The package evidence may record the full-capability object, but the product runtime must not branch on it.

## Public URLs

Use public pages that require no authentication:

- [Project homepage](https://github.com/izumi0uu/better-github-stars-manager)
- [Support and issue tracker](https://github.com/izumi0uu/better-github-stars-manager/issues)
- [Edge privacy policy source](https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/en/edge-privacy-policy.md)

Before entering the privacy URL in Partner Center, verify that the reviewed revision is publicly retrievable without authentication. The repository file does not prove which URL or revision was entered in Partner Center.

## Store listing copy

This copy describes the current implementation. It is not evidence that Partner Center contains this text.

### Extension name

Better GitHub Stars Manager

### Short description

Organize GitHub stars with search, tags, notes, filters, Watch Inbox, optional Gist sync, and a local-first AI assistant.

### Detailed description

Better GitHub Stars Manager turns GitHub's Stars page into a local-first workspace for browsing and organizing starred repositories.

Use the Microsoft Edge edition to:

- browse large Star collections in a virtualized table
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

Choose **Developer Tools** when Partner Center offers it; otherwise choose the closest productivity category and record the saved value.

Use no more than seven search terms and 21 total words:

- GitHub stars
- repository manager
- tags
- notes
- developer tools
- Watch Inbox
- Following Radar

## Build and package contract

Build and package the Edge target independently from Chrome:

```text
pnpm build:edge
pnpm package:edge
```

Expected locations for version `<version>`:

```text
dist-edge/manifest.json
artifacts/edge/better-github-stars-manager-edge-<version>.zip
artifacts/edge/better-github-stars-manager-edge-<version>.zip.sha256
artifacts/edge/release-evidence-<version>.provisional.json
```

The ZIP root must directly contain `manifest.json`. The schema-version 4 provisional evidence must identify `browserTarget: "edge"` and record the full-capability object:

```json
{
  "gistSync": true,
  "agent": true,
  "organizeProvider": true
}
```

This object is package evidence, not a runtime switch: the product runtime must not branch on it.

The packaged manifest must equal the Chrome manifest:

- `manifest_version: 3`
- a module `background.service_worker`
- `permissions`: exactly `storage` and `alarms`
- required `host_permissions`: `https://github.com/*`, `https://api.github.com/*`
- `optional_host_permissions`: `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`
- popup, Options, content-script, icon, and web-accessible-resource paths that resolve inside the ZIP
- no `update_url` and no remote executable code

Package validation reuses the full Chrome permission and disclosure behavior, retains the remote-executable-code exclusion, and enforces the exact Edge service-worker identity baseline (reviewed path, byte count, and SHA-256 digest); a size-only ceiling is not identity approval.

Do not rename or submit the Chrome ZIP as an Edge package. Provisional evidence is not a final release approval and does not prove Partner Center state.

## Run the Edge smoke

Set `EDGE_EXECUTABLE` to the full Microsoft Edge executable path and run:

```text
EDGE_EXECUTABLE="/full/path/to/Microsoft Edge" pnpm test:smoke:edge
```

The command loads `dist-edge/` in a fresh profile and runs the shared Chromium runtime scenario set. It verifies:

- MV3 service-worker startup
- popup and Options navigation, including invalid-PAT rejection
- the full manifest permission declarations, including required Provider hosts and optional custom hosts
- the Cubby data-sharing disclosure gate before any Provider traffic
- Stars owner gating, manager injection, panel controls, responsive toolbar behavior, and the Auto Tags chooser
- Following and For You discovery, Watch stored projections, repository details, credential recovery, and return to Stars
- idempotent Turbo navigation and the repository tag chip
- bounded page/background diagnostics and no unintended GitHub API calls during guarded fixture intervals

The automated smoke does not execute Gist Push/Pull, a live Cubby Provider turn, a Provider connection test, or Organize Review/Apply. Those remain packaged product capabilities and manual reviewer scenarios; they are not runtime-verified capability claims.

The command launches only the explicitly supplied Microsoft Edge executable, reads the browser command line, rejects a `--user-agent` override, hashes the executable binary contents, and requires an observed `Edg/<version>` identity for release proof. The result includes the sanitized Edge identity, executable-binary SHA-256 digest, extension ID, verified scenario IDs, bounded diagnostic counts, package-input fingerprint, and packaged capability declarations. It excludes the executable path, credentials, request payloads, authentication headers, personal account data, and private repository content.

`EDGE_EXECUTABLE` is required for release proof. A clearly labelled non-release Chromium executable may exercise local contracts through the exported smoke helper, but the result must say `releaseProof: false` and cannot satisfy the Edge checklist.

Complete the manual reviewer path below on the same fingerprinted package for every retained feature that the automated scenarios do not execute.

## Manual reviewer path

Use a new Edge profile and synthetic or dedicated review data. On the exact full-product package:

1. Open the popup and Options page.
2. Save and verify one dedicated GitHub Classic PAT.
3. Open `https://github.com/your_username_here?tab=stars`.
4. Run Full Sync and verify search, filters, tags, notes, and favorites.
5. Open Watch and confirm the existing Classic PAT is checked without requesting a second credential. Refresh and confirm only notifications for currently starred repositories appear, with a separate informational count for watched repositories. Turn Watch off and confirm cached threads are removed while Stars remains usable.
6. Open Following Radar and verify the `read:user` capability path.
7. Use **Push** and **Pull** to verify the dedicated secret Gist sync path.
8. In Options, select the AI service and confirm the disclosure names the selected service and exact origin. Complete the explicit consent action, enter the model and dedicated AI-service key, and run **Test connection**.
9. For a custom compatible origin, use **Allow access** and verify that denying access sends no request.
10. Ask Cubby for one ordinary bounded tag change and confirm only the prompt-authorized, locally evidenced change is applied.
11. Reload after a committed turn and confirm the conversation remains available. Exercise **Retry** only after a visible retryable failure.
12. Open Cubby on two GitHub pages and start full-library Organize on one page. Confirm the second page is read-only until the owner disconnects and you explicitly choose **Take control**. Select suggestions in Review, choose **Apply**, and confirm both pages converge on the terminal receipt.
13. Delete the origin conversation and confirm the terminal Organize result remains reviewable, then choose **Dismiss**.
14. Reload the extension pages and inspect page and service-worker consoles for errors.

Record the Edge version, operating system, source commit, ZIP checksum, package-input fingerprint, and observed outcomes. Never record credentials or private content.

## Permission and privacy answers

### Single purpose

Organize GitHub starred repositories inside GitHub with local search, filters, tags, notes, Watch Inbox, Following Radar, optional Gist sync, and a local-first AI assistant.

### Permission justifications

- `storage`: stores lightweight configuration and the encrypted GitHub Classic PAT and AI-service credentials in extension storage; repository and annotation data, Watch snapshots, Cubby's bounded conversation/recovery/artifact ledger, and separately bounded Organize records remain in local IndexedDB.
- `alarms`: schedules recovery work for durable full-library Organize analysis and approved Apply operations across MV3 service-worker suspension.
- `https://github.com/*`: mounts the Stars manager and repository tag chip on GitHub pages.
- `https://api.github.com/*`: verifies the Classic PAT and serves Stars, Watch, Notifications, Following, bounded public-code search, and Gist sync paths.
- Optional AI-service hosts (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`): connect to the AI service the user configures, whether built-in or custom, because no provider origin is a required permission. Options requests access only after an explicit **Allow access** action, and the credential and request remain bound to the exact configured canonical origin, including its port. Denied optional access makes no Provider request.

### Remote code

Answer **No** only after confirming that the final ZIP contains every executable dependency and does not fetch or execute remote scripts. GitHub and Provider responses are data, not extension code.

### Data handling

Keep Partner Center declarations aligned with the [Edge privacy policy](./edge-privacy-policy.md). The Edge package processes GitHub identity and authentication, Star and watched-repository metadata, optional notification and Following activity metadata, user-created tags and notes, optional Gist annotation sync, and Cubby task data sent to the AI service you select. It does not send data to developer proxies, analytics services, or advertising services.

Do not claim that the extension handles no user data.

## Certification notes and PAT scopes

Put test credentials only in Partner Center's private certification notes. Never add them to source files, documentation, screenshots, logs, packages, or evidence.

Use a dedicated, minimum-scope, revocable GitHub Classic PAT for the complete reviewer path:

```text
repo,gist,notifications,read:user
```

`repo` and `gist` are required for the full core experience: `gist` enables the secret-Gist sync path and its verified create/delete probe. `notifications` enables the optional Watch Inbox and `read:user` enables Following Radar. Do not grant organization administration, workflow, repository deletion, key, audit-log, enterprise, package, or Webhook administration scopes. Supply dedicated AI-service credentials through the same private notes. Revoke or rotate the PAT and AI-service keys after certification activity.

## Listing assets

Partner Center assets are uploaded separately from the extension package.

| Asset | Edge plan | Repository source |
| --- | --- | --- |
| Extension logo | Inspect before upload | `public/icons/icon-128.png` |
| Screenshots | Reuse the prepared product set; regenerate and inspect before upload | `public/store/screenshots/screenshot-main-stars.png`, `screenshot-detail-panel.png`, `screenshot-agent-disclosure-light-1280x800.png`, `screenshot-agent-disclosure-dark-640x400.png` |
| Small promotional tile | Reuse the prepared tile; inspect before upload | `store-assets/promo/small-tile.png` |
| Large promotional tile | Reuse the prepared marquee; inspect before upload | `store-assets/promo/marquee.png` |

The Edge package renders the same product as Chrome, so the prepared assets depict the current product experience. Regenerate and inspect every asset before each upload; repository files do not prove upload order, locale assignment, review, or public rendering.

## Partner Center steps

The first submission remains a manual external operation:

1. Open the [Edge developer dashboard](https://partner.microsoft.com/dashboard/microsoftedge/public/login).
2. Create a new extension draft.
3. Upload the verified Edge ZIP.
4. Complete Availability and Properties.
5. Enter the listing copy and Edge privacy URL.
6. Complete the exact permission, remote-code, and data-use answers.
7. Add private reviewer instructions and the dedicated PAT and AI-service credentials.
8. Resolve every package and form validation error.
9. Submit only after the local and manual evidence is reviewed.

Record draft upload, certification, and publication as separate states. The Microsoft Update REST API is for later updates after a product exists; it cannot prove or create the first public listing.

## Pre-submission checklist

- [ ] Partner Center enrollment is verified.
- [ ] The exact source commit and Edge target are approved.
- [ ] `dist-edge/` and `artifacts/edge/` contain fresh target-specific output.
- [ ] The ZIP, checksum, provisional evidence, and package-input fingerprint agree.
- [ ] The ZIP root contains `manifest.json` and the full Chrome-equivalent permission set.
- [ ] Evidence records `browserTarget: "edge"`, the full-capability object `{gistSync: true, agent: true, organizeProvider: true}`, and the exact Edge worker identity baseline.
- [ ] A real Microsoft Edge smoke passed with explicit `EDGE_EXECUTABLE` and an observed `Edg/<version>` identity on the exact fingerprint.
- [ ] Required full-product reviewer scenarios passed on that same package.
- [ ] The Edge privacy policy is reviewed and publicly retrievable without authentication.
- [ ] Listing copy and screenshots show the complete feature set.
- [ ] The reviewer PAT includes `repo,gist,notifications,read:user`, and AI-service credentials are dedicated.
- [ ] Credentials exist only in private certification notes.
- [ ] No upload, certification, review, or publication is claimed without external evidence.
- [ ] The README remains **Coming soon** until a public listing URL is observed.

## Microsoft references

- [Register as a Microsoft Edge extension developer](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)
- [Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- [Microsoft Edge Add-ons developer policies](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)
- [Port a Chrome extension to Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension)
- [Microsoft Edge extension API support](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)
- [Use the Update REST API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)
