export type ToolbarMessages = {
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

export const enToolbarMessages: ToolbarMessages = {
  searchPlaceholder:
    "Search name / description / topics / notes   (/ to focus)",
  searchClearTitle: "Clear search",
  sortStarredAt: "Sort by starred date",
  sortPushedAt: "Sort by updated date",
  sortCreatedAt: "Sort by repository creation date",
  sortStars: "Sort by stars",
  sortName: "Sort by name",
  toggleSortDir: "Toggle sort direction",
  syncTitle: "Sync new stars",
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
};

export const zhToolbarMessages: ToolbarMessages = {
  searchPlaceholder: "搜索 名称 / 描述 / topics / notes   (按 / 聚焦)",
  searchClearTitle: "清空搜索",
  sortStarredAt: "按 star 时间",
  sortPushedAt: "按更新时间",
  sortCreatedAt: "按仓库创建时间",
  sortStars: "按 star 数",
  sortName: "按名称",
  toggleSortDir: "切换排序方向",
  syncTitle: "同步新 Star",
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
};
