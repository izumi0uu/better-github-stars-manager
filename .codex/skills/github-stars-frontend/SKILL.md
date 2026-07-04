---
name: github-stars-frontend
description: Project-specific frontend rules for the GitHub Stars Manager extension. Use when implementing, refactoring, reviewing, or debugging UI code in src/ui, src/content, src/popup, or src/options; when changing Tailwind/shadcn styles, theme tokens, motion, layout editing, shadow-root portals, React component boundaries, or front-end tests.
---

# GitHub Stars Frontend

## Purpose

Apply this repo's frontend conventions before changing UI code. Keep changes scoped, shadow-root safe, theme-token based, and verified with the project's required checks.

## First Pass

1. Inspect the relevant existing component, hook, and style files before editing.
2. Preserve current behavior unless the user explicitly asks to change it.
3. Prefer extracting small behavior hooks or presentational components over growing `ManagerPanel`.
4. Do not add dependencies for UI logic or motion unless the user explicitly asks.
5. Run `pnpm typecheck` after code changes; run targeted tests and `pnpm build` for UI/style changes.

## Architecture Boundaries

- Keep extension entrypoints thin:
  - `src/content/stars-page/index.tsx` mounts the shadow-root panel and imports CSS with `?inline`.
  - `src/popup/index.tsx` and `src/options/index.tsx` import the shared CSS normally.
- Keep `ManagerPanel` as composition/orchestration, not a dumping ground for interaction internals.
- Put reusable UI components in `src/ui/components`.
- Put stateful UI behavior hooks in `src/ui/hooks`.
- Put pure layout or formatting logic in `src/ui/*.ts` and cover it with unit tests.
- Use `src/ui/shadcn/*` primitives before creating new primitives.
- Use `PortalProvider` / `usePortalContainer` for Radix portals that must render inside the shadow root.

## Styling Rules

- This project uses Tailwind v3, `tailwind.config.js`, PostCSS, and `tailwindcss-animate`; do not use Tailwind v4-only patterns such as `@theme inline`.
- Shared CSS entrypoint: `src/ui/styles/index.css`.
- Theme tokens live in `src/ui/styles/theme.css`.
- Motion and animation utilities live in `src/ui/styles/motion.css`.
- Non-motion custom utilities live in `src/ui/styles/utilities.css`.
- Keep custom CSS inside Tailwind layers:
  - `@layer base` for variables and base element rules.
  - `@layer utilities` for project utility classes.
- Define theme tokens for both `:root` and `:host`; `:host` is required for the content-script shadow root.
- Use semantic color classes (`bg-background`, `text-foreground`, `border-border`, `bg-primary`) instead of hardcoded palette classes.
- If adding a new semantic color, update both light and dark CSS variables and map it in `tailwind.config.js`.
- Preserve the GitHub-native black/white theme: `--primary` is the near-black/near-white inversion token.

## Motion Rules

- Use existing motion classes in `src/ui/styles/motion.css` before adding new ones.
- Keep motion subtle and functional: opacity, transform, grid row expansion, caret movement, and token-based color transitions.
- Always include reduced-motion behavior for new animation or transition classes.
- Avoid multiple animation layers fighting on the same element; for icon swaps, use `ActionIcon` and the existing success/spinner primitives.
- For layout editing, preserve these invariants:
  - edit chrome expands with `gsm-edit-chrome-wrap`;
  - hidden tray expands with `gsm-tray-zone`;
  - header controls animate with `gsm-gear-in`;
  - drag ghost uses `gsm-drag-ghost`;
  - restore/drop caret uses `gsm-insert-caret`;
  - column restore flash uses `gsm-flash-col`.

## React Rules

- Keep helper components at module scope when identity matters; do not define child components inside render if remounts would replay animations or reset state.
- Use `cn()` for class merging. Any boolean-driven class inclusion in `cn()`/clsx or `className` must use object syntax, e.g. `cn('base', { 'opacity-50': disabled })`, not `disabled && 'opacity-50'`, `disabled ? 'opacity-50' : ''`, or `active ? 'text-foreground' : 'text-muted-foreground'`.
- Use lucide icons for button affordances when an icon exists.
- Keep buttons icon-led when the action is compact or tool-like.
- Derive render data with `useMemo` only where it prevents meaningful recomputation or stabilizes layout behavior.
- Store transient drag/pointer state in the dedicated hook or refs when it should not trigger broad rerenders.
- Avoid broad prop bags; pass explicit, named callbacks and state.

## Layout Edit Rules

- Pure column layout math belongs in `src/ui/column-layout.ts`.
- Behavior for layout editing belongs in `src/ui/hooks/use-column-layout-editor.ts`.
- Layout edit chrome belongs in `src/ui/components/LayoutEditChrome.tsx`.
- Do not put popover positioning, drag lifecycle, reduced-motion fade timing, or tray restore suppression back into `ManagerPanel`.
- Preserve 01+04 parity when touching layout edit:
  - entering edit mode uses the committed layout immediately;
  - default/custom browsing crossfades without white-screen gaps;
  - reduced motion takes the instant path;
  - column popover stays above content and internal clicks do not close it before action;
  - locked columns cannot hide;
  - hidden tray order is canonical;
  - tray drag-back has the 24px header buffer.

## Shadow Root Rules

- Never move content-script CSS to a normal side-effect import; `?inline` keeps Tailwind preflight inside the shadow root.
- Do not portal Radix popovers, selects, dialogs, or tooltips to `document.body` from the stars page.
- If a popover is custom, anchor it inside the panel root and give it an explicit z-index above table content.
- Keep CSS variables available through `:host`; otherwise light theme can become transparent inside the shadow root.

## Verification

Run the smallest relevant checks, then broaden based on risk:

- Always after code changes: `pnpm typecheck`.
- Layout logic: `pnpm exec vitest run tests/unit/column-layout.test.ts`.
- Shared UI/style changes: `pnpm build`.
- Cross-cutting changes: `pnpm test`.
- CSS refactors: confirm build output has no runtime `@import` if the CSS is consumed with `?inline`.
- Before finishing, run `git diff --check` on changed files.

If browser or screenshot validation is unavailable, say so explicitly and report the checks that did run.
