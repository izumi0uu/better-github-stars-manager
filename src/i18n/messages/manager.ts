export type ManagerMessages = {
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

export const enManagerMessages: ManagerMessages = {
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
};

export const zhManagerMessages: ManagerMessages = {
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
};
