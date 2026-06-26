/**
 * Session-local panel-visibility state, shared between the stars-page content
 * script (which owns the actual mount/unmount) and the React ManagerPanel
 * (whose toolbar "hide panel" button triggers a hide).
 *
 * This module is deliberately SIDE-EFFECT-FREE: it only holds state and
 * dispatches a registered callback. The content-script entry registers its
 * `sync()` as that callback (via `onPanelToggle`) and performs the real
 * panel/FAB DOM work. Keeping the state here — rather than exporting a function
 * from the content-script entry — means ManagerPanel can `import { hidePanel }`
 * WITHOUT re-running the entry's top-level side effects (initial `sync()` +
 * navigation listeners), which would otherwise double-mount.
 *
 * The flag is NOT persisted (see the content-script header): refresh / re-entry
 * always lands on the panel.
 */
let enabledOverride: boolean | null = null;
let dispatch = (): void => {};

export function isPanelEnabled(defaultEnabled = true): boolean {
  return enabledOverride ?? defaultEnabled;
}

/** Register the effect that actually re-evaluates panel/fab visibility. */
export function onPanelToggle(fn: () => void): void {
  dispatch = fn;
}

/** Retract the panel overlay (toolbar "hide panel"). Session-local. */
export function hidePanel(): void {
  enabledOverride = false;
  dispatch();
}

/** Re-mount the panel overlay (FAB "show panel"). Session-local. */
export function showPanel(): void {
  enabledOverride = true;
  dispatch();
}

export function resetPanelToggle(): void {
  enabledOverride = null;
}
