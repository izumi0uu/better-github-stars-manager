import {
  type AgentWorkbenchMessages,
  enAgentWorkbenchMessages,
  zhAgentWorkbenchMessages,
} from './agent-workbench';

export type AgentPanelMessages = {
  title: string;
  chatInputLabel: string;
  chatIntro: string;
  chatPlaceholder: string;
  chatPlaceholderScoped: (count: number) => string;
  chatWorking: string;
  autoAssignPrompt: string;
  summarizeScopePrompt: string;
  findSimilarPrompt: string;
  cleanupTagsPrompt: string;
  searchCodePrompt: string;
  reviewNotesPrompt: string;
  quickFindSimilar: string;
  quickOrganizeUntagged: string;
  quickCleanupTags: string;
  functionMenuLabel: string;
  functionMenuTitle: string;
  functionSummarize: string;
  functionSummarizeDescription: string;
  functionFindSimilar: string;
  functionFindSimilarDescription: string;
  functionOrganizeUntagged: string;
  functionOrganizeUntaggedDescription: string;
  functionReviewTags: string;
  functionReviewTagsDescription: string;
  functionSearchCode: string;
  functionSearchCodeDescription: string;
  functionReviewNotes: string;
  functionReviewNotesDescription: string;
  askingAboutCurrentView: (count: number) => string;
  askingAboutAllLiveStars: (count?: number) => string;
  conversationSwitchPending: (scope: string) => string;
  agentChanged: (count: number) => string;
  turnFailed: string;
  attemptStateLost: string;
  attemptResumeStateUnknown: string;
  providerErrorTitle: string;
  providerErrorSubtitle: string;
  providerErrorBody: string;
  retry: string;
  retryDraftStoppedTitle: string;
  retryDraftFailedTitle: string;
  retryDraftContextTitle: string;
  retryDraftSubtitle: string;
  retryDraftBody: string;
  retryDraftPendingSubtitle: string;
  retryDraftPendingBody: string;
  contextSettingsTitle: string;
  contextSettingsMessage: string;
  contextPromptTooLargeTitle: string;
  contextPromptTooLargeMessage: string;
  contextToolMemoryTitle: string;
  contextToolMemoryMessage: string;
  contextToolMemoryWriteBlockedMessage: string;
  contextAdjustSettings: string;
  contextEditPrompt: string;
  composerPausedContextRecovery: string;
  composerWriteRetryBlocked: string;
  startNewConversation: string;
  sessionsLabel: string;
  sessionUntitled: string;
  sessionUnavailable: string;
  sessionDelete: string;
  sessionDeleteTitle: string;
  sessionDeleteMessage: (title: string) => string;
  sessionDeleteConfirm: string;
  sessionDeleteCancel: string;
  sessionDeleteBlocked: string;
  sessionDeleteFailed: string;
  sessionOperationFailed: string;
  sessionLoadFailed: string;
  sessionLoadTitle: string;
  sessionLoadSubtitle: string;
  sessionLoadBody: string;
  sessionLoadRetry: string;
  loadEarlierMessages: string;
  loadingEarlierMessages: string;
  runContinuesWhileHidden: string;
  confirmScopeHeader: string;
  analyzingHeader: (processed: number, total: number) => string;
  frozenScopeNote: (count: number) => string;
  pendingConfirmationNote: (count: number) => string;
  hideAgent: string;
  stop: string;
  pause: string;
  cancel: string;
  applyingHeader: (done: number, total: number) => string;
  applyingSubtitle: string;
  applyingStopbar: string;
  composerPausedApplying: string;
  nothingToAnalyzeHeader: string;
  nothingToAnalyzeBody: string;
  emptyScopeCount: string;
  handoffHeader: string;
  handoffTitle: string;
  handoffSubtitle: (count: number) => string;
  handoffBody: string;
  handoffAsk: (count: number) => string;
  handoffAmbiguous: string;
  handoffExamples: string;
  handoffScopeNote: (count: number) => string;
  partialReceiptHeader: string;
  resolvingScopeHeader: string;
  scopeNotFrozenYet: string;
  reviewFollowUpNote: string;
  reviewFollowUpPlaceholder: string;
  reviewConversationDetails: string;
  stopMidAnalyzeHeader: string;
  stopMidAnalyzeTitle: string;
  stopMidAnalyzeSubtitle: string;
  stopMidAnalyzeBody: (processed: number, remaining: number) => string;
  stopMidAnalyzeResume: string;
  stopMidAnalyzeDiscard: string;
  staleSourceTitle: string;
  staleSourceBody: string;
  providerAuthHeader: string;
  providerAuthTitle: string;
  providerAuthSubtitle: string;
  providerAuthBody: string;
  providerAuthOpenOptions: string;
  providerAuthRetry: string;
  completedNoChangesHeader: string;
  completedNoChangesTitle: string;
  completedNoChangesSubtitle: (inspected: number) => string;
  completedNoChangesBody: string;
  agentQueued: string;
  agentCompacting: string;
  agentStarting: string;
  agentThinking: string;
  agentWriting: string;
  agentReadingData: string;
  agentSearchingCode: string;
  agentPreparingOrganizationScope: string;
  agentApplyingChanges: string;
  agentDone: string;
  agentStopped: string;
  agentToolQueued: string;
  agentToolRunning: string;
  agentToolCompleted: string;
  agentToolFailed: string;
  codeSearchStatus: (status: string, count: number) => string;
  codeSearchUntrusted: string;
  repositoryCodeReadOnly: string;
  codeSearchOpenSource: string;
  resumeConversationFollow: string;
  toolResult: string;
  emptyAgentMessage: string;
  send: string;
  closeTitle: string;
  agentSettings: string;
  loadingSuggestions: string;
  emptyTitle: string;
  emptyBody: string;
  applied: (count: number) => string;
  loadFailed: string;
  created: (count: number) => string;
  range: (start: number, end: number, total: number) => string;
  toolbarApplying: string;
  toolbarReview: string;
  toolbarInterrupted: string;
  scopeReady: string;
  runStateLabel: (value: string) => string;
  needsReviewSelected: (count: number) => string;
  appliedTagChanges: (count: number) => string;
  followUpAboutScope: string;
  askingAboutCurrentViewUnknown: string;
  handoffAutoTagsUpdated: string;
  agentActivityLabel: string;
  workbench: AgentWorkbenchMessages;
};

