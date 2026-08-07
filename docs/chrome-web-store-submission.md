# Chrome Web Store Submission Notes

This document collects the store listing copy, permission justifications, and reviewer instructions for the first Chrome Web Store submission.

## Public URLs

- Homepage: https://github.com/izumi0uu/better-github-stars-manager
- Privacy policy: https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/privacy-policy.md
- Support/issues: https://github.com/izumi0uu/better-github-stars-manager/issues

Note: the privacy policy URL above only works after this document is committed and pushed to the public repository.

## Candidate listing copy

### Store name

Better GitHub Stars Manager

### Short description

Organize GitHub stars with search, tags, notes, filters, optional Gist sync, and Cubby, a review-first AI assistant.

### Detailed description

Better GitHub Stars Manager upgrades GitHub's native stars page into a fast, local-first workspace for heavy stars users.

Use it to:

- load and browse large star collections in a virtualized table
- search across repository name, description, topics, and your own notes
- organize repos with custom tags and notes
- filter by language, tags, and untagged items
- sync only your annotation layer across devices through your own secret GitHub Gist
- use your own OpenAI, OpenRouter, Anthropic, or compatible AI service to analyze a frozen repository scope and review additive tag suggestions before applying them

The extension UI runs on GitHub. GitHub/Gist requests go directly to GitHub, and optional Cubby requests go directly to the AI service the user selects. The developer operates no proxy or custom backend.

## Suggested store category

Developer Tools

## Suggested screenshots

Chrome Web Store screenshots must be `1280x800` or `640x400` pixels.

Prepared store screenshots:

- `public/store/screenshots/screenshot-main-stars.png`
- `public/store/screenshots/screenshot-detail-panel.png`
- `public/store/screenshots/screenshot-agent-disclosure-light-1280x800.png`
- `public/store/screenshots/screenshot-agent-disclosure-dark-640x400.png`

The token tutorial images remain useful for README and onboarding, but they are not the primary store screenshots:

- `public/tutorial/img_01.png`
- `public/tutorial/img_02.png`
- `public/tutorial/img_03.png`

## Promotional images

Chrome Web Store requires one small promotional image at `440x280`.

Prepared promo assets derived from `store-assets/poster/img_01.png`:

- `store-assets/promo/small-tile.png` (`440x280`)
- `store-assets/promo/marquee.png` (`1400x560`)

## Permission justification

### `storage`

Used to store local configuration, encrypted token material, query state, annotation data, Cubby conversations, and the latest terminal Organize result and receipt needed by the extension UI.

### `https://github.com/*`

Used to mount the manager UI on GitHub stars pages and repository pages where the repo tag chip appears.
The match pattern is broad because MV3 match patterns cannot target query strings such as `?tab=stars`, so the content script matches GitHub pages and then gates at runtime.

### `https://api.github.com/*`

Used to authenticate the provided token, fetch the authenticated user's starred repositories, optionally search bounded public code through GitHub's index, and optionally sync annotations through the user's own secret GitHub Gist.

### `https://api.openai.com/*`

Required in the current package so a user who explicitly configures OpenAI can test the connection and run Cubby. Options shows the exact service origin in a collapsed data-use notice.

### `https://openrouter.ai/*`

Required in the current package so a user who explicitly configures OpenRouter can test the connection and run Cubby. Options shows the exact service origin in a collapsed data-use notice.

### `https://api.anthropic.com/*`

Required in the current package so a user who explicitly configures Anthropic can test the connection and run Cubby. Options shows the exact service origin in a collapsed data-use notice.

### Optional custom AI-service hosts

The manifest declares broad HTTPS plus localhost/127.0.0.1 development patterns as optional host permissions because a custom compatible service cannot be known at install time. Options requests access only from an explicit **Allow access** user action for the configured hostname. Chrome's permission pattern may cover ports, while BGSM's credential and fetch gates remain exact-origin and port-sensitive.

## Privacy practices form notes

When filling the Chrome Web Store privacy section, the current codebase supports these answers:

