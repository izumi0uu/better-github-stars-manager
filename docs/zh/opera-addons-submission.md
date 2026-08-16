# Opera Add-ons 提交参考

[English](../en/opera-addons-submission.md)

这份参考说明 Better GitHub Stars Manager 提交至 Opera Add-ons 前需要完成的产品决策、安装包证据、商店素材和手动步骤。它不表示当前 Chromium 安装包已经符合 Opera 审核政策，也不表示某个提交已经上传、审核或发布。

## 证据边界

以下状态必须分别记录：

1. **Chromium 候选包**：通过验证的 Chrome 包只能证明 Chromium manifest 和安装包闭包，不能证明符合 Opera 政策
2. **Opera 目标决策**：维护者必须批准完整功能或受限的 Opera 构建
3. **Opera smoke**：sideload 运行只能证明实际执行的场景和平台
4. **上传**：只有登录后的 Opera upload form 能接受安装包
5. **审核与发布**：只有 Opera moderator 能决定是否接受和发布

直接观察到公开 listing URL 前，README 中的 Opera 条目必须保持“即将上架”。

## 注册开发者账户

Opera Add-ons 要求使用 Opera Account 登录扩展仓库。公开文档没有列出开发者注册费。

提交前：

- 在登录后的 portal 中验证账户邮箱和 publisher identity
- 使用你有权展示的 publisher name
- 接受当前 Opera Add-ons 条款
- 记录草稿流程中出现的 portal 专用账户或安装包要求

不要从公开文档推断私有 portal 状态。

## 公开 URL

只使用无需认证即可访问的公开页面：

