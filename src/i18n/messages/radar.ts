import {
  RADAR_MAX_FOLLOWING,
  type RadarPartialReason,
  type RadarRefreshMode,
} from '@/radar/radar-model';

export type RadarMessages = {
  surface: string;
  surfaceUnseen: (count: number) => string;
  title: string;
  viewLabel: string;
  feed: string;
  projects: string;
  toggleView: string;
  discoverViewLabel: string;
  following: string;
  forYou: string;
  openTrending: string;
  forYouSearchPlaceholder: string;
  clearForYouSearch: string;
  forYouSearchResultCount: (count: number) => string;
  forYouSearchEmpty: (query: string) => string;
  recommendationsRefreshing: string;
  recommendationsRefreshingSaved: string;
  recommendationsNewBatch: string;
  recommendationsQueryFailed: string;
  recommendationsRefreshFailed: string;
  recommendationsNeverLoadedTitle: string;
  recommendationsNeverLoadedBody: string;
  recommendationsRunFirstScan: string;
  recommendationsEmptyTitle: string;
  recommendationsEmptyBody: string;
  recommendationsStale: string;
  recommendationsCooldownUntil: (time: string) => string;
  recommendationsFreshSummary: (count: number) => string;
  recommendationsSnapshotAt: (time: string) => string;
  recommendationsListEnd: (count: number) => string;
  recommendationsListEndSaved: (count: number) => string;
  becauseYouStarred: (repository: string) => string;
  recommendationReason: (kind: string, value: string) => string;
  recommendationStarAction: string;
  starRecommendation: (repository: string) => string;
  ignoreRecommendation: (repository: string) => string;
  ignoredCount: (count: number) => string;
  recommendationIgnoreHint: string;
  restoreIgnoredAction: string;
  restoreIgnored: (repository: string) => string;
  sourceLabel: string;
  sourceFollowing: string;
  sourceSelf: string;
  sourceFollowingHint: string;
  sourceSelfHint: string;
  refresh: string;
  refreshing: string;
  statusLabel: (status: string) => string;
  openOptions: string;
  retry: string;
  configureMainToken: string;
  neverLoadedTitle: string;
  neverLoadedBody: string;
  runFirstScan: string;
  queryFailed: string;
  refreshFailed: string;
  permissionTitle: string;
  permissionBody: string;
  emptyTitle: string;
  emptyBody: (windowDays: number) => string;
  filteredEmptyTitle: string;
  filteredEmptyBody: (windowDays: number) => string;
  searchPlaceholder: string;
  clearSearch: string;
  searchResultCount: (count: number) => string;
  searchEmpty: (query: string) => string;
  statusRefreshingSaved: string;
  statusReconcilingSaved: string;
  statusReconciliationPaused: (completed: number, total: number | null) => string;
  statusReconciliationRatePaused: (time: string) => string;
  statusRefreshFailedSaved: string;
  fullReconcile: string;
  resumeFullReconcile: string;
  fullReconciling: string;
  fullReconcileHint: string;
  resumeFullReconcileHint: string;
  statusPartial: string;
  statusCooldown: (time: string) => string;
  statusPermission: string;
  listEndActivities: (windowDays: number, count: number) => string;
  listEndProjects: (windowDays: number, count: number) => string;
  listEndMatches: (count: number) => string;
  listEndPartial: string;
  listEndSaved: (count: number) => string;
  freshSummary: (activities: number, following: number) => string;
  partialSnapshot: (count: number) => string;
  partialReason: (reason: RadarPartialReason, windowDays: number) => string;
  staleSnapshot: string;
  cooldownUntil: (time: string) => string;
  snapshotAt: (time: string) => string;
  snapshotProvenance: (mode: RadarRefreshMode, windowDays: number) => string;
  publicActivityOnly: (windowDays: number) => string;
  actorStarred: string;
  openActorProfile: (actor: string) => string;
  inLibrary: string;
  followedStars: (count: number) => string;
  latest: string;
  expandProject: (repository: string) => string;
  collapseProject: (repository: string) => string;
  followedStarTimeline: string;
  starredThisRepository: string;
  quickActions: (repository: string) => string;
  projectActions: (repository: string) => string;
  starOnGitHub: string;
  unstarOnGitHub: string;
  favorite: string;
  addTag: string;
  addTagAction: string;
  addingTagStars: string;
  suggestedTags: string;
  repositoryTags: string;
  repositoryTagScope: string;
  noTags: string;
  tagComposerHint: string;
  openRepository: string;
  actionFailed: (error: string) => string;
  keyboardHint: string;
  unseenActivity: string;
  unseenProject: string;
  dismissActivity: (actor: string, repository: string) => string;
  dismissProject: (repository: string) => string;
};

