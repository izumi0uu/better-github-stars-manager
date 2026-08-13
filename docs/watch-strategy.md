# How Watch works

This document explains how Watch selects repositories, reads GitHub Notifications, stores a local snapshot, and changes notification state. It also records a current GitHub API risk: the repository-membership endpoint that Watch depends on may lose access. Read the [Chinese version](./watch-strategy.zh-CN.md).

## Purpose and scope

Watch gives you a focused inbox for repositories that you both Star and Watch on GitHub. It groups GitHub notification threads by repository so you can review activity without leaving the Stars workspace.

Watch is not a repository activity feed. It doesn't infer activity from commits, releases, or repository metadata. It also doesn't include notifications from repositories outside your current Stars library.

```mermaid
flowchart LR
  S["Current local Stars"] --> I["Intersect by repository name"]
  W["GitHub watched repositories"] --> I
  N["GitHub Notifications"] --> F["Keep matching threads"]
  I --> F
  F --> C["Account-bound IndexedDB snapshot"]
  C --> U["Repository-grouped Watch inbox"]
```

## What Watch shows

Watch displays normalized GitHub notification threads for repositories in the current intersection. Each row can include:

- repository name
- notification title and subject type
- GitHub's notification reason
- unread state
- update time
- a validated GitHub link

The interface supports **Unread** and **All** views. You can search repository names and titles, filter by reason, and collapse repository groups. New or changed threads reopen a previously collapsed group.

Expanding an Issue or Pull Request can load its details with the main GitHub credential. The detail panel can show state, author, labels, assignees, milestone, comment count, and description. Other subject types keep their notification summary and GitHub link.

## How repository scope is selected

Watch currently treats `GET /user/subscriptions` as the source for your watched repositories. It fetches every page at 100 repositories per page. A failed or malformed page invalidates that refresh, so a partial result never replaces the previous scope.

The extension intersects the complete response with local Stars. It excludes:

- repositories you have unstarred
- local tombstones
- owned repositories that aren't in your current Stars
- notifications from repositories outside the intersection

A successful scope refresh replaces the previous membership atomically. A failed refresh preserves the last successful snapshot and marks it stale.

## How notifications are refreshed

Watch reads `GET /notifications` only when the saved Classic personal access token (PAT) has Notifications access. The request includes `all=true`, so the snapshot can contain read and unread threads. GitHub returns threads newest first.

Each refresh uses these limits and controls:

| Control | Current behavior |
|---|---|
| Page size | 50 threads, the GitHub endpoint maximum |
| Page limit | 10 pages |
| Candidate limit | 500 threads |
| Snapshot boundary | One frozen `before` timestamp per refresh |
| Request timeout | 30s per page |
| Automatic Inbox check | Every minute, subject to GitHub's poll interval |
| Watched-scope check | Every hour |

The extension sends the committed `Last-Modified` value on the first page. A `304 Not Modified` response keeps the cached threads and updates the refresh time. A conditional `200` is treated as a delta and merged by thread ID.

Watch also respects `X-Poll-Interval`. The **Refresh** action makes no network request while the stored cooldown remains active. If more than 500 candidate threads exist, Watch publishes the valid newest window and labels it truncated.

## Notification actions

Watch currently exposes two GitHub Inbox actions:

| Watch action | GitHub request | Result in Watch |
|---|---|---|
| **Mark as read** | `PATCH /notifications/threads/{thread_id}` | Sets the cached row to read |
| **Mark as done** | `DELETE /notifications/threads/{thread_id}` | Removes the cached row |

Both actions change GitHub first. Watch updates IndexedDB only after GitHub succeeds. Repository-level bulk actions target every cached row in that repository, not only rows visible after a local search or reason filter.

