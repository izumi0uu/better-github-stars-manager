export type PopupMessages = {
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

export const enPopupMessages: PopupMessages = {
  title: "Better GitHub Stars Manager",
  noToken: "A GitHub Classic PAT is required.",
  addPat: "Add Classic PAT",
  idle: "Idle",
  syncIncremental: "Sync new stars",
  syncFull: "Full re-pull all stars",
  reconcile: "Reconcile stars",
  gistPull: "Pull tags from Gist",
  gistPush: "Push tags to Gist",
  testConnection: "Test Classic PAT",
  openStars: "Open my stars page",
  options: "Options…",
  starRepoTitle: "Like the project? Leave a star:)",
  testing: "Testing Classic PAT…",
  rate: (remaining, limit) => `rate: ${remaining}/${limit} remaining`,
  scopes: (scopes) => `scopes: ${scopes ?? "not reported — use a Classic PAT"}`,
  itemsOnPage: (count) => `items on page 1: ${count}`,
  sample: (sample) => `sample: ${sample ?? "—"}`,
  connectionOk: "OK — Classic PAT verified",
  connectionNoContent:
    "204 No Content — the Classic PAT may lack starred-repository access",
  connectionRejected: "401 — Classic PAT rejected or expired",
  connectionForbidden: "403 — Classic PAT lacks required scopes or repository access",
  failed: (label, error) => `${label} failed: ${error}`,
};

export const zhPopupMessages: PopupMessages = {
  title: "Better GitHub Stars Manager",
  noToken: "应用需要 GitHub Classic PAT 鉴权。",
  addPat: "添加 Classic PAT",
  idle: "空闲",
  syncIncremental: "同步新 Star",
  syncFull: "全量重新拉取所有 stars",
  reconcile: "校正 stars 状态",
  gistPull: "从 Gist 拉取标签",
  gistPush: "推送标签到 Gist",
  testConnection: "测试 Classic PAT",
  openStars: "打开我的 stars 页面",
  options: "选项…",
  starRepoTitle: "点个Star~",
  testing: "正在测试 Classic PAT…",
  rate: (remaining, limit) => `限额: ${remaining}/${limit} 剩余`,
  scopes: (scopes) => `权限: ${scopes ?? "未返回，请使用 Classic PAT"}`,
  itemsOnPage: (count) => `第 1 页条目数: ${count}`,
  sample: (sample) => `示例: ${sample ?? "—"}`,
  connectionOk: "正常 — Classic PAT 已验证",
  connectionNoContent: "204 No Content — Classic PAT 可能缺少 starred 仓库访问权限",
  connectionRejected: "401 — Classic PAT 被拒绝或已过期",
  connectionForbidden: "403 — Classic PAT 缺少所需 scopes 或仓库访问权限",
  failed: (label, error) => `${label} 失败: ${error}`,
};
