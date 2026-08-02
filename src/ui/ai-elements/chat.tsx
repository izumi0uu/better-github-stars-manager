import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode, TextareaHTMLAttributes } from 'react';
import { ArrowDown } from 'lucide-react';
import { Button } from '@/ui/shadcn/button';
import { Textarea } from '@/ui/shadcn/textarea';
import { cn } from '@/lib/utils';

export function Conversation({
  active = true,
  scrollKey,
  resumeLabel,
  className,
  children,
}: {
  active?: boolean;
  scrollKey: string | number;
  resumeLabel: string;
  className?: string;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const followsTailRef = useRef(true);
  const [showResume, setShowResume] = useState(false);

  useEffect(() => {
    if (!active || !followsTailRef.current) return;
    tailRef.current?.scrollIntoView({ block: 'end' });
    setShowResume(false);
  }, [active, scrollKey]);

  return (
    <div className={cn('relative flex min-h-0 flex-1', className)}>
      <div
        ref={viewportRef}
        className="gsm-scrollbar-stable min-h-0 flex-1 scroll-smooth overflow-auto px-3 py-3 motion-reduce:scroll-auto"
        onScroll={() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          const followsTail = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
          followsTailRef.current = followsTail;
          setShowResume(!followsTail);
        }}
      >
        <div className="flex flex-col gap-3">
          {children}
          <div ref={tailRef} aria-hidden="true" />
        </div>
      </div>
      {showResume && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-sm"
          data-testid="conversation-resume-follow"
          onClick={() => {
            followsTailRef.current = true;
            setShowResume(false);
            tailRef.current?.scrollIntoView({ block: 'end' });
          }}
        >
          <ArrowDown className="size-3.5" data-icon="inline-start" />
          {resumeLabel}
        </Button>
      )}
    </div>
  );
}

export function Message({
  role,
  children,
  className,
}: {
  role: 'assistant' | 'user' | 'system';
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex w-full',
        {
          'justify-end': role === 'user',
          'justify-start': role !== 'user',
        },
        className,
      )}
      data-role={role}
    >
      <div
        className={cn(
          'gsm-agent-message-bubble rounded-lg px-3 py-2 text-sm leading-5',
          {
            'max-w-[88%] bg-primary text-primary-foreground': role === 'user',
            'max-w-[88%] border border-border bg-background text-foreground': role === 'assistant',
            'w-full max-w-none border-0 bg-transparent p-0 text-foreground shadow-none': role === 'system',
          },
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function MessageContent({ children }: { children: ReactNode }) {
  return <div className="whitespace-pre-wrap">{children}</div>;
}

export function PromptInput({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  disabled,
  submitDisabled,
  submitLabel,
  submitVariant = 'default',
  inputLabel,
  note,
  actions,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  submitLabel: string;
  submitVariant?: 'default' | 'outline';
  inputLabel: string;
  note?: string;
  actions?: ReactNode;
}) {
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form className="border-t border-border bg-card px-3 pb-3 pt-2.5" onSubmit={handleSubmit}>
      {note ? (
        <div className="mb-1.5 text-[11px] leading-4 text-muted-foreground">{note}</div>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          value={value}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onSubmit();
          }}
          placeholder={placeholder}
          aria-label={inputLabel}
          disabled={disabled}
          rows={3}
          className="max-h-28 min-h-16 flex-1 resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-none focus-visible:ring-1"
        />
        {actions}
        <Button
          type="submit"
          variant={submitVariant}
          size="sm"
          className="h-8 min-w-14 shrink-0 px-3 text-xs font-semibold"
          disabled={disabled || submitDisabled || value.trim().length === 0}
          aria-label={submitLabel}
          title={submitLabel}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export type PromptInputTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;
