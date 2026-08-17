# Microsoft Edge Add-ons 提交参考

[English](../en/edge-addons-submission.md)

本文描述 Better GitHub Stars Manager 的完整 Microsoft Edge 目标。Edge 目标是在共享源码上的构建、打包、浏览器证明和商店 listing 身份；它提供与 Chrome 和 Firefox 相同的完整产品。本文涵盖本地安装包准备、运行证据、商店文案、隐私回答和审核员说明。本文不表示安装包已经上传、接受、认证、审核或发布。

## 证据边界

以下状态必须分开记录：

1. 确定性的 ZIP、校验和和临时证据文件只能证明本地安装包契约。
2. 完整产品 smoke 通过，只能证明它在对应 `dist-edge/` 指纹上实际执行的场景。
3. 非 Edge Chromium 运行只能作为本地契约证据，绝不能作为 Microsoft Edge 发布证明。
4. 上传回执只能证明 Partner Center 接受了草稿安装包。
5. 只有 Microsoft 能完成认证；只有直接观察到公开的 Microsoft Edge Add-ons URL，才能证明已经发布。

公开 listing URL 被直接观察到前，README 必须继续显示“即将上架”。

## 产品契约

Edge 目标保留完整的 Chrome 等价产品：

- GitHub Stars 同步、搜索、筛选、标签、笔记、收藏和仓库 chip；
- Watch Inbox 和 Following Radar；
- 确定性的 Auto Tags；
- 通过你自己的 Secret GitHub Gist 进行 Gist Push 和 Gist Pull，并与 Chrome 一样执行已验证的创建/删除探测；
- Cubby 本地优先 AI 助手，支持内建 OpenAI、OpenRouter、Anthropic Provider 和用户配置的自定义兼容 Provider；
- 支持 Provider 的全库 Organize，包含 Review 和 Apply；
- popup 和 Options 页面；
- 对 GitHub 页面与 API 的直接访问。

Edge 只是发布、商店和浏览器身份，绝不是产品能力开关。Chrome 和 Firefox 的行为保持不变。安装包证据可以记录完整能力对象，但产品运行时绝不能依赖它进行分支。

## 公开 URL

只使用无需认证即可访问的公开页面：

