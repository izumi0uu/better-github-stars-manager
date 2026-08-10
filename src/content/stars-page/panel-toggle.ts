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
type PanelToggleState = {
  enabledOverride: boolean | null;
  dispatch: () => void;
};

const pageStates = new WeakMap<object, PanelToggleState>();

function stateFor(target: object): PanelToggleState {
  let state = pageStates.get(target);
  if (!state) {
    state = { enabledOverride: null, dispatch: () => {} };
    pageStates.set(target, state);
  }
  return state;
}

export function isPanelEnabled(
  defaultEnabled = true,
  target: object = typeof window === 'undefined' ? globalThis : window,
): boolean {
  return stateFor(target).enabledOverride ?? defaultEnabled;
}

/** Register the effect that actually re-evaluates panel/fab visibility. */
export function onPanelToggle(
  fn: () => void,
  target: object = typeof window === 'undefined' ? globalThis : window,
): void {
  stateFor(target).dispatch = fn;
}

/** Retract the panel overlay (toolbar "hide panel"). Session-local. */
export function hidePanel(
  target: object = typeof window === 'undefined' ? globalThis : window,
): void {
  const state = stateFor(target);
  state.enabledOverride = false;
  state.dispatch();
}

/** Re-mount the panel overlay (FAB "show panel"). Session-local. */
export function showPanel(
  target: object = typeof window === 'undefined' ? globalThis : window,
): void {
  const state = stateFor(target);
  state.enabledOverride = true;
  state.dispatch();
}

export function resetPanelToggle(
  target: object = typeof window === 'undefined' ? globalThis : window,
): void {
  stateFor(target).enabledOverride = null;
}