GitHub's APIs also support repository subscription changes and thread subscription changes. Watch doesn't call those endpoints. Use [GitHub's watched repositories page](https://github.com/watching) to change Watch, Custom, Ignore, and unwatch settings.

Watch also doesn't expose Save, mark-unread, unsubscribe, custom Inbox filters, or the GitHub Done archive. **Mark as done** removes the row from the local Watch projection after GitHub accepts the action.

## Credentials and permissions

The current product uses one encrypted GitHub Classic PAT. Watch depends on:

- `notifications` for notification reads and thread actions
- `repo` for the product's private-repository contract and accessible Issue or Pull Request details

GitHub's Notifications REST API accepts `notifications` or `repo`. The explicit `notifications` scope keeps the optional Watch capability visible in the token setup. Missing Notifications access disables Watch without disabling Stars or Gist sync.

GitHub documents broader powers under `notifications`, including repository watch changes and thread subscription writes. The extension doesn't exercise those powers. Never add broader scopes for Watch.

## Storage and privacy

GitHub remains authoritative for watched membership and notification state. IndexedDB stores an account-bound cache:

- `watchRepositories`: canonical repository names in the current scope
- `watchNotificationThreads`: normalized notification rows
- `watchState`: refresh timestamps, errors, validators, cooldown, counts, and truncation state

Issue and Pull Request details use a bounded in-memory cache and aren't persisted. The main token stays encrypted in `chrome.storage.local`; plaintext exists only in memory.

Watch data never enters tags, tag metadata, the annotation Gist, logs, telemetry, or Cubby by default. Changing the GitHub account clears the old account's Watch cache. Disconnecting Watch clears notification rows and Watch refresh state while preserving Stars and annotations.

## Current GitHub API risk

GitHub announced new Watching API restrictions in July 2026. Its current REST documentation says access to subscriber and subscription listing endpoints will be limited to administrators and collaborators. GitHub also says the public `GET /users/{username}/subscriptions` endpoint is deprecated and may return an empty response before removal.

The announcement names the public user endpoint explicitly, while the Watching overview uses broader wording about subscription listing endpoints. The authenticated `GET /user/subscriptions` endpoint still appears in the reference, but GitHub no longer gives a durable availability guarantee for this product's use case.

This creates a source-of-truth risk for Watch. If `GET /user/subscriptions` returns `403` or an empty list because of platform policy, the extension can't distinguish that result from a real empty watched list.

Use these product rules until GitHub clarifies or replaces the endpoint:

1. Never fall back to `GET /users/{username}/subscriptions`; GitHub has deprecated it.
2. Never scrape `https://github.com/watching` or repository pages.
3. Preserve the last successful scope when GitHub returns an error.
4. Treat a successful empty authenticated response cautiously in product messaging.
5. Don't claim that Watch can always enumerate every repository you watch.

The current implementation atomically accepts a successful empty `GET /user/subscriptions` response. If GitHub starts returning policy-driven empty responses for the authenticated endpoint, that behavior will erase the cached scope. This is a known compatibility gap, not evidence that you stopped watching every repository.

## Future direction

The lowest-risk future design removes the global watched-list dependency. It can use the Notifications feed as the inbox source and intersect those threads directly with current local Stars. That preserves notification triage but changes the product claim: Watch would mean “GitHub Inbox threads for current Stars,” not “all current Stars that you watch.”

A second option checks `GET /repos/{owner}/{repo}/subscription` for selected repositories. It can answer one repository at a time, but a library-wide scan creates one request per Star. The extension must not add that fan-out without explicit limits and rate-limit validation.

Repository subscription writes can be added only as an explicit feature. They must use the existing `notifications` scope, confirm the requested repository, and avoid bulk defaults. They don't solve watched-list discovery.

## Supported and unsupported behavior

| Area | Supported now | Not supported |
|---|---|---|
| Repository scope | Current Stars intersected with authenticated watched membership | Arbitrary repositories or another user's watched list |
| Inbox | Read and unread GitHub threads in a bounded newest window | Complete activity history or GitHub's full Inbox archive |
| Details | Lazy Issue and Pull Request details | Comments, review timeline, commit details, release details, or discussions inline |
| Local filters | Unread/All, title and repository search, reason filters | GitHub custom-filter synchronization |
| Mutations | Mark read and mark done | Save, mark unread, unsubscribe, thread mute, Watch/Custom/Ignore changes |
| Sync | Local account-bound IndexedDB cache | Gist sync, cross-device Watch state, or AI-service export |

## References

- [GitHub REST API endpoints for notifications](https://docs.github.com/en/rest/activity/notifications)
- [GitHub REST API endpoints for watching](https://docs.github.com/en/rest/activity/watching)
- [GitHub notification concepts](https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications)
- [GitHub notification Inbox management](https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox)
- [GitHub's June 30, 2026 Watching access-restrictions announcement](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/)
- [GitHub Classic PAT scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