- User data is used only to provide the extension's core functionality.
- Data is not sold.
- Data is not used for personalized advertising.
- Data is not used for creditworthiness or lending purposes.
- Data is not shared with third-party analytics or ad SDKs.
- Remote services are GitHub/Gist plus, only when enabled, the user's selected OpenAI, OpenRouter, Anthropic, or custom OpenAI-compatible origin.
- The extension stores star metadata locally and optionally stores user-created annotations in the user's own secret GitHub Gist.
- Cubby task data may include the prompt or bounded task instruction, scoped public repository metadata, bounded public code snippets and file paths when indexed code search is requested, private notes for scoped repositories only when the current prompt asks to use them, visible, bounded tag taxonomy, and protocol observations. Indexed search can be partial and is not presented as an exhaustive repository scan. Requested notes and code snippets are untrusted and may enter committed local conversation history for follow-ups or summaries with the same AI service.
- Committed local conversation history and any in-flight or retryable prompt used to recover an interrupted turn are stored unencrypted in the extension's local IndexedDB database. They are not synced, exported, sent to a developer server, or included in release diagnostics. Committing or terminalizing the turn removes its recovery prompt. Deleting a conversation removes its transcript, remaining recovery prompt, and canonical conversation artifacts after any linked active Organize workflow is cancelled or completed. Other committed history remains until the user deletes the conversation or uninstalls the extension. Unpacked development builds have a separately disclosed, explicitly enabled raw-capture mode that can show Provider prompts in page memory; it is excluded from release builds and release evidence.
- Cubby retains at most one latest completed or cancelled Organize workflow, including frozen scope, review/apply state, and any mutation receipt, independently of its origin conversation. Deleting that conversation does not delete this terminal workflow evidence or transfer control through its provenance reference. The result remains local until the user dismisses it, starts a replacement Organize workflow, or uninstalls the extension.
- Oversized read results are stored as bounded local IndexedDB artifact pages. Cubby may page them through a session-owned opaque cursor, jump to a bounded UTF-8 byte offset, or search for an exact bounded literal before reading the matching region; every access remains scoped to the owning conversation. A successful commit promotes the referenced artifact to canonical storage; uncommitted cache expires or can be cleared independently. Canonical artifacts are deleted with their conversation. API keys, authorization headers, and raw provider requests are excluded from artifact storage.
- Cubby task data excludes private notes the user did not ask Cubby to use, credentials or secrets, the GitHub token, and unrelated or out-of-scope stars by default.
- The selected AI-provider API key is sent only to its bound origin as an authorization header, never as model-visible prompt/tool data or logs.
- No developer-operated proxy receives the traffic; provider requests go directly from the extension to the selected service.

If the dashboard asks for a Limited Use statement, reuse the language from `docs/privacy-policy.md`.

## Reviewer test instructions

1. Open the extension Options page.
2. Paste a GitHub fine-grained personal access token.
3. Grant `Public repositories` repository access.
4. Add `Starring: Read and write` and `Gists: Read and write` for full-feature testing.
5. Save the token and confirm the extension shows the authenticated account.
6. Open `https://github.com/{your-username}?tab=stars`.
7. Click `Sync` to import stars into the local database.
8. Verify that repositories appear, search works, and notes or tags can be added.
9. Click `Push` to create or update the dedicated secret sync Gist, then click `Pull` to fetch it back.
10. In Options, choose OpenAI, OpenRouter, or Anthropic and confirm the collapsed data-use notice names the service and exact origin.
11. Enter a model and test API key, then confirm **Test connection** is available without a separate disclosure acknowledgement.
12. For a custom compatible Base URL, click the separate **Allow access** control and verify denial makes no provider request.
13. Open the Cubby workbench on two GitHub pages, start a bounded tag analysis on one page, and verify the other page is read-only until the owner page disconnects and **Take control** is used.
14. Review selected rows and apply only the chosen additive tag suggestions; verify both pages converge on the same terminal receipt.
15. Delete the originating conversation and verify the terminal Organize result remains reviewable, then dismiss it from either page.

## Pre-submit checklist

- `corepack pnpm build`
- `corepack pnpm test`
- `corepack pnpm package:extension`
- confirm the ZIP in `artifacts/` contains `manifest.json` at its root
- confirm the public GitHub repository contains `docs/privacy-policy.md` and the URL opens without authentication
- provide a support email in the Chrome Web Store dashboard
- upload the 128x128 store icon
- upload at least 1 screenshot sized `1280x800` or `640x400`
- upload the required `440x280` small promotional image
- upload final screenshots that show the real stars-page UI
- paste the privacy policy URL from this document into the listing
- complete the privacy practices questionnaire to match the statements above
- prepare reviewer notes that mention required GitHub token scopes
- confirm the permission disclosures match the current manifest
- inspect the generated release-evidence JSON for source revision/dirty state, package version, file checksums, ZIP-root manifest, and packaged required/optional permission summaries
- do not claim dashboard submission from local package evidence
