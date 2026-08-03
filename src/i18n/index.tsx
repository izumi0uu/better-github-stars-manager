import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { authStore, CONFIG_STORAGE_KEY } from "@/auth/auth-store";
import type { Locale, SyncProgress } from "@/types";

export interface MessageCatalog {
  localeName: string;
  common: {
    untagged: string;
    remove: string;
    add: string;
    bulk: string;
    save: string;
    saved: string;
    unsaved: string;
    cancel: string;
    apply: string;
    loading: string;
    none: string;
    close: string;
    previous: string;
    next: string;
    current: (value: string) => string;
    phase: (phase: SyncProgress["phase"]) => string;
  };
  dev: {
    version: (hash: string) => string;
    clearLocalData: string;
    confirmClearLocalData: string;
    clearingLocalData: string;
    clearLocalDataFailed: (error: string) => string;
  };
  manager: {
    syncFailed: (label: string, error: string) => string;
    autoAssignDone: (count: number) => string;
    autoAssignFailed: (error: string) => string;
    autoTagAgentPromptTitle: string;
    autoTagAgentPromptBody: string;
    autoTagAgentPromptYes: string;
    autoTagAgentPromptNo: string;
    deleteTagFailed: (error: string) => string;
    deleteAllTagsFailed: (error: string) => string;
    noTokenBanner: string;
    addPat: string;
    emptyState: string;
    backfillSyncTitle: string;
    backfillSyncBody: string;
    backfillSyncAction: string;
    backfillSyncRetry: string;
    backfillSyncLater: string;
    backfillSyncRunning: string;
    backfillSyncFailed: (error: string) => string;
  };
  toolbar: {
    searchPlaceholder: string;
    searchClearTitle: string;
    sortStarredAt: string;
    sortPushedAt: string;
    sortCreatedAt: string;
    sortStars: string;
    sortName: string;
    toggleSortDir: string;
    syncTitle: string;
    syncButton: string;
    fullSyncTitle: string;
    fullSyncButton: string;
    themeTitle: string;
    /** Tooltip for the GitHub-home icon button (jump back to github.com). */
    githubHomeTitle: string;
    /** Tooltip for the toolbar "hide panel" button (retract the overlay → native list). */
    hidePanelTitle: string;
    /** Tooltip for the "Star the project" link (opens the repo). */
    starRepoTitle: string;
    autoAssignTitle: string;
    autoAssignButton: string;
    agentTitle: string;
    agentButton: string;
    gistTitle: string;
    gistButton: string;
    gistPushing: string;
    gistPulling: string;
    gistPushTitle: string;
    gistPushButton: string;
    gistPullTitle: string;
    gistPullButton: string;
    gistLinkTitle: string;
    moreTitle: string;
    shownTotal: (shown: number, total: number) => string;
    noToken: string;
    accountTitle: (username: string) => string;
    columnRepository: string;
    columnDescription: string;
    columnLanguage: string;
    columnStars: string;
    columnUpdated: string;
    columnCreated: string;
    columnTags: string;
    columnStarAction: string;
    columnFavorite: string;
    columnNotes: string;
    viewLabel: string;
    defaultLayout: string;
    customLayout: string;
    customLayoutChanged: string;
    editLayout: string;
    previewCustomLayout: string;
    editingLayout: string;
    columnsButton: string;
    columnsButtonTitle: string;
    hiddenColumns: (count: number) => string;
    hiddenColumnsTip: string;
    hideColumn: (label: string) => string;
    restoreColumn: (label: string) => string;
    dragColumnTitle: (label: string) => string;
    dragColumnHint: string;
    dragHideHint: (label: string) => string;
    dragTrayHint: string;
    dragInsertHint: string;
    resizeColumnTitle: (label: string) => string;
    lockedColumn: string;
    fitWidths: string;
    resetWidths: string;
    resetLayout: string;
    resizeFrozenPeers: string;
    resizeFitExplicit: string;
    resizeDefaultGuide: (width: number) => string;
    resizeBadgeDefault: string;
    resizeBadgeMin: string;
    resizeDeltaCurrentOnly: string;
    resizeWidthReadout: (tableWidth: number, panelWidth: number, overflow: number) => string;
    resizeLiveWidthReadout: (label: string, width: number, delta: number, tableWidth: number, panelWidth: number, overflow: number) => string;
  };
  agentPanel: {
    title: string;
    chatInputLabel: string;
    chatHeaderIdle: string;
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
    askingAboutSelectedRepository: string;
    askingAboutAllLiveStars: (count?: number) => string;
    agentChanged: (count: number) => string;
    turnFailed: string;
    attemptStateLost: string;
    answerReady: string;
    providerErrorTitle: string;
    providerErrorSubtitle: string;
    providerErrorBody: string;
    retry: string;
    noLocalDataModified: string;
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
    sessionDelete: string;
    sessionDeleteTitle: string;
    sessionDeleteMessage: (title: string) => string;
    sessionDeleteConfirm: string;
    sessionDeleteCancel: string;
    hideWhileRunning: string;
    runContinuesWhileHidden: string;
    confirmScopeHeader: string;
    analyzingHeader: (processed: number, total: number) => string;
    analyzingTitle: string;
    analyzingMeta: (processed: number, remaining: number, batches: number) => string;
    frozenScopeNote: (count: number) => string;
    pendingConfirmationNote: (count: number) => string;
    turnFrozenScopeNote: (count: number) => string;
    conversationFrozenScope: (label: string, count: number) => string;
    readOnlyResultTitle: string;
    readOnlyResultSubtitle: string;
    noTagChangesProposed: string;
    hideAgent: string;
    stop: string;
    cancel: string;
    applyingHeader: (done: number, total: number) => string;
    applyingTitle: string;
    applyingSubtitle: string;
    applyingMeta: (done: number, total: number) => string;
    applyingButton: string;
    applyingStopbar: string;
    composerPausedApplying: string;
    budgetExhaustedHeader: string;
    budgetExhaustedTitle: (reason: string) => string;
    budgetExhaustedSubtitle: (processed: number, total: number) => string;
    budgetExhaustedBody: string;
    continueRemainingCount: (count: number) => string;
    nothingToAnalyzeHeader: string;
    nothingToAnalyzeTitle: string;
    nothingToAnalyzeBody: string;
    emptyScopeCount: string;
    handoffHeader: string;
    handoffTitle: string;
    handoffSubtitle: (count: number) => string;
    handoffBody: string;
    handoffAsk: (count: number) => string;
    handoffOrganize: (count: number) => string;
    handoffAmbiguous: string;
    handoffExamples: string;
    handoffScopeNote: (count: number) => string;
    destructiveHeader: string;
    destructiveTitle: string;
    destructiveSubtitle: string;
    destructiveBody: string;
    destructiveUnavailable: string;
    partialReceiptHeader: string;
    resolvingScopeHeader: string;
    resolvingScopeBody: string;
    resolvingScopeMeta: string;
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
    unknownOutcomeComposer: string;
    applyTerminalUnknownComposer: string;
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
    agentToolDone: string;
    codeSearchStatus: (status: string, count: number) => string;
    codeSearchUntrusted: string;
    repositoryCodeReadOnly: string;
    codeSearchOpenSource: string;
    resumeConversationFollow: string;
    reasoningAgentTurn: string;
    toolResult: string;
    emptyAgentMessage: string;
    chatSuggestionsReady: (count: number) => string;
    chatNoSuggestions: string;
    chatLimitedCapability: string;
    reasoningSuggestTags: string;
    reasoningStreaming: string;
    reasoningDone: (duration: number) => string;
    reviewTitle: string;
    send: string;
    noSuggestionsReady: string;
    readySummary: (add: number, remove: number, deleteCount: number) => string;
    refreshTitle: string;
    closeTitle: string;
    suggestTags: string;
    agentSettings: string;
    cleanupTags: string;
    selectAllPage: string;
    selectedOnPage: (count: number) => string;
    nothingToApply: string;
    loadingSuggestions: string;
    emptyTitle: string;
    emptyBody: string;
    applied: (count: number) => string;
    loadFailed: string;
    created: (count: number) => string;
    noneFound: string;
    createFailed: string;
    groupAdd: string;
    groupRemove: string;
    groupDelete: string;
    groupSelection: (selected: number, total: number) => string;
    addTitle: (fullName: string) => string;
    removeTitle: (fullName: string) => string;
    deleteTitle: (tag: string) => string;
    more: (count: number) => string;
    range: (start: number, end: number, total: number) => string;
    zeroSuggestions: string;
    toolbarApplying: string;
    toolbarReview: string;
    toolbarInterrupted: string;
    scopeReady: string;
    runStateLabel: (value: string) => string;
    needsReviewFollowUp: string;
    needsReviewSelected: (count: number) => string;
    appliedTagChanges: (count: number) => string;
    followUpAboutScope: string;
    askingAboutCurrentViewUnknown: string;
    handoffAutoTagsUpdated: string;
    agentActivityLabel: string;
    workbench: {
      resolvingSubtitle: string;
      resolvingBody: string;
      resolvingHint: string;
      confirmScopeTitle: string;
      repositoriesFrozen: (count: number) => string;
      reviewBeforeApply: string;
      startAnalysis: string;
      startingAnalysis: string;
      analysisScopeIncomplete: string;
      nothingToAnalyzeBody: string;
      dismiss: string;
      confirmRequestedScope: string;
      candidateRepositories: (count: number) => string;
      continue: string;
      analyzingFrozenScope: string;
      progressSummary: (processed: number, remaining: number, batches: number) => string;
      runProgressLabel: string;
      processed: string;
      remaining: string;
      batches: string;
      providerAttempts: string;
      analysisBlockedTitle: string;
      analysisCoverage: (processed: number, total: number) => string;
      analysisBlockedBody: (failed: number) => string;
      restartWholeLibrary: string;
      discardAnalysis: string;
      runStateRefreshed: string;
      analysisReady: string;
      preparedReady: string;
      preparedPaused: string;
      budgetExhausted: (reason: string) => string;
      budgetSubtitle: (processed: number, total: number) => string;
      budgetProgress: (processed: number, remaining: number, attempts: number) => string;
      budgetBody: string;
      continueRemainingCount: (count: number) => string;
      moreRemain: string;
      moreRemainBody: string;
      continueCreatesRun: string;
      continueRemaining: string;
      proposalSummary: (actionable: number, nonActionable: number) => string;
      proposalSelectionNote: string;
      reviewSuggestions: string;
      reviewCoverageComplete: (count: number) => string;
      proposalCounts: (actionable: number, nonActionable: number, selected: number) => string;
      finishReviewFirst: string;
      selectRepository: (repositoryId: string) => string;
      applyingSelectedChanges: string;
      selectedRowsLocked: (count: number) => string;
      applying: string;
      applySelected: (count: number) => string;
      applyTagImpact: (tags: number, repositories: number) => string;
      selectAll: string;
      clear: string;
      previousPage: string;
      nextPage: string;
      reviewPageRange: (start: number, end: number, total: number) => string;
      applyingSubtitle: string;
      rowsSelectedLocked: (selected: number, total: number) => string;
      receiptPartial: (changed: number, skipped: number, failed: number) => string;
      receiptSingle: string;
      receiptComplete: (changed: number) => string;
      mutationReceipt: string;
      receiptSubtitle: string;
      receiptCountsLabel: string;
      changed: string;
      skipped: string;
      failed: string;
      unchanged: string;
      receiptCountSummary: (changed: number, skipped: number, failed: number) => string;
      unchangedCount: (count: number) => string;
      receiptRowsLabel: string;
      viewAllRows: string;
      viewFailedChanged: string;
      viewChanged: string;
      connectionInterrupted: string;
      workerLost: string;
      timelineLabel: (state: string) => string;
      runStepsLabel: string;
      runStepScope: string;
      runStepAnalyze: string;
      runStepReview: string;
      runStepApply: string;
      runStepReceipt: string;
      reviewEvidence: string;
      reviewExistingTag: string;
      reviewNewTag: string;
      reviewOpenRepository: string;
      reviewExpandRow: string;
      reviewCollapseRow: string;
      reviewReject: string;
      reviewUndoReject: string;
      reviewRejectedWithReason: (reason: string) => string;
      reviewRejectWrongRepo: string;
      reviewRejectTooBroad: string;
      reviewRejectAlreadyCovered: string;
      reviewRejectNotUseful: string;
      reviewEditTag: string;
      reviewEditTagLabel: (repositoryId: string, tag: string) => string;
      reviewSaveEdit: string;
      reviewCancelEdit: string;
      reviewEditInvalidEmpty: string;
      reviewEditInvalidNormalized: string;
      reviewEditInvalidDuplicate: string;
      reviewEditInvalidTooLong: string;
      reviewCorrectedTo: (tag: string) => string;
      reviewNeedsReanalysis: string;
      reviewAskRevise: string;
      reviewReviseRejected: (count: number) => string;
      reviewReviseRejectedPrompt: (details: string) => string;
      reviewEditCorrectionPrompt: (repositoryId: string, fromTag: string, toTag: string) => string;
      reviewRejectCorrectionPrompt: (repositoryId: string, reason: string) => string;
      reviewLocalOnlyNote: string;
    };
  };
  activeFilters: {
    onlyFavorite: string;
    onlyUntagged: string;
    onlyArchived: string;
    summary: (count: number) => string;
    clearOne: string;
    clearAll: string;
  };
  filterSidebar: {
    specialFilters: string;
    onlyFavoriteLabel: string;
    onlyFavoriteHint: string;
    onlyUntaggedLabel: string;
    onlyUntaggedHint: string;
    onlyArchivedLabel: string;
    onlyArchivedHint: string;
    showTombstoneLabel: string;
    showTombstoneHint: string;
    languages: (count: number) => string;
    languagesSearch: string;
    languagesSelected: (count: number) => string;
    languagesEmpty: string;
    tags: (count: number) => string;
    tagsSearch: string;
    tagsFilter: string;
    tagsEmpty: string;
    /** "Show all (N)" — reveal the full tag list past the preview cap. */
    tagsShowAll: (count: number) => string;
    tagsSelected: (count: number) => string;
    tagsMatchAny: string;
    tagsMatchAll: string;
    tagsMatchHelp: string;
    tagsSortAscTitle: string;
    tagsSortDescTitle: string;
    tagsSortDefaultTitle: string;
    deleteTagTitle: string;
    deleteTagConfirm: (name: string, count: number) => string;
    deleteTagDone: (count: number) => string;
    deleteAllTagsTitle: string;
    deleteAllTagsConfirm: string;
    deleteAllTagsDone: (assignmentsRemoved: number, distinctTagsRemoved: number) => string;
    noTagsPrefix: string;
    noTagsEmphasis: string;
    noTagsSuffix: string;
  };
  starRow: {
    archived: string;
    filterByTag: (tag: string) => string;
    clearTagFilter: (tag: string) => string;
    moreHidden: (count: number) => string;
    hasNotes: string;
    noNotes: string;
    markFavorite: string;
    removeFavorite: string;
    unstar: string;
    unstarTitle: (fullName: string) => string;
    unstarCancel: string;
    unstarDone: (fullName: string) => string;
    unstarFailed: (fullName: string, error: string) => string;
    alreadyUnstarred: string;
  };
  repoDetail: {
    previousTitle: string;
    nextTitle: string;
    closeTitle: string;
    description: string;
    topics: (count: number) => string;
    filterTopic: string;
    suggestedTags: string;
    acceptAll: string;
    acceptAllTitle: string;
    tags: (count: number) => string;
    tagsAction: string;
    notes: string;
    notesPlaceholder: string;
    notesSaved: string;
    notesUnsaved: string;
    language: string;
    stars: string;
    updated: string;
    starred: string;
  };
  tagEditor: {
    noTags: string;
    filterByTag: (tag: string) => string;
    clearTagFilter: (tag: string) => string;
    removeTag: string;
    addTagPlaceholder: string;
    addTagButton: string;
    bulkEditTitle: string;
    bulkPlaceholder: string;
  };
  popup: {
    title: string;
    noToken: string;
    addPat: string;
    idle: string;
    syncIncremental: string;
    syncFull: string;
    reconcile: string;
    gistPull: string;
    gistPush: string;
    testConnection: string;
    debugState: string;
    openStars: string;
    options: string;
    /** Tooltip for the popup header star-repo link. */
    starRepoTitle: string;
    testing: string;
    rate: (remaining: string | null, limit: string | null) => string;
    scopes: (scopes: string | null) => string;
    itemsOnPage: (count: number) => string;
    sample: (sample: string | null) => string;
    connectionOk: string;
    connectionNoContent: string;
    connectionRejected: string;
    connectionForbidden: string;
    failed: (label: string, error: string) => string;
  };
  options: {
    title: string;
    /** Label for the prominent "Star the project" CTA button. */
    starRepoButton: string;
    agentHeading: string;
    agentIntro: string;
    agentServiceLabel: string;
    agentServiceHint: string;
    agentAdvancedSettings: string;
    agentProtocolLabel: string;
    agentProtocolHint: string;
    agentProtocolChat: string;
    agentProtocolResponses: string;
    agentBaseUrlLabel: string;
    agentBaseUrlHint: string;
    agentBaseUrlPlaceholder: string;
    agentProviderContextWindowLabel: string;
    agentProviderContextWindowHint: string;
    agentProviderContextWindowRequired: string;
    agentWorkingContextWindowLabel: string;
    agentWorkingContextWindowHint: string;
    agentWorkingContextWindowPlaceholder: string;
    agentWorkingContextWindowTooLarge: string;
    agentContextWindowRange: string;
    agentModelLabel: string;
    agentModelHint: string;
    agentApiKeyLabel: string;
    agentApiKeyHint: string;
    agentApiKeyPlaceholder: string;
    agentSavedKeyHint: string;
    agentSave: string;
    agentSaving: string;
    agentSavedAndTested: (provider: string, model: string, latencyMs: number) => string;
    agentSavedTestFailed: (error: string) => string;
    agentSavedNeedsHostAccess: string;
    agentTest: string;
    agentTesting: string;
    agentTestOk: (provider: string, model: string, latencyMs: number) => string;
    agentRemoveKey: string;
    agentKeyRemoved: string;
    agentDisclosureHeading: string;
    agentDisclosureIntro: (provider: string, origin: string) => string;
    agentDisclosureSentHeading: string;
    agentDisclosureSentPrompt: string;
    agentDisclosureSentCode: string;
    agentDisclosureSentProtocol: string;
    agentDisclosureNotSentHeading: string;
    agentDisclosureNotSentSecrets: string;
    agentDisclosureKeyException: string;
    agentDisclosureBuiltInAccess: string;
    agentDisclosureCustomAccess: string;
    agentGrantAccess: string;
    agentAccessGranted: string;
    agentHostAccessRequired: string;
    behaviorHeading: string;
    maxTagsPerRepoLabel: string;
    maxTagsPerRepoHint: string;
    minTopicRepoCountLabel: string;
    minTopicRepoCountHint: string;
    starsPanelDefaultLabel: string;
    starsPanelDefaultHint: string;
    tokenHeading: string;
    tokenIntroPrefix: string;
    tokenLinkLabel: string;
    tokenIntroSuffix: string;
    tokenPublicRepos: string;
    tokenGists: string;
    tokenGistNote: string;
    authenticatedAs: (username: string) => string;
    openVerifiedStars: string;
    removeToken: string;
    cachedAccountWarning: (username: string) => string;
    clearCachedAuth: string;
    saveVerify: string;
    verifying: string;
    tokenVerified: (username: string) => string;
    tokenRemoved: string;
    /** Detailed PAT-creation walkthrough (numbered steps + screenshot captions). */
    tokenStepsTitle: string;
    tokenStep1: string;
    tokenStep2: string;
    tokenStep3: string;
    tokenStep4: string;
    tokenStep5: string;
    /** Screenshot placeholders (alt/caption text) — user will supply images later. */
    shotNewToken: string;
    shotRepoAccess: string;
    shotPermissions: string;
    languageLabel: string;
    gistHeading: string;
    gistBoundPrefix: string;
    gistBoundSuffix: string;
    gistEmpty: string;
    gistOpenLink: string;
  };
  repoChip: {
    untagged: string;
    filterByTag: (tag: string) => string;
    editTags: string;
  };
  background: {
    noToken: string;
    unknownBackfill: (id: string) => string;
    unsupportedBackfillKind: (kind: string) => string;
    incrementalSyncing: string;
    incrementalDone: (added: number) => string;
    fullDone: (count: number) => string;
    rescanDone: (tombstoned: number, revived: number) => string;
    autoAssignTagging: string;
    autoAssignDone: (tagged: number) => string;
    fetchingPages: (total: number) => string;
    fetchingPageRetry: (page: number, attempt: number) => string;
    syncedRepos: (count: number) => string;
    rescanningPages: (total: number) => string;
    reconcilingLocal: (count: number) => string;
    rescanSummary: (tombstoned: number, revived: number) => string;
  pushingTags: string;
    pullingTags: string;
    gistPushDone: (count: number) => string;
    gistPushRecreated: string;
    gistPushNoChanges: string;
    gistPullDone: (merged: number, total: number) => string;
    gistPullMissing: string;
  };
  /** Humanized error strings. Keys are matched against stable error codes thrown
   *  across the codebase (see src/api/errors.ts). `unknown` is the passthrough —
   *  it keeps the raw tail so nothing is silently swallowed. */
  errors: {
    tokenEmpty: string;
    tokenRejected: string;
    tokenStarsForbidden: string;
    tokenGistsForbidden: string;
    /** Step 1 (GET /user) — non-401 status, bad body, or network failure. */
    tokenProfileStatus: (status: number | string) => string;
    tokenProfileBadShape: string;
    tokenProfileNetwork: string;
    /** Step 2 (GET /user/starred) — non-401/403 status or network failure. */
    tokenStarsStatus: (status: number | string) => string;
    tokenStarsNetwork: string;
    /** Step 3 (POST /gists) — non-401/403/404 status, bad body, or network failure. */
    tokenGistsStatus: (status: number | string) => string;
    tokenGistsNetwork: string;
    tokenGistProbeBadShape: string;
    /** Step 3 cleanup (DELETE /gists/{id}) — best-effort; surfaced as a soft warning. */
    tokenGistCleanupStatus: (status: number | string) => string;
    tokenGistCleanupNetwork: string;
    ghTokenRejected: string;
    ghRateLimit: string;
    ghForbidden: string;
    ghTimeout: (page: number) => string;
    ghNetwork: (detail: string) => string;
    ghPageStatus: (status: number | string) => string;
    ghNoToken: string;
    ghBadShape: string;
    gistNoToken: string;
    gistCreateFailed: string;
    gistPushFailed: string;
    gistPullFailed: string;
    agentApiKeyEmpty: string;
    agentModelEmpty: string;
    agentBaseUrlEmpty: string;
    agentBaseUrlInvalid: string;
    agentHostPermissionDenied: string;
    agentProviderUnsupported: string;
    agentProviderTimeout: string;
    agentProviderIdentityChanged: string;
    agentProviderResponseInvalid: string;
    agentDataDisclosureRequired: string;
    agentContextCapabilityRequired: string;
    agentContextCapabilityInfeasible: string;
    unknown: (raw: string) => string;
  };
  /** First-run onboarding card (ManagerPanel). Context-aware: shows until the
   *  user dismisses it with "Got it" (sets Config.seenOnboarding). */
  onboarding: {
    title: string;
    /** Shown when there is no token yet — the install→configure path. */
    noTokenBody: string;
    /** The link label inside noTokenBody (kept separate so it can be a link). */
    createPatLabel: string;
    openOptions: string;
    /** Shown when a token exists but the first sync hasn't completed. */
    syncingBody: string;
    /** Shown when the first sync failed (the humanized error follows). */
    syncFailedBody: string;
    retry: string;
    gotIt: string;
    /** One-time enhanced tooltip bodies (shown on first hover of each action). */
    tooltipSyncFirst: string;
    tooltipPushFirst: string;
    tooltipPullFirst: string;
    /** Highlighted step coachmark (first run, after first sync). Persistent
     *  bubbles — no hover. Each step highlights one UI element. */
    coachTitle: string;
    coachIntro: string;
    coachStep1Title: string;
    coachStep1Body: string;
    coachStep2Title: string;
    coachStep2Body: string;
    coachStep3Title: string;
    coachStep3Body: string;
    coachStep4Title: string;
    coachStep4Body: string;
    coachStep5Title: string;
    coachStep5Body: string;
    coachNext: string;
    coachBack: string;
    coachSkip: string;
    coachOf: (current: number, total: number) => string;
  };
}

