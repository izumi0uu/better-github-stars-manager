/** Humanized error strings. Keys are matched against stable error codes thrown
 *  across the codebase (see src/api/errors.ts). `unknown` is the passthrough —
 *  it keeps the raw tail so nothing is silently swallowed. */
export type ErrorMessages = {
  tokenEmpty: string;
  tokenRejected: string;
  tokenStarsForbidden: string;
  tokenGistsForbidden: string;
  /** Step 1 (GET /user) — non-401 status, bad body, or network failure. */
  tokenProfileStatus: (status: number | string) => string;
  tokenProfileBadShape: string;
  tokenProfileNetwork: string;
  /** Step 2 (GET /user/starred) — non-401/403 status or network failure. */
  tokenStarsStatus: (status: number | string) => string;
  tokenStarsNetwork: string;
  /** Step 3 (POST /gists) — non-401/403/404 status, bad body, or network failure. */
  tokenGistsStatus: (status: number | string) => string;
  tokenGistsNetwork: string;
  tokenGistProbeBadShape: string;
  /** Step 3 cleanup (DELETE /gists/{id}) — surfaced before persistence. */
  tokenGistCleanupStatus: (status: number | string) => string;
  tokenWatchingForbidden: string;
  tokenWatchingStatus: (status: number | string) => string;
  tokenWatchingNetwork: string;
  tokenWatchingBadShape: string;
  ghTokenRejected: string;
  ghRateLimit: string;
  ghForbidden: string;
  ghTimeout: (page: number) => string;
  ghNetwork: (detail: string) => string;
  ghPageStatus: (status: number | string) => string;
  ghNoToken: string;
  ghBadShape: string;
  gistNoToken: string;
  gistCreateFailed: string;
  gistPushFailed: string;
  gistPullFailed: string;
  agentApiKeyEmpty: string;
  agentModelEmpty: string;
  agentBaseUrlEmpty: string;
  agentBaseUrlInvalid: string;
  agentHostPermissionDenied: string;
  agentProviderUnsupported: string;
  agentProviderTimeout: string;
  agentProviderIdentityChanged: string;
  agentProviderResponseInvalid: string;
  agentDataDisclosureRequired: string;
  agentPersonalCommunicationsPermissionRequired: string;
  agentContextCapabilityRequired: string;
  agentContextCapabilityInfeasible: string;
  agentArtifactCoverageStalled: string;
  unknown: (raw: string) => string;
};

