# GitHub Token 权限

[English](../en/github-token-permissions.md)

本指南说明 Better GitHub Stars Manager 使用的单一 GitHub 凭据。Cubby 使用另一份 AI 服务凭据，详见下文。

最后核对 GitHub 文档：2026-08-11。

## 当前配置

使用一个 GitHub **Classic PAT**。Options 页会打开已预填以下 scope 的 [Classic PAT 表单](https://github.com/settings/tokens/new?scopes=repo,gist,notifications,read:user&description=Better%20GitHub%20Stars%20Manager)：

```text
repo
gist
notifications
read:user
```

设置有限有效期，确认 scopes，生成 Token，然后粘贴到 `Options > GitHub Classic PAT` 并点击 **Save & verify**。

## Scope 与功能对应关系

| Scope | 要求 | 对应功能 |
| --- | --- | --- |
| `repo` | 必需 | Stars 同步、Star/Unstar、仓库元数据、私有仓库访问、已 Watch 仓库成员关系，以及你有权访问的 Issue/Pull Request 详情 |
| `gist` | 必需 | 通过扩展的私有 Gist 推送和拉取标签、笔记、收藏信息与标签元数据 |
| `notifications` | 可选能力 | Watch 收件箱读取和通知操作 |
| `read:user` | 可选能力 | Following Radar 读取你关注的账号及其公开 Star 动态 |

当前产品支持私有 Stars 和仓库操作，因此有意使用范围较广的 `repo`；`public_repo` 不能直接替代当前契约。GitHub 的 `gist` scope 作用于整个账号，不能只授权扩展使用的那一个 Gist。

不要授予 `user`、`user:email`、`user:follow`、`project`、`admin:org`、`workflow`、`delete_repo`、package、密钥、审计日志、enterprise 或 Webhook 管理权限；扩展不会使用这些权限。

## 验证行为

点击 **Save & verify** 后，扩展会验证账号、读取一页 Stars、创建并删除一个临时 Secret Gist，并探测 Notifications 权限。Gist 探测会同时证明写入和清理权限。配置阶段不会测试 Star 或 Unstar，因为那会修改你的 GitHub 账号。

缺少 `notifications` 或 `read:user` 时，只能禁用 Watch 收件箱或 Following Radar；Stars 和 Gist 必须继续可用。Following Radar 会在加载该界面时检查自己的可选能力。

## 凭据生命周期

产品只在 `chrome.storage.local` 中保存一个加密的 Classic PAT；明文只存在于内存中。它不会保存第二个 Notifications 凭据，也不会静默回退到另一份凭据。

这是一次有意的凭据切换。之前保存的 Fine-grained PAT 可能需要重新授权。扩展会保留本地 Stars、标签、笔记和设置，只有新的 Classic PAT 通过必需检查后才替换加密值。

## Cubby 与 AI 功能

GitHub Token 不能用于连接 Cubby 的 AI 服务。使用 Cubby 时，还要在 Options 中单独填写 AI 服务的 API Key、Base URL 和模型。扩展绝不会把 GitHub Token 发送给所选 AI 模型。

## 检查配置

1. 在 `Options > GitHub Classic PAT` 粘贴 Classic PAT，然后点击 **Save & verify**。
2. 确认显示正确的已认证账号，并且必需的 Stars 和 Gist 检查通过。
3. 打开管理器并运行 **Full Sync**。
4. 打开 **Watch**。有 `notifications` 时刷新，确认收件箱只显示当前已 Star 仓库的通知，并单独展示已 Watch 仓库的参考计数。
5. 打开 **Following Radar**。有 `read:user` 时，确认 Following 动态可以加载。

刷新 Watch 不会修改你在 GitHub 上的订阅设置。

## 安全说明

把 PAT 当作密码。请设置过期时间，只在扩展的 Options 页面粘贴；一旦泄露，立即撤销或轮换。

扩展会先加密 GitHub 凭据，再写入 `chrome.storage.local`。存储位置和数据流说明见[隐私政策](privacy-policy.md)。

## GitHub 官方依据

- [Personal access token 管理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Starring REST API](https://docs.github.com/en/rest/activity/starring)
- [Gists REST API](https://docs.github.com/en/rest/gists/gists)
- [Watching REST API](https://docs.github.com/en/rest/activity/watching)
- [Notifications REST API](https://docs.github.com/en/rest/activity/notifications)
- [Classic PAT 与 OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Code search REST API](https://docs.github.com/en/rest/search/search#search-code)

GitHub 已宣布限制 Watching 接口，并弃用公开的 `GET /users/{username}/subscriptions`。扩展使用的认证接口 `GET /user/subscriptions` 仍在文档中，但 GitHub 没有保证这个用法会长期可用。Better GitHub Stars Manager 只把已 Watch 仓库成员关系当作参考快照，不会用它筛掉 Watch Inbox 通知。详情见 [Watch 策略](watch-strategy.md)和 [GitHub API 访问限制公告](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/)。
