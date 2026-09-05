export type OptionsMessages = {
  title: string;
  /** Label for the prominent "Star the project" CTA button. */
  starRepoButton: string;
  storeRatingHeading: string;
  storeRatingManualAction: (store: string) => string;
  storeRatingManualHint: (store: string) => string;
  agentHeading: string;
  agentIntro: string;
  agentServiceLabel: string;
  agentServiceHint: string;
  agentAdvancedSettings: string;
  agentProtocolLabel: string;
  agentProtocolHint: string;
  agentProtocolChat: string;
  agentProtocolResponses: string;
  agentBaseUrlLabel: string;
  agentBaseUrlHint: string;
  agentBaseUrlPlaceholder: string;
  agentProviderContextWindowLabel: string;
  agentProviderContextWindowHint: string;
  agentProviderContextWindowRequired: string;
  agentWorkingContextWindowLabel: string;
  agentWorkingContextWindowHint: string;
  agentWorkingContextWindowPlaceholder: string;
  agentWorkingContextWindowTooLarge: string;
  agentContextWindowRange: string;
  agentModelLabel: string;
  agentModelHint: string;
  agentApiKeyLabel: string;
  agentApiKeyHint: string;
  agentApiKeyPlaceholder: string;
  agentSavedKeyHint: string;
  agentSave: string;
  agentSaving: string;
  agentSavedAndTested: (provider: string, model: string, latencyMs: number) => string;
  agentSavedTestFailed: (error: string) => string;
  agentSavedNeedsHostAccess: string;
  agentTest: string;
  agentTesting: string;
  agentTestOk: (provider: string, model: string, latencyMs: number) => string;
  agentRemoveKey: string;
  agentKeyRemoved: string;
  agentDisclosureHeading: string;
  agentDisclosureIntro: (provider: string, origin: string) => string;
  agentDisclosureSentHeading: string;
  agentDisclosureSentPrompt: string;
  agentDisclosureSentCode: string;
  agentDisclosureSentProtocol: string;
  agentDisclosureNotSentHeading: string;
  agentDisclosureNotSentSecrets: string;
  agentDisclosureKeyException: string;
  agentDisclosureLocalHistory: string;
  agentDisclosureBuiltInAccess: string;
  agentDisclosureCustomAccess: string;
  agentDisclosureAccept: string;
  agentDisclosureAccepting: string;
  agentDisclosureAccepted: string;
  agentDisclosureAcceptanceRequired: string;
  agentGrantAccess: string;
  agentAccessGranted: string;
  agentHostAccessRequired: string;
  agentStorageHeading: string;
  agentStorageIntro: string;
  agentStorageOrganizeRetention: string;
  agentStorageRefresh: string;
  agentStorageLoading: string;
  agentStorageDurableData: string;
  agentStorageConversationCount: (sessions: number, messages: number) => string;
  agentStorageToolCache: string;
  agentStorageArtifactCount: (artifacts: number) => string;
  agentStorageLedgerTotal: string;
  agentStorageLogicalLimit: (limit: string) => string;
  agentStorageLedgerUsageLabel: string;
  agentStorageThresholds: (warning: string, limit: string) => string;
  agentStorageBrowserUsage: (usage: string, quota: string) => string;
  agentStorageBrowserUnavailable: string;
  agentStorageWarning: string;
  agentStorageLimitReached: string;
  agentStorageClearHint: string;
  agentStorageClearCache: string;
  agentStorageClearingCache: string;
  agentStorageCacheCleared: (artifacts: number, bytes: string, protectedArtifacts: number) => string;
  agentStorageUnavailable: (error: string) => string;
  agentStorageClearFailed: (error: string) => string;
  agentStorageRetry: string;
  behaviorHeading: string;
  followingHistoryWindowLabel: string;
  followingHistoryWindowHint: string;
  followingHistoryWindowRisk: string;
  followingHistoryWindowOption: (days: number) => string;
  maxTagsPerRepoLabel: string;
  maxTagsPerRepoHint: string;
  minTopicRepoCountLabel: string;
  minTopicRepoCountHint: string;
  starsPanelDefaultLabel: string;
  starsPanelDefaultHint: string;
  tokenHeading: string;
  tokenIntroPrefix: string;
  tokenLinkLabel: string;
  tokenIntroSuffix: string;
  tokenPublicRepos: string;
  tokenGists: string;
  tokenWatchingOptional: string;
  tokenFollowersOptional: string;
  tokenIssuesOptional: string;
  tokenGistNote: string;
  authenticatedAs: (username: string) => string;
  openVerifiedStars: string;
  removeToken: string;
  cachedAccountWarning: (username: string) => string;
  clearCachedAuth: string;
  saveVerify: string;
  verifying: string;
  tokenVerified: (username: string) => string;
  tokenVerifiedWatchForbidden: (username: string) => string;
  tokenVerifiedWatchUnverified: (username: string) => string;
  tokenRemoved: string;
  /** Compact PAT walkthrough. */
  tokenStepsTitle: string;
  tokenStep1Title: string;
  tokenStep1: string;
  tokenStep1Alt: string;
  tokenStep2Title: string;
  tokenStep2: string;
  tokenStep2Alt: string;
  tokenStep3Title: string;
  tokenStep3: string;
  tokenStep3Alt: string;
  tokenScopesWarning: string;
  languageLabel: string;
  gistHeading: string;
  gistBoundPrefix: string;
  gistBoundSuffix: string;
  gistEmpty: string;
  gistOpenLink: string;
};

