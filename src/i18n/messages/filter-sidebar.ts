export type FilterSidebarMessages = {
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

export const enFilterSidebarMessages: FilterSidebarMessages = {
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
};

export const zhFilterSidebarMessages: FilterSidebarMessages = {
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
  showTombstoneLabel: "显示已取消 Star",
  showTombstoneHint: "已取消 Star 的仓库",
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
};
