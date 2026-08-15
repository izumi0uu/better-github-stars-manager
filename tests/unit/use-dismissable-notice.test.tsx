/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useDismissableNotice } from '@/ui/hooks/use-dismissable-notice';
import { cleanupMountedRootsAndBody } from './test-utils';

const mountedRoots: Root[] = [];

/** Renders the hook through a probe component and records every render's dismissed flag. */
function renderProbe(dismissable: boolean) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const renders: { dismissed: boolean }[] = [];
  const update = (next: boolean) => act(() => root.render(
    <Probe dismissable={next} renders={renders} />,
  ));
  update(dismissable);
  return { container, root, renders, update };
}

function Probe({
  dismissable,
  renders,
}: {
  dismissable: boolean;
  renders: { dismissed: boolean }[];
}) {
  const { dismissed, dismiss } = useDismissableNotice(dismissable);
  renders.push({ dismissed });
  if (dismissed) return <span data-dismissed />;
  return <button onClick={dismiss}>close</button>;
}

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
});

describe('useDismissableNotice', () => {
  it('stays dismissed while the notice condition persists', async () => {
    const probe = renderProbe(true);
    expect(probe.renders.at(-1)?.dismissed).toBe(false);
    expect(probe.container.querySelector('button')).not.toBeNull();

    await act(async () => { probe.container.querySelector('button')?.click(); });

    expect(probe.renders.at(-1)?.dismissed).toBe(true);
    expect(probe.container.querySelector('[data-dismissed]')).not.toBeNull();
  });

  it('resets the dismissal once the notice condition leaves and reappears', async () => {
    const probe = renderProbe(true);
    await act(async () => { probe.container.querySelector('button')?.click(); });
    expect(probe.renders.at(-1)?.dismissed).toBe(true);

    probe.update(false);
    expect(probe.renders.at(-1)?.dismissed).toBe(false);

    probe.update(true);
    expect(probe.renders.at(-1)?.dismissed).toBe(false);
    expect(probe.container.querySelector('button')).not.toBeNull();
  });

  it('never hides a non-dismissable notice', async () => {
    const probe = renderProbe(false);
    expect(probe.renders.at(-1)?.dismissed).toBe(false);
    await act(async () => { probe.container.querySelector('button')?.click(); });
    expect(probe.renders.at(-1)?.dismissed).toBe(false);
    expect(probe.container.querySelector('[data-dismissed]')).toBeNull();
  });
});
