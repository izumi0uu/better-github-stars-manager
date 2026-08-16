# Microsoft Edge Add-ons 提交参考

[English](../en/edge-addons-submission.md)

这份参考说明如何准备 Better GitHub Stars Manager 并提交至 Microsoft Edge Add-ons。它记录安装包、商店文案、隐私、测试和发布要求，但不表示 Partner Center 已接受或发布某个提交。

## 证据边界

以下外部状态必须分别记录：

1. **本地安装包**：确定性的 Chromium ZIP、校验和与发布证据只能证明本地包结构
2. **Edge smoke**：sideload 运行只能证明在对应 Microsoft Edge 版本中实际执行过的场景
3. **Partner Center 草稿**：上传成功只能证明 Partner Center 接受了草稿
4. **认证审核**：只有 Microsoft 能决定扩展是否符合 Edge Add-ons 政策
5. **公开发布**：只有公开的 Edge Add-ons listing URL 能证明已经发布

直接观察到公开 listing URL 前，不要替换 README 中的占位链接。

## 注册开发者账户

Microsoft Edge Add-ons 使用 Microsoft Partner Center。注册时必须让 Microsoft Account（MSA）成为 Partner Center 的 Primary Owner。

注册前：

- 谨慎选择 **Individual** 或 **Company**，账户类型在注册后不能更改
- 谨慎选择账户所在国家或地区，该字段注册后只读
- 使用你有权使用的 Publisher display name
- Company 账户需要额外的法律信息和联系人验证

Microsoft 明确说明 Edge 扩展开发者注册不收费。工作或学校账户不能直接作为 Primary Owner 注册；需要时，可在 MSA 注册完成后关联组织访问。

## 公开 URL

只使用无需认证即可访问的公开页面：

