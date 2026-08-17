# Microsoft Edge 隐私政策

[English](../en/edge-privacy-policy.md)

生效日期：2026-08-16

本政策适用于 Better GitHub Stars Manager 的 Microsoft Edge 构建。它描述该构建已经实现的行为，但不表示 Microsoft 已经审核、认证或发布该扩展。

Better GitHub Stars Manager 用于在 GitHub 内整理 Star 仓库。Edge 构建采用本地优先方式，直接连接 GitHub 和你选择的 AI 服务。开发者不运营代理、分析后端、广告服务或自定义数据服务。

## 单一用途

Edge 构建帮助你获取、浏览、搜索、筛选、打标签、批注和重新查看 GitHub Star 仓库。可选的 Watch Inbox 和 Following Radar 使用 GitHub 数据。你可以通过自己的 Secret GitHub Gist 同步批注层，也可以选择运行 Cubby 本地优先 AI 助手，连接你选择的 AI 服务。全库 Organize 会为冻结的库范围准备添加型标签建议，只有你点击 **Apply** 后才会修改标签。

## Edge 构建处理的数据

根据你使用的功能，扩展会处理：

- 你在 Options 中输入的 GitHub Classic Personal Access Token（PAT）；
- GitHub 账号身份，例如用户名、显示名称和头像 URL；
- Star 仓库 metadata，包括仓库名称、URL、描述、语言、topics、Star 数量和日期；
- 启用 Watch Inbox 后的已 Watch 仓库成员关系；
- 符合 Watch 范围的 GitHub 通知 metadata，包括仓库、原因、主题标题和类型、安全的 GitHub 链接、未读状态、更新时间和已读时间；
- Radar 和确定性推荐使用的 Following 活动和公开仓库 metadata；
- 你在本地创建的标签、笔记、收藏、筛选器、布局偏好和其他设置；
- 可选同步所用专用 Secret GitHub Gist 的 metadata；
- Cubby 服务配置，包括 Provider、模型、规范化服务地址、加密后的 API Key 材料和连接状态；
- 已提交的 Cubby 对话历史和不可变的已接纳尝试记录，其中包括每次已接纳的提示词；
- 用于在中断后继续已接纳尝试的有界恢复投影；
- 当工具结果无法装入扩展消息或模型结果时使用的分页工具产物和可重新获取的工具缓存；
- 独立的 Organize 数据，包括指令、冻结的范围、提案、Review 和 Apply 状态，以及最近一次完成或取消的结果；
- 用于显示所请求功能是否成功的刷新状态，以及有界运行诊断。

Edge 构建只会为 GitHub 和你选择的 AI 服务请求凭据。它不会把提示词、笔记、仓库数据或其他用户内容发送给任何其他服务。

## GitHub 凭据和 scopes

Edge 构建使用一个 GitHub Classic PAT 提供你请求的 GitHub 功能。完整的可选功能路径可能使用以下 scopes：

```text
repo,gist,notifications,read:user
```

- `repo` 用于 Stars 和仓库访问，包括你的 GitHub 账号有权访问的私有仓库；
- `gist` 用于可选的 Secret Gist 同步路径，以及用于确认能力的已验证 Gist 创建/删除探测；
- `notifications` 用于可选的 Watch Inbox；
- `read:user` 用于 Following Radar。

Edge 构建只请求上面列出的 scopes。不使用对应可选功能时，你可以按照 Options 中的说明省略相应可选 scope。

## 数据用途

扩展只会为了你请求的功能使用数据：

- 向 GitHub 认证，并确认 PAT 对应的账号；
- 获取和刷新 Star 仓库；
- 提供本地搜索、筛选、标签、笔记、收藏和确定性 Auto Tags；
- 显示可选的已 Watch 仓库通知；
- 显示 Following 活动和确定性推荐；
- 只有在你使用 **Push** 或 **Pull** 时，才通过 Secret Gist 同步批注层；
- 让 Cubby 分析你明确选择或冻结的仓库范围，并执行普通的有界标签修改；
- 运行包含 Review 和 Apply 的全库 Organize 工作流；
- 在符合条件的 GitHub 页面挂载 Stars 管理器和仓库标签 chip。

