import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CircleStop,
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
  Wrench,
  X,
} from 'lucide-react';
import type { LaunchCandidateContract } from '@/bgsm-agent/scope';
import {
  BGSM_AGENT_TOOL_NAMES,
  getBgsmAgentToolDefinition,
} from '@/bgsm-agent/tool-catalog';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';
import { Conversation, Message, MessageContent, PromptInput } from '@/ui/ai-elements/chat';
import { MessageResponse } from '@/ui/ai-elements/response';
import { AgentFunctionMenu } from '@/ui/components/AgentFunctionMenu';
import { AgentMascot, resolveAgentMascotState } from '@/ui/components/AgentMascot';
import { AgentSessionMenu } from '@/ui/components/AgentSessionMenu';
import {
  AgentProposalReviewCard,
  AgentRunStepper,
  type AgentRunMode,
} from '@/ui/components/AgentOrganizeReview';
import type { BgsmAgentChatMessage, useBgsmAgent } from '@/ui/hooks/use-bgsm-agent';
import type { useBgsmAgentWorkbench } from '@/ui/hooks/use-bgsm-agent-workbench';
import {
  CONNECTION_INTERRUPTED_COPY,
  PREFLIGHT_INCOMPLETE_COPY,
  WORKER_LOST_COPY,
  analyzedRepositoryCount,
  currentOrganizeJobState,
  hasCompleteAnalysisCoverage,
  type CurrentOrganizeJobState,
} from '@/ui/agent-workbench-state';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
type ChatController = ReturnType<typeof useBgsmAgent>;
type WorkbenchController = ReturnType<typeof useBgsmAgentWorkbench>;