const messages: Record<Locale, MessageCatalog> = {
  en: {
    localeName: "English",
    common: {
      untagged: "Untagged",
      remove: "Remove",
      add: "Add",
      bulk: "Bulk",
      save: "Save",
      saved: "Saved",
      unsaved: "Unsaved changes",
      cancel: "Cancel",
      apply: "Apply",
      loading: "Loading…",
      none: "—",
      close: "Close",
      previous: "Previous",
      next: "Next",
      current: (value) => `Current: ${value}`,
      phase: (phase) =>
        ({
          idle: "Idle",
          full: "Full",
          incremental: "Incremental",
          rescan: "Rescan",
          gist: "Gist",
        })[phase],
    },
    dev: {
      version: (hash) => `DEV ${hash}`,
      clearLocalData: "Clear local",
      confirmClearLocalData: "Confirm clear",
      clearingLocalData: "Clearing…",
      clearLocalDataFailed: (error) => `Clear failed: ${error}`,
    },
    manager: {
      syncFailed: (label, error) => `${label}: ${error}`,
      autoAssignDone: (count) =>
        `Auto-assigned tags from repo topics for ${count} repos`,
      autoAssignFailed: (error) => `auto-assign tags: ${error}`,
      autoTagAgentPromptTitle: "Try Agent for smarter tagging?",
      autoTagAgentPromptBody:
        "Agent can inspect repository details and suggest manual tags. Auto Tags stays local and assigns labels from synced topics.",
      autoTagAgentPromptYes: "Yes, open Agent",
      autoTagAgentPromptNo: "No, use Auto Tags",
      deleteTagFailed: (error) => `delete tag: ${error}`,
      deleteAllTagsFailed: (error) => `delete all tags: ${error}`,
      noTokenBanner: "No GitHub token configured — data cannot load.",
      addPat: "Open options and add a PAT",
      emptyState: "No results. Adjust filters, or click Sync in the toolbar.",
      backfillSyncTitle: "Sync your data",
      backfillSyncBody:
        "This update needs one full sync for your existing starred repos before everything is fully up to date.",
      backfillSyncAction: "Run Full Sync",
      backfillSyncRetry: "Retry sync",
      backfillSyncLater: "Later",
      backfillSyncRunning: "Syncing your data…",
      backfillSyncFailed: (error) => `Sync failed: ${error}`,
    },
    toolbar: {
      searchPlaceholder:
        "Search name / description / topics / notes   (/ to focus)",
      searchClearTitle: "Clear search",
      sortStarredAt: "Sort by starred date",
      sortPushedAt: "Sort by updated date",
      sortCreatedAt: "Sort by repository creation date",
      sortStars: "Sort by stars",
      sortName: "Sort by name",
      toggleSortDir: "Toggle sort direction",
      syncTitle: "Incrementally sync new stars",
      syncButton: "Sync",
      fullSyncTitle: "Re-fetch your entire starred library",
      fullSyncButton: "Full Sync",
      themeTitle: "Toggle black/white theme",
      githubHomeTitle: "GitHub home",
      hidePanelTitle: "Hide panel (use native stars list)",
      starRepoTitle: "Like the project? Leave a star:)",
      autoAssignTitle:
        "Auto-assign tags from each repo's topics (experimental)",
      autoAssignButton: "Auto Tags",
      agentTitle: "Open the optional AI tag assistant",
      agentButton: "Agent",
      gistTitle: "Gist backup actions",
      gistButton: "Gist",
      gistPushing: "Gist · Pushing",
      gistPulling: "Gist · Pulling",
      gistPushTitle: "Push tags to your Gist backup",
      gistPushButton: "Push",
      gistPullTitle: "Pull tags from your Gist backup",
      gistPullButton: "Pull",
      gistLinkTitle: "Open your tag-sync Gist on github.com",
      moreTitle: "More actions",
      shownTotal: (shown, total) => `${shown} shown / ${total} total`,
      noToken: "No token configured",
      accountTitle: (username) => `Signed in as @${username}`,
      columnRepository: "Repository",
      columnDescription: "Description",
      columnLanguage: "Lang",
      columnStars: "Stars",
      columnUpdated: "Updated",
      columnCreated: "Created",
      columnTags: "Tags",
      columnStarAction: "Unstar",
      columnFavorite: "Favorite",
      columnNotes: "Notes",
      viewLabel: "View",
      defaultLayout: "Default",
      customLayout: "Custom",
      customLayoutChanged: "Custom layout differs from default",
      editLayout: "Edit custom layout",
      previewCustomLayout: "Previewing custom layout. Click to apply.",
      editingLayout: "Editing layout",
      columnsButton: "Columns",
      columnsButtonTitle: "Show or hide columns",
      hiddenColumns: (count) => `${count} hidden`,
      hiddenColumnsTip: "Click to restore · drag into the header to place",
      hideColumn: (label) => `Hide ${label}`,
      restoreColumn: (label) => `Restore ${label}`,
      dragColumnTitle: (label) => `Drag ${label} to reorder; drop into tray to hide`,
      dragColumnHint: "Horizontal drag reorders · drop into tray hides",
      dragHideHint: (label) => `Release to hide ${label}`,
      dragTrayHint: "Drag into the header to place",
      dragInsertHint: "Release to insert here",
      resizeColumnTitle: (label) => `Resize ${label}`,
      lockedColumn: "Locked",
      fitWidths: "Fit width",
      resetWidths: "Reset widths",
      resetLayout: "Reset",
      resizeFrozenPeers: "Live drag: frozen peers",
      resizeFitExplicit: "Fit action: explicit only",
      resizeDefaultGuide: (width) => `Default ${width}px`,
      resizeBadgeDefault: "default",
      resizeBadgeMin: "min",
      resizeDeltaCurrentOnly: "current column only",
      resizeWidthReadout: (tableWidth, panelWidth, overflow) => `Table ${tableWidth}px / Panel ${panelWidth}px${overflow > 0 ? ` / Overflow +${overflow}px` : ''}`,
      resizeLiveWidthReadout: (label, width, delta, tableWidth, panelWidth, overflow) =>
        `${label} ${width}px (${delta >= 0 ? '+' : ''}${delta}px) / Table ${tableWidth}px / Panel ${panelWidth}px${overflow > 0 ? ` / Overflow +${overflow}px` : ''}`,
    },
    agentPanel: {
      title: "BGSM Agent",
      chatInputLabel: "Message BGSM Agent",
      chatHeaderIdle: "Ready",
      chatIntro:
        "I can inspect, compare, and organize repositories in your current scope. Auto Tags stays local and one-click — this chat is for judgment calls.",
      chatPlaceholder: "Ask about these repositories…",
      chatPlaceholderScoped: (count) => (
        count === 1
          ? "Ask about this repository…"
          : `Ask about these ${count} repositories…`
      ),
      chatWorking: "BGSM Agent is working...",
      autoAssignPrompt:
        "Organize untagged repositories across the entire starred library with useful semantic tags. Inspect every live star first, add manual tags only when repository topics, names, descriptions, or existing tags provide clear evidence, then return one complete review before applying anything.",
      summarizeScopePrompt:
        "Inspect the repositories in the current scope and summarize what they are for, the strongest patterns, and notable differences. Use local repository metadata and do not change tags.",
      findSimilarPrompt:
        "Find similar tools in this scope and compare the strongest options with clear evidence from local repository metadata.",
      cleanupTagsPrompt:
        "Review tag names in this scope and suggest cleanup opportunities. Do not remove or delete tags; only explain candidates and ask before any later review path.",
      searchCodePrompt:
        "Search the selected repository code for its main architecture and explain the key implementation files. Do not change tags.",
      reviewNotesPrompt:
        "Read the private notes for the selected repository and summarize the useful context. Do not change tags.",
      quickFindSimilar: "Find similar tools",
      quickOrganizeUntagged: "Organize full library",
      quickCleanupTags: "Clean up tag names",
      functionMenuLabel: "Prompt suggestions",
      functionMenuTitle: "Suggested prompts",
      functionSummarize: "Summarize current scope",
      functionSummarizeDescription: "Inspect repository metadata and explain the main patterns.",
      functionFindSimilar: "Find similar tools",
      functionFindSimilarDescription: "Compare the strongest alternatives in this scope.",
      functionOrganizeUntagged: "Organize full library",
      functionOrganizeUntaggedDescription: "Analyze every live star and prepare one complete tag review.",
      functionReviewTags: "Review tag names",
      functionReviewTagsDescription: "Find duplicates and naming cleanup opportunities without deleting.",
      functionSearchCode: "Search repository code",
      functionSearchCodeDescription: "Inspect indexed public code for the selected repository.",
      functionReviewNotes: "Review repository notes",
      functionReviewNotesDescription: "Read the private notes attached to the selected repository.",
      askingAboutCurrentView: (count) => (
        count === 1
          ? "Asking about current view · 1 repository"
          : `Asking about current view · ${count} repositories`
      ),
      askingAboutSelectedRepository: "Asking about selected repository · 1",
      askingAboutAllLiveStars: (count) => (
        typeof count === "number"
          ? (count === 1
            ? "Asking about all live stars · 1 repository"
            : `Asking about all live stars · ${count} repositories`)
          : "Asking about all live stars"
      ),
      agentChanged: (count) => `${count} tag update${count === 1 ? '' : 's'} applied`,
      turnFailed: "Turn failed",
      attemptStateLost: "The extension restarted before this turn could be recovered. Review any completed changes, then retry.",
      answerReady: "Answer ready",
      providerErrorTitle: "Provider error",
      providerErrorSubtitle: "No local data was modified",
      providerErrorBody: "Your prompt is still in the thread. Retry the same question or start a new conversation.",
      retry: "Retry",
      noLocalDataModified: "No local data was modified",
      contextSettingsTitle: "AI service settings need attention",
      contextSettingsMessage: "Adjust this service's context settings before continuing. Your draft is preserved.",
      contextPromptTooLargeTitle: "This request is too large",
      contextPromptTooLargeMessage: "Shorten the draft, or increase the configured context limit if your AI service supports it.",
      contextToolMemoryTitle: "BGSM reached an internal tool-data limit",
      contextToolMemoryMessage: "Your prompt and completed results were preserved. Retry to continue; you do not need to shorten the prompt or change the model context window.",
      contextToolMemoryWriteBlockedMessage: "Completed results were preserved, but a write may already have finished. Review or change the request before sending it again.",
      contextAdjustSettings: "Adjust AI service settings",
      contextEditPrompt: "Edit prompt",
      composerPausedContextRecovery: "Draft preserved · choose a recovery action above",
      composerWriteRetryBlocked: "Review or change this request before sending because a write may already have completed.",
      startNewConversation: "Start new conversation",
      sessionsLabel: "Conversations",
      sessionUntitled: "New conversation",
      sessionDelete: "Delete conversation",
      sessionDeleteTitle: "Delete this conversation?",
      sessionDeleteMessage: (title) => `Delete “${title}”? Its local transcript will be removed from this panel.`,
      sessionDeleteConfirm: "Delete",
      sessionDeleteCancel: "Cancel",
      hideWhileRunning: "Hide BGSM Agent",
      runContinuesWhileHidden: "You can hide this panel; the turn continues.",
      confirmScopeHeader: "Confirm scope",
      analyzingHeader: (processed, total) => `Analyzing · ${processed}/${total}`,
      analyzingTitle: "Analyzing frozen scope",
      analyzingMeta: (processed, remaining, batches) => (
        `${processed} processed · ${remaining} remaining · ${batches} batch${batches === 1 ? '' : 'es'}`
      ),
      frozenScopeNote: (count) => (
        count === 1
          ? "Frozen scope · 1 repository"
          : `Frozen scope · ${count} repositories`
      ),
      pendingConfirmationNote: (count) => (
        count === 1
          ? "Pending confirmation · 1 repository"
          : `Pending confirmation · ${count} repositories`
      ),
      turnFrozenScopeNote: (count) => (
        count === 1
          ? "Current view · 1 repository · frozen for this turn"
          : `Current view · ${count} repositories · frozen for this turn`
      ),
      conversationFrozenScope: (label, count) => (
        count === 1
          ? `${label} · 1 repository · frozen for this conversation`
          : `${label} · ${count} repositories · frozen for this conversation`
      ),
      readOnlyResultTitle: "Read-only answer",
      readOnlyResultSubtitle: "No tag changes proposed",
      noTagChangesProposed: "No tag changes proposed",
      hideAgent: "Hide BGSM Agent",
      stop: "Stop",
      cancel: "Cancel",
      applyingHeader: (done, total) => `Applying · ${done}/${total}`,
      applyingTitle: "Applying selected changes",
      applyingSubtitle: "Manual tag layer · frozen scope still locked",
      applyingMeta: (done, total) => `${done} of ${total} rows committed · checkboxes locked`,
      applyingButton: "Applying…",
      applyingStopbar: "Apply can’t be interrupted mid-row; hide is still allowed.",
      composerPausedApplying: "Composer paused while applying",
      budgetExhaustedHeader: "Budget exhausted",
      budgetExhaustedTitle: (reason) => `Budget exhausted · ${reason}`,
      budgetExhaustedSubtitle: (processed, total) => `Processed ${processed} / ${total} · remaining were not auto-continued`,
      budgetExhaustedBody: "No remaining work was processed or replayed automatically. Continuing creates a new run with new budgets and a new frozen cursor.",
      continueRemainingCount: (count) => `Continue remaining ${count}`,
      nothingToAnalyzeHeader: "Nothing to analyze",
      nothingToAnalyzeTitle: "Nothing to analyze",
      nothingToAnalyzeBody: "Either every visible repo already has tags, or the active filters hide the candidates. Change filters or broaden scope, then ask again.",
      emptyScopeCount: "0 repositories match this scope.",
      handoffHeader: "Handoff · still untagged",
      handoffTitle: "From Auto Tags",
      handoffSubtitle: (count) => `Deterministic pass finished · ${count} still untagged`,
      handoffBody: "Auto Tags already updated topic-based auto tags. This chat starts on the remaining untagged set only. It will not overwrite Auto Tags results unless you later apply manual tags.",
      handoffAsk: (count) => `I can help classify the ${count} repositories Auto Tags left untagged. Want me to propose careful manual tags for this set?`,
      handoffOrganize: (count) => `Yes — organize these ${count}`,
      handoffAmbiguous: "Only show the ambiguous ones",
      handoffExamples: "Explain a few examples first",
      handoffScopeNote: (count) => (
        count === 1
          ? "Still untagged after Auto Tags · 1 repository"
          : `Still untagged after Auto Tags · ${count} repositories`
      ),
      destructiveHeader: "Confirm destructive changes",
      destructiveTitle: "Confirm tag library changes",
      destructiveSubtitle: "Destructive · review required · not auto-applied",
      destructiveBody: "Rename, merge, and delete stay off the free-chat tool path. A dedicated confirm + Apply flow is required before any library cleanup writes.",
      destructiveUnavailable: "Not available in first-safe release",
      partialReceiptHeader: "Applied with conflicts",
      resolvingScopeHeader: "Resolving scope…",
      resolvingScopeBody: "I’m freezing exact repository IDs for this turn so later filter changes can’t silently expand the job.",
      resolvingScopeMeta: "Usually quick · cancel if you picked the wrong filters",
      scopeNotFrozenYet: "Scope not frozen yet",
      reviewFollowUpNote: "Review still open · follow-ups allowed",
      reviewFollowUpPlaceholder: "Ask about this review…",
      reviewConversationDetails: "Conversation details",
      stopMidAnalyzeHeader: "Stopped by you",
      stopMidAnalyzeTitle: "Run stopped",
      stopMidAnalyzeSubtitle: "User abort · no writes were in flight",
      stopMidAnalyzeBody: (processed, remaining) => (
        `Pending analysis cancelled. Completed reads: ${processed}. Not started: ${remaining}. Committed writes: 0.`
      ),
      stopMidAnalyzeResume: "Resume remaining as new run",
      stopMidAnalyzeDiscard: "Discard",
      staleSourceTitle: "Source changed after proposal",
      staleSourceBody: "Apply left stale rows untouched. Refresh conflicts only — don’t re-run the whole library blindly.",
      providerAuthHeader: "Provider auth failed",
      providerAuthTitle: "OpenAI-compatible auth failed",
      providerAuthSubtitle: "API key rejected or missing host permission",
      providerAuthBody: "I couldn’t call your configured provider. Your prompt and scope are preserved. No secrets are shown here.",
      providerAuthOpenOptions: "Open Options",
      providerAuthRetry: "Retry after fix",
      completedNoChangesHeader: "Completed · no changes",
      completedNoChangesTitle: "Completed · no changes",
      completedNoChangesSubtitle: (inspected) => `0 actionable proposals · ${inspected} inspected`,
      completedNoChangesBody: "Everything already matches a clear taxonomy or lacked enough evidence to propose a safe manual tag. Nothing to apply.",
      unknownOutcomeComposer: "Apply terminal · unknown outcome · chat available",
      applyTerminalUnknownComposer: "Apply terminal · unknown outcome · chat available",
      agentQueued: "Preparing your request...",
      agentCompacting: "Organizing conversation context…",
      agentStarting: "Preparing context...",
      agentThinking: "Thinking...",
      agentWriting: "Responding...",
      agentReadingData: "Checking local data...",
      agentSearchingCode: "Inspecting repository code...",
      agentPreparingOrganizationScope: "Preparing full-library scope...",
      agentApplyingChanges: "Applying tag changes...",
      agentDone: "Done",
      agentStopped: "Stopped",
      agentToolQueued: "Queued",
      agentToolRunning: "Running",
      agentToolCompleted: "Completed",
      agentToolFailed: "Failed",
      agentToolDone: "Done",
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
      reasoningAgentTurn:
        "I will call the model provider, inspect local stars with tools, and apply tag changes through controlled extension tools.",
      toolResult: "Tool result",
      emptyAgentMessage: "Done.",
      chatSuggestionsReady: (count) => `I prepared ${count} tag suggestions. Review them below before applying.`,
      chatNoSuggestions: "I did not find new tag suggestions from the current local data.",
      chatLimitedCapability:
        "I can help organize your stars with the configured AI service.",
      reasoningSuggestTags:
        "I will inspect local repository topics and existing tags, skip excluded tags, and apply conservative tag changes.",
      reasoningStreaming: "Running agent...",
      reasoningDone: (duration) => `Checked local tags in ${duration}s`,
      reviewTitle: "Review tag suggestions",
      send: "Send",
      noSuggestionsReady: "No suggestions ready",
      readySummary: (add, remove, deleteCount) => {
        const parts = [
          add > 0 ? `${add} add` : null,
          remove > 0 ? `${remove} remove` : null,
          deleteCount > 0 ? `${deleteCount} delete` : null,
        ].filter((part): part is string => part !== null);
        return parts.length === 0 ? "No suggestions ready" : parts.join(" · ");
      },
      refreshTitle: "Refresh suggestions",
      closeTitle: "Close BGSM Agent",
      suggestTags: "Organize untagged here",
      agentSettings: "Agent settings",
      cleanupTags: "Clean up tags",
      selectAllPage: "Select all suggestions on this page",
      selectedOnPage: (count) => `${count} selected on this page`,
      nothingToApply: "Nothing to apply",
      loadingSuggestions: "Loading suggestions",
      emptyTitle: "No suggestions yet.",
      emptyBody: "Suggestions will appear here.",
      applied: (count) => `${count} suggestions applied.`,
      loadFailed: "Could not load suggestions.",
      created: (count) => `${count} suggestions ready.`,
      noneFound: "No new suggestions found.",
      createFailed: "Could not create suggestions.",
      groupAdd: "Add tags",
      groupRemove: "Remove tags from repos",
      groupDelete: "Delete tags",
      groupSelection: (selected, total) => `${selected}/${total}`,
      addTitle: (fullName) => `Add tags to ${fullName}`,
      removeTitle: (fullName) => `Remove tags from ${fullName}`,
      deleteTitle: (tag) => `Delete ${tag}`,
      more: (count) => `+${count} more`,
      range: (start, end, total) => `${start}-${end} of ${total}`,
      zeroSuggestions: "0 suggestions",
      toolbarApplying: "Applying",
      toolbarReview: "Review",
      toolbarInterrupted: "Interrupted",
      scopeReady: "Scope ready",
      runStateLabel: (value) => value.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase()),
      needsReviewFollowUp: "Needs review · answering follow-up",
      needsReviewSelected: (count) => `Needs review · ${count} selected`,
      appliedTagChanges: (count) => `Applied ${count} tag ${count === 1 ? "change" : "changes"}`,
      followUpAboutScope: "Ask a follow-up about this scope",
      askingAboutCurrentViewUnknown: "Asking about current view",
      handoffAutoTagsUpdated: "Auto Tags already updated topic-based auto tags.",
      agentActivityLabel: "Agent activity",
      workbench: {
        resolvingSubtitle: "Preparing one job for the complete starred library",
        resolvingBody: "I’m freezing every live starred repository so filters and the selected row cannot narrow this organization job.",
        resolvingHint: "Usually quick · no tags are changed during this step",
        confirmScopeTitle: "Confirm analysis scope",
        repositoriesFrozen: (count) => `${count} repositories will be frozen for this run.`,
        reviewBeforeApply: "Analysis prepares a complete review first. No tags are changed at this step.",
        startAnalysis: "Start analysis",
        startingAnalysis: "Starting analysis",
        analysisScopeIncomplete: "The saved analysis scope is incomplete. Prepare it again.",
        nothingToAnalyzeBody: "Either every visible repo already has tags, or the active filters hide the candidates. Change filters or broaden scope, then ask again.",
        dismiss: "Dismiss",
        confirmRequestedScope: "Confirm requested scope",
        candidateRepositories: (count) => `${count} candidate repositories.`,
        continue: "Continue",
        analyzingFrozenScope: "Analyzing frozen scope",
        progressSummary: (processed, remaining) => `${processed} analyzed · ${remaining} remaining`,
        runProgressLabel: "Run progress",
        processed: "Processed",
        remaining: "Remaining",
        batches: "Batches",
        providerAttempts: "Provider attempts",
        analysisBlockedTitle: "Full-library analysis did not finish",
        analysisCoverage: (processed, total) => `${processed} of ${total} repositories analyzed`,
        analysisBlockedBody: (failed) => failed > 0
          ? `${failed} ${failed === 1 ? "repository" : "repositories"} could not be analyzed. No partial suggestions are shown or applied. Continue the failed items or restart the full-library analysis to produce one complete review.`
          : "No partial suggestions are shown or applied. Continue the remaining items or restart the full-library analysis to produce one complete review.",
        restartWholeLibrary: "Restart full-library analysis",
        discardAnalysis: "Discard this analysis",
        runStateRefreshed: "The saved analysis state changed. Its latest progress has been restored; try continuing again or restart the full-library analysis.",
        analysisReady: "Analysis ready",
        preparedReady: "The selected scope is prepared.",
        preparedPaused: "The selected scope is prepared and paused until the current run stops.",
        budgetExhausted: (reason) => `Budget exhausted · ${reason}`,
        budgetSubtitle: (processed, total) => `Processed ${processed} / ${total} · remaining were not auto-continued`,
        budgetProgress: (processed, remaining, attempts) => `${processed} processed · ${remaining} remaining · ${attempts} provider attempts used`,
        budgetBody: "No remaining work was processed or replayed automatically. Continuing creates a new run with new budgets and a new frozen cursor.",
        continueRemainingCount: (count) => `Continue remaining ${count}`,
        moreRemain: "More repositories remain",
        moreRemainBody: "The current review is settled. Remaining repositories were not processed automatically.",
        continueCreatesRun: "Continuing creates a new run with new budgets.",
        continueRemaining: "Continue remaining",
        proposalSummary: (actionable, nonActionable) => `I prepared ${actionable} actionable tag suggestions. ${nonActionable} repositories stayed non-actionable (already clear or insufficient evidence).`,
        proposalSelectionNote: "Only checked rows will become manual tags.",
        reviewSuggestions: "Review actionable suggestions",
        reviewCoverageComplete: (count) => `Full library covered · ${count} repositories analyzed`,
        proposalCounts: (actionable, nonActionable, selected) => `${actionable} actionable · ${nonActionable} non-actionable · ${selected} selected`,
        finishReviewFirst: "More repositories remain. Finish this review before continuing.",
        selectRepository: (repositoryId) => `Select ${repositoryId}`,
        applyingSelectedChanges: "Applying selected changes",
        selectedRowsLocked: (count) => `${count} rows selected · checkboxes locked`,
        applying: "Applying…",
        applySelected: (count) => `Apply ${count} selected`,
        applyTagImpact: (tags, repositories) => `Apply ${tags} tags to ${repositories} repositories`,
        selectAll: "Select all",
        clear: "Clear",
        previousPage: "Previous page",
        nextPage: "Next page",
        reviewPageRange: (start, end, total) => `${start}-${end} of ${total}`,
        applyingSubtitle: "Manual tag layer · frozen scope still locked",
        rowsSelectedLocked: (selected, total) => `${selected} of ${total} rows selected · checkboxes locked`,
        receiptPartial: (changed, skipped, failed) => `${changed} rows applied. ${skipped} skipped. ${failed} failed a precondition and were left untouched.`,
        receiptSingle: "Applied the 1 selected row as manual tags. Nothing was pushed to Gist.",
        receiptComplete: (changed) => `Applied the ${changed} selected rows as manual tags. Nothing was pushed to Gist.`,
        mutationReceipt: "Library update receipt",
        receiptSubtitle: "One authoritative result · local manual tags · Gist not pushed",
        receiptCountsLabel: "Available receipt counts",
        changed: "Changed",
        skipped: "Skipped",
        failed: "Failed",
        unchanged: "Unchanged",
        receiptCountSummary: (changed, skipped, failed) => `${changed} changed · ${skipped} skipped · ${failed} failed`,
        unchangedCount: (count) => `${count} unchanged`,
        receiptRowsLabel: "Available receipt rows",
        viewAllRows: "View all rows",
        viewFailedChanged: "View failed & changed",
        viewChanged: "View changed",
        connectionInterrupted: "Agent connection was interrupted. Reconnecting…",
        workerLost: "The extension worker restarted, so this run can no longer continue. Start a new analysis.",
        timelineLabel: (state) => state.replaceAll("_", " ").replace(/^./u, (character) => character.toUpperCase()),
        runStepsLabel: "Agent run steps",
        runStepScope: "Scope",
        runStepAnalyze: "Analyze",
        runStepReview: "Review",
        runStepApply: "Apply",
        runStepReceipt: "Receipt",
        reviewEvidence: "Evidence",
        reviewExistingTag: "Existing",
        reviewNewTag: "New",
        reviewOpenRepository: "Open repository on GitHub",
        reviewExpandRow: "Show review details",
        reviewCollapseRow: "Hide review details",
        reviewReject: "Reject",
        reviewUndoReject: "Undo reject",
        reviewRejectedWithReason: (reason) => `Rejected · ${reason}`,
        reviewRejectWrongRepo: "Wrong repository",
        reviewRejectTooBroad: "Tag too broad",
        reviewRejectAlreadyCovered: "Already covered",
        reviewRejectNotUseful: "Not useful",
        reviewEditTag: "Edit tag",
        reviewEditTagLabel: (repositoryId, tag) => `Edit tag ${tag} for ${repositoryId}`,
        reviewSaveEdit: "Save correction",
        reviewCancelEdit: "Cancel edit",
        reviewEditInvalidEmpty: "Enter a non-empty tag.",
        reviewEditInvalidNormalized: "Tag must stay NFKC-normalized.",
        reviewEditInvalidDuplicate: "Tag duplicates another action on this row.",
        reviewEditInvalidTooLong: "Tag exceeds 256 UTF-8 bytes.",
        reviewCorrectedTo: (tag) => `Corrected to ${tag}`,
        reviewNeedsReanalysis: "Needs re-analysis before apply",
        reviewAskRevise: "Ask to revise",
        reviewReviseRejected: (count) => `Ask to revise rejected (${count})`,
        reviewReviseRejectedPrompt: (details) => `Revise this tag review before any apply. Keep the frozen scope unchanged, skip rejected rows, and re-analyze only the corrected intent. Rejections/corrections:\n${details}`,
        reviewEditCorrectionPrompt: (repositoryId, fromTag, toTag) => `For ${repositoryId}, do not apply the reviewed tag "${fromTag}". Re-analyze that repository with the corrected tag intent "${toTag}" and return a fresh review row before any apply.`,
        reviewRejectCorrectionPrompt: (repositoryId, reason) => `For ${repositoryId}, reject the current suggestion (${reason}). Re-analyze that repository with this correction in mind and return a fresh review row before any apply.`,
        reviewLocalOnlyNote: "Rejects and edits are local review decisions. Apply still sends only checked rows with their reviewed actions.",
      },
    },
    activeFilters: {
      onlyFavorite: "Favorites",
      onlyUntagged: "Untagged only",
      onlyArchived: "Archived",
      summary: (count) => `${count} results · filtered`,
      clearOne: "Remove this filter",
      clearAll: "Clear all filters",
    },
    filterSidebar: {
      specialFilters: "Special Filters",
      onlyFavoriteLabel: "Favorites",
      onlyFavoriteHint: "",
      onlyUntaggedLabel: "Untagged only",
      onlyUntaggedHint: "",
      onlyArchivedLabel: "Archived",
      onlyArchivedHint: "",
      showTombstoneLabel: "Show unstarred",
      showTombstoneHint: "tombstoned repos",
      languages: (count) => `Languages${count > 0 ? ` · ${count}` : ""}`,
      languagesSearch: "Filter languages…",
      languagesSelected: (count) => `${count} selected`,
      languagesEmpty: "No languages match.",
      tags: (count) => `Tags (${count})`,
      tagsSearch: "Filter tags…",
      tagsFilter: "Search tags…",
      tagsEmpty: "No tags match.",
      tagsShowAll: (count) => `Show all ${count}`,
      tagsSelected: (count) => `${count} selected`,
      tagsMatchAny: "Any",
      tagsMatchAll: "All",
      tagsMatchHelp: "match any / all selected tags",
      tagsSortAscTitle: "Sort tags A to Z",
      tagsSortDescTitle: "Sort tags Z to A",
      tagsSortDefaultTitle: "Restore original tag order",
      deleteTagTitle: "Delete tag everywhere",
      deleteTagConfirm: (name, count) =>
        count > 0
          ? `Delete "${name}" from all ${count} repos? This cannot be undone.`
          : `Delete "${name}"?`,
      deleteTagDone: (count) => `Deleted tag from ${count} repos`,
      deleteAllTagsTitle: "Delete all tags",
      deleteAllTagsConfirm: "Delete all tags from every repo? This cannot be undone.",
      deleteAllTagsDone: (assignmentsRemoved, distinctTagsRemoved) =>
        `Cleared ${distinctTagsRemoved} tags from ${assignmentsRemoved} repo assignments`,
      noTagsPrefix: "No tags yet. Use toolbar",
      noTagsEmphasis: "Auto assign tags",
      noTagsSuffix: "to generate them from repo topics.",
    },
    starRow: {
      archived: "archived",
      filterByTag: (tag) => `Filter by "${tag}"`,
      clearTagFilter: (tag) => `Filtering by "${tag}" — click to remove`,
      moreHidden: (count) => `${count} more — see the detail panel`,
      hasNotes: "Has notes (view in details)",
      noNotes: "No notes",
      markFavorite: "Mark as favorite",
      removeFavorite: "Remove favorite",
      unstar: "Confirm",
      unstarTitle: (fullName) => `Unstar ${fullName}`,
      unstarCancel: "Cancel",
      unstarDone: (fullName) => `${fullName} removed from the current list`,
      unstarFailed: (fullName, error) => `Could not remove ${fullName}: ${error}`,
      alreadyUnstarred: "Already unstarred",
    },
    repoDetail: {
      previousTitle: "Previous ([)",
      nextTitle: "Next (])",
      closeTitle: "Close (Esc)",
      description: "Description",
      topics: (count) => `Topics (${count})`,
      filterTopic: "Filter by this topic",
      suggestedTags: "Suggested tags",
      acceptAll: "+ Accept all",
      acceptAllTitle: "Add all suggested tags",
      tags: (count) => `Tags (${count})`,
      tagsAction: "Tags",
      notes: "Notes",
      notesPlaceholder: "Why did you star this repo?",
      notesSaved: "Saved",
      notesUnsaved: "Unsaved changes",
      language: "Language",
      stars: "Stars",
      updated: "Updated",
      starred: "Starred",
    },
    tagEditor: {
      noTags: "No tags yet",
      filterByTag: (tag) => `Filter by "${tag}"`,
      clearTagFilter: (tag) => `Filtering by "${tag}" — click to remove`,
      removeTag: "Remove tag",
      addTagPlaceholder: "Add a tag, press Enter to confirm",
      addTagButton: "Add",
      bulkEditTitle: "Bulk edit (comma-separated)",
      bulkPlaceholder: "tag1, tag2, …",
    },
    popup: {
      title: "Better GitHub Stars Manager",
      noToken: "No token configured.",
      addPat: "Add PAT",
      idle: "Idle",
      syncIncremental: "Sync new stars (incremental)",
      syncFull: "Full re-pull all stars",
      reconcile: "Reconcile stars",
      gistPull: "Pull tags from Gist",
      gistPush: "Push tags to Gist",
      testConnection: "Test GitHub connection",
      debugState: "Debug extension state",
      openStars: "Open my stars page",
      options: "Options…",
      starRepoTitle: "Like the project? Leave a star:)",
      testing: "testing…",
      rate: (remaining, limit) => `rate: ${remaining}/${limit} remaining`,
      scopes: (scopes) => `scopes: ${scopes ?? "(fine-grained: none shown)"}`,
      itemsOnPage: (count) => `items on page 1: ${count}`,
      sample: (sample) => `sample: ${sample ?? "—"}`,
      connectionOk: "OK — connection works",
      connectionNoContent:
        "204 No Content — token may lack /user/starred access",
      connectionRejected: "401 — token rejected",
      connectionForbidden: "403 — forbidden (check scopes / repository access)",
      failed: (label, error) => `${label} failed: ${error}`,
    },
    options: {
      title: "Better GitHub Stars Manager — Options",
      starRepoButton: "Like the project? Leave a star:)",
      agentHeading: "2. BGSM Agent",
      agentIntro:
        "Connect your own AI service so BGSM Agent can suggest tags without leaving the extension.",
      agentServiceLabel: "AI service",
      agentServiceHint: "Choose where BGSM Agent should run.",
      agentAdvancedSettings: "Advanced settings",
      agentProtocolLabel: "API protocol",
      agentProtocolHint: "Choose the API supported by this custom service.",
      agentProtocolChat: "Chat Completions",
      agentProtocolResponses: "Responses API",
      agentBaseUrlLabel: "Base URL",
      agentBaseUrlHint:
        "Enter the /v1 Base URL provided by this service. BGSM only contacts its configured origin.",
      agentBaseUrlPlaceholder: "https://api.example.com/v1",
      agentProviderContextWindowLabel: "Service context window",
      agentProviderContextWindowHint:
        "Known model IDs use an exact built-in preset. Enter a value to override it, or to configure an unknown model.",
      agentProviderContextWindowRequired: "Enter this service's supported context window.",
      agentWorkingContextWindowLabel: "Working context window",
      agentWorkingContextWindowHint:
        "Optional. Set a smaller working window for this model. This can only reduce the service limit.",
      agentWorkingContextWindowPlaceholder: "Use the service limit",
      agentWorkingContextWindowTooLarge: "The working window cannot exceed the service window.",
      agentContextWindowRange: "Enter a whole number from 4,096 to 2,000,000.",
      agentModelLabel: "Model",
      agentModelHint: "Use any model ID supported by this service.",
      agentApiKeyLabel: "API key",
      agentApiKeyHint: "Stored encrypted on this device.",
      agentApiKeyPlaceholder: "Paste a key to save or test",
      agentSavedKeyHint:
        "A saved key is already on this device. Leave this blank to keep using it.",
      agentSave: "Save & test",
      agentSaving: "Saving and testing…",
      agentSavedAndTested: (provider, model, latencyMs) =>
        `Saved · Connected to ${provider} · ${model} (${latencyMs} ms)`,
      agentSavedTestFailed: (error) =>
        `Settings saved, but the connection test failed: ${error}`,
      agentSavedNeedsHostAccess:
        "Settings saved. Grant host access, then test the connection.",
      agentTest: "Test connection",
      agentTesting: "Testing…",
      agentTestOk: (provider, model, latencyMs) =>
        `Connected to ${provider} · ${model} (${latencyMs} ms)`,
      agentRemoveKey: "Remove saved key",
      agentKeyRemoved: "Saved BGSM Agent key removed.",
      agentDisclosureHeading: "How BGSM Agent uses data",
      agentDisclosureIntro: (provider, origin) =>
        `${provider} · ${origin} · direct connection`,
      agentDisclosureSentHeading: "May send",
      agentDisclosureSentPrompt: "Your prompt, scoped public repository metadata, and visible tags",
      agentDisclosureSentCode: "Requested code snippets or private notes from that scope",
      agentDisclosureSentProtocol: "Bounded tool results and conversation summaries",
      agentDisclosureNotSentHeading: "Never sent",
      agentDisclosureNotSentSecrets: "GitHub token, credentials in model data, or stars outside the active scope",
      agentDisclosureKeyException:
        "The AI service API key is used only as an Authorization header for this exact origin.",
      agentDisclosureBuiltInAccess:
        "This service is covered by the extension's built-in host access.",
      agentDisclosureCustomAccess:
        "Custom services also require separate Chrome host access.",
      agentGrantAccess: "Grant access",
      agentAccessGranted: "Host access granted",
      agentHostAccessRequired: "Grant host access to test or use this custom service.",
      behaviorHeading: "4. Preference",
      maxTagsPerRepoLabel: "Max Auto Tags per repo",
      maxTagsPerRepoHint:
        "When you run Auto Tags, each repo can receive at most this many topic tags.",
      minTopicRepoCountLabel: "Minimum topic coverage",
      minTopicRepoCountHint:
        "Bulk Auto Tags only generates a topic tag after that topic appears on at least this many repos.",
      starsPanelDefaultLabel: "Open my stars page with the manager panel by default",
      starsPanelDefaultHint:
        "Turn this off if you prefer to land on GitHub's native stars list and open the overlay manually.",
      tokenHeading: "1. GitHub Token",
      tokenIntroPrefix: "Create a fine-grained PAT at",
      tokenLinkLabel: "github.com/settings/tokens",
      tokenIntroSuffix: "Required permissions:",
      tokenPublicRepos:
        "Account · Starring (read/write, for sync and unstar)",
      tokenGists: "Account · Gists (read/write, for cross-device tag sync)",
      tokenGistNote:
        "Note: GitHub Gist scope is account-wide (no per-gist isolation for fine-grained tokens). We create one dedicated secret gist for sync.",
      authenticatedAs: (username) => `Authenticated as @${username}.`,
      openVerifiedStars: "Open my stars",
      removeToken: "Remove token",
      cachedAccountWarning: (username) =>
        `Cached account @${username} exists, but the token is not usable in this extension instance.`,
      clearCachedAuth: "Clear cached auth",
      saveVerify: "Save & verify",
      verifying: "Verifying…",
      tokenVerified: (username) => `Token verified. Logged in as ${username}. Sync and Gist access checked; unstar also needs Starring read/write.`,
      tokenRemoved: "Token removed.",
      tokenStepsTitle: "How to create the token (fine-grained PAT)",
      tokenStep1:
        "Open GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.",
      tokenStep2:
        'Token name: anything (e.g. "stars-manager"). Expiration: pick whatever you like.',
      tokenStep3:
        'Repository access → select "All public repositories" (the extension reads your starred public repos).',
      tokenStep4:
        'Account permissions → enable "Starring (read and write)" and "Gists (read and write)". Leave everything else off.',
      tokenStep5:
        "Generate → copy the token (starts with github_pat_…) → paste it above → Save & verify.",
      shotNewToken: 'Screenshot: the "Generate new token" form',
      shotRepoAccess:
        "Screenshot: repository access set to all public repositories",
      shotPermissions:
        "Screenshot: account permissions — Starring (read/write) + Gists (read and write)",
      languageLabel: "Language",
      gistHeading: "3. Gist sync",
      gistBoundPrefix: "Bound to gist",
      gistBoundSuffix:
        "Tags sync to and from this gist. If the same repo is edited in two places, the newer change wins.",
      gistEmpty:
        "No gist yet. One is created automatically on your first tag push.",
      gistOpenLink: "Open this gist on GitHub Gist",
    },
    repoChip: {
      untagged: "untagged",
      filterByTag: (tag) => `Filter stars by "${tag}"`,
      editTags: "Edit tags",
    },
    background: {
      noToken: "No token configured",
      unknownBackfill: (id) => `Unknown backfill: ${id}`,
      unsupportedBackfillKind: (kind) => `Unsupported backfill kind: ${kind}`,
      incrementalSyncing: "Checking for newly starred repos…",
      incrementalDone: (added) => `+${added} new`,
      fullDone: (count) => `Full sync done · ${count} repos refreshed`,
      rescanDone: (tombstoned, revived) => `Rescan done · ${tombstoned} removed, ${revived} restored`,
      autoAssignTagging: "Auto-tagging repos from topics…",
      autoAssignDone: (tagged) => `Auto-assigned · ${tagged} tagged`,
      fetchingPages: (total) => `Fetching ${total} pages…`,
      fetchingPageRetry: (page, attempt) => `Retrying page ${page} (attempt ${attempt})…`,
      syncedRepos: (count) => `Synced ${count} repos`,
      rescanningPages: (total) => `Rescanning ${total} pages…`,
      reconcilingLocal: (count) => `Reconciling ${count} local repos…`,
      rescanSummary: (tombstoned, revived) => `Rescan: ${tombstoned} removed from live set, ${revived} restored`,
      pushingTags: "Uploading tag snapshot to Gist…",
      pullingTags: "Pulling tags from Gist…",
      gistPushDone: (count) => `Pushed ${count} changed tag records to Gist`,
      gistPushRecreated:
        "Created a new sync Gist and uploaded your tag snapshot",
      gistPushNoChanges: "No local tag changes to push",
      gistPullDone: (merged, total) =>
        `Pulled ${merged} updates from ${total} remote tag records`,
      gistPullMissing:
        "The linked sync Gist was missing; the app unbound it on this device. Push to create a new one.",
    },
    errors: {
      tokenEmpty: "Please paste a token first.",
      tokenRejected:
        "GitHub rejected this token. Check that you copied the whole value.",
      tokenStarsForbidden:
        'This token can read your profile but lacks "Starring (read/write)". Re-create it with that permission.',
      tokenGistsForbidden:
        'This token can read your profile but lacks "Gists (read/write)". Re-create it with that permission.',
      tokenProfileStatus: (status) =>
        `GitHub responded with ${status} when checking your profile. Try again in a moment.`,
      tokenProfileBadShape:
        "GitHub returned a profile response without the expected username. Nothing was saved; retry shortly.",
      tokenProfileNetwork:
        "Could not reach GitHub while checking your profile. Check your connection and retry.",
      tokenStarsStatus: (status) =>
        `GitHub responded with ${status} when checking your starred-repo access. Try again in a moment.`,
      tokenStarsNetwork:
        "Could not reach GitHub while checking your starred-repo access. Check your connection and retry.",
      tokenGistsStatus: (status) =>
        `GitHub responded with ${status} when checking Gist access. Try again in a moment.`,
      tokenGistsNetwork:
        "Could not reach GitHub while checking Gist access. Check your connection and retry.",
      tokenGistProbeBadShape:
        "GitHub created the probe Gist but returned an unexpected response. Nothing was saved; retry.",
      tokenGistCleanupStatus: (status) =>
        `GitHub created the probe Gist but cleanup failed (${status}). Nothing was saved; retry.`,
      tokenGistCleanupNetwork:
        "GitHub created the probe Gist but cleanup could not be confirmed. Nothing was saved; retry.",
      ghTokenRejected: "GitHub rejected the saved token. Re-add it in Options.",
      ghRateLimit: "GitHub rate limit reached. Wait a minute and retry.",
      ghForbidden:
        "GitHub refused the request (403). The token may lack permissions (for unstar, Starring read/write) or repository access. Token settings: github.com/settings/tokens.",
      ghTimeout: (page) =>
        `GitHub took too long to respond (page ${page}). Retry shortly.`,
      ghNetwork: (detail) =>
        `Could not reach GitHub (${detail}). Check your connection.`,
      ghPageStatus: (status) =>
        `GitHub returned ${status}. Retry, or re-add the token in Options.`,
      ghNoToken: "No GitHub token configured. Add one in Options.",
      ghBadShape:
        "GitHub returned an unexpected data shape. Pull may need a full re-sync.",
      gistNoToken: "No token configured for Gist sync. Add one in Options.",
      gistCreateFailed:
        "Could not create the sync Gist. Check the token has Gists (read/write).",
      gistPushFailed:
        "Could not write to the sync Gist. Check the token has Gists (read/write).",
      gistPullFailed:
        "Could not read the sync Gist. It may have been deleted, or the token lacks Gists (read).",
      agentApiKeyEmpty: "Add an API key before testing the connection.",
      agentModelEmpty: "Enter a model before testing the connection.",
      agentBaseUrlEmpty: "Enter the Base URL from your AI service.",
      agentBaseUrlInvalid:
        "Enter a valid HTTPS Base URL, or a local http://localhost URL.",
      agentHostPermissionDenied:
        "Allow this AI service before saving or testing it.",
      agentProviderUnsupported: "This AI service isn't supported yet.",
      agentProviderTimeout:
        "The AI service did not respond in time. Try again, or use a smaller request.",
      agentProviderIdentityChanged:
        "AI service settings changed during the test. Review them and test the connection again.",
      agentProviderResponseInvalid:
        "The AI service returned an incompatible response. Check the service settings and try again.",
      agentDataDisclosureRequired:
        "Review and accept the Agent data-sharing disclosure before connecting.",
      agentContextCapabilityRequired:
        "AI service capability is not ready. Check the context window and test the connection before using Agent tools.",
      agentContextCapabilityInfeasible:
        "Increase the context window in Advanced settings before using the Agent.",
      unknown: (raw) => `Something went wrong: ${raw}`,
    },
    onboarding: {
      title: "Welcome to Better GitHub Stars Manager",
      noTokenBody: "To manage your stars, add a GitHub token first:",
      createPatLabel: "Create a fine-grained PAT",
      openOptions: "Open Options",
      syncingBody:
        "Fetching your stars… the list will fill in as the first sync completes.",
      syncFailedBody: "The first sync failed:",
      retry: "Retry sync",
      gotIt: "Got it",
      tooltipSyncFirst:
        "Sync pulls in stars you've starred since your last visit (a few requests). Run it whenever you want fresh data.",
      tooltipPushFirst:
        "Push backs up your tags + notes to a private Gist so they survive across devices. Auto-created on first push.",
      tooltipPullFirst:
        "Pull merges tags + notes from your Gist into this device (per-repo, last-write-wins). Use after editing on another device.",
      coachTitle: "Quick tour",
      coachIntro:
        "Here are the core controls you'll use most. Follow along — this shows only once.",
      coachStep1Title: "Sync your stars",
      coachStep1Body:
        "Sync pulls in newly starred repos since your last visit. It runs automatically on first load; click it anytime to refresh. It won't create tags by itself.",
      coachStep2Title: "Generate tags when you choose",
      coachStep2Body:
        "Auto Tags suggests topic-based labels for your synced repos. Run it when you want classification; sync and full sync leave tags untouched.",
      coachStep3Title: "Filter by tags",
      coachStep3Body:
        "The Tags sidebar lists all your tags, sorted by how often they're used. Click any tag (the whole row) to filter the list. Hover a tag for the delete button.",
      coachStep4Title: "Open a repo",
      coachStep4Body:
        "Click any row to open the detail drawer — edit tags, write notes, and accept suggested tags there.",
      coachStep5Title: "Hide the panel",
      coachStep5Body:
        "Want GitHub's native stars list for a moment? Click here to retract the overlay — a floating button stays on screen to bring the panel back.",
      coachNext: "Next",
      coachBack: "Back",
      coachSkip: "Skip tour",
      coachOf: (current, total) => `Step ${current} of ${total}`,
    },
  },
  "zh-CN": {
    localeName: "中文",
    common: {
      untagged: "未标注",
      remove: "移除",
      add: "添加",
      bulk: "批量",
      save: "保存",
      saved: "已保存",
      unsaved: "有未保存的更改",
      cancel: "取消",
      apply: "应用",
      loading: "加载中…",
      none: "—",
      close: "关闭",
      previous: "上一个",
      next: "下一个",
      current: (value) => `当前: ${value}`,
      phase: (phase) =>
        ({
          idle: "空闲",
          full: "全量",
          incremental: "增量",
          rescan: "重扫",
          gist: "Gist",
        })[phase],
    },
    dev: {
      version: (hash) => `DEV ${hash}`,
      clearLocalData: "清本地",
      confirmClearLocalData: "确认清除",
      clearingLocalData: "清除中…",
      clearLocalDataFailed: (error) => `清除失败: ${error}`,
    },
    manager: {
      syncFailed: (label, error) => `${label}: ${error}`,
      autoAssignDone: (count) =>
        `已从仓库 topics 为 ${count} 个仓库自动分配标签`,
      autoAssignFailed: (error) => `自动分配标签失败: ${error}`,
      autoTagAgentPromptTitle: "要试试让 Agent 帮你分配标签吗？",
      autoTagAgentPromptBody:
        "Agent 可以查看仓库详情并建议 manual tags；Auto Tags 会留在本地，根据已同步的 topics 一键分配。",
      autoTagAgentPromptYes: "是，打开 Agent",
      autoTagAgentPromptNo: "不，使用 Auto Tags",
      deleteTagFailed: (error) => `删除标签失败: ${error}`,
      deleteAllTagsFailed: (error) => `删除全部标签失败: ${error}`,
      noTokenBanner: "未配置 GitHub token — 无法加载数据。",
      addPat: "打开选项页并添加 PAT",
      emptyState: "无结果。调整筛选，或点击工具栏中的 Sync。",
      backfillSyncTitle: "需要同步数据",
      backfillSyncBody:
        "这个版本需要为你现有的 starred 仓库同步一次数据，跑一次 Full Sync 就可以了。",
      backfillSyncAction: "立即同步",
      backfillSyncRetry: "重试同步",
      backfillSyncLater: "稍后再说",
      backfillSyncRunning: "正在同步数据…",
      backfillSyncFailed: (error) => `同步失败: ${error}`,
    },
    toolbar: {
      searchPlaceholder: "搜索 名称 / 描述 / topics / notes   (按 / 聚焦)",
      searchClearTitle: "清空搜索",
      sortStarredAt: "按 star 时间",
      sortPushedAt: "按更新时间",
      sortCreatedAt: "按仓库创建时间",
      sortStars: "按 star 数",
      sortName: "按名称",
      toggleSortDir: "切换排序方向",
      syncTitle: "增量同步新的 stars",
      syncButton: "Sync",
      fullSyncTitle: "重新完整拉取你的全部 stars",
      fullSyncButton: "Full Sync",
      themeTitle: "切换黑白主题",
      githubHomeTitle: "GitHub 首页",
      hidePanelTitle: "隐藏面板（用 GitHub 原生列表）",
      starRepoTitle: "点个Star~",
      autoAssignTitle: "根据每个仓库的 topics 自动分配标签（实验性功能）",
      autoAssignButton: "Auto Tags",
      agentTitle: "打开可选的 AI 标签助手",
      agentButton: "Agent",
      gistTitle: "Gist 备份操作",
      gistButton: "Gist",
      gistPushing: "Gist · 推送中",
      gistPulling: "Gist · 拉取中",
      gistPushTitle: "推送标签到你的 Gist 备份",
      gistPushButton: "Push",
      gistPullTitle: "从你的 Gist 备份拉取标签",
      gistPullButton: "Pull",
      gistLinkTitle: "在 github.com 打开你的标签同步 Gist",
      moreTitle: "更多操作",
      shownTotal: (shown, total) => `${shown} 已显示 / ${total} 总计`,
      noToken: "未配置 token",
      accountTitle: (username) => `已登录为 @${username}`,
      columnRepository: "仓库",
      columnDescription: "描述",
      columnLanguage: "语言",
      columnStars: "Stars",
      columnUpdated: "更新",
      columnCreated: "创建",
      columnTags: "标签",
      columnStarAction: "取消 Star",
      columnFavorite: "收藏",
      columnNotes: "备注",
      viewLabel: "视图",
      defaultLayout: "默认",
      customLayout: "自定义",
      customLayoutChanged: "自定义布局与默认不同",
      editLayout: "编辑自定义布局",
      previewCustomLayout: "正在预览自定义布局，点击应用",
      editingLayout: "正在编辑布局",
      columnsButton: "列",
      columnsButtonTitle: "显示或隐藏列",
      hiddenColumns: (count) => `已隐藏 ${count}`,
      hiddenColumnsTip: "点击恢复 · 拖回表头可插入位置",
      hideColumn: (label) => `隐藏「${label}」`,
      restoreColumn: (label) => `恢复「${label}」`,
      dragColumnTitle: (label) => `拖动「${label}」排序；拖到托盘隐藏`,
      dragColumnHint: "水平拖动排序 · 拖到托盘隐藏",
      dragHideHint: (label) => `松手隐藏「${label}」`,
      dragTrayHint: "拖到表头插入",
      dragInsertHint: "松手插入这里",
      resizeColumnTitle: (label) => `调整「${label}」列宽`,
      lockedColumn: "锁定",
      fitWidths: "适应面板宽度",
      resetWidths: "重置列宽",
      resetLayout: "重置",
      resizeFrozenPeers: "Live drag：冻结同伴列",
      resizeFitExplicit: "Fit action：只在显式动作发生",
      resizeDefaultGuide: (width) => `默认 ${width}px`,
      resizeBadgeDefault: "默认",
      resizeBadgeMin: "最小",
      resizeDeltaCurrentOnly: "仅当前列",
      resizeWidthReadout: (tableWidth, panelWidth, overflow) => `总宽 ${tableWidth}px / 面板 ${panelWidth}px${overflow > 0 ? ` / 溢出 +${overflow}px` : ''}`,
      resizeLiveWidthReadout: (label, width, delta, tableWidth, panelWidth, overflow) =>
        `${label} ${width}px（${delta >= 0 ? '+' : ''}${delta}px） / 总宽 ${tableWidth}px / 面板 ${panelWidth}px${overflow > 0 ? ` / 溢出 +${overflow}px` : ''}`,
    },
    agentPanel: {
      title: "BGSM Agent",
      chatInputLabel: "向 BGSM Agent 提问",
      chatHeaderIdle: "就绪",
      chatIntro:
        "我可以检查、对比并整理当前范围内的仓库。Auto Tags 仍是本地一键操作——这个对话负责需要判断的部分。",
      chatPlaceholder: "问这些仓库…",
      chatPlaceholderScoped: (count) => (
        count === 1
          ? "问这个仓库…"
          : `问这 ${count} 个仓库…`
      ),
      chatWorking: "BGSM Agent 正在处理...",
      autoAssignPrompt:
        "整理整个 starred 资料库中尚未标注的仓库。先检查全部仍在收藏的仓库，只在 topics、名称、描述或已有标签有明确依据时添加 manual tags；完成全库分析后只返回一次完整审阅，再应用任何变更。",
      summarizeScopePrompt:
        "检查当前范围内的仓库，总结它们的用途、主要模式和值得注意的差异。使用本地仓库元数据，不要修改标签。",
      findSimilarPrompt:
        "在当前范围内找相似工具，并用本地仓库元数据给出有证据的对比。",
      cleanupTagsPrompt:
        "检查当前范围内的标签命名，并建议清理机会。不要移除或删除标签；只说明候选，后续如需删除走独立确认路径。",
      searchCodePrompt:
        "搜索选中仓库的代码，分析它的主要架构并说明关键实现文件。不要修改标签。",
      reviewNotesPrompt:
        "读取选中仓库的私人笔记，并总结其中有用的上下文。不要修改标签。",
      quickFindSimilar: "找相似工具",
      quickOrganizeUntagged: "整理整个资料库",
      quickCleanupTags: "清理标签命名",
      functionMenuLabel: "提示词建议",
      functionMenuTitle: "建议提示词",
      functionSummarize: "总结当前范围",
      functionSummarizeDescription: "检查仓库元数据并说明主要模式。",
      functionFindSimilar: "查找相似工具",
      functionFindSimilarDescription: "对比当前范围内最值得关注的替代方案。",
      functionOrganizeUntagged: "整理整个资料库",
      functionOrganizeUntaggedDescription: "分析全部仍在收藏的仓库并准备一次完整标签审阅。",
      functionReviewTags: "检查标签命名",
      functionReviewTagsDescription: "查找重复和命名清理机会，不直接删除。",
      functionSearchCode: "搜索仓库代码",
      functionSearchCodeDescription: "检查选中仓库的公开代码索引。",
      functionReviewNotes: "查看仓库笔记",
      functionReviewNotesDescription: "读取选中仓库关联的私人笔记。",
      askingAboutCurrentView: (count) => (
        count === 1
          ? "正在询问当前视图 · 1 个仓库"
          : `正在询问当前视图 · ${count} 个仓库`
      ),
      askingAboutSelectedRepository: "正在询问选中仓库 · 1",
      askingAboutAllLiveStars: (count) => (
        typeof count === "number"
          ? (count === 1
            ? "正在询问全部 live stars · 1 个仓库"
            : `正在询问全部 live stars · ${count} 个仓库`)
          : "正在询问全部 live stars"
      ),
      agentChanged: (count) => `已应用 ${count} 次标签更新`,
      turnFailed: "本轮失败",
      attemptStateLost: "扩展重启后无法恢复本轮执行。请先检查已完成的变更，再重试。",
      answerReady: "回答已就绪",
      providerErrorTitle: "服务商错误",
      providerErrorSubtitle: "本地数据未被修改",
      providerErrorBody: "你的问题仍在对话里。可以重试同一问题，或开始新对话。",
      retry: "重试",
      noLocalDataModified: "本地数据未被修改",
      contextSettingsTitle: "AI 服务设置需要调整",
      contextSettingsMessage: "请先调整此服务的上下文设置。你的草稿已保留。",
      contextPromptTooLargeTitle: "本次请求内容过多",
      contextPromptTooLargeMessage: "请缩短草稿；如果 AI 服务支持，也可以调高已配置的上下文上限。",
      contextToolMemoryTitle: "BGSM 达到本轮内部工具数据上限",
      contextToolMemoryMessage: "你的提示词和已完成结果都已保留。可直接重试继续处理，无需缩短提示词或调整模型上下文窗口。",
      contextToolMemoryWriteBlockedMessage: "已完成的结果已保留，但一次写入可能已经完成。请检查或修改本次请求后再发送。",
      contextAdjustSettings: "调整 AI 服务设置",
      contextEditPrompt: "编辑提示词",
      composerPausedContextRecovery: "草稿已保留 · 请从上方选择恢复方式",
      composerWriteRetryBlocked: "写入可能已经完成，请检查或修改本次请求后再发送。",
      startNewConversation: "开始新对话",
      sessionsLabel: "对话列表",
      sessionUntitled: "新对话",
      sessionDelete: "删除对话",
      sessionDeleteTitle: "删除这个对话？",
      sessionDeleteMessage: (title) => `确定删除「${title}」吗？它在本面板中的本地记录会被移除。`,
      sessionDeleteConfirm: "删除",
      sessionDeleteCancel: "取消",
      hideWhileRunning: "隐藏 BGSM Agent",
      runContinuesWhileHidden: "可以隐藏面板；本轮会继续。",
      confirmScopeHeader: "确认范围",
      analyzingHeader: (processed, total) => `分析中 · ${processed}/${total}`,
      analyzingTitle: "正在分析冻结范围",
      analyzingMeta: (processed, remaining, batches) => (
        `已处理 ${processed} · 剩余 ${remaining} · ${batches} 批`
      ),
      frozenScopeNote: (count) => (
        count === 1
          ? "冻结范围 · 1 个仓库"
          : `冻结范围 · ${count} 个仓库`
      ),
      pendingConfirmationNote: (count) => (
        count === 1
          ? "待确认 · 1 个仓库"
          : `待确认 · ${count} 个仓库`
      ),
      turnFrozenScopeNote: (count) => (
        count === 1
          ? "当前视图 · 1 个仓库 · 本轮冻结"
          : `当前视图 · ${count} 个仓库 · 本轮冻结`
      ),
      conversationFrozenScope: (label, count) => (
        count === 1
          ? `${label} · 1 个仓库 · 本对话范围已冻结`
          : `${label} · ${count} 个仓库 · 本对话范围已冻结`
      ),
      readOnlyResultTitle: "只读回答",
      readOnlyResultSubtitle: "未提出标签变更",
      noTagChangesProposed: "未提出标签变更",
      hideAgent: "隐藏 BGSM Agent",
      stop: "停止",
      cancel: "取消",
      applyingHeader: (done, total) => `应用中 · ${done}/${total}`,
      applyingTitle: "正在应用选中变更",
      applyingSubtitle: "仅 manual 标签层 · 冻结范围仍锁定",
      applyingMeta: (done, total) => `已提交 ${done}/${total} 行 · 复选框已锁定`,
      applyingButton: "应用中…",
      applyingStopbar: "单行应用中不可中断；仍可隐藏面板。",
      composerPausedApplying: "应用期间暂停输入",
      budgetExhaustedHeader: "预算已用尽",
      budgetExhaustedTitle: (reason) => `预算已用尽 · ${reason}`,
      budgetExhaustedSubtitle: (processed, total) => `已处理 ${processed} / ${total} · 剩余不会自动继续`,
      budgetExhaustedBody: "剩余工作不会自动处理或重放。继续会创建新的 run，并使用新的预算与冻结游标。",
      continueRemainingCount: (count) => `继续剩余 ${count}`,
      nothingToAnalyzeHeader: "没有可分析内容",
      nothingToAnalyzeTitle: "没有可分析内容",
      nothingToAnalyzeBody: "可见仓库可能都已有标签，或当前筛选隐藏了候选。请调整筛选或扩大范围后再问。",
      emptyScopeCount: "此范围匹配 0 个仓库。",
      handoffHeader: "交接 · 仍未标注",
      handoffTitle: "来自 Auto Tags",
      handoffSubtitle: (count) => `确定性整理已完成 · 仍有 ${count} 个未标注`,
      handoffBody: "Auto Tags 已更新基于 topic 的 auto tags。此对话只针对剩余未标注集合；除非你之后应用 manual tags，否则不会覆盖 Auto Tags 结果。",
      handoffAsk: (count) => `我可以帮你整理 Auto Tags 留下的 ${count} 个未标注仓库。要不要为这批提出谨慎的 manual tags？`,
      handoffOrganize: (count) => `好 — 整理这 ${count} 个`,
      handoffAmbiguous: "只看不明确的",
      handoffExamples: "先解释几个例子",
      handoffScopeNote: (count) => (
        count === 1
          ? "Auto Tags 后仍未标注 · 1 个仓库"
          : `Auto Tags 后仍未标注 · ${count} 个仓库`
      ),
      destructiveHeader: "确认破坏性变更",
      destructiveTitle: "确认标签库变更",
      destructiveSubtitle: "破坏性 · 需要审阅 · 不会自动应用",
      destructiveBody: "重命名、合并、删除不在自由聊天工具路径上。在写入标签库清理前，需要独立的确认 + Apply 流程。",
      destructiveUnavailable: "首个安全版本暂不可用",
      partialReceiptHeader: "已应用，但有冲突",
      resolvingScopeHeader: "正在解析范围…",
      resolvingScopeBody: "我会为本轮冻结确切的仓库 ID，避免之后改筛选时静默扩大任务范围。",
      resolvingScopeMeta: "通常很快 · 若选错筛选可取消",
      scopeNotFrozenYet: "范围尚未冻结",
      reviewFollowUpNote: "审阅仍打开 · 可继续追问",
      reviewFollowUpPlaceholder: "就本次审阅继续提问…",
      reviewConversationDetails: "对话细节",
      stopMidAnalyzeHeader: "已由你停止",
      stopMidAnalyzeTitle: "运行已停止",
      stopMidAnalyzeSubtitle: "用户中止 · 没有进行中的写入",
      stopMidAnalyzeBody: (processed, remaining) => (
        `待处理分析已取消。已完成读取：${processed}。未开始：${remaining}。已提交写入：0。`
      ),
      stopMidAnalyzeResume: "以新 run 继续剩余",
      stopMidAnalyzeDiscard: "丢弃",
      staleSourceTitle: "提案后源数据已变化",
      staleSourceBody: "过期行被留下未改。只刷新冲突即可，不要盲目整库重跑。",
      providerAuthHeader: "服务商鉴权失败",
      providerAuthTitle: "OpenAI 兼容鉴权失败",
      providerAuthSubtitle: "API key 被拒或缺少 host permission",
      providerAuthBody: "无法调用你配置的服务商。提示词与范围已保留。此处不展示任何密钥。",
      providerAuthOpenOptions: "打开选项",
      providerAuthRetry: "修复后重试",
      completedNoChangesHeader: "已完成 · 无变更",
      completedNoChangesTitle: "已完成 · 无变更",
      completedNoChangesSubtitle: (inspected) => `0 条可操作提案 · 已检查 ${inspected}`,
      completedNoChangesBody: "全部已有清晰分类，或证据不足无法安全提出 manual tag。无需应用。",
      unknownOutcomeComposer: "应用已结束 · 结果未知 · 可继续对话",
      applyTerminalUnknownComposer: "应用已结束 · 结果未知 · 可继续对话",
      agentQueued: "正在准备这次请求...",
      agentCompacting: "正在整理对话上下文…",
      agentStarting: "正在准备上下文...",
      agentThinking: "思考中...",
      agentWriting: "回复中...",
      agentReadingData: "正在检查本地数据...",
      agentSearchingCode: "正在检查仓库代码...",
      agentPreparingOrganizationScope: "正在准备全库整理范围...",
      agentApplyingChanges: "正在应用标签变更...",
      agentDone: "完成",
      agentStopped: "已停止",
      agentToolQueued: "等待中",
      agentToolRunning: "执行中",
      agentToolCompleted: "已完成",
      agentToolFailed: "失败",
      agentToolDone: "完成",
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
      reasoningAgentTurn:
        "我会调用模型服务，用工具检查本地 stars，并通过插件受控工具应用标签变更。",
      toolResult: "工具结果",
      emptyAgentMessage: "完成。",
      chatSuggestionsReady: (count) => `我准备了 ${count} 条标签建议。应用前可以先在下面确认。`,
      chatNoSuggestions: "基于当前本地数据，暂时没有找到新的标签建议。",
      chatLimitedCapability:
        "我可以用你配置的 AI 服务帮你整理 stars。",
      reasoningSuggestTags:
        "我会查看本地仓库 topics 和现有标签，跳过已排除的标签，并保守地应用标签变更。",
      reasoningStreaming: "正在运行 agent...",
      reasoningDone: (duration) => `已检查本地标签，用时 ${duration}s`,
      reviewTitle: "确认标签建议",
      send: "发送",
      noSuggestionsReady: "暂无建议",
      readySummary: (add, remove, deleteCount) => {
        const parts = [
          add > 0 ? `${add} 个添加` : null,
          remove > 0 ? `${remove} 个移除` : null,
          deleteCount > 0 ? `${deleteCount} 个删除` : null,
        ].filter((part): part is string => part !== null);
        return parts.length === 0 ? "暂无建议" : parts.join(" · ");
      },
      refreshTitle: "刷新建议",
      closeTitle: "关闭 BGSM Agent",
      suggestTags: "整理这里的未标注",
      agentSettings: "Agent 设置",
      cleanupTags: "整理标签",
      selectAllPage: "选择当前页全部建议",
      selectedOnPage: (count) => `当前页已选 ${count} 个`,
      nothingToApply: "暂无可应用内容",
      loadingSuggestions: "正在加载建议",
      emptyTitle: "还没有建议。",
      emptyBody: "建议会显示在这里。",
      applied: (count) => `已应用 ${count} 条建议。`,
      loadFailed: "无法加载建议。",
      created: (count) => `已准备 ${count} 条建议。`,
      noneFound: "没有找到新的建议。",
      createFailed: "无法生成建议。",
      groupAdd: "添加标签",
      groupRemove: "从仓库移除标签",
      groupDelete: "删除标签",
      groupSelection: (selected, total) => `${selected}/${total}`,
      addTitle: (fullName) => `为 ${fullName} 添加标签`,
      removeTitle: (fullName) => `从 ${fullName} 移除标签`,
      deleteTitle: (tag) => `删除 ${tag}`,
      more: (count) => `还有 ${count} 个`,
      range: (start, end, total) => `${start}-${end} / ${total}`,
      zeroSuggestions: "0 条建议",
      toolbarApplying: "正在应用",
      toolbarReview: "待审阅",
      toolbarInterrupted: "已中断",
      scopeReady: "范围已就绪",
      runStateLabel: (value) => ({
        frozen: "范围已冻结",
        prepared: "分析已准备",
        checking_provider: "正在检查 AI 服务",
        analyzing: "正在分析",
        analysis_blocked: "分析已阻断",
        review: "待审阅",
        applying: "正在应用",
        paused: "已暂停",
        completed: "已完成",
        budget_exhausted: "预算已用尽",
        cancelled: "已取消",
        failed: "失败",
        interrupted: "已中断",
        consumed_positions: "已达到仓库处理上限",
        provider_attempts: "已达到服务调用上限",
        analyzer_batches: "已达到分析批次上限",
        elapsed_ms: "已达到运行时限",
        user_stopped: "用户已停止",
        user_aborted: "用户已取消",
        no_changes: "没有变更",
        stale_source: "源数据已变化",
        worker_lost: "扩展后台已重启",
        port_disconnected: "连接已中断",
        internal_error: "内部错误",
        analysis_failed: "分析失败",
        budget: "运行预算",
        changed: "已变更",
        skipped: "已跳过",
        unchanged: "未变化",
      }[value] ?? value.replaceAll("_", " ")),
      needsReviewFollowUp: "待审阅 · 正在回答追问",
      needsReviewSelected: (count) => `待审阅 · 已选择 ${count} 条`,
      appliedTagChanges: (count) => `已应用 ${count} 项标签变更`,
      followUpAboutScope: "继续询问此范围",
      askingAboutCurrentViewUnknown: "正在询问当前视图",
      handoffAutoTagsUpdated: "自动标签已更新基于主题的标签。",
      agentActivityLabel: "Agent 活动",
      workbench: {
        resolvingSubtitle: "正在为完整 starred 资料库准备一个作业",
        resolvingBody: "正在冻结全部仍在收藏的仓库；筛选条件和当前选中行都不会缩小本次整理范围。",
        resolvingHint: "通常很快 · 此步骤不会修改标签",
        confirmScopeTitle: "确认分析范围",
        repositoriesFrozen: (count) => `本轮将冻结 ${count} 个仓库。`,
        reviewBeforeApply: "分析完成后会先生成一次完整审阅；此步骤不会修改标签。",
        startAnalysis: "开始分析",
        startingAnalysis: "正在启动分析",
        analysisScopeIncomplete: "已保存的分析范围不完整，请重新准备后再试。",
        nothingToAnalyzeBody: "可见仓库可能都已有标签，或当前筛选隐藏了候选项。请调整筛选或扩大范围后重试。",
        dismiss: "关闭",
        confirmRequestedScope: "确认请求的范围",
        candidateRepositories: (count) => `${count} 个候选仓库。`,
        continue: "继续",
        analyzingFrozenScope: "正在分析已冻结范围",
        progressSummary: (processed, remaining) => `已分析 ${processed} · 剩余 ${remaining}`,
        runProgressLabel: "运行进度",
        processed: "已处理",
        remaining: "剩余",
        batches: "批次",
        providerAttempts: "服务调用",
        analysisBlockedTitle: "全库分析未完成",
        analysisCoverage: (processed, total) => `已分析 ${processed} / ${total} 个仓库`,
        analysisBlockedBody: (failed) => failed > 0
          ? `${failed} 个仓库分析失败。不会展示或应用部分建议；可以继续处理失败项，或重新分析整个资料库，以生成一次完整审阅。`
          : "不会展示或应用部分建议。可以继续处理剩余项，或重新分析整个资料库，以生成一次完整审阅。",
        restartWholeLibrary: "重新分析整个资料库",
        discardAnalysis: "放弃本次分析",
        runStateRefreshed: "已恢复最新的分析进度。请再次继续，或重新分析整个资料库。",
        analysisReady: "分析已就绪",
        preparedReady: "所选范围已准备就绪。",
        preparedPaused: "所选范围已准备就绪，将在当前运行停止后开始。",
        budgetExhausted: (reason) => `预算已用尽 · ${reason}`,
        budgetSubtitle: (processed, total) => `已处理 ${processed} / ${total} · 剩余项未自动继续`,
        budgetProgress: (processed, remaining, attempts) => `已处理 ${processed} · 剩余 ${remaining} · 已使用 ${attempts} 次服务调用`,
        budgetBody: "剩余工作没有被自动处理或重放。继续将使用新的预算和新的冻结游标创建一次新运行。",
        continueRemainingCount: (count) => `继续处理剩余 ${count} 项`,
        moreRemain: "仍有仓库待处理",
        moreRemainBody: "当前审阅已结束，剩余仓库没有被自动处理。",
        continueCreatesRun: "继续将使用新预算创建一次新运行。",
        continueRemaining: "继续处理剩余项",
        proposalSummary: (actionable, nonActionable) => `已准备 ${actionable} 条可执行标签建议。另有 ${nonActionable} 个仓库无需操作或证据不足。`,
        proposalSelectionNote: "只有勾选的行会写入手动标签。",
        reviewSuggestions: "审阅可执行建议",
        reviewCoverageComplete: (count) => `已覆盖完整资料库 · 已分析 ${count} 个仓库`,
        proposalCounts: (actionable, nonActionable, selected) => `${actionable} 条可执行 · ${nonActionable} 条不可执行 · 已选择 ${selected} 条`,
        finishReviewFirst: "仍有仓库待处理。请先完成当前审阅再继续。",
        selectRepository: (repositoryId) => `选择 ${repositoryId}`,
        applyingSelectedChanges: "正在应用所选变更",
        selectedRowsLocked: (count) => `已选择 ${count} 行 · 复选框已锁定`,
        applying: "正在应用…",
        applySelected: (count) => `应用所选 ${count} 项`,
        applyTagImpact: (tags, repositories) => `将 ${tags} 个标签应用到 ${repositories} 个仓库`,
        selectAll: "全选",
        clear: "清除",
        previousPage: "上一页",
        nextPage: "下一页",
        reviewPageRange: (start, end, total) => `${start}-${end} / ${total}`,
        applyingSubtitle: "手动标签层 · 冻结范围仍锁定",
        rowsSelectedLocked: (selected, total) => `已选择 ${selected} / ${total} 行 · 复选框已锁定`,
        receiptPartial: (changed, skipped, failed) => `已应用 ${changed} 行，跳过 ${skipped} 行，${failed} 行前置条件失败且未改动。`,
        receiptSingle: "已将所选 1 行应用为手动标签，未推送到 Gist。",
        receiptComplete: (changed) => `已将所选 ${changed} 行应用为手动标签，未推送到 Gist。`,
        mutationReceipt: "资料库更新回执",
        receiptSubtitle: "一个权威结果 · 本地手动标签 · 未推送 Gist",
        receiptCountsLabel: "回执计数",
        changed: "已变更",
        skipped: "已跳过",
        failed: "失败",
        unchanged: "未变化",
        receiptCountSummary: (changed, skipped, failed) => `已变更 ${changed} · 已跳过 ${skipped} · 失败 ${failed}`,
        unchangedCount: (count) => `${count} 行未变化`,
        receiptRowsLabel: "回执行",
        viewAllRows: "查看全部行",
        viewFailedChanged: "查看失败和已变更项",
        viewChanged: "查看已变更项",
        connectionInterrupted: "Agent 连接已中断，正在重新连接…",
        workerLost: "扩展后台已重启，本次运行无法继续。请开始新的分析。",
        timelineLabel: (state) => ({
          preflight: "正在解析范围",
          frozen: "范围已冻结",
          prepared: "分析已准备",
          checking_provider: "正在检查 AI 服务",
          analyzing: "正在分析",
          review: "待审阅",
          applying: "正在应用",
          completed: "已完成",
          budget_exhausted: "预算已用尽",
          cancelled: "已取消",
          failed: "失败",
          interrupted: "已中断",
        }[state] ?? state.replaceAll("_", " ")),
        runStepsLabel: "Agent 运行步骤",
        runStepScope: "范围",
        runStepAnalyze: "分析",
        runStepReview: "审阅",
        runStepApply: "应用",
        runStepReceipt: "回执",
        reviewEvidence: "证据",
        reviewExistingTag: "已有",
        reviewNewTag: "新建",
        reviewOpenRepository: "在 GitHub 打开仓库",
        reviewExpandRow: "展开审阅细节",
        reviewCollapseRow: "收起审阅细节",
        reviewReject: "拒绝",
        reviewUndoReject: "撤销拒绝",
        reviewRejectedWithReason: (reason) => `已拒绝 · ${reason}`,
        reviewRejectWrongRepo: "仓库不匹配",
        reviewRejectTooBroad: "标签过宽",
        reviewRejectAlreadyCovered: "已被覆盖",
        reviewRejectNotUseful: "价值不高",
        reviewEditTag: "编辑标签",
        reviewEditTagLabel: (repositoryId, tag) => `编辑 ${repositoryId} 的标签 ${tag}`,
        reviewSaveEdit: "保存修正",
        reviewCancelEdit: "取消编辑",
        reviewEditInvalidEmpty: "请输入非空标签。",
        reviewEditInvalidNormalized: "标签必须保持 NFKC 规范化。",
        reviewEditInvalidDuplicate: "标签与该行其他动作重复。",
        reviewEditInvalidTooLong: "标签超过 256 个 UTF-8 字节。",
        reviewCorrectedTo: (tag) => `已修正为 ${tag}`,
        reviewNeedsReanalysis: "需重新分析后才能应用",
        reviewAskRevise: "要求修正",
        reviewReviseRejected: (count) => `要求修正已拒绝项（${count}）`,
        reviewReviseRejectedPrompt: (details) => `请在任何应用前修正这次标签审阅。保持冻结范围不变，跳过已拒绝行，只按修正后的意图重新分析。拒绝/修正：\n${details}`,
        reviewEditCorrectionPrompt: (repositoryId, fromTag, toTag) => `对于 ${repositoryId}，不要应用已审阅标签「${fromTag}」。请按修正后的标签意图「${toTag}」重新分析该仓库，并在任何应用前返回新的审阅行。`,
        reviewRejectCorrectionPrompt: (repositoryId, reason) => `对于 ${repositoryId}，拒绝当前建议（${reason}）。请带着这个修正重新分析该仓库，并在任何应用前返回新的审阅行。`,
        reviewLocalOnlyNote: "拒绝和编辑只是本地审阅决定。应用仍只发送勾选行及其已审阅动作。",
      },
    },
    activeFilters: {
      onlyFavorite: "收藏",
      onlyUntagged: "仅未标注",
      onlyArchived: "已归档",
      summary: (count) => `${count} 个结果 · 已筛选`,
      clearOne: "移除该筛选",
      clearAll: "清除全部筛选",
    },
    filterSidebar: {
      specialFilters: "特殊筛选",
      onlyFavoriteLabel: "收藏",
      onlyFavoriteHint: "",
      onlyUntaggedLabel: "仅未标注",
      onlyUntaggedHint: "",
      onlyArchivedLabel: "已归档",
      onlyArchivedHint: "",
      showTombstoneLabel: "显示已 unstar",
      showTombstoneHint: "tombstoned repos",
      languages: (count) => `Languages${count > 0 ? ` · ${count}` : ""}`,
      languagesSearch: "筛选语言…",
      languagesSelected: (count) => `已选 ${count} 个`,
      languagesEmpty: "没有匹配的语言。",
      tags: (count) => `Tags (${count})`,
      tagsSearch: "筛选标签…",
      tagsFilter: "搜索标签…",
      tagsEmpty: "没有匹配的标签。",
      tagsShowAll: (count) => `显示全部 ${count} 个`,
      tagsSelected: (count) => `已选 ${count} 个`,
      tagsMatchAny: "任一",
      tagsMatchAll: "全部",
      tagsMatchHelp: "匹配 任一 / 全部 所选标签",
      tagsSortAscTitle: "按标签自然升序排序",
      tagsSortDescTitle: "按标签自然降序排序",
      tagsSortDefaultTitle: "恢复标签原始顺序",
      deleteTagTitle: "删除该标签（所有仓库）",
      deleteTagConfirm: (name, count) =>
        count > 0
          ? `从全部 ${count} 个仓库删除标签「${name}」？此操作不可撤销。`
          : `删除标签「${name}」？`,
      deleteTagDone: (count) => `已从 ${count} 个仓库删除标签`,
      deleteAllTagsTitle: "删除全部标签",
      deleteAllTagsConfirm: "从所有仓库清空全部标签？此操作不可撤销。",
      deleteAllTagsDone: (assignmentsRemoved, distinctTagsRemoved) =>
        `已清空 ${distinctTagsRemoved} 个标签，共 ${assignmentsRemoved} 个仓库标签关联`,
      noTagsPrefix: "暂无标签。点击工具栏",
      noTagsEmphasis: "自动分配标签",
      noTagsSuffix: "从仓库 topics 自动生成。",
    },
    starRow: {
      archived: "已归档",
      filterByTag: (tag) => `按 "${tag}" 筛选`,
      clearTagFilter: (tag) => `正在按 "${tag}" 筛选，点击移除`,
      moreHidden: (count) => `还有 ${count} 个，在详情中查看`,
      hasNotes: "有笔记（在详情中查看）",
      noNotes: "无笔记",
      markFavorite: "收藏该仓库",
      removeFavorite: "取消收藏",
      unstar: "确定",
      unstarTitle: (fullName) => `取消 Star ${fullName}`,
      unstarCancel: "取消",
      unstarDone: (fullName) => `已从当前列表移除 ${fullName}`,
      unstarFailed: (fullName, error) => `移除 ${fullName} 失败：${error}`,
      alreadyUnstarred: "已取消 Star",
    },
    repoDetail: {
      previousTitle: "上一个 ([)",
      nextTitle: "下一个 (])",
      closeTitle: "关闭 (Esc)",
      description: "描述",
      topics: (count) => `Topics (${count})`,
      filterTopic: "按此 topic 筛选",
      suggestedTags: "建议标签",
      acceptAll: "+ 全部接受",
      acceptAllTitle: "添加所有建议标签",
      tags: (count) => `标签 (${count})`,
      tagsAction: "标签",
      notes: "笔记",
      notesPlaceholder: "为什么会 star 这个仓库？",
      notesSaved: "已保存",
      notesUnsaved: "有未保存的更改",
      language: "语言",
      stars: "Stars",
      updated: "更新",
      starred: "Star 时间",
    },
    tagEditor: {
      noTags: "尚无标签",
      filterByTag: (tag) => `按 "${tag}" 筛选`,
      clearTagFilter: (tag) => `正在按 "${tag}" 筛选，点击移除`,
      removeTag: "移除标签",
      addTagPlaceholder: "添加标签，按回车确认",
      addTagButton: "添加",
      bulkEditTitle: "批量编辑（逗号分隔）",
      bulkPlaceholder: "tag1, tag2, …",
    },
    popup: {
      title: "Better GitHub Stars Manager",
      noToken: "未配置 token。",
      addPat: "添加 PAT",
      idle: "空闲",
      syncIncremental: "同步新 stars（增量）",
      syncFull: "全量重新拉取所有 stars",
      reconcile: "校正 stars 状态",
      gistPull: "从 Gist 拉取标签",
      gistPush: "推送标签到 Gist",
      testConnection: "测试 GitHub 连接",
      debugState: "调试扩展状态",
      openStars: "打开我的 stars 页面",
      options: "选项…",
      starRepoTitle: "点个Star~",
      testing: "测试中…",
      rate: (remaining, limit) => `限额: ${remaining}/${limit} 剩余`,
      scopes: (scopes) => `权限: ${scopes ?? "（细粒度 token 不显示 scope）"}`,
      itemsOnPage: (count) => `第 1 页条目数: ${count}`,
      sample: (sample) => `示例: ${sample ?? "—"}`,
      connectionOk: "正常 — 连接可用",
      connectionNoContent: "204 No Content — token 可能缺少 /user/starred 权限",
      connectionRejected: "401 — token 被拒绝",
      connectionForbidden: "403 — 无权限（检查 scopes / repo access）",
      failed: (label, error) => `${label} 失败: ${error}`,
    },
    options: {
      title: "Better GitHub Stars Manager — 选项",
      starRepoButton: "点个Star~",
      agentHeading: "2. BGSM Agent",
      agentIntro:
        "连接你自己的 AI 服务，这样 BGSM Agent 就能在插件里直接给出 tag 建议。",
      agentServiceLabel: "AI 服务",
      agentServiceHint: "选择 BGSM Agent 要使用的服务。",
      agentAdvancedSettings: "高级设置",
      agentProtocolLabel: "API 协议",
      agentProtocolHint: "选择这个自定义服务支持的 API。",
      agentProtocolChat: "Chat Completions",
      agentProtocolResponses: "Responses API",
      agentBaseUrlLabel: "Base URL",
      agentBaseUrlHint:
        "填写服务提供的 /v1 Base URL。BGSM 只会访问其配置的 origin。",
      agentBaseUrlPlaceholder: "https://api.example.com/v1",
      agentProviderContextWindowLabel: "服务上下文窗口",
      agentProviderContextWindowHint:
        "已知 model ID 会精确匹配内置预置；也可填写此值覆盖预置，未知模型则必须填写。",
      agentProviderContextWindowRequired: "请填写此服务支持的上下文窗口。",
      agentWorkingContextWindowLabel: "工作上下文窗口",
      agentWorkingContextWindowHint:
        "可选。为此模型设置更小的工作窗口；该值只能降低服务上限。",
      agentWorkingContextWindowPlaceholder: "使用服务上限",
      agentWorkingContextWindowTooLarge: "工作窗口不能超过服务窗口。",
      agentContextWindowRange: "请输入 4,096 到 2,000,000 之间的整数。",
      agentModelLabel: "模型",
      agentModelHint: "填写这个服务支持的 model ID，之后也可以再改。",
      agentApiKeyLabel: "API Key",
      agentApiKeyHint: "只保存在本机，并会加密存储。",
      agentApiKeyPlaceholder: "粘贴 key 后即可保存或测试",
      agentSavedKeyHint:
        "这台设备里已经保存过 key。留空即可继续使用当前 key。",
      agentSave: "保存并测试",
      agentSaving: "正在保存并测试…",
      agentSavedAndTested: (provider, model, latencyMs) =>
        `已保存 · ${provider} · ${model} 已连接（${latencyMs} ms）`,
      agentSavedTestFailed: (error) =>
        `设置已保存，但连接测试失败：${error}`,
      agentSavedNeedsHostAccess:
        "设置已保存。请先授予 host 访问权限，然后测试连接。",
      agentTest: "测试连接",
      agentTesting: "测试中…",
      agentTestOk: (provider, model, latencyMs) =>
        `${provider} · ${model} 已连接（${latencyMs} ms）`,
      agentRemoveKey: "移除已保存 key",
      agentKeyRemoved: "已移除保存的 BGSM Agent key。",
      agentDisclosureHeading: "BGSM Agent 数据使用",
      agentDisclosureIntro: (provider, origin) =>
        `${provider} · ${origin} · 直接连接`,
      agentDisclosureSentHeading: "可能发送",
      agentDisclosureSentPrompt: "你的提示词、当前范围内的公开仓库元数据和可见标签",
      agentDisclosureSentCode: "你明确请求的范围内代码片段或私人笔记",
      agentDisclosureSentProtocol: "有界工具结果和对话摘要",
      agentDisclosureNotSentHeading: "不会发送",
      agentDisclosureNotSentSecrets: "GitHub token、模型任务数据中的凭据，或当前范围外的 stars",
      agentDisclosureKeyException:
        "AI 服务 API Key 只会作为 Authorization header 用于这个精确 origin。",
      agentDisclosureBuiltInAccess:
        "此服务已包含在扩展的内置 host 访问范围中。",
      agentDisclosureCustomAccess:
        "自定义服务还需要单独授予 Chrome host 访问权限。",
      agentGrantAccess: "授予访问权限",
      agentAccessGranted: "已授予 host 访问权限",
      agentHostAccessRequired: "测试或使用此自定义服务前，请先授予 host 访问权限。",
      behaviorHeading: "4. 偏好",
      maxTagsPerRepoLabel: "每个仓库最多自动标签数",
      maxTagsPerRepoHint:
        "点击 Auto Tags 时，单个仓库最多自动添加这么多个 topic 标签。",
      minTopicRepoCountLabel: "共同标签门槛",
      minTopicRepoCountHint:
        "只有达到这个仓库数量的共同 topic，才会生成自动标签。",
      starsPanelDefaultLabel: "默认打开自己的 stars 页面时显示管理面板",
      starsPanelDefaultHint:
        "关闭后会优先显示 GitHub 原生 stars 列表，需要时再手动打开悬浮面板。",
      tokenHeading: "1. GitHub Token",
      tokenIntroPrefix: "在这里创建细粒度 PAT：",
      tokenLinkLabel: "github.com/settings/tokens",
      tokenIntroSuffix: "所需权限：",
      tokenPublicRepos:
        "Account · Starring（读写，用于同步和 unstar）",
      tokenGists: "Account · Gists（读写，用于跨设备标签同步）",
      tokenGistNote:
        "注意：GitHub Gist 权限是账号级的（细粒度 token 不能按 gist 隔离）。我们会为同步创建一个专用 secret gist。",
      authenticatedAs: (username) => `已认证为 @${username}。`,
      openVerifiedStars: "打开我的 stars",
      removeToken: "移除 token",
      cachedAccountWarning: (username) =>
        `缓存账号 @${username} 仍在，但当前扩展实例里的 token 已不可用。`,
      clearCachedAuth: "清除缓存认证",
      saveVerify: "保存并验证",
      verifying: "验证中…",
      tokenVerified: (username) => `Token 验证成功，当前登录为 ${username}。已检查同步和 Gist 权限；取消 Star 还需要 Starring read/write。`,
      tokenRemoved: "Token 已移除。",
      tokenStepsTitle: "如何创建 token(fine-grained PAT)",
      tokenStep1:
        "打开 GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。",
      tokenStep2: "Token 名称:随便填(如「stars-manager」)。过期时间:按需选择。",
      tokenStep3:
        "Repository access → 选「All public repositories」(扩展只读你 star 的公开仓库)。",
      tokenStep4:
        "Account permissions → 开启「Starring (read and write)」和「Gists (read and write)」,其余全部关闭。",
      tokenStep5:
        "Generate → 复制 token(以 github_pat_ 开头)→ 粘贴到上面 → 保存并验证。",
      shotNewToken: "截图:「Generate new token」表单",
      shotRepoAccess: "截图:仓库访问设为所有公开仓库",
      shotPermissions:
        "截图:账号权限 —— Starring (read/write) + Gists (read and write)",
      languageLabel: "语言",
      gistHeading: "3. Gist 同步",
      gistBoundPrefix: "已绑定 gist",
      gistBoundSuffix:
        "标签会与该 gist 双向同步；如果同一仓库在两处被改动，较新的改动会生效。",
      gistEmpty: "尚未创建 gist。首次推送标签时会自动创建。",
      gistOpenLink: "在 GitHub 打开这个 gist",
    },
    repoChip: {
      untagged: "未标注",
      filterByTag: (tag) => `按 "${tag}" 筛选 stars`,
      editTags: "编辑标签",
    },
    background: {
      noToken: "未配置 token",
      unknownBackfill: (id) => `未知 backfill：${id}`,
      unsupportedBackfillKind: (kind) => `不支持的 backfill 类型：${kind}`,
      incrementalSyncing: "正在检查新 star 的仓库…",
      incrementalDone: (added) => `新增 ${added} 个`,
      fullDone: (count) => `全量同步完成 · 刷新 ${count} 个仓库`,
      rescanDone: (tombstoned, revived) => `重扫完成 · 移出 ${tombstoned} 个，恢复 ${revived} 个`,
      autoAssignTagging: "正在根据 topics 自动打标签…",
      autoAssignDone: (tagged) => `已自动分配 · 打标 ${tagged} 个`,
      fetchingPages: (total) => `正在获取 ${total} 页…`,
      fetchingPageRetry: (page, attempt) => `正在重试第 ${page} 页（第 ${attempt} 次）…`,
      syncedRepos: (count) => `已同步 ${count} 个仓库`,
      rescanningPages: (total) => `正在重扫 ${total} 页…`,
      reconcilingLocal: (count) => `正在校对本地 ${count} 个仓库…`,
      rescanSummary: (tombstoned, revived) => `重扫结果：移出 live 集合 ${tombstoned} 个，恢复 ${revived} 个`,
      pushingTags: "正在把标签快照上传到 Gist…",
      pullingTags: "正在从 Gist 拉取标签…",
      gistPushDone: (count) => `已向 Gist 推送 ${count} 条变更标签记录`,
      gistPushRecreated: "已创建新的同步 Gist，并上传当前标签快照",
      gistPushNoChanges: "没有需要推送的本地标签变更",
      gistPullDone: (merged, total) =>
        `已从 ${total} 条远端标签记录中合并 ${merged} 条更新`,
      gistPullMissing:
        "已绑定的同步 Gist 不见了；本设备已解绑。你可以点 Push 重新创建。",
    },
    errors: {
      tokenEmpty: "请先粘贴 token。",
      tokenRejected: "GitHub 拒绝了该 token,请确认是否完整复制。",
      tokenStarsForbidden:
        "该 token 能读取个人资料,但缺少「Starring (read/write)」权限,请重新创建并勾选该权限。",
      tokenGistsForbidden:
        "该 token 能读取个人资料,但缺少「Gists (read/write)」权限,请重新创建并勾选该权限。",
      tokenProfileStatus: (status) =>
        `GitHub 在校验你的资料时返回 ${status},请稍后重试。`,
      tokenProfileBadShape:
        "GitHub 返回的个人资料缺少预期的用户名字段。未保存 token,请稍后重试。",
      tokenProfileNetwork: "校验个人资料时无法连接 GitHub,请检查网络后重试。",
      tokenStarsStatus: (status) =>
        `GitHub 在校验 starred 读取权限时返回 ${status},请稍后重试。`,
      tokenStarsNetwork:
        "校验 starred 读取权限时无法连接 GitHub,请检查网络后重试。",
      tokenGistsStatus: (status) =>
        `GitHub 在校验 Gist 权限时返回 ${status},请稍后重试。`,
      tokenGistsNetwork: "校验 Gist 权限时无法连接 GitHub,请检查网络后重试。",
      tokenGistProbeBadShape:
        "GitHub 已创建探针 Gist,但返回内容不符合预期。未保存 token,请重试。",
      tokenGistCleanupStatus: (status) =>
        `GitHub 已创建探针 Gist,但清理失败(${status})。未保存 token,请重试。`,
      tokenGistCleanupNetwork:
        "GitHub 已创建探针 Gist,但无法确认清理是否完成。未保存 token,请重试。",
      ghTokenRejected: "GitHub 拒绝了已保存的 token,请在选项页重新添加。",
      ghRateLimit: "已达到 GitHub 速率限制,请稍候重试。",
      ghForbidden:
        "GitHub 拒绝了请求 (403)。token 可能缺少权限（取消 Star 需要 Starring read/write）或仓库访问权限。设置链接：github.com/settings/tokens。",
      ghTimeout: (page) => `GitHub 响应超时(第 ${page} 页),请稍后重试。`,
      ghNetwork: (detail) => `无法连接 GitHub(${detail}),请检查网络。`,
      ghPageStatus: (status) =>
        `GitHub 返回 ${status}。请重试,或在选项页重新添加 token。`,
      ghNoToken: "未配置 GitHub token,请在选项页添加。",
      ghBadShape: "GitHub 返回了非预期的数据结构,可能需要全量重新同步。",
      gistNoToken: "未配置 Gist 同步所需的 token,请在选项页添加。",
      gistCreateFailed:
        "无法创建同步用 Gist,请确认 token 具有「Gists (read/write)」权限。",
      gistPushFailed:
        "无法写入同步用 Gist,请确认 token 具有「Gists (read/write)」权限。",
      gistPullFailed:
        "无法读取同步用 Gist。它可能已被删除,或 token 缺少「Gists (read)」权限。",
      agentApiKeyEmpty: "测试连接前请先填写 API Key。",
      agentModelEmpty: "测试连接前请先填写模型。",
      agentBaseUrlEmpty: "请先填写这个 AI 服务的 Base URL。",
      agentBaseUrlInvalid:
        "请填写有效的 HTTPS Base URL，或本机 http://localhost 地址。",
      agentHostPermissionDenied:
        "保存或测试前，请先允许插件访问这个 AI 服务。",
      agentProviderUnsupported: "当前还不支持这个 AI 服务。",
      agentProviderTimeout:
        "AI 服务没有及时响应。可以重试，或换一个更小的请求。",
      agentProviderIdentityChanged:
        "测试期间 AI 服务设置已变化。请检查设置后重新测试连接。",
      agentProviderResponseInvalid:
        "AI 服务返回了不兼容的响应。请检查服务设置后重试。",
      agentDataDisclosureRequired:
        "连接前请先查看并接受 Agent 数据共享说明。",
      agentContextCapabilityRequired:
        "AI 服务能力尚未就绪。请检查上下文窗口并测试连接后再使用 Agent 工具。",
      agentContextCapabilityInfeasible:
        "请先在高级设置中增大上下文窗口，再使用 Agent。",
      unknown: (raw) => `出错了:${raw}`,
    },
    onboarding: {
      title: "欢迎使用 Better GitHub Stars Manager",
      noTokenBody: "要管理你的 stars,请先添加一个 GitHub token:",
      createPatLabel: "创建一个 fine-grained PAT",
      openOptions: "打开选项页",
      syncingBody: "正在拉取你的 stars…首次同步完成后列表会自动填充。",
      syncFailedBody: "首次同步失败:",
      retry: "重试同步",
      gotIt: "知道了",
      tooltipSyncFirst:
        "Sync 会拉取你自上次访问以来新 star 的仓库(只需几次请求)。想刷新数据时随时点击。",
      tooltipPushFirst:
        "Push 会把你的标签和笔记备份到一个私有 Gist,跨设备保留。首次推送时自动创建。",
      tooltipPullFirst:
        "Pull 会把 Gist 中的标签和笔记合并到本设备(按仓库、后写覆盖)。在另一台设备编辑后使用。",
      coachTitle: "快速上手",
      coachIntro: "下面是最常用的核心控件。跟着看一遍——本引导只显示一次。",
      coachStep1Title: "同步你的 stars",
      coachStep1Body:
        "Sync 按钮会拉取你自上次访问以来新 star 的仓库。首次加载会自动跑;想刷新随时点它。同步本身不会创建标签。",
      coachStep2Title: "需要时再生成标签",
      coachStep2Body:
        "Auto Tags 会根据已同步仓库的 topics 生成建议标签。只有你点击它时才会打标;Sync 和 Full Sync 都不会改动标签。",
      coachStep3Title: "按标签筛选",
      coachStep3Body:
        "Tags 侧栏列出所有标签，按使用频次排序。点击任意标签(整行)即可筛选列表。鼠标悬停标签会出现删除按钮。",
      coachStep4Title: "打开某个仓库",
      coachStep4Body:
        "点击任意一行打开详情抽屉——在那里编辑标签、写笔记、接受建议标签。",
      coachStep5Title: "隐藏面板",
      coachStep5Body:
        "想暂时用 GitHub 原生 stars 列表?点这里收起悬浮面板——屏幕上会留一个浮动按钮,随时能把面板调回来。",
      coachNext: "下一步",
      coachBack: "上一步",
      coachSkip: "跳过引导",
      coachOf: (current, total) => `第 ${current} 步,共 ${total} 步`,
    },
  },
};

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => Promise<void>;
  m: MessageCatalog;
}