扩展不会出售数据，不会将数据用于广告、信用评估或借贷决策，也不会把数据发送到开发者运营的后端。

## 存储和保留

- GitHub PAT 和 AI 服务 API Key 使用 AES-GCM 加密后保存到 Microsoft Edge 扩展存储（`chrome.storage.local`）。AI 服务 Key 绑定到选定的 Provider 和规范化服务地址。这可以降低明文存储暴露风险，但不等同于操作系统 Keychain 保护。
- 轻量配置，包括绑定的 Gist ID，保存在 `chrome.storage.local`。
- Star metadata、标签、笔记、收藏、Watch 记录、Radar 记录和本地查询状态保存在扩展本地 IndexedDB。
- Watch 仓库范围、通知 thread 快照和刷新状态以未加密形式保存在本地 IndexedDB。
- 已提交的 Cubby 对话历史、尝试和恢复记录以及分页产物以未加密形式保存在扩展本地 IndexedDB。
- 只有在你使用 **Push** 或 **Pull** 时，标签、笔记和标签 metadata 才会写入 Secret GitHub Gist。
- Watch 范围和通知记录、Cubby 对话/恢复/产物记录以及 Organize 记录绝不会通过 Gist 同步。
- Cubby 通常会把每个对话中有效且已结束的尝试裁剪到最新 128 条。当前尝试和损坏的恢复证据可能在你明确删除对话前继续保留。
- 对话、恢复和产物账本在 256 MiB 时发出警告，在 512 MiB 的逻辑上限处停止新写入；可重新获取的缓存会在这个上限下方预留 2 MiB 空间。
- Cubby 会独立于来源对话，在本地 IndexedDB 中最多保留一条最近完成或取消的 Organize 工作流。开始新的 Organize 工作流会移除上一条终态工作流记录。

如果某个 profile 以前使用过其他未打包构建，浏览器本地设置或记录可能一直保留到你清除数据或卸载扩展。旧设置不会授予超出产品正常行为的能力。

## 直接连接的服务

打包后的 Edge manifest 只允许：

- `https://github.com/*`；
- `https://api.github.com/*`；
- 选择 OpenAI 时的 `https://api.openai.com/*`；
- 选择 OpenRouter 时的 `https://openrouter.ai/*`；
- 选择 Anthropic 时的 `https://api.anthropic.com/*`；
- 你输入并明确允许的自定义 OpenAI 兼容 HTTPS 地址，或 HTTP loopback 地址。

GitHub 和 Provider 请求从 Microsoft Edge 直接发送到这些服务，不经过开发者代理。分析 SDK、广告网络、跟踪服务、开发者代理和开发者服务器都不会收到扩展数据。

## Cubby 数据共享与同意

Options 会显示一个折叠的信息摘要，其中写明选定的 Provider 和精确的规范化服务地址。Cubby 只在你完成记录选定 Provider 和精确服务地址的版本化接受的明确披露操作后才会运行。manifest 不包含远程可执行代码；GitHub 响应和 Provider 响应都是数据，不是扩展代码。

需要时，Cubby 可能把以下任务数据发送给你选择的 AI 服务：

- 你的提示词或有界任务指令；
- 所选或冻结范围内的公开仓库 metadata；
- Cubby 使用索引代码搜索时得到的有界公开代码片段和文件路径；
- Cubby 通过范围受限的笔记工具读取的私有笔记；可信指令要求它只在请求需要笔记内容时使用该工具；
- 当前可见且有界的标签分类；
- 协议观察结果，包括工具定义、有界工具结果、交互选择和应用生成的摘要。

