import {
  forwardRef,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type {
  ManagerImageResource,
  ManagerLinkResource,
} from '@/runtime/manager-runtime';
import { useOptionalManagerRuntime } from '@/ui/manager-runtime-context';

export function useManagerImage(resource: ManagerImageResource): string | null {
  const runtime = useOptionalManagerRuntime();
  return runtime ? runtime.resources.resolveImage(resource) : resource.remoteUrl;
}

type ManagerResourceLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'resource'> & {
  resource: ManagerLinkResource;
  children: ReactNode;
};

export const ManagerResourceLink = forwardRef<HTMLAnchorElement, ManagerResourceLinkProps>(
  function ManagerResourceLink({ resource, children, onClick, target = '_blank', rel = 'noreferrer', ...props }, ref) {
    const runtime = useOptionalManagerRuntime();
    const policy = runtime?.resources;
    const href = policy ? policy.resolveLink(resource) : resource.remoteUrl;
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (href) return;
      event.preventDefault();
      policy?.onBlockedLink(resource);
    };
    return (
      <a
        {...props}
        ref={ref}
        href={href ?? '#'}
        target={href ? target : undefined}
        rel={href ? rel : undefined}
        onClick={handleClick}
      >
        {children}
      </a>
    );
  },
);
