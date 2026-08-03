# Privacy Policy

Effective date: 2026-07-14

Better GitHub Stars Manager is a Chrome extension for organizing GitHub starred repositories.

## Limited Use disclosure

Better GitHub Stars Manager uses Chrome extension access to your GitHub data and, when you enable BGSM Agent, the AI service you select only to provide user-facing features you explicitly request inside the extension.

The extension does not:

- sell your data
- transfer data except to GitHub for GitHub/Gist features you invoke and to the AI service you explicitly select for BGSM Agent tasks
- use your data for advertising
- use your data for credit or lending decisions
- operate a developer-controlled proxy for GitHub or AI-provider traffic

Your data is processed only to:

- authenticate your GitHub token
- fetch and display your starred repositories
- store and sync your own tags and notes when you choose to use Gist sync
- test or run BGSM Agent through the AI service and origin you select

## What the extension processes

The extension processes the following categories of data:

- GitHub personal access token that you paste into the Options page
- GitHub account identity returned by `GET /user`, such as username, display name, and avatar URL
- GitHub star metadata returned by `GET /user/starred`, such as repository name, URL, description, language, topics, star count, pushed time, and starred time
- Tags and notes that you create inside the extension
- Optional sync metadata for the dedicated secret GitHub Gist used by the extension
- BGSM Agent service, model, canonical origin, encrypted API-key material, and connection readiness stored locally

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
- Tags, notes, tag metadata, and the bound Gist ID may be stored in a secret GitHub Gist only when you explicitly use Push or Pull sync

Depending on the features you choose, the extension communicates directly with:

- `https://github.com/*`
- `https://api.github.com/*`
- `https://api.openai.com/*` when OpenAI is selected
- `https://openrouter.ai/*` when OpenRouter is selected
- `https://api.anthropic.com/*` when Anthropic is selected
- a custom OpenAI-compatible HTTP(S) origin that you enter and explicitly allow

## BGSM Agent data sharing

The Options page shows a collapsed data-use summary naming the selected provider and exact canonical origin. This notice is informational and does not block connection tests or Agent use.

BGSM Agent may send these task-data categories when needed:

- your prompt or bounded task instruction
- public repository metadata for the selected or frozen scope
- bounded public code snippets and file paths when you request indexed repository code search
- private notes for repositories in the selected or frozen scope only when your current prompt asks BGSM Agent to read or use them
- the visible, bounded tag taxonomy
- protocol observations required for the interaction, such as tool definitions, bounded tool results, interaction choices, and app-authored run summaries

Indexed repository code search is not an exhaustive scan. GitHub searches its default-branch index, which may omit files or return partial results. BGSM revalidates the frozen repositories as public and non-archived, reads a bounded set of matching Git blobs, and marks every snippet as untrusted.

Private notes are read only through a scoped tool after the current prompt explicitly asks to use them. Notes and code snippets are treated as untrusted data, remain only in the in-memory conversation, and may be sent again or summarized only to the same bound AI provider during follow-up turns. Starting a new conversation clears that conversation context.

BGSM Agent does not send these as model-visible task data by default:

- private notes you did not ask BGSM Agent to use
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
- delete local extension data by removing the extension from Chrome
- delete the secret GitHub Gist from your GitHub account if you no longer want sync data stored there

If you uninstall the extension, Chrome removes the extension's local storage. Any sync Gist created under your GitHub account remains in your account until you delete it.

Requests already sent to an AI provider are subject to that provider's retention and deletion controls. BGSM does not keep a durable remote Agent session or a copy on a developer server.

## Security notes

The extension encrypts locally stored GitHub and AI-provider credentials before writing them to `chrome.storage.local`. This is defense in depth against plain-text storage exposure, not a replacement for operating-system keychain security.

## Contact

Project homepage: https://github.com/izumi0uu/better-github-stars-manager

For support or privacy questions, use the repository issue tracker:

https://github.com/izumi0uu/better-github-stars-manager/issues
