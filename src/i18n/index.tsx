import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_LOCALE } from "@/preferences";
import type { ManagerRuntime } from '@/runtime/manager-runtime';
import type { Locale, SyncProgress } from "@/types";
import type { RadarPartialReason } from '@/radar/radar-model';

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
    surfaceNavigation: string;
    syncFailed: (label: string, error: string) => string;
    autoAssignDone: (count: number) => string;
    autoAssignFailed: (error: string) => string;
    autoTagAgentPromptTitle: string;
    autoTagAgentPromptBody: string;
    autoTagAgentPromptYes: string;
    autoTagAgentPromptNo: string;
    storeRatingPromptTitle: string;
    storeRatingPromptBody: string;
    storeRatingPromptLinkLabel: (store: string) => string;
    storeRatingPromptStoreNote: (store: string) => string;
    storeRatingPromptLater: string;
    storeRatingPromptNever: string;
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
  watch: {
    starsSurface: string;
    watchSurface: string;
    watchSurfaceUnread: (count: number) => string;
    title: string;
    filterLabel: string;
    searchPlaceholder: string;
    clearSearch: string;
    reasonFilter: string;
    reasonFilterSelected: (count: number) => string;
    reasonFilterClear: string;
    reasonPresets: string;
    reasonPresetAll: string;
    reasonPresetDirect: string;
    reasonPresetSecurity: string;
    reasonPresetParticipation: string;
    reasonPresetWatching: string;
    reasonPresetOther: string;
    reasonThreadCount: (count: number) => string;
    unread: string;
    all: string;
    refresh: string;
    refreshing: string;
    openOptions: string;
    configureMainToken: string;
    configureNotificationsToken: string;
    scopeNeverLoaded: string;
    inboxNeverLoaded: string;
    queryFailed: string;
    refreshFailed: string;
    retry: string;
    scopePermissionDenied: string;
    inboxPermissionDenied: string;
    scopeUnavailable: string;
    noWatchedRepositories: string;
    noUnreadThreads: string;
    noThreads: string;
    noMatchingThreads: string;
    statusFresh: (unread: number, watched: number) => string;
    statusRefreshingSaved: string;
    statusRefreshFailedSaved: string;
    statusCooldown: (time: string) => string;
    statusTruncated: (count: number) => string;
    statusCredential: string;
    statusNeverLoaded: string;
    listEndSnapshot: (count: number) => string;
    listEndMatches: (count: number) => string;
    listEndWindow: string;
    listEndSaved: (count: number) => string;
    staleSnapshot: string;
    credentialStaleSnapshot: string;
    scopeFailed: string;
    inboxFailed: string;
    truncated: string;
    cooldownUntil: (time: string) => string;
    watchedRepositoryCount: (count: number) => string;
    threadCount: (count: number) => string;
    snapshotAt: (time: string) => string;
    manageOnGitHub: string;
    watchedOnGitHub: string;
    repositoryUnreadCount: (count: number) => string;
    openOnGitHub: string;
    unreadSnapshot: string;
    expandRepository: (repository: string) => string;
    collapseRepository: (repository: string) => string;
    markAsRead: string;
    markAsDone: string;
    markAllRead: string;
    markAllDone: string;
    markingRead: string;
    markingDone: string;
    actionReadFailed: string;
    actionDoneFailed: string;
    openSubjectOnGitHub: (subjectType: string) => string;
    threadDetails: string;
    threadReason: string;
    threadUpdated: string;
    threadStatus: string;
    readStatus: string;
    unreadStatus: string;
    subjectDetails: string;
    subjectDetailsLoading: string;
    subjectDetailsUnavailable: string;
    subjectDetailsAuthentication: string;
    subjectDetailsPermission: string;
    subjectStateOpen: string;
    subjectStateClosed: string;
    subjectStateReason: (reason: string) => string;
    subjectAuthor: (login: string) => string;
    subjectCreated: (time: string) => string;
    subjectComments: (count: number) => string;
    subjectLabels: string;
    subjectAssignees: (logins: string) => string;
    subjectMilestone: (title: string) => string;
    subjectNoDescription: string;
    subjectShowDescription: string;
    subjectCollapseDescription: string;
  };
  radar: {
    surface: string;
    surfaceUnseen: (count: number) => string;
    title: string;
    viewLabel: string;
    feed: string;
    projects: string;
    toggleView: string;
    discoverViewLabel: string;
    following: string;
    forYou: string;
    openTrending: string;
    forYouSearchPlaceholder: string;
    clearForYouSearch: string;
    forYouSearchResultCount: (count: number) => string;
    forYouSearchEmpty: (query: string) => string;
    recommendationsOnly: string;
    recommendationsRefreshing: string;
    recommendationsRefreshingSaved: string;
    recommendationsNewBatch: string;
    recommendationsQueryFailed: string;
    recommendationsRefreshFailed: string;
    recommendationsNeverLoadedTitle: string;
    recommendationsNeverLoadedBody: string;
    recommendationsRunFirstScan: string;
    recommendationsEmptyTitle: string;
    recommendationsEmptyBody: string;
    recommendationsStale: string;
    recommendationsCooldownUntil: (time: string) => string;
    recommendationsFreshSummary: (count: number) => string;
    recommendationsSnapshotAt: (time: string) => string;
    recommendationsListEnd: (count: number) => string;
    recommendationsListEndSaved: (count: number) => string;
    becauseYouStarred: (repository: string) => string;
    recommendationReason: (kind: string, value: string) => string;
    recommendationStarAction: string;
    starRecommendation: (repository: string) => string;
    ignoreRecommendation: (repository: string) => string;
    ignoredCount: (count: number) => string;
    recommendationIgnoreHint: string;
    restoreIgnoredAction: string;
    restoreIgnored: (repository: string) => string;
    sourceLabel: string;
    sourceFollowing: string;
    sourceSelf: string;
    sourceFollowingHint: string;
    sourceSelfHint: string;
    refresh: string;
    refreshing: string;
    statusLabel: (status: string) => string;
    openOptions: string;
    retry: string;
    configureMainToken: string;
    neverLoadedTitle: string;
    neverLoadedBody: string;
    runFirstScan: string;
    queryFailed: string;
    refreshFailed: string;
    permissionTitle: string;
    permissionBody: string;
    emptyTitle: string;
    emptyBody: string;
    filteredEmptyTitle: string;
    filteredEmptyBody: string;
    searchPlaceholder: string;
    clearSearch: string;
    searchResultCount: (count: number) => string;
    searchEmpty: (query: string) => string;
    statusRefreshingSaved: string;
    statusRefreshFailedSaved: string;
    statusPartial: string;
    statusCooldown: (time: string) => string;
    statusPermission: string;
    listEndActivities: (count: number) => string;
    listEndProjects: (count: number) => string;
    listEndMatches: (count: number) => string;
    listEndPartial: string;
    listEndSaved: (count: number) => string;
    freshSummary: (activities: number, following: number) => string;
    partialSnapshot: (count: number) => string;
    partialReason: (reason: RadarPartialReason) => string;
    staleSnapshot: string;
    cooldownUntil: (time: string) => string;
    snapshotAt: (time: string) => string;
    publicActivityOnly: string;
    actorStarred: string;
    openActorProfile: (actor: string) => string;
    inLibrary: string;
    followedStars: (count: number) => string;
    latest: string;
    expandProject: (repository: string) => string;
    collapseProject: (repository: string) => string;
    followedStarTimeline: string;
    starredThisRepository: string;
    quickActions: (repository: string) => string;
    projectActions: (repository: string) => string;
    starOnGitHub: string;
    unstarOnGitHub: string;
    favorite: string;
    addTag: string;
    addTagAction: string;
    addingTagStars: string;
    suggestedTags: string;
    repositoryTags: string;
    repositoryTagScope: string;
    noTags: string;
    tagComposerHint: string;
    openRepository: string;
    actionFailed: (error: string) => string;
    keyboardHint: string;
    unseenActivity: string;
    unseenProject: string;
    dismissActivity: (actor: string, repository: string) => string;
    dismissProject: (repository: string) => string;
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
    /** Tooltip for the toolbar product icon link (opens the project repository). */
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
    showRepositoryOwner: string;
    showRepositoryAvatar: string;
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
    hideWhileRunning: string;
    runContinuesWhileHidden: string;
    confirmScopeHeader: string;
    analyzingHeader: (processed: number, total: number) => string;
    analyzingTitle: string;
    analyzingMeta: (processed: number, remaining: number, batches: number) => string;
    frozenScopeNote: (count: number) => string;
    pendingConfirmationNote: (count: number) => string;
    hideAgent: string;
    stop: string;
    pause: string;
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
      controlledElsewhere: string;
      ownerDisconnected: string;
      takeControl: string;
      takingControl: string;
      takeControlFailedOwnerConnected: string;
      takeControlFailedConflict: string;
      takeControlFailedUnavailable: string;
      takeControlFailed: string;
      takeControlSucceeded: string;
      organizeAlreadyRunning: string;
      organizeCommandFailed: string;
      receiptOriginDeleted: string;
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
      reviewLoadFailedBody: string;
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
      receiptLoadFailed: string;
      receiptLoadFailedBody: string;
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
    onlyOwned: string;
    summary: (count: number) => string;
    clearOne: string;
    clearAll: string;
  };
  filterSidebar: {
    specialFilters: string;
    onlyOwnedLabel: string;
    onlyOwnedHint: (username: string) => string;
    onlyOwnedUnavailableHint: string;
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
    fork: string;
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
    notStarred: string;
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
    librarySource: string;
    ownedPublicRepository: string;
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
    storeRatingHeading: string;
    storeRatingManualAction: (store: string) => string;
    storeRatingManualHint: (store: string) => string;
    storeRatingReminderLabel: string;
    storeRatingReminderTracking: string;
    storeRatingReminderSnoozed: (date: string) => string;
    storeRatingReminderDisabled: string;
    storeRatingReminderExhausted: string;
    storeRatingReminderStoreOpened: string;
    storeRatingReminderEnable: string;
    storeRatingReminderDisable: string;
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
    agentDisclosureLocalHistory: string;
    agentDisclosureBuiltInAccess: string;
    agentDisclosureCustomAccess: string;
    agentGrantAccess: string;
    agentAccessGranted: string;
    agentHostAccessRequired: string;
    agentStorageHeading: string;
    agentStorageIntro: string;
    agentStorageOrganizeRetention: string;
    agentStorageRefresh: string;
    agentStorageLoading: string;
    agentStorageDurableData: string;
    agentStorageConversationCount: (sessions: number, messages: number) => string;
    agentStorageToolCache: string;
    agentStorageArtifactCount: (artifacts: number) => string;
    agentStorageLedgerTotal: string;
    agentStorageLogicalLimit: (limit: string) => string;
    agentStorageLedgerUsageLabel: string;
    agentStorageThresholds: (warning: string, limit: string) => string;
    agentStorageBrowserUsage: (usage: string, quota: string) => string;
    agentStorageBrowserUnavailable: string;
    agentStorageWarning: string;
    agentStorageLimitReached: string;
    agentStorageClearHint: string;
    agentStorageClearCache: string;
    agentStorageClearingCache: string;
    agentStorageCacheCleared: (artifacts: number, bytes: string, protectedArtifacts: number) => string;
    agentStorageUnavailable: (error: string) => string;
    agentStorageClearFailed: (error: string) => string;
    agentStorageRetry: string;
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
    tokenWatchingOptional: string;
    tokenFollowersOptional: string;
    tokenIssuesOptional: string;
    tokenGistNote: string;
    authenticatedAs: (username: string) => string;
    openVerifiedStars: string;
    removeToken: string;
    cachedAccountWarning: (username: string) => string;
    clearCachedAuth: string;
    saveVerify: string;
    verifying: string;
    tokenVerified: (username: string) => string;
    tokenVerifiedWatchForbidden: (username: string) => string;
    tokenVerifiedWatchUnverified: (username: string) => string;
    tokenRemoved: string;
    /** Compact PAT walkthrough. */
    tokenStepsTitle: string;
    tokenStep1Title: string;
    tokenStep1: string;
    tokenStep1Alt: string;
    tokenStep2Title: string;
    tokenStep2: string;
    tokenStep2Alt: string;
    tokenStep3Title: string;
    tokenStep3: string;
    tokenStep3Alt: string;
    tokenScopesWarning: string;
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
    watchStatusUnavailable: string;
    watchInboxQueryInvalid: string;
    watchInboxUnavailable: string;
    watchRepositoryInvalid: string;
    watchRepositoryDetailUnavailable: string;
    watchRefreshFailed: string;
    watchDisconnectFailed: string;
    watchDataClearFailed: string;
    watchThreadActionInvalid: string;
    watchThreadActionFailed: string;
    watchSubjectDetailInvalid: string;
    watchSubjectDetailError: (code: string) => string;
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
    /** Step 3 cleanup (DELETE /gists/{id}) — surfaced before persistence. */
    tokenGistCleanupStatus: (status: number | string) => string;
    tokenGistCleanupNetwork: string;
    tokenWatchingForbidden: string;
    tokenWatchingStatus: (status: number | string) => string;
    tokenWatchingNetwork: string;
    tokenWatchingBadShape: string;
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
    agentArtifactCoverageStalled: string;
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
      surfaceNavigation: "Manager surfaces",
      syncFailed: (label, error) => `${label}: ${error}`,
      autoAssignDone: (count) =>
        `Auto Tags added topic-based tags to ${count} repositories`,
      autoAssignFailed: (error) => `Auto Tags failed: ${error}`,
      autoTagAgentPromptTitle: "Let Cubby look first?",
      autoTagAgentPromptBody:
        "Auto Tags adds local tags directly from GitHub topics. Cubby also checks repository details, then waits for you to approve its suggestions.",
      autoTagAgentPromptYes: "Ask Cubby",
      autoTagAgentPromptNo: "Use Auto Tags",
      storeRatingPromptTitle: "Enjoying Better GitHub Stars Manager?",
      storeRatingPromptBody:
        "A quick store rating helps other GitHub users discover the extension.",
      storeRatingPromptLinkLabel: (store) =>
        `Rate Better GitHub Stars Manager in ${store}`,
      storeRatingPromptStoreNote: (store) => `Choose your rating in ${store}.`,
      storeRatingPromptLater: "Later",
      storeRatingPromptNever: "Never remind me",
      deleteTagFailed: (error) => `delete tag: ${error}`,
      deleteAllTagsFailed: (error) => `delete all tags: ${error}`,
      noTokenBanner: "A GitHub Classic PAT is required to load your data.",
      addPat: "Open options and add a Classic PAT",
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
    watch: {
      starsSurface: "Stars",
      watchSurface: "Watch",
      watchSurfaceUnread: (count) => `Watch, ${count} unread ${count === 1 ? "thread" : "threads"}`,
      title: "Watched stars inbox",
      filterLabel: "Inbox thread filter",
      searchPlaceholder: "Search repositories and threads",
      clearSearch: "Clear Watch search",
      reasonFilter: "Notification reasons",
      reasonFilterSelected: (count) => `Notification reasons, ${count} selected`,
      reasonFilterClear: "Clear reasons",
      reasonPresets: "Reason presets",
      reasonPresetAll: "All",
      reasonPresetDirect: "Direct",
      reasonPresetSecurity: "Security",
      reasonPresetParticipation: "Participation",
      reasonPresetWatching: "Watching",
      reasonPresetOther: "Other",
      reasonThreadCount: (count) => `${count} ${count === 1 ? "thread" : "threads"}`,
      unread: "Unread",
      all: "All",
      refresh: "Refresh Watch inbox",
      refreshing: "Refreshing…",
      openOptions: "Open options",
      configureMainToken: "Update the GitHub Classic PAT to load Watch data.",
      configureNotificationsToken: "Open Options and verify the Classic PAT has the notifications scope.",
      scopeNeverLoaded: "Watched-repository membership has not been loaded from GitHub yet.",
      inboxNeverLoaded: "Refresh to load the latest bounded Inbox snapshot for your current Stars.",
      queryFailed: "The Watch snapshot could not be loaded.",
      refreshFailed: "The latest Watch refresh failed; the previous snapshot remains available.",
      retry: "Retry",
      scopePermissionDenied:
        "GitHub could not enumerate watched-repository membership. Inbox threads for current Stars can still load.",
      inboxPermissionDenied:
        "The GitHub Classic PAT cannot read Notifications. Add the notifications scope; other features still work.",
      scopeUnavailable: "Watched-repository membership is unavailable; Inbox threads still use your current Stars.",
      noWatchedRepositories: "GitHub returned no watched-repository membership for the current Stars.",
      noUnreadThreads: "No unread threads for your current Stars in the latest Watch snapshot.",
      noThreads: "No Inbox threads matched your current Stars in this snapshot.",
      credentialStaleSnapshot:
        "The GitHub Classic PAT was rejected or is unavailable, so the last successful Watch snapshot is shown.",
      noMatchingThreads: "No threads match the current Watch search and reason filters.",
      statusFresh: (unread, watched) => `${unread} unread · ${watched} confirmed watched Stars`,
      statusRefreshingSaved: "Refreshing · showing saved rows",
      statusRefreshFailedSaved: "Couldn’t refresh · showing saved rows",
      statusCooldown: (time) => `Refresh available at ${time}`,
      statusTruncated: (count) => `Showing the newest ${count} threads`,
      statusCredential: "Classic PAT authorization required",
      statusNeverLoaded: "Ready to load Watch",
      listEndSnapshot: (count) => `End of current snapshot · ${count} ${count === 1 ? "thread" : "threads"}`,
      listEndMatches: (count) => `End of matching results · ${count} ${count === 1 ? "thread" : "threads"}`,
      listEndWindow: "End of current window · older threads may exist",
      listEndSaved: (count) => `End of saved snapshot · ${count} ${count === 1 ? "thread" : "threads"}`,
      staleSnapshot: "Showing the last successful snapshot because the latest refresh failed.",
      scopeFailed: "Watched-repository membership could not be refreshed; Inbox coverage is unaffected.",
      inboxFailed: "Inbox threads could not be refreshed.",
      truncated: "This is the newest bounded window; more GitHub threads exist beyond it.",
      cooldownUntil: (time) => `GitHub asks clients to wait until ${time} before refreshing again.`,
      watchedRepositoryCount: (count) => `${count} confirmed watched ${count === 1 ? "Star" : "Stars"}`,
      threadCount: (count) => `${count} ${count === 1 ? "thread" : "threads"}`,
      snapshotAt: (time) => `Snapshot checked ${time}`,
      manageOnGitHub: "Manage Watch settings on GitHub",
      watchedOnGitHub: "confirmed watched on GitHub",
      repositoryUnreadCount: (count) => `${count} unread`,
      openOnGitHub: "Open on GitHub",
      unreadSnapshot: "Unread at the time of this snapshot",
      markAsRead: "Mark as read",
      markAsDone: "Mark as done",
      markAllRead: "Mark all as read",
      markAllDone: "Mark all as done",
      markingRead: "Marking as read…",
      markingDone: "Marking as done…",
      actionReadFailed: "Couldn’t mark the selected notifications as read.",
      actionDoneFailed: "Couldn’t mark the selected notifications as done.",
      openSubjectOnGitHub: (subjectType) => `Open ${subjectType} in GitHub`,
      threadDetails: "Notification details",
      threadReason: "Reason",
      threadUpdated: "Updated",
      threadStatus: "Status",
      readStatus: "Read",
      unreadStatus: "Unread",
      subjectDetails: "Issue details",
      subjectDetailsLoading: "Loading issue details…",
      subjectDetailsUnavailable: "Issue details could not be loaded. Notification data is still available.",
      subjectDetailsAuthentication: "The saved GitHub Classic PAT was rejected or expired. Replace it in Options, then retry.",
      subjectDetailsPermission: "The GitHub Classic PAT needs the repo scope and access to this repository.",
      subjectStateOpen: "Open",
      subjectStateClosed: "Closed",
      subjectStateReason: (reason) => `State: ${reason.replace(/_/g, " ")}`,
      subjectAuthor: (login) => `by @${login}`,
      subjectCreated: (time) => `created ${time}`,
      subjectComments: (count) => `${count} ${count === 1 ? "comment" : "comments"}`,
      subjectLabels: "Labels",
      subjectAssignees: (logins) => `Assigned to ${logins}`,
      subjectMilestone: (title) => `Milestone: ${title}`,
      subjectNoDescription: "No description provided.",
      subjectShowDescription: "Show full description",
      subjectCollapseDescription: "Collapse description",
      expandRepository: (repository) => `Expand ${repository}`,
      collapseRepository: (repository) => `Collapse ${repository}`,
    },
    radar: {
      surface: "Following",
      surfaceUnseen: (count) => `Following, ${count} unseen ${count === 1 ? "activity" : "activities"}`,
      title: "Recent stars",
      viewLabel: "Following view",
      feed: "Feed",
      projects: "Projects",
      toggleView: "Switch Following view (V)",
      discoverViewLabel: "Discover view",
      following: "Following",
      forYou: "For You",
      openTrending: "Open GitHub Trending",
      forYouSearchPlaceholder: "Search recommendations",
      clearForYouSearch: "Clear For You search",
      forYouSearchResultCount: (count) => `${count} matching ${count === 1 ? "recommendation" : "recommendations"}`,
      forYouSearchEmpty: (query) => `No recommendations match “${query}”.`,
      recommendationsOnly: "Public repositories · based on your stars",
      recommendationsRefreshing: "Refreshing recommendations…",
      recommendationsRefreshingSaved: "Refreshing · showing saved recommendations",
      recommendationsNewBatch: "New batch",
      recommendationsQueryFailed: "Recommendations could not be loaded.",
      recommendationsRefreshFailed: "The latest refresh failed; saved recommendations remain available.",
      recommendationsNeverLoadedTitle: "For You hasn’t been generated yet",
      recommendationsNeverLoadedBody:
        "Generate a private recommendation list from your current stars and public GitHub Search results.",
      recommendationsRunFirstScan: "Generate recommendations",
      recommendationsEmptyTitle: "No recommendations yet",
      recommendationsEmptyBody:
        "Your current stars did not produce a strong public match. Star more repositories or refresh later.",
      recommendationsStale: "Showing saved recommendations because the latest refresh failed or is stale.",
      recommendationsCooldownUntil: (time) => `GitHub Search rate limit reached. Refresh unlocks at ${time}.`,
      recommendationsFreshSummary: (count) => `${count} ${count === 1 ? "recommendation" : "recommendations"}`,
      recommendationsSnapshotAt: (time) => `Recommendations checked ${time}`,
      recommendationsListEnd: (count) => `End of recommendations · ${count}`,
      recommendationsListEndSaved: (count) => `End of saved recommendations · ${count}`,
      becauseYouStarred: (repository) => `Because you starred ${repository}`,
      recommendationReason: (kind, value) => ({
        topic: `shared topic · ${value}`,
        language: `same language · ${value}`,
        owner: `same owner · ${value}`,
        name: `related repository name · ${value}`,
      } as Record<string, string>)[kind] ?? value,
      recommendationStarAction: "Star",
      starRecommendation: (repository) => `Star ${repository} on GitHub`,
      ignoreRecommendation: (repository) => `Never recommend ${repository} again`,
      ignoredCount: (count) => `${count} ignored ${count === 1 ? "repository" : "repositories"}`,
      recommendationIgnoreHint: "Never show this repository in my recommendations again",
      restoreIgnoredAction: "Restore",
      restoreIgnored: (repository) => `Recommend ${repository} again`,
      sourceLabel: "Activity sources",
      sourceFollowing: "Following",
      sourceSelf: "Me",
      sourceFollowingHint: "Stars from people you follow",
      sourceSelfHint: "Your own stars",
      refresh: "Refresh",
      refreshing: "Scanning…",
      statusLabel: (status) => ({
        partial: "Partial",
        stale: "Stale",
        cooldown: "Cooldown",
        error: "Error",
      } as Record<string, string>)[status] ?? status,
      openOptions: "Open options",
      retry: "Retry",
      configureMainToken:
        "Add the read:user scope to the GitHub Classic PAT so Following can read the accounts you follow.",
      neverLoadedTitle: "Following hasn’t been scanned yet",
      neverLoadedBody:
        "Scan recent public stars from accounts you follow. Nothing has been scanned so far.",
      runFirstScan: "Run first scan",
      queryFailed: "Following activity could not be loaded.",
      refreshFailed: "The latest scan failed; the previous snapshot remains available.",
      permissionTitle: "GitHub Classic PAT authorization required",
      permissionBody:
        "Following Radar needs the read:user scope on the GitHub Classic PAT. Stars, tags, Gist, and sync are unaffected.",
      emptyTitle: "No recent stars",
      emptyBody: "No star activity was found in the last 30 days.",
      filteredEmptyTitle: "No activity from selected sources",
      filteredEmptyBody: "Adjust Following and Me to show recent stars from the last 30 days.",
      searchPlaceholder: "Search people or repositories",
      clearSearch: "Clear Following search",
      searchResultCount: (count) => `${count} matching ${count === 1 ? "activity" : "activities"}`,
      searchEmpty: (query) => `No people or repositories match “${query}”.`,
      statusRefreshingSaved: "Scanning · showing saved activity",
      statusRefreshFailedSaved: "Couldn’t scan · showing saved activity",
      statusPartial: "Partial results · some activity may be missing",
      statusCooldown: (time) => `Scan available at ${time}`,
      statusPermission: "Following needs access to your following graph",
      listEndActivities: (count) => `End of 30-day window · ${count} ${count === 1 ? "activity" : "activities"}`,
      listEndProjects: (count) => `End of 30-day window · ${count} ${count === 1 ? "project" : "projects"}`,
      listEndMatches: (count) => `End of matching results · ${count}`,
      listEndPartial: "End of fetched results · some activity may be missing",
      listEndSaved: (count) => `End of saved activity · ${count} ${count === 1 ? "item" : "items"}`,
      freshSummary: (activities, following) => `${activities} activities · ${following} following`,
      partialSnapshot: (count) =>
        `Partial snapshot — ${count} known ${count === 1 ? "gap" : "gaps"}`,
      partialReason: (reason) => ({
        github_star_list_truncated: "Some accounts could not be paged to the end of the 30-day window.",
        private_activity_omitted: "Private followed-star activity was omitted.",
        following_scan_truncated: "Not every followed account could be scanned.",
      })[reason],
      staleSnapshot: "Showing the last successful snapshot because the latest scan failed or is stale.",
      cooldownUntil: (time) => `GitHub rate limit reached. Scanning unlocks at ${time}.`,
      snapshotAt: (time) => `Snapshot checked ${time}`,
      publicActivityOnly: "Public stars · last 30 days",
      actorStarred: "starred",
      openActorProfile: (actor) => `Open @${actor} on GitHub`,
      inLibrary: "in your library",
      followedStars: (count) => `${count} followed ${count === 1 ? "star" : "stars"}`,
      latest: "latest",
      expandProject: (repository) => `Show details for ${repository}`,
      collapseProject: (repository) => `Hide details for ${repository}`,
      followedStarTimeline: "Followed-star timeline",
      starredThisRepository: "starred this repository",
      quickActions: (repository) => `Quick actions for ${repository}`,
      projectActions: (repository) => `Repository actions for ${repository}`,
      starOnGitHub: "Star on GitHub",
      unstarOnGitHub: "Unstar on GitHub",
      favorite: "Favorite",
      addTag: "Add tag…",
      addTagAction: "Add tag",
      addingTagStars: "Adding a tag stars this repository first",
      suggestedTags: "Suggested tags",
      repositoryTags: "Tags on this repository",
      repositoryTagScope: "Shared by every Feed entry for this repository.",
      noTags: "No tags yet.",
      tagComposerHint: "Enter to apply · Esc to close",
      openRepository: "Open repository",
      actionFailed: (error) => `Action failed: ${error}`,
      keyboardHint: "↑↓ navigate · Enter apply · Esc close",
      unseenActivity: "Unseen activity",
      unseenProject: "Project has unseen activity",
      dismissActivity: (actor, repository) => `Dismiss activity: ${actor} starred ${repository}`,
      dismissProject: (repository) => `Dismiss ${repository} from Following`,
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
      fullSyncTitle: "Re-fetch all stars and every public repository you own",
      fullSyncButton: "Full Sync",
      themeTitle: "Toggle black/white theme",
      githubHomeTitle: "GitHub home",
      hidePanelTitle: "Hide panel (use native stars list)",
      starRepoTitle: "Open the project repository",
      autoAssignTitle:
        "Add local tags from synced GitHub topics",
      autoAssignButton: "Auto Tags",
      agentTitle: "Open Cubby, your AI library assistant",
      agentButton: "Cubby",
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
      showRepositoryOwner: "Show repository owner",
      showRepositoryAvatar: "Show repository avatar",
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
      hideWhileRunning: "Hide Cubby",
      runContinuesWhileHidden: "You can hide this panel; the turn continues.",
      confirmScopeHeader: "Confirm scope",
      analyzingHeader: (processed, total) => `Analyzing · ${processed}/${total}`,
      analyzingTitle: "Analyzing locked scope",
      analyzingMeta: (processed, remaining, batches) => (
        `${processed} processed · ${remaining} remaining · ${batches} batch${batches === 1 ? '' : 'es'}`
      ),
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
      applyingTitle: "Applying selected changes",
      applyingSubtitle: "Manual tags · scope remains locked",
      applyingMeta: (done, total) => `${done} of ${total} changes applied · selection locked`,
      applyingButton: "Applying…",
      applyingStopbar: "Pause after the current repository finishes.",
      composerPausedApplying: "Composer paused while applying",
      budgetExhaustedHeader: "Run limit reached",
      budgetExhaustedTitle: (reason) => `Run limit reached · ${reason}`,
      budgetExhaustedSubtitle: (processed, total) => `Processed ${processed} / ${total} · remaining were not auto-continued`,
      budgetExhaustedBody: "Remaining repositories were not processed automatically. Continue to start a new analysis for them.",
      continueRemainingCount: (count) => `Continue remaining ${count}`,
      nothingToAnalyzeHeader: "Nothing to analyze",
      nothingToAnalyzeTitle: "Nothing to analyze",
      nothingToAnalyzeBody: "Either every visible repo already has tags, or the active filters hide the candidates. Change filters or broaden scope, then ask again.",
      emptyScopeCount: "0 repositories match this scope.",
      handoffHeader: "Handoff · still untagged",
      handoffTitle: "From Auto Tags",
      handoffSubtitle: (count) => `Auto Tags finished · ${count} still untagged`,
      handoffBody: "Auto Tags added local tags from GitHub topics. Cubby will review only the remaining untagged repositories and won't overwrite those results unless you apply manual tags.",
      handoffAsk: (count) => `Auto Tags left ${count} repositories untagged. I can take a closer look and suggest careful manual tags. Want me to?`,
      handoffOrganize: (count) => `Organize these ${count}`,
      handoffAmbiguous: "Only show the ambiguous ones",
      handoffExamples: "Explain a few examples first",
      handoffScopeNote: (count) => (
        count === 1
          ? "Still untagged after Auto Tags · 1 repository"
          : `Still untagged after Auto Tags · ${count} repositories`
      ),
      partialReceiptHeader: "Applied with conflicts",
      resolvingScopeHeader: "Resolving scope…",
      resolvingScopeBody: "I'm locking the repository selection so later filter changes won't affect this analysis.",
      resolvingScopeMeta: "No tags change during this step",
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
      providerAuthSubtitle: "API key rejected or Chrome access missing",
      providerAuthBody: "Cubby couldn't reach your configured AI service. Your message and scope are saved, and no secrets are shown here.",
      providerAuthOpenOptions: "Open options",
      providerAuthRetry: "Retry after updating settings",
      completedNoChangesHeader: "Completed · no changes",
      completedNoChangesTitle: "Completed · no changes",
      completedNoChangesSubtitle: (inspected) => `No tag changes suggested · ${inspected} inspected`,
      completedNoChangesBody: "Everything already has a clear place, or there wasn't enough evidence for a safe manual tag. Nothing to apply.",
      unknownOutcomeComposer: "Couldn't confirm the result · you can continue chatting",
      applyTerminalUnknownComposer: "Couldn't confirm the result · you can continue chatting",
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
        "I'll use your configured AI service and only the tools allowed for this request.",
      toolResult: "Tool result",
      emptyAgentMessage: "No response returned.",
      chatSuggestionsReady: (count) => `I found ${count} tag suggestions. Review them below before applying.`,
      chatNoSuggestions: "I couldn't find any new tag suggestions in the current local data.",
      chatLimitedCapability:
        "I'm here to help organize your stars with the configured AI service.",
      reasoningSuggestTags:
        "I'll inspect local repository topics and existing tags, skip excluded tags, and prepare conservative tag suggestions.",
      reasoningStreaming: "Cubby is looking into it…",
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
      closeTitle: "Close Cubby",
      suggestTags: "Organize untagged here",
      agentSettings: "Cubby settings",
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
      needsReviewFollowUp: "Needs review · answering follow-up",
      needsReviewSelected: (count) => `Needs review · ${count} selected`,
      appliedTagChanges: (count) => `Applied ${count} tag ${count === 1 ? "change" : "changes"}`,
      followUpAboutScope: "Ask a follow-up about this scope",
      askingAboutCurrentViewUnknown: "Current view",
      handoffAutoTagsUpdated: "Auto Tags already updated topic-based auto tags.",
      agentActivityLabel: "Cubby activity",
      workbench: {
        controlledElsewhere: "This run is controlled from another Cubby page. This page is read-only.",
        ownerDisconnected: "The page controlling this run disconnected. Take control here to keep managing it.",
        takeControl: "Take control",
        takingControl: "Taking control…",
        takeControlFailedOwnerConnected: "The controlling page reconnected, so this page stays read-only.",
        takeControlFailedConflict: "This run changed while taking control. Try again.",
        takeControlFailedUnavailable: "This run is no longer available.",
        takeControlFailed: "Could not take control. Try again.",
        takeControlSucceeded: "You now control this run.",
        organizeAlreadyRunning: "An Organize run is already in progress. Wait for it to finish, or dismiss its result before starting another.",
        organizeCommandFailed: "Cubby couldn't update this Organize run. Refresh its latest state and try again.",
        receiptOriginDeleted: "Started from a conversation that has been deleted.",
        resolvingSubtitle: "Preparing your starred library",
        resolvingBody: "This analysis includes every currently starred repository. Filters and the selected row won't narrow the scope.",
        resolvingHint: "No tags change during this step",
        confirmScopeTitle: "Confirm analysis scope",
        repositoriesFrozen: (count) => `This analysis will include ${count} repositories.`,
        reviewBeforeApply: "Analysis prepares a complete review first. No tags are changed at this step.",
        startAnalysis: "Start analysis",
        startingAnalysis: "Starting analysis",
        analysisScopeIncomplete: "The saved analysis scope is incomplete. Prepare it again.",
        nothingToAnalyzeBody: "Either every visible repo already has tags, or the active filters hide the candidates. Change filters or broaden scope, then ask again.",
        dismiss: "Dismiss",
        confirmRequestedScope: "Confirm requested scope",
        candidateRepositories: (count) => `${count} candidate repositories.`,
        continue: "Continue",
        analyzingFrozenScope: "Analyzing locked scope",
        progressSummary: (processed, remaining) => `${processed} analyzed · ${remaining} remaining`,
        runProgressLabel: "Analysis progress",
        processed: "Processed",
        remaining: "Remaining",
        batches: "Batches",
        providerAttempts: "AI requests",
        analysisBlockedTitle: "Analysis paused before completion",
        analysisCoverage: (processed, total) => `${processed} of ${total} repositories analyzed`,
        analysisBlockedBody: (failed) => failed > 0
          ? `${failed} ${failed === 1 ? "repository" : "repositories"} could not be analyzed. No partial suggestions are shown or applied. Continue the failed items or restart the full-library analysis to produce one complete review.`
          : "No partial suggestions are shown or applied. Continue the remaining items or restart the full-library analysis to produce one complete review.",
        restartWholeLibrary: "Restart full-library analysis",
        discardAnalysis: "Discard this analysis",
        runStateRefreshed: "The saved analysis state changed. Its latest progress has been restored; try continuing again or restart the full-library analysis.",
        analysisReady: "Analysis ready",
        preparedReady: "The selected scope is prepared.",
        preparedPaused: "The selected scope is ready and will start after the current analysis stops.",
        budgetExhausted: (reason) => `Run limit reached · ${reason}`,
        budgetSubtitle: (processed, total) => `Processed ${processed} / ${total} · remaining were not auto-continued`,
        budgetProgress: (processed, remaining, attempts) => `${processed} processed · ${remaining} remaining · ${attempts} AI requests used`,
        budgetBody: "Remaining repositories were not processed automatically. Continue to start a new analysis for them.",
        continueRemainingCount: (count) => `Continue remaining ${count}`,
        moreRemain: "More repositories remain",
        moreRemainBody: "The current review is settled. Remaining repositories were not processed automatically.",
        continueCreatesRun: "Continuing starts a new analysis for the remaining repositories.",
        continueRemaining: "Continue remaining",
        proposalSummary: (actionable, nonActionable) => `Cubby found ${actionable} tag suggestions. ${nonActionable} repositories need no changes or lack enough evidence.`,
        proposalSelectionNote: "Only selected suggestions will become manual tags.",
        reviewSuggestions: "Review tag suggestions",
        reviewCoverageComplete: (count) => `Full library covered · ${count} repositories analyzed`,
        reviewLoadFailedBody: "The analysis is complete, but its suggestions could not be loaded. Retry without rerunning the analysis.",
        proposalCounts: (actionable, nonActionable, selected) => `${actionable} suggestions · ${nonActionable} no change · ${selected} selected`,
        finishReviewFirst: "More repositories remain. Finish this review before continuing.",
        selectRepository: (repositoryId) => `Select ${repositoryId}`,
        applyingSelectedChanges: "Applying selected changes",
        selectedRowsLocked: (count) => `${count} selected · selection locked`,
        applying: "Applying…",
        applySelected: (count) => `Apply ${count} selected`,
        applyTagImpact: (tags, repositories) => `Apply ${tags} ${tags === 1 ? 'tag' : 'tags'} to ${repositories} ${repositories === 1 ? 'repository' : 'repositories'}`,
        selectAll: "Select all",
        clear: "Clear",
        previousPage: "Previous page",
        nextPage: "Next page",
        reviewPageRange: (start, end, total) => `${start}-${end} of ${total}`,
        applyingSubtitle: "Manual tags · scope remains locked",
        rowsSelectedLocked: (selected, total) => `${selected} of ${total} selected · selection locked`,
        receiptPartial: (changed, skipped, failed) => `${changed} applied. ${skipped} skipped. ${failed} no longer met the required conditions and were left unchanged.`,
        receiptSingle: "Applied the selected suggestion as a manual tag. Nothing was pushed to Gist.",
        receiptComplete: (changed) => `Applied ${changed} selected suggestions as manual tags. Nothing was pushed to Gist.`,
        mutationReceipt: "Tag update results",
        receiptSubtitle: "Final result · local manual tags · Gist not pushed",
        receiptCountsLabel: "Result totals",
        changed: "Changed",
        skipped: "Skipped",
        failed: "Failed",
        unchanged: "Unchanged",
        receiptCountSummary: (changed, skipped, failed) => `${changed} changed · ${skipped} skipped · ${failed} failed`,
        unchangedCount: (count) => `${count} unchanged`,
        receiptRowsLabel: "Result details",
        receiptLoadFailed: "Could not load result details",
        receiptLoadFailedBody: "The tag updates are complete. Retry loading the details, or dismiss these results.",
        viewAllRows: "View all results",
        viewFailedChanged: "View failed & changed",
        viewChanged: "View changed",
        connectionInterrupted: "Cubby connection was interrupted. Reconnecting…",
        workerLost: "The extension restarted, so this analysis can no longer continue. Start a new analysis.",
        timelineLabel: (state) => ({
          preflight: "Preparing scope",
          frozen: "Scope locked",
          prepared: "Analysis ready",
          checking_provider: "Checking AI service",
          analyzing: "Analyzing",
          review: "Ready for review",
          applying: "Applying",
          completed: "Completed",
          budget_exhausted: "Run limit reached",
          cancelled: "Cancelled",
          failed: "Failed",
          interrupted: "Interrupted",
        }[state] ?? state.replaceAll("_", " ")),
        runStepsLabel: "Cubby analysis steps",
        runStepScope: "Scope",
        runStepAnalyze: "Analyze",
        runStepReview: "Review",
        runStepApply: "Apply",
        runStepReceipt: "Results",
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
        reviewEditInvalidNormalized: "This tag contains unsupported character variants.",
        reviewEditInvalidDuplicate: "Tag duplicates another action on this row.",
        reviewEditInvalidTooLong: "Tag is too long.",
        reviewCorrectedTo: (tag) => `Corrected to ${tag}`,
        reviewNeedsReanalysis: "Needs re-analysis before apply",
        reviewAskRevise: "Ask to revise",
        reviewReviseRejected: (count) => `Ask to revise rejected (${count})`,
        reviewReviseRejectedPrompt: (details) => `Revise this tag review before any apply. Keep the frozen scope unchanged, skip rejected rows, and re-analyze only the corrected intent. Rejections/corrections:\n${details}`,
        reviewEditCorrectionPrompt: (repositoryId, fromTag, toTag) => `For ${repositoryId}, do not apply the reviewed tag "${fromTag}". Re-analyze that repository with the corrected tag intent "${toTag}" and return a fresh review row before any apply.`,
        reviewRejectCorrectionPrompt: (repositoryId, reason) => `For ${repositoryId}, reject the current suggestion (${reason}). Re-analyze that repository with this correction in mind and return a fresh review row before any apply.`,
        reviewLocalOnlyNote: "Edits and rejections stay in this review. Only selected suggestions are applied.",
      },
    },
    activeFilters: {
      onlyFavorite: "Favorites",
      onlyUntagged: "Untagged only",
      onlyArchived: "Archived",
      onlyOwned: "My repositories",
      summary: (count) => `${count} results · filtered`,
      clearOne: "Remove this filter",
      clearAll: "Clear all filters",
    },
    filterSidebar: {
      specialFilters: "Special Filters",
      onlyOwnedLabel: "My public repositories",
      onlyOwnedHint: (username) => `All public repositories owned by @${username}, including unstarred repositories`,
      onlyOwnedUnavailableHint: "GitHub account required",
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
      fork: "Fork",
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
      notStarred: "Owned public repository · not starred",
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
      librarySource: "Library source",
      ownedPublicRepository: "Owned public repository",
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
      noToken: "A GitHub Classic PAT is required.",
      addPat: "Add Classic PAT",
      idle: "Idle",
      syncIncremental: "Sync new stars (incremental)",
      syncFull: "Full re-pull all stars",
      reconcile: "Reconcile stars",
      gistPull: "Pull tags from Gist",
      gistPush: "Push tags to Gist",
      testConnection: "Test Classic PAT",
      debugState: "Debug extension state",
      openStars: "Open my stars page",
      options: "Options…",
      starRepoTitle: "Like the project? Leave a star:)",
      testing: "Testing Classic PAT…",
      rate: (remaining, limit) => `rate: ${remaining}/${limit} remaining`,
      scopes: (scopes) => `scopes: ${scopes ?? "not reported — use a Classic PAT"}`,
      itemsOnPage: (count) => `items on page 1: ${count}`,
      sample: (sample) => `sample: ${sample ?? "—"}`,
      connectionOk: "OK — Classic PAT verified",
      connectionNoContent:
        "204 No Content — the Classic PAT may lack starred-repository access",
      connectionRejected: "401 — Classic PAT rejected or expired",
      connectionForbidden: "403 — Classic PAT lacks required scopes or repository access",
      failed: (label, error) => `${label} failed: ${error}`,
    },
    options: {
      title: "Better GitHub Stars Manager — Options",
      starRepoButton: "Like the project? Leave a star:)",
      storeRatingHeading: "Store rating",
      storeRatingManualAction: (store) => `Rate in ${store}`,
      storeRatingManualHint: (store) =>
        `Opens the verified Better GitHub Stars Manager listing in ${store}.`,
      storeRatingReminderLabel: "Automatic rating reminder",
      storeRatingReminderTracking: "Enabled",
      storeRatingReminderSnoozed: (date) => `Paused until ${date}`,
      storeRatingReminderDisabled: "Disabled",
      storeRatingReminderExhausted: "Finished after two reminders",
      storeRatingReminderStoreOpened: "Disabled after opening the store",
      storeRatingReminderEnable: "Enable reminders",
      storeRatingReminderDisable: "Disable reminders",
      agentHeading: "2. Cubby",
      agentIntro:
        "Connect an AI service. Cubby sends requests directly to it and shows the results in the extension.",
      agentServiceLabel: "AI service",
      agentServiceHint: "Choose the AI service Cubby uses.",
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
      agentApiKeyPlaceholder: "Paste an API key",
      agentSavedKeyHint:
        "A saved key is already on this device. Leave this blank to keep using it.",
      agentSave: "Save & test",
      agentSaving: "Saving and testing…",
      agentSavedAndTested: (provider, model, latencyMs) =>
        `Saved · Connected to ${provider} · ${model} (${latencyMs} ms)`,
      agentSavedTestFailed: (error) =>
        `Settings saved, but the connection test failed: ${error}`,
      agentSavedNeedsHostAccess:
        "Settings saved. Allow Chrome access, then test the connection.",
      agentTest: "Test connection",
      agentTesting: "Testing…",
      agentTestOk: (provider, model, latencyMs) =>
        `Connected to ${provider} · ${model} (${latencyMs} ms)`,
      agentRemoveKey: "Remove saved key",
      agentKeyRemoved: "Saved AI service key removed.",
      agentDisclosureHeading: "Data shared with your AI service",
      agentDisclosureIntro: (provider, origin) =>
        `${provider} · ${origin} · direct connection`,
      agentDisclosureSentHeading: "Sent when needed",
      agentDisclosureSentPrompt: "Your prompt, scoped public repository metadata, and visible tags",
      agentDisclosureSentCode: "Code snippets or private notes only when you ask Cubby to use them",
      agentDisclosureSentProtocol: "Tool definitions, limited tool results, interaction choices, and conversation summaries",
      agentDisclosureNotSentHeading: "Never included as model input",
      agentDisclosureNotSentSecrets: "GitHub token, API keys, other credentials, or repositories outside the active scope",
      agentDisclosureKeyException:
        "The AI service API key is sent only to the exact address above in the provider-required authentication header, including Anthropic's x-api-key. It is never included in prompts or logs.",
      agentDisclosureLocalHistory:
        "Committed conversation history, recent attempt rows that include the admitted prompt, bounded continuation-recovery projections, and paged artifacts may be stored unencrypted in this browser's extension storage. They are not synced, exported, or included in release diagnostics. Deleting a conversation removes its transcript, attempt and recovery data, and conversation-owned artifacts; re-fetchable tool cache can also be cleared separately. Unpacked development builds disclose raw capture separately before it can be enabled.",
      agentDisclosureBuiltInAccess:
        "This service is covered by the extension's built-in Chrome access.",
      agentDisclosureCustomAccess:
        "Custom services also require separate Chrome access.",
      agentGrantAccess: "Allow access",
      agentAccessGranted: "Access allowed",
      agentHostAccessRequired: "Allow Chrome access to test or use this custom service.",
      agentStorageHeading: "Local Cubby conversation, recovery & artifact ledger",
      agentStorageIntro:
        "This ledger covers conversation transcripts, attempt and recovery state, saved conversation artifacts, and re-fetchable tool cache on this device. It does not represent all Cubby or extension storage.",
      agentStorageOrganizeRetention:
        "Organize data is separate and bounded: active or preflight task instructions and frozen scope, proposal, Apply, and receipt records, plus one latest completed or cancelled result. None is counted in this ledger. Deleting the origin conversation keeps that latest result until you dismiss it or a new Organize run replaces it.",
      agentStorageRefresh: "Refresh storage usage",
      agentStorageLoading: "Checking Agent storage…",
      agentStorageDurableData: "Conversation, recovery & saved artifacts",
      agentStorageConversationCount: (sessions, messages) =>
        `${sessions} conversation${sessions === 1 ? "" : "s"} · ${messages} message${messages === 1 ? "" : "s"}`,
      agentStorageToolCache: "Re-fetchable tool cache",
      agentStorageArtifactCount: (artifacts) =>
        `${artifacts} cached tool artifact${artifacts === 1 ? "" : "s"}`,
      agentStorageLedgerTotal: "Conversation, recovery & artifact ledger total",
      agentStorageLogicalLimit: (limit) => `${limit} ledger limit`,
      agentStorageLedgerUsageLabel: "Conversation, recovery, and artifact ledger used",
      agentStorageThresholds: (warning, limit) =>
        `This ledger only: warning at ${warning} · new ledger writes refused at ${limit}`,
      agentStorageBrowserUsage: (usage, quota) =>
        `Whole-extension browser storage estimate: ${usage} of ${quota}`,
      agentStorageBrowserUnavailable: "Whole-extension browser storage estimate unavailable",
      agentStorageWarning:
        "This ledger is above its warning level; other Cubby and extension storage is outside this threshold. Clear the re-fetchable tool cache before storage-heavy work.",
      agentStorageLimitReached:
        "This ledger reached its local limit. New ledger data is refused until space is available; other Cubby and extension storage is outside this threshold.",
      agentStorageClearHint:
        "Clears only re-fetchable tool cache. Final answers and conversation transcripts, attempt and recovery state, and saved conversation artifacts remain.",
      agentStorageClearCache: "Clear tool cache",
      agentStorageClearingCache: "Clearing tool cache…",
      agentStorageCacheCleared: (artifacts, bytes, protectedArtifacts) =>
        `Cleared ${artifacts} cached tool artifact${artifacts === 1 ? "" : "s"} and freed ${bytes}.${protectedArtifacts > 0 ? ` Kept ${protectedArtifacts} active or referenced artifact${protectedArtifacts === 1 ? "" : "s"}.` : ""}`,
      agentStorageUnavailable: (error) => `Cubby ledger usage is unavailable: ${error}`,
      agentStorageClearFailed: (error) => `Tool cache could not be cleared: ${error}`,
      agentStorageRetry: "Try again",
      behaviorHeading: "4. Preferences",
      maxTagsPerRepoLabel: "Max automatic tags per repo",
      maxTagsPerRepoHint:
        "Auto Tags uses this limit. In Chat, Cubby may add at most this many tags to a repository per turn; Organize uses the lower of this value and its 5-tag safety cap.",
      minTopicRepoCountLabel: "Minimum shared tag coverage",
      minTopicRepoCountHint:
        "Cubby Chat assigns a tag only when the target brings its topic-or-visible-tag coverage to this many live repositories. Organize uses proposal-wide coverage; Auto Tags applies the same threshold to topics.",
      starsPanelDefaultLabel: "Open my stars page with the manager panel by default",
      starsPanelDefaultHint:
        "Turn this off to show GitHub's native stars list first; the floating button can reopen the manager.",
      tokenHeading: "1. GitHub Classic PAT",
      tokenIntroPrefix: "Create the single GitHub token used by Stars, Gist, Watch, and Following:",
      tokenLinkLabel: "open the prefilled classic token form",
      tokenIntroSuffix: "Review the scopes before generating it.",
      tokenPublicRepos: "Required · repo · Stars, repository access, and Issue/PR details",
      tokenGists: "Required · gist · cross-device annotation sync",
      tokenWatchingOptional: "Optional · notifications · Watch Inbox reads and actions",
      tokenIssuesOptional: "repo also covers private Issue/PR details you can access.",
      tokenFollowersOptional: "Optional · read:user · Following Radar",
      tokenGistNote:
        "gist applies to the whole account. The extension creates a private Gist for annotation sync.",
      authenticatedAs: (username) => `Classic PAT authenticated as @${username}.`,
      openVerifiedStars: "Open my stars",
      removeToken: "Remove Classic PAT",
      cachedAccountWarning: (username) =>
        `This app requires a GitHub Classic PAT. Add and verify one below; local data for @${username} is preserved.`,
      clearCachedAuth: "Clear saved account",
      saveVerify: "Save & verify",
      verifying: "Verifying…",
      tokenVerified: (username) => `Classic PAT verified for @${username}. Stars, Gist, and Watch are ready.`,
      tokenVerifiedWatchForbidden: (username) => `Classic PAT verified for @${username}. Stars and Gist are ready; add notifications to use Watch.`,
      tokenVerifiedWatchUnverified: (username) => `Classic PAT verified for @${username}. Stars and Gist are ready, but Notifications access could not be checked.`,
      tokenRemoved: "GitHub Classic PAT removed.",
      tokenStepsTitle: "Token setup",
      tokenStep1Title: "Set the expiration",
      tokenStep1: "Open the prefilled form, keep the Note, and choose a finite expiration.",
      tokenStep1Alt: "Classic PAT Note, expiration, and repo scope",
      tokenStep2Title: "Check the scopes",
      tokenStep2: "Keep repo, gist, notifications, and read:user selected. Leave user unselected.",
      tokenStep2Alt: "gist, notifications, and read:user selected; user unselected",
      tokenStep3Title: "Generate and save",
      tokenStep3: "Generate the token, copy it, paste it below, then select Save & verify.",
      tokenStep3Alt: "GitHub Generate token button",
      tokenScopesWarning: "GitHub shows the token once. Keep it private.",
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
      autoAssignTagging: "Adding local tags from repository topics…",
      autoAssignDone: (tagged) => `Auto Tags complete · ${tagged} repositories tagged`,
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
      watchStatusUnavailable: "Watch status is unavailable.",
      watchInboxQueryInvalid: "Invalid Watch inbox query.",
      watchInboxUnavailable: "Watch inbox is unavailable.",
      watchRepositoryInvalid: "Invalid Watch repository.",
      watchRepositoryDetailUnavailable: "Watch repository detail is unavailable.",
      watchRefreshFailed: "Watch refresh failed.",
      watchDisconnectFailed: "Watch Inbox disconnect failed.",
      watchDataClearFailed: "Watch data could not be cleared.",
      watchThreadActionInvalid: "Invalid Watch notification selection.",
      watchThreadActionFailed: "The Watch notification action failed.",
      watchSubjectDetailInvalid: "Invalid Watch notification detail request.",
      watchSubjectDetailError: (code) => {
        switch (code) {
          case "authentication_required":
          case "permission_denied":
            return "The main GitHub token cannot read this Issue or Pull Request. Add Issues: read and repository access.";
          case "subject_not_found":
            return "This Issue or Pull Request is unavailable.";
          case "rate_limited":
            return "GitHub rate-limited this detail request. Retry later.";
          case "credential_changed":
            return "The GitHub connection changed while details were loading. Retry.";
          default:
            return "Issue details could not be loaded. Notification data is still available.";
        }
      },
    },
    errors: {
      tokenEmpty: "Paste a GitHub Classic PAT first.",
      tokenRejected:
        "GitHub rejected this Classic PAT. It may be expired, revoked, or incomplete; create or paste a valid Classic PAT.",
      tokenStarsForbidden:
        "This Classic PAT cannot access Stars. Re-create it with the repo scope.",
      tokenGistsForbidden:
        "This Classic PAT cannot write Gists. Re-create it with the gist scope.",
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
      tokenWatchingForbidden: "The token was saved, but Watch Inbox needs the notifications scope.",
      tokenWatchingStatus: (status) => `GitHub returned ${status} while checking Notifications access.`,
      tokenWatchingNetwork: "The token was saved, but Notifications access could not be checked.",
      tokenWatchingBadShape: "GitHub returned an unexpected Notifications response.",
      ghTokenRejected: "The saved GitHub Classic PAT was rejected or expired. Replace it in Options.",
      ghRateLimit: "GitHub rate limit reached. Wait a minute and retry.",
      ghForbidden:
        "GitHub refused the request (403). Check the Classic PAT scopes and repository access in Options.",
      ghTimeout: (page) =>
        `GitHub took too long to respond (page ${page}). Retry shortly.`,
      ghNetwork: (detail) =>
        `Could not reach GitHub (${detail}). Check your connection.`,
      ghPageStatus: (status) =>
        `GitHub returned ${status}. Retry, or replace the Classic PAT in Options.`,
      ghNoToken: "A GitHub Classic PAT is required. Add one in Options.",
      ghBadShape:
        "GitHub returned an unexpected data shape. Pull may need a full re-sync.",
      gistNoToken: "A GitHub Classic PAT with the gist scope is required for Gist sync.",
      gistCreateFailed:
        "Could not create the sync Gist. Check that the Classic PAT has the gist scope.",
      gistPushFailed:
        "Could not write to the sync Gist. Check that the Classic PAT has the gist scope.",
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
        "The AI service returned a response Cubby can't use. Check the protocol and model, then retry.",
      agentDataDisclosureRequired:
        "Review Cubby's data-sharing details in Options, then save the AI service settings again.",
      agentContextCapabilityRequired:
        "Check the context window, then test the connection before using Cubby.",
      agentContextCapabilityInfeasible:
        "Increase the working context window in Advanced settings before using Cubby.",
      agentArtifactCoverageStalled:
        "Cubby couldn't finish verifying the complete stored result. Retry the request.",
      unknown: (raw) => `Something went wrong: ${raw}`,
    },
    onboarding: {
      title: "Welcome to Better GitHub Stars Manager",
      noTokenBody: "This app requires a GitHub Classic PAT to manage your stars:",
      createPatLabel: "Create a GitHub Classic PAT",
      openOptions: "Add Classic PAT in Options",
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
      coachStep1Title: "Meet the three workspaces",
      coachStep1Body:
        "Stars organizes your saved repositories. Watch surfaces Issue and Pull Request threads from those repositories. Following shows repositories recently starred by people you follow, plus For You recommendations.",
      coachStep2Title: "Keep Stars in sync",
      coachStep2Body:
        "Sync fetches stars added since your last visit. Open its menu for Full Sync when you need a complete re-pull. Neither action creates or changes tags.",
      coachStep3Title: "Add topic-based tags",
      coachStep3Body:
        "Auto Tags adds local tags from synced GitHub topics only when you run it. It never runs as part of Sync.",
      coachStep4Title: "Organize with Cubby",
      coachStep4Body:
        "Ask Cubby about a selected repository or your current Stars view. It can also help organize your library, with library-wide changes reviewed before Apply.",
      coachStep5Title: "Exit the panel",
      coachStep5Body:
        "Click here to return to GitHub's native Stars page. A floating button stays on screen so you can reopen the manager at any time.",
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
      surfaceNavigation: "管理器页面",
      syncFailed: (label, error) => `${label}: ${error}`,
      autoAssignDone: (count) =>
        `Auto Tags 已为 ${count} 个仓库添加主题标签`,
      autoAssignFailed: (error) => `Auto Tags 失败：${error}`,
      autoTagAgentPromptTitle: "这次要让 Cubby 先看看吗？",
      autoTagAgentPromptBody:
        "Auto Tags 会直接根据 GitHub 主题添加本地标签。Cubby 会多看一眼仓库详情，先给出建议，等你确认后再改。",
      autoTagAgentPromptYes: "让 Cubby 看看",
      autoTagAgentPromptNo: "直接用 Auto Tags",
      storeRatingPromptTitle: "喜欢 Better GitHub Stars Manager 吗？",
      storeRatingPromptBody:
        "一条简短的商店评价，可以帮助更多 GitHub 用户发现这个扩展。",
      storeRatingPromptLinkLabel: (store) =>
        `前往 ${store} 评价 Better GitHub Stars Manager`,
      storeRatingPromptStoreNote: (store) => `实际评分将在 ${store} 中完成。`,
      storeRatingPromptLater: "以后再说",
      storeRatingPromptNever: "不再提醒",
      deleteTagFailed: (error) => `删除标签失败: ${error}`,
      deleteAllTagsFailed: (error) => `删除全部标签失败: ${error}`,
      noTokenBanner: "应用需要 GitHub Classic PAT 鉴权才能加载数据。",
      addPat: "打开选项页添加 Classic PAT",
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
    watch: {
      starsSurface: "Stars",
      watchSurface: "Watch",
      watchSurfaceUnread: (count) => `Watch，${count} 个未读 threads`,
      title: "已 Watch 的 Stars 收件箱",
      filterLabel: "Inbox thread 筛选",
      searchPlaceholder: "搜索仓库和 threads",
      clearSearch: "清除 Watch 搜索",
      reasonFilter: "通知原因",
      reasonFilterSelected: (count) => `通知原因，已选 ${count} 项`,
      reasonFilterClear: "清除原因筛选",
      reasonPresets: "原因预设",
      reasonPresetAll: "全部",
      reasonPresetDirect: "直接相关",
      reasonPresetSecurity: "安全",
      reasonPresetParticipation: "参与过",
      reasonPresetWatching: "Watching",
      reasonPresetOther: "其他",
      reasonThreadCount: (count) => `${count} 个 threads`,
      unread: "未读",
      all: "全部",
      refresh: "刷新 Watch 收件箱",
      refreshing: "刷新中…",
      openOptions: "打开选项页",
      configureMainToken: "请更新 GitHub Classic PAT，以加载 Watch 数据。",
      configureNotificationsToken: "请在选项页确认 Classic PAT 已包含 notifications scope。",
      scopeNeverLoaded: "尚未从 GitHub 加载已 Watch 仓库成员关系。",
      inboxNeverLoaded: "刷新后可加载当前 Stars 的最新有界 Inbox 快照。",
      queryFailed: "无法加载 Watch 快照。",
      refreshFailed: "最近一次 Watch 刷新失败，仍可查看之前的快照。",
      retry: "重试",
      scopePermissionDenied:
        "GitHub 无法列出已 Watch 仓库成员关系；当前 Stars 的 Inbox threads 仍可加载。",
      inboxPermissionDenied:
        "GitHub Classic PAT 无法读取通知，请添加 notifications scope；其他功能仍可使用。",
      scopeUnavailable: "已 Watch 仓库成员关系不可用；Inbox threads 仍以当前 Stars 为范围。",
      noWatchedRepositories: "GitHub 没有返回当前 Stars 的已 Watch 仓库成员关系。",
      noUnreadThreads: "最近一次 Watch 快照中，当前 Stars 没有未读 thread。",
      credentialStaleSnapshot:
        "GitHub Classic PAT 已被拒绝或暂时不可用，现显示上一次成功的 Watch 快照。",
      noThreads: "这次快照中没有 Inbox thread 匹配当前 Stars。",
      noMatchingThreads: "没有 thread 匹配当前 Watch 搜索和通知原因筛选。",
      statusFresh: (unread, watched) => `未读 ${unread} · 已确认 Watch 的 Stars ${watched} 个`,
      statusRefreshingSaved: "刷新中 · 显示已保存数据",
      statusRefreshFailedSaved: "刷新失败 · 显示已保存数据",
      statusCooldown: (time) => `可在 ${time} 后刷新`,
      statusTruncated: (count) => `显示最新 ${count} 个 thread`,
      statusCredential: "需要 GitHub Classic PAT 鉴权",
      statusNeverLoaded: "Watch 等待首次加载",
      listEndSnapshot: (count) => `当前快照末尾 · 共 ${count} 个 thread`,
      listEndMatches: (count) => `匹配结果末尾 · 共 ${count} 个 thread`,
      listEndWindow: "当前窗口末尾 · 可能还有更早的 thread",
      listEndSaved: (count) => `已保存快照末尾 · 共 ${count} 个 thread`,
      staleSnapshot: "最近一次刷新失败，当前仍显示上一次成功快照。",
      scopeFailed: "无法刷新已 Watch 仓库成员关系；不影响 Inbox 覆盖范围。",
      inboxFailed: "无法刷新 Inbox threads。",
      truncated: "这里只显示最新的有界窗口，GitHub 上仍有更早的 threads。",
      cooldownUntil: (time) => `GitHub 要求客户端等到 ${time} 后再刷新。`,
      watchedRepositoryCount: (count) => `${count} 个已确认 Watch 的 Star 仓库`,
      threadCount: (count) => `${count} 个 threads`,
      snapshotAt: (time) => `快照检查于 ${time}`,
      manageOnGitHub: "在 GitHub 管理 Watch 设置",
      watchedOnGitHub: "已确认在 GitHub Watch",
      repositoryUnreadCount: (count) => `${count} 个未读`,
      openOnGitHub: "在 GitHub 打开",
      unreadSnapshot: "未读状态来自这次快照",
      markAsRead: "标记为已读",
      markAsDone: "标记为完成",
      markAllRead: "全部标记为已读",
      markAllDone: "全部标记为完成",
      markingRead: "正在标记为已读…",
      markingDone: "正在标记为完成…",
      actionReadFailed: "无法将所选通知标记为已读。",
      actionDoneFailed: "无法将所选通知标记为完成。",
      openSubjectOnGitHub: (subjectType) => `在 GitHub 打开 ${subjectType}`,
      threadDetails: "通知详情",
      threadReason: "原因",
      threadUpdated: "更新时间",
      threadStatus: "状态",
      readStatus: "已读",
      unreadStatus: "未读",
      subjectDetails: "Issue 详情",
      subjectDetailsLoading: "正在加载 Issue 详情…",
      subjectDetailsUnavailable: "无法加载 Issue 详情，通知信息仍可使用。",
      subjectDetailsAuthentication: "已保存的 GitHub Classic PAT 被拒绝或已过期。请在选项页更换后重试。",
      subjectDetailsPermission: "GitHub Classic PAT 需要 repo scope 和该仓库的访问权限。",
      subjectStateOpen: "Open",
      subjectStateClosed: "Closed",
      subjectStateReason: (reason) => `状态：${reason.replace(/_/g, " ")}`,
      subjectAuthor: (login) => `作者 @${login}`,
      subjectCreated: (time) => `创建于 ${time}`,
      subjectComments: (count) => `${count} 条评论`,
      subjectLabels: "标签",
      subjectAssignees: (logins) => `负责人：${logins}`,
      subjectMilestone: (title) => `里程碑：${title}`,
      subjectNoDescription: "未提供描述。",
      subjectShowDescription: "展开完整描述",
      subjectCollapseDescription: "收起描述",
      expandRepository: (repository) => `展开 ${repository}`,
      collapseRepository: (repository) => `收起 ${repository}`,
    },
    radar: {
      surface: "Following",
      surfaceUnseen: (count) => `Following，${count} 条未查看动态`,
      title: "近期 Star",
      viewLabel: "关注动态视图",
      feed: "动态",
      projects: "项目",
      discoverViewLabel: "发现视图",
      following: "关注动态",
      forYou: "为你推荐",
      openTrending: "打开 GitHub Trending",
      forYouSearchPlaceholder: "搜索推荐仓库",
      clearForYouSearch: "清除为你推荐搜索",
      forYouSearchResultCount: (count) => `匹配 ${count} 个推荐仓库`,
      forYouSearchEmpty: (query) => `没有推荐仓库匹配“${query}”。`,
      recommendationsOnly: "公开仓库 · 基于你的 Stars",
      recommendationsRefreshing: "正在刷新推荐…",
      recommendationsRefreshingSaved: "刷新中 · 显示已保存推荐",
      recommendationsNewBatch: "换一批",
      recommendationsQueryFailed: "无法加载推荐仓库。",
      recommendationsRefreshFailed: "最近一次刷新失败，仍可查看已保存推荐。",
      recommendationsNeverLoadedTitle: "尚未生成“为你推荐”",
      recommendationsNeverLoadedBody: "根据你当前的 Stars 和 GitHub 公开搜索结果生成私有推荐列表。",
      recommendationsRunFirstScan: "生成推荐",
      recommendationsEmptyTitle: "暂无推荐",
      recommendationsEmptyBody: "当前 Stars 未产生足够相关的公开仓库。可继续 Star 仓库或稍后刷新。",
      recommendationsStale: "最近一次刷新失败或结果已过期，当前显示已保存推荐。",
      recommendationsCooldownUntil: (time) => `已触发 GitHub Search 速率限制，${time} 后可再次刷新。`,
      recommendationsFreshSummary: (count) => `${count} 个推荐仓库`,
      recommendationsSnapshotAt: (time) => `推荐检查于 ${time}`,
      recommendationsListEnd: (count) => `推荐末尾 · 共 ${count} 项`,
      recommendationsListEndSaved: (count) => `已保存推荐末尾 · 共 ${count} 项`,
      becauseYouStarred: (repository) => `因为你 Star 了 ${repository}`,
      recommendationReason: (kind, value) => ({
        topic: `共同 topic · ${value}`,
        language: `相同语言 · ${value}`,
        owner: `相同所有者 · ${value}`,
        name: `相关仓库名称 · ${value}`,
      } as Record<string, string>)[kind] ?? value,
      recommendationStarAction: "Star",
      starRecommendation: (repository) => `在 GitHub Star ${repository}`,
      ignoreRecommendation: (repository) => `不再推荐 ${repository}`,
      ignoredCount: (count) => `已忽略 ${count} 个仓库`,
      recommendationIgnoreHint: "这个仓库将不再出现在我的推荐中",
      restoreIgnoredAction: "恢复",
      restoreIgnored: (repository) => `恢复推荐 ${repository}`,
      toggleView: "切换关注动态视图（V）",
      sourceLabel: "动态来源",
      sourceFollowing: "关注的人",
      sourceSelf: "我",
      sourceFollowingHint: "你关注的人的 Star 动态",
      sourceSelfHint: "你自己的 Star 动态",
      refresh: "刷新",
      refreshing: "扫描中…",
      statusLabel: (status) => ({
        partial: "部分",
        stale: "已过期",
        cooldown: "冷却中",
        error: "错误",
      } as Record<string, string>)[status] ?? status,
      openOptions: "打开选项页",
      retry: "重试",
      configureMainToken: "请为 GitHub Classic PAT 添加 read:user scope，以读取你关注的账号。",
      neverLoadedTitle: "尚未扫描关注动态",
      neverLoadedBody: "扫描你所关注账号最近公开 Star 的仓库。目前还没有执行过扫描。",
      runFirstScan: "开始首次扫描",
      queryFailed: "无法加载关注动态。",
      refreshFailed: "最近一次扫描失败，仍可查看之前的快照。",
      permissionTitle: "需要 GitHub Classic PAT 鉴权",
      permissionBody:
        "Following Radar 需要 GitHub Classic PAT 的 read:user scope。Stars、标签、Gist 和同步不受影响。",
      emptyTitle: "暂无近期 Star",
      emptyBody: "最近 30 天未发现 Star 动态。",
      filteredEmptyTitle: "所选来源没有动态",
      filteredEmptyBody: "调整“关注的人”和“我”，查看最近 30 天的 Star 动态。",
      searchPlaceholder: "搜索人物或仓库",
      clearSearch: "清除 Following 搜索",
      searchResultCount: (count) => `匹配 ${count} 条动态`,
      searchEmpty: (query) => `没有人物或仓库匹配“${query}”。`,
      statusRefreshingSaved: "扫描中 · 显示已保存动态",
      statusRefreshFailedSaved: "扫描失败 · 显示已保存动态",
      statusPartial: "部分结果 · 可能缺少部分动态",
      statusCooldown: (time) => `可在 ${time} 后扫描`,
      statusPermission: "Following 需要读取关注关系的权限",
      listEndActivities: (count) => `30 天窗口末尾 · 共 ${count} 条动态`,
      listEndProjects: (count) => `30 天窗口末尾 · 共 ${count} 个项目`,
      listEndMatches: (count) => `匹配结果末尾 · 共 ${count} 项`,
      listEndPartial: "已获取结果末尾 · 可能缺少部分动态",
      listEndSaved: (count) => `已保存动态末尾 · 共 ${count} 项`,
      freshSummary: (activities, following) => `${activities} 条动态 · 关注 ${following} 人`,
      partialSnapshot: (count) => `部分快照 · ${count} 个已知缺口`,
      partialReason: (reason) => ({
        github_star_list_truncated: "部分账号未能翻页到 30 天窗口末尾。",
        private_activity_omitted: "已省略关注账号的私有 Star 动态。",
        following_scan_truncated: "未能扫描全部关注账号。",
      })[reason],
      staleSnapshot: "最近一次扫描失败或快照已过期，当前显示上一次成功快照。",
      cooldownUntil: (time) => `已触发 GitHub 速率限制，${time} 后可再次扫描。`,
      snapshotAt: (time) => `快照检查于 ${time}`,
      publicActivityOnly: "公开 Star · 最近 30 天",
      actorStarred: "Star 了",
      openActorProfile: (actor) => `在 GitHub 打开 @${actor} 的主页`,
      inLibrary: "已在你的 Stars 中",
      followedStars: (count) => `${count} 条关注 Star 动态`,
      latest: "最新",
      expandProject: (repository) => `展开 ${repository} 的详情`,
      collapseProject: (repository) => `收起 ${repository} 的详情`,
      followedStarTimeline: "关注 Star 时间线",
      starredThisRepository: "Star 了此仓库",
      quickActions: (repository) => `${repository} 的快捷操作`,
      projectActions: (repository) => `${repository} 的仓库操作`,
      starOnGitHub: "在 GitHub Star",
      unstarOnGitHub: "在 GitHub 取消 Star",
      favorite: "收藏",
      addTag: "添加标签…",
      addTagAction: "添加标签",
      addingTagStars: "添加标签前会先 Star 此仓库",
      suggestedTags: "推荐标签",
      repositoryTags: "此仓库的标签",
      repositoryTagScope: "同一仓库的所有动态共用这些标签。",
      noTags: "暂无标签。",
      tagComposerHint: "Enter 添加 · Esc 关闭",
      openRepository: "打开仓库",
      actionFailed: (error) => `操作失败：${error}`,
      keyboardHint: "↑↓ 导航 · Enter 应用 · Esc 关闭",
      unseenActivity: "未查看动态",
      unseenProject: "此项目有未查看动态",
      dismissActivity: (actor, repository) => `隐藏动态：${actor} Star 了 ${repository}`,
      dismissProject: (repository) => `从关注动态中隐藏 ${repository}`,
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
      fullSyncTitle: "重新拉取全部 Stars 和本人拥有的全部公开仓库",
      fullSyncButton: "Full Sync",
      themeTitle: "切换黑白主题",
      githubHomeTitle: "GitHub 首页",
      hidePanelTitle: "隐藏面板（用 GitHub 原生列表）",
      starRepoTitle: "打开项目仓库",
      autoAssignTitle: "根据已同步的 GitHub 主题在本地添加标签",
      autoAssignButton: "Auto Tags",
      agentTitle: "打开 Cubby，你的 AI 仓库整理助手",
      agentButton: "Cubby",
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
      showRepositoryOwner: "显示仓库所有者",
      showRepositoryAvatar: "显示仓库头像",
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
      hideWhileRunning: "隐藏 Cubby",
      runContinuesWhileHidden: "可以隐藏面板；本轮会继续。",
      confirmScopeHeader: "确认范围",
      analyzingHeader: (processed, total) => `分析中 · ${processed}/${total}`,
      analyzingTitle: "正在分析锁定范围",
      analyzingMeta: (processed, remaining, batches) => (
        `已处理 ${processed} · 剩余 ${remaining} · ${batches} 批`
      ),
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
      applyingTitle: "正在应用选中变更",
      applyingSubtitle: "手动标签 · 范围仍保持锁定",
      applyingMeta: (done, total) => `已应用 ${done}/${total} 项变更 · 选择已锁定`,
      applyingButton: "应用中…",
      applyingStopbar: "当前仓库处理完成后暂停。",
      composerPausedApplying: "应用期间暂停输入",
      budgetExhaustedHeader: "已达到本轮上限",
      budgetExhaustedTitle: (reason) => `已达到本轮上限 · ${reason}`,
      budgetExhaustedSubtitle: (processed, total) => `已处理 ${processed} / ${total} · 剩余不会自动继续`,
      budgetExhaustedBody: "剩余仓库不会被自动处理。继续即可为它们开始新的分析。",
      continueRemainingCount: (count) => `继续剩余 ${count}`,
      nothingToAnalyzeHeader: "没有可分析内容",
      nothingToAnalyzeTitle: "没有可分析内容",
      nothingToAnalyzeBody: "可见仓库可能都已有标签，或当前筛选隐藏了候选。请调整筛选或扩大范围后再问。",
      emptyScopeCount: "此范围匹配 0 个仓库。",
      handoffHeader: "交接 · 仍未标注",
      handoffTitle: "来自 Auto Tags",
      handoffSubtitle: (count) => `Auto Tags 已完成 · 仍有 ${count} 个未标注`,
      handoffBody: "Auto Tags 已根据 GitHub 主题添加本地标签。Cubby 只会检查剩余未标注仓库，除非你应用手动标签，否则不会覆盖这些结果。",
      handoffAsk: (count) => `Auto Tags 留下了 ${count} 个未标注仓库。我可以再仔细看看，并建议合适的手动标签。要继续吗？`,
      handoffOrganize: (count) => `整理这 ${count} 个`,
      handoffAmbiguous: "只看不明确的",
      handoffExamples: "先解释几个例子",
      handoffScopeNote: (count) => (
        count === 1
          ? "Auto Tags 后仍未标注 · 1 个仓库"
          : `Auto Tags 后仍未标注 · ${count} 个仓库`
      ),
      partialReceiptHeader: "已应用，但有冲突",
      resolvingScopeHeader: "正在解析范围…",
      resolvingScopeBody: "我会锁定所选仓库，之后的筛选变化不会影响本次分析。",
      resolvingScopeMeta: "此步骤不会修改标签",
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
      providerAuthSubtitle: "API 密钥无效或缺少 Chrome 访问权限",
      providerAuthBody: "Cubby 无法连接你配置的 AI 服务。消息和范围已保存，此处不会显示任何密钥。",
      providerAuthOpenOptions: "打开选项",
      providerAuthRetry: "更新设置后重试",
      completedNoChangesHeader: "已完成 · 无变更",
      completedNoChangesTitle: "已完成 · 无变更",
      completedNoChangesSubtitle: (inspected) => `未建议标签变更 · 已检查 ${inspected}`,
      completedNoChangesBody: "这些仓库已有清晰分类，或证据不足以安全建议手动标签。无需应用。",
      unknownOutcomeComposer: "无法确认结果 · 可以继续对话",
      applyTerminalUnknownComposer: "无法确认结果 · 可以继续对话",
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
        "我会使用你配置的 AI 服务，以及本次请求允许的工具。",
      toolResult: "工具结果",
      emptyAgentMessage: "未返回回复。",
      chatSuggestionsReady: (count) => `我找到了 ${count} 条标签建议。应用前可以先在下面确认。`,
      chatNoSuggestions: "按当前本地数据，我没有找到新的标签建议。",
      chatLimitedCapability:
        "我可以用你配置的 AI 服务帮你整理星标仓库。",
      reasoningSuggestTags:
        "我会查看本地仓库的 GitHub 主题和现有标签，跳过已排除的标签，并准备谨慎的标签建议。",
      reasoningStreaming: "Cubby 正在仔细查看…",
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
      closeTitle: "关闭 Cubby",
      suggestTags: "整理这里的未标注",
      agentSettings: "Cubby 设置",
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
      needsReviewFollowUp: "待审阅 · 正在回答追问",
      needsReviewSelected: (count) => `待审阅 · 已选择 ${count} 条`,
      appliedTagChanges: (count) => `已应用 ${count} 项标签变更`,
      followUpAboutScope: "继续询问此范围",
      askingAboutCurrentViewUnknown: "当前视图",
      handoffAutoTagsUpdated: "自动标签已更新基于主题的标签。",
      agentActivityLabel: "Cubby 活动",
      workbench: {
        controlledElsewhere: "本次任务正由另一个 Cubby 页面控制，本页面为只读。",
        ownerDisconnected: "控制本次任务的页面已断开连接。可在本页面接管并继续管理。",
        takeControl: "接管控制",
        takingControl: "正在接管…",
        takeControlFailedOwnerConnected: "原控制页面已重新连接，本页面保持只读。",
        takeControlFailedConflict: "接管期间任务状态已变化，请重试。",
        takeControlFailedUnavailable: "该任务已不可用。",
        takeControlFailed: "暂时无法接管，请重试。",
        takeControlSucceeded: "你已接管本次任务。",
        organizeAlreadyRunning: "已有整理任务正在进行。请等待其完成，或先关闭其结果，再开始新的整理。",
        organizeCommandFailed: "Cubby 无法更新本次整理任务。请刷新最新状态后重试。",
        receiptOriginDeleted: "该结果来自一个已删除的对话。",
        resolvingSubtitle: "正在准备你的星标资料库",
        resolvingBody: "本次分析会包含全部仍在星标的仓库。筛选条件和当前选中行都不会缩小范围。",
        resolvingHint: "此步骤不会修改标签",
        confirmScopeTitle: "确认分析范围",
        repositoriesFrozen: (count) => `将分析 ${count} 个仓库。`,
        reviewBeforeApply: "分析完成后会先生成一次完整审阅；此步骤不会修改标签。",
        startAnalysis: "开始分析",
        startingAnalysis: "正在启动分析",
        analysisScopeIncomplete: "已保存的分析范围不完整，请重新准备后再试。",
        nothingToAnalyzeBody: "可见仓库可能都已有标签，或当前筛选隐藏了候选项。请调整筛选或扩大范围后重试。",
        dismiss: "关闭",
        confirmRequestedScope: "确认请求的范围",
        candidateRepositories: (count) => `${count} 个候选仓库。`,
        continue: "继续",
        analyzingFrozenScope: "正在分析锁定范围",
        progressSummary: (processed, remaining) => `已分析 ${processed} · 剩余 ${remaining}`,
        runProgressLabel: "分析进度",
        processed: "已处理",
        remaining: "剩余",
        batches: "批次",
        providerAttempts: "AI 请求",
        analysisBlockedTitle: "分析未完成，已暂停",
        analysisCoverage: (processed, total) => `已分析 ${processed} / ${total} 个仓库`,
        analysisBlockedBody: (failed) => failed > 0
          ? `${failed} 个仓库分析失败。不会展示或应用部分建议；可以继续处理失败项，或重新分析整个资料库，以生成一次完整审阅。`
          : "不会展示或应用部分建议。可以继续处理剩余项，或重新分析整个资料库，以生成一次完整审阅。",
        restartWholeLibrary: "重新分析整个资料库",
        discardAnalysis: "放弃本次分析",
        runStateRefreshed: "已恢复最新的分析进度。请再次继续，或重新分析整个资料库。",
        analysisReady: "分析已就绪",
        preparedReady: "所选范围已准备就绪。",
        preparedPaused: "所选范围已准备就绪，将在当前分析停止后开始。",
        budgetExhausted: (reason) => `已达到本轮上限 · ${reason}`,
        budgetSubtitle: (processed, total) => `已处理 ${processed} / ${total} · 剩余项未自动继续`,
        budgetProgress: (processed, remaining, attempts) => `已处理 ${processed} · 剩余 ${remaining} · 已使用 ${attempts} 次 AI 请求`,
        budgetBody: "剩余仓库不会被自动处理。继续即可为它们开始新的分析。",
        continueRemainingCount: (count) => `继续处理剩余 ${count} 项`,
        moreRemain: "仍有仓库待处理",
        moreRemainBody: "当前审阅已结束，剩余仓库没有被自动处理。",
        continueCreatesRun: "继续将为剩余仓库开始新的分析。",
        continueRemaining: "继续处理剩余项",
        proposalSummary: (actionable, nonActionable) => `Cubby 找到了 ${actionable} 条标签建议。另有 ${nonActionable} 个仓库无需变更或证据不足。`,
        proposalSelectionNote: "只有选中的建议会写入手动标签。",
        reviewSuggestions: "审阅标签建议",
        reviewCoverageComplete: (count) => `已覆盖完整资料库 · 已分析 ${count} 个仓库`,
        reviewLoadFailedBody: "分析已完成，但建议暂时无法加载。可以直接重试，无需重新分析。",
        proposalCounts: (actionable, nonActionable, selected) => `${actionable} 条建议 · ${nonActionable} 个无需变更 · 已选择 ${selected} 条`,
        finishReviewFirst: "仍有仓库待处理。请先完成当前审阅再继续。",
        selectRepository: (repositoryId) => `选择 ${repositoryId}`,
        applyingSelectedChanges: "正在应用所选变更",
        selectedRowsLocked: (count) => `已选择 ${count} 项 · 选择已锁定`,
        applying: "正在应用…",
        applySelected: (count) => `应用所选 ${count} 项`,
        applyTagImpact: (tags, repositories) => `将 ${tags} 个标签应用到 ${repositories} 个仓库`,
        selectAll: "全选",
        clear: "清除",
        previousPage: "上一页",
        nextPage: "下一页",
        reviewPageRange: (start, end, total) => `${start}-${end} / ${total}`,
        applyingSubtitle: "手动标签 · 范围仍保持锁定",
        rowsSelectedLocked: (selected, total) => `已选择 ${selected} / ${total} 项 · 选择已锁定`,
        receiptPartial: (changed, skipped, failed) => `已应用 ${changed} 项，跳过 ${skipped} 项；${failed} 项不再满足所需条件，因此保持不变。`,
        receiptSingle: "已将所选建议应用为手动标签，未推送到 Gist。",
        receiptComplete: (changed) => `已将所选 ${changed} 条建议应用为手动标签，未推送到 Gist。`,
        mutationReceipt: "标签更新结果",
        receiptSubtitle: "最终结果 · 本地手动标签 · 未推送 Gist",
        receiptCountsLabel: "结果统计",
        changed: "已变更",
        skipped: "已跳过",
        failed: "失败",
        unchanged: "未变化",
        receiptCountSummary: (changed, skipped, failed) => `已变更 ${changed} · 已跳过 ${skipped} · 失败 ${failed}`,
        unchangedCount: (count) => `${count} 项未变化`,
        receiptRowsLabel: "结果详情",
        receiptLoadFailed: "无法加载结果详情",
        receiptLoadFailedBody: "标签更新已经完成。可以重试加载详情，或关闭本次结果。",
        viewAllRows: "查看全部结果",
        viewFailedChanged: "查看失败和已变更项",
        viewChanged: "查看已变更项",
        connectionInterrupted: "Cubby 连接已中断，正在重新连接…",
        workerLost: "扩展已重启，本次分析无法继续。请开始新的分析。",
        timelineLabel: (state) => ({
          preflight: "正在解析范围",
          frozen: "范围已锁定",
          prepared: "分析已准备",
          checking_provider: "正在检查 AI 服务",
          analyzing: "正在分析",
          review: "待审阅",
          applying: "正在应用",
          completed: "已完成",
          budget_exhausted: "已达到本轮上限",
          cancelled: "已取消",
          failed: "失败",
          interrupted: "已中断",
        }[state] ?? state.replaceAll("_", " ")),
        runStepsLabel: "Cubby 分析步骤",
        runStepScope: "范围",
        runStepAnalyze: "分析",
        runStepReview: "审阅",
        runStepApply: "应用",
        runStepReceipt: "结果",
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
        reviewEditInvalidNormalized: "这个标签包含不受支持的字符变体。",
        reviewEditInvalidDuplicate: "标签与这条建议中的其他操作重复。",
        reviewEditInvalidTooLong: "标签过长。",
        reviewCorrectedTo: (tag) => `已修正为 ${tag}`,
        reviewNeedsReanalysis: "需重新分析后才能应用",
        reviewAskRevise: "要求修正",
        reviewReviseRejected: (count) => `要求修正已拒绝项（${count}）`,
        reviewReviseRejectedPrompt: (details) => `请在任何应用前修正这次标签审阅。保持冻结范围不变，跳过已拒绝行，只按修正后的意图重新分析。拒绝/修正：\n${details}`,
        reviewEditCorrectionPrompt: (repositoryId, fromTag, toTag) => `对于 ${repositoryId}，不要应用已审阅标签「${fromTag}」。请按修正后的标签意图「${toTag}」重新分析该仓库，并在任何应用前返回新的审阅行。`,
        reviewRejectCorrectionPrompt: (repositoryId, reason) => `对于 ${repositoryId}，拒绝当前建议（${reason}）。请带着这个修正重新分析该仓库，并在任何应用前返回新的审阅行。`,
        reviewLocalOnlyNote: "编辑和拒绝只影响本次审阅，最终只会应用选中的建议。",
      },
    },
    activeFilters: {
      onlyFavorite: "收藏",
      onlyUntagged: "仅未标注",
      onlyArchived: "已归档",
      onlyOwned: "我的仓库",
      summary: (count) => `${count} 个结果 · 已筛选`,
      clearOne: "移除该筛选",
      clearAll: "清除全部筛选",
    },
    filterSidebar: {
      specialFilters: "特殊筛选",
      onlyOwnedLabel: "我的公开仓库",
      onlyOwnedHint: (username) => `@${username} 拥有的全部公开仓库，包括尚未 Star 的仓库`,
      onlyOwnedUnavailableHint: "需要 GitHub 账号",
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
      fork: "Fork",
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
      notStarred: "本人公开仓库 · 尚未 Star",
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
      librarySource: "收录来源",
      ownedPublicRepository: "本人公开仓库",
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
      noToken: "应用需要 GitHub Classic PAT 鉴权。",
      addPat: "添加 Classic PAT",
      idle: "空闲",
      syncIncremental: "同步新 stars（增量）",
      syncFull: "全量重新拉取所有 stars",
      reconcile: "校正 stars 状态",
      gistPull: "从 Gist 拉取标签",
      gistPush: "推送标签到 Gist",
      testConnection: "测试 Classic PAT",
      debugState: "调试扩展状态",
      openStars: "打开我的 stars 页面",
      options: "选项…",
      starRepoTitle: "点个Star~",
      testing: "正在测试 Classic PAT…",
      rate: (remaining, limit) => `限额: ${remaining}/${limit} 剩余`,
      scopes: (scopes) => `权限: ${scopes ?? "未返回，请使用 Classic PAT"}`,
      itemsOnPage: (count) => `第 1 页条目数: ${count}`,
      sample: (sample) => `示例: ${sample ?? "—"}`,
      connectionOk: "正常 — Classic PAT 已验证",
      connectionNoContent: "204 No Content — Classic PAT 可能缺少 starred 仓库访问权限",
      connectionRejected: "401 — Classic PAT 被拒绝或已过期",
      connectionForbidden: "403 — Classic PAT 缺少所需 scopes 或仓库访问权限",
      failed: (label, error) => `${label} 失败: ${error}`,
    },
    options: {
      title: "Better GitHub Stars Manager — 选项",
      starRepoButton: "点个Star~",
      storeRatingHeading: "商店评分",
      storeRatingManualAction: (store) => `前往 ${store} 评分`,
      storeRatingManualHint: (store) =>
        `打开 Better GitHub Stars Manager 在 ${store} 中已验证的商店页面。`,
      storeRatingReminderLabel: "自动评分提醒",
      storeRatingReminderTracking: "已启用",
      storeRatingReminderSnoozed: (date) => `已暂停至 ${date}`,
      storeRatingReminderDisabled: "已停用",
      storeRatingReminderExhausted: "两次提醒已完成",
      storeRatingReminderStoreOpened: "打开商店后已停用",
      storeRatingReminderEnable: "启用提醒",
      storeRatingReminderDisable: "停用提醒",
      tokenHeading: "1. GitHub Classic PAT",
      tokenIntroPrefix: "创建 Stars、Gist、Watch 和 Following 共用的唯一 GitHub token：",
      tokenLinkLabel: "打开已预填的 classic token 表单",
      tokenIntroSuffix: "生成前请确认 scopes。",
      agentHeading: "2. Cubby",
      agentIntro:
        "连接 AI 服务后，Cubby 会直接向该服务发送请求，并在扩展内显示结果。",
      agentServiceLabel: "AI 服务",
      agentServiceHint: "选择 Cubby 使用的 AI 服务。",
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
      agentApiKeyLabel: "API 密钥",
      agentApiKeyHint: "只保存在本机，并会加密存储。",
      agentApiKeyPlaceholder: "粘贴 API 密钥",
      agentSavedKeyHint:
        "这台设备里已经保存过密钥。留空即可继续使用当前密钥。",
      agentSave: "保存并测试",
      agentSaving: "正在保存并测试…",
      agentSavedAndTested: (provider, model, latencyMs) =>
        `已保存 · ${provider} · ${model} 已连接（${latencyMs} ms）`,
      agentSavedTestFailed: (error) =>
        `设置已保存，但连接测试失败：${error}`,
      agentSavedNeedsHostAccess:
        "设置已保存。请先允许 Chrome 访问，然后测试连接。",
      agentTest: "测试连接",
      agentTesting: "测试中…",
      agentTestOk: (provider, model, latencyMs) =>
        `${provider} · ${model} 已连接（${latencyMs} ms）`,
      agentRemoveKey: "移除已保存密钥",
      agentKeyRemoved: "已移除保存的 AI 服务密钥。",
      agentDisclosureHeading: "与 AI 服务共享的数据",
      agentDisclosureIntro: (provider, origin) =>
        `${provider} · ${origin} · 直接连接`,
      agentDisclosureSentHeading: "按需发送",
      agentDisclosureSentPrompt: "你的提示词、当前范围内的公开仓库元数据和可见标签",
      agentDisclosureSentCode: "只有你明确要求 Cubby 使用时，才会发送代码片段或私人笔记",
      agentDisclosureSentProtocol: "工具定义、有限的工具结果、交互选择和对话摘要",
      agentDisclosureNotSentHeading: "绝不会作为模型输入",
      agentDisclosureNotSentSecrets: "GitHub token、API 密钥、其他凭据，或当前范围外的仓库",
      agentDisclosureKeyException:
        "AI 服务 API 密钥只会通过服务商要求的认证请求头发送到上方准确地址（Anthropic 使用 x-api-key），绝不会写入提示词或日志。",
      agentDisclosureLocalHistory:
        "已提交的对话历史、包含已提交提示词的近期尝试记录、有界续接恢复投影，以及分页工件，可能会以明文保存在本机浏览器的扩展存储中，不会同步、导出或进入发布版诊断。删除对话会移除对应对话记录、尝试与恢复数据，以及归该对话所有的工件；可重新获取的工具缓存也可单独清理。解压加载的开发版会在启用原始捕获前另行披露风险。",
      agentDisclosureBuiltInAccess:
        "此服务已包含在扩展内置的 Chrome 访问范围中。",
      agentDisclosureCustomAccess:
        "自定义服务还需要单独允许 Chrome 访问。",
      agentGrantAccess: "允许访问",
      agentAccessGranted: "已允许访问",
      agentHostAccessRequired: "测试或使用此自定义服务前，请先允许 Chrome 访问。",
      agentStorageHeading: "本机 Cubby 对话、恢复与工件账本",
      agentStorageIntro:
        "此账本涵盖本机的对话记录、尝试与恢复状态、已保存的对话工件，以及可重新获取的工具缓存；不代表 Cubby 或扩展的全部存储。",
      agentStorageOrganizeRetention:
        "Organize 数据单独有界保存：活动中或预检阶段的任务指令与冻结范围、提案、Apply 与回执记录，以及最近一次已完成或已取消的结果；这些数据均不计入此账本。删除来源对话仍会保留该最近结果，直到你将其关闭或新的 Organize 运行将其替换。",
      agentStorageRefresh: "刷新存储用量",
      agentStorageLoading: "正在检查 Agent 存储…",
      agentStorageDurableData: "对话、恢复与已保存工件",
      agentStorageConversationCount: (sessions, messages) =>
        `${sessions} 个对话 · ${messages} 条消息`,
      agentStorageToolCache: "可重新获取的工具缓存",
      agentStorageArtifactCount: (artifacts) => `${artifacts} 个缓存工具工件`,
      agentStorageLedgerTotal: "对话、恢复与工件账本总量",
      agentStorageLogicalLimit: (limit) => `账本上限 ${limit}`,
      agentStorageLedgerUsageLabel: "对话、恢复与工件账本已用空间",
      agentStorageThresholds: (warning, limit) =>
        `仅此账本：${warning} 时提醒 · ${limit} 时拒绝新的账本写入`,
      agentStorageBrowserUsage: (usage, quota) =>
        `整个扩展的浏览器存储估算：已用 ${usage}，可用额度 ${quota}`,
      agentStorageBrowserUnavailable: "暂时无法获取整个扩展的浏览器存储估算",
      agentStorageWarning:
        "此账本已超过提醒线；其他 Cubby 与扩展存储不受此阈值限制。进行高存储量任务前，请先清理可重新获取的工具缓存。",
      agentStorageLimitReached:
        "此账本已达到本机上限。释放空间前将拒绝新的账本数据；其他 Cubby 与扩展存储不受此阈值限制。",
      agentStorageClearHint:
        "只清理可重新获取的工具缓存；最终回答与对话记录、尝试与恢复状态，以及已保存的对话工件会保留。",
      agentStorageClearCache: "清理工具缓存",
      agentStorageClearingCache: "正在清理工具缓存…",
      agentStorageCacheCleared: (artifacts, bytes, protectedArtifacts) =>
        `已清理 ${artifacts} 个缓存工具工件，释放 ${bytes}。${protectedArtifacts > 0 ? `另有 ${protectedArtifacts} 个正在使用或仍被引用的工件已保留。` : ""}`,
      agentStorageUnavailable: (error) => `无法获取 Cubby 账本用量：${error}`,
      agentStorageClearFailed: (error) => `无法清理工具缓存：${error}`,
      agentStorageRetry: "重试",
      behaviorHeading: "4. 偏好设置",
      maxTagsPerRepoLabel: "每个仓库最多自动标签数",
      maxTagsPerRepoHint:
        "Auto Tags 使用此上限；聊天中 Cubby 每轮最多为单个仓库新增这么多个标签；整理功能取此值与 5 个标签安全上限中的较小值。",
      minTopicRepoCountLabel: "共同标签最低覆盖数",
      minTopicRepoCountHint:
        "聊天中，只有目标仓库加入后，同一主题或可见标签至少覆盖这么多个有效仓库，Cubby 才会分配该标签；整理功能按整批建议计算，Auto Tags 对主题使用相同阈值。",
      starsPanelDefaultLabel: "默认打开自己的 stars 页面时显示管理面板",
      starsPanelDefaultHint:
        "关闭后会优先显示 GitHub 原生 stars 列表，需要时再手动打开悬浮面板。",
      tokenPublicRepos: "必需 · repo · Stars、仓库访问和 Issue/PR 详情",
      tokenGists: "必需 · gist · 跨设备同步标签和笔记",
      tokenWatchingOptional: "可选 · notifications · Watch 收件箱",
      tokenIssuesOptional: "repo 也包含你有权访问的私有 Issue/PR 详情。",
      tokenFollowersOptional: "可选 · read:user · Following Radar",
      tokenGistNote:
        "gist 是账号级权限。扩展会创建一个私有 Gist，用于同步标签和笔记。",
      authenticatedAs: (username) => `Classic PAT 已鉴权为 @${username}。`,
      openVerifiedStars: "打开我的 stars",
      removeToken: "移除 Classic PAT",
      cachedAccountWarning: (username) =>
        `应用需要 GitHub Classic PAT 鉴权。请在下方添加并验证；@${username} 的本地数据会保留。`,
      clearCachedAuth: "清除已保存账号",
      saveVerify: "保存并验证",
      verifying: "验证中…",
      tokenVerified: (username) => `@${username} 的 Classic PAT 已验证，Stars、Gist 和 Watch 均可使用。`,
      tokenVerifiedWatchForbidden: (username) => `@${username} 的 Classic PAT 已验证。Stars 和 Gist 可用；如需 Watch，请添加 notifications。`,
      tokenVerifiedWatchUnverified: (username) => `@${username} 的 Classic PAT 已验证。Stars 和 Gist 可用，但暂时无法检查 Notifications。`,
      tokenRemoved: "GitHub Classic PAT 已移除。",
      tokenStepsTitle: "Token 配置",
      tokenStep1Title: "设置有效期",
      tokenStep1: "打开预填表单，保留 Note，并选择有限有效期。",
      tokenStep1Alt: "Classic PAT 的 Note、有效期和 repo scope",
      tokenStep2Title: "确认 scopes",
      tokenStep2: "保留 repo、gist、notifications 和 read:user；不要勾选 user。",
      tokenStep2Alt: "已勾选 gist、notifications 和 read:user，未勾选 user",
      tokenStep3Title: "生成并保存",
      tokenStep3: "生成 Token，复制并粘贴到下方，然后点击保存并验证。",
      tokenStep3Alt: "GitHub Generate token 按钮",
      tokenScopesWarning: "GitHub 只显示一次 Token，请妥善保管。",
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
      autoAssignTagging: "正在根据仓库主题添加本地标签…",
      autoAssignDone: (tagged) => `Auto Tags 已完成 · ${tagged} 个仓库已添加标签`,
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
      watchStatusUnavailable: "Watch 状态暂时不可用。",
      watchInboxQueryInvalid: "Watch 收件箱查询无效。",
      watchInboxUnavailable: "Watch 收件箱暂时不可用。",
      watchRepositoryInvalid: "Watch 仓库无效。",
      watchRepositoryDetailUnavailable: "Watch 仓库详情暂时不可用。",
      watchRefreshFailed: "Watch 刷新失败。",
      watchDisconnectFailed: "断开 Watch 收件箱失败。",
      watchDataClearFailed: "无法清除 Watch 数据。",
      watchThreadActionInvalid: "Watch 通知选择无效。",
      watchThreadActionFailed: "Watch 通知操作失败。",
      watchSubjectDetailInvalid: "Watch 通知详情请求无效。",
      watchSubjectDetailError: (code) => {
        switch (code) {
          case "authentication_required":
          case "permission_denied":
            return "主 GitHub token 无法读取此 Issue 或 Pull Request，请添加 Issues: read 和对应仓库访问权限。";
          case "subject_not_found":
            return "此 Issue 或 Pull Request 不可用。";
          case "rate_limited":
            return "GitHub 限制了此次详情请求，请稍后重试。";
          case "credential_changed":
            return "加载详情时 GitHub 连接发生变化，请重试。";
          default:
            return "无法加载 Issue 详情，通知信息仍可使用。";
        }
      },
    },
    errors: {
      tokenEmpty: "请先粘贴 GitHub Classic PAT。",
      tokenRejected:
        "GitHub 拒绝了该 Classic PAT。它可能已过期、被撤销或复制不完整；请创建或粘贴有效的 Classic PAT。",
      tokenStarsForbidden:
        "该 Classic PAT 无法访问 Stars，请重新创建并添加 repo scope。",
      tokenGistsForbidden:
        "该 Classic PAT 无法写入 Gist，请重新创建并添加 gist scope。",
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
      ghTokenRejected: "已保存的 GitHub Classic PAT 被拒绝或已过期，请在选项页更换。",
      ghRateLimit: "已达到 GitHub 速率限制,请稍候重试。",
      ghNoToken: "应用需要 GitHub Classic PAT 鉴权，请在选项页添加。",
      ghForbidden:
        "GitHub 拒绝了请求 (403)。请在选项页检查 Classic PAT scopes 和仓库访问权限。",
      ghTimeout: (page) => `GitHub 响应超时(第 ${page} 页),请稍后重试。`,
      ghNetwork: (detail) => `无法连接 GitHub(${detail}),请检查网络。`,
      ghPageStatus: (status) =>
        `GitHub 返回 ${status}。请重试，或在选项页更换 Classic PAT。`,
      tokenWatchingForbidden: "Classic PAT 已保存，但 Watch 收件箱需要 notifications scope。",
      tokenWatchingStatus: (status) => `检查 Notifications 访问权限时 GitHub 返回 ${status}。`,
      tokenWatchingNetwork: "Classic PAT 已保存，但暂时无法检查 Notifications 访问权限。",
      tokenWatchingBadShape: "GitHub 返回了非预期的 Notifications 响应。",
      ghBadShape: "GitHub 返回了非预期的数据结构,可能需要全量重新同步。",
      gistNoToken: "Gist 同步需要带 gist scope 的 GitHub Classic PAT。",
      gistCreateFailed:
        "无法创建同步用 Gist，请确认 Classic PAT 具有 gist scope。",
      gistPushFailed:
        "无法写入同步用 Gist，请确认 Classic PAT 具有 gist scope。",
      gistPullFailed:
        "无法读取同步用 Gist。它可能已被删除,或 token 缺少「Gists (read)」权限。",
      agentApiKeyEmpty: "测试连接前请先填写 API 密钥。",
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
        "AI 服务返回了 Cubby 无法使用的响应。请检查协议和模型后重试。",
      agentDataDisclosureRequired:
        "请在选项中查看 Cubby 的数据共享说明，然后重新保存 AI 服务设置。",
      agentContextCapabilityRequired:
        "请检查上下文窗口并测试连接后再使用 Cubby。",
      agentContextCapabilityInfeasible:
        "请先在高级设置中增大工作上下文窗口，再使用 Cubby。",
      agentArtifactCoverageStalled:
        "Cubby 无法完成对已存结果的完整校验，请重试该请求。",
      unknown: (raw) => `出错了:${raw}`,
    },
    onboarding: {
      title: "欢迎使用 Better GitHub Stars Manager",
      noTokenBody: "应用需要 GitHub Classic PAT 鉴权才能管理你的 stars：",
      createPatLabel: "创建 GitHub Classic PAT",
      openOptions: "在选项页添加 Classic PAT",
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
      coachStep1Title: "认识三个工作区",
      coachStep1Body:
        "Stars 用于整理已收藏的仓库；Watch 汇总这些仓库的 Issue 和 Pull Request 动态；Following 展示关注用户最近 Star 的仓库，并提供 For You 推荐。",
      coachStep2Title: "保持 Stars 最新",
      coachStep2Body:
        "Sync 拉取自上次访问后新增的 Star；需要完整重拉时，从旁边的菜单选择 Full Sync。两者都不会创建或修改标签。",
      coachStep3Title: "按 GitHub Topics 添加标签",
      coachStep3Body:
        "Auto Tags 只在你主动运行时，根据已同步的 GitHub Topics 添加本地标签；它不会随 Sync 自动执行。",
      coachStep4Title: "用 Cubby 整理仓库",
      coachStep4Body:
        "可以让 Cubby 分析选中的仓库或当前 Stars 视图，也可以协助整理整个收藏库；全库变更会先进入 Review，再由你 Apply。",
      coachStep5Title: "退出管理面板",
      coachStep5Body:
        "点击这里返回 GitHub 原生 Stars 页面。屏幕上会保留一个悬浮按钮，随时可以重新打开管理面板。",
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

type I18nPreferenceSource = Pick<ManagerRuntime, 'readPreferences' | 'updatePreferences' | 'subscribe'>;

export function I18nProvider({
  children,
  source,
}: {
  children: ReactNode;
  source?: I18nPreferenceSource;
}) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    let cancelled = false;
    if (!source) {
      setLocaleState(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
      return () => {
        cancelled = true;
      };
    }
    const syncLocale = () => {
      void source.readPreferences()
        .then((preferences) => {
          if (!cancelled) setLocaleState(preferences.locale);
        })
        .catch(() => {});
    };
    syncLocale();
    const unsubscribe = source.subscribe((event) => {
      if (event.kind === 'preferences' || event.kind === 'reset') syncLocale();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);

  const setLocale = async (next: Locale) => {
    setLocaleState(next);
    if (source) await source.updatePreferences({ locale: next });
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
