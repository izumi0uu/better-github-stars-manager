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
  manager: {
    syncFailed: (label: string, error: string) => string;
    autoAssignDone: (count: number) => string;
    autoAssignFailed: (error: string) => string;
    deleteTagFailed: (error: string) => string;
    noTokenBanner: string;
    addPat: string;
    emptyState: string;
  };
  toolbar: {
    searchPlaceholder: string;
    searchClearTitle: string;
    sortStarredAt: string;
    sortPushedAt: string;
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
    columnTags: string;
    columnFavorite: string;
  };
  activeFilters: {
    onlyFavorite: string;
    onlyUntagged: string;
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
    deleteTagTitle: string;
    deleteTagConfirm: (name: string, count: number) => string;
    deleteTagDone: (count: number) => string;
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
    tokenHeading: string;
    tokenIntroPrefix: string;
    tokenLinkLabel: string;
    tokenIntroSuffix: string;
    tokenPublicRepos: string;
    tokenGists: string;
    tokenGistNote: string;
    authenticatedAs: (username: string) => string;
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
    coachNext: string;
    coachBack: string;
    coachSkip: string;
    coachDone: string;
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
    manager: {
      syncFailed: (label, error) => `${label}: ${error}`,
      autoAssignDone: (count) =>
        `Auto-assigned tags from repo topics for ${count} repos`,
      autoAssignFailed: (error) => `auto-assign tags: ${error}`,
      deleteTagFailed: (error) => `delete tag: ${error}`,
      noTokenBanner: "No GitHub token configured — data cannot load.",
      addPat: "Open options and add a PAT",
      emptyState: "No results. Adjust filters, or click Sync in the toolbar.",
    },
    toolbar: {
      searchPlaceholder:
        "Search name / description / topics / notes   (/ to focus)",
      searchClearTitle: "Clear search",
      sortStarredAt: "Sort by starred date",
      sortPushedAt: "Sort by updated date",
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
      autoAssignButton: "Auto assign tags",
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
      columnTags: "Tags",
      columnFavorite: "Favorite",
    },
    activeFilters: {
      onlyFavorite: "Favorites",
      onlyUntagged: "Untagged only",
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
      deleteTagTitle: "Delete tag everywhere",
      deleteTagConfirm: (name, count) =>
        count > 0
          ? `Delete "${name}" from all ${count} repos? This cannot be undone.`
          : `Delete "${name}"?`,
      deleteTagDone: (count) => `Deleted tag from ${count} repos`,
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
      tokenHeading: "1. GitHub Token",
      tokenIntroPrefix: "Create a fine-grained PAT at",
      tokenLinkLabel: "github.com/settings/tokens",
      tokenIntroSuffix: "Required permissions:",
      tokenPublicRepos:
        "Account · Public Repositories (read starred repos via /user/starred)",
      tokenGists: "Account · Gists (read/write, for cross-device tag sync)",
      tokenGistNote:
        "Note: GitHub Gist scope is account-wide (no per-gist isolation for fine-grained tokens). We create one dedicated secret gist for sync.",
      authenticatedAs: (username) => `Authenticated as @${username}.`,
      removeToken: "Remove token",
      cachedAccountWarning: (username) =>
        `Cached account @${username} exists, but the token is not usable in this extension instance.`,
      clearCachedAuth: "Clear cached auth",
      saveVerify: "Save & verify",
      verifying: "Verifying…",
      tokenVerified: (username) => `Token verified. Logged in as ${username}.`,
      tokenRemoved: "Token removed.",
      tokenStepsTitle: "How to create the token (fine-grained PAT)",
      tokenStep1:
        "Open GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.",
      tokenStep2:
        'Token name: anything (e.g. "stars-manager"). Expiration: pick whatever you like.',
      tokenStep3:
        'Repository access → select "All public repositories" (the extension reads your starred public repos).',
      tokenStep4:
        'Account permissions → enable "Public Repositories (read)" and "Gists (read and write)". Leave everything else off.',
      tokenStep5:
        "Generate → copy the token (starts with github_pat_…) → paste it above → Save & verify.",
      shotNewToken: 'Screenshot: the "Generate new token" form',
      shotRepoAccess:
        "Screenshot: repository access set to all public repositories",
      shotPermissions:
        "Screenshot: account permissions — Public Repositories (read) + Gists (read and write)",
      languageLabel: "Language",
      gistHeading: "2. Gist sync",
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
        'This token can read your profile but lacks "Public Repositories (read)". Re-create it with that permission.',
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
        "GitHub refused the request (403). The token may lack permissions or repository access.",
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
        "Here are the three things you'll use most. Follow along — this shows only once.",
      coachStep1Title: "Sync your stars",
      coachStep1Body:
        "Sync pulls in newly starred repos since your last visit. It runs automatically on first load; click it anytime to refresh.",
      coachStep2Title: "Filter by tags",
      coachStep2Body:
        "The Tags sidebar lists all your tags, sorted by how often they're used. Click any tag (the whole row) to filter the list. Hover a tag for the delete button.",
      coachStep3Title: "Open a repo",
      coachStep3Body:
        "Click any row to open the detail drawer — edit tags, write notes, and accept suggested tags there.",
      coachNext: "Next",
      coachBack: "Back",
      coachSkip: "Skip tour",
      coachDone: "Start using",
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
    manager: {
      syncFailed: (label, error) => `${label}: ${error}`,
      autoAssignDone: (count) =>
        `已从仓库 topics 为 ${count} 个仓库自动分配标签`,
      autoAssignFailed: (error) => `自动分配标签失败: ${error}`,
      deleteTagFailed: (error) => `删除标签失败: ${error}`,
      noTokenBanner: "未配置 GitHub token — 无法加载数据。",
      addPat: "打开选项页并添加 PAT",
      emptyState: "无结果。调整筛选，或点击工具栏中的 Sync。",
    },
    toolbar: {
      searchPlaceholder: "搜索 名称 / 描述 / topics / notes   (按 / 聚焦)",
      searchClearTitle: "清空搜索",
      sortStarredAt: "按 star 时间",
      sortPushedAt: "按更新时间",
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
      autoAssignButton: "自动分配标签",
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
      columnTags: "标签",
      columnFavorite: "收藏",
    },
    activeFilters: {
      onlyFavorite: "收藏",
      onlyUntagged: "仅未标注",
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
      deleteTagTitle: "删除该标签（所有仓库）",
      deleteTagConfirm: (name, count) =>
        count > 0
          ? `从全部 ${count} 个仓库删除标签「${name}」？此操作不可撤销。`
          : `删除标签「${name}」？`,
      deleteTagDone: (count) => `已从 ${count} 个仓库删除标签`,
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
      tokenHeading: "1. GitHub Token",
      tokenIntroPrefix: "在这里创建细粒度 PAT：",
      tokenLinkLabel: "github.com/settings/tokens",
      tokenIntroSuffix: "所需权限：",
      tokenPublicRepos:
        "Account · Public Repositories（通过 /user/starred 读取 stars）",
      tokenGists: "Account · Gists（读写，用于跨设备标签同步）",
      tokenGistNote:
        "注意：GitHub Gist 权限是账号级的（细粒度 token 不能按 gist 隔离）。我们会为同步创建一个专用 secret gist。",
      authenticatedAs: (username) => `已认证为 @${username}。`,
      removeToken: "移除 token",
      cachedAccountWarning: (username) =>
        `缓存账号 @${username} 仍在，但当前扩展实例里的 token 已不可用。`,
      clearCachedAuth: "清除缓存认证",
      saveVerify: "保存并验证",
      verifying: "验证中…",
      tokenVerified: (username) => `Token 验证成功，当前登录为 ${username}。`,
      tokenRemoved: "Token 已移除。",
      tokenStepsTitle: "如何创建 token(fine-grained PAT)",
      tokenStep1:
        "打开 GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。",
      tokenStep2: "Token 名称:随便填(如「stars-manager」)。过期时间:按需选择。",
      tokenStep3:
        "Repository access → 选「All public repositories」(扩展只读你 star 的公开仓库)。",
      tokenStep4:
        "Account permissions → 开启「Public Repositories (read)」和「Gists (read and write)」,其余全部关闭。",
      tokenStep5:
        "Generate → 复制 token(以 github_pat_ 开头)→ 粘贴到上面 → 保存并验证。",
      shotNewToken: "截图:「Generate new token」表单",
      shotRepoAccess: "截图:仓库访问设为所有公开仓库",
      shotPermissions:
        "截图:账号权限 —— Public Repositories (read) + Gists (read and write)",
      languageLabel: "语言",
      gistHeading: "2. Gist 同步",
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
        "该 token 能读取个人资料,但缺少「Public Repositories (read)」权限,请重新创建并勾选该权限。",
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
        "GitHub 拒绝了请求 (403)。token 可能缺少权限或仓库访问权限。",
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
      coachIntro: "下面是最常用的三处。跟着看一遍——本引导只显示一次。",
      coachStep1Title: "同步你的 stars",
      coachStep1Body:
        "Sync 按钮会拉取你自上次访问以来新 star 的仓库。首次加载会自动跑;想刷新随时点它。",
      coachStep2Title: "按标签筛选",
      coachStep2Body:
        "Tags 侧栏列出所有标签，按使用频次排序。点击任意标签(整行)即可筛选列表。鼠标悬停标签会出现删除按钮。",
      coachStep3Title: "打开某个仓库",
      coachStep3Body:
        "点击任意一行打开详情抽屉——在那里编辑标签、写笔记、接受建议标签。",
      coachNext: "下一步",
      coachBack: "上一步",
      coachSkip: "跳过引导",
      coachDone: "开始使用",
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
    await authStore.setLocale(next);
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
