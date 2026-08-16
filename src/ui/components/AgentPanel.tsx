import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CircleStop,
  Eye,
  EyeOff,
  ExternalLink,
  FileCode2,
  ListFilter,
  MessageSquarePlus,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Tags,
  TriangleAlert,
  Unplug,
  Wrench,
  X,
} from 'lucide-react';
import type { LaunchCandidateContract } from '@/bgsm-agent/scope';
import type { BgsmAgentConversationCandidate } from '@/bgsm-agent/conversation-binding';
import {
  BGSM_AGENT_TOOL_NAMES,
  getBgsmAgentToolDefinition,
} from '@/bgsm-agent/tool-catalog';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import { Conversation, Message, MessageContent, PromptInput } from '@/ui/ai-elements/chat';
import { MessageResponse } from '@/ui/ai-elements/response';
import { AgentFunctionMenu } from '@/ui/components/AgentFunctionMenu';
import { AgentMascot } from '@/ui/components/AgentMascot';
import { AgentSessionMenu } from '@/ui/components/AgentSessionMenu';
import { AgentProposalReviewCard } from '@/ui/components/AgentOrganizeReview';
import {
  AgentRunStepper,
  type AgentRunMode,
} from '@/ui/components/AgentRunStepper';
import type { BgsmAgentHookState } from '@/ui/hooks/use-bgsm-agent';
import type { BgsmAgentChatMessage } from '@/ui/bgsm-agent-session-projection';
import type { useBgsmAgentWorkbench } from '@/ui/hooks/use-bgsm-agent-workbench';
import {
  resolveAgentUiPresentation,
  selectOrganizeWorkbenchView,
  type AgentDominantPhase,
  type AgentProgress,
  type OrganizeWorkbenchView,
} from '@/ui/agent-ui-presentation';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
type ChatController = BgsmAgentHookState;
type WorkbenchController = ReturnType<typeof useBgsmAgentWorkbench>;

