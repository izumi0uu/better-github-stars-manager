export type RepoChipMessages = {
  untagged: string;
  filterByTag: (tag: string) => string;
  editTags: string;
};

export const enRepoChipMessages: RepoChipMessages = {
  untagged: "untagged",
  filterByTag: (tag) => `Filter stars by "${tag}"`,
  editTags: "Edit tags",
};

export const zhRepoChipMessages: RepoChipMessages = {
  untagged: "未标注",
  filterByTag: (tag) => `按 "${tag}" 筛选 stars`,
  editTags: "编辑标签",
};
