import type { MouseEvent } from 'react';

type LockedRegionProps = {
  'aria-disabled'?: true;
  inert?: '';
};

type LockedAnchorProps = {
  'aria-disabled'?: true;
  tabIndex?: -1;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
};

export function getLockedRegionProps(locked: boolean): LockedRegionProps {
  return locked ? { 'aria-disabled': true, inert: '' } : {};
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
