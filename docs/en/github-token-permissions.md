# GitHub token permissions

[简体中文](../zh/github-token-permissions.md)

This guide covers the single GitHub credential used by Better GitHub Stars Manager. Cubby uses a separate AI-service credential, described below.

Last checked against the GitHub documentation: 2026-08-11.

## Current setup

Use one GitHub **Classic PAT**. The Options page links to a prefilled [Classic PAT form](https://github.com/settings/tokens/new?scopes=repo,gist,notifications,read:user&description=Better%20GitHub%20Stars%20Manager) with this scope set:

```text
repo
gist
notifications
read:user
```

Choose a finite expiration, review the scopes, generate the token, then paste it into `Options > GitHub Classic PAT` and select **Save & verify**.

## Scope-to-feature mapping

| Scope | Requirement | Feature |
| --- | --- | --- |
| `repo` | Required | Stars sync, Star/Unstar, repository metadata, private-repository access, watched-repository membership, and accessible Issue/Pull Request details |
| `gist` | Required | Push and pull tags, notes, favorites, and tag metadata through the extension's private Gist |
| `notifications` | Optional capability | Watch Inbox reads and notification actions |
| `read:user` | Optional capability | Following Radar reads the accounts you follow and their public Star activity |

`repo` is intentionally broad because the current product supports private Stars and repository actions. `public_repo` is not a drop-in replacement for that contract. GitHub grants `gist` at account level; it cannot be restricted to only the extension's Gist.

Do not grant `user`, `user:email`, `user:follow`, `project`, `admin:org`, `workflow`, `delete_repo`, package, key, audit-log, enterprise, or Webhook administration scopes. The extension does not use them.

## Verification behavior

**Save & verify** authenticates the account, reads one page of Stars, creates and deletes a temporary secret Gist, and probes Notifications access. The Gist probe proves both write and cleanup access. Setup does not test Star or Unstar because that would mutate your GitHub account.

Missing `notifications` or `read:user` must disable only Watch Inbox or Following Radar. Stars and Gist remain usable. Following Radar checks its optional capability when that surface loads.

## Credential lifecycle

The product stores one encrypted Classic PAT in `chrome.storage.local`; plaintext exists only in memory. It does not store a second Notifications credential or silently fall back to one.

This is a deliberate credential cutover. A previously stored Fine-grained PAT may require reauthorization. The extension preserves local Stars, tags, notes, and settings and replaces the encrypted value only after the new Classic PAT passes the required checks.

## Cubby and AI features

A GitHub token does not authorize Cubby with an AI provider. To use Cubby, configure the provider's API key, Base URL, and model separately in Options. The extension never sends the GitHub token to the selected AI model.

## Verify the setup

1. Paste the Classic PAT into `Options > GitHub Classic PAT`, then select **Save & verify**.
2. Confirm that the authenticated account appears and the required Stars and Gist checks pass.
3. Open the manager and run **Full Sync**.
4. Open **Watch**. With `notifications`, refresh and confirm that the Inbox shows notifications only for currently starred repositories, with a separate informational count for watched repositories.
5. Open **Following Radar**. With `read:user`, confirm that Following activity loads.

Refreshing Watch does not change your GitHub subscription settings.

## Security notes

Treat the PAT as a password. Give it an expiration date, paste it only into the extension's Options page, and revoke or rotate it if it is exposed.

The extension encrypts the GitHub credential before storing it in `chrome.storage.local`. See the [privacy policy](privacy-policy.md) for storage and data-flow details.

## Official GitHub references

- [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Starring REST API](https://docs.github.com/en/rest/activity/starring)
- [Gists REST API](https://docs.github.com/en/rest/gists/gists)
- [Watching REST API](https://docs.github.com/en/rest/activity/watching)
- [Notifications REST API](https://docs.github.com/en/rest/activity/notifications)
- [Classic PAT and OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Code search REST API](https://docs.github.com/en/rest/search/search#search-code)

GitHub has announced restrictions on Watching endpoints and deprecated the public `GET /users/{username}/subscriptions` endpoint. The authenticated `GET /user/subscriptions` endpoint used by the extension remains documented, but GitHub does not give this use case a durable availability guarantee. Better GitHub Stars Manager treats watched-repository membership as a best-effort snapshot and never uses it to gate Watch Inbox notifications. See the [Watch strategy](watch-strategy.md) and [GitHub's access-restriction announcement](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/).
