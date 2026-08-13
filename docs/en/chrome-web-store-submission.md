# Chrome Web Store update notes

[简体中文](../zh/chrome-web-store-submission.md)

This reference collects candidate listing copy, manifest-derived permission justifications, reviewer steps, and external Chrome Web Store work. It does not claim that a package is release-ready, uploaded, under review, or published.

## Current update status

The public item is already version `1.0.8`. This work is an update, not a first submission. Google requires each uploaded update to contain the complete package and a version larger than the published version.

The user explicitly approved `1.0.9` as the candidate version. The repository package and generated manifest now use `1.0.9`; the clean runtime, package, and final verification gates have not yet passed at this point in the record.

Keep these evidence states separate:

1. **Controlled source**: source review and controlled Provider fixtures can prove local contracts
2. **Strict adapters**: focused tests can prove OpenAI Responses, OpenAI-compatible and OpenRouter streaming, Anthropic Messages, registry, and error contracts
3. **Live credentials**: dedicated GitHub and AI-service credentials require a separate manual check
4. **Clean local package**: a clean ZIP and release evidence can prove local package structure and checksums
5. **Dashboard and publication**: upload, dashboard values, review, approval, publication, and installed-store behavior require direct external evidence

None of these states implies a later state. Local evidence must keep `dashboardSubmissionClaimed: false`.