export function AgentPanel({
  open,
  onHide,
  onOpenOptions,
  agent,
  workbench,
  defaultCandidate,
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
  scopeCount?: number;
  handoff?: { remainingUntagged: number; autoTagged: number } | null;
  onDismissHandoff?: () => void;
}) {
  const { m } = useI18n();
  const [input, setInput] = useState('');
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [reviewTranscriptOpen, setReviewTranscriptOpen] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const reviewTranscriptMessageIdRef = useRef<string | null>(null);
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;
  const {
    messages,
    running,
    status,
    error,
    lastTurnResult,
    contextLimitRecovery,
    draftRecovery,
    canRetryLastTurn,
    toolActivities,
    errorCategory,
    startTurn,
    stopTurn,
    editContextLimitedPrompt,
    activeSessionId,
    sessions,
    createSession,
    switchSession,
    deleteSession,
    resetConversation,
  } = agent;
  const organize = workbench.state;
  const durableReceiptCounts = organize.organizeJob?.status === 'completed' && organize.organizeJob.apply
    ? {
        changed: organize.organizeJob.apply.changed,
        unchanged: organize.organizeJob.apply.unchanged,
        skipped: organize.organizeJob.apply.skipped,
        failed: organize.organizeJob.apply.failed,
      }
    : null;
  const receiptCounts = durableReceiptCounts;
  const analysisCoverageComplete = organize.organizeJob
    ? organize.organizeJob.coverage.analyzed === organize.organizeJob.coverage.total &&
      organize.organizeJob.coverage.analysisFailed === 0
    : hasCompleteAnalysisCoverage(organize);
  const automaticContinuation = organize.continuationPending;
  const currentRunState = currentOrganizeJobState(organize.snapshot, organize.organizeJob);
  const mascotState = resolveAgentMascotState({
    chatStatus: status?.kind ?? null,
    chatRunning: running,
    hasAgentError: !!error,
    hasContextRecovery: !!contextLimitRecovery,
    preflightStatus: organize.preflight?.status ?? null,
    runState: currentRunState,
    automaticContinuation: organize.continuationPending,
    hasWorkbenchError: !!organize.error,
    workbenchDisconnected: organize.transport === 'disconnected',
    hasReceipt: durableReceiptCounts !== null,
  });
  const organizeActive = automaticContinuation || isActiveRunState(currentRunState);
  const preflightRequesting = organize.preflight?.status === 'requesting'
    || organize.preflight?.status === 'starting';
  const preflightReady = organize.preflight?.status === 'ready';
  const preflightActive = preflightRequesting || preflightReady;
  const active = running || organizeActive || preflightActive;
  const showStopbar = running || organizeActive || preflightRequesting;
  const workbenchOwnsSession = !!(
    organize.preflight
    || organize.snapshot
    || organize.proposal
    || organize.organizeJob
    || organize.organizeReviewPage
    || organize.organizeReceiptPage
    || organize.conversationAnchor
  );
  const sessionTransitionBlocked = active || workbenchOwnsSession;
  const reviewFocused = !!organize.snapshot
    && currentRunState === 'review'
    && !!organize.proposal
    && analysisCoverageComplete
    && !durableReceiptCounts
    && organize.organizeJob?.status !== 'completed';
  const organizeBlocksChat = automaticContinuation || isActiveRunState(currentRunState);
  const chatDisabled = running
    || organizeActive
    || preflightRequesting
    || !!contextLimitRecovery
    || organizeBlocksChat;
  const isReadyIdle = !running
    && !organize.snapshot
    && !organize.preflight
    && !durableReceiptCounts
    && !error
    && !lastTurnResult
    && !contextLimitRecovery
    && messages.length === 0;
  const showHandoff = !!handoff
    && handoff.remainingUntagged > 0
    && !running
    && !organize.snapshot
    && !organize.preflight
    && !durableReceiptCounts
    && !error
    && !contextLimitRecovery
    && messages.length === 0;
  const applying = currentRunState === 'apply_sealed' || currentRunState === 'applying';
  const lastUserPrompt = [...messages].reverse().find((message) => message.role === 'user')?.content ?? null;
  const retryPrompt = draftRecovery ?? lastFailedPrompt ?? lastUserPrompt;
  const unsafeReplayBlocked = !canRetryLastTurn
    && !!retryPrompt
    && input.trim() === retryPrompt.trim();
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
  const toolMessages = messages.filter((message) => message.role === 'tool');
  const repositoryCodeReadOnly = toolMessages.some((message) => (
    getBgsmAgentToolDefinition(message.toolName)?.capability === 'repository_code'
  ));
  const showProviderErrorCard = !running && !!error && !contextLimitRecovery;
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

  useEffect(() => {
    if (contextLimitRecovery) setInput(contextLimitRecovery.prompt);
  }, [contextLimitRecovery]);

  useEffect(() => {
    if (draftRecovery) setInput(draftRecovery);
  }, [draftRecovery]);

  useEffect(() => {
    if (error && lastUserPrompt) setLastFailedPrompt(lastUserPrompt);
    if (!error && !running) setLastFailedPrompt(null);
  }, [error, lastUserPrompt, running]);

  const focusComposerAtEnd = () => {
    queueMicrotask(() => {
      const textarea = drawerRef.current?.querySelector<HTMLTextAreaElement>('textarea');
      if (!textarea) return;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  };

  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    const root = drawer?.getRootNode() as (Document | ShadowRoot | null);
    const activeElement = root && 'activeElement' in root ? root.activeElement : document.activeElement;
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
      const current = root && 'activeElement' in root ? root.activeElement : document.activeElement;
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

  const runAgentPrompt = (prompt: string) => {
    const handoffAuthority = workbench.captureAgentHandoffAuthority();
    void startTurn(prompt).then((result) => {
      if (result?.organizeLibraryHandoff?.type !== 'organize_whole_library') return;
      const anchorMessage = result.newMessages.at(-1);
      workbench.applyAgentHandoff(
        result.organizeLibraryHandoff,
        handoffAuthority,
        {
          messageId: anchorMessage?.id ?? null,
          createdAt: anchorMessage?.createdAt ?? Date.now(),
        },
      );
    });
  };

  const handlePromptSuggestion = (prompt: string) => {
    if (!prompt.trim() || chatDisabled) return;
    setInput(prompt);
    focusComposerAtEnd();
  };

  const handleSubmit = () => {
    if (!input.trim() || chatDisabled || unsafeReplayBlocked) return;
    const prompt = input;
    setInput('');
    runAgentPrompt(prompt);
  };

  const handleRetry = () => {
    if (!retryPrompt || chatDisabled) return;
    setInput('');
    runAgentPrompt(retryPrompt);
  };

  const handleEditContextLimitedPrompt = () => {
    if (!contextLimitRecovery || active) return;
    editContextLimitedPrompt();
    focusComposerAtEnd();
  };

  const handleRetryContextLimitedPrompt = () => {
    if (!contextLimitRecovery || active || !canRetryLastTurn) return;
    const prompt = contextLimitRecovery.prompt;
    editContextLimitedPrompt();
    setInput('');
    runAgentPrompt(prompt);
  };

  const handleOpenContextSettings = () => {
    if (contextLimitRecovery) editContextLimitedPrompt();
    onOpenOptions?.();
    focusComposerAtEnd();
  };

  const handleResetConversation = () => {
    if (sessionTransitionBlocked) return;
    resetConversation();
    setLastFailedPrompt(null);
    setInput('');
    focusComposerAtEnd();
  };

  const handleCreateSession = (): boolean => {
    if (sessionTransitionBlocked) return false;
    if (createSession()) {
      setLastFailedPrompt(null);
      setInput('');
      focusComposerAtEnd();
      return true;
    }
    return false;
  };

  const handleSwitchSession = (nextSessionId: string): boolean => {
    if (sessionTransitionBlocked || !switchSession(nextSessionId)) return false;
    setLastFailedPrompt(null);
    setInput('');
    focusComposerAtEnd();
    return true;
  };

  const handleDeleteSession = (sessionIdToDelete: string): boolean => {
    if (sessionTransitionBlocked) return false;
    if (deleteSession(sessionIdToDelete)) {
      setLastFailedPrompt(null);
      setInput('');
      focusComposerAtEnd();
      return true;
    }
    return false;
  };

  const motionState = open ? 'open' : 'closed';
  const selectedCount = organize.organizeJob?.selectedRepositories ?? organize.selectedProposalRowIds.size;
  const resolvedScopeCount = resolvedScopeCountValue(scopeCount, defaultCandidate);
  const analyzing = currentRunState !== null && (
    (['frozen', 'prepared', 'checking_provider', 'analyzing'] as readonly string[]).includes(currentRunState)
    || automaticContinuation
  );
  const total = organize.organizeJob?.scopeCount ?? organize.snapshot?.frozenScope.count ?? 0;
  const processed = analyzedRepositoryCount(organize);
  const displayedProcessed = Math.min(total, Math.max(processed, workbench.displayedProcessed));
  const applySelectedTotal = organize.organizeJob?.apply?.total ?? selectedCount;
  const applyDone = organize.organizeJob?.apply?.settled ?? 0;
  const isProviderSetupError = !!error && !!errorCategory && !['provider', 'other'].includes(errorCategory);
  const headerStatus = (() => {
    if (running) return status?.text ?? m.agentPanel.chatWorking;
    if (contextLimitRecovery) return contextRecoveryTitle;
    if (automaticContinuation) return m.agentPanel.analyzingHeader(displayedProcessed, total);
    if (currentRunState === 'cancelled') return m.agentPanel.stopMidAnalyzeHeader;
    if (currentRunState === 'failed' && !durableReceiptCounts) {
      return m.agentPanel.workbench.analysisBlockedTitle;
    }
    if (currentRunState === 'analysis_blocked') return m.agentPanel.workbench.analysisBlockedTitle;
    if (currentRunState === 'completed' && !organize.organizeJob?.apply) {
      return m.agentPanel.completedNoChangesHeader;
    }
    if (organize.preflight?.status === 'requesting') return m.agentPanel.resolvingScopeHeader;
    if (organize.preflight?.status === 'starting') return m.agentPanel.workbench.startingAnalysis;
    if (organize.preflight?.status === 'no_work' && !organize.snapshot) {
      return m.agentPanel.nothingToAnalyzeHeader;
    }
    if (organize.preflight?.status === 'ready' && !organize.snapshot) {
      return m.agentPanel.confirmScopeHeader;
    }
    if (applying) {
      return m.agentPanel.applyingHeader(Math.min(applyDone, applySelectedTotal), applySelectedTotal);
    }
    if (currentRunState === 'budget_exhausted' && !automaticContinuation) {
      return m.agentPanel.workbench.analysisBlockedTitle;
    }
    if (currentRunState === 'review' && organize.proposal && !analysisCoverageComplete) {
      return m.agentPanel.workbench.analysisBlockedTitle;
    }
    if (currentRunState === 'review' && organize.proposal && analysisCoverageComplete) {
      return m.agentPanel.needsReviewSelected(selectedCount);
    }
    if (analyzing && total > 0) return m.agentPanel.analyzingHeader(displayedProcessed, total);
    if (receiptCounts) {
      return receiptCounts.failed > 0 || receiptCounts.skipped > 0
        ? m.agentPanel.partialReceiptHeader
        : m.agentPanel.appliedTagChanges(receiptCounts.changed);
    }
    if (showHandoff) return m.agentPanel.handoffHeader;
    if (currentRunState) return m.agentPanel.runStateLabel(currentRunState);
    if (error) return isProviderSetupError ? m.agentPanel.providerAuthHeader : m.agentPanel.turnFailed;
    if (lastTurnResult?.changed) return m.agentPanel.agentChanged(lastTurnResult.changedCount);
    if (status?.kind === 'stopped') return status.text;
    return null;
  })();
  const composerNote = contextLimitRecovery
    ? m.agentPanel.composerPausedContextRecovery
    : unsafeReplayBlocked
      ? m.agentPanel.composerWriteRetryBlocked
    : applying
      ? m.agentPanel.composerPausedApplying
      : organize.preflight?.status === 'requesting'
        ? m.agentPanel.scopeNotFrozenYet
        : organize.preflight?.status === 'starting'
          ? m.agentPanel.workbench.startingAnalysis
        : organize.organizeJob?.status === 'review' && organize.proposal && analysisCoverageComplete
          ? (running ? m.agentPanel.reviewFollowUpNote : m.agentPanel.reviewFollowUpNote)
          : receiptCounts
            ? m.agentPanel.followUpAboutScope
            : organize.preflight?.status === 'ready' && !organize.snapshot
              ? m.agentPanel.pendingConfirmationNote(organize.preflight.count)
              : organize.preflight?.status === 'no_work' && !organize.snapshot
                ? `${organize.preflight.label} · ${m.agentPanel.emptyScopeCount}`
                : showHandoff
                  ? m.agentPanel.handoffScopeNote(handoff!.remainingUntagged)
                  : organize.snapshot
                    ? m.agentPanel.frozenScopeNote(organize.snapshot.frozenScope.count)
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
                            : m.agentPanel.askingAboutAllLiveStars(resolvedScopeCount);
  const composerPlaceholder = reviewFocused
    ? m.agentPanel.reviewFollowUpPlaceholder
    : isReadyIdle && typeof resolvedScopeCount === 'number'
      ? m.agentPanel.chatPlaceholderScoped(resolvedScopeCount)
      : m.agentPanel.chatPlaceholder;
  const stopbarText = applying
    ? m.agentPanel.applyingStopbar
    : organize.preflight?.status === 'requesting'
      ? m.agentPanel.resolvingScopeHeader
      : organize.preflight?.status === 'starting'
        ? m.agentPanel.workbench.startingAnalysis
        : (organizeActive || running)
          ? m.agentPanel.runContinuesWhileHidden
          : status?.text ?? m.agentPanel.chatWorking;
  const conversationScrollKey = [
    messages.at(-1)?.id ?? '',
    messages.at(-1)?.content.length ?? 0,
    organize.timeline.at(-1)?.id ?? '',
    organize.snapshot?.state ?? '',
    processed,
    organize.organizeJob?.apply?.applyId ?? '',
    status?.text ?? '',
    error ?? '',
  ].join(':');
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
            className="mt-2 h-7 px-2 text-xs"
            onClick={handleResetConversation}
            disabled={sessionTransitionBlocked}
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
            disabled={sessionTransitionBlocked || !open}
            onCreate={handleCreateSession}
            onSwitch={handleSwitchSession}
            onDelete={handleDeleteSession}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleResetConversation}
            disabled={sessionTransitionBlocked}
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
            <Conversation
              active={open}
              scrollKey={conversationScrollKey}
              resumeLabel={m.agentPanel.resumeConversationFollow}
            >
              {isReadyIdle && (
                <Message role="assistant">
                  <MessageContent>{m.agentPanel.chatIntro}</MessageContent>
                  <div className="mt-3 flex flex-wrap gap-2" data-testid="agent-ready-quick-chips">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={chatDisabled}
                      onClick={() => handlePromptSuggestion(m.agentPanel.findSimilarPrompt)}
                    >
                      <Search className="size-3.5" data-icon="inline-start" />
                      {m.agentPanel.quickFindSimilar}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={chatDisabled}
                      onClick={() => handlePromptSuggestion(m.agentPanel.autoAssignPrompt)}
                    >
                      <Tags className="size-3.5" data-icon="inline-start" />
                      {m.agentPanel.quickOrganizeUntagged}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={chatDisabled}
                      onClick={() => handlePromptSuggestion(m.agentPanel.cleanupTagsPrompt)}
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
                          handlePromptSuggestion(m.agentPanel.autoAssignPrompt);
                        }}
                      >
                        {m.agentPanel.quickOrganizeUntagged}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={chatDisabled}
                        onClick={() => handlePromptSuggestion(m.agentPanel.handoffAmbiguous)}
                      >
                        {m.agentPanel.handoffAmbiguous}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={chatDisabled}
                        onClick={() => handlePromptSuggestion(m.agentPanel.handoffExamples)}
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
                readOnly={repositoryCodeReadOnly}
                displayedProcessed={displayedProcessed}
                onInsertCorrection={handlePromptSuggestion}
              />

              {conversationTranscriptAfterWorkbench}

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
                          {isProviderSetupError ? m.agentPanel.providerAuthTitle : m.agentPanel.providerErrorTitle}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                          {isProviderSetupError ? m.agentPanel.providerAuthSubtitle : m.agentPanel.providerErrorSubtitle}
                        </div>
                      </div>
                    </div>
                    <div className="space-y-2 px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
                      <p className="font-medium text-foreground">{error}</p>
                      <p>{isProviderSetupError ? m.agentPanel.providerAuthBody : m.agentPanel.providerErrorBody}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {isProviderSetupError && onOpenOptions && (
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={onOpenOptions}
                          >
                            {m.agentPanel.providerAuthOpenOptions}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={handleRetry}
                          disabled={!retryPrompt || active || !canRetryLastTurn}
                        >
                          {isProviderSetupError ? m.agentPanel.providerAuthRetry : m.agentPanel.retry}
                        </Button>
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
                    <Button size="sm" onClick={handleOpenContextSettings}>
                      <Wrench data-icon="inline-start" />
                      {m.agentPanel.contextAdjustSettings}
                    </Button>
                  )}
                  {contextNeedsPromptEdit && (
                    <Button size="sm" onClick={handleEditContextLimitedPrompt}>
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
                    <Button size="sm" onClick={handleRetryContextLimitedPrompt} disabled={!canRetryLastTurn}>
                      {m.agentPanel.retry}
                    </Button>
                  )}
                  {contextNeedsInternalRetry && !canRetryLastTurn && (
                    <Button size="sm" onClick={handleEditContextLimitedPrompt}>
                      {m.agentPanel.contextEditPrompt}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {showStopbar && (
              <div
                className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-3 py-2"
                data-testid="agent-stopbar"
              >
                <span className="text-xs text-muted-foreground">{stopbarText}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={organizeActive
                    ? workbench.stop
                    : running
                      ? stopTurn
                      : preflightActive ? workbench.cancelPreflight : stopTurn}
                  disabled={applying || organize.preflight?.status === 'starting' || status?.kind === 'stopped'}
                >
                  <CircleStop className="size-4" data-icon="inline-start" />
                  {!running && preflightActive ? m.agentPanel.cancel : m.agentPanel.stop}
                </Button>
              </div>
            )}

            <PromptInput
              value={input}
              onValueChange={setInput}
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

function resolvedScopeCountValue(
  scopeCount: number | undefined,
  defaultCandidate: LaunchCandidateContract,
): number | undefined {
  if (typeof scopeCount === 'number') return scopeCount;
  if (defaultCandidate.kind === 'selected_repository') return 1;
  return undefined;
}

function OrganizeJobRunWorkbench({
  workbench,
  readOnly,
  displayedProcessed,
  onInsertCorrection,
}: {
  workbench: WorkbenchController;
  readOnly: boolean;
  displayedProcessed: number;
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

  useEffect(() => {
    setShowChangedOrFailed(false);
  }, [receipt?.applyId]);

  useEffect(() => {
    if (!durableReceipt) return;
    workbench.requestOrganizeReceiptPage(0, showChangedOrFailed ? 'changed_or_failed' : 'all');
  }, [durableReceipt?.applyId, showChangedOrFailed, workbench.requestOrganizeReceiptPage]);

  const processed = analyzedRepositoryCount(state);
  const total = state.organizeJob?.scopeCount ?? snapshot?.frozenScope.count ?? preflight?.count ?? 0;
  const automaticContinuation = state.continuationPending;
  const currentRunState = currentOrganizeJobState(snapshot, state.organizeJob);
  const analysisInProgress = automaticContinuation || (
    currentRunState !== null
    && ['frozen', 'prepared', 'checking_provider', 'analyzing'].includes(currentRunState)
  );
  const visibleProcessed = Math.min(total, Math.max(processed, displayedProcessed));
  const remaining = Math.max(0, total - processed);
  const displayedRemaining = Math.max(0, total - visibleProcessed);
  const analysisCoverageComplete = state.organizeJob
    ? state.organizeJob.coverage.analyzed === state.organizeJob.coverage.total &&
      state.organizeJob.coverage.analysisFailed === 0
    : hasCompleteAnalysisCoverage(state);
  const proposalReadyForReview = currentRunState === 'review' &&
    !!state.proposal && analysisCoverageComplete;
  const analysisBlocked = !receipt && !automaticContinuation && currentRunState !== null && [
    'budget_exhausted',
    'analysis_blocked',
    'failed',
  ].includes(currentRunState);
  const snapshotMatchesDurablePresentation = !!snapshot && (
    !state.organizeJob || (
      snapshot.runId === state.organizeJob.runId
      && snapshot.generation === state.organizeJob.generation
    )
  );
  const blockedSnapshot = snapshotMatchesDurablePresentation ? snapshot : null;
  const blockedFailureCount = state.organizeJob?.coverage.analysisFailed
    ?? blockedSnapshot?.coverage?.analysisFailed
    ?? 0;

  if (!preflight && !snapshot && !state.organizeJob && !state.error) return null;

  const selectedCount = state.organizeJob?.selectedRepositories ?? 0;
  const applyInFlight = currentRunState === 'apply_sealed' || currentRunState === 'applying';
  const reviewEditable = (
    !!state.proposal
    && analysisCoverageComplete
    && !receipt
    && !applyInFlight
    && state.organizeReviewRequestId === null
    && !readOnly
    && state.organizeJob?.status === 'review'
  );

  const stopMidAnalyze = currentRunState === 'cancelled'
    && snapshotMatchesDurablePresentation
    && snapshot?.state === 'cancelled'
    && !receipt
    && (snapshot.terminalReason === 'user_stopped' || snapshot.terminalReason === 'user_aborted');
  const completedNoChanges = currentRunState === 'completed' && !state.organizeJob?.apply;
  const staleBlockedRows = receipt
    ? receipt.rows.filter((row) => row.reason === 'stale_source')
    : [];
  const receiptRows = receipt
    ? (showChangedOrFailed
      ? receipt.rows.filter((row) => row.outcome === 'changed' || row.outcome === 'failed')
      : receipt.rows)
    : [];
  const runMode: AgentRunMode = receipt
    ? 'receipt'
    : applyInFlight || state.organizeJob?.status === 'paused'
      ? 'apply'
      : currentRunState === 'review'
        ? 'review'
        : snapshot
          ? 'analyze'
          : 'scope';
  return (
    <div className="space-y-3" data-testid="organize-job-workbench">
      <AgentRunStepper mode={runMode} />
      {preflight?.status === 'requesting' && (
        <Message role="system">
          <WorkbenchSection title={m.agentPanel.resolvingScopeHeader} icon={<Spinner />} subtitle={m.agentPanel.workbench.resolvingSubtitle}>
            <p>{m.agentPanel.workbench.resolvingBody}</p>
            <p className="mt-2 text-[11.5px] text-muted-foreground">{m.agentPanel.workbench.resolvingHint}</p>
          </WorkbenchSection>
        </Message>
      )}

      {(preflight?.status === 'ready' || preflight?.status === 'starting') && !snapshot && (
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
                disabled={readOnly || preflight.status === 'starting'}
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
                disabled={preflight.status === 'starting'}
              >
                {m.agentPanel.cancel}
              </Button>
            </div>
          </WorkbenchSection>
        </Message>
      )}

      {preflight?.status === 'no_work' && !snapshot && (
        <Message role="system">
          <WorkbenchSection title={m.agentPanel.nothingToAnalyzeHeader} icon={<CheckCircle2 className="size-4" />} subtitle={preflight.label}>
            <p className="font-medium text-foreground">{m.agentPanel.emptyScopeCount}</p>
            <p className="mt-1">{m.agentPanel.workbench.nothingToAnalyzeBody}</p>
            <div className="mt-2 flex gap-2">
              <Button variant="ghost" size="sm" onClick={workbench.cancelPreflight}>{m.agentPanel.workbench.dismiss}</Button>
            </div>
          </WorkbenchSection>
        </Message>
      )}

      {snapshot && analysisInProgress && !receipt && !analysisBlocked && (
        <Message role="system">
          <WorkbenchSection
            title={m.agentPanel.runStateLabel(
              currentRunState === 'analyzing' || automaticContinuation
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
                  aria-valuenow={visibleProcessed}
                >
                  <div
                    className="h-full rounded-full bg-foreground/80 transition-[width] motion-reduce:transition-none"
                    style={{ width: `${total > 0 ? Math.min(100, (visibleProcessed / total) * 100) : 0}%` }}
                  />
                </div>
                <p
                  className="mt-2 text-[11.5px] text-muted-foreground"
                  data-testid="organize-job-progress-summary"
                >
                  {m.agentPanel.workbench.progressSummary(visibleProcessed, displayedRemaining, 0)}
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
            <p>{m.agentPanel.workbench.analysisBlockedBody(blockedFailureCount)}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {state.organizeJob?.status === 'analysis_blocked' && blockedSnapshot?.continuationCursor && (
                <Button
                  size="sm"
                  onClick={workbench.continueRemaining}
                  disabled={
                    readOnly ||
                    state.transport !== 'connected' ||
                    state.continuationPending
                  }
                >
                  {state.continuationPending
                    ? <Spinner data-icon="inline-start" />
                    : <Play className="size-4" data-icon="inline-start" />}
                  {m.agentPanel.workbench.continueRemaining}
                </Button>
              )}
              <Button
                variant={state.organizeJob?.status === 'analysis_blocked' ? 'outline' : 'default'}
                size="sm"
                onClick={() => workbench.restartWholeLibrary(m.agentPanel.autoAssignPrompt)}
                disabled={readOnly || state.transport !== 'connected' || state.continuationPending}
              >
                <RotateCcw className="size-4" data-icon="inline-start" />
                {m.agentPanel.workbench.restartWholeLibrary}
              </Button>
              {state.organizeJob?.status === 'analysis_blocked' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={workbench.discardBlockedRun}
                  disabled={readOnly || state.transport !== 'connected' || state.continuationPending}
                >
                  <X className="size-4" data-icon="inline-start" />
                  {m.agentPanel.workbench.discardAnalysis}
                </Button>
              )}
            </div>
          </WorkbenchSection>
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
                disabled={readOnly || state.transport !== 'connected'}
              >
                <X className="size-4" data-icon="inline-start" />
                {m.agentPanel.workbench.discardAnalysis}
              </Button>
            </div>
          </Message>
        </>
      )}

      {applyInFlight && state.organizeJob?.apply && !state.proposal && !receipt && (
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

      {state.organizeJob?.status === 'paused' && state.organizeJob.apply && !receipt && (
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
              disabled={readOnly || state.transport !== 'connected'}
            >
              <Play className="size-4" data-icon="inline-start" />
              {m.agentPanel.workbench.continue}
            </Button>
          </WorkbenchSection>
        </Message>
      )}

      {receipt && (
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
                      disabled={state.organizeReceiptPage.rowOffset === 0}
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
                      disabled={state.organizeReceiptPage.nextRowOffset === null}
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
                  >
                    {m.agentPanel.workbench.dismiss}
                  </Button>
                </div>
              </div>
            </div>
        </Message>
      )}

      {stopMidAnalyze && snapshot && (
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
              </div>
            </div>
            <div className="space-y-2 px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
              <p>{m.agentPanel.stopMidAnalyzeBody(processed, remaining)}</p>
              <div className="flex flex-wrap gap-1.5">
                {snapshot.continuationCursor && (
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
              </div>
            </div>
            <div className="px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
              <p>{m.agentPanel.completedNoChangesBody}</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-7 px-2 text-xs"
                onClick={workbench.clearTerminal}
              >
                {m.agentPanel.workbench.dismiss}
              </Button>
            </div>
          </div>
        </Message>
      )}

      {state.error && (
        <Message role="system">
          <div className="rounded-[10px] border border-border bg-card p-3 text-xs text-foreground" role="alert" data-testid="organize-job-error-card">
            {state.error === CONNECTION_INTERRUPTED_COPY
              ? m.agentPanel.workbench.connectionInterrupted
              : state.error === WORKER_LOST_COPY
                ? m.agentPanel.workbench.workerLost
                : state.error === PREFLIGHT_INCOMPLETE_COPY
                  ? m.agentPanel.workbench.analysisScopeIncomplete
                : isStaleOrganizeJobRunError(state.error)
                  ? m.agentPanel.workbench.runStateRefreshed
                  : state.error}
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

function isActiveRunState(state: CurrentOrganizeJobState | null | undefined): boolean {
  return !!state && ![
    'analysis_blocked',
    'review',
    'completed',
    'budget_exhausted',
    'cancelled',
    'failed',
    'interrupted',
    'paused',
  ].includes(state);
}

function isStaleOrganizeJobRunError(error: string): boolean {
  return /OrganizeJobRun identity is stale|Continuation authority is stale|does not belong to this controller\/session/iu.test(error);
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