- [项目主页](https://github.com/izumi0uu/better-github-stars-manager)
- [浏览器中立隐私政策](https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/zh/privacy-policy.md)
- [支持与 issue 追踪](https://github.com/izumi0uu/better-github-stars-manager/issues)

现有政策描述了 GitHub、Gist 和 AI Provider 的直接数据流，但没有解决 Opera moderator 是否接受这些数据流的问题。

## 选择 Opera 产品范围

Opera acceptance criteria 禁止把 private data 发送到 external store。Better GitHub Stars Manager 可以把私有笔记发送到用户自己的 Secret Gist，也可以把有范围限制的任务数据发送到用户选择的 AI Provider。扩展会披露这些传输，并且不使用开发者运营的后端，但 Opera 的公开政策没有说明用户指定的 Gist 和 AI 服务是否属于例外。

最终打包前选择一个目标：

### 完整功能目标

保留 Stars、Gist 同步、Watch、Radar、Cubby 和 Organize。只有在 Opera 提供书面说明，确认这些用户指定的数据传输和控制符合政策后，才能提交该目标。

### 受限的本地优先目标

移除所有会把私有笔记、提示词或任务数据发送到 external store 的功能：

- 禁用 Gist Push 和 Pull
- 禁用 Cubby 和 Organize Provider 流量
- 移除内建 AI Provider 主机权限
- 移除可选兼容 Provider 和 loopback 主机权限
- 同步更新商店文案、隐私政策、测试和截图

受限目标是独立的产品契约，不是只修改 listing。必须先实现并验证，再生成安装包。

## 候选商店文案

产品范围批准前，不要把最终文案保存到 Opera。以下完整功能候选文案与当前共享实现一致。

### 名称

Better GitHub Stars Manager

### 打包 manifest 描述

Manage your GitHub starred repos: tag, note, filter, search across thousands of stars. UI injected into the stars page.

这只是安装包证据，不是可以直接提交的 Opera 摘要。最后一段是句子片段。如果 Opera 从 manifest 读取 listing summary，必须更新 `package.json`、重新构建安装包，并在上传前重新运行安装包验证。

### Portal 摘要

Better GitHub Stars Manager helps you search, filter, tag, and annotate starred GitHub repositories in a local-first workspace.

只有登录后的 Opera form 提供独立可编辑 summary 字段时，才能使用这段文案。提交前确认 portal 中实际保存的值。

### 详细描述

Better GitHub Stars Manager 把 GitHub Stars 页面变成本地优先的 Star 仓库浏览和整理工作区。

主界面以可搜索的虚拟化仓库表格显示在 GitHub Stars 页面中。工具栏提供搜索、语言和标签筛选，仓库行展示标签和私有笔记。Popup 和 Options 页面用于设置和配置。

你可以用它：

- 浏览和搜索大量 Star 仓库
- 按语言和标签筛选仓库
- 添加本地标签和私有笔记
- 查看可选的 Watch Inbox 和 Following 动态
- 启用后，通过自己的 Secret GitHub Gist 同步批注
- 启用后，通过你选择的 AI 服务和精确地址运行 Cubby

扩展会把 GitHub 和 Gist 请求直接发送到 GitHub。可选的 Cubby 请求直接发送到选择的 AI 服务。开发者不运营代理或自定义后端。

MV3 background service worker 负责 GitHub 和可选 Provider 请求。长时间运行的 Organize 分析可以在后台继续，并在 worker 挂起后恢复；已经批准的 Apply 工作也可以恢复。只有在你选择建议并点击 **Apply** 后，标签才会改变。

如果批准的 Opera 目标移除了 Gist 或 AI 功能，提交前必须删除所有对应文案。

### 分类

Productivity

### 许可证

MIT License

必须明确选择仓库的 MIT License。Opera 发布指南说明，不指定许可证会应用不同的默认许可证。

## 安装包契约

Opera 支持 Chromium 扩展架构，以及受支持 API 的 `chrome.*` 命名空间。Opera 也已经宣布新的商店上传必须使用 Manifest V3（MV3）。

完整功能候选从经过验证的 Chromium 产物开始：

```text
artifacts/better-github-stars-manager-<version>.zip
```

ZIP 根目录必须直接包含 `manifest.json`。候选包必须包含：

- `manifest_version: 3`
- 打包在扩展内的 MV3 background service worker
- 全部 popup、Options、content script、图标和运行时资源
- 不包含外部 JavaScript
- 不包含未使用的开发文件或源码专用文件
- 只包含批准的 Opera 目标真正需要的权限

Opera 的公开架构页面描述 Chromium ZIP 和 CRX 格式，但登录后的 upload form 才是当前接受文件类型的事实来源。不要在没有验证表单的情况下把 ZIP 直接重命名为 `.crx`。

仓库还没有单独验证的 Opera target 或标记为 Opera 的发布证据。

## 让代码可审核

Opera acceptance criteria 拒绝 reviewer 无法检查的第一方代码。Production Vite 输出包含 minification，因此提交时必须提供公开的可读源码和精确重建说明。

提供以下任一源码来源：

- 包含精确提交源码和 lockfile 的不可变 Git tag
- 从精确提交生成的 Opera 专用 reviewer source archive

Firefox reviewer source ZIP 不能替代 Opera 源码包，因为它生成的说明和预期输出以 Firefox 为目标。Opera 源码包必须能够重建提交的 Opera 或 Chromium 字节。

记录：

- 可复现性检查使用的操作系统
- Node.js 版本
- `package.json` 中的 pnpm 版本
- `pnpm install --frozen-lockfile`
- 精确的目标构建和打包命令
- 预期安装包名称和 SHA-256 校验和
- 第一方源码和未修改第三方库之间的区别

Reviewer source archive 不得包含 Git 元数据、依赖目录、构建输出、凭据、个人路径、私有数据或外部工作项文本。

## 准备 Opera 专用截图

当前 Chrome 截图为 1280×800，超过 Opera 文档规定的 800×600 上限。现有 640×400 disclosure 截图符合像素范围，但不能证明核心流程在 Opera 中运行。

在干净 Opera profile 中至少截图两张：

1. 包含搜索、筛选和标签的 Stars 管理器
2. 与批准的 Opera 产品范围一致的 Options 或 popup 流程

图片要求：

- 建议 612×408
- 最大 800×600
- 条件允许时使用白色背景
- 使用默认 Opera UI
- 不展示无关标签页、其他扩展或自定义 UI
- PNG 不使用 interlaced
- 不包含个人账号数据、私有仓库、笔记、提示词或凭据

不要机械缩小 Chrome 截图后把它当作 Opera 运行证据。

## 审核 manifest 和权限

对照批准的 Opera 目标检查精确的打包 manifest。共享完整功能候选目前请求：

- `storage` 和 `alarms`
- `https://github.com/*`
- `https://api.github.com/*`
- 内建 OpenAI、OpenRouter 和 Anthropic 主机
- 用户配置兼容 Provider 所需的可选 `https://*/*` 和 loopback 主机

逐项检查权限：

- 记录需要该权限的可见功能
- 批准的 Opera 目标不包含对应功能时删除权限
- 在 listing 中描述后台行为
- 确认不包含 `update_url`、Chrome 商店标识或不适用的浏览器声明

Opera 会拒绝冗余权限和不必要的 manifest 字段。

## 运行 Opera smoke

在干净 Opera profile 中 sideload 精确候选包，并测试批准的功能范围。至少执行：

1. 打开 popup 和 Options
2. 保存并验证一个专用 GitHub Classic PAT
3. 打开 `https://github.com/your_username_here?tab=stars`
4. 运行 Full Sync
5. 验证搜索、筛选、标签、笔记和仓库 chip
6. 如果 Opera 目标保留 Watch 和 Radar，验证这两项功能
7. 只有在 Opera 批准对应数据流时，才验证 Gist 和 AI disclosure
8. 拒绝可选权限，并确认无关功能仍可用
9. 挂起或重新加载后台运行时，并验证恢复
10. 检查扩展和页面 console，确认没有未捕获错误

Opera 说明 moderator 会在 Windows、macOS 和 Linux 测试。必须如实记录平台覆盖。macOS smoke 通过不能证明 Windows 或 Linux 行为。

## 准确说明数据处理

Listing 和隐私回答必须列出批准目标中保留的全部数据流：

- 从 GitHub 请求的 GitHub 身份和仓库元数据
- 本地标签、笔记、偏好、Watch 记录和 Cubby 记录
- 可选发送到用户 Secret Gist 的批注数据
- 可选发送到选择的 AI Provider 的 Cubby 任务数据
- 不使用开发者运营的代理、分析 SDK、广告 SDK 或自定义后端

保留 Gist 或 Cubby 时，不要声称所有数据都留在设备内。目标通过政策审核和真实 Opera smoke 前，不要声称完整 Opera 功能对等。

## 私下提供审核凭据

使用专用、最小权限、可撤销的凭据。任何 Secret 都不能进入源码、文档、截图、日志、ZIP 或发布证据。

完整审核路径使用以下 GitHub Classic PAT scope：

```text
repo,gist,notifications,read:user
```

受限 Opera 目标移除某项依赖功能后，应减少凭据 scope。只有批准目标包含 Cubby，且 Opera moderator 要求测试该路径时，才提供 AI 凭据。

审核后：

- 撤销或轮换全部审核凭据
- 删除审核 Gist
- 清理所有合成外部数据

## 手动提交

Opera 没有公开开发者发布 API。除非登录后的 portal 提供受支持的工作流，否则首次提交和更新都按手动流程处理。

1. 登录 [Opera extensions repository](https://addons.opera.com/extensions/)
2. 打开 [Upload Extensions form](https://addons.opera.com/developer/upload/)
3. 上传当前表单接受的安装包格式
4. 填写批准的名称、分类、许可证、摘要和详细描述
5. 添加支持页面和公开隐私政策
6. 上传 Opera 专用截图和图标
7. 通过表单或 reviewer 私有渠道提供精确源码和构建说明
8. 在最终确认页面逐项检查字段
9. 提交 moderation
10. 在 [Submitted extensions](https://addons.opera.com/developer/) 中查看结果

如果 Opera 拒绝安装包，把 reviewer 消息保留在产品代码之外，并把它转换成通用产品要求。修复验证完成后，通过 portal 为该 product 显示的路径提交更正版本。

## 提交前检查清单

- [ ] Opera Account 可以访问开发者 portal
- [ ] 维护者已批准完整功能或受限 Opera 目标
- [ ] Opera 书面说明覆盖 Gist 和 AI 数据流，或者安装包不包含这些功能
- [ ] 已记录精确源码提交和安装包版本
- [ ] 安装包使用 MV3，且不包含外部 JavaScript
- [ ] 每项权限都属于批准目标
- [ ] 提交的摘要是完整句子；如果 Opera 从 manifest 读取摘要，安装包已使用合规文案重新构建
- [ ] 详细描述覆盖 UI 外观，以及后台 Organize 和 Apply 恢复
- [ ] 可读源码和可复现构建说明与提交字节一致
- [ ] Opera 专用截图符合文档尺寸
- [ ] 批准的功能范围通过真实 Opera smoke
- [ ] 如实记录 Windows、macOS 和 Linux 覆盖
- [ ] 商店文案和隐私政策与提交目标一致
- [ ] 审核凭据保持私有且可撤销
- [ ] 直接观察到公开 listing URL 前，README 仍显示“即将上架”

## Opera 官方参考

- [Opera 扩展发布指南](https://help.opera.com/en/extensions/publishing-guidelines/)
- [Opera Add-ons acceptance criteria](https://help.opera.com/en/extensions/acceptance-criteria/)
- [Opera 扩展架构](https://help.opera.com/en/extensions/architecture-overview/)
- [Opera 扩展 manifest 参考](https://help.opera.com/en/extensions/manifest/)
- [Opera 扩展 API 参考](https://help.opera.com/en/extensions/apis/)
- [Opera MV2 与 MV3 过渡说明](https://blogs.opera.com/news/2025/09/mv2-extensions-opera/)
