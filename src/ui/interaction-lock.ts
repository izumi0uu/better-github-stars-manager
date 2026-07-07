import type { MouseEvent } from 'react';

type LockedRegionProps = {
  'aria-disabled'?: true;
  inert?: boolean;
};

type LockedAnchorProps = {
  'aria-disabled'?: true;
  tabIndex?: -1;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
};

export function getLockedRegionProps(locked: boolean): LockedRegionProps {
  return locked ? { 'aria-disabled': true, inert: true } : {};
}

export function getLockedAnchorProps(locked: boolean): LockedAnchorProps {
  if (!locked) return {};
  return {
    'aria-disabled': true,
    tabIndex: -1,
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

export function isTextEditingTarget(target: EventTarget | null): boolean {
  const tagName = (target as { tagName?: string } | null)?.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA';
}

export function shouldIgnorePanelShortcut(locked: boolean, target: EventTarget | null): boolean {
  return locked || isTextEditingTarget(target);
}