Cubby 不会把凭据、你的 GitHub Token 或当前范围之外的无关 Star 作为模型可见的任务数据发送。选定的 AI 服务 Key 只会作为认证 Header 发送到绑定的服务地址（OpenAI、OpenRouter 和自定义 OpenAI 兼容服务使用 `Authorization: Bearer`；Anthropic 使用 `x-api-key`）。Key 不会放入提示词、工具载荷或日志，GitHub Token 永远不会发送给 AI 服务。

GitHub 只会收到请求功能所需的数据：GitHub REST API 会收到账号查询、Star 获取、启用 Watch Inbox 后的已 Watch 仓库范围和 Notifications、可选的公开代码索引搜索，以及 Gist 同步请求；GitHub Gists API 只有在你使用可选的 **Push** 或 **Pull** 同步时才会收到批注数据。Provider 端的数据保留和删除由你选择的账号和服务条款决定。

## 权限

Edge 安装包使用：

- `storage`：保存轻量配置和加密后的 GitHub 与 AI 服务凭据；
- `alarms`：让持久化的全库 Organize 分析和已批准的 Apply 操作跨越 MV3 service worker 挂起继续调度恢复工作；
- `https://github.com/*`：在 GitHub 页面挂载产品界面；
- `https://api.github.com/*`：提供需要认证的 GitHub 功能；
- `https://api.openai.com/*`、`https://openrouter.ai/*`、`https://api.anthropic.com/*`：用于用户配置的内建 Provider；
- `https://*/*`、`http://localhost/*`、`http://127.0.0.1/*`：作为可选主机权限，用于用户配置的自定义兼容地址；Options 只有在用户明确点击 **Allow access** 后才会请求访问，凭据和请求都绑定到精确的规范化服务地址（包括端口）。

拒绝可选访问后，扩展不会发起 Provider 请求。

## 诊断和发布证据

运行和发布证据经过有界处理和脱敏。它可能包含脱敏的浏览器身份、可执行二进制摘要、扩展 ID、已验证场景标识、诊断计数、安装包指纹、manifest 权限事实和安装包能力声明。

证据不包含可执行文件路径、PAT、API Key、认证 Header、请求 body、笔记、提示词、个人账号数据、私有仓库内容或原始 GitHub/Provider 响应。扩展不会把发布证据发送到开发者服务器。

## 你的控制和删除方式

你可以：

- 在 Options 中清除已保存的 GitHub Classic PAT；
- 删除已保存的 AI 服务 Key，或更换 Provider 或服务地址，这会使原来的凭据绑定失效；
- 关闭 Watch Inbox，并清除其本地缓存记录；
- 通过产品控件编辑或删除本地标签和笔记；
- 在取消或完成关联的 Organize 工作流后删除 Cubby 对话；
- 在 workbench 中关闭保留的已完成或已取消 Organize 结果；
- 在 Options 中清除可重新获取的 Cubby 工具缓存，不删除最终答案或对话数据；
- 从你的 GitHub 账号删除 Secret 同步 Gist；
- 通过 Microsoft Edge 清除浏览器本地扩展数据；
- 卸载扩展，删除 Microsoft Edge 扩展存储和 IndexedDB 数据；
- 在 GitHub 撤销 PAT，停止后续需要认证的 GitHub 访问。

删除对话会移除其 transcript、尝试和恢复行，以及由对话拥有的产物。删除来源对话不会删除最近的终态 Organize 结果；该记录会一直保留到你关闭它、开始替代的 Organize 工作流或卸载扩展。已经发送到 AI 服务的请求仍受该服务的保留和删除设置约束。

## 安全说明

扩展通过 HTTPS 向 GitHub 和内建 Provider 发送请求。自定义 localhost 服务只有在你配置并允许精确的本地地址后才能使用 HTTP。扩展将全部可执行代码打包在安装包内，不会获取或执行远程脚本。GitHub 和 Provider 响应数据会被当作数据，而不是可执行的扩展代码。

请妥善保管 PAT 和 AI 服务 Key，只授予需要的 scopes；如果怀疑它们已经泄露，请立即撤销或轮换。

## 联系方式

- [项目概览](../../README.md)
- [安全与支持](../../SECURITY.md)
