# 隐私政策

[English](../en/privacy-policy.md)

生效日期：2026-08-16

Better GitHub Stars Manager 是一个用于整理 GitHub Star 仓库的浏览器扩展。它通过基于 Chromium 的浏览器商店分发；Firefox 版本正在准备提交至 Firefox Add-ons（AMO）。本政策说明扩展处理哪些数据、数据会发送到哪里、本地记录保留多久，以及你可以怎样删除这些数据。

## Limited Use 说明

Better GitHub Stars Manager 只会为了你请求的功能访问 GitHub 数据。启用可选的 Cubby AI 助手后，扩展还会直接连接到你选择的 AI 服务。

扩展从 Google API 获得的信息遵守 [Chrome Web Store 用户数据政策](https://developer.chrome.com/docs/webstore/program-policies/limited-use)，包括其中的 Limited Use 要求。

扩展不会：

- 出售你的数据；
- 将数据用于广告、信用评估或借贷决策；
- 将数据传给 GitHub 或 Gist 请求所需之外的服务，也不会把 Cubby 请求发送给你未选择的 AI 服务；
- 运营由开发者控制的 GitHub 或 AI 服务代理、后端或中转服务器。

扩展只会为了以下目的处理数据：

- 验证你提供的 GitHub **Classic PAT**；
- 获取并显示你的 Star 仓库；
- 将你创建的标签和笔记保存在你自己的 Secret Gist 中，并在你选择时同步；
- 通过你选择的 AI 服务和精确的服务地址测试或运行 Cubby；
- 在你主动请求后，检查同一个 GitHub 凭据的 Notifications 能力并显示可选的 Watch Inbox。

## Firefox 数据收集声明

Firefox 构建会在打包后的 manifest 中声明 AMO 数据收集类别，以便 Firefox 在安装扩展时向用户展示。这些类别描述的产品行为与本文其余部分一致：

必需：

- `authenticationInfo`（认证信息）——GitHub 账号信息，以及你提供并用于 GitHub API 认证的加密 Classic PAT；
- `websiteActivity`（网站活动）——扩展所管理的 GitHub 页面上的活动，包括 Star 仓库元数据、已 Watch 仓库成员关系，以及启用 Watch Inbox 后的通知元数据；
- `websiteContent`（网站内容）——扩展读取和更新的页面内容，包括仓库页面、Stars 表格、标签和笔记。

可选：

- `personalCommunications`（个人通信）——发送给你选择的 AI 服务的 Cubby 对话消息和任务数据。

扩展只会在你启用或调用 Cubby 的明确用户操作中请求可选的 `personalCommunications` 权限，并且只在浏览器授予后才记录接受。每次 Cubby Provider 请求前，Firefox 都会检查该权限是否仍然授予。拒绝或撤销该权限只会禁用依赖它的 Cubby AI 请求；Stars、同步、Watch、Radar、本地整理和 GitHub API 功能仍然可用。

数据收集权限与下面列出的主机权限相互独立；授予或拒绝其中一项不会授予或拒绝另一项。

## 扩展处理的数据

扩展处理的数据类别包括：

- 你在 Options 中粘贴的单一 GitHub **Classic PAT**；其可选的 `notifications` 和 `read:user` 能力分别控制 Watch Inbox 和 Following Radar；
- 来自 `GET /user` 的 GitHub 账号信息，例如用户名、显示名称和头像地址；
- 来自 `GET /user/starred` 的 Star 元数据，例如仓库名、URL、描述、语言、topics、Star 数量和日期；
- 来自 `GET /user/subscriptions` 的已 Watch 仓库成员关系；
- 可选 Watch Inbox 的 GitHub 通知元数据，包括仓库、原因、主题标题和类型、安全的 GitHub 链接、未读状态以及更新时间和已读时间；
- 你在扩展中创建的标签和笔记；
- 可选同步所用专用 Secret Gist 的元数据；
- Cubby 服务配置，包括 Provider、模型、规范化服务地址、加密后的 API Key 材料和连接状态；
- 已提交的 Cubby 对话历史和不可变的已接纳尝试记录，其中包括每次已接纳的提示词；
- 用于在中断后继续已接纳尝试的有界恢复投影；
- 当工具结果无法装入扩展消息或模型结果时使用的分页工具产物和可重新获取的工具缓存；
- 独立的 Organize 数据，包括指令、冻结的范围、提案、Review 和 Apply 状态，以及最近一次完成或取消的结果。

## 数据用途

扩展使用这些数据来提供以下功能：

- 获取、搜索、筛选、打标签和批注 Star 仓库；
- 通过你账号下的 Secret GitHub Gist 同步批注层；
- 可选显示你已经 Star 且在 GitHub 上 Watch 的仓库通知；
- 让 Cubby 分析你明确选择或冻结的仓库范围；
- 让 Cubby 根据当前提示词和本轮本地证据执行普通的有界标签修改；
- 运行独立的全库 Organize 工作流，冻结范围，提出添加型标签建议，并要求你在 Review 中选择后才能 Apply；
- 在你请求代码搜索时，在最多五个已 Star、公开且未归档仓库的冻结范围内搜索 GitHub 的公开代码索引。

扩展不投放广告、不出售数据，也不把数据发送到开发者运营的服务器。

## 本地存储与可选 Gist 存储

扩展把数据存放在以下位置：

- 单一 GitHub Classic PAT 使用 AES-GCM 加密后保存到宿主浏览器的扩展存储区域（`chrome.storage.local`），Stars、Gist、Watch 和 Following 在各自能力检查后复用该凭据；
- AI 服务 API Key 使用 AES-GCM 加密后保存到 `chrome.storage.local`，并绑定到选定的 Provider 和规范化服务地址；
- 轻量配置，包括绑定的 Gist ID，保存到 `chrome.storage.local`；
- Star 元数据、标签和笔记保存到 IndexedDB，以便快速查询；
- Watch 仓库范围、通知 thread 快照和刷新状态以未加密形式保存到本地 IndexedDB；
- 已提交的对话历史、尝试记录、恢复记录和分页产物以未加密形式保存到扩展本地 IndexedDB；
- 只有在你使用 **Push** 或 **Pull** 时，标签、笔记和标签元数据才会写入 Secret GitHub Gist。

Watch 范围和通知记录、Cubby 对话和恢复产物、Organize 记录都不会通过 Gist 同步。

每次已接纳的 Cubby turn 都会在 attempt 行中保存一个不可变的启动记录，其中包括提示词。待继续的消息使用单独的有界恢复行。继续权限结束后，Cubby 会删除恢复行。

Cubby 通常会把每个对话中有效且已结束的尝试裁剪到最新 128 条。当前尝试和损坏的恢复证据可能在你明确删除对话前继续保留。

较大的工具结果可能被拆成有界的本地分页。Cubby 可以按对话绑定的不透明游标分页读取，按有界的 UTF-8 字节偏移读取，或定位精确的有界字面量后读取对应区域。每次读取都限定在所属对话内。

规范产物会随对话保留。可重新获取的产物缓存可以过期或被清除，但不会因此删除最终答案。对话、恢复和产物账本在 256 MiB 时发出警告，在 512 MiB 的逻辑上限处停止新写入。可重新获取的缓存会在这个上限下方预留 2 MiB 空间。

账本包括对话头、尝试、恢复行、消息、规范产物和可重新获取的缓存。它不包括单独设置上限的 Organize 表，也不等同于宿主浏览器对整个扩展存储的估算。

Cubby 在本地 IndexedDB 中最多保留一条最近完成或取消的 Organize 工作流记录。该记录可以包含指令、冻结的范围、提案、Review 和 Apply 状态、回执以及来源溯源。开始新的 Organize 工作流会移除上一条终态工作流记录。

流式文本、进度指示器、Provider 授权 Header、API Key、原始 Provider 请求和响应，以及超出有界恢复记录的 worker 本地投影，都不会作为已提交的对话历史、恢复状态或工具产物保存。

## 直接连接的服务

根据你选择的功能，扩展会直接连接到：

- `https://github.com/*`；
- `https://api.github.com/*`；
- 你选择并明确允许的 AI 服务地址，可以是 OpenAI、OpenRouter、Anthropic、自定义 OpenAI 兼容 HTTPS 地址或 HTTP loopback 地址。

只有上述两个 GitHub 地址是必需主机权限。所有 AI 服务地址（含内建服务）都在你配置该服务时按需请求，在你授权之前扩展没有任何 AI 服务访问权限。

Provider 请求和 GitHub 请求不会经过开发者运营的代理。

## Cubby 数据共享

Options 会显示一个折叠的信息摘要，其中写明选定的 Provider 和精确的规范化服务地址。这个提示不会自动授予主机权限，也不会阻止内置 Provider。

Cubby 只在你完成记录选定 Provider 和精确服务地址的版本化接受的明确披露操作后才会运行。在 Firefox 上，同一个操作会先请求可选的 `personalCommunications` 数据权限，并且只在浏览器授予后才记录接受。拒绝或撤销该权限只会禁用依赖它的 Cubby AI 请求；Stars、同步、Watch、Radar、本地整理和 GitHub API 功能仍然可用。

需要时，Cubby 可能把以下任务数据发送给你选择的 AI 服务：

- 你的提示词或有界任务指令；
- 所选或冻结范围内的公开仓库元数据；
- Cubby 为当前请求使用索引代码搜索时得到的有界公开代码片段和文件路径；
- Cubby 通过范围受限的笔记工具读取的私有笔记；可信指令要求它只在请求需要笔记内容时使用该工具；
- 当前可见且有界的标签分类；
- 协议观察结果，包括工具定义、有界工具结果、交互选择和应用生成的摘要。

索引代码搜索不是完整搜索。GitHub 搜索默认分支的索引，可能遗漏文件或只返回部分结果。扩展会重新确认仓库仍然公开且未归档，读取有界的匹配 Git blob，并把每个代码片段视为不可信数据。

普通对话会注册私有笔记和仓库代码工具。运行时会限制仓库范围、工具授权和结果大小，但不会判断提示词是否在语义上要求这些数据。Cubby 的可信指令要求它只在请求需要相应数据时调用工具。笔记和代码片段都被视为不可信数据。已提交的工具结果可能在后续对话中再次发送，或只发送给同一个绑定的 AI Provider 进行摘要。

默认情况下，Cubby 不会把以下数据作为模型可见的任务输入发送：

- 请求不需要笔记内容时的私有笔记；这是指令层限制，不是独立的运行时意图分类器；
- 凭据或 Secret；
- GitHub Token；
- 当前范围之外或未相关的 Star 仓库。

选定的 AI 服务 Key 必须发送到绑定的服务地址，用作认证。OpenAI、OpenRouter 和自定义 OpenAI 兼容服务使用 `Authorization: Bearer` Header。Anthropic 使用 `x-api-key` Header。Key 不会放入提示词、工具载荷或日志。GitHub Token 永远不会发送给 AI 服务。

GitHub 只会收到请求功能所需的数据：

- GitHub REST API 会收到账号查询、Star 获取、启用 Watch Inbox 后的已 Watch 仓库范围和 Notifications、可选的公开代码索引搜索，以及 Gist 同步请求；
- GitHub Gists API 只有在你使用可选的 Push 或 Pull 同步时才会收到批注数据。

扩展数据不会发送给分析 SDK、广告网络、跟踪服务、开发者代理或开发者服务器。Provider 端的数据保留和删除由你选择的账号和服务条款决定。

## 主机权限

manifest 需要 GitHub 页面和 API 主机，以及 OpenAI、OpenRouter 和 Anthropic 主机。自定义兼容服务使用可选主机权限。

主机匹配模式可能覆盖某个协议和主机名下的所有端口。扩展会另外把凭据和请求绑定到精确的规范化服务地址，包括端口。基于 Chromium 的浏览器对必需和可选访问权限的区分见 [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)；Firefox 通过其可选权限 API 提供同样的区分。

## 诊断边界

发布诊断不包含已提交的历史、尝试和恢复记录、原始 Provider 请求和响应、凭据或认证 Header。发布证据只保存有界的语义事实、计数、相对路径和摘要，不保存私有任务内容。

解压的开发版本可以在页面内存中暴露一个明确启用的一次性原始捕获功能。捕获的提示词可能包含已提交的对话历史。开发版本在启用前会发出警告；发布版本和发布证据不包含原始捕获。

## 保留与删除

你可以通过以下方式删除数据：

- 在 Options 中清除已保存的 GitHub Classic PAT；
- 关闭 Watch Inbox，删除其能力绑定和缓存的通知 thread；Stars 仍可用；
- 删除已保存的 AI 服务 Key，或更换 Provider 或服务地址，这会使原来的凭据绑定失效；
- 在取消或完成关联的 Organize 工作流后删除 Cubby 对话；
- 在 workbench 中关闭保留的已完成或已取消 Organize 结果；
- 在 Options 中清除可重新获取的 Cubby 工具缓存，不删除最终答案或对话数据；
- 卸载扩展，删除浏览器本地扩展存储；
- 从你的 GitHub 账号删除 Secret 同步 Gist。

删除对话会移除其 transcript、尝试和恢复行，以及由对话拥有的产物，包括损坏的尝试证据。如果 worker 仍持有活动尝试，或关联的 Organize 工作流尚未进入终态，删除会被阻止。

删除来源对话不会删除最近的终态 Organize 结果。该记录保留不可变的来源溯源，但来源溯源不等于授权。结果会一直保留到你关闭它、开始替代的 Organize 工作流或卸载扩展。

卸载扩展会删除浏览器本地存储。你账号下创建的 Gist 会继续存在，直到你手动删除。已经发送到 AI 服务的请求仍受该服务的保留和删除设置约束。

## 安全说明

扩展在把 GitHub 和 AI 服务凭据写入 `chrome.storage.local` 前会先加密。这可以降低明文存储暴露的风险，但不等同于操作系统 Keychain 保护。

扩展通过 HTTPS 向 GitHub 和内置 AI 服务发送数据。自定义 localhost 服务只有在你配置并允许精确的本地地址后才能使用 HTTP。

## 联系方式

- [项目主页](https://github.com/izumi0uu/better-github-stars-manager)
- [支持与隐私问题追踪](https://github.com/izumi0uu/better-github-stars-manager/issues)
