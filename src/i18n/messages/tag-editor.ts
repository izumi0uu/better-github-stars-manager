export type TagEditorMessages = {
  noTags: string;
  filterByTag: (tag: string) => string;
  clearTagFilter: (tag: string) => string;
  removeTag: string;
  addTagPlaceholder: string;
  addTagButton: string;
  bulkEditTitle: string;
  bulkPlaceholder: string;
};

export const enTagEditorMessages: TagEditorMessages = {
  noTags: "No tags yet",
  filterByTag: (tag) => `Filter by "${tag}"`,
  clearTagFilter: (tag) => `Filtering by "${tag}" — click to remove`,
  removeTag: "Remove tag",
  addTagPlaceholder: "Add a tag, press Enter to confirm",
  addTagButton: "Add",
  bulkEditTitle: "Bulk edit (comma-separated)",
  bulkPlaceholder: "tag1, tag2, …",
};

export const zhTagEditorMessages: TagEditorMessages = {
  noTags: "尚无标签",
  filterByTag: (tag) => `按 "${tag}" 筛选`,
  clearTagFilter: (tag) => `正在按 "${tag}" 筛选，点击移除`,
  removeTag: "移除标签",
  addTagPlaceholder: "添加标签，按回车确认",
  addTagButton: "添加",
  bulkEditTitle: "批量编辑（逗号分隔）",
  bulkPlaceholder: "tag1, tag2, …",
};