export function AgentPanel({
  open,
  onHide,
  onOpenOptions,
  agent,
  workbench,
  defaultCandidate,
  blockedConversationCandidate = null,
  scopeCount,
  handoff,
  onDismissHandoff,
}: {
  open: boolean;
  onHide: () => void;
  onOpenOptions?: () => void;
  agent: ChatController;
  workbench: WorkbenchController;
  defaultCandidate: LaunchCandidateContract;
  blockedConversationCandidate?: BgsmAgentConversationCandidate | null;
  scopeCount?: number;
  handoff?: { remainingUntagged: number; autoTagged: number } | null;
  onDismissHandoff?: () => void;
}) {
  const { m } = useI18n();
  const [input, setInput] = useState('');
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onHideRef = useRef(onHide);
  const previousDurableRetryDraftRef = useRef(agent.durableRetryDraft);
  onHideRef.current = onHide;
  const {
    messages,
    running,
    status,
    error: turnError,
    lastTurnResult,
    contextLimitRecovery,
    draftRecovery,
    durableRetryDraft,
    canRetryLastTurn,
    transientSafeResendPrompt,
    errorCategory,
    startTurn,
    stopTurn,
    editContextLimitedPrompt,
    clearTransientSafeResend,
    sessionReady: agentSessionReady,
    sessionOperationPending,
    sessionInitializationError,
    activeSessionId,
    sessions,
    createSession,
    switchSession,
    deleteSession,
    resetConversation,
  } = agent;
  const organize = workbench.state;
  const error = sessionInitializationError ?? turnError;
  const sessionIdentityReady = agentSessionReady && organize.sessionId === activeSessionId;
  const sessionReady = sessionIdentityReady && !sessionOperationPending;
  const organizeView = useMemo(
    () => selectOrganizeWorkbenchView(organize, workbench.displayedProcessed),
    [organize, workbench.displayedProcessed],
  );
  const receiptCounts = organizeView.receiptCounts;
  const reviewFocused = organizeView.phase === 'review_ready';
  const isReadyIdle = !running
    && !organize.snapshot
    && !organize.preflight
    && !organizeView.hasReceipt
    && !error
    && !lastTurnResult
    && !contextLimitRecovery
    && !durableRetryDraft
    && messages.length === 0;
  const showHandoff = !!handoff
    && handoff.remainingUntagged > 0
    && !running
    && !organize.snapshot
    && !organize.preflight
    && !organizeView.hasReceipt
    && !error
    && !contextLimitRecovery
    && !durableRetryDraft
    && messages.length === 0;
  const lastUserPrompt = [...messages].reverse().find((message) => message.role === 'user')?.content ?? null;
  const retryPrompt = durableRetryDraft?.prompt ?? draftRecovery ?? lastFailedPrompt ?? lastUserPrompt;
  const transientSafeResendAllowed = transientSafeResendPrompt !== null
    && input === transientSafeResendPrompt;
  const unsafeReplayBlocked = !canRetryLastTurn
    && !transientSafeResendAllowed
    && !!retryPrompt
    && input.trim() === retryPrompt.trim();
  const uiPresentation = resolveAgentUiPresentation({
    phase: agent.phase,
    hasError: !!error,
    hasContextRecovery: !!contextLimitRecovery,
    unsafeReplayBlocked,
    revisionKey: [
      messages.at(-1)?.id ?? '',
      messages.at(-1)?.content.length ?? 0,
      status?.text ?? '',
      error ?? '',
    ].join(':'),
  }, organizeView);
  const active = uiPresentation.active;
  const showStopbar = uiPresentation.stopbar !== null;
  const createSessionBlocked = !sessionReady || !uiPresentation.sessionPolicy.canCreateSession;
  const switchSessionBlocked = !sessionReady || !uiPresentation.sessionPolicy.canSwitchSession;
  const deleteSessionBlocked = !sessionReady || !uiPresentation.sessionPolicy.canDeleteSession;
  const sessionMenuDisabled = !sessionIdentityReady;
  const conversationSwitchBlocked = blockedConversationCandidate !== null;
  const chatDisabled = !sessionReady
    || uiPresentation.composer.disabled
    || conversationSwitchBlocked;
  const mascotState = uiPresentation.mascot;
  const contextFailureReason = contextLimitRecovery?.reason ?? null;
  const contextNeedsProviderSettings = contextFailureReason === 'capability_unresolved'
    || contextFailureReason === 'provider_context_overflow_repeated'
    || contextFailureReason === 'provider_request_byte_limit_repeated';
  const contextNeedsInternalRetry = contextFailureReason === 'tool_result_memory_limit';
  const contextRecoveryTitle = contextNeedsProviderSettings
    ? m.agentPanel.contextSettingsTitle
    : contextNeedsInternalRetry
      ? m.agentPanel.contextToolMemoryTitle
      : m.agentPanel.contextPromptTooLargeTitle;
  const repositoryCodeReadOnly = useMemo(() => messages.some((message) => (
    message.role === 'tool'
    && getBgsmAgentToolDefinition(message.toolName)?.capability === 'repository_code'
  )), [messages]);
  const isSessionInitializationFailure = sessionInitializationError !== null;

  useEffect(() => {
    if (contextLimitRecovery) setInput(contextLimitRecovery.prompt);
  }, [contextLimitRecovery]);

  useEffect(() => {
    if (draftRecovery) setInput(draftRecovery);
  }, [draftRecovery]);

  useEffect(() => {
    const previousDraft = previousDurableRetryDraftRef.current;
    previousDurableRetryDraftRef.current = durableRetryDraft;
    if (!durableRetryDraft) return;
    // A retry CAS claim changes the same draft from retryable to stop_pending.
    // Keep the composer clear while that claimed attempt is running.
    if (
      previousDraft?.settlement === 'retryable'
      && durableRetryDraft.settlement === 'stop_pending'
      && previousDraft.sessionId === durableRetryDraft.sessionId
      && previousDraft.baseRevision === durableRetryDraft.baseRevision
      && previousDraft.prompt === durableRetryDraft.prompt
    ) return;
    setInput((current) => current.trim() ? current : durableRetryDraft.prompt);
  }, [durableRetryDraft]);

  useEffect(() => {
    if (error && lastUserPrompt) setLastFailedPrompt(lastUserPrompt);
    if (!error && !running) setLastFailedPrompt(null);
  }, [error, lastUserPrompt, running]);

  const focusComposerAtEnd = useCallback(() => {
    queueMicrotask(() => {
      const textarea = drawerRef.current?.querySelector<HTMLTextAreaElement>('textarea');
      if (!textarea) return;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    const activeElement = activeElementFor(drawer) ?? document.activeElement;
    restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    queueMicrotask(() => closeButtonRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onHideRef.current();
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;
      const focusable = [...drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute('inert') && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = activeElementFor(drawer) ?? document.activeElement;
      if (event.shiftKey && (current === first || current === drawer)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      queueMicrotask(() => {
        if (restore?.isConnected) restore.focus();
      });
    };
  }, [open]);

  const runAgentPrompt = useCallback(async (prompt: string, retrySourceAttemptId?: string) => {
    const handoffAuthority = workbench.captureAgentHandoffAuthority();
    const result = await startTurn(
      prompt,
      retrySourceAttemptId ? { retrySourceAttemptId } : undefined,
    );
    if (result?.organizeLibraryHandoff?.type === 'organize_whole_library') {
      // The terminal handoff anchor is durable commit metadata. It is nested in
      // the receipt so a replayed result follows the same message boundary as
      // the original turn, without relying on the transient stream state.
      const handoffAnchor = result.commit?.outcome.handoffAnchor;
      workbench.applyAgentHandoff(
        result.organizeLibraryHandoff,
        handoffAuthority,
        handoffAnchor ?? { messageId: null, createdAt: Date.now() },
      );
    }
    return result;
  }, [startTurn, workbench]);

  const handleInputChange = useCallback((nextInput: string) => {
    if (transientSafeResendPrompt !== null && nextInput !== transientSafeResendPrompt) {
      clearTransientSafeResend();
    }
    setInput(nextInput);
  }, [clearTransientSafeResend, transientSafeResendPrompt]);

  const handlePromptSuggestion = useCallback((prompt: string) => {
    if (!prompt.trim() || chatDisabled) return;
    handleInputChange(prompt);
    focusComposerAtEnd();
  }, [chatDisabled, focusComposerAtEnd, handleInputChange]);

  const handleSubmit = () => {
    if (!input.trim() || chatDisabled || unsafeReplayBlocked) return;
    const prompt = input;
    setInput('');
    void runAgentPrompt(prompt).then((result) => {
      if (!result) setInput((current) => current || prompt);
    });
  };

  const handleRetry = useCallback(() => {
    if (!retryPrompt || chatDisabled || active || !canRetryLastTurn) return;
    setInput('');
    void runAgentPrompt(retryPrompt, durableRetryDraft?.turnAttemptId).then((result) => {
      if (!result) setInput((current) => current || retryPrompt);
    });
  }, [active, canRetryLastTurn, chatDisabled, durableRetryDraft?.turnAttemptId, retryPrompt, runAgentPrompt]);

  const handleEditContextLimitedPrompt = useCallback(() => {
    if (!contextLimitRecovery || active) return;
    editContextLimitedPrompt();
    focusComposerAtEnd();
  }, [active, contextLimitRecovery, editContextLimitedPrompt, focusComposerAtEnd]);

  const handleRetryContextLimitedPrompt = useCallback(() => {
    if (!contextLimitRecovery || active || !canRetryLastTurn || conversationSwitchBlocked) return;
    const prompt = contextLimitRecovery.prompt;
    editContextLimitedPrompt();
    setInput('');
    void runAgentPrompt(
      prompt,
      durableRetryDraft?.prompt.trim() === prompt.trim()
        ? durableRetryDraft.turnAttemptId
        : undefined,
    ).then((result) => {
      if (!result) setInput((current) => current || prompt);
    });
  }, [
    active,
    canRetryLastTurn,
    contextLimitRecovery,
    conversationSwitchBlocked,
    durableRetryDraft,
    editContextLimitedPrompt,
    runAgentPrompt,
  ]);

  const handleOpenContextSettings = useCallback(() => {
    if (contextLimitRecovery) editContextLimitedPrompt();
    onOpenOptions?.();
    focusComposerAtEnd();
  }, [contextLimitRecovery, editContextLimitedPrompt, focusComposerAtEnd, onOpenOptions]);
  const handleResetConversation = useCallback(async () => {
    if (createSessionBlocked) return;
    if (await resetConversation()) {
      setLastFailedPrompt(null);
      setInput('');
      focusComposerAtEnd();
    }
  }, [createSessionBlocked, focusComposerAtEnd, resetConversation]);

  const handleCreateSession = async (): Promise<boolean> => {
    if (createSessionBlocked) return false;
    if (await createSession()) {
      setLastFailedPrompt(null);
      setInput('');
      focusComposerAtEnd();
      return true;
    }
    return false;
  };

  const handleSwitchSession = async (nextSessionId: string): Promise<boolean> => {
    if (switchSessionBlocked || !await switchSession(nextSessionId)) return false;
    setLastFailedPrompt(null);
    setInput('');
    focusComposerAtEnd();
    return true;
  };

  const handleDeleteSession = async (sessionIdToDelete: string): Promise<boolean> => {
    if (deleteSessionBlocked) return false;
    if (await deleteSession(sessionIdToDelete)) {
      setLastFailedPrompt(null);
      focusComposerAtEnd();
      return true;
    }
    return false;
  };

  const motionState = open ? 'open' : 'closed';
  const selectedCount = organizeView.selectedCount;
  const resolvedScopeCount = resolvedScopeCountValue(scopeCount, defaultCandidate);
  const isProviderSetupError = !!error && !!errorCategory && !['provider', 'other'].includes(errorCategory);
  const headerStatus = isSessionInitializationFailure ? null : resolveAgentHeaderStatus({
    phase: uiPresentation.header.kind,
    statusText: status?.text ?? null,
    contextRecoveryTitle,
    analysisProgress: organizeView.analysisProgress,
    applyProgress: organizeView.applyProgress,
    selectedCount,
    receiptCounts,
    showHandoff,
    isProviderSetupError,
    lastTurnChangedCount: lastTurnResult?.changed ? lastTurnResult.changedCount : null,
    m,
  });
  const stateComposerNote = resolveAgentComposerNote({
    mode: uiPresentation.composer.mode,
    organizeView,
    m,
  });
  const blockedConversationLabel = blockedConversationCandidate?.kind === 'selected_repository'
    ? blockedConversationCandidate.selectedRepositoryIdHint
    : blockedConversationCandidate
      ? m.agentPanel.askingAboutCurrentViewUnknown
      : null;
  const composerNote = blockedConversationLabel
    ? m.agentPanel.conversationSwitchPending(blockedConversationLabel)
    : stateComposerNote
    ?? (showHandoff
      ? m.agentPanel.handoffScopeNote(handoff!.remainingUntagged)
      : organize.snapshot
        ? m.agentPanel.frozenScopeNote(organizeView.analysisProgress.total)
        : agent.conversationBinding
          ? agent.conversationBinding.candidateContract.kind === 'selected_repository'
            ? agent.conversationBinding.label
            : m.agentPanel.askingAboutCurrentView(agent.conversationBinding.count)
          : defaultCandidate.kind === 'selected_repository'
            ? defaultCandidate.selectedRepositoryIdHint
            : defaultCandidate.kind === 'current_view'
              ? (typeof resolvedScopeCount === 'number'
                ? m.agentPanel.askingAboutCurrentView(resolvedScopeCount)
                : m.agentPanel.askingAboutCurrentViewUnknown)
              : defaultCandidate.kind === 'still_untagged_after_auto_tags'
                ? m.agentPanel.handoffScopeNote(resolvedScopeCount ?? 0)
                : m.agentPanel.askingAboutAllLiveStars(resolvedScopeCount));
  const composerPlaceholder = reviewFocused
    ? m.agentPanel.reviewFollowUpPlaceholder
    : isReadyIdle && typeof resolvedScopeCount === 'number'
      ? m.agentPanel.chatPlaceholderScoped(resolvedScopeCount)
      : m.agentPanel.chatPlaceholder;
  const stopbarText = uiPresentation.stopbar?.action === 'pause_apply'
    ? m.agentPanel.applyingStopbar
    : uiPresentation.stopbar?.action === 'cancel_preflight'
      ? uiPresentation.dominantPhase === 'scope_starting'
        ? m.agentPanel.workbench.startingAnalysis
        : m.agentPanel.resolvingScopeHeader
      : uiPresentation.stopbar?.action === 'stop_analysis'
        ? m.agentPanel.runContinuesWhileHidden
        : m.agentPanel.runContinuesWhileHidden;
  const handleStopbarAction = () => {
    const action = uiPresentation.stopbar?.action;
    if (action === 'stop_chat') stopTurn();
    if (action === 'cancel_preflight') workbench.cancelPreflight();
    if (action === 'stop_analysis' || action === 'pause_apply') workbench.stop();
  };
  const conversationScrollKey = uiPresentation.scrollKey;

  return (
    <>
      <button
        type="button"
        className="gsm-agent-drawer-scrim absolute inset-0 z-[var(--gsm-z-overlay)] bg-background/45"
        data-state={motionState}
        tabIndex={-1}
        aria-label={m.agentPanel.closeTitle}
        onClick={onHide}
      />
      <aside
        ref={drawerRef}
        className="gsm-agent-drawer absolute inset-y-0 right-0 z-[var(--gsm-z-overlay)] flex w-full max-w-[460px] flex-col border-l border-border bg-card shadow-xl"
        data-state={motionState}
        data-agent-active={active ? 'true' : 'false'}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        aria-labelledby="gsm-agent-dialog-title"
        tabIndex={-1}
        {...(!open ? { inert: '' as const } : {})}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <AgentMascot key={mascotState} state={mascotState} playing={open} />
          <div className="min-w-0 flex-1">
            <div id="gsm-agent-dialog-title" className="text-[13.5px] font-semibold leading-tight text-foreground">{m.agentPanel.title}</div>
            {headerStatus && (
              <>
                <div
                  className="truncate text-[11.5px] text-muted-foreground"
                  data-testid="agent-header-status"
                >
                  {headerStatus}
                </div>
                <div className="sr-only" role="status" aria-live="polite">{headerStatus}</div>
              </>
            )}
          </div>
          <AgentSessionMenu
            sessions={sessions}
            activeSessionId={activeSessionId}
            disabled={sessionMenuDisabled || !open}
            canCreateSession={uiPresentation.sessionPolicy.canCreateSession}
            canSwitchSession={uiPresentation.sessionPolicy.canSwitchSession}
            canDeleteSession={uiPresentation.sessionPolicy.canDeleteSession}
            onCreate={handleCreateSession}
            onSwitch={handleSwitchSession}
            onDelete={handleDeleteSession}
          />
          <Button
            variant="ghost"
            size="icon"
            disabled={createSessionBlocked}
            onClick={handleResetConversation}
            aria-label={m.agentPanel.startNewConversation}
            title={m.agentPanel.startNewConversation}
          >
            <MessageSquarePlus className="size-4" />
          </Button>
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onHide}
            aria-label={active ? m.agentPanel.hideAgent : m.agentPanel.closeTitle}
            title={active ? m.agentPanel.hideAgent : m.agentPanel.closeTitle}
          >
            {active ? <EyeOff className="size-4" /> : <X className="size-4" />}
          </Button>
        </div>

        <>
            <AgentConversationBody
              open={open}
              agent={agent}
              workbench={workbench}
              organizeView={organizeView}
              reviewFocused={reviewFocused}
              active={active}
              chatDisabled={chatDisabled}
              createSessionBlocked={createSessionBlocked}
              conversationSwitchBlocked={conversationSwitchBlocked}
              repositoryCodeReadOnly={repositoryCodeReadOnly}
              isReadyIdle={isReadyIdle}
              showHandoff={showHandoff}
              handoff={handoff}
              onDismissHandoff={onDismissHandoff}
              onOpenOptions={onOpenOptions}
              retryPrompt={retryPrompt}
              scrollKey={conversationScrollKey}
              onPromptSuggestion={handlePromptSuggestion}
              onResetConversation={handleResetConversation}
              onRetry={handleRetry}
              onEditContextLimitedPrompt={handleEditContextLimitedPrompt}
              onRetryContextLimitedPrompt={handleRetryContextLimitedPrompt}
              onOpenContextSettings={handleOpenContextSettings}
            />

            {showStopbar && (
              <div
                className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-3 py-2"
                data-testid="agent-stopbar"
              >
                <span className="text-xs text-muted-foreground">{stopbarText}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStopbarAction}
                >
                  <CircleStop className="size-4" data-icon="inline-start" />
                  {uiPresentation.stopbar?.action === 'cancel_preflight'
                    ? m.agentPanel.cancel
                    : uiPresentation.stopbar?.action === 'pause_apply'
                      ? m.agentPanel.pause
                      : m.agentPanel.stop}
                </Button>
              </div>
            )}

            <PromptInput
              value={input}
              onValueChange={handleInputChange}
              onSubmit={handleSubmit}
              placeholder={composerPlaceholder}
              disabled={chatDisabled}
              submitDisabled={unsafeReplayBlocked}
              submitLabel={m.agentPanel.send}
              submitVariant={reviewFocused ? 'outline' : 'default'}
              inputLabel={m.agentPanel.chatInputLabel}
              note={composerNote}
              actions={(
                <AgentFunctionMenu
                  disabled={chatDisabled}
                  showRepositoryFunctions={defaultCandidate.kind === 'selected_repository'}
                  showWriteFunctions={!repositoryCodeReadOnly}
                  onSummarizeScope={() => handlePromptSuggestion(m.agentPanel.summarizeScopePrompt)}
                  onFindSimilar={() => handlePromptSuggestion(m.agentPanel.findSimilarPrompt)}
                  onOrganizeUntagged={() => handlePromptSuggestion(m.agentPanel.autoAssignPrompt)}
                  onReviewTags={() => handlePromptSuggestion(m.agentPanel.cleanupTagsPrompt)}
                  onSearchCode={() => handlePromptSuggestion(m.agentPanel.searchCodePrompt)}
                  onReviewNotes={() => handlePromptSuggestion(m.agentPanel.reviewNotesPrompt)}
                />
              )}
            />
        </>
      </aside>
    </>
  );
}

type AgentConversationBodyProps = Readonly<{
  open: boolean;
  agent: ChatController;
  workbench: WorkbenchController;
  organizeView: OrganizeWorkbenchView;
  reviewFocused: boolean;
  active: boolean;
  chatDisabled: boolean;
  createSessionBlocked: boolean;
  conversationSwitchBlocked: boolean;
  repositoryCodeReadOnly: boolean;
  isReadyIdle: boolean;
  showHandoff: boolean;
  handoff: { remainingUntagged: number; autoTagged: number } | null | undefined;
  onDismissHandoff: (() => void) | undefined;
  onOpenOptions: (() => void) | undefined;
  retryPrompt: string | null;
  scrollKey: string;
  onPromptSuggestion: (prompt: string) => void;
  onResetConversation: () => void;
  onRetry: () => void;
  onEditContextLimitedPrompt: () => void;
  onRetryContextLimitedPrompt: () => void;
  onOpenContextSettings: () => void;
}>;

const AgentConversationBody = memo(function AgentConversationBody({
  open,
  agent,
  workbench,
  organizeView,
  reviewFocused,
  active,
  chatDisabled,
  createSessionBlocked,
  conversationSwitchBlocked,
  repositoryCodeReadOnly,
  isReadyIdle,
  showHandoff,
  handoff,
  onDismissHandoff,
  onOpenOptions,
  retryPrompt,
  scrollKey,
  onPromptSuggestion,
  onResetConversation,
  onRetry,
  onEditContextLimitedPrompt,
  onRetryContextLimitedPrompt,
  onOpenContextSettings,
}: AgentConversationBodyProps) {
  const { m } = useI18n();
  const [reviewTranscriptOpen, setReviewTranscriptOpen] = useState(false);
  const reviewTranscriptMessageIdRef = useRef<string | null>(null);
  const {
    messages,
    running,
    status,
    error: turnError,
    contextLimitRecovery,
    durableRetryDraft,
    canRetryLastTurn,
    transientSafeResendPrompt,
    toolActivities,
    errorCategory,
    sessionReady: agentSessionReady,
    sessionOperationPending,
    sessionInitializationError,
    sessions,
    hasEarlierMessages,
    loadingEarlierMessages,
    loadEarlierMessages,
    retrySessionHydration,
  } = agent;
  const organize = workbench.state;
  const error = sessionInitializationError ?? turnError;
  const terminalOrganizeJob = organize.organizeJob
    && ['completed', 'cancelled'].includes(organize.organizeJob.status)
    ? organize.organizeJob
    : null;
  const organizeOriginSessionDeleted = !!terminalOrganizeJob && (
    organize.deletedSessionIds.has(terminalOrganizeJob.originAgentSessionId)
    || (
      agentSessionReady
      && !sessions.some((session) => session.id === terminalOrganizeJob.originAgentSessionId)
    )
  );
  const contextFailureReason = contextLimitRecovery?.reason ?? null;
  const contextNeedsProviderSettings = contextFailureReason === 'capability_unresolved'
    || contextFailureReason === 'provider_context_overflow_repeated'
    || contextFailureReason === 'provider_request_byte_limit_repeated';
  const contextNeedsPromptEdit = contextFailureReason === 'current_turn_too_large';
  const contextNeedsInternalRetry = contextFailureReason === 'tool_result_memory_limit';
  const contextRecoveryTitle = contextNeedsProviderSettings
    ? m.agentPanel.contextSettingsTitle
    : contextNeedsInternalRetry
      ? m.agentPanel.contextToolMemoryTitle
      : m.agentPanel.contextPromptTooLargeTitle;
  const contextRecoveryMessage = contextNeedsProviderSettings
    ? m.agentPanel.contextSettingsMessage
    : contextNeedsInternalRetry
      ? canRetryLastTurn
        ? m.agentPanel.contextToolMemoryMessage
        : m.agentPanel.contextToolMemoryWriteBlockedMessage
      : m.agentPanel.contextPromptTooLargeMessage;
  const showProviderErrorCard = (!running || transientSafeResendPrompt !== null)
    && !!error
    && !contextLimitRecovery;
  const isSessionInitializationFailure = sessionInitializationError !== null;
  const isProviderSetupError = !!error && !!errorCategory && !['provider', 'other'].includes(errorCategory);
  const showDurableRetryCard = !!durableRetryDraft
    && !running
    && !turnError
    && !contextLimitRecovery
    && !sessionInitializationError;
  const durableRetryPending = durableRetryDraft?.settlement === 'stop_pending';
  const durableRetryTitle = durableRetryDraft?.kind === 'stopped'
    ? m.agentPanel.retryDraftStoppedTitle
    : durableRetryDraft?.kind === 'context_limit'
      ? m.agentPanel.retryDraftContextTitle
      : m.agentPanel.retryDraftFailedTitle;
  const toolMessages = messages.filter((message) => message.role === 'tool');
  const codeSearchMessages = toolMessages.filter((message) => (
    message.toolName === BGSM_AGENT_TOOL_NAMES.searchRepositoryCode
  ));
  const transcriptMessages = messages.filter((message) => message.role !== 'tool');
  const workbenchAnchor = organize.conversationAnchor;
  const anchoredMessageIndex = workbenchAnchor?.messageId
    ? messages.findIndex((message) => message.id === workbenchAnchor.messageId)
    : -1;
  const messagesBeforeWorkbench = anchoredMessageIndex >= 0
    ? new Set(messages.slice(0, anchoredMessageIndex + 1).map((message) => message.id))
    : null;
  const isBeforeWorkbench = (message: BgsmAgentChatMessage) => messagesBeforeWorkbench
    ? messagesBeforeWorkbench.has(message.id)
    : workbenchAnchor
      ? message.createdAt <= workbenchAnchor.createdAt
      : true;
  const transcriptMessagesBeforeWorkbench = workbenchAnchor === null
    ? transcriptMessages
    : transcriptMessages.filter(isBeforeWorkbench);
  const transcriptMessagesAfterWorkbench = workbenchAnchor === null
    ? []
    : transcriptMessages.filter((message) => !isBeforeWorkbench(message));
  const codeSearchMessagesBeforeWorkbench = workbenchAnchor === null
    ? codeSearchMessages
    : codeSearchMessages.filter(isBeforeWorkbench);
  const codeSearchMessagesAfterWorkbench = workbenchAnchor === null
    ? []
    : codeSearchMessages.filter((message) => !isBeforeWorkbench(message));
  const hasPostWorkbenchTranscript = transcriptMessagesAfterWorkbench.length > 0
    || codeSearchMessagesAfterWorkbench.length > 0;
  const repositoryCodeReadOnlyNoticeAfterWorkbench = codeSearchMessagesAfterWorkbench.length > 0;
  const latestReviewTranscriptMessageId = transcriptMessagesBeforeWorkbench.at(-1)?.id ?? null;

  useEffect(() => {
    const messageChanged = latestReviewTranscriptMessageId !== reviewTranscriptMessageIdRef.current;
    reviewTranscriptMessageIdRef.current = latestReviewTranscriptMessageId;
    if (!reviewFocused) {
      setReviewTranscriptOpen(false);
      return;
    }
    if ((running && !hasPostWorkbenchTranscript) || messageChanged) setReviewTranscriptOpen(true);
  }, [hasPostWorkbenchTranscript, latestReviewTranscriptMessageId, reviewFocused, running]);

  const repositoryCodeReadOnlyNotice = repositoryCodeReadOnly ? (
    <Message role="system">
      <section
        className="flex w-full items-start gap-2 border-l-2 border-border pl-3 text-xs text-muted-foreground"
        data-testid="agent-code-readonly-notice"
        role="status"
        aria-live="polite"
      >
        <FileCode2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p>{m.agentPanel.repositoryCodeReadOnly}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={createSessionBlocked}
            onClick={onResetConversation}
          >
            <MessageSquarePlus className="size-3.5" data-icon="inline-start" />
            {m.agentPanel.startNewConversation}
          </Button>
        </div>
      </section>
    </Message>
  ) : null;
  const toolActivityTranscript = running && toolActivities.length > 0 ? (
    <Message role="system">
      <div
        className="flex w-full flex-col gap-1 border-l-2 border-border py-0.5 pl-2 text-xs text-muted-foreground"
        data-testid="agent-tool-activity"
        aria-label={m.agentPanel.agentActivityLabel}
        role="group"
      >
        {toolActivities.map((activity) => (
          <div key={activity.callId} className="flex items-center gap-1.5">
            <span
              className={cn('size-1.5 shrink-0 rounded-full', {
                'animate-pulse bg-foreground motion-reduce:animate-none': activity.state === 'running',
                'bg-muted-foreground/55': activity.state === 'queued',
                'bg-primary': activity.state === 'completed',
                'bg-destructive': activity.state === 'failed',
              })}
              aria-hidden="true"
            />
            <span>
              {toolDisplayName(activity.toolName, m.agentPanel)} · {toolActivityStateLabel(activity.state, m.agentPanel)}
            </span>
          </div>
        ))}
      </div>
    </Message>
  ) : null;
  const runningTranscript = running && status?.kind !== 'tool' ? (
    <Message role="assistant">
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid={status?.kind === 'compacting' ? 'agent-compacting-status' : 'agent-streaming-status'}
        aria-busy="true"
      >
        <Spinner />
        {status?.text ?? m.agentPanel.chatWorking}
      </div>
    </Message>
  ) : null;
  const conversationTranscriptBeforeWorkbench = (
    <>
      {transcriptMessagesBeforeWorkbench.map((message) => (
        <AgentChatMessage
          key={message.id}
          message={message}
          hidePlainError={showProviderErrorCard && message.role === 'assistant' && message.content === error}
        />
      ))}

      {!hasPostWorkbenchTranscript && toolActivityTranscript}

      {codeSearchMessagesBeforeWorkbench.map((message) => (
        <RepositoryCodeSearchResult key={`code:${message.id}`} content={message.content} />
      ))}

      {!reviewFocused && !repositoryCodeReadOnlyNoticeAfterWorkbench && repositoryCodeReadOnlyNotice}

      {!hasPostWorkbenchTranscript && runningTranscript}
    </>
  );
  const conversationTranscriptAfterWorkbench = (
    <>
      {transcriptMessagesAfterWorkbench.map((message) => (
        <AgentChatMessage
          key={message.id}
          message={message}
          hidePlainError={showProviderErrorCard && message.role === 'assistant' && message.content === error}
        />
      ))}

      {hasPostWorkbenchTranscript && toolActivityTranscript}

      {codeSearchMessagesAfterWorkbench.map((message) => (
        <RepositoryCodeSearchResult key={`code:${message.id}`} content={message.content} />
      ))}

      {repositoryCodeReadOnlyNoticeAfterWorkbench && repositoryCodeReadOnlyNotice}

      {hasPostWorkbenchTranscript && runningTranscript}
    </>
  );

  return (
    <>
      <Conversation
        active={open}
        scrollKey={scrollKey}
        resumeLabel={m.agentPanel.resumeConversationFollow}
      >
        {hasEarlierMessages && (
          <Message role="system">
            <div className="flex w-full justify-center">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                data-testid="agent-load-earlier-messages"
                aria-busy={loadingEarlierMessages}
                disabled={loadingEarlierMessages || running || !agentSessionReady}
                onClick={() => {
                  void loadEarlierMessages();
                }}
              >
                {loadingEarlierMessages && <Spinner />}
                {loadingEarlierMessages
                  ? m.agentPanel.loadingEarlierMessages
                  : m.agentPanel.loadEarlierMessages}
              </Button>
            </div>
          </Message>
        )}

        {isReadyIdle && (
          <Message role="assistant">
            <MessageContent>{m.agentPanel.chatIntro}</MessageContent>
            <div className="mt-3 flex flex-wrap gap-2" data-testid="agent-ready-quick-chips">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={chatDisabled}
                onClick={() => onPromptSuggestion(m.agentPanel.findSimilarPrompt)}
              >
                <Search className="size-3.5" data-icon="inline-start" />
                {m.agentPanel.quickFindSimilar}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={chatDisabled}
                onClick={() => onPromptSuggestion(m.agentPanel.autoAssignPrompt)}
              >
                <Tags className="size-3.5" data-icon="inline-start" />
                {m.agentPanel.quickOrganizeUntagged}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={chatDisabled}
                onClick={() => onPromptSuggestion(m.agentPanel.cleanupTagsPrompt)}
              >
                <ListFilter className="size-3.5" data-icon="inline-start" />
                {m.agentPanel.quickCleanupTags}
              </Button>
              {onOpenOptions && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={onOpenOptions}
                >
                  <Wrench className="size-3.5" data-icon="inline-start" />
                  {m.agentPanel.agentSettings}
                </Button>
              )}
            </div>
          </Message>
        )}

        {showHandoff && handoff && (
          <>
            <Message role="system">
              <div
                className="w-full overflow-hidden rounded-[10px] border border-border bg-card"
                data-testid="agent-auto-tags-handoff-card"
              >
                <div className="flex items-start gap-2 border-b border-border/70 px-3 pb-2 pt-2.5">
                  <div className="mt-0.5 grid size-5 place-items-center text-muted-foreground">
                    <ArrowUp className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold leading-tight text-foreground">
                      {m.agentPanel.handoffTitle}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                      {m.agentPanel.handoffSubtitle(handoff.remainingUntagged)}
                    </div>
                  </div>
                </div>
                <div className="space-y-2 px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
                  <p className="font-medium text-foreground">{m.agentPanel.handoffAutoTagsUpdated}</p>
                  <p>{m.agentPanel.handoffBody}</p>
                </div>
              </div>
            </Message>
            <Message role="assistant">
              <MessageContent>{m.agentPanel.handoffAsk(handoff.remainingUntagged)}</MessageContent>
              <div className="mt-3 flex flex-wrap gap-2" data-testid="agent-handoff-quick-chips">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={active}
                  onClick={() => {
                    onDismissHandoff?.();
                    onPromptSuggestion(m.agentPanel.autoAssignPrompt);
                  }}
                >
                  {m.agentPanel.quickOrganizeUntagged}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={chatDisabled}
                  onClick={() => onPromptSuggestion(m.agentPanel.handoffAmbiguous)}
                >
                  {m.agentPanel.handoffAmbiguous}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={chatDisabled}
                  onClick={() => onPromptSuggestion(m.agentPanel.handoffExamples)}
                >
                  {m.agentPanel.handoffExamples}
                </Button>
              </div>
            </Message>
          </>
        )}

        {reviewFocused ? (
          <details
            className="w-full"
            data-testid="agent-run-transcript-details"
            open={reviewTranscriptOpen}
            onToggle={(event) => setReviewTranscriptOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer select-none text-xs text-muted-foreground">
              {m.agentPanel.reviewConversationDetails}
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {conversationTranscriptBeforeWorkbench}
            </div>
          </details>
        ) : conversationTranscriptBeforeWorkbench}

        {reviewFocused && !repositoryCodeReadOnlyNoticeAfterWorkbench && repositoryCodeReadOnlyNotice}

        <OrganizeJobRunWorkbench
          workbench={workbench}
          view={organizeView}
          readOnly={repositoryCodeReadOnly}
          originSessionDeleted={organizeOriginSessionDeleted}
          onInsertCorrection={onPromptSuggestion}
        />

        {conversationTranscriptAfterWorkbench}

        {showDurableRetryCard && durableRetryDraft && (
          <Message role="system">
            <div
              className="w-full overflow-hidden rounded-[8px] border border-border bg-card"
              data-testid="agent-durable-retry-card"
              role="status"
            >
              <div className="flex items-start gap-2 border-b border-border/70 px-3 pb-2 pt-2.5">
                <div className="mt-0.5 grid size-5 place-items-center text-muted-foreground">
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold leading-tight text-foreground">
                    {durableRetryTitle}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {durableRetryPending
                      ? m.agentPanel.retryDraftPendingSubtitle
                      : m.agentPanel.retryDraftSubtitle}
                  </div>
                </div>
              </div>
              <div className="space-y-2 px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
                <p>
                  {durableRetryPending
                    ? m.agentPanel.retryDraftPendingBody
                    : m.agentPanel.retryDraftBody}
                </p>
                <p className="max-h-16 overflow-hidden whitespace-pre-wrap break-words font-medium text-foreground">
                  {durableRetryDraft.prompt}
                </p>
                {!durableRetryPending && (
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    data-testid="agent-durable-retry-button"
                    onClick={onRetry}
                    disabled={chatDisabled || active || !canRetryLastTurn}
                  >
                    <RotateCcw className="size-3.5" data-icon="inline-start" />
                    {m.agentPanel.retry}
                  </Button>
                )}
              </div>
            </div>
          </Message>
        )}

        {showProviderErrorCard && (
          <Message role="system">
            <div
              className="w-full overflow-hidden rounded-[10px] border border-border bg-card"
              data-testid="agent-provider-error-card"
              role="alert"
            >
              <div className="flex items-start gap-2 border-b border-border/70 px-3 pb-2 pt-2.5">
                <div className="mt-0.5 grid size-5 place-items-center text-muted-foreground">
                  <TriangleAlert className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold leading-tight text-foreground">
                    {isSessionInitializationFailure
                      ? m.agentPanel.sessionLoadTitle
                      : isProviderSetupError
                        ? m.agentPanel.providerAuthTitle
                        : m.agentPanel.providerErrorTitle}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {isSessionInitializationFailure
                      ? m.agentPanel.sessionLoadSubtitle
                      : isProviderSetupError
                        ? m.agentPanel.providerAuthSubtitle
                        : m.agentPanel.providerErrorSubtitle}
                  </div>
                </div>
              </div>
              <div className="space-y-2 px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
                <p className="font-medium text-foreground">{error}</p>
                <p>
                  {isSessionInitializationFailure
                    ? m.agentPanel.sessionLoadBody
                    : isProviderSetupError
                      ? m.agentPanel.providerAuthBody
                      : canRetryLastTurn
                        ? m.agentPanel.providerErrorBody
                        : m.agentPanel.composerWriteRetryBlocked}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {!isSessionInitializationFailure && isProviderSetupError && onOpenOptions && (
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={onOpenOptions}
                    >
                      {m.agentPanel.providerAuthOpenOptions}
                    </Button>
                  )}
                  {(isSessionInitializationFailure || canRetryLastTurn) && (
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={isSessionInitializationFailure ? retrySessionHydration : onRetry}
                      disabled={isSessionInitializationFailure
                        ? sessionOperationPending
                        : !retryPrompt || chatDisabled || active}
                    >
                      {isSessionInitializationFailure
                        ? m.agentPanel.sessionLoadRetry
                        : isProviderSetupError
                          ? m.agentPanel.providerAuthRetry
                          : m.agentPanel.retry}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </Message>
        )}
      </Conversation>

      {contextLimitRecovery && (
        <div className="border-t border-border bg-muted/40 px-3 py-3" role="status" data-testid="agent-context-recovery-banner">
          <div className="text-sm font-medium text-foreground">{contextRecoveryTitle}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{contextRecoveryMessage}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {contextNeedsProviderSettings && onOpenOptions && (
              <Button size="sm" onClick={onOpenContextSettings}>
                <Wrench data-icon="inline-start" />
                {m.agentPanel.contextAdjustSettings}
              </Button>
            )}
            {contextNeedsPromptEdit && (
              <Button size="sm" onClick={onEditContextLimitedPrompt}>
                {m.agentPanel.contextEditPrompt}
              </Button>
            )}
            {contextNeedsPromptEdit && onOpenOptions && (
              <Button variant="outline" size="sm" onClick={onOpenOptions}>
                <Wrench data-icon="inline-start" />
                {m.agentPanel.contextAdjustSettings}
              </Button>
            )}
            {contextNeedsInternalRetry && (
              <Button
                size="sm"
                onClick={onRetryContextLimitedPrompt}
                disabled={!canRetryLastTurn || conversationSwitchBlocked}
              >
                {m.agentPanel.retry}
              </Button>
            )}
            {contextNeedsInternalRetry && !canRetryLastTurn && (
              <Button size="sm" onClick={onEditContextLimitedPrompt}>
                {m.agentPanel.contextEditPrompt}
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
});

function resolvedScopeCountValue(
  scopeCount: number | undefined,
  defaultCandidate: LaunchCandidateContract,
): number | undefined {
  if (typeof scopeCount === 'number') return scopeCount;
  if (defaultCandidate.kind === 'selected_repository') return 1;
  return undefined;
}

type AgentMessages = ReturnType<typeof useI18n>['m'];

function resolveAgentHeaderStatus({
  phase,
  statusText,
  contextRecoveryTitle,
  analysisProgress,
  applyProgress,
  selectedCount,
  receiptCounts,
  showHandoff,
  isProviderSetupError,
  lastTurnChangedCount,
  m,
}: {
  phase: AgentDominantPhase;
  statusText: string | null;
  contextRecoveryTitle: string;
  analysisProgress: AgentProgress;
  applyProgress: AgentProgress | null;
  selectedCount: number;
  receiptCounts: OrganizeWorkbenchView['receiptCounts'];
  showHandoff: boolean;
  isProviderSetupError: boolean;
  lastTurnChangedCount: number | null;
  m: AgentMessages;
}): string | null {
  switch (phase) {
    case 'chat_queued':
    case 'chat_working':
    case 'chat_compacting':
    case 'chat_tool':
      return statusText ?? m.agentPanel.chatWorking;
    case 'chat_done':
      return null;
    case 'chat_stopped':
      return statusText;
    case 'chat_failed':
      return isProviderSetupError ? m.agentPanel.providerAuthHeader : m.agentPanel.turnFailed;
    case 'context_recovery':
      return contextRecoveryTitle;
    case 'scope_requesting':
      return m.agentPanel.resolvingScopeHeader;
    case 'scope_ready':
      return m.agentPanel.confirmScopeHeader;
    case 'scope_starting':
      return m.agentPanel.workbench.startingAnalysis;
    case 'scope_failed':
      return null;
    case 'scope_empty':
      return m.agentPanel.nothingToAnalyzeHeader;
    case 'analyzing':
      return m.agentPanel.analyzingHeader(analysisProgress.completed, analysisProgress.total);
    case 'reconnecting':
      return m.agentPanel.workbench.connectionInterrupted;
    case 'analysis_blocked':
    case 'review_invalid':
    case 'failed':
      return m.agentPanel.workbench.analysisBlockedTitle;
    case 'review_loading':
      return m.agentPanel.loadingSuggestions;
    case 'review_failed':
      return m.agentPanel.loadFailed;
    case 'review_ready':
      return m.agentPanel.needsReviewSelected(selectedCount);
    case 'applying':
      return m.agentPanel.applyingHeader(
        applyProgress?.completed ?? 0,
        applyProgress?.total ?? selectedCount,
      );
    case 'paused':
      return m.agentPanel.runStateLabel('paused');
    case 'receipt':
      return receiptCounts && (receiptCounts.failed > 0 || receiptCounts.skipped > 0)
        ? m.agentPanel.partialReceiptHeader
        : m.agentPanel.appliedTagChanges(receiptCounts?.changed ?? 0);
    case 'completed_no_changes':
      return m.agentPanel.completedNoChangesHeader;
    case 'cancelled':
      return m.agentPanel.stopMidAnalyzeHeader;
    case 'interrupted':
      return m.agentPanel.toolbarInterrupted;
    case 'idle':
      if (showHandoff) return m.agentPanel.handoffHeader;
      if (lastTurnChangedCount !== null) return m.agentPanel.agentChanged(lastTurnChangedCount);
      return statusText;
  }
}

function resolveAgentComposerNote({
  mode,
  organizeView,
  m,
}: {
  mode: ReturnType<typeof resolveAgentUiPresentation>['composer']['mode'];
  organizeView: OrganizeWorkbenchView;
  m: AgentMessages;
}): string | null {
  switch (mode) {
    case 'context_recovery':
      return m.agentPanel.composerPausedContextRecovery;
    case 'write_retry_blocked':
      return m.agentPanel.composerWriteRetryBlocked;
    case 'applying':
      return m.agentPanel.composerPausedApplying;
    case 'scope_pending':
      return organizeView.phase === 'scope_starting'
        ? m.agentPanel.workbench.startingAnalysis
        : m.agentPanel.scopeNotFrozenYet;
    case 'scope_ready':
      return m.agentPanel.pendingConfirmationNote(organizeView.analysisProgress.total);
    case 'review_follow_up':
      return m.agentPanel.reviewFollowUpNote;
    case 'receipt':
      return m.agentPanel.followUpAboutScope;
    case 'default':
      return organizeView.phase === 'scope_empty'
        ? `${organizeView.scopeLabel ?? ''} · ${m.agentPanel.emptyScopeCount}`
        : null;
  }
}

function OrganizeJobRunWorkbench({
  workbench,
  view,
  readOnly,
  originSessionDeleted,
  onInsertCorrection,
}: {
  workbench: WorkbenchController;
  view: OrganizeWorkbenchView;
  readOnly: boolean;
  originSessionDeleted: boolean;
  onInsertCorrection: (prompt: string) => void;
}) {
  const { m } = useI18n();
  const { state } = workbench;
  const snapshot = state.snapshot;
  const preflight = state.preflight;
  const durableReceipt = state.organizeJob?.status === 'completed' && state.organizeJob.apply
    ? {
        applyId: state.organizeJob.apply.applyId,
        counts: {
          changed: state.organizeJob.apply.changed,
          unchanged: state.organizeJob.apply.unchanged,
          skipped: state.organizeJob.apply.skipped,
          failed: state.organizeJob.apply.failed,
        },
        rows: state.organizeReceiptPage?.rows ?? [],
      }
    : null;
  const receipt = durableReceipt;
  const [showChangedOrFailed, setShowChangedOrFailed] = useState(false);
  const workbenchContainerRef = useRef<HTMLDivElement | null>(null);
  const wasTakingControlRef = useRef(false);
  const focusAfterTakeoverRef = useRef(false);
  const previousControlNoticeRef = useRef(view.controlNotice);
  const [takeControlSucceeded, setTakeControlSucceeded] = useState(false);
  const takingControl = state.pendingCommand?.kind === 'take_control';
  const workbenchHadFocus = !!workbenchContainerRef.current?.contains(
    activeElementFor(workbenchContainerRef.current),
  );

  useEffect(() => {
    setShowChangedOrFailed(false);
  }, [receipt?.applyId]);

  useEffect(() => {
    if (!durableReceipt || !view.capabilities.canReadReceipt) return;
    workbench.requestOrganizeReceiptPage(0, showChangedOrFailed ? 'changed_or_failed' : 'all');
  }, [
    durableReceipt?.applyId,
    showChangedOrFailed,
    view.capabilities.canReadReceipt,
    workbench.requestOrganizeReceiptPage,
  ]);

  useEffect(() => {
    if (view.controlNotice !== null || !wasTakingControlRef.current) return;
    wasTakingControlRef.current = false;
    setTakeControlSucceeded(true);
    if (focusAfterTakeoverRef.current) {
      focusAfterTakeoverRef.current = false;
      workbenchContainerRef.current?.focus();
    }
  }, [view.controlNotice]);

  useEffect(() => {
    if (takeControlSucceeded) {
      const timeout = window.setTimeout(() => setTakeControlSucceeded(false), 1200);
      return () => window.clearTimeout(timeout);
    }
    return undefined;
  }, [takeControlSucceeded]);

  useEffect(() => {
    const previous = previousControlNoticeRef.current;
    previousControlNoticeRef.current = view.controlNotice;
    if (previous === null && view.controlNotice !== null && workbenchHadFocus) {
      workbenchContainerRef.current?.focus();
    }
  }, [view.controlNotice, workbenchHadFocus]);

  const phase = view.phase;
  const currentRunState = view.runState;
  const { completed: processed, total, remaining } = view.analysisProgress;
  const analysisInProgress = phase === 'analyzing';
  const proposalReadyForReview = phase === 'review_ready' && !!state.proposal;
  const analysisBlocked = !receipt && [
    'analysis_blocked',
    'review_invalid',
    'failed',
    'interrupted',
  ].includes(phase);
  const blockedFailureCount = view.failedCount;

  if (phase === 'idle' && !state.error) return null;

  const selectedCount = state.organizeJob?.selectedRepositories ?? 0;
  const applyInFlight = phase === 'applying'
    || state.pendingCommand?.kind === 'apply_selection';
  const mutationsLocked = readOnly || view.controlNotice !== null;
  const reviewEditable = !!state.proposal
    && !receipt
    && !applyInFlight
    && !mutationsLocked
    && view.capabilities.canEditReview;

  const completedNoChanges = phase === 'completed_no_changes';
  const staleBlockedRows = receipt
    ? receipt.rows.filter((row) => row.reason === 'stale_source')
    : [];
  const receiptRows = receipt
    ? (showChangedOrFailed
      ? receipt.rows.filter((row) => row.outcome === 'changed' || row.outcome === 'failed')
      : receipt.rows)
    : [];
  const runMode: AgentRunMode = phase === 'receipt'
    ? 'receipt'
    : phase === 'applying' || phase === 'paused'
      ? 'apply'
      : phase === 'review_loading' || phase === 'review_failed' || phase === 'review_ready' || phase === 'review_invalid'
        ? 'review'
        : snapshot
          ? 'analyze'
          : 'scope';
  const takeControlError = view.takeControlFailure === 'owner_connected'
    ? m.agentPanel.workbench.takeControlFailedOwnerConnected
    : view.takeControlFailure === 'revision_conflict'
      ? m.agentPanel.workbench.takeControlFailedConflict
      : view.takeControlFailure === 'job_unavailable'
        ? m.agentPanel.workbench.takeControlFailedUnavailable
        : view.takeControlFailure
          ? m.agentPanel.workbench.takeControlFailed
          : null;
  return (
    <div
      ref={workbenchContainerRef}
      className="space-y-3"
      data-testid="organize-job-workbench"
      tabIndex={-1}
    >
      <AgentRunStepper mode={runMode} />
      {view.controlNotice !== null && (
        <Message role="system">
          <div className="w-full">
            <div
              className="flex w-full items-center gap-2 rounded-[10px] border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              data-testid="organize-job-control-notice"
              role="status"
              aria-atomic="true"
            >
              {view.controlNotice === 'controlled_elsewhere'
                ? <Eye className="size-3.5 shrink-0" aria-hidden="true" />
                : <Unplug className="size-3.5 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 flex-1 leading-4">
                {view.controlNotice === 'controlled_elsewhere'
                  ? m.agentPanel.workbench.controlledElsewhere
                  : m.agentPanel.workbench.ownerDisconnected}
              </span>
              {view.controlNotice === 'owner_disconnected' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={!view.capabilities.canTakeControl || takingControl}
                  aria-busy={takingControl}
                  onClick={(event) => {
                    wasTakingControlRef.current = true;
                    focusAfterTakeoverRef.current = activeElementFor(event.currentTarget) === event.currentTarget;
                    workbench.takeControl();
                  }}
                >
                  {takingControl && <Spinner data-icon="inline-start" />}
                  {takingControl
                    ? m.agentPanel.workbench.takingControl
                    : m.agentPanel.workbench.takeControl}
                </Button>
              )}
            </div>
            {takeControlError && (
              <p
                className="mt-1 text-[11px] leading-4 text-destructive"
                data-testid="organize-job-take-control-error"
                role="alert"
              >
                {takeControlError}
              </p>
            )}
          </div>
        </Message>
      )}
      {takeControlSucceeded && (
        <div className="sr-only" role="status">
          {m.agentPanel.workbench.takeControlSucceeded}
        </div>
      )}
      {phase === 'scope_requesting' && preflight && (
        <Message role="system">
          <WorkbenchSection title={m.agentPanel.resolvingScopeHeader} icon={<Spinner />} subtitle={m.agentPanel.workbench.resolvingSubtitle}>
            <p>{m.agentPanel.workbench.resolvingBody}</p>
            <p className="mt-2 text-[11.5px] text-muted-foreground">{m.agentPanel.workbench.resolvingHint}</p>
          </WorkbenchSection>
        </Message>
      )}

      {(phase === 'scope_ready' || phase === 'scope_starting') && preflight && !snapshot && (
        <Message role="system">
          <WorkbenchSection
            title={m.agentPanel.workbench.confirmScopeTitle}
            icon={<Sparkles className="size-4" />}
            subtitle={preflight.label}
          >
            <p className="font-medium text-foreground">
              {m.agentPanel.workbench.repositoriesFrozen(preflight.count)}
            </p>
            <p className="mt-1">{m.agentPanel.workbench.reviewBeforeApply}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={workbench.confirmPreflight}
                disabled={mutationsLocked || !view.capabilities.canConfirmPreflight}
              >
                {preflight.status === 'starting'
                  ? <Spinner data-icon="inline-start" />
                  : <Play className="size-4" data-icon="inline-start" />}
                {preflight.status === 'starting'
                  ? m.agentPanel.workbench.startingAnalysis
                  : m.agentPanel.workbench.startAnalysis}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={workbench.cancelPreflight}
                disabled={readOnly || !view.capabilities.canCancelPreflight}
              >
                {m.agentPanel.cancel}
              </Button>
            </div>
          </WorkbenchSection>
        </Message>
      )}

      {phase === 'scope_empty' && preflight && !snapshot && (
        <Message role="system">
          <WorkbenchSection title={m.agentPanel.nothingToAnalyzeHeader} icon={<CheckCircle2 className="size-4" />} subtitle={preflight.label}>
            <p className="font-medium text-foreground">{m.agentPanel.emptyScopeCount}</p>
            <p className="mt-1">{m.agentPanel.workbench.nothingToAnalyzeBody}</p>
            <div className="mt-2 flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={workbench.cancelPreflight}
                disabled={readOnly || !view.capabilities.canCancelPreflight}
              >
                {m.agentPanel.workbench.dismiss}
              </Button>
            </div>
          </WorkbenchSection>
        </Message>
      )}

      {snapshot && phase === 'analyzing' && !receipt && (
        <Message role="system">
          <WorkbenchSection
            title={m.agentPanel.runStateLabel(
              currentRunState === 'analyzing' || state.continuationPending
                ? 'analyzing'
                : currentRunState ?? snapshot.state,
            )}
            titleTestId="organize-job-current-phase"
            icon={
              analysisInProgress
                ? <Spinner />
                : <Activity className="size-4" />
            }
            subtitle={snapshot.frozenScope.label}
          >
            {analysisInProgress ? (
              <>
                <div
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={m.agentPanel.workbench.runProgressLabel}
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={processed}
                >
                  <div
                    className="h-full rounded-full bg-foreground/80 transition-[width] motion-reduce:transition-none"
                    style={{ width: `${total > 0 ? Math.min(100, (processed / total) * 100) : 0}%` }}
                  />
                </div>
                <p
                  className="mt-2 text-[11.5px] text-muted-foreground"
                  data-testid="organize-job-progress-summary"
                >
                  {m.agentPanel.workbench.progressSummary(processed, remaining, 0)}
                </p>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2" aria-label={m.agentPanel.workbench.runProgressLabel}>
                <Metric label={m.agentPanel.workbench.processed} value={`${processed}/${total}`} />
                <Metric label={m.agentPanel.workbench.remaining} value={String(remaining)} />
              </div>
            )}
          </WorkbenchSection>
        </Message>
      )}

      {analysisBlocked && (
        <Message role="system">
          <WorkbenchSection
            title={m.agentPanel.workbench.analysisBlockedTitle}
            icon={<TriangleAlert className="size-4" />}
            subtitle={m.agentPanel.workbench.analysisCoverage(processed, total)}
          >
            <p>
              {phase === 'interrupted'
                ? m.agentPanel.workbench.workerLost
                : m.agentPanel.workbench.analysisBlockedBody(blockedFailureCount)}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {view.capabilities.canResumeAnalysis && (
                <Button
                  size="sm"
                  onClick={workbench.continueRemaining}
                  disabled={mutationsLocked || !view.capabilities.canResumeAnalysis}
                >
                  {state.continuationPending
                    ? <Spinner data-icon="inline-start" />
                    : <Play className="size-4" data-icon="inline-start" />}
                  {m.agentPanel.workbench.continueRemaining}
                </Button>
              )}
              {view.capabilities.canRestart && (
                <Button
                  variant={view.capabilities.canResumeAnalysis ? 'outline' : 'default'}
                  size="sm"
                  onClick={() => workbench.restartWholeLibrary(m.agentPanel.autoAssignPrompt)}
                  disabled={mutationsLocked || !view.capabilities.canRestart}
                >
                  <RotateCcw className="size-4" data-icon="inline-start" />
                  {m.agentPanel.workbench.restartWholeLibrary}
                </Button>
              )}
              {view.capabilities.canDiscard && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={phase === 'review_invalid'
                    ? workbench.discardReview
                    : phase === 'analysis_blocked'
                      ? workbench.discardBlockedRun
                      : workbench.clearTerminal}
                  disabled={mutationsLocked || !view.capabilities.canDiscard}
                >
                  <X className="size-4" data-icon="inline-start" />
                  {m.agentPanel.workbench.discardAnalysis}
                </Button>
              )}
            </div>
          </WorkbenchSection>
        </Message>
      )}

      {phase === 'review_loading' && (
        <Message role="system">
          <div data-testid="organize-job-review-loading">
            <WorkbenchSection
              title={m.agentPanel.loadingSuggestions}
              icon={<Spinner />}
              subtitle={m.agentPanel.workbench.reviewCoverageComplete(total)}
            >
              <p>{m.agentPanel.workbench.proposalSelectionNote}</p>
              {view.capabilities.canDiscard && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-7 px-2 text-xs"
                  onClick={workbench.discardReview}
                  disabled={mutationsLocked || !view.capabilities.canDiscard}
                >
                  <X className="size-4" data-icon="inline-start" />
                  {m.agentPanel.workbench.discardAnalysis}
                </Button>
              )}
            </WorkbenchSection>
          </div>
        </Message>
      )}

      {phase === 'review_failed' && (
        <Message role="system">
          <div data-testid="organize-job-review-failed">
            <WorkbenchSection
              title={m.agentPanel.loadFailed}
              icon={<TriangleAlert className="size-4" />}
              subtitle={m.agentPanel.workbench.reviewCoverageComplete(total)}
            >
              <p>{m.agentPanel.workbench.reviewLoadFailedBody}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  onClick={() => workbench.requestOrganizeReviewPage(
                    state.organizeReviewPage?.rowOffset ?? 0,
                  )}
                  disabled={readOnly || !view.capabilities.canRetryReviewPage}
                >
                  <RotateCcw className="size-4" data-icon="inline-start" />
                  {m.agentPanel.retry}
                </Button>
                {view.capabilities.canDiscard && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={workbench.discardReview}
                    disabled={mutationsLocked || !view.capabilities.canDiscard}
                  >
                    <X className="size-4" data-icon="inline-start" />
                    {m.agentPanel.workbench.discardAnalysis}
                  </Button>
                )}
              </div>
            </WorkbenchSection>
          </div>
        </Message>
      )}

      {state.proposal && proposalReadyForReview && !receipt && (
        <>
          <Message role="assistant">
            <MessageContent>
              {`${m.agentPanel.workbench.proposalSummary(state.proposal.actionableCount, state.proposal.nonActionableCount)}\n\n${m.agentPanel.workbench.proposalSelectionNote}`}
            </MessageContent>
          </Message>
          <Message role="system">
            <AgentProposalReviewCard
              proposal={state.proposal}
              selectedProposalRowIds={state.selectedProposalRowIds}
              reviewEditable={reviewEditable}
              reviewPageable={view.capabilities.canReadReview}
              applyInFlight={applyInFlight}
              applySelectedTotal={selectedCount}
              selectedRepositoryCount={state.organizeJob?.selectedRepositories}
              selectedActionCount={state.organizeJob?.selectedActions}
              coveredRepositoryCount={total}
              rowOffset={state.organizeReviewPage?.rowOffset ?? 0}
              nextRowOffset={state.organizeReviewPage?.nextRowOffset ?? null}
              onToggleRow={workbench.toggleProposalRow}
              onSelectAll={workbench.setAllProposalRowsSelected}
              onClear={() => workbench.setAllProposalRowsSelected(false)}
              onApplySelected={workbench.applySelected}
              onInsertCorrection={onInsertCorrection}
              onPageChange={workbench.requestOrganizeReviewPage}
            />
            <div className="mt-2 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={workbench.discardReview}
                disabled={mutationsLocked || !view.capabilities.canDiscard}
              >
                <X className="size-4" data-icon="inline-start" />
                {m.agentPanel.workbench.discardAnalysis}
              </Button>
            </div>
          </Message>
        </>
      )}

      {phase === 'applying' && state.organizeJob?.apply && !receipt && (
        <Message role="system">
          <WorkbenchSection
            title={m.agentPanel.workbench.applyingSelectedChanges}
            icon={<Spinner />}
            subtitle={m.agentPanel.workbench.applyingSubtitle}
          >
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={m.agentPanel.workbench.applyingSelectedChanges}
              aria-valuemin={0}
              aria-valuemax={state.organizeJob.apply.total}
              aria-valuenow={state.organizeJob.apply.settled}
            >
              <div
                className="h-full rounded-full bg-foreground/80 transition-[width] motion-reduce:transition-none"
                style={{
                  width: `${state.organizeJob.apply.total > 0
                    ? (state.organizeJob.apply.settled / state.organizeJob.apply.total) * 100
                    : 0}%`,
                }}
              />
            </div>
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              {m.agentPanel.workbench.rowsSelectedLocked(
                state.organizeJob.apply.settled,
                state.organizeJob.apply.total,
              )}
            </p>
          </WorkbenchSection>
        </Message>
      )}

      {phase === 'paused' && state.organizeJob?.apply && !receipt && (
        <Message role="system">
          <WorkbenchSection
            title={m.agentPanel.workbench.applyingSelectedChanges}
            icon={<CircleStop className="size-4" />}
            subtitle={m.agentPanel.workbench.applyingSubtitle}
          >
            <p className="text-foreground">
              {m.agentPanel.workbench.rowsSelectedLocked(
                state.organizeJob.apply.settled,
                state.organizeJob.apply.total,
              )}
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={workbench.resumeOrganizeApply}
              disabled={mutationsLocked || !view.capabilities.canResumeApply}
            >
              <Play className="size-4" data-icon="inline-start" />
              {m.agentPanel.workbench.continue}
            </Button>
          </WorkbenchSection>
        </Message>
      )}

      {phase === 'receipt' && receipt && (
        <Message role="system">
            <div
              className="w-full overflow-hidden rounded-[10px] border border-border bg-card"
              data-testid="organize-job-receipt-card"
              role={receipt.counts.failed > 0 || receipt.counts.skipped > 0 ? 'alert' : 'status'}
            >
              <div className="flex items-start gap-2 border-b border-border/70 px-3 pb-2 pt-2.5">
                <div className="mt-0.5 grid size-5 place-items-center text-muted-foreground">
                  {receipt.counts.failed > 0 || receipt.counts.skipped > 0
                    ? <TriangleAlert className="size-3.5" />
                    : <CheckCircle2 className="size-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold leading-tight text-foreground">
                    {m.agentPanel.workbench.mutationReceipt}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {m.agentPanel.workbench.receiptSubtitle}
                  </div>
                  {originSessionDeleted && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {m.agentPanel.workbench.receiptOriginDeleted}
                    </div>
                  )}
                </div>
              </div>
              <div className="px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
                <p className="mb-2 font-medium text-foreground">
                  {receipt.counts.failed > 0 || receipt.counts.skipped > 0
                    ? m.agentPanel.workbench.receiptPartial(receipt.counts.changed, receipt.counts.skipped, receipt.counts.failed)
                    : receipt.counts.changed === 1
                      ? m.agentPanel.workbench.receiptSingle
                      : m.agentPanel.workbench.receiptComplete(receipt.counts.changed)}
                </p>
                <div className="grid grid-cols-3 gap-2" aria-label={m.agentPanel.workbench.receiptCountsLabel}>
                  <Metric label={m.agentPanel.workbench.changed} value={String(receipt.counts.changed)} />
                  <Metric label={m.agentPanel.workbench.skipped} value={String(receipt.counts.skipped)} />
                  <Metric label={m.agentPanel.workbench.failed} value={String(receipt.counts.failed)} />
                </div>
                {(receipt.counts.failed > 0 || receipt.counts.skipped > 0) && (
                  <p className="mt-2 text-[11.5px] text-muted-foreground">
                    {m.agentPanel.workbench.receiptCountSummary(receipt.counts.changed, receipt.counts.skipped, receipt.counts.failed)}
                  </p>
                )}
                {receipt.counts.unchanged > 0 && (
                  <p className="mt-2 text-[11.5px] text-muted-foreground">
                    {m.agentPanel.workbench.unchangedCount(receipt.counts.unchanged)}
                  </p>
                )}
                {state.organizeReceiptError && (
                  <div
                    className="mt-2 rounded-md border border-border bg-muted/30 px-2 py-2"
                    data-testid="organize-job-receipt-failed"
                    role="alert"
                  >
                    <p className="font-medium text-foreground">
                      {m.agentPanel.workbench.receiptLoadFailed}
                    </p>
                    <p className="mt-0.5 text-[11.5px]">
                      {m.agentPanel.workbench.receiptLoadFailedBody}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 h-7 px-2 text-xs"
                      onClick={() => workbench.requestOrganizeReceiptPage(
                        state.organizeReceiptPage?.rowOffset ?? 0,
                        showChangedOrFailed ? 'changed_or_failed' : 'all',
                      )}
                      disabled={readOnly || !view.capabilities.canRetryReceiptPage}
                    >
                      <RotateCcw className="size-4" data-icon="inline-start" />
                      {m.agentPanel.retry}
                    </Button>
                  </div>
                )}
                {staleBlockedRows.length > 0 && !showChangedOrFailed ? (
                  <div className="mt-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
                    <p className="font-medium text-foreground">{m.agentPanel.staleSourceTitle}</p>
                    <p className="mt-0.5 text-[11.5px]">{m.agentPanel.staleSourceBody}</p>
                  </div>
                ) : null}
                <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto" aria-label={m.agentPanel.workbench.receiptRowsLabel}>
                  {receiptRows.map((row) => (
                    <li
                      key={row.proposalRowId}
                      className="flex items-center justify-between gap-2 rounded-md bg-background px-2 py-1.5"
                    >
                      <span className="min-w-0 truncate text-foreground">{row.repositoryId}</span>
                      <span className="shrink-0 font-medium text-foreground">
                        {m.agentPanel.runStateLabel(row.outcome)}{row.reason ? ` · ${m.agentPanel.runStateLabel(row.reason)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                {durableReceipt && state.organizeReceiptPage && (
                  state.organizeReceiptPage.rowOffset > 0 ||
                  state.organizeReceiptPage.nextRowOffset !== null
                ) ? (
                  <div className="mt-2 flex items-center justify-end gap-1 border-t border-border/70 pt-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => workbench.requestOrganizeReceiptPage(
                        Math.max(0, state.organizeReceiptPage!.rowOffset - 100),
                        showChangedOrFailed ? 'changed_or_failed' : 'all',
                      )}
                      disabled={!view.capabilities.canReadReceipt || state.organizeReceiptPage.rowOffset === 0}
                      title={m.agentPanel.workbench.previousPage}
                      aria-label={m.agentPanel.workbench.previousPage}
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => {
                        const nextOffset = state.organizeReceiptPage?.nextRowOffset;
                        if (nextOffset === null || nextOffset === undefined) return;
                        workbench.requestOrganizeReceiptPage(
                          nextOffset,
                          showChangedOrFailed ? 'changed_or_failed' : 'all',
                        );
                      }}
                      disabled={!view.capabilities.canReadReceipt || state.organizeReceiptPage.nextRowOffset === null}
                      title={m.agentPanel.workbench.nextPage}
                      aria-label={m.agentPanel.workbench.nextPage}
                    >
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                ) : null}
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setShowChangedOrFailed((current) => !current)}
                    disabled={receipt.counts.changed === 0 && receipt.counts.failed === 0}
                  >
                    {showChangedOrFailed
                      ? m.agentPanel.workbench.viewAllRows
                      : receipt.counts.failed > 0
                        ? m.agentPanel.workbench.viewFailedChanged
                        : m.agentPanel.workbench.viewChanged}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={workbench.clearTerminal}
                    disabled={!view.capabilities.canDismissTerminal}
                  >
                    {m.agentPanel.workbench.dismiss}
                  </Button>
                </div>
              </div>
            </div>
        </Message>
      )}

      {phase === 'cancelled' && !receipt && (
        <Message role="system">
          <div className="w-full overflow-hidden rounded-[10px] border border-border bg-card" data-testid="organize-job-stop-card" role="status">
            <div className="flex items-start gap-2 border-b border-border/70 px-3 pb-2 pt-2.5">
              <div className="mt-0.5 grid size-5 place-items-center text-muted-foreground">
                <CircleStop className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold leading-tight text-foreground">
                  {m.agentPanel.stopMidAnalyzeTitle}
                </div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {m.agentPanel.stopMidAnalyzeSubtitle}
                </div>
                {originSessionDeleted && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {m.agentPanel.workbench.receiptOriginDeleted}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-2 px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
              <p>{m.agentPanel.stopMidAnalyzeBody(processed, remaining)}</p>
              <div className="flex flex-wrap gap-1.5">
                {snapshot?.continuationCursor && (
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={workbench.continueRemaining}
                    disabled={readOnly || state.continuationPending}
                  >
                    {state.continuationPending ? <Spinner data-icon="inline-start" /> : <Play className="size-4" data-icon="inline-start" />}
                    {m.agentPanel.stopMidAnalyzeResume}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={workbench.clearTerminal}
                  disabled={!view.capabilities.canDismissTerminal}
                >
                  {m.agentPanel.stopMidAnalyzeDiscard}
                </Button>
              </div>
            </div>
          </div>
        </Message>
      )}

      {completedNoChanges && (
        <Message role="system">
          <div className="w-full overflow-hidden rounded-[10px] border border-border bg-card" data-testid="organize-job-no-changes-card" role="status">
            <div className="flex items-start gap-2 border-b border-border/70 px-3 pb-2 pt-2.5">
              <div className="mt-0.5 grid size-5 place-items-center text-muted-foreground">
                <CheckCircle2 className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold leading-tight text-foreground">
                  {m.agentPanel.completedNoChangesTitle}
                </div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {m.agentPanel.completedNoChangesSubtitle(total)}
                </div>
                {originSessionDeleted && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {m.agentPanel.workbench.receiptOriginDeleted}
                  </div>
                )}
              </div>
            </div>
            <div className="px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
              <p>{m.agentPanel.completedNoChangesBody}</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-7 px-2 text-xs"
                onClick={workbench.clearTerminal}
                disabled={!view.capabilities.canDismissTerminal}
              >
                {m.agentPanel.workbench.dismiss}
              </Button>
            </div>
          </div>
        </Message>
      )}

      {(view.error || workbench.terminalDismissFailed) && !analysisBlocked && phase !== 'reconnecting' && (
        <Message role="system">
          <div className="rounded-[10px] border border-border bg-card p-3 text-xs text-foreground" role="alert" data-testid="organize-job-error-card">
            {workbench.terminalDismissFailed
              ? m.agentPanel.workbench.organizeCommandFailed
              : view.error?.kind === 'organize_already_running'
                ? m.agentPanel.workbench.organizeAlreadyRunning
                : view.error?.kind === 'connection_interrupted'
                  ? m.agentPanel.workbench.connectionInterrupted
                  : view.error?.kind === 'worker_lost'
                    ? m.agentPanel.workbench.workerLost
                    : view.error?.kind === 'preflight_incomplete'
                      ? m.agentPanel.workbench.analysisScopeIncomplete
                      : view.error?.kind === 'run_state_refreshed'
                        ? m.agentPanel.workbench.runStateRefreshed
                        : m.agentPanel.workbench.organizeCommandFailed}
          </div>
        </Message>
      )}

    </div>
  );
}

function WorkbenchSection({
  title,
  icon,
  children,
  subtitle,
  titleTestId,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  subtitle?: string;
  titleTestId?: string;
}) {
  return (
    <section className="w-full max-w-[88%] overflow-hidden rounded-[10px] border border-border bg-background">
      <div className="flex items-start gap-2 border-b border-border/70 px-3 pb-2 pt-2.5">
        <div className="mt-0.5 grid size-5 place-items-center text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="text-[12.5px] font-semibold leading-tight text-foreground"
            data-testid={titleTestId}
          >
            {title}
          </div>
          {subtitle ? (
            <div className="mt-0.5 text-[11.5px] text-muted-foreground">{subtitle}</div>
          ) : null}
        </div>
      </div>
      <div className="px-3 pb-3 pt-2.5 text-[12.5px] leading-5 text-muted-foreground">{children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-background px-2 py-1.5">
      <div className="truncate text-[10px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}


function AgentChatMessage({
  message,
  hidePlainError = false,
}: {
  message: BgsmAgentChatMessage;
  hidePlainError?: boolean;
}) {
  const { m } = useI18n();
  const role = message.role === 'tool' ? 'assistant' : message.role;

  if (hidePlainError) return null;

  if (message.role === 'tool') {
    return null;
  }

  return (
    <Message role={role}>
      {role === 'assistant' ? (
        message.streaming
          ? (
              <div aria-busy="true" data-testid="agent-streaming-message">
                <MessageContent>{message.content}</MessageContent>
              </div>
            )
          : <MessageResponse>{message.content || m.agentPanel.emptyAgentMessage}</MessageResponse>
      ) : (
        <MessageContent>{message.content || m.agentPanel.emptyAgentMessage}</MessageContent>
      )}
    </Message>
  );
}

function toolActivityStateLabel(
  state: 'queued' | 'running' | 'completed' | 'failed',
  labels: {
    agentToolQueued: string;
    agentToolRunning: string;
    agentToolCompleted: string;
    agentToolFailed: string;
  },
): string {
  if (state === 'queued') return labels.agentToolQueued;
  if (state === 'running') return labels.agentToolRunning;
  if (state === 'completed') return labels.agentToolCompleted;
  return labels.agentToolFailed;
}

function toolDisplayName(
  toolName: string | undefined,
  labels: {
    agentReadingData: string;
    agentSearchingCode: string;
    agentPreparingOrganizationScope: string;
    agentApplyingChanges: string;
    toolResult: string;
  },
): string {
  const presentation = getBgsmAgentToolDefinition(toolName)?.presentation;
  if (presentation === 'organization') {
    return labels.agentPreparingOrganizationScope;
  }
  if (presentation === 'repository_code') return labels.agentSearchingCode;
  if (presentation === 'tag_changes') {
    return labels.agentApplyingChanges;
  }
  if (presentation === 'repository_data') {
    return labels.agentReadingData;
  }
  return labels.toolResult;
}

type RepositoryCodeSearchData = Readonly<{
  status: 'complete' | 'partial' | 'no_indexed_matches';
  matches: readonly Readonly<{
    repository: string;
    path: string;
    lineStart: number;
    lineEnd: number;
    snippet: string;
    githubUrl: string;
  }>[];
}>;

function RepositoryCodeSearchResult({ content }: { content: string }) {
  const { m } = useI18n();
  const result = parseRepositoryCodeSearchResult(content);
  if (!result) return null;
  return (
    <Message role="system">
      <section
        className="w-full border-l-2 border-border pl-3"
        data-testid="agent-code-search-result"
        aria-label={m.agentPanel.agentSearchingCode}
      >
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <FileCode2 className="size-3.5" />
          {m.agentPanel.codeSearchStatus(result.status, result.matches.length)}
        </div>
        <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
          {m.agentPanel.codeSearchUntrusted}
        </p>
        <div className="mt-2 space-y-2">
          {result.matches.map((match) => (
            <article key={`${match.repository}:${match.path}:${match.lineStart}`} className="min-w-0">
              <a
                className="inline-flex max-w-full items-center gap-1 text-xs font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                href={match.githubUrl}
                target="_blank"
                rel="noreferrer"
                title={m.agentPanel.codeSearchOpenSource}
              >
                <span className="truncate">{match.repository}/{match.path}:{match.lineStart}</span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/45 px-2 py-1.5 font-mono text-[11px] leading-4 text-foreground">
                {match.snippet}
              </pre>
            </article>
          ))}
        </div>
      </section>
    </Message>
  );
}

function parseRepositoryCodeSearchResult(content: string): RepositoryCodeSearchData | null {
  try {
    const envelope = JSON.parse(content) as { ok?: unknown; data?: unknown };
    if (envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object') return null;
    const data = envelope.data as Record<string, unknown>;
    if (
      data.untrusted !== true
      || !['complete', 'partial', 'no_indexed_matches'].includes(String(data.status))
      || !Array.isArray(data.matches)
    ) return null;
    const matches = data.matches.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const match = entry as Record<string, unknown>;
      if (
        typeof match.repository !== 'string'
        || typeof match.path !== 'string'
        || !Number.isSafeInteger(match.lineStart)
        || !Number.isSafeInteger(match.lineEnd)
        || typeof match.snippet !== 'string'
        || typeof match.githubUrl !== 'string'
        || !match.githubUrl.startsWith('https://github.com/')
      ) return [];
      return [{
        repository: match.repository,
        path: match.path,
        lineStart: Number(match.lineStart),
        lineEnd: Number(match.lineEnd),
        snippet: match.snippet,
        githubUrl: match.githubUrl,
      }];
    });
    return {
      status: data.status as RepositoryCodeSearchData['status'],
      matches,
    };
  } catch {
    return null;
  }
}

function activeElementFor(owner: Node | null): Element | null {
  const root = owner?.getRootNode();
  return root && 'activeElement' in root
    ? (root as Document | ShadowRoot).activeElement
    : null;
}
