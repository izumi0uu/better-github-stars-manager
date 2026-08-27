# Microsoft Edge privacy policy

[简体中文](../zh/edge-privacy-policy.md)

Effective date: 2026-08-16

This policy applies to the Microsoft Edge build of Better GitHub Stars Manager. It describes the behavior implemented for that build; it does not claim that Microsoft has reviewed, certified, or published the extension.

Better GitHub Stars Manager organizes GitHub starred repositories inside GitHub. The Edge build is local-first and connects directly to GitHub and to the AI service you select. The developer operates no proxy, analytics backend, advertising service, or custom data service.

## Single purpose

The Edge build helps you fetch, browse, search, filter, tag, annotate, and revisit repositories you have starred on GitHub. Optional Watch Inbox and Following Radar views use GitHub data. You can sync your annotation layer through your own secret GitHub Gist and optionally run Cubby, the local-first AI assistant, against the AI service you select. Full-library Organize prepares additive tag suggestions for a frozen library scope and changes tags only when you choose **Apply**.

## Data the Edge build processes

Depending on the features you use, the extension processes:

- the GitHub Classic Personal Access Token (PAT) that you enter in Options
- GitHub account identity, such as username, display name, and avatar URL
- starred-repository metadata, including repository name, URL, description, language, topics, star count, and dates
- watched-repository membership when Watch Inbox is enabled
- GitHub notification metadata for repositories in the eligible Watch scope, including repository, reason, subject title and type, safe GitHub link, unread state, and update or read dates
- Following activity and public repository metadata used by Radar and deterministic recommendations
- tags, notes, favorites, filters, layout preferences, and other settings you create locally
- metadata for the dedicated secret GitHub Gist used for optional sync
- Cubby service configuration, including provider, model, canonical origin, encrypted API-key material, and connection readiness
- committed Cubby conversation history and immutable admitted attempts, including each admitted prompt
- bounded recovery projections needed to continue an admitted attempt after interruption
- paged tool artifacts and re-fetchable tool cache used when a result cannot fit an extension message or model result
- separate Organize data, including its instruction, frozen scope, proposal, Review and Apply state, and one latest completed or cancelled result
- refresh state and bounded operational diagnostics needed to show whether a requested feature succeeded

The Edge build requests credentials only for GitHub and for the AI service you select. It does not send prompts, notes, repository data, or other user content to any other service.

## GitHub credential and scopes

The Edge build uses one GitHub Classic PAT for requested GitHub features. The complete optional feature path may use these scopes:

```text
repo,gist,notifications,read:user
```

- `repo` permits Stars and repository access, including private repositories your GitHub account is allowed to access.
- `gist` permits the optional secret-Gist sync path and the verified Gist create/delete probe used to confirm the capability.
- `notifications` enables the optional Watch Inbox.
- `read:user` enables Following Radar.

The Edge build requests only the scopes listed above. You can omit optional scopes when you do not use the corresponding optional feature, subject to the guidance shown in Options.

## How data is used

The extension uses the data only to provide features you request:

- authenticate to GitHub and confirm the account attached to the PAT
- fetch and refresh starred repositories
- provide local search, filters, tags, notes, favorites, and deterministic Auto Tags
- show optional watched-repository notifications
- show Following activity and deterministic recommendations
- sync your annotation layer through the secret Gist only when you use **Push** or **Pull**
- let Cubby analyze an explicitly selected or frozen repository scope and perform ordinary bounded tag changes
- run the full-library Organize workflow with Review and Apply
- mount the Stars manager and repository tag chip on eligible GitHub pages

The extension does not sell data, use it for advertising, credit, or lending decisions, or send it to a developer-operated backend.

## Storage and retention

- The GitHub PAT and AI-service API keys are encrypted with AES-GCM before they are stored in Microsoft Edge extension storage (`chrome.storage.local`). AI-service keys are bound to the selected provider and canonical origin. This is defense in depth against plain-text storage exposure; it is not equivalent to operating-system keychain protection.
- Lightweight configuration, including the bound Gist ID, is stored in `chrome.storage.local`.
- Star metadata, tags, notes, favorites, Watch records, Radar records, and local query state are stored in the extension's local IndexedDB database.
- Watch repository scope, notification-thread snapshots, and refresh state are stored unencrypted in local IndexedDB.
- Committed Cubby conversation history, attempt and recovery records, and paged artifacts are stored unencrypted in the extension's local IndexedDB database.
- Tags, notes, and tag metadata are written to a secret GitHub Gist only when you use **Push** or **Pull**.
- Watch scope and notification records, Cubby conversation/recovery/artifact records, and Organize records are never synced through Gist.
- Cubby normally prunes valid settled attempts to the newest 128 per conversation. The current attempt and damaged recovery evidence may remain beyond that boundary until you explicitly delete the conversation.
- The conversation, recovery, and artifact ledger warns at 256 MiB and stops new writes at a 512 MiB logical limit; the re-fetchable cache has 2 MiB of headroom below that limit.
- Cubby retains at most one latest completed or cancelled Organize workflow in local IndexedDB, independently of its origin conversation. Starting a replacement Organize workflow removes the previous terminal workflow.