Google documents the update flow in [Update your Chrome Web Store item](https://developer.chrome.com/docs/webstore/update). Upload, review, and publication remain separate external states whether work is performed in the Dashboard or through an enabled API workflow.

## Public URLs

- [Project homepage](https://github.com/izumi0uu/better-github-stars-manager)
- [Candidate privacy policy](https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/en/privacy-policy.md)
- [Support and issue tracker](https://github.com/izumi0uu/better-github-stars-manager/issues)

The privacy URL is usable only after the reviewed policy is public and retrievable without authentication. Dashboard values and the public listing, privacy display, promo assets, and installed version must be checked manually.

Historical observation from the Phase 8 fact sheet: the public item showed `1.0.8`, its privacy URL served older policy text, and its public privacy display did not describe current Cubby, Gist, and Provider processing. Treat this as dated audit evidence, not proof of the current dashboard or public state.

## Candidate listing copy

The candidate copy describes the current implementation. It is not evidence that the dashboard contains this text.

### Store name

Better GitHub Stars Manager

### Short description

Organize GitHub stars with search, tags, notes, filters, Watch Inbox, optional Gist sync, and a local-first AI assistant.

### Detailed description

Better GitHub Stars Manager turns GitHub's stars page into a local-first workspace for browsing and organizing starred repositories.

Use it to:

- browse large star collections in a virtualized table
- search repository names, descriptions, topics, and your notes
- organize repositories with custom tags and notes
- filter by language, tags, and untagged status
- sync only your annotation layer through your own secret GitHub Gist
- view GitHub Notifications for currently starred repositories you watch through the optional Watch Inbox
- use your own OpenAI, OpenRouter, Anthropic, or compatible AI service with Cubby

Ordinary Cubby prompts can authorize bounded tag changes. Every write remains limited by current-turn local evidence, operation limits, and the current write policy.

Full-library Organize is a separate workflow. It freezes the library scope, prepares additive tag suggestions, lets you select suggestions in Review, and changes tags only when you choose **Apply**.

GitHub, Watch Inbox, and Gist requests go directly to GitHub. Optional Cubby requests go directly to the selected AI service and exact configured origin. The developer operates no proxy or custom backend.

### Suggested category

Developer Tools

## Local asset inventory

The Phase 8 source inventory observed the following local files and dimensions. This does not prove dashboard upload, ordering, review, or public display.

Prepared screenshots:

- `public/store/screenshots/screenshot-main-stars.png`
- `public/store/screenshots/screenshot-detail-panel.png`
- `public/store/screenshots/screenshot-agent-disclosure-light-1280x800.png`
- `public/store/screenshots/screenshot-agent-disclosure-dark-640x400.png`

Prepared promotional source and outputs:

- `store-assets/promo/promo-tiles.html` is the vector and type source of truth
- `scripts/generate-store-promo.mjs` regenerates both tiles with `node scripts/generate-store-promo.mjs`
- `store-assets/promo/small-tile.png` is an RGB PNG without alpha at 440x280 pixels
- `store-assets/promo/marquee.png` is an RGB PNG without alpha at 1400x560 pixels

Prepared store icon:

- `public/icons/icon-128.png` at 128x128 pixels

Google's [image requirements](https://developer.chrome.com/docs/webstore/images) require a 128x128 icon, at least one screenshot, and a 440x280 small promotional image. The 1400x560 marquee image is optional. Screenshots must show the current product experience.

The reviewed tiles now say “Local-first star organization.” and “Direct to GitHub and your selected AI provider. No developer-operated proxy.” The marquee adds that stars, tags, and notes remain in the browser while sync and AI requests go directly to the selected services. Its “Yours to keep” card describes optional sync through the user's secret Gist with **Push** and **Pull**. It makes no JSON, CSV, Markdown, export, or backup claim. The previous “Zero server. 100% private.” and “Private by Design” claims are absent.

The tiles contain typography and the brand icon, not screenshots. Review found no credentials, tokens, account data, private notes, prompts, Provider payloads, absolute privacy claims, or unsupported export claims. The regenerated small tile has SHA-256 `10b3b09739a454c63e805fa292d969c8223fb3bf5257c04a854d399b07b82aea`. The corrected marquee has SHA-256 `874796aa24006e023d22fdab1cd074862ec158cf2cbb71539136630ac6810258`.

Two consecutive generations produced byte-identical outputs on the same machine and Chrome build. Different Chrome builds can rasterize the same source differently, so this evidence makes no cross-machine reproducibility claim. Dashboard upload and public rendering remain separate external checks.

Dashboard asset presence, ordering, locale assignment, review status, and public rendering remain manual and unverified. In-app English and Simplified Chinese switching does not establish a localized Web Store listing.

## Manifest permission justifications

These justifications derive from the current Manifest V3 source. The final clean ZIP must be checked again because source review does not prove packaged permissions.

### `storage`

Provides `chrome.storage.local` for lightweight configuration and the encrypted GitHub Classic PAT and AI-service credentials, plus query or UI state. Star and annotation data, Watch snapshots, Cubby's bounded conversation/recovery/artifact ledger, and separately bounded Organize records use extension-local IndexedDB. A transient `chrome.storage.session` value routes Watch recovery to the relevant Options section and is consumed immediately.

### `alarms`

Schedules recovery work for durable full-library Organize analysis and approved Apply operations after Manifest V3 service-worker suspension. The extension creates and clears named alarms as work becomes recoverable or settles. See the official [`chrome.alarms` reference](https://developer.chrome.com/docs/extensions/reference/api/alarms).

### `https://github.com/*`

Mounts the manager on GitHub stars and repository pages. Manifest match patterns cannot target a query string such as `?tab=stars`, so the content script matches GitHub pages and gates its behavior at runtime.

### `https://api.github.com/*`

Authenticates the provided token, fetches starred and watched repositories, fetches Notifications only after Watch Inbox is enabled, performs requested bounded public-code search, and syncs annotations through the user's own secret Gist.

### `https://api.openai.com/*`

Allows a user who configures OpenAI to test the connection and run Cubby directly against OpenAI.

### `https://openrouter.ai/*`

Allows a user who configures OpenRouter to test the connection and run Cubby directly against OpenRouter.

### `https://api.anthropic.com/*`

Allows a user who configures Anthropic to test the connection and run Cubby directly against Anthropic.

### Optional custom AI-service hosts

The manifest declares `https://*/*`, `http://localhost/*`, and `http://127.0.0.1/*` as optional host permissions because a custom compatible origin is not known at install time. The broad HTTPS pattern lets the extension connect to an arbitrary HTTPS-compatible service configured by the user. Options requests access only after an explicit **Allow access** action.

Chrome's permission pattern may cover every port for a scheme and hostname. The extension separately binds the credential and request to the exact canonical origin, including its port. Denied optional access makes no Provider request.

Google explains required and optional host access in [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions). The Dashboard justification must explicitly explain the `https://*/*` scope, and the final ZIP manifest must match these documented patterns.

## Privacy practices mapping

Use this source-backed mapping while completing the dashboard. The dashboard answers remain unverified until someone inspects and saves them.

- User data supports the extension's disclosed purpose and requested user-facing features
- Data is not sold or used for personalized advertising, credit, or lending decisions
- No analytics or advertising software development kit receives extension data
- Watch Inbox processes watched-repository membership and bounded GitHub notification metadata only after explicit setup; it reuses the single Classic PAT after checking its `notifications` capability
- Following Radar uses the same Classic PAT only after checking its `read:user` capability; missing optional capabilities disable only the dependent feature
- Watch scope, notification threads, and refresh state stay in local IndexedDB and are never synced through Gist or sent to an AI service by default
- The selected AI service receives task data only when Cubby is used
- No developer-operated proxy or backend receives GitHub, Gist, or Provider traffic
- Star metadata remains in local IndexedDB unless you approve its use for a scoped Cubby task. Selected or frozen scope public repository metadata may reach the exact AI service you selected. Annotation data reaches your secret Gist only through optional **Push** or **Pull** sync.
- Committed conversation history, attempts, recovery projections, and artifacts remain unencrypted in local IndexedDB
- Valid settled attempts are normally pruned to the newest 128 per conversation; the current attempt and damaged recovery evidence may remain until explicit conversation deletion
- Conversation, recovery, and artifact records are not synced to Gist, sent to a developer server, or included in release diagnostics
- Re-fetchable tool cache can be cleared without deleting final answers, transcripts, attempt or recovery rows, or canonical artifacts
- The logical ledger warns at 256 MiB and stops new writes at 512 MiB; it excludes separately bounded Organize tables and differs from Chrome's whole-extension browser estimate
- Cubby retains at most one latest completed or cancelled Organize workflow independently of its origin conversation
- Origin-conversation deletion removes its transcript, attempt, recovery, and conversation-artifact rows but retains the latest terminal Organize result until Dismiss, replacement, or uninstall
- Task data can include the prompt, scoped public metadata, requested bounded public snippets and paths, requested in-scope private notes, visible bounded tags, and protocol observations
- Unrequested private notes, credentials, the GitHub token, and unrelated stars are excluded from model-visible task data by default
- OpenAI, OpenRouter, and custom OpenAI-compatible keys use `Authorization: Bearer`; Anthropic uses `x-api-key`
- Provider keys go only to the exact bound origin as authentication headers, not as prompt, tool, artifact, or log content
- Release diagnostics exclude committed history, attempts, recoveries, raw Provider requests and responses, keys, and authentication headers
- Unpacked development raw capture is separately warned page-memory behavior and is excluded from release builds and release evidence

Indexed public-code search can be partial because GitHub searches its default-branch index. The extension revalidates the frozen repositories as public and non-archived, bounds matching Git blob reads, and treats returned snippets as untrusted.

The dashboard must include an accurate single-purpose description, permission justifications, remote-code answer, data-use checkboxes, Limited Use certification, and privacy URL. Review the official [Privacy practices fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [Privacy Policy rules](https://developer.chrome.com/docs/webstore/program-policies/privacy), and [Limited Use policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Reviewer test instructions

Store credentials only in the Chrome Web Store Dashboard **Test instructions** tab. Never commit reviewer credentials to source, Markdown, screenshots, logs, ZIP files, or release evidence. Google documents this private reviewer channel in [Provide test instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions).

- **Credential-required path**: use a dedicated, least-privilege, revocable GitHub **Classic PAT** and AI-service credentials supplied only in Dashboard Test Instructions

The GitHub review PAT should use the current product scope set:

```text
repo,gist,notifications,read:user
```

`repo` and `gist` are required for the full core experience. `notifications` enables Watch Inbox and `read:user` enables Following Radar; omitting either must leave unrelated features usable. Do not use a fine-grained PAT for this review because the current product's Notifications API contract requires a Classic PAT.

Use these reviewer steps after private credentials are available:

1. Open Options and enter the dedicated GitHub Classic PAT from Dashboard Test Instructions.
2. Confirm the token uses `repo`, `gist`, `notifications`, and `read:user`; do not grant organization administration, workflow, repository deletion, key, audit-log, enterprise, package, or Webhook administration scopes.
3. Click **Save & verify** and confirm the authenticated account appears.
4. Open `https://github.com/your_username_here?tab=stars`, then run **Full Sync**.
5. Verify that stars appear and that search, filters, notes, and manual tags work locally.
6. Open **Watch** and confirm the existing Classic PAT is checked without requesting a second credential.
7. Refresh Watch and confirm only notifications for repositories that are both currently starred and watched are displayed. Turn Watch off and confirm cached threads are removed while Stars remains usable.
8. Open **Following Radar** and confirm it loads when `read:user` is present; remove that capability only in a separate negative test if needed.
9. Use **Push** and **Pull** to verify the dedicated secret Gist sync path.
10. In Options, select the AI service and confirm the collapsed notice shows the selected service and exact origin.
11. Enter the model and dedicated AI-service key from Dashboard Test Instructions, then run **Test connection**.
12. For a custom compatible origin, use **Allow access** and verify that denying access sends no request.
13. Ask Cubby for one ordinary bounded tag change and confirm only the prompt-authorized, locally evidenced change is applied.
14. Reload after a committed turn and confirm the conversation remains available. Exercise **Retry** only after a visible retryable failure.
15. Clear the re-fetchable tool cache in Options and confirm final answers and conversation history remain.
16. Open Cubby on two GitHub pages and start full-library Organize on one page.
17. Confirm the second page is read-only until the owner disconnects and you explicitly choose **Take control**.
18. Select suggestions in Review, choose **Apply**, and confirm both pages converge on the terminal receipt.
19. Delete the origin conversation and confirm the terminal Organize result remains reviewable, then choose **Dismiss**.
20. Confirm requests target the selected origin. Inspect release diagnostics and evidence for bounded facts only, with no credentials, authentication headers, or raw Provider request and response bodies.
21. Delete the dedicated review Gist and revoke or rotate all reviewer credentials after review.

Do not place the credential values or cleanup secrets in this document. Dashboard setup, credential validity, live service behavior, and cleanup remain manual until observed.

## Candidate version prerequisite

Candidate version `1.0.9` is explicitly approved, is strictly greater than public `1.0.8`, and is now applied to the package and generated manifest. The runner requires `GSM_VERSION_APPROVAL` to contain valid JSON with exactly three fields: the approved candidate, observed current public version, and observed prior uploaded version. Missing, scalar, extra-field, or mismatched approval blocks the run.

## Local release pipeline

The Phase 8 command names below exist in the current source. Their presence does not claim that the current candidate package has passed them.

After the exact intended source is committed cleanly, bind the approval with single-quoted JSON so the shell passes it unchanged:

```sh
export GSM_VERSION_APPROVAL='{"approvedCandidateVersion":"1.0.9","observedCurrentPublicVersion":"1.0.8","observedPriorUploadVersion":"1.0.8"}'
pnpm verify:agent-runtime
pnpm verify:agent-release-gates
```

The first command is the clean runtime verifier: it builds, runs controlled packaged scenarios and strict adapter contracts, packages the unchanged build, and writes bounded runtime evidence. The second command validates those existing inputs without rebuilding and writes final evidence before the gate marker.

The final chain must prove the ZIP root contains `manifest.json`, every manifest resource exists, required and optional permissions match this document, source-only and diagnostic material is absent, and the immutable provisional evidence remains `releaseReady: false`.

The two verification commands above do not upload the package or prove live credentials, dashboard values, review, or publication.

The release workflow runs its package and GitHub Release path for tag pushes, but the Chrome Web Store publish step does not run automatically from a tag push. That step runs only when `workflow_dispatch` is invoked on a tag with `publish_to_chrome_web_store` set to `true` and `CWS_DEPLOY_ENABLED` set to `true`. If the step is selected while required Web Store credentials or item identifiers are missing, it still starts and the publisher script fails closed. Local source does not show whether this gate is enabled or whether the step has ever run.

## Dashboard and publication checklist

Complete or directly verify these items after a clean local candidate passes:

- publish the exact reviewed privacy policy and verify unauthenticated retrieval
- reconcile the Store listing text, screenshots, promo images, category, homepage, and support fields
- reconcile single purpose, all permission justifications including `alarms`, remote-code answer, data-use checkboxes, and Limited Use certification
- place dedicated reviewer instructions and credentials only in Dashboard Test Instructions
- verify distribution, visibility, countries, pricing, rollout, and deferred-publishing choices
- upload the exact clean candidate package manually, or verify that the gated tagged workflow selected that exact ZIP
- confirm the dashboard or API accepted the package and reports the expected version and permissions
- submit the update only after every dashboard field is correct, or verify that the configured workflow invoked publication under that condition
- record review outcome separately from upload
- record publication separately from review approval
- verify the live listing, privacy link, promo assets, version, and installed-store behavior after publication
- revoke or rotate reviewer credentials and remove test Gist data

The public listing, public privacy display, public promo rendering, dashboard fields, reviewer credentials, upload, review, and publication states remain unverified until direct evidence records them.

## Official Chrome references

- [Update an existing item](https://developer.chrome.com/docs/webstore/update)
- [Publish and submit for review](https://developer.chrome.com/docs/webstore/publish)
- [Complete the Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Supply listing images](https://developer.chrome.com/docs/webstore/images)
- [Fill out privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Provide private reviewer test instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions)
- [Declare extension permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Use the alarms permission](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Chrome Web Store privacy policy requirements](https://developer.chrome.com/docs/webstore/program-policies/privacy)
- [Chrome Web Store Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Chrome Web Store user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
