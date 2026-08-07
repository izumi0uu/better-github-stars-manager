# Privacy Policy

Effective date: 2026-08-06

Better GitHub Stars Manager is a Chrome extension for organizing GitHub starred repositories.

## Limited Use disclosure

Better GitHub Stars Manager uses Chrome extension access to your GitHub data only to provide user-facing features you explicitly request. When you enable Cubby, the extension's optional AI assistant, the extension also connects directly to the AI service you select for Cubby tasks.

The extension does not:

- sell your data
- transfer data except to GitHub for GitHub/Gist features you invoke and to the AI service you explicitly select for Cubby tasks
- use your data for advertising
- use your data for credit or lending decisions
- operate a developer-controlled proxy for GitHub or AI-provider traffic

Your data is processed only to:

- authenticate your GitHub token
- fetch and display your starred repositories
- store and sync your own tags and notes when you choose to use Gist sync
- test or run Cubby through the AI service and origin you select

## What the extension processes

The extension processes the following categories of data:

- GitHub personal access token that you paste into the Options page
- GitHub account identity returned by `GET /user`, such as username, display name, and avatar URL
- GitHub star metadata returned by `GET /user/starred`, such as repository name, URL, description, language, topics, star count, pushed time, and starred time
- Tags and notes that you create inside the extension
- Optional sync metadata for the dedicated secret GitHub Gist used by the extension
- AI service configuration for Cubby, including provider, model, canonical origin, encrypted API-key material, and connection readiness stored locally
- Local Cubby conversation history, including committed prompts and assistant replies, plus any in-flight or retryable prompt kept with its conversation for recovery
- Paged tool artifacts created when a read result cannot fit the current extension-message/model-result budget, plus re-fetchable tool cache used to keep that result out of the message
- The latest completed or cancelled Cubby Organize workflow, including its frozen scope, review/apply state, and mutation receipt when present

## How the extension uses data

The extension uses this data only to provide its core features:

- fetch and render your GitHub starred repositories
- let you search, filter, tag, and annotate those repositories
- optionally sync your tags and notes through a secret GitHub Gist under your own account
- optionally analyze an explicitly selected or frozen repository scope through your configured AI service
- optionally search GitHub's index for public, non-archived code in a frozen scope of up to five starred repositories and send bounded matching snippets to your chosen AI service

The extension does not run ads, does not sell data, and does not send your data to a custom backend operated by the developer.

## Where data is stored

- Your GitHub token is stored in `chrome.storage.local` after AES-GCM encryption
- Star metadata is stored locally in the extension's IndexedDB database for fast querying
- Lightweight configuration is stored in `chrome.storage.local`
- AI service API keys are stored in `chrome.storage.local` after AES-GCM encryption and are bound to the selected provider and canonical origin
- Committed Cubby conversation history, in-flight or retryable prompts, and paged tool artifacts are stored unencrypted in the extension's local IndexedDB database; streaming text, progress indicators, provider authorization headers, API keys, and raw provider requests are not stored as conversation history, recovery state, or tool artifacts
- Cubby keeps at most one latest completed or cancelled Organize workflow in local IndexedDB so its result and receipt remain reviewable across page refreshes, service-worker restarts, and conversation deletion
- Tags, notes, tag metadata, and the bound Gist ID may be stored in a secret GitHub Gist only when you explicitly use Push or Pull sync

Depending on the features you choose, the extension communicates directly with:

- `https://github.com/*`
- `https://api.github.com/*`
- `https://api.openai.com/*` when OpenAI is selected
- `https://openrouter.ai/*` when OpenRouter is selected
- `https://api.anthropic.com/*` when Anthropic is selected
- a custom OpenAI-compatible HTTP(S) origin that you enter and explicitly allow

## Cubby data sharing

The Options page shows a collapsed data-use summary naming the selected provider and exact canonical origin. This notice is informational and does not block connection tests or Cubby use.

When you use Cubby, the extension may send these task-data categories to your selected AI service when needed:

- your prompt or bounded task instruction
- public repository metadata for the selected or frozen scope
- bounded public code snippets and file paths when you request indexed repository code search
- private notes for repositories in the selected or frozen scope only when your current prompt asks Cubby to read or use them
- the visible, bounded tag taxonomy
- protocol observations required for the interaction, such as tool definitions, bounded tool results, interaction choices, and app-authored run summaries

Indexed repository code search is not an exhaustive scan. GitHub searches its default-branch index, which may omit files or return partial results. BGSM revalidates the frozen repositories as public and non-archived, reads a bounded set of matching Git blobs, and marks every snippet as untrusted.

