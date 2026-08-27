export type BackgroundMessages = {
  noToken: string;
  unknownBackfill: (id: string) => string;
  unsupportedBackfillKind: (kind: string) => string;
  incrementalSyncing: string;
  incrementalDone: (added: number) => string;
  fullDone: (count: number) => string;
  rescanDone: (tombstoned: number, revived: number) => string;
  autoAssignTagging: string;
  autoAssignDone: (tagged: number) => string;
  fetchingPages: (total: number) => string;
  fetchingPageRetry: (page: number, attempt: number) => string;
  syncedRepos: (count: number) => string;
  rescanningPages: (total: number) => string;
  reconcilingLocal: (count: number) => string;
  rescanSummary: (tombstoned: number, revived: number) => string;
  pushingTags: string;
  pullingTags: string;
  gistPushDone: (count: number) => string;
  gistPushRecreated: string;
  gistPushNoChanges: string;
  gistPullDone: (merged: number, total: number) => string;
  gistPullMissing: string;
  watchStatusUnavailable: string;
  watchInboxQueryInvalid: string;
  watchInboxUnavailable: string;
  watchRepositoryInvalid: string;
  watchRepositoryDetailUnavailable: string;
  watchRefreshFailed: string;
  watchDisconnectFailed: string;
  watchDataClearFailed: string;
  watchThreadActionInvalid: string;
  watchThreadActionFailed: string;
  watchSubjectDetailInvalid: string;
  watchSubjectDetailError: (code: string) => string;
};

export const enBackgroundMessages: BackgroundMessages = {
  noToken: "No token configured",
  unknownBackfill: (id) => `Unknown backfill: ${id}`,
  unsupportedBackfillKind: (kind) => `Unsupported backfill kind: ${kind}`,
  incrementalSyncing: "Checking for new stars…",
  incrementalDone: (added) => `+${added} new`,
  fullDone: (count) => `Full sync done · ${count} repos refreshed`,
  rescanDone: (tombstoned, revived) => `Rescan done · ${tombstoned} removed, ${revived} restored`,
  autoAssignTagging: "Adding local tags from repository topics…",
  autoAssignDone: (tagged) => `Auto Tags complete · ${tagged} repositories tagged`,
  fetchingPages: (total) => `Fetching ${total} pages…`,
  fetchingPageRetry: (page, attempt) => `Retrying page ${page} (attempt ${attempt})…`,
  syncedRepos: (count) => `Synced ${count} repos`,
  rescanningPages: (total) => `Rescanning ${total} pages…`,
  reconcilingLocal: (count) => `Reconciling ${count} local repos…`,
  rescanSummary: (tombstoned, revived) => `Rescan: ${tombstoned} removed from live set, ${revived} restored`,
  pushingTags: "Uploading tag snapshot to Gist…",
  pullingTags: "Pulling tags from Gist…",
  gistPushDone: (count) => `Pushed ${count} changed tag records to Gist`,
  gistPushRecreated:
    "Created a new sync Gist and uploaded your tag snapshot",
  gistPushNoChanges: "No local tag changes to push",
  gistPullDone: (merged, total) =>
    `Pulled ${merged} updates from ${total} remote tag records`,
  gistPullMissing:
    "The linked sync Gist was missing; the app unbound it on this device. Push to create a new one.",
  watchStatusUnavailable: "Watch status is unavailable.",
  watchInboxQueryInvalid: "Invalid Watch inbox query.",
  watchInboxUnavailable: "Watch inbox is unavailable.",
  watchRepositoryInvalid: "Invalid Watch repository.",
  watchRepositoryDetailUnavailable: "Watch repository detail is unavailable.",
  watchRefreshFailed: "Watch refresh failed.",
  watchDisconnectFailed: "Watch Inbox disconnect failed.",
  watchDataClearFailed: "Watch data could not be cleared.",
  watchThreadActionInvalid: "Invalid Watch notification selection.",
  watchThreadActionFailed: "The Watch notification action failed.",
  watchSubjectDetailInvalid: "Invalid Watch notification detail request.",
  watchSubjectDetailError: (code) => {
    switch (code) {
      case "authentication_required":
      case "permission_denied":
        return "The main GitHub token cannot read this Issue or Pull Request. Add Issues: read and repository access.";
      case "subject_not_found":
        return "This Issue or Pull Request is unavailable.";
      case "rate_limited":
        return "GitHub rate-limited this detail request. Retry later.";
      case "credential_changed":
        return "The GitHub connection changed while details were loading. Retry.";
      default:
        return "Issue details could not be loaded. Notification data is still available.";
    }
  },
};

