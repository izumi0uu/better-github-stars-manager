# GitHub Stars Manager Agent Guide

Keep this file short and practical. Add rules here only when they are core to the repo or fix a repeated mistake.

## Scope

- This repo is a Chrome extension that augments the GitHub Stars page with local search, filters, sorting, tags, notes, and sync helpers.
- Prefer repo-specific facts over generic browser-extension assumptions.
- If an API behavior is unclear or recently changed, check official docs before editing code.

## Key Paths

- `src/storage/db.ts`: IndexedDB schema and version bumps.
- `src/types/index.ts`: shared domain types and config shape.
- `src/auth/auth-store.ts`: `chrome.storage.local` config normalization.
- `src/api/github-star-source.ts`: GitHub REST/GraphQL sync logic.
- `src/upgrades/backfill-state.ts` and `src/upgrades/tasks.ts`: one-shot feature/data backfills.
- `src/background/index.ts`: backfill orchestration and sync entrypoints.
- `tests/unit`, `tests/integration`, `tests/regressions`, `tests/runtime`: test layers.

## Source Of Truth

- IndexedDB is the source of truth for bulk repo data and annotations: `stars`, `tags`, `tagMeta`.
- `chrome.storage.local` is only for lightweight config and UI state: token metadata, locale, theme, onboarding, sync progress, backfill state, and user preferences.
- GitHub is the source of truth for repository metadata such as `archived`, `fork`, `pushed_at`, `starred_at`, and release metadata.
- Do not infer remote repo state in the UI when the sync layer can persist the canonical field.

## Data Rules

- UI-only behavior changes do not need a storage upgrade.
- A new lightweight preference in `Config` should be added with a safe default and normalized on read. This usually does not need a DB bump.
- A new persisted field on `Star`, `Tag`, or `TagMeta` requires:
  - updating `src/types/index.ts`
  - bumping Dexie schema in `src/storage/db.ts` if the stored shape changes
  - keeping legacy-row compatibility, usually by treating old `undefined` values as missing
- New remote-derived metadata for existing rows should usually use a feature/data backfill, not an app-version migration.
- Backfills are keyed by capability, not extension version. Once a one-shot backfill is done, it should stay done unless the task definition itself changes.
- Do not run a full sync on every extension update. Full sync is for data completeness gaps that incremental sync or lazy hydration cannot close reliably.

## Upgrade Decision Rules

- Use a Dexie version bump when stored IndexedDB shape or indexes change.
- Use config normalization when only `chrome.storage.local` shape changes.
- Add a backfill task when old local rows are missing data required by a new feature.
- Prefer lazy remote hydration when missing data can be filled gradually without blocking correctness.
- Prefer a full-sync backfill only when the feature needs library-wide consistency and there is no safe incremental path.

## Sync And GitHub API Rules

- Keep incremental sync and rescan aligned with authenticated REST `GET /user/starred`; that endpoint matches the current cursor and tombstone model.
- Use GraphQL full sync when one query can hydrate multiple required fields together across the whole library. Current example: `viewer.starredRepositories` plus `latestRelease`.
- `archived` must come from GitHub metadata (`repo.archived` or GraphQL `isArchived`) and be stored locally; never guess it from UI state.
- Release-date semantics are:
  - prefer release `publishedAt` / `published_at`
  - fall back to `createdAt` / `created_at`
  - do not substitute Git tag time for release time
- Preserve tombstone semantics. By default the product operates on currently starred repos, not historical unstarred rows.
- Keep `StarredRepositoryConnection.isOverLimit` in mind for very large accounts. If completeness matters for a new feature, handle or surface that boundary explicitly.

## GitHub Docs To Trust

- GraphQL overview: `https://docs.github.com/en/graphql`
- GraphQL repositories reference: `https://docs.github.com/en/graphql/reference/repos`
- REST starring endpoints: `https://docs.github.com/v3/activity/starring`
- REST releases endpoints: `https://docs.github.com/rest/releases/releases`
- About releases: `https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases`

## Testing And Done Criteria

- Always run `pnpm typecheck` after code changes.
- Run the smallest relevant test layer first:
  - `pnpm test:logic` for pure logic and filter/sort behavior
  - `pnpm test:integration` for query/store integration
  - `pnpm test:regressions` for sync/storage compatibility changes
  - `pnpm test:runtime` for extension runtime smoke coverage
- Add a regression test when changing sync semantics, storage compatibility, migration/backfill logic, or GitHub data mapping.
- For docs-only changes, code tests are optional.

## Maintenance Of This File

- Keep this file concise. Link to code paths or dedicated docs instead of turning this into a handbook.
- Update this file when the same repo-specific mistake or review comment appears more than once.