- [项目主页](https://github.com/izumi0uu/better-github-stars-manager)
- [支持与 issue 追踪](https://github.com/izumi0uu/better-github-stars-manager/issues)
- [Edge 隐私政策源码页](https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/zh/edge-privacy-policy.md)

在 Partner Center 中填写隐私 URL 前，必须确认审核过的版本无需认证即可公开访问。仓库文件不能证明 Partner Center 实际填写了哪个 URL 或版本。

## 商店文案

这些文案描述当前实现，但不代表 Partner Center 中已经填写了这些文字。

### 扩展名称

Better GitHub Stars Manager

### 简短描述

用搜索、标签、笔记、筛选、Watch Inbox、可选的 Gist 同步和本地优先 AI 助手管理 GitHub Stars。

### 详细描述

Better GitHub Stars Manager 把 GitHub Stars 页面变成本地优先的 Star 仓库浏览和整理工作区。

Microsoft Edge 版本可以：

- 在虚拟化表格中浏览大量 Star 仓库；
- 搜索仓库名称、描述、topics 和你的笔记；
- 用自定义标签和笔记整理仓库；
- 按语言、标签和未打标签状态筛选；
- 通过你自己的 Secret GitHub Gist 只同步批注层；
- 通过可选的 Watch Inbox 查看当前已 Star 仓库的 GitHub 通知，并单独查看已 Watch 仓库的参考计数；
- 使用你自己的 OpenAI、OpenRouter、Anthropic 或兼容 AI 服务运行 Cubby。

普通 Cubby 提示词可以授权有界的标签修改。每次写入仍受本轮本地证据、操作限制和当前写策略约束。

全库 Organize 是独立的工作流。它会冻结库范围，准备添加型标签建议，让你在 Review 中选择建议，只有你点击 **Apply** 后才会修改标签。

GitHub、Watch Inbox 和 Gist 请求直接发送到 GitHub。可选的 Cubby 请求直接发送到你选择的 AI 服务和精确配置的地址。开发者不运营代理或自定义后端。

### 建议分类

Partner Center 提供 **Developer Tools** 时选择该分类；否则选择最接近的效率分类，并记录实际保存的值。

搜索词最多七项，总计不超过 21 个词：

- GitHub stars
- repository manager
- tags
- notes
- developer tools
- Watch Inbox
- Following Radar

## 构建和安装包契约

Edge 目标必须与 Chrome 分开构建和打包：

```text
pnpm build:edge
pnpm package:edge
```

版本 `<version>` 的预期位置：

```text
dist-edge/manifest.json
artifacts/edge/better-github-stars-manager-edge-<version>.zip
artifacts/edge/better-github-stars-manager-edge-<version>.zip.sha256
artifacts/edge/release-evidence-<version>.provisional.json
```

ZIP 根目录必须直接包含 `manifest.json`。schema version 4 临时证据必须写明 `browserTarget: "edge"`，并记录完整能力对象：

```json
{
  "gistSync": true,
  "agent": true,
  "organizeProvider": true
}
```

该对象是安装包证据，不是运行时开关：产品运行时绝不能依赖它进行分支。

打包后的 manifest 必须与 Chrome manifest 完全一致：

- `manifest_version: 3`；
- 模块化 `background.service_worker`；
- `permissions` 中只能有 `storage` 和 `alarms`；
- 必需 `host_permissions`：`https://github.com/*`、`https://api.github.com/*`、`https://api.openai.com/*`、`https://openrouter.ai/*`、`https://api.anthropic.com/*`；
- `optional_host_permissions`：`https://*/*`、`http://localhost/*`、`http://127.0.0.1/*`；
- ZIP 内可解析的 popup、Options、content script、图标和 web accessible resource 路径；
- 不包含 `update_url` 和远程可执行代码。

安装包验证复用完整的 Chrome 权限和披露行为，保留远程可执行代码排除检查，并强制执行精确的 Edge service worker 身份基线（审核过的路径、字节数和 SHA-256 摘要）；仅靠大小上限不能代替身份批准。

不要重命名 Chrome ZIP 并把它作为 Edge 安装包提交。临时证据不是最终发布批准，也不能证明 Partner Center 状态。

## 运行 Edge smoke

把 `EDGE_EXECUTABLE` 设为 Microsoft Edge 可执行文件的完整路径，然后运行：

```text
EDGE_EXECUTABLE="/Microsoft Edge/的完整路径" pnpm test:smoke:edge
```

命令会用新 profile 加载 `dist-edge/`，并运行共享的完整产品 Chromium 场景集。它验证：

- MV3 service worker 启动；
- popup 和 Options 可用；
- 完整的 manifest 权限集合，包括必需 Provider 主机和可选自定义主机；
- Gist Push/Pull 和 Gist 能力探测；
- Cubby、Provider 设置和 Provider 驱动的全库 Organize；
- Stars 管理器保留 Sync、搜索、筛选、标签、笔记、收藏、确定性 Auto Tags、Watch Inbox 和 Following Radar；
- 受保护的检查期间，除已获准的 GitHub、Gist 和已配置 Provider 地址外，没有其他请求。

命令只启动显式提供的 Microsoft Edge 可执行文件，确认启动的浏览器报告 `Edg/<version>` 身份；缺少 Edge 或替换为 Chrome 时，命令会以可操作的消息失败。结果包含脱敏的 Edge 身份、可执行文件路径 SHA-256 摘要、扩展 ID、实际执行的场景 ID、有界诊断计数、安装包输入指纹和能力对象。结果不包含可执行文件路径、凭据、请求载荷、认证 Header、个人账号数据或私有仓库内容。

发布证明必须提供 `EDGE_EXECUTABLE`。导出的 smoke helper 可以用明确标记的非发布 Chromium 可执行文件测试本地契约，但结果必须写明 `releaseProof: false`，且不能满足 Edge 发布清单。

smoke 不会证明它没有实际执行的保留功能。如果审核要求这些场景，必须在同一指纹的安装包上完成下面的手动审核路径。

## 手动审核路径

使用新的 Edge profile 和合成数据或专用审核数据。在精确的完整产品安装包上：

1. 打开 popup 和 Options 页面。
2. 保存并验证一个专用 GitHub Classic PAT。
3. 打开 `https://github.com/your_username_here?tab=stars`。
4. 运行 Full Sync，并验证搜索、筛选、标签、笔记和收藏。
5. 打开 Watch，确认扩展检查现有 Classic PAT 且不会要求第二份凭据。刷新后确认只显示当前已 Star 仓库的通知，并单独展示已 Watch 仓库的参考计数。关闭 Watch，确认缓存 thread 被删除，而 Stars 仍可用。
6. 打开 Following Radar，并验证 `read:user` 能力路径。
7. 使用 **Push** 和 **Pull** 检查专用 Secret Gist 同步流程。
8. 在 Options 中选择 AI 服务，确认披露显示选定的服务和精确地址。完成明确的同意操作，输入模型和专用 AI 服务 Key，并运行 **Test connection**。
9. 对自定义兼容地址点击 **Allow access**，并确认拒绝访问后不会发起请求。
10. 让 Cubby 执行一次普通且有界的标签修改，确认只应用提示词授权且有本地证据支持的变化。
11. 在一次 turn 提交后重新加载页面，确认对话仍然可用。只有出现可见的可重试失败后才测试 **Retry**。
12. 在两个 GitHub 页面上打开 Cubby，在其中一个页面启动全库 Organize。确认第二个页面在所有者断开连接并明确选择 **Take control** 前保持只读。在 Review 中选择建议并点击 **Apply**，确认两个页面都收敛到终态回执。
13. 删除来源对话，确认终态 Organize 结果仍可查看，然后点击 **Dismiss**。
14. 重新加载扩展页面，并检查页面和 service worker console。

记录 Edge 版本、操作系统、源码提交、ZIP 校验和、安装包输入指纹和观察结果。绝不能记录凭据或私有内容。

## 权限和隐私回答

### 单一用途

在 GitHub 内使用本地搜索、筛选、标签、笔记、Watch Inbox、Following Radar、可选的 Gist 同步和本地优先 AI 助手整理 GitHub Star 仓库。

### 权限理由

- `storage`：把轻量配置、加密后的 GitHub Classic PAT 和 AI 服务凭据保存在扩展存储中；仓库和批注数据、Watch 快照、Cubby 有界的对话/恢复/产物账本，以及单独设置上限的 Organize 记录保存在本地 IndexedDB。
- `alarms`：让持久化的全库 Organize 分析和已批准的 Apply 操作跨越 MV3 service worker 挂起继续调度恢复工作。
- `https://github.com/*`：在 GitHub 页面挂载 Stars 管理器和仓库标签 chip。
- `https://api.github.com/*`：验证 Classic PAT，并提供 Stars、Watch、Notifications、Following、有界公开代码搜索和 Gist 同步路径。
- `https://api.openai.com/*`、`https://openrouter.ai/*`、`https://api.anthropic.com/*`：允许配置了对应 Provider 的用户测试连接，并让 Cubby 直接连接该服务运行。
- 可选的自定义 AI 服务主机（`https://*/*`、`http://localhost/*`、`http://127.0.0.1/*`）：连接安装时未知的自定义兼容地址。Options 只有在用户明确点击 **Allow access** 后才会请求访问，凭据和请求都绑定到精确配置的规范化地址（包括端口）。拒绝可选访问后，扩展不会发起 Provider 请求。

### 远程代码

只有在确认最终 ZIP 包含全部可执行依赖，并且不会获取或执行远程脚本后，才能回答 **No**。GitHub 和 Provider 响应是数据，不是扩展代码。

### 数据处理

Partner Center 申报必须与 [Edge 隐私政策](./edge-privacy-policy.md)一致。Edge 安装包处理 GitHub 身份和认证数据、Star 和已 Watch 仓库 metadata、可选通知和 Following 活动 metadata、用户创建的标签和笔记、可选的 Gist 批注同步，以及发送给你选择的 AI 服务的 Cubby 任务数据。它不会把数据发送到开发者代理、分析服务或广告服务。

不要声称扩展不处理用户数据。

## 认证备注和 PAT scopes

测试凭据只能放在 Partner Center 私有认证备注中。不要把凭据写入源码、文档、截图、日志、安装包或证据。

完整的审核路径使用专用、最小权限、可撤销的 GitHub Classic PAT：

```text
repo,gist,notifications,read:user
```

`repo` 和 `gist` 是完整核心体验的必需权限：`gist` 启用 Secret Gist 同步路径及其已验证的创建/删除探测。`notifications` 启用可选的 Watch Inbox，`read:user` 启用 Following Radar。不要授予组织管理、workflow、删除仓库、密钥、审计日志、enterprise、package 或 Webhook 管理权限。专用 AI 服务凭据也通过同一私有备注提供。认证活动结束后撤销或轮换 PAT 和 AI 服务 Key。

## Listing 素材

Partner Center 素材与扩展安装包分开上传。

| 素材 | Edge 计划 | 仓库来源 |
| --- | --- | --- |
| 扩展 Logo | 上传前检查 | `public/icons/icon-128.png` |
| 截图 | 复用已准备的完整产品截图集；上传前重新生成并检查 | `public/store/screenshots/screenshot-main-stars.png`、`screenshot-detail-panel.png`、`screenshot-agent-disclosure-light-1280x800.png`、`screenshot-agent-disclosure-dark-640x400.png` |
| Small promotional tile | 复用已准备的 tile；上传前检查 | `store-assets/promo/small-tile.png` |
| Large promotional tile | 复用已准备的 marquee；上传前检查 | `store-assets/promo/marquee.png` |

Edge 安装包渲染与 Chrome 相同的产品，因此已准备的素材展示的就是当前产品体验。每次上传前都应重新生成并检查每个素材；仓库文件不能证明上传顺序、locale 分配、审核状态或公开渲染效果。

## Partner Center 步骤

首次提交仍然是外部手动操作：

1. 打开 [Edge developer dashboard](https://partner.microsoft.com/dashboard/microsoftedge/public/login)。
2. 创建新扩展草稿。
3. 上传验证过的 Edge ZIP。
4. 填写 Availability 和 Properties。
5. 填写商店文案和 Edge 隐私 URL。
6. 填写准确的权限、远程代码和数据使用回答。
7. 添加私有审核说明、专用 PAT 和 AI 服务凭据。
8. 解决全部安装包和表单验证错误。
9. 只有在本地和手动证据审核完成后才提交。

草稿上传、认证和发布必须分别记录。Microsoft Update REST API 只能用于 product 已存在后的更新；它不能证明或创建第一个公开 listing。

## 提交前检查清单

- [ ] Partner Center 注册状态已经验证。
- [ ] 精确源码提交和 Edge 目标已经批准。
- [ ] `dist-edge/` 和 `artifacts/edge/` 包含新生成的目标专用输出。
- [ ] ZIP、校验和、临时证据和安装包输入指纹一致。
- [ ] ZIP 根目录包含 `manifest.json` 和完整的 Chrome 等价权限集合。
- [ ] 证据记录 `browserTarget: "edge"`、完整能力对象 `{gistSync: true, agent: true, organizeProvider: true}` 和精确的 Edge worker 身份基线。
- [ ] 真实 Microsoft Edge smoke 使用显式 `EDGE_EXECUTABLE`，在精确指纹上观察到 `Edg/<version>` 身份并通过。
- [ ] 审核所需的完整产品场景在同一安装包上通过。
- [ ] Edge 隐私政策已经审核，且无需认证即可公开访问。
- [ ] 商店文案和截图展示完整功能集。
- [ ] 审核 PAT 包含 `repo,gist,notifications,read:user`，且 AI 服务凭据为专用。
- [ ] 凭据只存在于私有认证备注中。
- [ ] 没有外部证据时，不声称已经上传、认证、审核或发布。
- [ ] 公开 listing URL 被观察到前，README 继续显示“即将上架”。

## Microsoft 官方参考

- [注册 Microsoft Edge 扩展开发者账户](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)
- [发布 Microsoft Edge 扩展](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- [Microsoft Edge Add-ons 开发者政策](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)
- [将 Chrome 扩展移植到 Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension)
- [Microsoft Edge 扩展 API 支持列表](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)
- [使用 Update REST API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)
