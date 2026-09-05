export type WatchStatusProgressField = 'count' | 'pages';

export type WatchStatusTextPart = string | Readonly<{
  field: WatchStatusProgressField;
  value: number;
}>;

export type WatchMessages = {
  starsSurface: string;
  watchSurface: string;
  watchSurfaceUnread: (count: number) => string;
  title: string;
  filterLabel: string;
  viewLabel: string;
  timelineView: string;
  repositoryView: string;
  searchPlaceholder: string;
  clearSearch: string;
  reasonFilter: string;
  reasonFilterSelected: (count: number) => string;
  reasonFilterClear: string;
  reasonPresets: string;
  reasonPresetAll: string;
  reasonPresetDirect: string;
  reasonPresetSecurity: string;
  reasonPresetParticipation: string;
  reasonPresetWatching: string;
  reasonPresetOther: string;
  reasonThreadCount: (count: number) => string;
  unread: string;
  all: string;
  refresh: string;
  refreshing: string;
  openOptions: string;
  configureMainToken: string;
  configureNotificationsToken: string;
  inboxNeverLoaded: string;
  queryFailed: string;
  refreshFailed: string;
  retry: string;
  inboxPermissionDenied: string;
  noUnreadThreads: string;
  noThreads: string;
  noMatchingThreads: string;
  statusFresh: (unread: number, watched: number) => string;
  statusRefreshingSaved: string;
  statusRefreshingScope: string;
  statusRefreshFailedSaved: string;
  statusScanPending: (count: number) => string;
  statusScanning: (count: number, pages: number) => readonly WatchStatusTextPart[];
  statusScanPartial: (count: number, pages: number) => string;
  statusCooldown: (time: string) => string;
  statusCredential: string;
  statusNeverLoaded: string;
  listEndSnapshot: (count: number) => string;
  listEndMatches: (count: number) => string;
  listEndWindow: string;
  listEndSaved: (count: number) => string;
  timelineToday: string;
  timelineYesterday: string;
  newBadge: string;
  newSinceLastVisit: string;
  loadOlder: string;
  loadingOlder: string;
  loadOlderFailed: string;
  historyComplete: (count: number) => string;
  staleSnapshot: string;
  scopeFailed: string;
  inboxFailed: string;
  cooldownUntil: (time: string) => string;
  threadCount: (count: number) => string;
  snapshotAt: (time: string) => string;
  manageOnGitHub: string;
  repositoryUnreadCount: (count: number) => string;
  unreadSnapshot: string;
  expandRepository: (repository: string) => string;
  collapseRepository: (repository: string) => string;
  markAsRead: string;
  markAsDone: string;
  markAllRead: string;
  markAllDone: string;
  markingRead: string;
  markingDone: string;
  actionReadFailed: string;
  actionDoneFailed: string;
  openSubjectOnGitHub: (subjectType: string) => string;
  threadDetails: string;
  threadReason: string;
  threadUpdated: string;
  threadStatus: string;
  readStatus: string;
  unreadStatus: string;
  subjectDetails: string;
  subjectDetailsLoading: string;
  subjectDetailsUnavailable: string;
  subjectDetailsAuthentication: string;
  subjectDetailsPermission: string;
  subjectStateOpen: string;
  subjectStateClosed: string;
  subjectStateReason: (reason: string) => string;
  subjectAuthor: (login: string) => string;
  subjectCreated: (time: string) => string;
  subjectComments: (count: number) => string;
  subjectLabels: string;
  subjectAssignees: (logins: string) => string;
  subjectMilestone: (title: string) => string;
  subjectNoDescription: string;
  subjectShowDescription: string;
  subjectCollapseDescription: string;
};

