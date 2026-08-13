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
- GitHub is the source of truth for repository metadata such as `archived`, `fork`, `pushed_at`, `created_at`, and `starred_at`.
- Do not infer remote repo state in the UI when the sync layer can persist the canonical field.

## Data Rules

- UI-only behavior changes do not need a storage upgrade.
- Unless `package.json` version has already changed in the current worktree, treat new feature work as unreleased. Do not add compatibility code for hypothetical previously shipped users unless the user explicitly says the behavior has already been released.
- Local dev builds and feature-branch experiments are not releases. If an unreleased migration, backfill, or schema change is revised before shipping, edit the existing unreleased upgrade/backfill in place instead of inventing a new version/id just to support local development data.
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
- Keep full sync, incremental sync, and rescan aligned with authenticated REST `GET /user/starred` whenever the required metadata already exists there.
- `archived` must come from GitHub metadata (`repo.archived` or GraphQL `isArchived`) and be stored locally; never guess it from UI state.
- Repository creation time should come from GitHub repo metadata (`created_at` / `createdAt`), not from releases, tags, or first-star heuristics.
- Preserve tombstone semantics. By default the product operates on currently starred repos, not historical unstarred rows.

## GitHub Docs To Trust

- REST starring endpoints: `https://docs.github.com/v3/activity/starring`
- REST repositories endpoints: `https://docs.github.com/rest/repos/repos`

## Privacy And External Context

- Never put personal information in tracked files, including real usernames, names, email addresses, local home-directory paths, account data, tokens, or screenshots and fixtures derived from a personal account. Use synthetic values such as `octocat`, `user@example.com`, and repository-relative paths.
- Never copy issue, pull-request, Jira, support-ticket, chat, or other external-work-item content into product code, tests, fixtures, comments, logs, screenshots, generated artifacts, or documentation. Translate only the necessary requirement into generic product behavior and terminology; keep external identifiers, URLs, customer data, reporter details, and verbatim text out of the repository.
- Before committing, scan every changed tracked artifact, including binary assets and metadata, for personal information and external-work-item residue.

## Testing And Done Criteria

- Always run `pnpm typecheck` after code changes.
- Run the smallest relevant test layer first:
  - `pnpm test:logic` for pure logic and filter/sort behavior
  - `pnpm test:integration` for query/store integration
  - `pnpm test:regressions` for sync/storage compatibility changes
  - `pnpm test:runtime` for extension runtime smoke coverage
- Add a regression test when changing sync semantics, storage compatibility, migration/backfill logic, or GitHub data mapping.
- Name new tests, suites, and replay env prefixes by product surface or behavior, not priority or phase labels. Use names like `query-fuzz`, `tag-store-fuzz`, or `BACKGROUND_RUNNER_FUZZ`.
- For docs-only changes, code tests are optional.

## Comment Rules

- Write comments when they materially improve maintainability.
- Good comments briefly explain what a function or module does, what problem it solves, or the key constraint/invariant behind it.
- Comments should focus on intent, purpose, boundaries, and `why`; avoid line-by-line narration of `what` the next lines already say.
- Prefer one short block comment above the tricky code. Do not add multi-paragraph, sectioned, or doc-style comments inside product code.
- If a comment starts carrying design history, tradeoff analysis, or workflow notes, move that material to tests or docs and leave at most a short pointer.
- During refactors, update or delete stale comments aggressively. A partly true comment is worse than no comment.

## Maintenance Of This File

- Keep this file concise. Link to code paths or dedicated docs instead of turning this into a handbook.
- Update this file when the same repo-specific mistake or review comment appears more than once.
