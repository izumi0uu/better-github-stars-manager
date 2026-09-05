import type { SyncProgress } from '@/types';

export type CommonMessages = {
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
  copyRepository: string;
  copied: string;
  current: (value: string) => string;
  phase: (phase: SyncProgress["phase"]) => string;
};

export const enCommonMessages: CommonMessages = {
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
  copyRepository: "Copy repository URL",
  copied: "Copied!",
  current: (value) => `Current: ${value}`,
  phase: (phase) =>
    ({
      idle: "Idle",
      full: "Full",
      incremental: "Incremental",
      rescan: "Rescan",
      gist: "Gist",
    })[phase],
};

export const zhCommonMessages: CommonMessages = {
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
  copyRepository: "复制仓库链接",
  copied: "已复制",
  current: (value) => `当前: ${value}`,
  phase: (phase) =>
    ({
      idle: "空闲",
      full: "全量",
      incremental: "增量",
      rescan: "重扫",
      gist: "Gist",
    })[phase],
};
