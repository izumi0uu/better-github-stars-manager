# Privacy policy

[简体中文](../zh/privacy-policy.md)

Effective date: 2026-08-12

Better GitHub Stars Manager is a Chrome extension for organizing GitHub starred repositories. This policy describes the data the extension processes, where it goes, how long local records remain, and how you can delete them.

## Limited Use disclosure

Better GitHub Stars Manager uses access to GitHub data only for features you request. When you enable Cubby, the optional AI assistant, the extension also connects directly to the AI service you select.

Use of information received from Google APIs complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements.

The extension does not:

- sell your data
- use your data for advertising, credit, or lending decisions
- transfer data except to GitHub for requested GitHub or Gist features and to your selected AI service for requested Cubby tasks
- operate a developer-controlled proxy or backend for GitHub or AI-service traffic

The extension processes data only to:

- authenticate the GitHub **Classic PAT** you provide
- fetch and display your starred repositories
- store and optionally sync your tags and notes through your own secret GitHub Gist
- test or run Cubby through the AI service and exact origin you select
- show the optional Watch Inbox after you request it, using the same GitHub credential after its Notifications capability is checked

## Data the extension processes

The extension processes these data categories:
- the single GitHub **Classic PAT** you paste into Options; its optional `notifications` and `read:user` capabilities control Watch Inbox and Following Radar
- GitHub account identity from `GET /user`, such as username, display name, and avatar URL
- star metadata from `GET /user/starred`, such as repository name, URL, description, language, topics, star count, and dates
- watched-repository membership from `GET /user/subscriptions`
- GitHub notification metadata for the optional Watch Inbox, including repository, reason, subject title and type, safe GitHub link, unread state, and update/read dates
- tags and notes that you create inside the extension
- metadata for the dedicated secret GitHub Gist used for optional sync
- Cubby service configuration, including provider, model, canonical origin, encrypted API-key material, and connection readiness
- committed Cubby conversation history and immutable admitted attempts, including each admitted prompt
- bounded recovery projections needed to continue an admitted attempt after interruption
- paged tool artifacts and re-fetchable tool cache used when a result cannot fit an extension message or model result
- separate Organize data, including its instruction, frozen scope, proposal, Review and Apply state, and one latest completed or cancelled result

## How the extension uses data

The extension uses this data to provide these features:

- fetch, search, filter, tag, and annotate your starred repositories
- optionally sync your annotation layer through a secret GitHub Gist under your account
- optionally show GitHub Notifications for currently starred repositories you watch
- let Cubby analyze an explicitly selected or frozen repository scope
- let Cubby perform ordinary bounded tag changes authorized by your current prompt and current-turn local evidence
- run a separate full-library Organize workflow that freezes its scope, proposes additive tags, and requires your Review selections before Apply
- search GitHub's index for public, non-archived code in a frozen scope of up to five starred repositories when you request code search

The extension does not run ads, sell data, or send data to a developer-operated server.

## Local and optional Gist storage

- GitHub credentials are stored in `chrome.storage.local` after Advanced Encryption Standard Galois/Counter Mode (AES-GCM) encryption; the single Classic PAT is reused for Stars, Gist, Watch, and Following after capability checks
- AI-service API keys are stored in `chrome.storage.local` after AES-GCM encryption and are bound to the selected provider and canonical origin
- Lightweight configuration, including the bound Gist ID, is stored in `chrome.storage.local`
- Star metadata, tags, and notes are stored locally in IndexedDB for fast querying
- Watch repository scope, notification-thread snapshots, and refresh state are stored unencrypted in local IndexedDB
- Committed conversation history, attempt and recovery records, and paged artifacts are stored unencrypted in the extension's local IndexedDB database
- Tags, notes, and tag metadata are stored in a secret GitHub Gist only when you use **Push** or **Pull**

Watch scope and notification records, Cubby conversation/recovery/artifact records, and Organize records are not synced through Gist.

Each admitted Cubby turn stores an immutable launch, including its prompt, in an attempt row. Pending continuation messages use a separate bounded recovery row. Cubby removes the recovery row when continuation authority ends.

Cubby normally prunes valid settled attempts to the newest 128 per conversation. It may retain the current attempt and damaged recovery evidence beyond that normal pruning boundary until you explicitly delete the conversation.

Large tool results may be split into bounded local pages. Cubby can page them with a conversation-bound opaque cursor, read from a bounded UTF-8 byte offset, or locate an exact bounded literal before reading the matching region. Every read remains scoped to the owning conversation.

Canonical artifacts remain with their conversation. Re-fetchable artifact cache can expire or be cleared without deleting final answers. The conversation, recovery, and artifact ledger warns at 256 MiB and stops new writes at a 512 MiB logical limit. Re-fetchable cache has 2 MiB of headroom below that limit.

The logical ledger includes conversation headers, attempts, recovery rows, messages, canonical artifacts, and re-fetchable cache. It excludes separately bounded Organize tables and differs from Chrome's browser-level estimate for all extension storage.

Cubby keeps at most one latest completed or cancelled Organize workflow in local IndexedDB. This separate record can include its instruction, frozen scope, proposal, Review and Apply state, receipt, and origin provenance. Starting a replacement Organize workflow removes the previous terminal workflow.