export const zhBackgroundMessages: BackgroundMessages = {
  noToken: "未配置 token",
  unknownBackfill: (id) => `未知 backfill：${id}`,
  unsupportedBackfillKind: (kind) => `不支持的 backfill 类型：${kind}`,
  incrementalSyncing: "正在检查新 Star…",
  incrementalDone: (added) => `新增 ${added} 个`,
  fullDone: (count) => `全量同步完成 · 刷新 ${count} 个仓库`,
  rescanDone: (tombstoned, revived) => `重扫完成 · 移出 ${tombstoned} 个，恢复 ${revived} 个`,
  autoAssignTagging: "正在根据仓库主题添加本地标签…",
  autoAssignDone: (tagged) => `Auto Tags 已完成 · ${tagged} 个仓库已添加标签`,
  fetchingPages: (total) => `正在获取 ${total} 页…`,
  fetchingPageRetry: (page, attempt) => `正在重试第 ${page} 页（第 ${attempt} 次）…`,
  syncedRepos: (count) => `已同步 ${count} 个仓库`,
  rescanningPages: (total) => `正在重扫 ${total} 页…`,
  reconcilingLocal: (count) => `正在校对本地 ${count} 个仓库…`,
  rescanSummary: (tombstoned, revived) => `重扫结果：移出已取消 Star ${tombstoned} 个，恢复 ${revived} 个`,
  pushingTags: "正在把标签快照上传到 Gist…",
  pullingTags: "正在从 Gist 拉取标签…",
  gistPushDone: (count) => `已向 Gist 推送 ${count} 条变更标签记录`,
  gistPushRecreated: "已创建新的同步 Gist，并上传当前标签快照",
  gistPushNoChanges: "没有需要推送的本地标签变更",
  gistPullDone: (merged, total) =>
    `已从 ${total} 条远端标签记录中合并 ${merged} 条更新`,
  gistPullMissing:
    "已绑定的同步 Gist 不见了；本设备已解绑。你可以点 Push 重新创建。",
  watchStatusUnavailable: "Watch 状态暂时不可用。",
  watchInboxQueryInvalid: "Watch 收件箱查询无效。",
  watchInboxUnavailable: "Watch 收件箱暂时不可用。",
  watchRepositoryInvalid: "Watch 仓库无效。",
  watchRepositoryDetailUnavailable: "Watch 仓库详情暂时不可用。",
  watchRefreshFailed: "Watch 刷新失败。",
  watchDisconnectFailed: "断开 Watch 收件箱失败。",
  watchDataClearFailed: "无法清除 Watch 数据。",
  watchThreadActionInvalid: "Watch 通知选择无效。",
  watchThreadActionFailed: "Watch 通知操作失败。",
  watchSubjectDetailInvalid: "Watch 通知详情请求无效。",
  watchSubjectDetailError: (code) => {
    switch (code) {
      case "authentication_required":
      case "permission_denied":
        return "主 GitHub token 无法读取此 Issue 或 Pull Request，请添加 Issues: read 和对应仓库访问权限。";
      case "subject_not_found":
        return "此 Issue 或 Pull Request 不可用。";
      case "rate_limited":
        return "GitHub 限制了此次详情请求，请稍后重试。";
      case "credential_changed":
        return "加载详情时 GitHub 连接发生变化，请重试。";
      default:
        return "无法加载 Issue 详情，通知信息仍可使用。";
    }
  },
};