export const enOptionsMessages: OptionsMessages = {
  title: "Better GitHub Stars Manager — Options",
  starRepoButton: "Like the project? Leave a star!",
  storeRatingHeading: "Store rating",
  storeRatingManualAction: (store) => `Rate in ${store}`,
  storeRatingManualHint: (store) =>
    `Opens the verified Better GitHub Stars Manager listing in ${store}.`,
  agentHeading: "2. Cubby",
  agentIntro:
    "Connect an AI service. Cubby sends requests directly to it and shows the results in the extension.",
  agentServiceLabel: "AI service",
  agentServiceHint: "Choose the AI service Cubby uses.",
  agentAdvancedSettings: "Advanced settings",
  agentProtocolLabel: "API protocol",
  agentProtocolHint: "Choose the API supported by this custom service.",
  agentProtocolChat: "Chat Completions",
  agentProtocolResponses: "Responses API",
  agentBaseUrlLabel: "Base URL",
  agentBaseUrlHint:
    "Enter the /v1 Base URL provided by this service. BGSM only contacts its configured origin.",
  agentBaseUrlPlaceholder: "https://api.example.com/v1",
  agentProviderContextWindowLabel: "Service context window",
  agentProviderContextWindowHint:
    "Known model IDs use an exact built-in preset. Enter a value to override it, or to configure an unknown model.",
  agentProviderContextWindowRequired: "Enter this service's supported context window.",
  agentWorkingContextWindowLabel: "Working context window",
  agentWorkingContextWindowHint:
    "Optional. Set a smaller working window for this model. This can only reduce the service limit.",
  agentWorkingContextWindowPlaceholder: "Use the service limit",
  agentWorkingContextWindowTooLarge: "The working window cannot exceed the service window.",
  agentContextWindowRange: "Enter a whole number from 4,096 to 2,000,000.",
  agentModelLabel: "Model",
  agentModelHint: "Use any model ID supported by this service.",
  agentApiKeyLabel: "API key",
  agentApiKeyHint: "Stored encrypted on this device.",
  agentApiKeyPlaceholder: "Paste an API key",
  agentSavedKeyHint:
    "A saved key is already on this device. Leave this blank to keep using it.",
  agentSave: "Save & test",
  agentSaving: "Saving and testing…",
  agentSavedAndTested: (provider, model, latencyMs) =>
    `Saved · Connected to ${provider} · ${model} (${latencyMs} ms)`,
  agentSavedTestFailed: (error) =>
    `Settings saved, but the connection test failed: ${error}`,
  agentSavedNeedsHostAccess:
    "Settings saved. Allow browser access, then test the connection.",
  agentTest: "Test connection",
  agentTesting: "Testing…",
  agentTestOk: (provider, model, latencyMs) =>
    `Connected to ${provider} · ${model} (${latencyMs} ms)`,
  agentRemoveKey: "Remove saved key",
  agentKeyRemoved: "Saved AI service key removed.",
  agentDisclosureHeading: "Data shared with your AI service",
  agentDisclosureIntro: (provider, origin) =>
    `${provider} · ${origin} · direct connection`,
  agentDisclosureSentHeading: "Sent when needed",
  agentDisclosureSentPrompt: "Your prompt, scoped public repository metadata, and visible tags",
  agentDisclosureSentCode: "Code snippets or private notes only when you ask Cubby to use them",
  agentDisclosureSentProtocol: "Tool definitions, limited tool results, interaction choices, and conversation summaries",
  agentDisclosureNotSentHeading: "Never included as model input",
  agentDisclosureNotSentSecrets: "GitHub token, API keys, other credentials, or repositories outside the active scope",
  agentDisclosureKeyException:
    "The AI service API key is sent only to the exact address above in the provider-required authentication header, including Anthropic's x-api-key. It is never included in prompts or logs.",
  agentDisclosureLocalHistory:
    "Committed conversation history, recent attempt rows that include the admitted prompt, bounded continuation-recovery projections, and paged artifacts may be stored unencrypted in this browser's extension storage. They are not synced, exported, or included in release diagnostics. Deleting a conversation removes its transcript, attempt and recovery data, and conversation-owned artifacts; re-fetchable tool cache can also be cleared separately. Unpacked development builds disclose raw capture separately before it can be enabled.",
  agentDisclosureBuiltInAccess:
    "This service is covered by the extension's built-in browser access.",
  agentDisclosureCustomAccess:
    "Custom services also require separate browser access.",
  agentDisclosureAccept: "Accept data sharing",
  agentDisclosureAccepting: "Requesting permission…",
  agentDisclosureAccepted: "Data sharing accepted",
  agentDisclosureAcceptanceRequired:
    "Accept this disclosure before testing or using Cubby. Required browser permission will be requested when applicable.",
  agentGrantAccess: "Allow access",
  agentAccessGranted: "Access allowed",
  agentHostAccessRequired: "Allow browser access to test or use this custom service.",
  agentStorageHeading: "Local Cubby storage & tool cache",
  agentStorageIntro:
    "Tracks locally saved Cubby conversation transcripts, recovery state, saved artifacts, and re-fetchable tool cache on this device. It does not represent all extension storage.",
  agentStorageOrganizeRetention:
    "Organize task data and the latest completed or cancelled result are stored separately and not counted in this cache ledger. Deleting the origin conversation still keeps that latest result until you dismiss it or a new Organize run replaces it.",
  agentStorageRefresh: "Refresh storage usage",
  agentStorageLoading: "Checking Agent storage…",
  agentStorageDurableData: "Conversation & saved data",
  agentStorageConversationCount: (sessions, messages) =>
    `${sessions} conversation${sessions === 1 ? "" : "s"} · ${messages} message${messages === 1 ? "" : "s"}`,
  agentStorageToolCache: "Re-fetchable tool cache",
  agentStorageArtifactCount: (artifacts) =>
    `${artifacts} cached tool artifact${artifacts === 1 ? "" : "s"}`,
  agentStorageLedgerTotal: "Total Cubby storage used",
  agentStorageLogicalLimit: (limit) => `${limit} limit`,
  agentStorageLedgerUsageLabel: "Cubby storage used",
  agentStorageThresholds: (warning, limit) =>
    `Warning at ${warning} · New writes paused at ${limit} limit`,
  agentStorageBrowserUsage: (usage, quota) =>
    `Whole-extension browser storage estimate: ${usage} of ${quota}`,
  agentStorageBrowserUnavailable: "Whole-extension browser storage estimate unavailable",
  agentStorageWarning:
    "Cubby storage is above its warning threshold. Clear the re-fetchable tool cache before storage-heavy tasks to free up space.",
  agentStorageLimitReached:
    "Cubby storage reached its local limit. New writes are paused until space is freed; other extension storage is unaffected.",
  agentStorageClearHint:
    "Only clears re-fetchable tool cache. Conversation transcripts, answers, recovery state, and saved artifacts will be preserved.",
  agentStorageClearCache: "Clear tool cache",
  agentStorageClearingCache: "Clearing tool cache…",
  agentStorageCacheCleared: (artifacts, bytes, protectedArtifacts) =>
    `Cleared ${artifacts} cached tool artifact${artifacts === 1 ? "" : "s"} and freed ${bytes}.${protectedArtifacts > 0 ? ` Kept ${protectedArtifacts} active or referenced artifact${protectedArtifacts === 1 ? "" : "s"}.` : ""}`,
  agentStorageUnavailable: (error) => `Cubby storage usage is unavailable: ${error}`,
  agentStorageClearFailed: (error) => `Tool cache could not be cleared: ${error}`,
  agentStorageRetry: "Try again",
  behaviorHeading: "4. Preferences",
  followingHistoryWindowLabel: "Activity history range",
  followingHistoryWindowHint:
    "Choose how many days of public Star activity to scan from accounts you follow. Applies on the next scan.",
  followingHistoryWindowRisk:
    "Longer ranges take more time, API quota, and local storage to scan. If you follow many accounts, GitHub rate limits may cause only partial results to load.",
  followingHistoryWindowOption: (days) => `${days} days`,
  maxTagsPerRepoLabel: "Max automatic tags per repo",
  maxTagsPerRepoHint:
    "Auto Tags uses this limit. In Chat, Cubby may add at most this many tags to a repository per turn; Organize uses the lower of this value and its 5-tag safety cap.",
  minTopicRepoCountLabel: "Minimum shared tag coverage",
  minTopicRepoCountHint:
    "Cubby Chat assigns a tag only when the target brings its topic-or-visible-tag coverage to this many live repositories. Organize uses proposal-wide coverage; Auto Tags applies the same threshold to topics.",
  starsPanelDefaultLabel: "Open my stars page with the manager panel by default",
  starsPanelDefaultHint:
    "Turn this off to show GitHub's native stars list first; the floating button can reopen the manager.",
  tokenHeading: "1. GitHub Classic PAT",
  tokenIntroPrefix: "Create the single GitHub token used by Stars, Gist, Watch, and Following:",
  tokenLinkLabel: "open the prefilled classic token form",
  tokenIntroSuffix: "Review the scopes before generating it.",
  tokenPublicRepos: "Required · repo · Stars, repository access, and Issue/PR details",
  tokenGists: "Required · gist · cross-device annotation sync",
  tokenWatchingOptional: "Optional · notifications · Watch Inbox reads and actions",
  tokenIssuesOptional: "repo also covers private Issue/PR details you can access.",
  tokenFollowersOptional: "Optional · read:user · Following Radar",
  tokenGistNote:
    "gist applies to the whole account. The extension creates a private Gist for annotation sync.",
  authenticatedAs: (username) => `Classic PAT authenticated as @${username}.`,
  openVerifiedStars: "Open my stars",
  removeToken: "Remove Classic PAT",
  cachedAccountWarning: (username) =>
    `This app requires a GitHub Classic PAT. Add and verify one below; local data for @${username} is preserved.`,
  clearCachedAuth: "Clear saved account",
  saveVerify: "Save & verify",
  verifying: "Verifying…",
  tokenVerified: (username) => `Classic PAT verified for @${username}. Stars, Gist, and Watch are ready.`,
  tokenVerifiedWatchForbidden: (username) => `Classic PAT verified for @${username}. Stars and Gist are ready; add notifications to use Watch.`,
  tokenVerifiedWatchUnverified: (username) => `Classic PAT verified for @${username}. Stars and Gist are ready, but Notifications access could not be checked.`,
  tokenRemoved: "GitHub Classic PAT removed.",
  tokenStepsTitle: "Token setup",
  tokenStep1Title: "Set the expiration",
  tokenStep1: "Open the prefilled form, keep the Note, and choose a finite expiration.",
  tokenStep1Alt: "Classic PAT Note, expiration, and repo scope",
  tokenStep2Title: "Check the scopes",
  tokenStep2: "Keep repo, gist, notifications, and read:user selected. Leave user unselected.",
  tokenStep2Alt: "gist, notifications, and read:user selected; user unselected",
  tokenStep3Title: "Generate and save",
  tokenStep3: "Generate the token, copy it, paste it below, then select Save & verify.",
  tokenStep3Alt: "GitHub Generate token button",
  tokenScopesWarning: "GitHub shows the token once. Keep it private.",
  languageLabel: "Language",
  gistHeading: "3. Gist sync",
  gistBoundPrefix: "Bound to gist",
  gistBoundSuffix:
    "Tags sync to and from this gist. If the same repo is edited in two places, the newer change wins.",
  gistEmpty:
    "No gist yet. One is created automatically on your first tag push.",
  gistOpenLink: "Open this gist on GitHub Gist",
};