export const enErrorMessages: ErrorMessages = {
  tokenEmpty: "Paste a GitHub Classic PAT first.",
  tokenRejected:
    "GitHub rejected this Classic PAT. It may be expired, revoked, or incomplete; create or paste a valid Classic PAT.",
  tokenStarsForbidden:
    "This Classic PAT cannot access Stars. Re-create it with the repo scope.",
  tokenGistsForbidden:
    "This Classic PAT cannot write Gists. Re-create it with the gist scope.",
  tokenProfileStatus: (status) =>
    `GitHub responded with ${status} when checking your profile. Try again in a moment.`,
  tokenProfileBadShape:
    "GitHub returned a profile response without the expected username. Nothing was saved; retry shortly.",
  tokenProfileNetwork:
    "Could not reach GitHub while checking your profile. Check your connection and retry.",
  tokenStarsStatus: (status) =>
    `GitHub responded with ${status} when checking your starred-repo access. Try again in a moment.`,
  tokenStarsNetwork:
    "Could not reach GitHub while checking your starred-repo access. Check your connection and retry.",
  tokenGistsStatus: (status) =>
    `GitHub responded with ${status} when checking Gist access. Try again in a moment.`,
  tokenGistsNetwork:
    "Could not reach GitHub while checking Gist access. Check your connection and retry.",
  tokenGistProbeBadShape:
    "GitHub created the probe Gist but returned an unexpected response. Nothing was saved; retry.",
  tokenGistCleanupStatus: (status) =>
    `GitHub created the probe Gist but cleanup failed (${status}). Nothing was saved; retry.`,
  tokenWatchingForbidden: "The token was saved, but Watch Inbox needs the notifications scope.",
  tokenWatchingStatus: (status) => `GitHub returned ${status} while checking Notifications access.`,
  tokenWatchingNetwork: "The token was saved, but Notifications access could not be checked.",
  tokenWatchingBadShape: "GitHub returned an unexpected Notifications response.",
  ghTokenRejected: "The saved GitHub Classic PAT was rejected or expired. Replace it in Options.",
  ghRateLimit: "GitHub rate limit reached. Wait a minute and retry.",
  ghForbidden:
    "GitHub refused the request (403). Check the Classic PAT scopes and repository access in Options.",
  ghTimeout: (page) =>
    `GitHub took too long to respond (page ${page}). Retry shortly.`,
  ghNetwork: (detail) =>
    `Could not reach GitHub (${detail}). Check your connection.`,
  ghPageStatus: (status) =>
    `GitHub returned ${status}. Retry, or replace the Classic PAT in Options.`,
  ghNoToken: "A GitHub Classic PAT is required. Add one in Options.",
  ghBadShape:
    "GitHub returned an unexpected data shape. Pull may need a full re-sync.",
  gistNoToken: "A GitHub Classic PAT with the gist scope is required for Gist sync.",
  gistCreateFailed:
    "Could not create the sync Gist. Check that the Classic PAT has the gist scope.",
  gistPushFailed:
    "Could not write to the sync Gist. Check that the Classic PAT has the gist scope.",
  gistPullFailed:
    "Could not read the sync Gist. It may have been deleted, or the token lacks Gists (read).",
  agentApiKeyEmpty: "Add an API key before testing the connection.",
  agentModelEmpty: "Enter a model before testing the connection.",
  agentBaseUrlEmpty: "Enter the Base URL from your AI service.",
  agentBaseUrlInvalid:
    "Enter a valid HTTPS Base URL, or a local http://localhost URL.",
  agentHostPermissionDenied:
    "Allow this AI service before saving or testing it.",
  agentProviderUnsupported: "This AI service isn't supported yet.",
  agentProviderTimeout:
    "The AI service did not respond in time. Try again, or use a smaller request.",
  agentProviderIdentityChanged:
    "AI service settings changed during the test. Review them and test the connection again.",
  agentProviderResponseInvalid:
    "The AI service returned a response Cubby can't use. Check the protocol and model, then retry.",
  agentDataDisclosureRequired:
    "Accept Cubby's data-sharing disclosure in Options before testing or using the AI service.",
  agentPersonalCommunicationsPermissionRequired:
    "Allow Firefox's personal-communications permission before testing or using Cubby.",
  agentContextCapabilityRequired:
    "Check the context window, then test the connection before using Cubby.",
  agentContextCapabilityInfeasible:
    "Increase the working context window in Advanced settings before using Cubby.",
  agentArtifactCoverageStalled:
    "Cubby couldn't finish verifying the complete stored result. Retry the request.",
  unknown: (raw) => `Something went wrong: ${raw}`,
};

