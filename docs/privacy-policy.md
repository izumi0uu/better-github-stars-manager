# Privacy Policy

Effective date: 2026-06-24

Better GitHub Stars Manager is a browser extension for organizing GitHub starred repositories.

## Limited Use disclosure

Better GitHub Stars Manager uses browser extension access to your GitHub data only to provide the user-facing features you explicitly request inside the extension.

The extension does not:

- sell or transfer your data to third parties, except to GitHub when needed to provide GitHub API and Gist sync features you invoke
- use your data for advertising
- use your data for credit or lending decisions
- allow humans to read your data except when you explicitly publish it yourself through GitHub

Your data is processed only to:

- authenticate your GitHub token
- fetch and display your starred repositories
- store and sync your own tags and notes when you choose to use Gist sync

## What the extension processes

The extension processes the following categories of data:

- GitHub personal access token that you paste into the Options page
- GitHub account identity returned by `GET /user`, such as username, display name, and avatar URL
- GitHub star metadata returned by `GET /user/starred`, such as repository name, URL, description, language, topics, star count, pushed time, and starred time
- Tags and notes that you create inside the extension
- Optional sync metadata for the dedicated secret GitHub Gist used by the extension

## How the extension uses data

The extension uses this data only to provide its core features:

- fetch and render your GitHub starred repositories
- let you search, filter, tag, and annotate those repositories
- optionally sync your tags and notes through a secret GitHub Gist under your own account

The extension does not run ads, does not sell data, and does not send your data to a custom backend operated by the developer.

## Where data is stored

- Your GitHub token is stored in extension local storage after AES-GCM encryption
- Star metadata is stored locally in the extension's IndexedDB database for fast querying
- Lightweight configuration is stored in extension local storage
- Tags, notes, tag metadata, and the bound Gist ID may be stored in a secret GitHub Gist only when you explicitly use Push or Pull sync

The extension communicates only with:

- `https://github.com/*`
- `https://api.github.com/*`

## Data sharing

The extension shares data only with GitHub services that are necessary for the requested feature:

- GitHub REST API for account lookup and star retrieval
- GitHub Gists API for optional cross-device sync

No analytics SDK, ad network, third-party tracking service, or developer-operated server receives your extension data.

## Retention and deletion

You can remove data at any time:

- clear the saved token from the Options page
- delete local extension data by removing the extension from your browser
- delete the secret GitHub Gist from your GitHub account if you no longer want sync data stored there

If you uninstall the extension, your browser removes the extension's local storage. Any sync Gist created under your GitHub account remains in your account until you delete it.

## Security notes

The extension encrypts the locally stored token before writing it to extension local storage. This is intended as defense in depth against plain-text storage exposure. It is not a replacement for operating-system keychain security.

## Contact

Project homepage: https://github.com/izumi0uu/better-github-stars-manager

For support or privacy questions, use the repository issue tracker:

https://github.com/izumi0uu/better-github-stars-manager/issues