export const enAgentPanelMessages: AgentPanelMessages = {
  title: "Cubby",
  chatInputLabel: "Ask Cubby",
  chatIntro:
    "Hey, I'm Cubby. Tell me what you want to organize.",
  chatPlaceholder: "Ask about your repositories…",
  chatPlaceholderScoped: (count) => (
    count <= 0
      ? "Ask about your repositories…"
      : count === 1
        ? "Ask me about this repository…"
        : `Ask me about these ${count} repositories…`
  ),
  chatWorking: "Cubby is looking into it…",
  autoAssignPrompt:
    "Organize untagged repositories across the entire starred library with useful semantic tags. Inspect every live star first, add manual tags only when repository topics, names, descriptions, or existing tags provide clear evidence, then return one complete review before applying anything.",
  summarizeScopePrompt:
    "Inspect the repositories in the current scope and summarize what they are for, the strongest patterns, and notable differences. Use local repository metadata and do not change tags.",
  findSimilarPrompt:
    "Find similar tools in this scope and compare the strongest options with clear evidence from local repository metadata.",
  cleanupTagsPrompt:
    "Review tag usage in this view. Clean up duplicate, inconsistent, or unused tags, then summarize the changes.",
  searchCodePrompt:
    "Search the selected repository's indexed public code. Explain its architecture and key implementation files. Do not change tags.",
  reviewNotesPrompt:
    "Summarize the private notes saved for the selected repository. Do not change tags.",
  quickFindSimilar: "Find similar tools",
  quickOrganizeUntagged: "Organize full library",
  quickCleanupTags: "Clean up tags",
  functionMenuLabel: "Suggested actions",
  functionMenuTitle: "Choose an action",
  functionSummarize: "Summarize this view",
  functionSummarizeDescription: "Explain what these repositories do and highlight common themes.",
  functionFindSimilar: "Compare similar repositories",
  functionFindSimilarDescription: "Compare similar repositories using local metadata.",
  functionOrganizeUntagged: "Organize full library",
  functionOrganizeUntaggedDescription: "Analyze every live star and prepare one complete tag review.",
  functionReviewTags: "Clean up tags",
  functionReviewTagsDescription: "Inspect local usage and clean up duplicate, inconsistent, or unused tags.",
  functionSearchCode: "Search repository code",
  functionSearchCodeDescription: "Inspect indexed public code for the selected repository.",
  functionReviewNotes: "Review repository notes",
  functionReviewNotesDescription: "Read the private notes attached to the selected repository.",
  askingAboutCurrentView: (count) => (
    count === 1
      ? "Current view · 1 repository"
      : `Current view · ${count} repositories`
  ),
  askingAboutAllLiveStars: (count) => (
    typeof count === "number"
      ? (count === 1
        ? "All starred repositories · 1 repository"
        : `All starred repositories · ${count} repositories`)
      : "All starred repositories"
  ),
  conversationSwitchPending: (scope) => (
    `Selected ${scope} · finish or discard the current Organize run to switch conversations`
  ),
  agentChanged: (count) => `${count} tag update${count === 1 ? '' : 's'} applied`,
  turnFailed: "Cubby couldn't complete this request",
  attemptStateLost: "The extension restarted, so Cubby couldn't recover this request. Check any completed changes before retrying.",
  attemptResumeStateUnknown: "Cubby couldn't confirm this resumed request's final state. Direct retry is disabled to avoid repeating a completed change. Review the result, then edit and send again.",
  providerErrorTitle: "AI service error",
  providerErrorSubtitle: "No local data was modified",
  providerErrorBody: "Your message and scope are saved. Retry, or start a new conversation.",
  retry: "Retry",
  retryDraftStoppedTitle: "Stopped request restored",
  retryDraftFailedTitle: "Failed request restored",
  retryDraftContextTitle: "Context-limited request restored",
  retryDraftSubtitle: "Ready to retry",
  retryDraftBody: "The prompt is restored in the composer. Retry it as-is or edit it first.",
  retryDraftPendingSubtitle: "Retry needs confirmation",
  retryDraftPendingBody: "The prompt is restored, but Cubby could not confirm that no change was applied. Review or edit it before sending a new request.",
  contextSettingsTitle: "AI service settings need attention",
  contextSettingsMessage: "Adjust this service's context settings before continuing. Your draft is preserved.",
  contextPromptTooLargeTitle: "This request is too large",
  contextPromptTooLargeMessage: "Shorten the draft, or increase the configured context limit if your AI service supports it.",
  contextToolMemoryTitle: "Cubby reached this request's data limit",
  contextToolMemoryMessage: "Your prompt and completed results were preserved. Retry to continue; you do not need to shorten the prompt or change the model context window.",
  contextToolMemoryWriteBlockedMessage: "Completed results are saved, but a change may already be applied. Review the results before retrying.",
  contextAdjustSettings: "Adjust AI service settings",
  contextEditPrompt: "Edit prompt",
  composerPausedContextRecovery: "Draft preserved · choose a recovery action above",
  composerWriteRetryBlocked: "A change may already be applied. Review the results before retrying.",
  startNewConversation: "Start new conversation",
  sessionsLabel: "Conversations",
  sessionUntitled: "New conversation",
  sessionUnavailable: "Unavailable conversation",
  sessionDelete: "Delete conversation",
  sessionDeleteTitle: "Delete this conversation?",
  sessionDeleteMessage: (title) => `Delete “${title}”? Its conversation history, recovery state, and saved tool data will be deleted. The latest completed or cancelled Organize result is kept until you dismiss it or a new run replaces it.`,
  sessionDeleteConfirm: "Delete",
  sessionDeleteCancel: "Cancel",
  sessionDeleteBlocked: "Finish, stop, or discard the active work linked to this conversation before deleting it.",
  sessionDeleteFailed: "This conversation could not be deleted. Try again.",
  sessionOperationFailed: "The conversation could not be loaded. Try again.",
  sessionLoadFailed: "Local conversation history is temporarily unavailable.",
  sessionLoadTitle: "Couldn't load conversations",
  sessionLoadSubtitle: "Cubby is waiting for local history.",
  sessionLoadBody: "Try again. Your saved conversations have not been changed.",
  sessionLoadRetry: "Try again",
  loadEarlierMessages: "Load earlier messages",
  loadingEarlierMessages: "Loading earlier messages…",
  runContinuesWhileHidden: "You can hide this panel; the turn continues.",
  confirmScopeHeader: "Confirm scope",
  analyzingHeader: (processed, total) => `Analyzing · ${processed}/${total}`,
  frozenScopeNote: (count) => (
    count === 1
      ? "Locked scope · 1 repository"
      : `Locked scope · ${count} repositories`
  ),
  pendingConfirmationNote: (count) => (
    count === 1
      ? "Pending confirmation · 1 repository"
      : `Pending confirmation · ${count} repositories`
  ),
  hideAgent: "Hide Cubby",
  stop: "Stop",
  pause: "Pause",
  cancel: "Cancel",
  applyingHeader: (done, total) => `Applying · ${done}/${total}`,
  applyingSubtitle: "Manual tags · scope remains locked",
  applyingStopbar: "Pause after the current repository finishes.",
  composerPausedApplying: "Composer paused while applying",
  nothingToAnalyzeHeader: "Nothing to analyze",
  nothingToAnalyzeBody: "Either every visible repo already has tags, or the active filters hide the candidates. Change filters or broaden scope, then ask again.",
  emptyScopeCount: "0 repositories match this scope.",
  handoffHeader: "Handoff · still untagged",
  handoffTitle: "From Auto Tags",
  handoffSubtitle: (count) => `Auto Tags finished · ${count} still untagged`,
  handoffBody: "Auto Tags added local tags from GitHub topics. Cubby will review only the remaining untagged repositories and won't overwrite those results unless you apply manual tags.",
  handoffAsk: (count) => `Auto Tags left ${count} repositories untagged. I can take a closer look and suggest careful manual tags. Want me to?`,
  handoffAmbiguous: "Only show the ambiguous ones",
  handoffExamples: "Explain a few examples first",
  handoffScopeNote: (count) => (
    count === 1
      ? "Still untagged after Auto Tags · 1 repository"
      : `Still untagged after Auto Tags · ${count} repositories`
  ),
  partialReceiptHeader: "Applied with conflicts",
  resolvingScopeHeader: "Resolving scope…",
  scopeNotFrozenYet: "Scope is not locked yet",
  reviewFollowUpNote: "Review still open · follow-ups allowed",
  reviewFollowUpPlaceholder: "Ask about these suggestions…",
  reviewConversationDetails: "Conversation details",
  stopMidAnalyzeHeader: "Stopped by you",
  stopMidAnalyzeTitle: "Analysis stopped",
  stopMidAnalyzeSubtitle: "Stopped before any changes were applied",
  stopMidAnalyzeBody: (processed, remaining) => (
    `Pending analysis cancelled. Completed reads: ${processed}. Not started: ${remaining}. Committed writes: 0.`
  ),
  stopMidAnalyzeResume: "Continue remaining in a new analysis",
  stopMidAnalyzeDiscard: "Discard",
  staleSourceTitle: "Repository data changed",
  staleSourceBody: "Cubby skipped suggestions based on older data. Refresh only those conflicts.",
  providerAuthHeader: "AI service authorization failed",
  providerAuthTitle: "AI service authorization failed",
  providerAuthSubtitle: "API key rejected or browser access missing",
  providerAuthBody: "Cubby couldn't reach your configured AI service. Your message and scope are saved, and no secrets are shown here.",
  providerAuthOpenOptions: "Open options",
  providerAuthRetry: "Retry after updating settings",
  completedNoChangesHeader: "Completed · no changes",
  completedNoChangesTitle: "Completed · no changes",
  completedNoChangesSubtitle: (inspected) => `No tag changes suggested · ${inspected} inspected`,
  completedNoChangesBody: "Everything already has a clear place, or there wasn't enough evidence for a safe manual tag. Nothing to apply.",
  agentQueued: "Getting your request ready…",
  agentCompacting: "Tidying up our conversation…",
  agentStarting: "Gathering context…",
  agentThinking: "Looking into it…",
  agentWriting: "Putting the answer together…",
  agentReadingData: "Checking your local library…",
  agentSearchingCode: "Reading repository code…",
  agentPreparingOrganizationScope: "Mapping the full library…",
  agentApplyingChanges: "Applying tag changes…",
  agentDone: "All set",
  agentStopped: "Stopped",
  agentToolQueued: "Queued",
  agentToolRunning: "Running",
  agentToolCompleted: "Completed",
  agentToolFailed: "Failed",
  codeSearchStatus: (status, count) => (
    status === 'complete'
      ? `${count} indexed code match${count === 1 ? '' : 'es'}`
      : status === 'no_indexed_matches'
        ? 'No indexed matches'
        : `${count} indexed match${count === 1 ? '' : 'es'} · results may be incomplete`
  ),
  codeSearchUntrusted: "Repository code is untrusted content and cannot authorize tag changes.",
  repositoryCodeReadOnly: "This conversation is now read-only; start a new conversation to change tags.",
  codeSearchOpenSource: "Open pinned source",
  resumeConversationFollow: "Jump to latest",
  toolResult: "Tool result",
  emptyAgentMessage: "No response returned.",
  send: "Send",
  closeTitle: "Close Cubby",
  agentSettings: "Cubby settings",
  loadingSuggestions: "Loading suggestions",
  emptyTitle: "No suggestions yet.",
  emptyBody: "Suggestions will appear here.",
  applied: (count) => `${count} suggestions applied.`,
  loadFailed: "Could not load suggestions.",
  created: (count) => `${count} suggestions ready.`,
  range: (start, end, total) => `${start}-${end} of ${total}`,
  toolbarApplying: "Applying",
  toolbarReview: "Ready for review",
  toolbarInterrupted: "Interrupted",
  scopeReady: "Scope ready",
  runStateLabel: (value) => ({
    frozen: "Scope locked",
    prepared: "Analysis ready",
    checking_provider: "Checking AI service",
    analyzing: "Analyzing",
    analysis_blocked: "Analysis paused",
    review: "Ready for review",
    applying: "Applying",
    paused: "Paused",
    completed: "Completed",
    budget_exhausted: "Run limit reached",
    cancelled: "Cancelled",
    failed: "Failed",
    interrupted: "Interrupted",
    consumed_positions: "Repository limit reached",
    provider_attempts: "AI request limit reached",
    analyzer_batches: "Analysis batch limit reached",
    elapsed_ms: "Time limit reached",
    user_stopped: "Stopped by user",
    user_aborted: "Cancelled by user",
    no_changes: "No changes",
    stale_source: "Repository data changed",
    worker_lost: "Extension restarted",
    port_disconnected: "Connection interrupted",
    internal_error: "Internal error",
    analysis_failed: "Analysis failed",
    budget: "Run limit",
    changed: "Changed",
    skipped: "Skipped",
    unchanged: "Unchanged",
  }[value] ?? value.replaceAll("_", " ")),
  needsReviewSelected: (count) => `Needs review · ${count} selected`,
  appliedTagChanges: (count) => `Applied ${count} tag ${count === 1 ? "change" : "changes"}`,
  followUpAboutScope: "Ask a follow-up about this scope",
  askingAboutCurrentViewUnknown: "Current view",
  handoffAutoTagsUpdated: "Auto Tags already updated topic-based auto tags.",
  agentActivityLabel: "Cubby activity",
  workbench: enAgentWorkbenchMessages,
};