export const zhErrorMessages: ErrorMessages = {
  tokenEmpty: "请先粘贴 GitHub Classic PAT。",
  tokenRejected:
    "GitHub 拒绝了该 Classic PAT。它可能已过期、被撤销或复制不完整；请创建或粘贴有效的 Classic PAT。",
  tokenStarsForbidden:
    "该 Classic PAT 无法访问 Stars，请重新创建并添加 repo scope。",
  tokenGistsForbidden:
    "该 Classic PAT 无法写入 Gist，请重新创建并添加 gist scope。",
  tokenProfileStatus: (status) =>
    `GitHub 在校验你的资料时返回 ${status},请稍后重试。`,
  tokenProfileBadShape:
    "GitHub 返回的个人资料缺少预期的用户名字段。未保存 token,请稍后重试。",
  tokenProfileNetwork: "校验个人资料时无法连接 GitHub,请检查网络后重试。",
  tokenStarsStatus: (status) =>
    `GitHub 在校验 starred 读取权限时返回 ${status},请稍后重试。`,
  tokenStarsNetwork:
    "校验 starred 读取权限时无法连接 GitHub,请检查网络后重试。",
  tokenGistsStatus: (status) =>
    `GitHub 在校验 Gist 权限时返回 ${status},请稍后重试。`,
  tokenGistsNetwork: "校验 Gist 权限时无法连接 GitHub,请检查网络后重试。",
  tokenGistProbeBadShape:
    "GitHub 已创建探针 Gist,但返回内容不符合预期。未保存 token,请重试。",
  tokenGistCleanupStatus: (status) =>
    `GitHub 已创建探针 Gist，但清理失败（${status}）。未保存 token，请重试。`,
  ghTokenRejected: "已保存的 GitHub Classic PAT 被拒绝或已过期，请在选项页更换。",
  ghRateLimit: "已达到 GitHub 速率限制，请稍候重试。",
  ghNoToken: "应用需要 GitHub Classic PAT 鉴权，请在选项页添加。",
  ghForbidden:
    "GitHub 拒绝了请求 (403)。请在选项页检查 Classic PAT scopes 和仓库访问权限。",
  ghTimeout: (page) => `GitHub 响应超时（第 ${page} 页），请稍后重试。`,
  ghNetwork: (detail) => `无法连接 GitHub(${detail}),请检查网络。`,
  ghPageStatus: (status) =>
    `GitHub 返回 ${status}。请重试，或在选项页更换 Classic PAT。`,
  tokenWatchingForbidden: "Classic PAT 已保存，但 Watch 收件箱需要 notifications scope。",
  tokenWatchingStatus: (status) => `检查 Notifications 访问权限时 GitHub 返回 ${status}。`,
  tokenWatchingNetwork: "Classic PAT 已保存，但暂时无法检查 Notifications 访问权限。",
  tokenWatchingBadShape: "GitHub 返回了非预期的 Notifications 响应。",
  ghBadShape: "GitHub 返回了非预期的数据结构，可能需要全量重新同步。",
  gistNoToken: "Gist 同步需要带 gist scope 的 GitHub Classic PAT。",
  gistCreateFailed:
    "无法创建同步用 Gist，请确认 Classic PAT 具有 gist scope。",
  gistPushFailed:
    "无法写入同步用 Gist，请确认 Classic PAT 具有 gist scope。",
  gistPullFailed:
    "无法读取同步用 Gist。它可能已被删除，或 token 缺少「Gists (read)」权限。",
  agentApiKeyEmpty: "测试连接前请先填写 API 密钥。",
  agentModelEmpty: "测试连接前请先填写模型。",
  agentBaseUrlEmpty: "请先填写这个 AI 服务的 Base URL。",
  agentBaseUrlInvalid:
    "请填写有效的 HTTPS Base URL，或本机 http://localhost 地址。",
  agentHostPermissionDenied:
    "保存或测试前，请先允许插件访问这个 AI 服务。",
  agentProviderUnsupported: "当前还不支持这个 AI 服务。",
  agentProviderTimeout:
    "AI 服务没有及时响应。可以重试，或换一个更小的请求。",
  agentProviderIdentityChanged:
    "测试期间 AI 服务设置已变化。请检查设置后重新测试连接。",
  agentProviderResponseInvalid:
    "AI 服务返回了 Cubby 无法使用的响应。请检查协议和模型后重试。",
  agentDataDisclosureRequired:
    "测试或使用 AI 服务前，请先在选项中接受 Cubby 的数据共享说明。",
  agentPersonalCommunicationsPermissionRequired:
    "测试或使用 Cubby 前，请先允许 Firefox 的个人通信数据权限。",
  agentContextCapabilityRequired:
    "请检查上下文窗口并测试连接后再使用 Cubby。",
  agentContextCapabilityInfeasible:
    "请先在高级设置中增大工作上下文窗口，再使用 Cubby。",
  agentArtifactCoverageStalled:
    "Cubby 无法完成对已存结果的完整校验，请重试该请求。",
  unknown: (raw) => `出错了：${raw}`,
};
