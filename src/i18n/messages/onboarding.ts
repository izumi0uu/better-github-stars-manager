/** First-run onboarding card (ManagerPanel). Context-aware: shows until the
 *  user dismisses it with "Got it" (sets Config.seenOnboarding). */
export type OnboardingMessages = {
  title: string;
  /** Shown when there is no token yet — the install→configure path. */
  noTokenBody: string;
  /** The link label inside noTokenBody (kept separate so it can be a link). */
  createPatLabel: string;
  openOptions: string;
  /** Shown when a token exists but the first sync hasn't completed. */
  syncingBody: string;
  /** Shown when the first sync failed (the humanized error follows). */
  syncFailedBody: string;
  retry: string;
  gotIt: string;
  /** One-time enhanced tooltip bodies (shown on first hover of each action). */
  tooltipSyncFirst: string;
  /** Highlighted step coachmark (first run, after first sync). Persistent
   *  bubbles — no hover. Each step highlights one UI element. */
  coachTitle: string;
  coachIntro: string;
  coachStep1Title: string;
  coachStep1Body: string;
  coachStep2Title: string;
  coachStep2Body: string;
  coachStep3Title: string;
  coachStep3Body: string;
  coachStep4Title: string;
  coachStep4Body: string;
  coachStep5Title: string;
  coachStep5Body: string;
  coachNext: string;
  coachBack: string;
  coachSkip: string;
  coachOf: (current: number, total: number) => string;
};

export const enOnboardingMessages: OnboardingMessages = {
  title: "Welcome to Better GitHub Stars Manager",
  noTokenBody: "This app requires a GitHub Classic PAT to manage your stars:",
  createPatLabel: "Create a GitHub Classic PAT",
  openOptions: "Add Classic PAT in Options",
  syncingBody:
    "Fetching your stars… the list will fill in as the first sync completes.",
  syncFailedBody: "The first sync failed:",
  retry: "Retry sync",
  gotIt: "Got it",
  tooltipSyncFirst:
    "Sync pulls in newly starred repositories. When Stars opens, your public repositories refresh quietly in the background so the list appears quickly.",
  coachTitle: "Quick tour",
  coachIntro:
    "Here are the core controls you'll use most. Follow along — this shows only once.",
  coachStep1Title: "Meet the three workspaces",
  coachStep1Body:
    "Stars organizes your saved repositories. Watch surfaces Issue and Pull Request threads from those repositories. Following shows repositories recently starred by people you follow, plus For You recommendations.",
  coachStep2Title: "Keep Stars in sync",
  coachStep2Body:
    "Sync fetches stars added since your last visit. When Stars opens, your public repositories refresh quietly in the background; open the menu for Full Sync when you need a complete re-pull. Neither action creates or changes tags.",
  coachStep3Title: "Add topic-based tags",
  coachStep3Body:
    "Auto Tags adds local tags from synced GitHub topics only when you run it. It never runs as part of Sync.",
  coachStep4Title: "Organize with Cubby",
  coachStep4Body:
    "Ask Cubby about a selected repository or your current Stars view. It can also help organize your library, with library-wide changes reviewed before Apply.",
  coachStep5Title: "Exit the panel",
  coachStep5Body:
    "Click here to return to GitHub's native Stars page. A floating button stays on screen so you can reopen the manager at any time.",
  coachNext: "Next",
  coachBack: "Back",
  coachSkip: "Skip tour",
  coachOf: (current, total) => `Step ${current} of ${total}`,
};

export const zhOnboardingMessages: OnboardingMessages = {
  title: "欢迎使用 Better GitHub Stars Manager",
  noTokenBody: "应用需要 GitHub Classic PAT 鉴权才能管理你的 stars：",
  createPatLabel: "创建 GitHub Classic PAT",
  openOptions: "在选项页添加 Classic PAT",
  syncingBody: "正在拉取你的 stars…首次同步完成后列表会自动填充。",
  syncFailedBody: "首次同步失败：",
  retry: "重试同步",
  gotIt: "知道了",
  tooltipSyncFirst:
    "Sync 会拉取新增的 Star。打开 Stars 后，应用会在后台静默刷新本人公开仓库，让列表先快速显示。",
  coachTitle: "快速上手",
  coachIntro: "下面是最常用的核心控件。跟着看一遍——本引导只显示一次。",
  coachStep1Title: "认识三个工作区",
  coachStep1Body:
    "Stars 用于整理已收藏的仓库；Watch 汇总这些仓库的 Issue 和 Pull Request 动态；Following 展示关注用户最近 Star 的仓库，并提供 For You 推荐。",
  coachStep2Title: "保持 Stars 最新",
  coachStep2Body:
    "Sync 会拉取自上次访问后新增的 Star。打开 Stars 后，应用会在后台静默刷新本人公开仓库；需要完整重拉时，从旁边的菜单选择 Full Sync。两者都不会创建或修改标签。",
  coachStep3Title: "按 GitHub Topics 添加标签",
  coachStep3Body:
    "Auto Tags 只在你主动运行时，根据已同步的 GitHub Topics 添加本地标签；它不会随 Sync 自动执行。",
  coachStep4Title: "用 Cubby 整理仓库",
  coachStep4Body:
    "可以让 Cubby 分析选中的仓库或当前 Stars 视图，也可以协助整理整个收藏库；全库变更会先进入 Review，再由你 Apply。",
  coachStep5Title: "退出管理面板",
  coachStep5Body:
    "点击这里返回 GitHub 原生 Stars 页面。屏幕上会保留一个悬浮按钮，随时可以重新打开管理面板。",
  coachNext: "下一步",
  coachBack: "上一步",
  coachSkip: "跳过引导",
  coachOf: (current, total) => `第 ${current} 步，共 ${total} 步`,
};