export const zhOptionsMessages: OptionsMessages = {
  title: "Better GitHub Stars Manager — 选项",
  starRepoButton: "点个 Star 吧",
  storeRatingHeading: "商店评分",
  storeRatingManualAction: (store) => `前往 ${store} 评分`,
  storeRatingManualHint: (store) =>
    `打开 Better GitHub Stars Manager 在 ${store} 中已验证的商店页面。`,
  tokenHeading: "1. GitHub Classic PAT",
  tokenIntroPrefix: "创建 Stars、Gist、Watch 和 Following 共用的唯一 GitHub token：",
  tokenLinkLabel: "打开已预填的 classic token 表单",
  tokenIntroSuffix: "生成前请确认 scopes。",
  agentHeading: "2. Cubby",
  agentIntro:
    "连接 AI 服务后，Cubby 会直接向该服务发送请求，并在扩展内显示结果。",
  agentServiceLabel: "AI 服务",
  agentServiceHint: "选择 Cubby 使用的 AI 服务。",
  agentAdvancedSettings: "高级设置",
  agentProtocolLabel: "API 协议",
  agentProtocolHint: "选择这个自定义服务支持的 API。",
  agentProtocolChat: "Chat Completions",
  agentProtocolResponses: "Responses API",
  agentBaseUrlLabel: "Base URL",
  agentBaseUrlHint:
    "填写服务提供的 /v1 Base URL。BGSM 只会访问其配置的 origin。",
  agentBaseUrlPlaceholder: "https://api.example.com/v1",
  agentProviderContextWindowLabel: "服务上下文窗口",
  agentProviderContextWindowHint:
    "已知 model ID 会精确匹配内置预置；也可填写此值覆盖预置，未知模型则必须填写。",
  agentProviderContextWindowRequired: "请填写此服务支持的上下文窗口。",
  agentWorkingContextWindowLabel: "工作上下文窗口",
  agentWorkingContextWindowHint:
    "可选。为此模型设置更小的工作窗口；该值只能降低服务上限。",
  agentWorkingContextWindowPlaceholder: "使用服务上限",
  agentWorkingContextWindowTooLarge: "工作窗口不能超过服务窗口。",
  agentContextWindowRange: "请输入 4,096 到 2,000,000 之间的整数。",
  agentModelLabel: "模型",
  agentModelHint: "填写这个服务支持的 model ID，之后也可以再改。",
  agentApiKeyLabel: "API 密钥",
  agentApiKeyHint: "只保存在本机，并会加密存储。",
  agentApiKeyPlaceholder: "粘贴 API 密钥",
  agentSavedKeyHint:
    "这台设备里已经保存过密钥。留空即可继续使用当前密钥。",
  agentSave: "保存并测试",
  agentSaving: "正在保存并测试…",
  agentSavedAndTested: (provider, model, latencyMs) =>
    `已保存 · ${provider} · ${model} 已连接（${latencyMs} ms）`,
  agentSavedTestFailed: (error) =>
    `设置已保存，但连接测试失败：${error}`,
  agentSavedNeedsHostAccess:
    "设置已保存。请先允许浏览器访问，然后测试连接。",
  agentTest: "测试连接",
  agentTesting: "测试中…",
  agentTestOk: (provider, model, latencyMs) =>
    `${provider} · ${model} 已连接（${latencyMs} ms）`,
  agentRemoveKey: "移除已保存密钥",
  agentKeyRemoved: "已移除保存的 AI 服务密钥。",
  agentDisclosureHeading: "与 AI 服务共享的数据",
  agentDisclosureIntro: (provider, origin) =>
    `${provider} · ${origin} · 直接连接`,
  agentDisclosureSentHeading: "按需发送",
  agentDisclosureSentPrompt: "你的提示词、当前范围内的公开仓库元数据和可见标签",
  agentDisclosureSentCode: "只有你明确要求 Cubby 使用时，才会发送代码片段或私人笔记",
  agentDisclosureSentProtocol: "工具定义、有限的工具结果、交互选择和对话摘要",
  agentDisclosureNotSentHeading: "绝不会作为模型输入",
  agentDisclosureNotSentSecrets: "GitHub token、API 密钥、其他凭据，或当前范围外的仓库",
  agentDisclosureKeyException:
    "AI 服务 API 密钥只会通过服务商要求的认证请求头发送到上方准确地址（Anthropic 使用 x-api-key），绝不会写入提示词或日志。",
  agentDisclosureLocalHistory:
    "已提交的对话历史、近期尝试记录、恢复状态及会话工件会保存在本机浏览器的扩展存储中，不会同步、导出或进入发布版诊断。删除对话会彻底移除对应对话记录、尝试与恢复数据及相关工件；工具临时缓存也可随时单独清理。解压加载的开发版会在启用原始捕获前另行披露风险。",
  agentDisclosureBuiltInAccess:
    "此服务已包含在扩展内置的浏览器访问范围中。",
  agentDisclosureCustomAccess:
    "自定义服务还需要单独允许浏览器访问。",
  agentDisclosureAccept: "接受数据共享",
  agentDisclosureAccepting: "正在请求权限…",
  agentDisclosureAccepted: "已接受数据共享",
  agentDisclosureAcceptanceRequired:
    "测试或使用 Cubby 前，请先接受此说明；如适用，浏览器会同时请求所需权限。",
  agentGrantAccess: "允许访问",
  agentAccessGranted: "已允许访问",
  agentHostAccessRequired: "测试或使用此自定义服务前，请先允许浏览器访问。",
  agentStorageHeading: "本机 Cubby 存储与缓存",
  agentStorageIntro:
    "统计本机保存的 Cubby 对话记录、恢复状态、已保存工件与可重新获取的工具缓存；不代表扩展的全部存储。",
  agentStorageOrganizeRetention:
    "智能整理 (Organize) 的任务数据与最近一次整理结果独立存储，不计入此缓存统计；删除来源对话仍会保留该最近结果，直到你将其关闭或新的整理运行将其替换。",
  agentStorageRefresh: "刷新存储用量",
  agentStorageLoading: "正在检查 Agent 存储…",
  agentStorageDurableData: "对话记录与已保存数据",
  agentStorageConversationCount: (sessions, messages) =>
    `${sessions} 个对话 · ${messages} 条消息`,
  agentStorageToolCache: "可重新获取的工具缓存",
  agentStorageArtifactCount: (artifacts) => `${artifacts} 项缓存工具数据`,
  agentStorageLedgerTotal: "Cubby 存储总占用",
  agentStorageLogicalLimit: (limit) => `上限 ${limit}`,
  agentStorageLedgerUsageLabel: "Cubby 存储已用空间",
  agentStorageThresholds: (warning, limit) =>
    `达到 ${warning} 时预警 · 达到 ${limit} 上限时将暂停写入新数据`,
  agentStorageBrowserUsage: (usage, quota) =>
    `整个扩展的浏览器存储估算：已用 ${usage}，可用额度 ${quota}`,
  agentStorageBrowserUnavailable: "暂时无法获取整个扩展的浏览器存储估算",
  agentStorageWarning:
    "Cubby 存储已超过预警阈值。建议在执行高存储量任务前先清理工具缓存以释放空间。",
  agentStorageLimitReached:
    "Cubby 存储已达到本机上限。释放空间前将暂停写入新数据；扩展的其他存储不受影响。",
  agentStorageClearHint:
    "仅清理可重新获取的工具临时缓存；对话历史、回答、恢复状态与已保存数据均会完整保留。",
  agentStorageClearCache: "清理工具缓存",
  agentStorageClearingCache: "正在清理工具缓存…",
  agentStorageCacheCleared: (artifacts, bytes, protectedArtifacts) =>
    `已清理 ${artifacts} 项缓存工具数据，释放 ${bytes}。${protectedArtifacts > 0 ? `另有 ${protectedArtifacts} 项正在使用或仍被引用的数据已保留。` : ""}`,
  agentStorageUnavailable: (error) => `无法获取 Cubby 存储用量：${error}`,
  agentStorageClearFailed: (error) => `无法清理工具缓存：${error}`,
  agentStorageRetry: "重试",
  behaviorHeading: "4. 偏好设置",
  followingHistoryWindowLabel: "关注动态时间范围",
  followingHistoryWindowHint:
    "选择扫描所关注账号最近多少天的公开 Star 动态，更改将在下次扫描生效。",
  followingHistoryWindowRisk:
    "天数越长，扫描耗时、API 配额和本地存储占用越高；若关注人数较多，可能会因 GitHub 速率限制仅返回部分最新结果。",
  followingHistoryWindowOption: (days) => `${days} 天`,
  maxTagsPerRepoLabel: "每个仓库最多自动标签数",
  maxTagsPerRepoHint:
    "Auto Tags 使用此上限；聊天中 Cubby 每轮最多为单个仓库新增这么多个标签；整理功能取此值与 5 个标签安全上限中的较小值。",
  minTopicRepoCountLabel: "共同标签最低覆盖数",
  minTopicRepoCountHint:
    "聊天中，只有目标仓库加入后，同一主题或可见标签至少覆盖这么多个有效仓库，Cubby 才会分配该标签；整理功能按整批建议计算，Auto Tags 对主题使用相同阈值。",
  starsPanelDefaultLabel: "默认打开自己的 stars 页面时显示管理面板",
  starsPanelDefaultHint:
    "关闭后会优先显示 GitHub 原生 stars 列表，需要时再手动打开悬浮面板。",
  tokenPublicRepos: "必需 · repo · Stars、仓库访问和 Issue/PR 详情",
  tokenGists: "必需 · gist · 跨设备同步标签和笔记",
  tokenWatchingOptional: "可选 · notifications · Watch 收件箱",
  tokenIssuesOptional: "repo 也包含你有权访问的私有 Issue/PR 详情。",
  tokenFollowersOptional: "可选 · read:user · Following Radar",
  tokenGistNote:
    "gist 是账号级权限。扩展会创建一个私有 Gist，用于同步标签和笔记。",
  authenticatedAs: (username) => `Classic PAT 已鉴权为 @${username}。`,
  openVerifiedStars: "打开我的 stars",
  removeToken: "移除 Classic PAT",
  cachedAccountWarning: (username) =>
    `应用需要 GitHub Classic PAT 鉴权。请在下方添加并验证；@${username} 的本地数据会保留。`,
  clearCachedAuth: "清除已保存账号",
  saveVerify: "保存并验证",
  verifying: "验证中…",
  tokenVerified: (username) => `@${username} 的 Classic PAT 已验证，Stars、Gist 和 Watch 均可使用。`,
  tokenVerifiedWatchForbidden: (username) => `@${username} 的 Classic PAT 已验证。Stars 和 Gist 可用；如需 Watch，请添加 notifications。`,
  tokenVerifiedWatchUnverified: (username) => `@${username} 的 Classic PAT 已验证。Stars 和 Gist 可用，但暂时无法检查 Notifications。`,
  tokenRemoved: "GitHub Classic PAT 已移除。",
  tokenStepsTitle: "Token 配置",
  tokenStep1Title: "设置有效期",
  tokenStep1: "打开预填表单，保留 Note，并选择有限有效期。",
  tokenStep1Alt: "Classic PAT 的 Note、有效期和 repo scope",
  tokenStep2Title: "确认 scopes",
  tokenStep2: "保留 repo、gist、notifications 和 read:user；不要勾选 user。",
  tokenStep2Alt: "已勾选 gist、notifications 和 read:user，未勾选 user",
  tokenStep3Title: "生成并保存",
  tokenStep3: "生成 Token，复制并粘贴到下方，然后点击保存并验证。",
  tokenStep3Alt: "GitHub Generate token 按钮",
  tokenScopesWarning: "GitHub 只显示一次 Token，请妥善保管。",
  languageLabel: "语言",
  gistHeading: "3. Gist 同步",
  gistBoundPrefix: "已绑定 gist",
  gistBoundSuffix:
    "标签会与该 gist 双向同步；如果同一仓库在两处被改动，较新的改动会生效。",
  gistEmpty: "尚未创建 gist。首次推送标签时会自动创建。",
  gistOpenLink: "在 GitHub 打开这个 gist",
};
