export type StarRowMessages = {
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

export const enStarRowMessages: StarRowMessages = {
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
};

export const zhStarRowMessages: StarRowMessages = {
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
};