- [项目主页](https://github.com/izumi0uu/better-github-stars-manager)
- [支持与 issue 追踪](https://github.com/izumi0uu/better-github-stars-manager/issues)
- Edge 专用隐私政策：尚未发布

当前浏览器中立隐私政策描述了产品行为，但 Microsoft 政策要求提交的隐私政策应主要描述 Microsoft Edge。提交前必须发布并审核 Edge 专用政策。

## 商店文案

以下文案描述完整的当前产品。只有直接检查 Partner Center 中保存的草稿后，才能确认外部字段内容。

### 扩展名称

Better GitHub Stars Manager

### 简短描述

Manage your GitHub starred repos: tag, note, filter, search across thousands of stars. UI injected into the stars page.

该值来自 `package.json`，并由 `manifest.config.ts` 写入安装包。当前 manifest 描述没有本地化；修改它需要重新上传安装包。

### 详细描述

Better GitHub Stars Manager 把 GitHub Stars 页面变成本地优先的 Star 仓库浏览和整理工作区。

你可以用它：

- 在虚拟化表格中浏览大量 Star 仓库
- 搜索仓库名称、描述、topics 和你的笔记
- 用自定义标签和笔记整理仓库
- 按语言、标签和未打标签状态筛选
- 通过自己的 Secret GitHub Gist 只同步批注层
- 通过可选的 Watch Inbox 查看当前已 Star 仓库的 GitHub 通知
- 查看 Following 动态和确定性的仓库推荐
- 使用自己的 OpenAI、OpenRouter、Anthropic 或兼容 AI 服务运行 Cubby

普通 Cubby 提示词可以授权有界的标签修改。全库 Organize 会冻结库范围，准备添加型标签建议，并且只有在你选择建议并点击 **Apply** 后才修改标签。

GitHub、Watch Inbox 和 Gist 请求直接发送到 GitHub。可选的 Cubby 请求直接发送到选定的 AI 服务和精确配置的地址。开发者不运营代理或自定义后端。

### 建议分类

Partner Center 提供 Developer Tools 时选择该分类。否则选择最接近的效率分类，并在发布清单中记录实际保存的值。

### 建议搜索词

搜索词最多七项，总计不超过 21 个词：

- GitHub stars
- repository manager
- tags
- notes
- developer tools
- Watch Inbox
- AI assistant

## Chromium 安装包契约

完整功能 Edge 候选包复用经过验证的 Chrome Chromium 包。安装包必须来自精确的干净发布提交，不能从旧的 artifact 目录复制。

预期产物：

```text
artifacts/better-github-stars-manager-<version>.zip
```

ZIP 根目录必须直接包含 `manifest.json`。打包后的 manifest 必须包含：

- `manifest_version: 3`
- 模块化 `background.service_worker`
- `storage` 和 `alarms`
- GitHub 与内建 AI Provider 的必需主机权限
- 用户配置兼容 Provider 所需的可选主机权限
- ZIP 内可以解析的 popup、Options、content script、图标和 web accessible resource 路径
- 不包含 `update_url`
- 不包含远程可执行代码

Microsoft 说明 Chrome 扩展具备广泛的兼容性，但安装包兼容不等于运行证据。提交前必须对照当前 Edge API 支持列表，并 sideload 精确的候选包。

### 受限 Edge 目标

受限 Edge 包不是共享 Chromium 产物。仓库目前没有 `build:edge` 或 `package:edge` 脚本、Edge 专用 manifest 转换、目标标记安装包或 Edge 发布证据。在这些边界实现并通过验证前，受限 Edge 产物并不存在。

如果 Microsoft 不批准当前 AI 和 Gist 数据流，必须在上传前把受限目标实现为独立产品契约：

- 在产品中禁用 Gist Push 和 Pull、Cubby 和 Organize Provider 流量，而不只是修改商店文案
- 从打包 manifest 中移除内建 AI Provider 主机，以及可选兼容 Provider 和 loopback 权限
- 增加目标感知的构建、manifest、打包、校验和、可复现性和发布证据步骤，同时保持 Chrome 输出不变
- 更新 Edge 商店文案、隐私政策、截图、权限回答、审核凭据和 smoke 场景，使其对应缩减后的功能范围
- 在 Edge 中验证精确的受限安装包，并运行相关 Chrome 回归检查

不要把共享 Chrome ZIP 当作受限 Edge 包提交。

## 生成发布证据

记录已批准候选版本、当前公开版本和上次上传版本后，从干净 checkout 运行 Chromium 发布流水线。命令和发布证据规则见 [Chrome Web Store 提交参考](./chrome-web-store-submission.md)。

上传前确认：

- 最终证据记录预期源码提交
- `source.dirty` 为 `false`
- `package.releaseReady` 为 `true`
- ZIP 校验和与 `.sha256` 文件一致
- ZIP manifest 报告已批准版本
- 现有 Chrome 安装包仍通过仓库要求的 smoke 验证

仓库目前不会通过 CI 发布 Edge 安装包。

## 运行真实 Edge smoke

在 `edge://extensions` 中开启 Developer mode，并 sideload 精确的 `dist/` 输出。使用新的 Edge profile 和合成数据或专用审核数据。

执行以下场景：

1. 打开 popup 和 Options 页面
2. 保存并验证一个专用 GitHub Classic PAT
3. 打开 `https://github.com/your_username_here?tab=stars`
4. 运行 Full Sync，并验证搜索、筛选、标签和笔记
5. 打开仓库页面并验证仓库标签 chip
6. 启用 Watch Inbox，并验证 capability 检查和刷新流程
7. 打开 Following Radar，并验证 `read:user` capability 路径
8. 为一个 Provider 和精确地址接受 AI 数据披露
9. 测试一个内建 Provider，以及一个拒绝自定义 Provider 主机权限的路径
10. 启动、审核并应用一个有界的 Organize 任务
11. 重新加载扩展页面，并验证 service worker 挂起后的恢复
12. 检查页面和 service worker console，确认没有未捕获错误

记录 Edge 版本、操作系统、源码提交、安装包校验和和观察结果。不要记录凭据、认证 Header、个人账号数据或私有仓库内容。

## 准备 listing 素材

Partner Center 将素材与扩展安装包分开上传。

| 素材 | Edge 要求 | 仓库候选文件 |
| --- | --- | --- |
| 扩展 Logo | 正方形，至少 128×128，建议 300×300 | `public/icons/icon-128.png` |
| Small promotional tile | 可选，440×280 | `store-assets/chrome-web-store/small-promo-440x280.png` |
| Large promotional tile | 可选，1400×560 | `store-assets/promo/marquee.png` |
| 截图 | 可选，最多六张，640×480 或 1280×800 | `store-assets/chrome-web-store/*-1280x800.png` |

在 Partner Center 中检查每张已上传图片。仓库文件不能证明上传顺序、locale 分配、认证结果或公开渲染效果。

## 填写 Privacy 页面

Partner Center 要求填写单一用途、权限理由、远程代码、数据使用和隐私政策。

### 单一用途

在 GitHub 内用本地搜索、筛选、标签、笔记、可选的用户控制同步和可选的用户配置 AI 助手整理 GitHub Star 仓库。

### 权限理由

Partner Center 要求解释打包后的权限时，使用以下事实：

- `storage`：把轻量配置和加密凭据保存在扩展存储中；仓库、批注、Watch、Cubby 和 Organize 的批量记录保存在本地 IndexedDB
- `alarms`：在 MV3 service worker 挂起后，为持久化的 Organize 分析和已批准的 Apply 工作安排恢复
- `https://github.com/*`：在 GitHub 页面挂载 Stars 管理器和仓库标签 chip
- `https://api.github.com/*`：验证 Classic PAT，并提供 Stars、Watch、Notifications、Following、公开代码搜索和可选 Gist 同步
- 内建 AI Provider 主机：只在用户选择 Provider 并接受披露后测试和运行 Cubby
- 可选 `https://*/*` 和 loopback 主机：只连接用户输入并明确允许的精确兼容 Provider 地址

### 远程代码回答

只有在确认最终 ZIP 包含全部可执行依赖，并且不会获取或执行远程脚本后，才能回答 **No**。Provider 响应是数据，不是扩展代码。

### 数据处理

选择当前 Partner Center 中与已发布行为匹配的全部数据类别。表单要求时也要申报本地处理。申报内容必须覆盖：

- GitHub 账号信息和 Classic PAT 认证
- Star 仓库、Watch 仓库和通知元数据
- 标签和私有笔记
- 可选的 Secret Gist 同步
- 可选的 Cubby 提示词、范围内仓库元数据、代码片段、笔记和 Provider 响应
- 本地对话、恢复、产物和 Organize 记录

不要声称扩展不处理用户数据。

## 解决 Edge 专用政策阻塞

Microsoft 政策要求向第三方共享数据前取得明确 opt-in，并且在产品 UI 中提供撤回入口。扩展已经使用 Provider 与 origin 绑定的披露接受来限制 Provider 流量，但当前 UI 没有专用撤回控制。

明确同意和撤回入口是必要条件，但不一定充分。公开政策还把第三方共享限制在指定允许用途内，并没有明确确认用户选择的 AI 推理或 Secret Gist 同步符合该限制。必须获得 Microsoft 对这两种数据流的书面说明。如果无法获得说明，必须在上传前实现并验证上文所述的受限 Edge 目标；当前共享 Chrome ZIP 不能作为替代。

提交前：

- 发布主要描述 Microsoft Edge 的 Edge 专用隐私政策
- 增加 **Disable AI sharing** 或 **Revoke consent** 等明确入口
- 用户撤回后停止所有后续 Provider 流量
- 保持 Stars、Watch、Radar、本地整理和 GitHub API 功能可用
- 说明如何关闭 Gist 同步并删除 Secret Gist
- 确认打包行为与政策和 Partner Center 回答一致

这些是提交阻塞，不是可选的 listing 润色。

## 提供认证审核备注

只在 Partner Center 的私有认证备注中保存测试凭据。不要把凭据写入源码、文档、截图、日志、ZIP 或发布证据。

完整审核路径使用专用、最小权限、可撤销的 GitHub Classic PAT：

```text
repo,gist,notifications,read:user
```

说明哪些 scope 启用可选的 Watch Inbox 和 Following Radar。只有认证需要测试 Cubby 时才提供专用 AI Provider 凭据。认证完成后撤销或轮换全部凭据，并删除审核 Gist。

对于受限 Edge 目标，除非其他已批准功能需要，否则不要提供 AI 凭据或 `gist` scope。

## 通过 Partner Center 提交

首次提交必须手动完成：

1. 打开 [Edge developer dashboard](https://partner.microsoft.com/dashboard/microsoftedge/public/login)
2. 点击 **Create new extension**
3. 上传批准的 Edge 目标所对应的已验证安装包
4. 在 **Availability** 中配置可见性和市场
5. 在 **Properties** 中填写分类、网站、支持方式和成熟内容
6. 在 **Privacy** 中填写单一用途、权限、远程代码、数据使用和隐私政策
7. 在 **Store listings** 中完成每个语言
8. 在 **Notes for certification** 中加入私有测试步骤
9. 解决全部安装包和表单校验错误
10. 提交草稿进行认证

分别记录上传、认证和发布状态。

## 只自动化后续更新

Microsoft Update REST API 只能在首个 product 已存在后上传并发布安装包更新。它不能创建新 product，也不能修改 listing metadata。

首个 listing 发布且手动字段验证完成前，不要添加 API 凭据。Client ID 与 API Key 必须保存在仓库 Secret 中，不能进入 tracked file。

## 提交前检查清单

- [ ] Partner Center 注册状态已经验证
- [ ] 精确源码提交干净且已批准
- [ ] Chromium 发布门禁生成新的最终 ZIP
- [ ] ZIP 根目录包含 `manifest.json`
- [ ] 安装包不包含 `update_url` 或远程可执行代码
- [ ] 精确安装包通过真实 Edge smoke
- [ ] Edge 专用隐私政策已公开且无需认证
- [ ] AI 明确同意和撤回控制已实现并验证
- [ ] Microsoft 书面说明覆盖 AI 和 Gist 数据流，或者受限 Edge 目标已经实现并验证
- [ ] 受限目标具备独立的构建、manifest 转换、安装包、发布证据、商店文案、隐私政策和 smoke 证明
- [ ] 权限和数据回答与最终 manifest 和政策一致
- [ ] 商店文案与图片对应当前产品
- [ ] 审核凭据只存在于私有认证备注
- [ ] 直接观察到公开 listing URL 前，README 仍显示“即将上架”

## Microsoft 官方参考

- [注册 Microsoft Edge 扩展开发者账户](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)
- [发布 Microsoft Edge 扩展](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- [Microsoft Edge Add-ons 开发者政策](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)
- [将 Chrome 扩展移植到 Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension)
- [Microsoft Edge 扩展 API 支持列表](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)
- [使用 Update REST API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)
