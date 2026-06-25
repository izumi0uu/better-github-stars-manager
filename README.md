[English](./README.md) · [简体中文](./README.zh-CN.md)

# Better GitHub Stars Manager

[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Latest release](https://img.shields.io/github/v/release/izumi0uu/better-github-stars-manager?logo=github&label=release)](https://github.com/izumi0uu/better-github-stars-manager/releases)
[![License: MIT](https://img.shields.io/github/license/izumi0uu/better-github-stars-manager?logo=opensourceinitiative&logoColor=white)](./LICENSE)

> A Chrome extension for heavy GitHub users — local-first, zero-server, personal. It turns `https://github.com/{user}?tab=stars` into a fast, searchable, taggable, filterable, annotatable workspace so you can manage thousands of stars without leaving GitHub.

![Better GitHub Stars Manager](public/poster/img_01.png)

## Table of Contents

- [Why Better GitHub Stars Manager?](#why-better-github-stars-manager)
- [Features](#features)
- [Screenshots](#screenshots)
- [How to Use](#how-to-use)
- [Install](#install)
- [Privacy and Storage](#privacy-and-storage)
- [Development](#development)
- [License](#license)
- [Contributing](#contributing)

## Why Better GitHub Stars Manager?

GitHub Stars is good for bookmarking, but it does not hold up for long-term organization.

Once your stars grow into the hundreds or thousands, the native list becomes hard to manage. In the AI era, GitHub projects multiply exponentially — you star all kinds of things, then forget where you saved them or what they were called. The real pain points:

- pagination hides the full picture of your stars
- no personal tagging system
- no real notes layer
- hard to revisit what you saved and why

Better GitHub Stars Manager makes GitHub Stars genuinely manageable for heavy users.

## Features

- **All stars in one place**
  Load your starred repositories into a virtualized table that stays usable even with very large collections.

- **Fast search and filtering**
  Search across repository name, description, topics, and notes. Filter by language, tags, and untagged items.

- **Floating toggle button**
  On your own GitHub stars page, a floating button switches to the management panel with one click.

- **Custom tags and notes**
  Add your own labels and notes so your stars become a working library instead of a passive list.

- **Auto-suggested tags**
  Turn repository topics and language into suggested tags with one click or in bulk.

- **Incremental sync and full rescan**
  Pull in newly starred repositories quickly, and run a full rescan when you want to reconcile unstars while keeping your annotations.

- **Repo-page tag chip**
  See and edit your tags directly on individual GitHub repository pages.

- **Cross-device annotation sync**
  Push and pull your tags and notes through your own private GitHub Gist.

- **Gist-backed storage layer**
  Keep your annotation layer in a dedicated secret Gist so it is portable, recoverable, and easy to sync across devices without a backend.

## Screenshots

<img src="public/poster/img_02.png" alt="Better GitHub Stars Manager screenshot" width="1672">

## How to Use

1. Install the extension in Chrome as an unpacked MV3 extension.
2. Open the Options page and paste a GitHub personal access token.
3. Visit your GitHub stars page: `https://github.com/{you}?tab=stars`.
4. Run **Sync** to import your stars.
5. Search, filter, tag, and add notes as you review repositories.
6. Use **Push** and **Pull** if you want your annotations to travel across devices.

## Install

```bash
pnpm install
pnpm build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder
5. Open the extension **Options** page
6. Create a GitHub token with the permissions below
7. Paste the token into Options and click **Save & verify**

### Token setup

Step 1: Create a **fine-grained personal access token** and click **Generate new token**.

![Create a fine-grained token](public/tutorial/img_01.png)

Step 2: For repository access, choose **Public repositories**.

![Choose repository access](public/tutorial/img_02.png)

Step 3: Add **Gists: read and write** so cross-device sync can work.

![Grant Gists permission](public/tutorial/img_03.png)

Recommended GitHub token permissions:

- **Public Repositories (read)**
- **Gists (read/write)**

> Fine-grained token Gist permissions are account-level (they cannot be scoped per gist). The extension creates a dedicated secret gist for sync.

## Privacy and Storage

The extension is designed to keep the heavy data local and sync only the personal annotation layer.

- Star metadata is stored locally in IndexedDB.
- Lightweight config lives in `chrome.storage.local`.
- Tags, notes, and tag metadata can be stored in a dedicated secret Gist under your own GitHub account.

Push / Pull only sync your annotation layer:

- `Push` uploads tags, notes, and tag metadata to your private Gist.
- `Pull` merges the latest tags, notes, and tag metadata back into the local database.
- Star metadata itself stays local and is always reconstructed from GitHub.

There is no custom backend and no separate app account.

For a store-ready privacy statement, see [docs/privacy-policy.md](docs/privacy-policy.md).

## Development

- Build: `pnpm build`
- Test: `pnpm test`
- Package release zip: `pnpm package:extension`

## License

MIT — see [LICENSE](./LICENSE).

Copyright (c) 2026 izumi0uu.

## Contributing

Issues and PRs are welcome at [the repository](https://github.com/izumi0uu/better-github-stars-manager/issues).