Streaming text, progress indicators, Provider authorization headers, API keys, raw Provider requests and responses, and worker-local projections beyond the bounded recovery record are not stored as committed conversation history, recovery state, or tool artifacts.

## Direct service connections

Depending on the features you choose, the extension connects directly to:

- `https://github.com/*`
- `https://api.github.com/*`
- `https://api.openai.com/*` when OpenAI is selected
- `https://openrouter.ai/*` when OpenRouter is selected
- `https://api.anthropic.com/*` when Anthropic is selected
- a custom OpenAI-compatible HTTPS origin, or HTTP loopback origin, that you enter and explicitly allow

Provider and GitHub requests do not pass through a developer-operated proxy.

## Cubby data sharing

Options shows a collapsed informational summary naming the selected provider and exact canonical origin. This notice does not grant Chrome host permission or block built-in Provider use.

Cubby may send these task-data categories to your selected AI service when needed:

- your prompt or bounded task instruction
- public repository metadata for the selected or frozen scope
- bounded public code snippets and file paths when Cubby uses indexed code search for your request
- private notes for in-scope repositories when Cubby uses the scoped note tool; trusted instructions limit that use to requests that call for note content
- the visible, bounded tag taxonomy
- protocol observations, including tool definitions, bounded tool results, interaction choices, and app-authored summaries

Indexed code search is not exhaustive. GitHub searches its default-branch index, which may omit files or return partial results. The extension revalidates repositories as public and non-archived, reads bounded matching Git blobs, and treats every snippet as untrusted data.

The private-note and repository-code tools are available during ordinary turns. The runtime enforces repository scope, tool authorization, and result bounds, but it does not semantically classify your prompt. Cubby's trusted instructions limit these tools to requests that call for the corresponding data. Notes and code snippets are treated as untrusted data. A committed tool result may be stored locally and sent again or summarized only to the same bound AI provider during follow-up turns.

Cubby does not send these categories as model-visible task data by default:

- private notes when your request does not call for note content; this is an instruction-level restriction, not a separate runtime intent classifier
- credentials or secrets
- your GitHub token
- unrelated or out-of-scope stars

The selected AI-service key must be sent to its bound origin for authentication. OpenAI, OpenRouter, and custom OpenAI-compatible services use an `Authorization: Bearer` header. Anthropic uses an `x-api-key` header. The key is not included in prompts, tool payloads, or logs. The GitHub token is never sent to an AI service.

GitHub receives only data needed for a requested GitHub feature:

- the GitHub REST API receives requests for account lookup, star retrieval, optional watched-repository membership and Notifications when Watch Inbox is enabled, optional indexed public-code search, and Gist sync
- the GitHub Gists API receives annotation data only when you use optional Push or Pull sync

No analytics software development kit, ad network, tracking service, developer proxy, or developer server receives extension data. Provider-side retention and deletion follow the account and service terms you selected.

## Host permissions

The current manifest requires GitHub page and API hosts plus the OpenAI, OpenRouter, and Anthropic hosts. Custom compatible services use Chrome optional host permissions.

Chrome's host pattern may cover every port for a scheme and hostname. The extension separately binds credentials and requests to the exact configured canonical origin, including its port. Learn how Chrome distinguishes required and optional access in [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions).

## Diagnostics boundary

Release diagnostics exclude committed history, attempt and recovery records, raw Provider requests and responses, credentials, and authentication headers. Release evidence stores bounded semantic facts, counts, relative paths, and digests instead of private task content.

An unpacked development build can expose an explicitly enabled one-shot raw capture in page memory. Captured prompts may include committed conversation history. The development build warns you before arming this mode. Raw capture is excluded from release builds and release evidence.

## Retention and deletion

- clear the saved GitHub Classic PAT in Options
- turn off Watch Inbox to remove its capability binding and cached notification threads; Stars remains usable
- remove the saved AI-service key or change the provider or origin, which invalidates the prior credential binding
- delete a Cubby conversation after cancelling or completing any linked active Organize workflow
- dismiss the retained completed or cancelled Organize result from the workbench
- clear re-fetchable Cubby tool cache in Options without deleting final answers or conversation data
- uninstall the extension to remove Chrome-local extension storage
- delete the secret sync Gist from your GitHub account

Deleting a conversation removes its transcript, attempt and recovery rows, and conversation-owned artifacts. This includes damaged attempt evidence. Deletion is blocked while the worker owns an active attempt or a linked Organize workflow remains nonterminal.

Deleting the origin conversation does not delete the latest terminal Organize result. That record keeps immutable origin provenance, but provenance is not authorization. It remains until you dismiss it, start a replacement Organize workflow, or uninstall the extension.

Uninstalling removes the extension's Chrome-local storage. A Gist created under your GitHub account remains until you delete it. Requests already sent to an AI service remain subject to that service's retention and deletion controls.

## Security notes

The extension encrypts stored GitHub and AI-service credentials before writing them to `chrome.storage.local`. This provides defense in depth against plain-text storage exposure. It is not equivalent to operating-system keychain protection.

The extension transmits data to GitHub and built-in AI services over HTTPS. A custom localhost service may use HTTP only when you configure and allow that exact local origin.

## Contact

- [Project homepage](https://github.com/izumi0uu/better-github-stars-manager)
- [Support and privacy issue tracker](https://github.com/izumi0uu/better-github-stars-manager/issues)
