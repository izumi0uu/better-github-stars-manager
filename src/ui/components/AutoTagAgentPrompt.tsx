import { useEffect, useRef } from 'react';
import { Bot, Tags } from 'lucide-react';
import { useI18n } from '@/i18n';
import { AgentMascot } from '@/ui/components/AgentMascot';
import { Button } from '@/ui/shadcn/button';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function rootActiveElement(node: HTMLElement | null): Element | null {
  const root = node?.getRootNode();
  if (root instanceof Document || root instanceof ShadowRoot) return root.activeElement;
  return document.activeElement;
}

export function AutoTagAgentPrompt({
  open,
  onChooseAgent,
  onChooseAutoTags,
  onDismiss,
}: {
  open: boolean;
  onChooseAgent: () => void;
  onChooseAutoTags: () => void;
  onDismiss: () => void;
}) {
  const { m } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const activeElement = rootActiveElement(dialogRef.current);
    const restoreFocus = activeElement instanceof HTMLElement
      ? activeElement
      : null;
    primaryActionRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
      const first = focusable[0];
      const last = focusable.at(-1);
      const current = rootActiveElement(dialogRef.current);
      if (!first || !last) return;
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      restoreFocus?.focus();
    };
  }, [onDismiss, open]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-[calc(var(--gsm-z-overlay)+1)] grid place-items-center bg-background/55 px-4" data-testid="auto-tag-agent-prompt">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gsm-auto-tag-agent-title"
        aria-describedby="gsm-auto-tag-agent-description"
        className="w-full max-w-[420px] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
      >
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
            <AgentMascot state="compacting" />
          </div>
          <div className="min-w-0">
            <h2 id="gsm-auto-tag-agent-title" className="text-sm font-semibold leading-snug">
              {m.manager.autoTagAgentPromptTitle}
            </h2>
            <p id="gsm-auto-tag-agent-description" className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
              {m.manager.autoTagAgentPromptBody}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onChooseAutoTags}>
            <Tags data-icon="inline-start" />
            {m.manager.autoTagAgentPromptNo}
          </Button>
          <Button ref={primaryActionRef} onClick={onChooseAgent}>
            <Bot data-icon="inline-start" />
            {m.manager.autoTagAgentPromptYes}
          </Button>
        </div>
      </div>
    </div>
  );
}