export const enRadarMessages: RadarMessages = {
  surface: "Following",
  surfaceUnseen: (count) => `Following, ${count} unseen ${count === 1 ? "activity" : "activities"}`,
  title: "Recent stars",
  viewLabel: "Following view",
  feed: "Feed",
  projects: "Projects",
  toggleView: "Switch Following view (V)",
  discoverViewLabel: "Discover view",
  following: "Following",
  forYou: "For You",
  openTrending: "Open GitHub Trending",
  forYouSearchPlaceholder: "Search recommendations",
  clearForYouSearch: "Clear For You search",
  forYouSearchResultCount: (count) => `${count} matching ${count === 1 ? "recommendation" : "recommendations"}`,
  forYouSearchEmpty: (query) => `No recommendations match “${query}”.`,
  recommendationsRefreshing: "Refreshing recommendations…",
  recommendationsRefreshingSaved: "Refreshing · showing saved recommendations",
  recommendationsNewBatch: "New batch",
  recommendationsQueryFailed: "Recommendations could not be loaded.",
  recommendationsRefreshFailed: "The latest refresh failed; saved recommendations remain available.",
  recommendationsNeverLoadedTitle: "For You hasn’t been generated yet",
  recommendationsNeverLoadedBody:
    "Generate a private recommendation list from your current stars and public GitHub Search results.",
  recommendationsRunFirstScan: "Generate recommendations",
  recommendationsEmptyTitle: "No recommendations yet",
  recommendationsEmptyBody:
    "Your current stars did not produce a strong public match. Star more repositories or refresh later.",
  recommendationsStale: "Showing saved recommendations because the latest refresh failed or is stale.",
  recommendationsCooldownUntil: (time) => `GitHub Search rate limit reached. Refresh unlocks at ${time}.`,
  recommendationsFreshSummary: (count) => `${count} ${count === 1 ? "recommendation" : "recommendations"}`,
  recommendationsSnapshotAt: (time) => `Recommendations checked ${time}`,
  recommendationsListEnd: (count) => `End of recommendations · ${count}`,
  recommendationsListEndSaved: (count) => `End of saved recommendations · ${count}`,
  becauseYouStarred: (repository) => `Because you starred ${repository}`,
  recommendationReason: (kind, value) => ({
    topic: `shared topic · ${value}`,
    language: `same language · ${value}`,
    owner: `same owner · ${value}`,
    keyword: `related keyword · ${value}`,
    name: `related repository name · ${value}`,
  } as Record<string, string>)[kind] ?? value,
  recommendationStarAction: "Star",
  starRecommendation: (repository) => `Star ${repository} on GitHub`,
  ignoreRecommendation: (repository) => `Never recommend ${repository} again`,
  ignoredCount: (count) => `${count} ignored ${count === 1 ? "repository" : "repositories"}`,
  recommendationIgnoreHint: "Never show this repository in my recommendations again",
  restoreIgnoredAction: "Restore",
  restoreIgnored: (repository) => `Recommend ${repository} again`,
  sourceLabel: "Activity sources",
  sourceFollowing: "Following",
  sourceSelf: "Me",
  sourceFollowingHint: "Stars from people you follow",
  sourceSelfHint: "Your own stars",
  refresh: "Refresh",
  refreshing: "Scanning…",
  statusLabel: (status) => ({
    partial: "Partial",
    stale: "Stale",
    cooldown: "Cooldown",
    error: "Error",
  } as Record<string, string>)[status] ?? status,
  openOptions: "Open options",
  retry: "Retry",
  configureMainToken:
    "Add the read:user scope to the GitHub Classic PAT so Following can read the accounts you follow.",
  neverLoadedTitle: "Following hasn’t been scanned yet",
  neverLoadedBody:
    "Scan recent public stars from accounts you follow. Nothing has been scanned so far.",
  runFirstScan: "Run first scan",
  queryFailed: "Following activity could not be loaded.",
  refreshFailed: "The latest scan failed; the previous snapshot remains available.",
  permissionTitle: "GitHub Classic PAT authorization required",
  permissionBody:
    "Following Radar needs the read:user scope on the GitHub Classic PAT. Stars, tags, Gist, and sync are unaffected.",
  emptyTitle: "No recent stars",
  emptyBody: (windowDays) => `No star activity was found in the last ${windowDays} days.`,
  filteredEmptyTitle: "No activity from selected sources",
  filteredEmptyBody: (windowDays) => `Adjust Following and Me to show recent stars from the last ${windowDays} days.`,
  searchPlaceholder: "Search people or repositories",
  clearSearch: "Clear Following search",
  searchResultCount: (count) => `${count} matching ${count === 1 ? "activity" : "activities"}`,
  searchEmpty: (query) => `No activity matches “${query}”.`,
  statusRefreshingSaved: "Scanning · showing saved activity",
  statusReconcilingSaved: "Full sync · showing saved activity",
  statusReconciliationPaused: (completed, total) => total === null
    ? `Full sync paused · ${completed} accounts completed · saved activity remains visible`
    : `Full sync paused · ${completed} of ${total} accounts completed · saved activity remains visible`,
  statusReconciliationRatePaused: (time) => `Full sync paused until ${time} while GitHub quota recovers.`,
  statusRefreshFailedSaved: "Couldn’t scan · showing saved activity",
  fullReconcile: "Full sync",
  resumeFullReconcile: "Resume full sync",
  fullReconciling: "Full syncing…",
  fullReconcileHint: "Attempts a complete scan of the selected history window. Saved activity remains visible while it runs; it may use more GitHub quota and take longer.",
  resumeFullReconcileHint: "Resume the saved full scan from its last checkpoint. Saved activity remains visible while it continues.",
  statusPartial: "Partial results · some activity may be missing",
  statusCooldown: (time) => `Scan available at ${time}`,
  statusPermission: "Following needs access to your following graph",
  listEndActivities: (windowDays, count) => `Showing all activity from the last ${windowDays} days · ${count} ${count === 1 ? "activity" : "activities"}`,
  listEndProjects: (windowDays, count) => `Showing all projects from the last ${windowDays} days · ${count} ${count === 1 ? "project" : "projects"}`,
  listEndMatches: (count) => `End of matching results · ${count}`,
  listEndPartial: "End of fetched results · some activity may be missing",
  listEndSaved: (count) => `End of saved activity · ${count} ${count === 1 ? "item" : "items"}`,
  freshSummary: (activities, following) => `${activities} activities · ${following} following`,
  partialSnapshot: (count) =>
    `Partial snapshot — ${count} known ${count === 1 ? "gap" : "gaps"}`,
  partialReason: (reason, windowDays) => ({
    github_star_list_truncated: `Some highly active accounts could not be fully retrieved for the ${windowDays}-day range.`,
    private_activity_omitted: "Private followed-star activity was omitted.",
    following_scan_truncated: "Not every followed account could be scanned.",
    following_cap_reached: `Following covers your ${RADAR_MAX_FOLLOWING} most recently followed accounts.`,
  })[reason],
  staleSnapshot: "Showing saved activity because the latest snapshot is stale.",
  cooldownUntil: (time) => `GitHub rate limit reached. Scanning unlocks at ${time}.`,
  snapshotAt: (time) => `Snapshot checked ${time}`,
  snapshotProvenance: (mode, windowDays) => mode === 'full'
    ? `Full sync · last ${windowDays} days`
    : `Incremental update · last ${windowDays} days`,
  publicActivityOnly: (windowDays) => `Public followed activity · last ${windowDays} days`,
  actorStarred: "starred",
  openActorProfile: (actor) => `Open @${actor} on GitHub`,
  inLibrary: "in your library",
  followedStars: (count) => `${count} followed ${count === 1 ? "star" : "stars"}`,
  latest: "latest",
  expandProject: (repository) => `Show details for ${repository}`,
  collapseProject: (repository) => `Hide details for ${repository}`,
  followedStarTimeline: "Followed-star timeline",
  starredThisRepository: "starred this repository",
  quickActions: (repository) => `Quick actions for ${repository}`,
  projectActions: (repository) => `Repository actions for ${repository}`,
  starOnGitHub: "Star on GitHub",
  unstarOnGitHub: "Unstar on GitHub",
  favorite: "Favorite",
  addTag: "Add tag…",
  addTagAction: "Add tag",
  addingTagStars: "Adding a tag stars this repository first",
  suggestedTags: "Suggested tags",
  repositoryTags: "Tags on this repository",
  repositoryTagScope: "Shared by every Feed entry for this repository.",
  noTags: "No tags yet.",
  tagComposerHint: "Enter to apply · Esc to close",
  openRepository: "Open repository",
  actionFailed: (error) => `Action failed: ${error}`,
  keyboardHint: "↑↓ navigate · Enter apply · Esc close",
  unseenActivity: "Unseen activity",
  unseenProject: "Project has unseen activity",
  dismissActivity: (actor, repository) => `Dismiss activity: ${actor} starred ${repository}`,
  dismissProject: (repository) => `Dismiss ${repository} from Following`,
};