export const enWatchMessages: WatchMessages = {
  starsSurface: "Stars",
  watchSurface: "Watch",
  watchSurfaceUnread: (count) => `Watch, ${count} unread ${count === 1 ? "thread" : "threads"}`,
  title: "GitHub Notifications inbox",
  filterLabel: "Inbox thread filter",
  viewLabel: "View",
  timelineView: "Timeline",
  repositoryView: "Repository",
  searchPlaceholder: "Search repositories and threads",
  clearSearch: "Clear Watch search",
  reasonFilter: "Notification reasons",
  reasonFilterSelected: (count) => `Notification reasons, ${count} selected`,
  reasonFilterClear: "Clear reasons",
  reasonPresets: "Reason presets",
  reasonPresetAll: "All",
  reasonPresetDirect: "Direct",
  reasonPresetSecurity: "Security",
  reasonPresetParticipation: "Participation",
  reasonPresetWatching: "Watching",
  reasonPresetOther: "Other",
  reasonThreadCount: (count) => `${count} ${count === 1 ? "thread" : "threads"}`,
  unread: "Unread",
  all: "All",
  refresh: "Refresh Watch inbox",
  refreshing: "Refreshing…",
  openOptions: "Open options",
  configureMainToken: "Update the GitHub Classic PAT to load Watch data.",
  configureNotificationsToken: "Open Options and verify the Classic PAT has the notifications scope.",
  inboxNeverLoaded: "Refresh to scan your complete GitHub Notifications inbox.",
  queryFailed: "The Watch snapshot could not be loaded.",
  refreshFailed: "The latest Watch refresh failed; the previous snapshot remains available.",
  retry: "Retry",
  inboxPermissionDenied:
    "The GitHub Classic PAT cannot read Notifications. Add the notifications scope; other features still work.",
  noUnreadThreads: "No unread threads in the currently saved Inbox.",
  noThreads: "No notification threads are currently saved.",
  noMatchingThreads: "No threads match the current Watch search and reason filters.",
  statusFresh: (unread, watched) => `${unread} unread · currently watching ${watched} ${watched === 1 ? "repository" : "repositories"}`,
  statusRefreshingSaved: "Refreshing Inbox · showing saved rows",
  statusRefreshingScope: "Syncing watched repositories · showing saved Inbox",
  statusRefreshFailedSaved: "Couldn’t refresh · showing saved rows",
  statusScanPending: (count) => `Full Inbox scan needed · showing ${count} saved ${count === 1 ? "thread" : "threads"}`,
  statusScanning: (count, pages) => [
    "Scanning full Inbox · ",
    { field: 'count', value: count },
    count === 1 ? " thread found across " : " threads found across ",
    { field: 'pages', value: pages },
    pages === 1 ? " page" : " pages",
  ],
  statusScanPartial: (count, pages) => `Full Inbox scan paused · ${count} ${count === 1 ? "thread" : "threads"} found across ${pages} ${pages === 1 ? "page" : "pages"}`,
  statusCooldown: (time) => `Inbox complete · background polling resumes at ${time}`,
  statusCredential: "Classic PAT authorization required",
  statusNeverLoaded: "Ready to scan Inbox",
  listEndSnapshot: (count) => `End of saved snapshot · ${count} ${count === 1 ? "thread" : "threads"}`,
  listEndMatches: (count) => `End of matching results · ${count} ${count === 1 ? "thread" : "threads"}`,
  listEndWindow: "Current scan boundary · earlier Inbox threads remain",
  listEndSaved: (count) => `End of saved rows · full Inbox scan incomplete · ${count} ${count === 1 ? "thread" : "threads"}`,
  timelineToday: "Today",
  timelineYesterday: "Yesterday",
  newBadge: "New",
  newSinceLastVisit: "Updated since your last Watch visit",
  loadOlder: "Continue full Inbox scan",
  loadingOlder: "Scanning older notifications…",
  loadOlderFailed: "Full Inbox scan paused. Your saved timeline is unchanged.",
  historyComplete: (count) => `All caught up · ${count} ${count === 1 ? "thread" : "threads"}`,
  staleSnapshot: "Showing the last successful snapshot because the latest refresh failed.",
  scopeFailed: "Watched-repository membership could not be refreshed; Inbox coverage is unaffected.",
  inboxFailed: "The full Inbox scan could not continue.",
  cooldownUntil: (time) => `Background polling resumes at ${time}; manual refresh remains available.`,
  threadCount: (count) => `${count} ${count === 1 ? "thread" : "threads"}`,
  snapshotAt: (time) => `Snapshot checked ${time}`,
  manageOnGitHub: "Manage Watch settings on GitHub",
  repositoryUnreadCount: (count) => `${count} unread`,
  unreadSnapshot: "Unread at the time of this snapshot",
  markAsRead: "Mark as read",
  markAsDone: "Mark as done",
  markAllRead: "Mark all as read",
  markAllDone: "Mark all as done",
  markingRead: "Marking as read…",
  markingDone: "Marking as done…",
  actionReadFailed: "Couldn’t mark the selected notifications as read.",
  actionDoneFailed: "Couldn’t mark the selected notifications as done.",
  openSubjectOnGitHub: (subjectType) => `Open ${subjectType} in GitHub`,
  threadDetails: "Notification details",
  threadReason: "Reason",
  threadUpdated: "Updated",
  threadStatus: "Status",
  readStatus: "Read",
  unreadStatus: "Unread",
  subjectDetails: "Issue details",
  subjectDetailsLoading: "Loading issue details…",
  subjectDetailsUnavailable: "Issue details could not be loaded. Notification data is still available.",
  subjectDetailsAuthentication: "The saved GitHub Classic PAT was rejected or expired. Replace it in Options, then retry.",
  subjectDetailsPermission: "The GitHub Classic PAT needs the repo scope and access to this repository.",
  subjectStateOpen: "Open",
  subjectStateClosed: "Closed",
  subjectStateReason: (reason) => `State: ${reason.replace(/_/g, " ")}`,
  subjectAuthor: (login) => `by @${login}`,
  subjectCreated: (time) => `created ${time}`,
  subjectComments: (count) => `${count} ${count === 1 ? "comment" : "comments"}`,
  subjectLabels: "Labels",
  subjectAssignees: (logins) => `Assigned to ${logins}`,
  subjectMilestone: (title) => `Milestone: ${title}`,
  subjectNoDescription: "No description provided.",
  subjectShowDescription: "Show full description",
  subjectCollapseDescription: "Collapse description",
  expandRepository: (repository) => `Expand ${repository}`,
  collapseRepository: (repository) => `Collapse ${repository}`,
};

