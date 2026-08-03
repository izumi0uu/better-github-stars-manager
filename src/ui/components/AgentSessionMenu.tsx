import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, MessagesSquare, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/shadcn/button';
import type { BgsmAgentSessionSummary } from '@/ui/hooks/use-bgsm-agent';

export function AgentSessionMenu({
  sessions,
  activeSessionId,
  disabled,
  onCreate,
  onSwitch,
  onDelete,
}: {
  sessions: readonly BgsmAgentSessionSummary[];
  activeSessionId: string;
  disabled: boolean;
  onCreate: () => boolean;
  onSwitch: (sessionId: string) => boolean;
  onDelete: (sessionId: string) => boolean;
}) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const currentSession = sessions.find((session) => session.id === activeSessionId);
  const currentSessionTitle = sessionLabel(currentSession, m.agentPanel.sessionUntitled);
  const deletingSession = sessionToDelete
    ? sessions.find((session) => session.id === sessionToDelete) ?? null
    : null;

  const close = (restoreFocus = false) => {
    setSessionToDelete(null);
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => toggleRef.current?.focus());
  };

  useEffect(() => {
    if (!disabled) return;
    setSessionToDelete(null);
    setOpen(false);
  }, [disabled]);

  return (
    <div
      className="relative shrink-0"
      onKeyDownCapture={(event) => {
        if (!open || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }}
    >
      <Button
        ref={toggleRef}
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => {
          if (disabled) return;
          setSessionToDelete(null);
          setOpen((openState) => !openState);
        }}
        disabled={disabled}
        aria-label={m.agentPanel.sessionsLabel}
        aria-expanded={open}
        aria-controls="agent-session-list"
        title={currentSessionTitle}
        data-testid="agent-session-toggle"
      >
        <MessagesSquare className="size-4" />
      </Button>
      {open && !disabled && (
        <div
          className="absolute right-0 top-10 z-20 w-[min(300px,calc(100vw-32px))] overflow-hidden rounded-md border border-border bg-card p-1.5 shadow-lg"
          id="agent-session-list"
          data-testid="agent-session-list"
          role="dialog"
          aria-label={m.agentPanel.sessionsLabel}
        >
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
            <span>{m.agentPanel.sessionsLabel}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => {
                if (onCreate()) close();
              }}
              aria-label={m.agentPanel.startNewConversation}
            >
              <MessageSquarePlus className="size-3.5" data-icon="inline-start" />
              {m.agentPanel.startNewConversation}
            </Button>
          </div>
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {sessions.map((session) => {
              const title = sessionLabel(session, m.agentPanel.sessionUntitled);
              const isCurrent = session.id === activeSessionId;
              return (
                <div
                  key={session.id}
                  className={cn('flex items-center gap-1 rounded-sm px-1', {
                    'bg-accent': isCurrent,
                  })}
                  data-testid="agent-session-item"
                  data-session-id={session.id}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate rounded-sm px-1.5 py-1.5 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => {
                      if (onSwitch(session.id)) close();
                    }}
                  >
                    {title}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setSessionToDelete(session.id)}
                    disabled={sessions.length <= 1}
                    aria-label={`${m.agentPanel.sessionDelete}: ${title}`}
                    title={m.agentPanel.sessionDelete}
                    data-testid="agent-session-delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
          {deletingSession && (
            <div
              className="mt-1.5 border-t border-border px-2 pb-1 pt-2"
              data-testid="agent-session-delete-confirm"
              role="alertdialog"
              aria-label={m.agentPanel.sessionDeleteTitle}
              aria-describedby="agent-session-delete-message"
            >
              <div className="text-xs font-medium text-foreground">{m.agentPanel.sessionDeleteTitle}</div>
              <p id="agent-session-delete-message" className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {m.agentPanel.sessionDeleteMessage(
                  sessionLabel(deletingSession, m.agentPanel.sessionUntitled),
                )}
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setSessionToDelete(null)}
                >
                  {m.agentPanel.sessionDeleteCancel}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    if (onDelete(deletingSession.id)) close();
                  }}
                >
                  {m.agentPanel.sessionDeleteConfirm}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function sessionLabel(
  session: Pick<BgsmAgentSessionSummary, 'title'> | undefined,
  fallback: string,
): string {
  return session?.title || fallback;
}