const I18nContext = createContext<I18nValue>({
  locale: "en",
  setLocale: async () => {},
  m: messages.en,
});

export function getMessages(locale: Locale): MessageCatalog {
  return messages[locale] ?? messages.en;
}

export const messageFor = getMessages;

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    if (!hasExtensionStorage()) {
      setLocaleState(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
      return;
    }
    const syncLocale = () => {
      authStore
        .getLocale()
        .then((stored) => setLocaleState(stored))
        .catch(() => {});
    };
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local" || !changes[CONFIG_STORAGE_KEY]) return;
      const oldCfg = changes[CONFIG_STORAGE_KEY].oldValue as Record<string, unknown> | undefined;
      const newCfg = changes[CONFIG_STORAGE_KEY].newValue as Record<string, unknown> | undefined;
      if (oldCfg?.locale === newCfg?.locale) return;
      syncLocale();
    };

    syncLocale();
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const setLocale = async (next: Locale) => {
    setLocaleState(next);
    if (hasExtensionStorage()) await authStore.setLocale(next);
  };

  return (
    <I18nContext.Provider value={{ locale, setLocale, m: getMessages(locale) }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

function hasExtensionStorage(): boolean {
  return typeof chrome !== "undefined"
    && chrome.storage?.onChanged !== undefined;
}
