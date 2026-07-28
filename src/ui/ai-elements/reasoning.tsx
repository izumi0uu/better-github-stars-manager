import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { Brain, ChevronDown } from 'lucide-react';
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useReasoning() {
  const context = useContext(ReasoningContext);
  if (!context) throw new Error('Reasoning components must be used within Reasoning.');
  return context;
}

export type ReasoningProps = ComponentProps<typeof CollapsiblePrimitive.Root> & {
  isStreaming?: boolean;
  duration?: number;
};

export const Reasoning = memo(function Reasoning({
  className,
  isStreaming = false,
  open,
  defaultOpen = true,
  onOpenChange,
  duration,
  children,
  ...props
}: ReasoningProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [hasAutoClosed, setHasAutoClosed] = useState(false);
  const isOpen = open ?? uncontrolledOpen;

  useEffect(() => {
    if (!defaultOpen || isStreaming || !isOpen || hasAutoClosed) return;
    const timer = window.setTimeout(() => {
      setUncontrolledOpen(false);
      onOpenChange?.(false);
      setHasAutoClosed(true);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [defaultOpen, hasAutoClosed, isOpen, isStreaming, onOpenChange]);

  const handleOpenChange = (nextOpen: boolean) => {
    setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  return (
    <ReasoningContext.Provider value={{ isStreaming, isOpen, duration }}>
      <CollapsiblePrimitive.Root
        className={cn('not-prose mb-3', className)}
        open={isOpen}
        onOpenChange={handleOpenChange}
        {...props}
      >
        {children}
      </CollapsiblePrimitive.Root>
    </ReasoningContext.Provider>
  );
});

export type ReasoningTriggerProps = ComponentProps<typeof CollapsiblePrimitive.Trigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

export const ReasoningTrigger = memo(function ReasoningTrigger({
  className,
  children,
  getThinkingMessage = defaultGetThinkingMessage,
  ...props
}: ReasoningTriggerProps) {
  const { isStreaming, isOpen, duration } = useReasoning();

  return (
    <CollapsiblePrimitive.Trigger
      className={cn(
        'flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <Brain className="size-4" />
          <span>{getThinkingMessage(isStreaming, duration)}</span>
          <ChevronDown
            className={cn('ml-auto size-4 transition-transform', {
              'rotate-180': isOpen,
            })}
          />
        </>
      )}
    </CollapsiblePrimitive.Trigger>
  );
});

export type ReasoningContentProps = ComponentProps<typeof CollapsiblePrimitive.Content> & {
  children: ReactNode;
};

export const ReasoningContent = memo(function ReasoningContent({
  className,
  children,
  ...props
}: ReasoningContentProps) {
  return (
    <CollapsiblePrimitive.Content
      className={cn(
        'mt-3 whitespace-pre-wrap text-sm leading-5 text-muted-foreground',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2',
        className,
      )}
      {...props}
    >
      {children}
    </CollapsiblePrimitive.Content>
  );
});

function defaultGetThinkingMessage(isStreaming: boolean, duration?: number): ReactNode {
  if (isStreaming || duration === 0) return 'Thinking...';
  if (duration === undefined) return 'Thought for a few seconds';
  return `Thought for ${duration} seconds`;
}
