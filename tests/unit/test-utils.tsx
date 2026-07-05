import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/ui/shadcn/tooltip';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type MountedRoot = Root;

export function mountReact(element: ReactElement, mountedRoots: MountedRoot[]): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mountedRoots.push(root);
  return container;
}

export function mountWithTooltipProvider(
  element: ReactElement,
  mountedRoots: MountedRoot[],
): HTMLDivElement {
  return mountReact(<TooltipProvider>{element}</TooltipProvider>, mountedRoots);
}

export function cleanupMountedRoots(mountedRoots: MountedRoot[]) {
  act(() => {
    for (const root of mountedRoots) root.unmount();
    mountedRoots.length = 0;
  });
}

export function cleanupMountedRootsAndBody(mountedRoots: MountedRoot[]) {
  cleanupMountedRoots(mountedRoots);
  document.body.replaceChildren();
}

export async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

export async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}
