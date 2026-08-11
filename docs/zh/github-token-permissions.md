# GitHub Token 权限

[English](../en/github-token-permissions.md)

本指南说明 Better GitHub Stars Manager 使用的 GitHub 凭据。Cubby 使用另一份 AI 服务凭据，详见下文。

最后核对 GitHub 文档：2026-08-11。

## 推荐配置

建议使用两个凭据。主连接使用细粒度 Token，Classic Token 只负责读取 Notifications。

### 主连接：Fine-grained PAT

打开 [Fine-grained personal access token 创建页](https://github.com/settings/personal-access-tokens/new)，按下表设置：

| 设置项 | 选择 |
| --- | --- |
| Resource owner | 你的个人 GitHub 账号 |
| Repository access | Public repositories |
| Account permission: Starring | Read and write |
| Account permission: Gists | Read and write |
| Account permission: Watching | Read-only |

其他权限保持 `No access`，也不需要授权私有仓库。

GitHub 的 Gists 权限作用于整个账号，Fine-grained PAT 不能只授权某一个 Gist。扩展只会创建一个专用的 Secret Gist 来同步批注。

这些权限在扩展中的用途如下：

| 权限 | 扩展调用的 GitHub API | 对应功能 |
| --- | --- | --- |
| Starring: read | `GET /user/starred` | 首次同步、增量同步和全量重扫 |
| Starring: write | `DELETE /user/starred/{owner}/{repo}` | 在管理器中取消 Star |
| Gists: read and write | `/gists` 相关接口 | 推送和拉取标签、笔记与标签元数据 |
| Watching: read | `GET /user/subscriptions` | 找出同时处于 Star 和 Watch 状态的仓库 |
| 公开仓库访问 | 公开仓库、代码搜索、Contents 和 Git blob 接口 | 读取公开元数据；你要求 Cubby 搜索代码时，读取有限的公开代码片段 |

点击 `Save & verify` 后，扩展会检查账号、读取一页 Stars、创建并删除一个临时 Secret Gist，再检查 Watching 权限。这个临时 Gist 用来确认写入和清理权限。扩展不会在配置阶段测试取消 Star，因为那会修改你的 GitHub 账号；因此 Starring 必须保留 Read and write。

### Watch Inbox：Classic PAT

GitHub 当前的 Notifications REST API 只接受 Personal access token (classic)，不接受 Fine-grained PAT。打开 [Classic PAT 创建页](https://github.com/settings/tokens/new)，使用与主连接相同的 GitHub 账号，只勾选：

```text
notifications
```

不要给这个 Token 添加 `repo`、`gist`、`user` 或 `workflow`。读取 Watch Inbox 只需要 `notifications`，没有必要改用权限更大的 `repo`。

先连接主 Token，再到 Options 中点击 `Set up Watch Inbox`。扩展会先测试主凭据，确认无法读取 Notifications 后才显示 Classic PAT 输入框。Fine-grained 主 Token 通常需要这个备用 Token；如果主连接本身使用兼容的 Classic PAT，Watch 可以直接复用它。

两个 Token 必须属于同一个 GitHub 账号。账号不一致时，扩展不会保存 Watch Token。

## 只用一个 Token

如果你不想维护两个 Token，可以创建一个 Classic PAT，并勾选：

```text
public_repo
gist
notifications
```

它可以覆盖取消 Star、Gist 同步、Watching 和 Notifications 等 GitHub 功能，但权限明显更大。`public_repo` 包含对公开仓库的广泛写权限。除非你确实需要访问私有仓库，否则不要勾选范围更大的 `repo`。

从权限控制来看，两个 Token 更合适：主 Token 保持细粒度，Classic Token 只有 `notifications`。

## Cubby 与 AI 功能

GitHub Token 不能用于连接 Cubby 的 AI 服务。使用 Cubby 时，还要在 Options 中单独填写 AI 服务的 API Key、Base URL 和模型。扩展不会把 GitHub Token 发送给你选择的 AI 模型。

## 检查配置

1. 在 `Options > GitHub connection` 粘贴主 Token，点击 `Save & verify`。
2. 确认账号、Stars、Gist 和 Watching 检查通过。
3. 打开 `Options > Watch Inbox` 并开始设置。
4. 如果主 Token 无法读取 Notifications，粘贴同一账号下只带 `notifications` 的 Classic PAT。
5. 在 GitHub 上 Star 并 Watch 一个仓库，然后打开管理器的 Watch 页签并刷新 Inbox。

Watch 只显示同时处于 Star 和 Watch 状态的仓库通知。刷新 Watch 不会修改你在 GitHub 上的订阅设置。

## 安全说明

Token 与密码一样敏感。请设置过期时间，只在扩展的 Options 页面粘贴 Token；一旦泄露，立即到 GitHub 撤销。GitHub 建议在条件允许时使用 Fine-grained PAT，也建议为 Classic PAT 设置过期时间。

扩展会先加密 GitHub 凭据，再写入 `chrome.storage.local`。存储位置和数据流说明见[隐私政策](privacy-policy.md)。

## GitHub 官方依据

- [Personal access token 管理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Fine-grained PAT 权限与 API 对应表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [Starring REST API](https://docs.github.com/en/rest/activity/starring)
- [Gists REST API](https://docs.github.com/en/rest/gists/gists)
- [Watching REST API](https://docs.github.com/en/rest/activity/watching)
- [Notifications REST API](https://docs.github.com/en/rest/activity/notifications)
- [Classic PAT 与 OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Code search REST API](https://docs.github.com/en/rest/search/search#search-code)

GitHub 在 2026 年 6 月 30 日宣布弃用公开的 `GET /users/{username}/subscriptions` 接口。Better GitHub Stars Manager 使用的是已认证的 `GET /user/subscriptions`。GitHub 当前的 Fine-grained 权限表仍把这个接口列在 `Watching: read` 下。相关说明见 [GitHub API 访问限制公告](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/)。
