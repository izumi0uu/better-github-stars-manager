---
name: github-stars-backfill-rules
description: Project-specific storage migration and backfill decision rules for GitHub Stars Manager. Use when adding or reviewing persisted fields, Dexie schema versions, config normalization, one-shot backfill tasks, GitHub metadata hydration, full-sync prompts, storage compatibility, or tests around src/storage, src/upgrades, src/auth, src/background, and related regressions.
---

# GitHub Stars Backfill Rules

## Purpose

Use this skill before changing persisted data shape or data-completeness behavior. Choose the lightest mechanism that preserves correctness: config normalization, Dexie schema bump, lazy hydration, feature backfill, or full sync backfill.

## Source Of Truth

- Treat IndexedDB as source of truth for bulk repo data and annotations: `stars`, `tags`, `tagMeta`.
- Treat `chrome.storage.local` as lightweight config/UI state only: auth metadata, locale/theme, onboarding, sync progress, user preferences, and `backfills`.
- Treat GitHub as source of truth for remote repo metadata such as `archived`, `fork`, `pushed_at`, `created_at`, and `starred_at`.
- Do not infer remote metadata in the UI when sync/storage can persist the canonical value.

## Decision Tree

1. If the change is UI-only, do not add a storage migration or backfill.
2. If only `Config` shape changes, add a safe default and normalize in `src/auth/auth-store.ts`; no Dexie bump.
3. If an IndexedDB stored field or index changes, update `src/types/index.ts`, bump Dexie schema in `src/storage/db.ts`, and treat old `undefined` values as missing data for legacy rows.
4. If old local rows are missing data required by a new feature, prefer a capability-keyed backfill task.
5. If missing data can be filled safely over time without blocking correctness, prefer lazy hydration.
6. Use a full-sync backfill only when the feature requires library-wide consistency and there is no safe incremental/lazy path.
7. If the package version has not already changed in the worktree, treat the feature as unreleased; revise existing unreleased migrations/backfills in place instead of adding compatibility layers for local experiments.

## Backfill Contract

- Key backfills by capability, not extension version, e.g. `repo_data_sync_v1`.
- Once a backfill is `done`, keep it done unless the task definition itself changes.
- Do not reopen a done backfill because later/incremental rows are missing optional data.
- Preserve user deferral: `deferred` must not surface as an active card.
- Preserve failure evidence: keep `error`, `lastAttemptAt`, and retry path.
- Keep `running` stable during an in-flight sync when reconciling with `keepRunning`.
- Add new IDs consistently:
  - `BackfillId` in `src/types/index.ts`;
  - `BACKFILL_IDS` in `src/upgrades/backfill-state.ts`;
  - `backfillTasks` in `src/upgrades/tasks.ts`;
  - execution support in `src/background/index.ts` if the task kind is new;
  - i18n/UI copy if the user sees a new action or message.

## Task Kinds

- `local`: Use for deterministic local-only repairs that do not need GitHub.
- `lazy_remote`: Use when rows can hydrate gradually during normal sync/query paths.
- `full_sync`: Use only for library-wide remote metadata gaps that require authenticated `GET /user/starred` coverage.

Current background execution supports `full_sync`; adding other executable kinds requires explicit background handling and tests.

## Detection Rules

- Make `detectNeed` narrow and cheap enough for status checks.
- Exclude tombstones unless the feature explicitly operates on historical unstarred rows.
- Detect the specific missing capability, not a vague app version.
- Treat legacy `undefined` and current `null` intentionally; tests should cover the distinction when it matters.
- Keep detection independent of UI state.

## Sync Rules

- Keep full sync, incremental sync, and rescan aligned with authenticated REST `GET /user/starred` when required metadata exists there.
- Preserve tombstone semantics; the product normally operates on currently starred repos.
- Do not run a full sync on every extension update.
- Do not add a full-sync backfill for data that can be corrected by incremental sync, rescan, or lazy hydration without user-visible correctness gaps.

## File Checklist

Inspect and update only what the change needs:

- `src/types/index.ts` for persisted domain/config/backfill types.
- `src/storage/db.ts` for Dexie schema versions and indexes.
- `src/auth/auth-store.ts` for config defaults and normalization.
- `src/upgrades/backfill-state.ts` for ID allowlist, normalization, active selection.
- `src/upgrades/tasks.ts` for backfill definitions and reconciliation.
- `src/background/index.ts` for run/defer orchestration and supported task kinds.
- `src/utils/messaging.ts` for status payload normalization.
- `src/ui/ManagerPanel.tsx` and `src/i18n/index.tsx` only when surfaced UI/copy changes.
- `tests/regressions/storage` or relevant sync/auth regression suites for compatibility behavior.

## Testing

- Always run `pnpm typecheck` after code changes.
- For backfill changes, add or update regression tests and run:
  - `pnpm test:regressions` for broad storage/sync compatibility;
  - or the narrow Vitest file if the change is isolated.
- For DB schema/type changes, also run integration or query/store tests that exercise persisted rows.
- For GitHub metadata mapping changes, add sync regression coverage and run the relevant sync regression file.
- Report any verification gap explicitly.

## Review Smells

Flag these before implementation is considered done:

- A backfill keyed by app/package version instead of capability.
- A full sync used as a convenient default.
- A done backfill that can become pending again due to later rows.
- Silent defaults that hide corrupted/missing persisted data without a test.
- UI code guessing metadata that belongs in storage.
- New persisted fields without legacy-row compatibility.
- A Dexie version bump for a config-only preference.
- A new stored shape without a regression test.
