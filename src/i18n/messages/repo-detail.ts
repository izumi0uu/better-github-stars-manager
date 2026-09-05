export type RepoDetailMessages = {
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

export const enRepoDetailMessages: RepoDetailMessages = {
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
};

export const zhRepoDetailMessages: RepoDetailMessages = {
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
};