export const zhWatchMessages: WatchMessages = {
  starsSurface: "Stars",
  watchSurface: "Watch",
  watchSurfaceUnread: (count) => `Watch，${count} 条未读通知`,
  title: "GitHub 通知收件箱",
  filterLabel: "收件箱通知筛选",
  viewLabel: "视图",
  timelineView: "时间线",
  repositoryView: "仓库",
  searchPlaceholder: "搜索仓库和通知",
  clearSearch: "清除 Watch 搜索",
  reasonFilter: "通知原因",
  reasonFilterSelected: (count) => `通知原因，已选 ${count} 项`,
  reasonFilterClear: "清除原因筛选",
  reasonPresets: "原因预设",
  reasonPresetAll: "全部",
  reasonPresetDirect: "直接相关",
  reasonPresetSecurity: "安全",
  reasonPresetParticipation: "参与过",
  reasonPresetWatching: "Watching",
  reasonPresetOther: "其他",
  reasonThreadCount: (count) => `${count} 条通知`,
  unread: "未读",
  all: "全部",
  refresh: "刷新 Watch 收件箱",
  refreshing: "刷新中…",
  openOptions: "打开选项页",
  configureMainToken: "请更新 GitHub Classic PAT，以加载 Watch 数据。",
  configureNotificationsToken: "请在选项页确认 Classic PAT 已包含 notifications scope。",
  inboxNeverLoaded: "刷新后将完整扫描 GitHub 通知收件箱。",
  queryFailed: "无法加载 Watch 通知。",
  refreshFailed: "最近一次 Watch 刷新失败，仍可查看已有通知。",
  retry: "重试",
  inboxPermissionDenied:
    "GitHub Classic PAT 无法读取通知，请添加 notifications scope；其他功能仍可使用。",
  noUnreadThreads: "当前已保存的收件箱中没有未读通知。",
  noThreads: "当前没有已保存的通知。",
  noMatchingThreads: "没有通知匹配当前 Watch 搜索和通知原因筛选。",
  statusFresh: (unread, watched) => `未读 ${unread} · 当前 Watch 了 ${watched} 个仓库`,
  statusRefreshingSaved: "正在刷新收件箱 · 显示已保存数据",
  statusRefreshingScope: "正在同步 Watch 仓库 · 显示已保存的收件箱",
  statusRefreshFailedSaved: "刷新失败 · 显示已保存数据",
  statusScanPending: (count) => `需要完整扫描收件箱 · 当前显示 ${count} 条已保存通知`,
  statusScanning: (count, pages) => [
    "正在完整扫描收件箱 · 已扫描 ",
    { field: 'pages', value: pages },
    " 页，找到 ",
    { field: 'count', value: count },
    " 条通知",
  ],
  statusScanPartial: (count, pages) => `完整扫描已暂停 · 已扫描 ${pages} 页，找到 ${count} 条通知`,
  statusCooldown: (time) => `收件箱已完整同步 · 后台轮询将在 ${time} 恢复`,
  statusCredential: "需要 GitHub Classic PAT 鉴权",
  statusNeverLoaded: "等待扫描收件箱",
  listEndSnapshot: (count) => `已保存通知末尾 · 共 ${count} 条通知`,
  listEndMatches: (count) => `匹配结果末尾 · 共 ${count} 条通知`,
  listEndWindow: "当前扫描边界 · 仍有更早的收件箱通知待扫描",
  listEndSaved: (count) => `已保存数据末尾 · 完整扫描尚未结束 · 共 ${count} 条通知`,
  timelineToday: "今天",
  timelineYesterday: "昨天",
  newBadge: "新",
  newSinceLastVisit: "自上次查看 Watch 后有更新",
  loadOlder: "继续完整扫描收件箱",
  loadingOlder: "正在扫描更早的通知…",
  loadOlderFailed: "完整扫描已暂停，已保存的时间线未受影响。",
  historyComplete: (count) => `已看完所有通知 · 共 ${count} 条`,
  staleSnapshot: "最近一次刷新失败，当前仍显示上一次成功获取的通知。",
  scopeFailed: "无法刷新已 Watch 仓库成员关系；不影响 Inbox 覆盖范围。",
  inboxFailed: "无法继续完整扫描收件箱。",
  cooldownUntil: (time) => `后台轮询将在 ${time} 恢复；仍可手动刷新。`,
  threadCount: (count) => `${count} 条通知`,
  snapshotAt: (time) => `更新于 ${time}`,
  manageOnGitHub: "在 GitHub 管理 Watch 设置",
  repositoryUnreadCount: (count) => `${count} 个未读`,
  unreadSnapshot: "未读状态来自本次同步",
  markAsRead: "标记为已读",
  markAsDone: "标记为完成",
  markAllRead: "全部标记为已读",
  markAllDone: "全部标记为完成",
  markingRead: "正在标记为已读…",
  markingDone: "正在标记为完成…",
  actionReadFailed: "无法将所选通知标记为已读。",
  actionDoneFailed: "无法将所选通知标记为完成。",
  openSubjectOnGitHub: (subjectType) => `在 GitHub 打开 ${subjectType}`,
  threadDetails: "通知详情",
  threadReason: "原因",
  threadUpdated: "更新时间",
  threadStatus: "状态",
  readStatus: "已读",
  unreadStatus: "未读",
  subjectDetails: "Issue 详情",
  subjectDetailsLoading: "正在加载 Issue 详情…",
  subjectDetailsUnavailable: "无法加载 Issue 详情，通知信息仍可使用。",
  subjectDetailsAuthentication: "已保存的 GitHub Classic PAT 被拒绝或已过期。请在选项页更换后重试。",
  subjectDetailsPermission: "GitHub Classic PAT 需要 repo scope 和该仓库的访问权限。",
  subjectStateOpen: "Open",
  subjectStateClosed: "Closed",
  subjectStateReason: (reason) => `状态：${reason.replace(/_/g, " ")}`,
  subjectAuthor: (login) => `作者 @${login}`,
  subjectCreated: (time) => `创建于 ${time}`,
  subjectComments: (count) => `${count} 条评论`,
  subjectLabels: "标签",
  subjectAssignees: (logins) => `负责人：${logins}`,
  subjectMilestone: (title) => `里程碑：${title}`,
  subjectNoDescription: "未提供描述。",
  subjectShowDescription: "展开完整描述",
  subjectCollapseDescription: "收起描述",
  expandRepository: (repository) => `展开 ${repository}`,
  collapseRepository: (repository) => `收起 ${repository}`,
};