A profile that previously held settings or records from another unpacked build can retain browser-local records until they are cleared or the extension is uninstalled. Legacy settings do not grant capabilities beyond the product's normal behavior.

## Direct service connections

The packaged Edge manifest permits only:

- `https://github.com/*`
- `https://api.github.com/*`
- `https://api.openai.com/*` when OpenAI is selected
- `https://openrouter.ai/*` when OpenRouter is selected
- `https://api.anthropic.com/*` when Anthropic is selected
- a custom OpenAI-compatible HTTPS origin, or HTTP loopback origin, that you enter and explicitly allow

GitHub and Provider requests go directly from Microsoft Edge to those services. They do not pass through a developer proxy. No analytics SDK, advertising network, tracking service, developer proxy, or developer server receives extension data.

## Cubby data sharing and consent

Options shows a collapsed informational summary naming the selected provider and exact canonical origin. Cubby runs only after you complete the explicit disclosure action that records the versioned acceptance of the selected provider and exact origin. The manifest includes no remote executable code; GitHub responses and Provider responses are data, not extension code.

Cubby may send these task-data categories to your selected AI service when needed:

- your prompt or bounded task instruction
- public repository metadata for the selected or frozen scope
- bounded public code snippets and file paths when Cubby uses indexed code search
- private notes for in-scope repositories when Cubby uses the scoped note tool; trusted instructions limit that use to requests that call for note content
- the visible, bounded tag taxonomy
- protocol observations, including tool definitions, bounded tool results, interaction choices, and app-authored summaries

Cubby does not send credentials, your GitHub token, or unrelated out-of-scope stars as model-visible task data. The selected AI-service key is sent to its bound origin only as an authentication header (OpenAI, OpenRouter, and custom OpenAI-compatible services use `Authorization: Bearer`; Anthropic uses `x-api-key`). The key is not included in prompts, tool payloads, or logs, and the GitHub token is never sent to an AI service.

GitHub receives only data needed for a requested GitHub feature: the GitHub REST API receives account lookup, star retrieval, optional watched-repository membership and Notifications, optional indexed public-code search, and Gist sync requests; the GitHub Gists API receives annotation data only when you use optional **Push** or **Pull** sync. Provider-side retention and deletion follow the account and service terms you selected.

## Permissions

The Edge package uses:

- `storage` for lightweight configuration and the encrypted GitHub and AI-service credentials
- `alarms` for recovery scheduling of durable full-library Organize analysis and approved Apply operations across MV3 service-worker suspension
- `https://github.com/*` to mount product surfaces on GitHub pages
- `https://api.github.com/*` for authenticated GitHub features
- `https://api.openai.com/*`, `https://openrouter.ai/*`, and `https://api.anthropic.com/*` for user-configured built-in Providers
- `https://*/*`, `http://localhost/*`, and `http://127.0.0.1/*` as optional host permissions for a user-configured custom compatible origin; Options requests access only after an explicit **Allow access** action, and credentials and requests remain bound to the exact canonical origin, including its port

Denied optional access makes no Provider request.

## Diagnostics and release evidence

Runtime and release evidence is bounded and redacted. It may contain a sanitized browser identity, an executable-binary digest, extension ID, verified scenario identifiers, diagnostic counts, package fingerprints, manifest permission facts, and packaged capability declarations.

Evidence does not contain the executable path, PAT, API keys, authentication headers, request bodies, notes, prompts, personal account data, private repository content, or raw GitHub or Provider responses. The extension does not send release evidence to a developer server.

## Your controls and deletion

You can:

- clear the saved GitHub Classic PAT in Options
- remove the saved AI-service key, or change the provider or origin, which invalidates the prior credential binding
- disable Watch Inbox and clear its locally cached records
- edit or delete local tags and notes through the product controls
- delete a Cubby conversation after cancelling or completing any linked active Organize workflow
- dismiss the retained completed or cancelled Organize result from the workbench
- clear the re-fetchable Cubby tool cache in Options without deleting final answers or conversation data
- delete the secret sync Gist from your GitHub account
- clear browser-local extension data through Microsoft Edge
- uninstall the extension to remove its Microsoft Edge extension storage and IndexedDB data
- revoke the PAT at GitHub to stop future authenticated GitHub access

Deleting a conversation removes its transcript, attempt and recovery rows, and conversation-owned artifacts. Deleting the origin conversation does not delete the latest terminal Organize result; that record remains until you dismiss it, start a replacement Organize workflow, or uninstall the extension. Requests already sent to an AI service remain subject to that service's retention and deletion controls.

## Security

The extension sends GitHub and built-in Provider requests over HTTPS. A custom localhost service may use HTTP only when you configure and allow that exact local origin. The extension bundles its executable code and does not fetch or execute remote scripts. GitHub and Provider response data are treated as data, not executable extension code.

Keep your PAT and AI-service keys private, use only the scopes you need, and revoke or rotate them if you believe they have been exposed.

## Contact

- [Project overview](../../README.en.md)
- [Security and support](../../SECURITY.md)
