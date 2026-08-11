# DAP Handoff Guidelines

[简体中文](../zh/dap-handoff-guidelines.md)

This project uses DAP handoff documents as debugging contracts for modules where
plain tests are not enough to explain failures. A DAP handoff should tell a
debugging agent what invariant to probe, which fixture exposes the issue, where
to stop, and what evidence to return.

DAP is a microscope, not the discovery engine. Start from a named invariant and
a deterministic fixture before attaching a debugger.

## When To Write One

Write a DAP handoff for new modules or changes that involve:

- State machines: sync, backfill, onboarding, queue runners, layout editing.
- Async races: storage changes, background jobs, content-script navigation,
  GitHub Turbo/PJAX events, debounced UI state.
- Data safety: auth tokens, Gist sync, IndexedDB writes, migrations, backfills.
- Cross-boundary behavior: React UI, shadow root, content script, background
  service worker, storage, and message passing.
- Complex UI mechanics: popovers, portals, drag, resize, layout mode changes,
  and interaction layers that can be visually correct but statefully wrong.
- Any module that will be handed to a DAP/debugger/QA agent for independent
  investigation.

Usually skip it for:

- Copy-only changes.
- Small visual polish with no state transition.
- Pure functions that already have direct regression coverage.
- Renames, type-only edits, or mechanical refactors.

## Priority Levels

- P0: data integrity, credentials, sync, persistence, remote writes. A handoff is
  required.
- P1: query behavior, local annotations, upgrades, core interaction flows. A
  handoff is strongly recommended.
- P2: onboarding, i18n, content lifecycle, portals, shadow-root behavior, and
  experience stability. Write one when behavior crosses boundaries or is likely
  to regress.
- P3: isolated visual details. Prefer normal tests or screenshots unless the
  problem repeats.

## Required Shape

Use this compact structure:

```text
# DAP Agent Handoff: <Module> <Priority> Probe Plan

## Requirements Summary
What the DAP agent should diagnose. State clearly that this is diagnostic, not
an implementation plan.

## Delivery Location
Repository path and plan path.

## Diagnostic Edit Permission
Allowed test-only edits and forbidden product-source edits.

## System Invariants
Rules that must always hold.

## Phase Contract Map
Pipeline stages and the file/function responsible for each stage.

## Fixture Matrix
Small deterministic scenarios that can expose divergence.

## DAP Breakpoint And Watchpoint List
Exact files/functions and values to watch.

## Execution Procedure
Smallest test command first, then DAP only after a fixture fails or looks
suspicious.

## Evidence Package Format
What the DAP agent must return.

## Acceptance Criteria
What coverage makes the diagnostic complete.

## Risks And Mitigations
Known blind spots and how to avoid false conclusions.
```

## Evidence Rules

A good DAP handoff should make the agent return:

- Fixture/test name and command.
- The invariant under test.
- Input state and event order.
- Expected vs actual state/output.
- First divergent breakpoint with watch values.
- Whether product source changed; normally this should be `no`.
- Root-cause hypothesis with confidence.

Do not accept "I stepped through it and it looked fine" as evidence. The handoff
must tie debugger observations back to a named fixture and invariant.

## Naming

Use a descriptive filename that includes the module and priority, for example:

- `dap-github-stars-sync-handoff.md`
- `dap-auth-token-probe-handoff.md`
- `dap-backfill-upgrade-handoff.md`
- `dap-query-filter-cache-handoff.md`
- `dap-onboarding-first-run-handoff.md`
- `dap-content-script-mount-toggle-handoff.md`
- `dap-portal-shadow-primitives-handoff.md`
- `dap-i18n-catalog-locale-handoff.md`