Private notes are read only through a scoped tool after the current prompt explicitly asks to use them. Notes and code snippets are treated as untrusted data. When they enter a committed conversation tool result, that result may be stored in the local conversation history and sent again or summarized only to the same bound AI provider during follow-up turns. Starting a new conversation creates a separate context. Deleting a conversation removes its local transcript, in-flight or retryable prompt, and canonical conversation artifacts. A linked active Organize workflow must first be cancelled or completed; deleting the conversation does not delete the latest completed or cancelled Organize result.

Local Cubby conversation history and recovery prompts are not synced to Gist, included in configuration export, sent to a developer server, or included in release diagnostics. An in-flight or retryable prompt is stored in the same IndexedDB conversation record only while it remains recovery authority; it is removed when the turn commits or becomes non-retryable, when expired authority is inspected, or when you delete the conversation. Other committed history remains available after a page refresh until you delete that conversation or uninstall the extension. In an unpacked local development build, an explicitly enabled, separately disclosed raw-capture mode can show Provider prompts and responses in page memory; those prompts may contain committed conversation history. Raw capture is excluded from release builds and release evidence.

The retained terminal Organize result is local workflow evidence, not conversation or authorization state. It may still record the deleted conversation as immutable provenance, but Cubby does not use that reference to route commands or restore control. It remains until you dismiss it, start a replacement Organize workflow, or uninstall the extension.

Large tool results may be split into bounded local pages. Cubby can page them with a session-bound opaque cursor, jump to a bounded UTF-8 byte offset, or locate an exact bounded literal before reading the matching region; every read remains scoped to the owning conversation. Canonical artifacts are removed with their conversation. Re-fetchable tool cache can be cleared separately from Options without deleting final answers. The extension applies a 256 MiB warning threshold and a 512 MiB logical limit to conversation and artifact payloads; these logical byte counts are separate from Chrome's browser-level storage estimate.

When you use Cubby, the extension does not send these as model-visible task data by default:

- private notes you did not ask Cubby to use
- credentials or secrets
- your GitHub token
- unrelated or out-of-scope stars

Authentication exception: the selected AI provider's own API key is necessarily sent only to its bound provider origin as an authorization header. It is not included in prompts, tool payloads, or logs. The GitHub token is never sent to an AI provider.

GitHub services receive only data necessary for the requested GitHub feature:

- GitHub REST API for account lookup, star retrieval, and optional indexed public-code search
- GitHub Gists API for optional cross-device sync

No analytics SDK, ad network, third-party tracking service, developer-operated proxy, or developer-operated server receives your extension data. Data sent directly to an AI provider is governed by the provider account and service terms you chose; BGSM does not add provider-side retention.

## Host permissions

OpenAI, OpenRouter, and Anthropic hosts are declared as required host permissions in the current extension package. Custom compatible services use Chrome optional host permissions. Chrome's host-permission pattern may cover every port for a scheme/hostname, but BGSM separately binds credentials and runtime requests to the exact configured canonical origin, including its port. The informational data-use notice does not grant Chrome host permission.

## Retention and deletion

You can remove data at any time:

- clear the saved token from the Options page
- remove the saved AI-provider API key or change the provider/origin, which invalidates its prior credential eligibility
- delete individual Cubby conversations from the conversation menu after cancelling or completing any linked active Organize workflow; this deletes conversation-owned history and artifacts but retains the latest terminal Organize result
- dismiss the retained completed or cancelled Organize result from the workbench
- clear re-fetchable Cubby tool cache from the Options page without deleting final answers
- delete local extension data by removing the extension from Chrome
- delete the secret GitHub Gist from your GitHub account if you no longer want sync data stored there

If you uninstall the extension, Chrome removes the extension's local storage. Any sync Gist created under your GitHub account remains in your account until you delete it.

Requests already sent to an AI provider are subject to that provider's retention and deletion controls. BGSM keeps local conversation history as described above, but does not keep a durable remote Cubby session or a copy on a developer server.

## Security notes

The extension encrypts locally stored GitHub and AI-provider credentials before writing them to `chrome.storage.local`. This is defense in depth against plain-text storage exposure, not a replacement for operating-system keychain security.

## Contact

Project homepage: https://github.com/izumi0uu/better-github-stars-manager

For support or privacy questions, use the repository issue tracker:

https://github.com/izumi0uu/better-github-stars-manager/issues
