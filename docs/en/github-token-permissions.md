# GitHub token permissions

[简体中文](../zh/github-token-permissions.md)

This guide covers the GitHub credentials used by Better GitHub Stars Manager. Cubby uses a separate AI service credential, described below.

Last checked against the GitHub documentation: 2026-08-11.

## Recommended setup

Use two credentials. This keeps the main connection fine-grained and limits the classic token to Notifications.

### Main connection: fine-grained PAT

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with these settings:

| Setting | Value |
| --- | --- |
| Resource owner | Your personal GitHub account |
| Repository access | Public repositories |
| Account permission: Starring | Read and write |
| Account permission: Gists | Read and write |
| Account permission: Watching | Read-only |

Leave every other permission at `No access`. You do not need to grant access to private repositories.

GitHub grants the Gists permission at account level, so a fine-grained PAT cannot be limited to one Gist. The extension creates one dedicated secret Gist for annotation sync.

The permissions map to the extension as follows:

| Permission | GitHub API used by the extension | Feature |
| --- | --- | --- |
| Starring: read | `GET /user/starred` | Initial sync, incremental sync, and full rescan |
| Starring: write | `DELETE /user/starred/{owner}/{repo}` | Unstar from the manager |
| Gists: read and write | `/gists` endpoints | Push and pull tags, notes, and tag metadata |
| Watching: read | `GET /user/subscriptions` | Find watched repositories that are also in the current starred library |
| Public repository access | Public repository, code search, contents, and Git blob endpoints | Read public metadata and bounded public code when you ask Cubby to search code |

`Save & verify` checks the account, reads one page of stars, creates a temporary secret Gist, deletes it, and checks Watching access. The Gist probe confirms both write and cleanup access. The extension does not test Unstar during setup because that would change your GitHub account, so keep Starring set to read and write.

### Watch Inbox: classic PAT

GitHub's Notifications REST API currently accepts personal access tokens (classic), not fine-grained PATs. Create a [classic personal access token](https://github.com/settings/tokens/new) for the same GitHub account and select only:

```text
notifications
```

Do not add `repo`, `gist`, `user`, or `workflow` to this token. The `notifications` scope is enough to read the Inbox and is narrower than `repo`.

Connect the main token first. In Options, choose `Set up Watch Inbox`. The extension tests the main credential before showing the classic PAT fallback. A fine-grained main token will normally need this fallback; a compatible classic main token can be reused.

The dedicated token must belong to the same GitHub account as the main connection. The extension rejects an account mismatch.

## One-token alternative

If you want one credential instead of the recommended two-token setup, use a classic PAT with:

```text
public_repo
gist
notifications
```

This covers the extension's GitHub features, including Unstar, Gist sync, Watching, and Notifications. It also grants more access than the extension needs. In particular, `public_repo` includes broad write access to public repositories. Do not select the wider `repo` scope unless you deliberately want the token to access private repositories.

The two-token setup is safer because the main PAT stays fine-grained and the classic PAT has only `notifications`.

## Cubby and AI features

A GitHub token does not authorize Cubby with an AI provider. To use Cubby, configure the provider's API key, Base URL, and model separately in Options. The extension does not send either GitHub token to the selected AI model.

## Verify the setup

1. Paste the main token into `Options > GitHub connection`, then select `Save & verify`.
2. Confirm that the account, Stars, Gist, and Watching checks pass.
3. Open `Options > Watch Inbox` and run its setup.
4. If the main token cannot read Notifications, paste the same-account classic PAT with only `notifications`.
5. Star and Watch a repository on GitHub, open the manager's Watch tab, and refresh the Inbox.

Watch displays GitHub notification threads only for repositories that are both currently starred and watched. Refreshing Watch does not change your GitHub subscription settings.

## Security notes

Treat both tokens as passwords. Give them an expiration date, paste them only into the extension's Options page, and revoke them if they are exposed. GitHub recommends fine-grained PATs when possible and recommends expiration dates for classic PATs.

The extension encrypts GitHub credentials before storing them in `chrome.storage.local`. See the [privacy policy](privacy-policy.md) for storage and data-flow details.

## Official GitHub references

- [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Fine-grained PAT permissions and endpoint mapping](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [Starring REST API](https://docs.github.com/en/rest/activity/starring)
- [Gists REST API](https://docs.github.com/en/rest/gists/gists)
- [Watching REST API](https://docs.github.com/en/rest/activity/watching)
- [Notifications REST API](https://docs.github.com/en/rest/activity/notifications)
- [Classic PAT and OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Code search REST API](https://docs.github.com/en/rest/search/search#search-code)

GitHub has announced the deprecation of the public `GET /users/{username}/subscriptions` endpoint. During the transition, that endpoint remains accessible but may return empty responses; GitHub plans to remove it in a later phase. Better GitHub Stars Manager instead uses the authenticated `GET /user/subscriptions` endpoint, which GitHub's current fine-grained permission table maps to `Watching: read`. See [GitHub's access-restriction announcement](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/).
