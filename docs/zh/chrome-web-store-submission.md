# Chrome Web Store 提交参考

[English](../en/chrome-web-store-submission.md)

这份文档记录商店文案、根据 manifest 整理的权限说明、审核员测试步骤以及 Chrome Web Store 的外部工作。它不表示某个安装包已经可以发布、已经上传、正在审核或已经上线。

## 证据边界

以下证据状态必须分开看：

1. **受控源码**：源码审查和受控 Provider fixture 可以证明本地契约；
2. **严格适配器**：聚焦测试可以证明 OpenAI Responses、OpenAI 兼容服务、OpenRouter streaming、Anthropic Messages、registry 和错误契约；
3. **真实凭据**：专用 GitHub 和 AI 服务凭据需要单独手动检查；
4. **干净本地安装包**：干净 ZIP 和发布证据可以证明本地包结构与校验和；
5. **Dashboard 和发布**：上传、Dashboard 字段、审核、批准、发布以及商店安装行为都需要直接的外部证据。

这些状态不会自动证明后面的状态。本地证据必须保持 `dashboardSubmissionClaimed: false`。

对于更新，Google 要求安装包内容完整，且版本号高于已发布版本。Google 在 [Update your Chrome Web Store item](https://developer.chrome.com/docs/webstore/update) 中说明了这一流程。无论通过 Dashboard 还是已经启用的 API 工作流完成，上传、审核和发布仍然是三个独立的外部状态。

## 公开 URL

- [项目主页](https://github.com/izumi0uu/better-github-stars-manager)
- [隐私政策](https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/zh/privacy-policy.md)
- [支持与 issue 追踪](https://github.com/izumi0uu/better-github-stars-manager/issues)

只有在审核后的政策已经公开，并且无需认证就能访问时，隐私 URL 才可使用。Dashboard 字段、公开商店文案、隐私展示、宣传素材和已安装版本都必须手动检查。

## 商店文案

这些文案描述当前实现，但不代表 Dashboard 中已经填写了这些文字。

### 商店名称

Better GitHub Stars Manager

### 简短描述

用搜索、标签、笔记、筛选、Watch Inbox、可选的 Gist 同步和本地优先 AI 助手管理 GitHub Stars。

### 详细描述

Better GitHub Stars Manager 把 GitHub Stars 页面变成本地优先的仓库浏览和整理工作区。

你可以用它：

- 在虚拟化表格中浏览大量 Star 仓库；
- 搜索仓库名称、描述、topics 和你的笔记；
- 用自定义标签和笔记整理仓库；
- 按语言、标签和未打标签状态筛选；
- 通过自己的 Secret GitHub Gist 只同步批注层；
- 通过可选的 Watch Inbox 查看当前已 Star 仓库的 GitHub 通知，并单独查看已 Watch 仓库的参考计数；
- 使用自己的 OpenAI、OpenRouter、Anthropic 或兼容 AI 服务运行 Cubby。

普通 Cubby 提示词可以授权有界的标签修改。每次写入仍受本轮本地证据、操作限制和当前写策略约束。

全库 Organize 是独立的工作流。它会冻结库范围，准备添加型标签建议，让你在 Review 中选择建议，只有你点击 **Apply** 后才会修改标签。

GitHub、Watch Inbox 和 Gist 请求直接发送到 GitHub。可选的 Cubby 请求直接发送到你选择的 AI 服务和精确配置的地址。开发者不运营代理或自定义后端。

### 建议分类

Developer Tools

## 本地素材清单

仓库中包含以下本地文件和尺寸。这不能证明素材已经上传到 Dashboard、顺序正确、审核通过或公开展示。

准备好的截图：

- `public/store/screenshots/screenshot-main-stars.png`
- `public/store/screenshots/screenshot-detail-panel.png`
- `public/store/screenshots/screenshot-agent-disclosure-light-1280x800.png`
- `public/store/screenshots/screenshot-agent-disclosure-dark-640x400.png`

准备好的宣传素材源文件和输出：

- `store-assets/promo/promo-tiles.html` 是矢量和字体的事实来源；
- `scripts/generate-store-promo.mjs` 通过 `node scripts/generate-store-promo.mjs` 重新生成两个 tile；
- `store-assets/promo/small-tile.png` 是 440x280、无 alpha 通道的 RGB PNG；
- `store-assets/promo/marquee.png` 是 1400x560、无 alpha 通道的 RGB PNG。

准备好的商店图标：

- `public/icons/icon-128.png`，尺寸为 128x128。

Google 的[图片要求](https://developer.chrome.com/docs/webstore/images)要求 128x128 图标、至少一张截图和 440x280 的小型宣传图。1400x560 的 marquee 图是可选项。截图必须展示当前产品体验。

Tile 文案是“Local-first star organization.”和“Direct to GitHub and your selected AI provider. No developer-operated proxy.”。Marquee 还说明 Stars、标签和笔记留在浏览器中，而同步和 AI 请求直接发送到选定服务。它的“Yours to keep”卡片说明可通过用户自己的 Secret Gist 和 **Push**、**Pull** 进行可选同步。文案没有 JSON、CSV、Markdown、导出、备份或绝对隐私承诺。

这些 tile 只包含字体和品牌图标，不包含截图。它们不包含凭据、Token、账号数据、私有笔记、提示词、Provider 载荷或无依据的导出承诺。

不同 Chrome 构建可能以不同方式栅格化相同源文件。每次上传前都应重新生成并检查输出；Dashboard 上传和公开渲染仍需单独检查。

Dashboard 中的素材是否存在、顺序、locale 分配、审核状态和公开渲染都需要手动确认，目前没有验证。在应用内切换 English 和简体中文，也不能证明 Web Store listing 已经本地化。

## Manifest 权限说明

以下说明来自当前 Manifest V3 源码。最终干净 ZIP 仍需重新检查，因为审查源码不能证明打包后的权限。

### `storage`

为轻量配置、加密的单一 GitHub Classic PAT 和 AI 服务凭据，以及查询或界面状态提供 `chrome.storage.local`。Star 和批注数据、Watch 快照、Cubby 有界的对话、恢复和产物账本，以及单独设置上限的 Organize 记录，使用扩展本地 IndexedDB。一次性的 `chrome.storage.session` 值把 Watch 恢复流程路由到对应的 Options 区域，使用后立即消费。

### `alarms`

在 Manifest V3 service worker 挂起后，为持久化的全库 Organize 分析和已批准的 Apply 操作安排恢复工作。扩展在工作可以恢复或结束时创建并清除命名 alarm。见官方 [`chrome.alarms` 参考](https://developer.chrome.com/docs/extensions/reference/api/alarms)。

### `https://github.com/*`

把管理面板挂载到 GitHub Stars 和仓库页面。Manifest 匹配模式不能匹配 `?tab=stars` 这样的 query string，因此 content script 匹配 GitHub 页面后，再在运行时判断是否启用行为。

### `https://api.github.com/*`

验证用户提供的 Token，获取 Star 和 Watch 仓库；只有启用 Watch Inbox 后才获取 Notifications；按请求执行有界的公开代码搜索；通过用户自己的 Secret Gist 同步批注。

### `https://api.openai.com/*`

当用户配置 OpenAI 后，用于测试连接，并让 Cubby 直接连接 OpenAI 运行。

### `https://openrouter.ai/*`

当用户配置 OpenRouter 后，用于测试连接，并让 Cubby 直接连接 OpenRouter 运行。

### `https://api.anthropic.com/*`

当用户配置 Anthropic 后，用于测试连接，并让 Cubby 直接连接 Anthropic 运行。

### 可选的自定义 AI 服务主机

由于安装时不知道自定义兼容服务的地址，manifest 将 `https://*/*`、`http://localhost/*` 和 `http://127.0.0.1/*` 声明为可选主机权限。其中 `https://*/*` 用于连接用户配置的任意 HTTPS 兼容服务。Options 只有在用户明确点击 **Allow access** 后才会请求访问。

Chrome 的权限匹配模式可能覆盖某个协议和主机名下的所有端口。扩展会另外把凭据和请求绑定到精确的规范化地址，包括端口。拒绝可选访问后，扩展不会发起 Provider 请求。

Google 在 [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) 中解释了必需和可选的主机访问权限。Dashboard 权限说明必须明确解释 `https://*/*` 的用途，最终 ZIP 的 manifest 也必须与这些文档化的模式一致。

## 隐私实践对应关系

完成 Dashboard 时使用以下有来源支持的对应关系。有人检查并保存之前，Dashboard 的答案都应视为未验证：

- 用户数据支持扩展已披露的用途和用户请求的功能；
- 数据不会出售，也不会用于个性化广告、信用或借贷决策；
- 没有分析或广告 SDK 接收扩展数据；
- GitHub 和 Gist 只接收用户请求的 GitHub、搜索和同步功能所需的数据；
- Watch Inbox 只有在用户明确设置后才处理已 Watch 仓库成员关系和有界的 GitHub 通知元数据；它会先检查单一 Classic PAT 的 `notifications` 能力；
- Following Radar 使用同一个 Classic PAT，并单独检查 `read:user` 能力；缺少任一可选能力都只会禁用依赖它的功能；
- Watch 范围、通知 thread 和刷新状态保存在本地 IndexedDB，默认不会通过 Gist 同步，也不会发送给 AI 服务；
- 只有使用 Cubby 时，选定的 AI 服务才会接收任务数据；
- GitHub、Gist 或 Provider 流量不会经过开发者运营的代理或后端；
- Star 元数据保存在本地 IndexedDB，除非你批准 Cubby 在有范围限制的任务中使用它。选定或冻结范围中的公开仓库元数据可以发送给你选择的精确 AI 服务。批注数据只有在使用可选的 **Push** 或 **Pull** 同步时才会发送到你的 Secret Gist；
- 已提交的对话历史、尝试、恢复投影和产物保存在本地 IndexedDB，不加密；
- 每个对话通常只保留最新 128 条有效且已结束的尝试；当前尝试和损坏的恢复证据可能保留到明确删除对话；
- 对话、恢复和产物记录不会同步到 Gist，不会发送到开发者服务器，也不会包含在发布诊断中；
- 清除可重新获取的工具缓存不会删除最终答案、transcript、尝试或恢复行，也不会删除规范产物；
- 逻辑账本在 256 MiB 时警告，在 512 MiB 时停止新写入。它不包括单独设置上限的 Organize 表，也不同于 Chrome 对整个扩展的浏览器级存储估算；
- Cubby 会独立于来源对话保留最近一条已完成或取消的 Organize 工作流；
- 删除来源对话会移除 transcript、尝试、恢复和对话产物行，但最近的终态 Organize 结果会一直保留到 Dismiss、替换或卸载；
- 任务数据可能包含提示词、有范围限制的公开元数据、有界公开代码片段和路径、范围内私有笔记、可见且有界的标签以及协议观察结果；可信指令要求代码和笔记工具只在请求需要相应数据时使用；
- 运行时会限制范围、工具授权和结果大小，但不会对提示词做语义分类；凭据、GitHub Token 和无关 Star 始终不进入模型可见的任务数据；
- OpenAI、OpenRouter 和自定义 OpenAI 兼容服务的 Key 使用 `Authorization: Bearer`；Anthropic 使用 `x-api-key`；
- Provider Key 只作为认证 Header 发送到精确绑定的地址，不会作为提示词、工具、产物或日志内容发送；
- 发布诊断不包含已提交历史、尝试、恢复记录、原始 Provider 请求和响应、Key 或认证 Header；
- 解压开发版本的原始捕获功能会单独发出页面内存警告，并且不包含在发布版本和发布证据中；
- 索引公开代码搜索可能只返回部分结果，因为 GitHub 搜索默认分支索引。扩展会重新验证冻结仓库公开且未归档，限制 Git blob 读取，并把返回片段当作不可信数据。

Dashboard 必须包含准确的单一用途说明、权限理由、远程代码回答、数据使用复选框、Limited Use 认证和隐私 URL。请查看官方的 [Privacy practices fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)、[Privacy Policy rules](https://developer.chrome.com/docs/webstore/program-policies/privacy) 和 [Limited Use policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use)。

## 审核员测试说明

只在 Chrome Web Store Dashboard 的 **Test instructions** 标签页中保存凭据。不要把审核凭据提交到源码、Markdown、截图、日志、ZIP 或发布证据中。Google 在 [Provide test instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions) 中说明了这个私有审核渠道。

Dashboard 应区分两条路径：

- **无需凭据的路径**：安装扩展，打开 Options，查看隐私披露、主题和语言控制，并确认安装包没有包含私有凭据；
- **需要凭据的路径**：只使用放在 Test instructions 中的专用、最小权限、可撤销 GitHub **Classic PAT** 和 AI 服务凭据。

GitHub 审核 PAT 应使用当前产品的 scope 集合：

```text
repo,gist,notifications,read:user
```

`repo` 和 `gist` 是完整核心体验的必需权限。`notifications` 启用 Watch Inbox，`read:user` 启用 Following Radar；缺少任一可选能力都必须让无关功能继续可用。当前产品只使用一个 Classic PAT，因此审核时不要使用 Fine-grained PAT。

凭据准备好后，按以下步骤审核：

1. 打开 Options，输入 Test instructions 中的专用 GitHub Classic PAT；
2. 确认 Token 使用 `repo`、`gist`、`notifications` 和 `read:user`，不要授予组织管理、workflow、删除仓库、密钥、审计日志、enterprise、package 或 Webhook 管理权限；
3. 点击 **Save & verify**，确认显示正确的已认证账号；
4. 打开 `https://github.com/your_username_here?tab=stars`，运行 **Full Sync**；
5. 确认 Star 已显示，并确认搜索、筛选、笔记和手动标签在本地可用；
6. 打开 **Watch**，确认扩展检查现有 Classic PAT，且不会要求第二份凭据；
7. 刷新 Watch，确认只显示当前已 Star 仓库的通知，并单独展示已 Watch 仓库的参考计数。关闭 Watch，确认缓存 thread 被删除，而 Stars 仍可用；
8. 打开 **Following Radar**，确认存在 `read:user` 时可以加载；如需测试缺少该能力的行为，请单独执行负向测试；
9. 使用 **Push** 和 **Pull** 检查专用 Secret Gist 同步流程；
10. 在 Options 中选择 AI 服务，确认折叠提示显示选定服务和精确地址；
11. 输入 Test instructions 中的模型和专用 AI 服务 Key，运行 **Test connection**；
12. 对自定义兼容地址点击 **Allow access**，并确认拒绝访问后不会发起请求；
13. 让 Cubby 执行一次普通且有界的标签修改，确认只应用提示词授权且有本地证据支持的变化；
14. 在一次 turn 提交后重新加载页面，确认对话仍然可用。只有出现可见的可重试失败后才测试 **Retry**；
15. 在 Options 中清除可重新获取的工具缓存，确认最终答案和对话历史仍保留；
16. 在两个 GitHub 页面上打开 Cubby，在其中一个页面启动全库 Organize；
17. 确认第二个页面在所有者断开连接并明确选择 **Take control** 前保持只读；
18. 在 Review 中选择建议并点击 **Apply**，确认两个页面都收敛到终态回执；
19. 删除来源对话，确认终态 Organize 结果仍可查看，然后点击 **Dismiss**；
20. 确认请求发送到选定地址。检查发布诊断和证据中只有有界事实，不包含凭据、认证 Header 或原始 Provider 请求和响应正文；
21. 删除审核专用 Gist，并在审核结束后撤销或轮换所有审核凭据。

不要把凭据值或清理用 Secret 放进本文档。Dashboard 设置、凭据有效性、线上服务行为和清理状态，在被直接观察前都保持未验证。

## 版本批准前置条件

执行发布验证前，确认 package 和生成的 manifest 使用明确批准的版本，并且该版本高于直接观察到的当前公开版本和上一次上传版本。运行器要求 `GSM_VERSION_APPROVAL` 包含有效 JSON，且必须正好包含 `approvedCandidateVersion`、`observedCurrentPublicVersion` 和 `observedPriorUploadVersion` 三个字段。缺失、标量、额外字段或版本不匹配都会阻止运行。应根据本次发布填写这些字段，不要复制之前提交的值。

## 本地发布流程

下面的命令存在于当前源码中，但命令存在不代表当前发布包已经通过它们。

准确的目标源码干净提交后，把 `GSM_VERSION_APPROVAL` 设置为上面说明的本次发布专用 JSON，然后运行：

```sh
pnpm verify:agent-runtime
pnpm verify:agent-release-gates
```

第一个命令是干净运行验证器：它构建扩展，运行受控打包场景和严格适配器契约，打包未改变的构建，并写入有界运行证据。第二个命令不重新构建，只验证这些已有输入，并在门禁标记前写入最终证据。

最终链路必须证明 ZIP 根目录包含 `manifest.json`，manifest 引用的每个资源都存在，必需和可选权限与本文档一致，源码专用和诊断材料不在包内，并且不可变的临时证据仍然是 `releaseReady: false`。

上面两个验证命令不会上传安装包，也不能证明真实凭据、Dashboard 值、审核或发布状态。

发布工作流会在推送 Tag 时执行打包和 GitHub Release 流程，但 Chrome Web Store 发布步骤不会因 Tag 推送而自动运行。只有在某个 Tag 上手动触发 `workflow_dispatch`、将 `publish_to_chrome_web_store` 设为 `true`，并且 `CWS_DEPLOY_ENABLED` 为 `true` 时，该步骤才会运行。如果步骤已被选中但缺少必需的 Web Store 凭据或 item 标识符，它仍会启动，并由发布脚本失败关闭。源码无法证明这个门禁是否启用，也无法证明这一步曾经运行过。

## Dashboard 与发布清单

干净的本地验证通过后，完成或直接验证以下事项：

- 发布准确审核过的隐私政策，并确认无需认证即可获取；
- 核对商店文案、截图、宣传图片、分类、主页和支持字段；
- 核对单一用途、包括 `alarms` 在内的全部权限说明、远程代码回答、数据使用复选框和 Limited Use 认证；
- 只把审核说明和凭据放在 Test instructions 中；
- 核对分发、可见性、国家或地区、价格、分批发布和延迟发布选项；
- 手动上传准确的已验证安装包，或确认受门禁控制的 tag 工作流选择了该 ZIP；
- 确认 Dashboard 或 API 接受该包，并报告预期版本和权限；
- 只有所有 Dashboard 字段都正确后才提交更新，或确认配置的工作流在满足该条件后执行了发布；
- 把审核结果与上传结果分开记录；
- 把发布结果与审核批准分开记录；
- 发布后检查线上 listing、隐私链接、宣传素材、版本和商店安装行为；
- 撤销或轮换审核凭据，并删除测试 Gist 数据。

在有直接证据记录前，公开 listing、公开隐私展示、公开宣传素材、Dashboard 字段、审核凭据、上传、审核和发布状态都保持未验证。

## Chrome 官方参考

- [Update an existing item](https://developer.chrome.com/docs/webstore/update)
- [Publish and submit for review](https://developer.chrome.com/docs/webstore/publish)
- [Complete the Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Supply listing images](https://developer.chrome.com/docs/webstore/images)
- [Fill out privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Provide private reviewer test instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions)
- [Declare extension permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Use the alarms permission](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Chrome Web Store privacy policy requirements](https://developer.chrome.com/docs/webstore/program-policies/privacy)
- [Chrome Web Store Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Chrome Web Store user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