export const zhAgentPanelMessages: AgentPanelMessages = {
  title: "Cubby",
  chatInputLabel: "问问 Cubby",
  chatIntro:
    "嗨，我是 Cubby。告诉我你想整理什么吧。",
  chatPlaceholder: "问问你的仓库…",
  chatPlaceholderScoped: (count) => (
    count <= 0
      ? "问问你的仓库…"
      : count === 1
        ? "想了解这个仓库什么？"
        : `想了解这 ${count} 个仓库什么？`
  ),
  chatWorking: "Cubby 正在仔细查看…",
  autoAssignPrompt:
    "整理整个星标资料库中尚未标注的仓库。先检查全部仍在收藏的仓库，只在 GitHub topics、名称、描述或已有标签有明确依据时添加手动标签；完成全库分析后只返回一次完整审阅，再应用任何变更。",
  summarizeScopePrompt:
    "检查当前范围内的仓库，总结它们的用途、主要模式和值得注意的差异。使用本地仓库元数据，不要修改标签。",
  findSimilarPrompt:
    "在当前范围内找相似工具，并用本地仓库元数据给出有证据的对比。",
  cleanupTagsPrompt:
    "检查当前视图中的标签使用情况，清理重复、命名不一致或未使用的标签，并总结改动。",
  searchCodePrompt:
    "搜索所选仓库已建立索引的公开代码，说明整体架构和关键实现文件。不要修改标签。",
  reviewNotesPrompt:
    "总结为所选仓库保存的私人笔记。不要修改标签。",
  quickFindSimilar: "找相似工具",
  quickOrganizeUntagged: "整理整个资料库",
  quickCleanupTags: "清理标签",
  functionMenuLabel: "建议操作",
  functionMenuTitle: "选择操作",
  functionSummarize: "总结当前视图",
  functionSummarizeDescription: "说明这些仓库的用途，并概括共同主题。",
  functionFindSimilar: "比较相似仓库",
  functionFindSimilarDescription: "根据本地元数据比较相似仓库。",
  functionOrganizeUntagged: "整理整个资料库",
  functionOrganizeUntaggedDescription: "分析全部仍在收藏的仓库并准备一次完整标签审阅。",
  functionReviewTags: "清理标签",
  functionReviewTagsDescription: "检查本地使用情况并清理重复、命名不一致或未使用的标签。",
  functionSearchCode: "搜索仓库代码",
  functionSearchCodeDescription: "检查选中仓库的公开代码索引。",
  functionReviewNotes: "查看仓库笔记",
  functionReviewNotesDescription: "读取选中仓库关联的私人笔记。",
  askingAboutCurrentView: (count) => (
    count === 1
      ? "当前视图 · 1 个仓库"
      : `当前视图 · ${count} 个仓库`
  ),
  askingAboutAllLiveStars: (count) => (
    typeof count === "number"
      ? (count === 1
        ? "全部星标仓库 · 1 个仓库"
        : `全部星标仓库 · ${count} 个仓库`)
      : "全部星标仓库"
  ),
  conversationSwitchPending: (scope) => (
    `已选择 ${scope} · 完成或放弃当前整理任务后切换对话`
  ),
  agentChanged: (count) => `已应用 ${count} 次标签更新`,
  turnFailed: "Cubby 未能完成这次请求",
  attemptStateLost: "扩展已重启，Cubby 无法恢复这次请求。重试前请检查已完成的变更。",
  attemptResumeStateUnknown: "Cubby 无法确认这次恢复请求的最终状态。为避免重复执行已完成的变更，直接重试已禁用；请检查结果后编辑并重新发送。",
  providerErrorTitle: "AI 服务错误",
  providerErrorSubtitle: "本地数据未被修改",
  providerErrorBody: "你的消息和范围已保存。可以重试，或开始新对话。",
  retry: "重试",
  retryDraftStoppedTitle: "已恢复停止的请求",
  retryDraftFailedTitle: "已恢复失败的请求",
  retryDraftContextTitle: "已恢复受上下文限制的请求",
  retryDraftSubtitle: "可以重新尝试",
  retryDraftBody: "提示词已恢复到输入框。你可以直接重试，也可以先编辑。",
  retryDraftPendingSubtitle: "重试仍需确认",
  retryDraftPendingBody: "提示词已恢复，但 Cubby 尚无法确认是否已有变更生效。请检查或编辑后，再作为新请求发送。",
  contextSettingsTitle: "AI 服务设置需要调整",
  contextSettingsMessage: "请先调整此服务的上下文设置。你的草稿已保留。",
  contextPromptTooLargeTitle: "本次请求内容过多",
  contextPromptTooLargeMessage: "请缩短草稿；如果 AI 服务支持，也可以调高已配置的上下文上限。",
  contextToolMemoryTitle: "Cubby 已达到这次请求的数据上限",
  contextToolMemoryMessage: "你的提示词和已完成结果都已保留。可直接重试继续处理，无需缩短提示词或调整模型上下文窗口。",
  contextToolMemoryWriteBlockedMessage: "已完成的结果已保存，但部分变更可能已经应用。请检查结果后再重试。",
  contextAdjustSettings: "调整 AI 服务设置",
  contextEditPrompt: "编辑提示词",
  composerPausedContextRecovery: "草稿已保留 · 请从上方选择恢复方式",
  composerWriteRetryBlocked: "部分变更可能已经应用，请检查结果后再重试。",
  startNewConversation: "开始新对话",
  sessionsLabel: "对话列表",
  sessionUntitled: "新对话",
  sessionUnavailable: "不可用的对话",
  sessionDelete: "删除对话",
  sessionDeleteTitle: "删除这个对话？",
  sessionDeleteMessage: (title) => `确定删除「${title}」吗？其对话历史、恢复状态和已保存的工具数据都会被删除。最近一次已完成或已取消的整理结果会保留，直到你关闭它或被新的运行替换。`,
  sessionDeleteConfirm: "删除",
  sessionDeleteCancel: "取消",
  sessionDeleteBlocked: "请先完成、停止或丢弃与这个对话关联的任务，再删除对话。",
  sessionDeleteFailed: "无法删除这个对话，请重试。",
  sessionOperationFailed: "无法加载这个对话，请重试。",
  sessionLoadFailed: "本地对话历史暂时不可用。",
  sessionLoadTitle: "无法加载对话",
  sessionLoadSubtitle: "Cubby 正在等待本地历史恢复。",
  sessionLoadBody: "请重试；你已保存的对话不会受到影响。",
  sessionLoadRetry: "重试",
  loadEarlierMessages: "加载更早的消息",
  loadingEarlierMessages: "正在加载更早的消息…",
  runContinuesWhileHidden: "可以隐藏面板；本轮会继续。",
  confirmScopeHeader: "确认范围",
  analyzingHeader: (processed, total) => `分析中 · ${processed}/${total}`,
  frozenScopeNote: (count) => (
    count === 1
      ? "范围已锁定 · 1 个仓库"
      : `范围已锁定 · ${count} 个仓库`
  ),
  pendingConfirmationNote: (count) => (
    count === 1
      ? "待确认 · 1 个仓库"
      : `待确认 · ${count} 个仓库`
  ),
  hideAgent: "隐藏 Cubby",
  stop: "停止",
  pause: "暂停",
  cancel: "取消",
  applyingHeader: (done, total) => `应用中 · ${done}/${total}`,
  applyingSubtitle: "手动标签 · 范围仍保持锁定",
  applyingStopbar: "当前仓库处理完成后暂停。",
  composerPausedApplying: "应用期间暂停输入",
  nothingToAnalyzeHeader: "没有可分析内容",
  nothingToAnalyzeBody: "可见仓库可能都已有标签，或当前筛选隐藏了候选。请调整筛选或扩大范围后再问。",
  emptyScopeCount: "此范围匹配 0 个仓库。",
  handoffHeader: "交接 · 仍未标注",
  handoffTitle: "来自 Auto Tags",
  handoffSubtitle: (count) => `Auto Tags 已完成 · 仍有 ${count} 个未标注`,
  handoffBody: "Auto Tags 已根据 GitHub 主题添加本地标签。Cubby 只会检查剩余未标注仓库，除非你应用手动标签，否则不会覆盖这些结果。",
  handoffAsk: (count) => `Auto Tags 留下了 ${count} 个未标注仓库。我可以再仔细看看，并建议合适的手动标签。要继续吗？`,
  handoffAmbiguous: "只看不明确的",
  handoffExamples: "先解释几个例子",
  handoffScopeNote: (count) => (
    count === 1
      ? "Auto Tags 后仍未标注 · 1 个仓库"
      : `Auto Tags 后仍未标注 · ${count} 个仓库`
  ),
  partialReceiptHeader: "已应用，但有冲突",
  resolvingScopeHeader: "正在解析范围…",
  scopeNotFrozenYet: "范围尚未锁定",
  reviewFollowUpNote: "审阅仍打开 · 可继续追问",
  reviewFollowUpPlaceholder: "询问这些标签建议…",
  reviewConversationDetails: "对话细节",
  stopMidAnalyzeHeader: "已由你停止",
  stopMidAnalyzeTitle: "分析已停止",
  stopMidAnalyzeSubtitle: "停止前没有应用任何变更",
  stopMidAnalyzeBody: (processed, remaining) => (
    `待处理分析已取消。已完成读取：${processed}。未开始：${remaining}。已提交写入：0。`
  ),
  stopMidAnalyzeResume: "在新分析中继续剩余项",
  stopMidAnalyzeDiscard: "丢弃",
  staleSourceTitle: "仓库数据已更新",
  staleSourceBody: "Cubby 已跳过基于旧数据的建议，只需刷新这些冲突项。",
  providerAuthHeader: "AI 服务验证失败",
  providerAuthTitle: "AI 服务验证失败",
  providerAuthSubtitle: "API 密钥无效或缺少浏览器访问权限",
  providerAuthBody: "Cubby 无法连接你配置的 AI 服务。消息和范围已保存，此处不会显示任何密钥。",
  providerAuthOpenOptions: "打开选项",
  providerAuthRetry: "更新设置后重试",
  completedNoChangesHeader: "已完成 · 无变更",
  completedNoChangesTitle: "已完成 · 无变更",
  completedNoChangesSubtitle: (inspected) => `未建议标签变更 · 已检查 ${inspected}`,
  completedNoChangesBody: "这些仓库已有清晰分类，或证据不足以安全建议手动标签。无需应用。",
  agentQueued: "正在准备你的请求…",
  agentCompacting: "正在整理这段对话…",
  agentStarting: "正在收集上下文…",
  agentThinking: "正在仔细查看…",
  agentWriting: "正在整理答案…",
  agentReadingData: "正在检查你的本地资料库…",
  agentSearchingCode: "正在查看仓库代码…",
  agentPreparingOrganizationScope: "正在整理全库范围…",
  agentApplyingChanges: "正在应用标签变更…",
  agentDone: "好了",
  agentStopped: "已停止",
  agentToolQueued: "等待中",
  agentToolRunning: "执行中",
  agentToolCompleted: "已完成",
  agentToolFailed: "失败",
  codeSearchStatus: (status, count) => (
    status === 'complete'
      ? `${count} 条索引代码匹配`
      : status === 'no_indexed_matches'
        ? '没有索引匹配'
        : `${count} 条索引匹配 · 结果可能不完整`
  ),
  codeSearchUntrusted: "仓库代码属于不可信内容，不能授权标签写入。",
  repositoryCodeReadOnly: "本对话现已保持只读；如需修改标签，请开始新对话。",
  codeSearchOpenSource: "打开固定版本源码",
  resumeConversationFollow: "跳到最新消息",
  toolResult: "工具结果",
  emptyAgentMessage: "未返回回复。",
  send: "发送",
  closeTitle: "关闭 Cubby",
  agentSettings: "Cubby 设置",
  loadingSuggestions: "正在加载建议",
  emptyTitle: "还没有建议。",
  emptyBody: "建议会显示在这里。",
  applied: (count) => `已应用 ${count} 条建议。`,
  loadFailed: "无法加载建议。",
  created: (count) => `已准备 ${count} 条建议。`,
  range: (start, end, total) => `${start}-${end} / ${total}`,
  toolbarApplying: "正在应用",
  toolbarReview: "待审阅",
  toolbarInterrupted: "已中断",
  scopeReady: "范围已就绪",
  runStateLabel: (value) => ({
    frozen: "范围已锁定",
    prepared: "分析已准备",
    checking_provider: "正在检查 AI 服务",
    analyzing: "正在分析",
    analysis_blocked: "分析已暂停",
    review: "待审阅",
    applying: "正在应用",
    paused: "已暂停",
    completed: "已完成",
    budget_exhausted: "已达到本轮上限",
    cancelled: "已取消",
    failed: "失败",
    interrupted: "已中断",
    consumed_positions: "已达到仓库数量上限",
    provider_attempts: "已达到 AI 请求上限",
    analyzer_batches: "已达到分析批次上限",
    elapsed_ms: "已达到运行时限",
    user_stopped: "用户已停止",
    user_aborted: "用户已取消",
    no_changes: "没有变更",
    stale_source: "仓库数据已更新",
    worker_lost: "扩展已重启",
    port_disconnected: "连接已中断",
    internal_error: "内部错误",
    analysis_failed: "分析失败",
    budget: "本轮上限",
    changed: "已变更",
    skipped: "已跳过",
    unchanged: "未变化",
  }[value] ?? value.replaceAll("_", " ")),
  needsReviewSelected: (count) => `待审阅 · 已选择 ${count} 条`,
  appliedTagChanges: (count) => `已应用 ${count} 项标签变更`,
  followUpAboutScope: "继续询问此范围",
  askingAboutCurrentViewUnknown: "当前视图",
  handoffAutoTagsUpdated: "自动标签已更新基于主题的标签。",
  agentActivityLabel: "Cubby 活动",
  workbench: zhAgentWorkbenchMessages,
};
