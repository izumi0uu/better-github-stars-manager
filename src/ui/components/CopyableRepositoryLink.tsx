import { useEffect, useRef, useState } from 'react';
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  MouseEvent,
  ReactNode,
} from 'react';
import { Copy } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ManagerLinkResource } from '@/runtime/manager-runtime';
import { useOptionalManagerRuntime } from '@/ui/manager-runtime-context';
import { ActionIcon } from '@/ui/shadcn/action-icon';
import { Button } from '@/ui/shadcn/button';
import { SuccessCheck } from '@/ui/shadcn/success-check';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/shadcn/tooltip';
import { ManagerResourceLink } from '@/ui/components/ManagerResource';

/** How long the copied success state stays visible before reverting to the copy icon. */
const COPY_SUCCESS_MS = 2000;

export type CopyableRepositoryLinkProps = Readonly<{
  resource: ManagerLinkResource;
  children: ReactNode;
  /** Disables the copy control (mirrors the owning overlay's interaction lock). */
  disabled?: boolean;
  /** Classes for the repository anchor. */
  linkClassName?: string;
  /** Extra anchor props (stopPropagation handlers, locked-anchor props, title, …). */
  linkProps?: AnchorHTMLAttributes<HTMLAnchorElement>;
  /** Extra copy-button props. */
  copyProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}> & Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'resource'>;

/**
 * Repository link rendered next to an icon-only copy control for drawer/popup
 * surfaces. Clicking the control copies the complete resolved repository URL
 * (never the display label), briefly swaps in a localized success status, and
 * never claims success when the runtime blocks the link or the clipboard write
 * fails. The success timer is bounded and cleared on unmount or on the next
 * copy attempt.
 */
export function CopyableRepositoryLink({
  resource,
  children,
  disabled = false,
  className,
  linkClassName,
  linkProps,
  copyProps,
  ...wrapperProps
}: CopyableRepositoryLinkProps) {
  const { m } = useI18n();
  const runtime = useOptionalManagerRuntime();
  const policy = runtime?.resources;
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  const copyUrl = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    const href = policy ? policy.resolveLink(resource) : resource.remoteUrl;
    if (!href || !navigator.clipboard?.writeText) {
      setCopied(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        setCopied(false);
      }, COPY_SUCCESS_MS);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span {...wrapperProps} className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <ManagerResourceLink {...linkProps} resource={resource} className={linkClassName}>
        {children}
      </ManagerResourceLink>
      <TooltipProvider delayDuration={300} skipDelayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              {...copyProps}
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled || copyProps?.disabled === true}
              aria-label={copied ? m.common.copied : m.common.copyRepository}
              title={copied ? m.common.copied : m.common.copyRepository}
              onClick={(event) => void copyUrl(event)}
              className={cn(
                'size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                copyProps?.className,
              )}
            >
              <ActionIcon phase={copied ? 'copied' : 'idle'}>
                {copied ? <SuccessCheck aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
              </ActionIcon>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copied ? m.common.copied : m.common.copyRepository}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span
        role="status"
        aria-live="polite"
        className={cn('shrink-0 text-[11px] font-medium text-foreground', { 'sr-only': !copied })}
      >
        {copied ? m.common.copied : ''}
      </span>
    </span>
  );
}