export const zhRadarMessages: RadarMessages = {
  surface: "Following",
  surfaceUnseen: (count) => `Following，${count} 条未查看动态`,
  title: "近期 Star",
  viewLabel: "关注动态视图",
  feed: "动态",
  projects: "项目",
  discoverViewLabel: "发现视图",
  following: "关注动态",
  forYou: "为你推荐",
  openTrending: "打开 GitHub Trending",
  forYouSearchPlaceholder: "搜索推荐仓库",
  clearForYouSearch: "清除为你推荐搜索",
  forYouSearchResultCount: (count) => `匹配 ${count} 个推荐仓库`,
  forYouSearchEmpty: (query) => `没有推荐仓库匹配“${query}”。`,
  recommendationsRefreshing: "正在刷新推荐…",
  recommendationsRefreshingSaved: "刷新中 · 显示已保存推荐",
  recommendationsNewBatch: "换一批",
  recommendationsQueryFailed: "无法加载推荐仓库。",
  recommendationsRefreshFailed: "最近一次刷新失败，仍可查看已保存推荐。",
  recommendationsNeverLoadedTitle: "尚未生成“为你推荐”",
  recommendationsNeverLoadedBody: "根据你当前的 Stars 和 GitHub 公开搜索结果生成私有推荐列表。",
  recommendationsRunFirstScan: "生成推荐",
  recommendationsEmptyTitle: "暂无推荐",
  recommendationsEmptyBody: "当前 Stars 未产生足够相关的公开仓库。可继续 Star 仓库或稍后刷新。",
  recommendationsStale: "最近一次刷新失败或结果已过期，当前显示已保存推荐。",
  recommendationsCooldownUntil: (time) => `已触发 GitHub Search 速率限制，${time} 后可再次刷新。`,
  recommendationsFreshSummary: (count) => `${count} 个推荐仓库`,
  recommendationsSnapshotAt: (time) => `推荐检查于 ${time}`,
  recommendationsListEnd: (count) => `推荐末尾 · 共 ${count} 项`,
  recommendationsListEndSaved: (count) => `已保存推荐末尾 · 共 ${count} 项`,
  becauseYouStarred: (repository) => `因为你 Star 了 ${repository}`,
  recommendationReason: (kind, value) => ({
    topic: `共同 topic · ${value}`,
    language: `相同语言 · ${value}`,
    owner: `相同所有者 · ${value}`,
    keyword: `相关关键词 · ${value}`,
    name: `相关仓库名称 · ${value}`,
  } as Record<string, string>)[kind] ?? value,
  recommendationStarAction: "Star",
  starRecommendation: (repository) => `在 GitHub Star ${repository}`,
  ignoreRecommendation: (repository) => `不再推荐 ${repository}`,
  ignoredCount: (count) => `已忽略 ${count} 个仓库`,
  recommendationIgnoreHint: "这个仓库将不再出现在我的推荐中",
  restoreIgnoredAction: "恢复",
  restoreIgnored: (repository) => `恢复推荐 ${repository}`,
  toggleView: "切换关注动态视图（V）",
  sourceLabel: "动态来源",
  sourceFollowing: "关注的人",
  sourceSelf: "我",
  sourceFollowingHint: "你关注的人的 Star 动态",
  sourceSelfHint: "你自己的 Star 动态",
  refresh: "刷新",
  refreshing: "扫描中…",
  statusLabel: (status) => ({
    partial: "部分",
    stale: "已过期",
    cooldown: "冷却中",
    error: "错误",
  } as Record<string, string>)[status] ?? status,
  openOptions: "打开选项页",
  retry: "重试",
  configureMainToken: "请为 GitHub Classic PAT 添加 read:user scope，以读取你关注的账号。",
  neverLoadedTitle: "尚未扫描关注动态",
  neverLoadedBody: "扫描你所关注账号最近公开 Star 的仓库。目前还没有执行过扫描。",
  runFirstScan: "开始首次扫描",
  queryFailed: "无法加载关注动态。",
  refreshFailed: "最近一次扫描失败，仍可查看之前的快照。",
  permissionTitle: "需要 GitHub Classic PAT 鉴权",
  permissionBody:
    "Following Radar 需要 GitHub Classic PAT 的 read:user scope。Stars、标签、Gist 和同步不受影响。",
  emptyTitle: "暂无近期 Star",
  emptyBody: (windowDays) => `最近 ${windowDays} 天未发现 Star 动态。`,
  filteredEmptyTitle: "所选来源没有动态",
  filteredEmptyBody: (windowDays) => `调整“关注的人”和“我”，查看最近 ${windowDays} 天的 Star 动态。`,
  searchPlaceholder: "搜索人物或仓库",
  clearSearch: "清除 Following 搜索",
  searchResultCount: (count) => `匹配 ${count} 条动态`,
  searchEmpty: (query) => `没有动态匹配“${query}”。`,
  statusRefreshingSaved: "扫描中 · 显示已保存动态",
  statusReconcilingSaved: "全量同步 · 显示已保存动态",
  statusReconciliationPaused: (completed, total) => total === null
    ? `全量同步已暂停 · 已同步 ${completed} 个账号 · 当前展示已有动态`
    : `全量同步已暂停 · 已同步 ${completed}/${total} 个账号 · 当前展示已有动态`,
  statusReconciliationRatePaused: (time) => `全量同步已暂停，等待 GitHub 配额于 ${time} 后恢复。`,
  statusRefreshFailedSaved: "扫描失败 · 显示已保存动态",
  fullReconcile: "全量同步",
  resumeFullReconcile: "继续全量同步",
  fullReconciling: "全量同步中…",
  fullReconcileHint: "完整扫描设定天数内的全部动态；同步期间仍可浏览已有数据，该操作耗时较长并消耗更多 GitHub 配额。",
  resumeFullReconcileHint: "从上次中断处继续全量同步；同步期间仍可浏览已有动态。",
  statusPartial: "部分结果 · 可能缺少部分动态",
  statusCooldown: (time) => `可在 ${time} 后扫描`,
  statusPermission: "关注动态需要读取关注列表的权限",
  listEndActivities: (windowDays, count) => `已展示最近 ${windowDays} 天的全部动态 · 共 ${count} 条`,
  listEndProjects: (windowDays, count) => `已展示最近 ${windowDays} 天涉及的全部项目 · 共 ${count} 个`,
  listEndMatches: (count) => `匹配结果末尾 · 共 ${count} 项`,
  listEndPartial: "已获取结果末尾 · 可能缺少部分动态",
  listEndSaved: (count) => `已保存动态末尾 · 共 ${count} 项`,
  freshSummary: (activities, following) => `${activities} 条动态 · 关注 ${following} 人`,
  partialSnapshot: (count) => `部分结果 · 包含 ${count} 项未完整扫描`,
  partialReason: (reason, windowDays) => ({
    github_star_list_truncated: `部分活跃账号历史 Star 较多，未能完整获取最近 ${windowDays} 天的全部记录。`,
    private_activity_omitted: "已省略关注账号的私有 Star 动态。",
    following_scan_truncated: "未能扫描全部关注账号。",
    following_cap_reached: `Following 覆盖你最近关注的 ${RADAR_MAX_FOLLOWING} 个账号。`,
  })[reason],
  staleSnapshot: "数据已有一段时间未更新，当前显示上次同步结果。",
  cooldownUntil: (time) => `已触发 GitHub 速率限制，${time} 后可再次扫描。`,
  snapshotAt: (time) => `更新于 ${time}`,
  snapshotProvenance: (mode, windowDays) => mode === 'full'
    ? `全量同步 · 最近 ${windowDays} 天`
    : `增量更新 · 最近 ${windowDays} 天`,
  publicActivityOnly: (windowDays) => `公开关注动态 · 最近 ${windowDays} 天`,
  actorStarred: "Star 了",
  openActorProfile: (actor) => `在 GitHub 打开 @${actor} 的主页`,
  inLibrary: "已在你的 Stars 中",
  followedStars: (count) => `${count} 条关注 Star 动态`,
  latest: "最新",
  expandProject: (repository) => `展开 ${repository} 的详情`,
  collapseProject: (repository) => `收起 ${repository} 的详情`,
  followedStarTimeline: "关注 Star 时间线",
  starredThisRepository: "Star 了此仓库",
  quickActions: (repository) => `${repository} 的快捷操作`,
  projectActions: (repository) => `${repository} 的仓库操作`,
  starOnGitHub: "在 GitHub Star",
  unstarOnGitHub: "在 GitHub 取消 Star",
  favorite: "收藏",
  addTag: "添加标签…",
  addTagAction: "添加标签",
  addingTagStars: "添加标签前会先 Star 此仓库",
  suggestedTags: "推荐标签",
  repositoryTags: "此仓库的标签",
  repositoryTagScope: "同一仓库的所有动态共用这些标签。",
  noTags: "暂无标签。",
  tagComposerHint: "Enter 添加 · Esc 关闭",
  openRepository: "打开仓库",
  actionFailed: (error) => `操作失败：${error}`,
  keyboardHint: "↑↓ 导航 · Enter 应用 · Esc 关闭",
  unseenActivity: "未查看动态",
  unseenProject: "此项目有未查看动态",
  dismissActivity: (actor, repository) => `隐藏动态：${actor} Star 了 ${repository}`,
  dismissProject: (repository) => `从关注动态中隐藏 ${repository}`,
};
