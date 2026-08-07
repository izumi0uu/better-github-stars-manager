import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, MessagesSquare, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/shadcn/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import type { BgsmAgentSessionSummary } from '@/ui/hooks/use-bgsm-agent';

export function AgentSessionMenu({
  sessions,
  activeSessionId,
  disabled,
  canCreateSession,
  canSwitchSession,
  canDeleteSession,
  onCreate,
  onSwitch,
  onDelete,
}: {
  sessions: readonly BgsmAgentSessionSummary[];
  activeSessionId: string;
  disabled: boolean;
  canCreateSession: boolean;
  canSwitchSession: boolean;
  canDeleteSession: boolean;
  onCreate: () => Promise<boolean>;
  onSwitch: (sessionId: string) => Promise<boolean>;
  onDelete: (sessionId: string) => Promise<boolean>;
}) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const createRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const currentSession = sessions.find((session) => session.id === activeSessionId);
  const currentSessionTitle = sessionLabel(
    currentSession,
    m.agentPanel.sessionUntitled,
    m.agentPanel.sessionUnavailable,
  );
  const deletingSession = sessionToDelete
    ? sessions.find((session) => session.id === sessionToDelete) ?? null
    : null;

  const close = () => {
    setSessionToDelete(null);
    setOperationError(null);
    setDeleteError(null);
    setOpen(false);
    deleteTriggerRef.current = null;
  };

  const cancelDelete = () => {
    const deleteTrigger = deleteTriggerRef.current;
    setDeleteError(null);
    setSessionToDelete(null);
    queueMicrotask(() => {
      if (deleteTrigger?.isConnected) deleteTrigger.focus();
    });
  };

  useEffect(() => {
    if (!disabled) return;
    setSessionToDelete(null);
    setOperationError(null);
    setDeleteError(null);
    setOpen(false);
    deleteTriggerRef.current = null;
  }, [disabled]);

  useEffect(() => {
    if (!sessionToDelete) return;
    deleteCancelRef.current?.focus();
  }, [sessionToDelete]);

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          if (disabled) return;
          setSessionToDelete(null);
          setOperationError(null);
          setDeleteError(null);
          setOpen(true);
          return;
        }
        close();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={toggleRef}
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled}
          aria-label={m.agentPanel.sessionsLabel}
          aria-controls="agent-session-list"
          title={currentSessionTitle}
          data-testid="agent-session-toggle"
        >
          <MessagesSquare className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        side="bottom"
        sideOffset={8}
        collisionPadding={8}
        className="w-[min(300px,calc(100vw-32px))] overflow-hidden bg-card p-1.5 shadow-lg"
        id="agent-session-list"
        data-testid="agent-session-list"
        role="dialog"
        aria-modal="true"
        aria-label={m.agentPanel.sessionsLabel}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const target = createRef.current?.disabled ? contentRef.current : createRef.current;
          target?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          toggleRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          event.stopPropagation();
          if (!sessionToDelete) return;
          event.preventDefault();
          if (busy) return;
          cancelDelete();
        }}
      >
        <div className="flex items-center justify-between px-2 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
          <span>{m.agentPanel.sessionsLabel}</span>
          <Button
            ref={createRef}
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            disabled={busy || !canCreateSession}
            onClick={async () => {
              setBusy(true);
              setOperationError(null);
              try {
                if (await onCreate()) close();
                else setOperationError(m.agentPanel.sessionOperationFailed);
              } finally {
                setBusy(false);
              }
            }}
            aria-label={m.agentPanel.startNewConversation}
          >
            <MessageSquarePlus className="size-3.5" data-icon="inline-start" />
            {m.agentPanel.startNewConversation}
          </Button>
        </div>
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {sessions.map((session) => {
            const title = sessionLabel(
              session,
              m.agentPanel.sessionUntitled,
              m.agentPanel.sessionUnavailable,
            );
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
                  disabled={busy || !canSwitchSession || session.corrupt === true}
                  onClick={async () => {
                    if (isCurrent) {
                      close();
                      return;
                    }
                    setBusy(true);
                    setOperationError(null);
                    try {
                      if (await onSwitch(session.id)) close();
                      else setOperationError(m.agentPanel.sessionOperationFailed);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {title}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={(event) => {
                    setOperationError(null);
                    setDeleteError(null);
                    deleteTriggerRef.current = event.currentTarget;
                    setSessionToDelete(session.id);
                  }}
                  disabled={busy || !canDeleteSession || sessions.length <= 1}
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
        {operationError && (
          <p className="px-2 pb-1 pt-1 text-[11px] leading-4 text-destructive" role="alert">
            {operationError}
          </p>
        )}
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
                sessionLabel(
                  deletingSession,
                  m.agentPanel.sessionUntitled,
                  m.agentPanel.sessionUnavailable,
                ),
              )}
            </p>
            {deleteError && (
              <p className="mt-1 text-[11px] leading-4 text-destructive" role="alert">
                {deleteError}
              </p>
            )}
            <div className="mt-2 flex justify-end gap-1.5">
              <Button
                ref={deleteCancelRef}
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={busy}
                onClick={cancelDelete}
              >
                {m.agentPanel.sessionDeleteCancel}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={busy || !canDeleteSession}
                onClick={async () => {
                  setBusy(true);
                  try {
                    if (await onDelete(deletingSession.id)) {
                      close();
                    } else {
                      setDeleteError(m.agentPanel.sessionDeleteBlocked);
                    }
                  } catch {
                    setDeleteError(m.agentPanel.sessionDeleteFailed);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {m.agentPanel.sessionDeleteConfirm}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function sessionLabel(
  session: Pick<BgsmAgentSessionSummary, 'title' | 'corrupt'> | undefined,
  fallback: string,
  unavailable: string,
): string {
  if (session?.corrupt) return unavailable;
  return session?.title || fallback;
}
