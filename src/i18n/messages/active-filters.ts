export type ActiveFilterMessages = {
  onlyFavorite: string;
  onlyUntagged: string;
  onlyArchived: string;
  onlyOwned: string;
  summary: (count: number) => string;
  clearOne: string;
  clearAll: string;
};

export const enActiveFilterMessages: ActiveFilterMessages = {
  onlyFavorite: "Favorites",
  onlyUntagged: "Untagged only",
  onlyArchived: "Archived",
  onlyOwned: "My repositories",
  summary: (count) => `${count} results · filtered`,
  clearOne: "Remove this filter",
  clearAll: "Clear all filters",
};

export const zhActiveFilterMessages: ActiveFilterMessages = {
  onlyFavorite: "收藏",
  onlyUntagged: "仅未标注",
  onlyArchived: "已归档",
  onlyOwned: "我的仓库",
  summary: (count) => `${count} 个结果 · 已筛选`,
  clearOne: "移除该筛选",
  clearAll: "清除全部筛选",
};
