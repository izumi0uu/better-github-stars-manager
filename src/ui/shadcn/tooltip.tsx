import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';
import { usePortalContainer } from './portal-context';

/**
 * shadcn-style Tooltip, portaled into the stars-page shadow root (same pattern
 * as Popover) so the tip inherits the Tailwind theme and doesn't escape onto
 * github.com. Native `title` is unreliable inside the isolated shadow root, so
 * any control that needs a hover hint uses this instead.
 */
const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = ({ children, ...props }: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>) => (
  <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>
);

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => {
  const container = usePortalContainer();
  const content = (
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 max-w-xs overflow-hidden rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md',
        'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        className,
      )}
      {...props}
    />
  );
  // Portal into the shadow root container when available; otherwise let Radix
  // pick (used by popup/options pages outside the shadow).
  return container ? (
    <TooltipPrimitive.Portal container={container}>{content}</TooltipPrimitive.Portal>
  ) : (
    <TooltipPrimitive.Portal>{content}</TooltipPrimitive.Portal>
  );
});
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
