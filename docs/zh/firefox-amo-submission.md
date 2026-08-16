# Firefox Add-ons（AMO）提交参考

[English](../en/firefox-amo-submission.md)

这份文档记录 Better GitHub Stars Manager 的 Firefox Add-ons（AMO）商店文案、打包后的 Firefox manifest 契约、数据收集申报、审核员构建说明和本地发布证据。它不表示某个安装包已经上传、已签名、正在审核、已经批准或已经发布。

## 证据边界

本地准备和本文档不会上传、签名、提交审核、获得批准或发布任何内容：

1. **本地安装包**：确定性的 Firefox ZIP、校验和、审核员源码包和证据只能证明本地包结构与可复现性；
2. **上传**：只有 AMO Developer Hub 能接受安装包并创建提交；
3. **签名**：分发用的安装包由 AMO 签名；没有任何本地步骤会签名；
4. **审核与批准**：只有 AMO 审核员决定可审核性和是否批准；
5. **发布**：只有 AMO 会改变 listing 状态；在直接观察到 AMO listing URL 之前，README 中 Firefox 条目保持“即将上架”。

这些状态不会自动证明后面的状态。

## 公开 URL

- [项目主页](https://github.com/izumi0uu/better-github-stars-manager)
- [隐私政策](https://github.com/izumi0uu/better-github-stars-manager/blob/master/docs/zh/privacy-policy.md)
- [支持与 issue 追踪](https://github.com/izumi0uu/better-github-stars-manager/issues)

只有在审核后的政策已经公开，并且无需认证就能访问时，隐私 URL 才可使用。

## 商店文案

这些文案描述当前实现，但不代表 AMO 中已经填写了这些文字。

### 名称

Better GitHub Stars Manager

### 摘要

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

## 打包后的 Firefox manifest 契约

Firefox 生产输出从当前 Chrome 生产清单精确推导而来，只修改浏览器相关的 manifest 字段。打包后的 manifest：

- `manifest_version`：3；
- background：模块化 `background.scripts` 入口，不包含 `background.service_worker`；
- `browser_specific_settings.gecko.id`：`{5aeb7340-40e6-428d-9566-f3cacbe06352}`——永久附加组件 ID；不要更改，也不要将其复用到其他附加组件；
- `browser_specific_settings.gecko.strict_min_version`：`140.0`；
- 必需权限：`storage`、`alarms`；
- 必需主机权限：`https://github.com/*`、`https://api.github.com/*`、`https://api.openai.com/*`、`https://openrouter.ai/*`、`https://api.anthropic.com/*`；
- 可选主机权限：`https://*/*`、`http://localhost/*`、`http://127.0.0.1/*`；
- 必需数据收集权限：`authenticationInfo`、`websiteActivity`、`websiteContent`；
- 可选数据收集权限：`personalCommunications`；
- content script 匹配 `https://github.com/*`（Stars 页面和仓库 chip）。

ZIP 根目录必须直接包含 `manifest.json`。仅适用于 Chrome 的键会从 Firefox 产物中剔除。

## 数据收集申报

必需类别：

| 类别 | 产品含义 |
| --- | --- |
| `authenticationInfo` | GitHub 账号信息，以及用于 GitHub API 认证的加密 Classic PAT |
| `websiteActivity` | 扩展所管理的 GitHub 页面上的活动：Star 仓库元数据、已 Watch 仓库成员关系，以及可选的通知元数据 |
| `websiteContent` | 扩展读取和更新的页面内容：仓库页面、Stars 表格、标签和笔记 |

可选类别：

| 类别 | 产品含义 |
| --- | --- |
| `personalCommunications` | 发送给你选择的 AI 服务的 Cubby 对话消息和任务数据 |

同意与控制：

- 在产生任何 Provider 流量前，一个明确的披露操作会记录选定 Provider 和精确服务地址的版本化接受；
- 在 Firefox 上，同一个用户操作会先请求 `chrome.permissions.request({ data_collection: ['personalCommunications'] })`，并且只在授予后才记录接受；
- Firefox 在 Provider 流量前检查 `chrome.permissions.contains({ data_collection: ['personalCommunications'] })`；Chrome 将这项仅限 Firefox 的权限视为不适用；
- 拒绝或撤销该权限只会禁用 Agent/Cubby Provider 流量；Stars、同步、Watch、Radar、本地整理和 GitHub API 使用仍然可用；
- 主机访问控制与数据收集权限相互独立；授予或拒绝其中一项不会授予或拒绝另一项。

## 远程代码政策

- 扩展不包含远程可执行代码：所有运行时代码都由本地构建打包进 ZIP，并固定版本；
- 扩展从不从远程 URL 加载或执行代码；
- 发布证据包含明确的远程可执行代码排除证明。

## 已审核的 `web-ext` 警告

`pnpm lint:firefox` 使用固定的 `web-ext@10.6.0`，只接受五条已审核警告。出现 error、notice、新警告、缺失警告、警告归属变化或警告文本变化时，命令都会失败。

- `manifest.json` 中一条 `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` 警告：本次版本未声明 `browser_specific_settings.gecko_android`，因此只发布桌面版。Firefox Desktop 140 支持当前数据收集权限；Firefox for Android 不在本次范围内。以后增加 Android 支持时，必须单独验证至少 142 的 Android 最低版本。
- `assets/recommendation-entry-*.js` 中两条 `UNSAFE_VAR_ASSIGNMENT` 警告来自固定的 React DOM 18.3.1 renderer。仓库自有的 `src/` 代码没有 `innerHTML` 赋值、`document.write` 或 `dangerouslySetInnerHTML` sink。
- `assets/mermaid-*.js` 中两条 `UNSAFE_VAR_ASSIGNMENT` 警告来自固定的 `streamdown@2.5.0` 及其 `mermaid@11.16.0` renderer。Mermaid 保留默认的 `securityLevel: 'strict'` 消毒策略和打包后的 DOMPurify；仓库自有代码不直接调用这些 sink。

这些警告不会豁免远程代码政策。发布打包器会另外拒绝远程可执行代码模式，lint 门禁也会拒绝不属于上述精确集合的任何警告。

## 产物清单

构建输出根目录：`dist-firefox/`。发布产物目录：`artifacts/firefox/`。将 `<version>` 替换为明确批准的发布版本。

| 产物 | 含义 |
| --- | --- |
| `better-github-stars-manager-firefox-<version>.zip` | 扩展安装包，`manifest.json` 位于 ZIP 根目录 |
| `better-github-stars-manager-firefox-<version>.zip.sha256` | 扩展安装包校验和 |
| `release-evidence-<version>.provisional.json` | 标记 `browserTarget: 'firefox'` 的不可变临时证据，仍为 `releaseReady: false` |
| `release-evidence-<version>.json` | 最终发布证据 |
| `agent-release-gate-evidence.json` | 发布门禁证据 |
| `better-github-stars-manager-firefox-<version>-source.zip` | 审核员源码包 |
| `better-github-stars-manager-firefox-<version>-source.zip.sha256` | 审核员源码包校验和 |

确定性的清单、ZIP 和校验和逻辑与 Chrome 目标共用同一实现。`web-ext build` 不是发布打包器；`web-ext lint` 只是额外的 Firefox 校验。

## 审核员构建说明

环境：

- 包管理器：pnpm 10.33.2（仓库的 `packageManager` 字段）；
- Node：可复现性验证使用 24.10.0；固定的 `web-ext` 工具要求 Node 20 或更高版本；
- `web-ext` 作为 devDependency 精确锁定为 `10.6.0`，只能通过 pnpm 调用（绝不使用 `pnpm dlx` 或 `npx`）。

命令：

```sh
pnpm install --frozen-lockfile
pnpm build:firefox
pnpm check:firefox-output
pnpm lint:firefox
GSM_APPROVED_RELEASE_VERSION=<version> pnpm package:firefox
FIREFOX_EXECUTABLE=/path/to/current/firefox pnpm test:smoke:firefox
FIREFOX_140_EXECUTABLE=/path/to/firefox-140 \
FIREFOX_STABLE_EXECUTABLE=/path/to/current/firefox \
pnpm test:verify-firefox
```

- `build:firefox` 生成带转换后 manifest 的 `dist-firefox/`；
- `check:firefox-output` 校验 Firefox manifest 字段和必需入口文件；`package:firefox` 负责完整的 manifest 资源闭包，并拒绝仅限 Chrome 或开发环境的残留；
- `lint:firefox` 运行固定版本 `web-ext@10.6.0` 的 lint；
- `package:firefox` 要求提供明确批准的安装包版本，然后在 `artifacts/firefox/` 中输出扩展 ZIP、校验和、临时证据和审核员源码包；
- `test:smoke:firefox` 使用当前固定的 Puppeteer 驱动，对 `FIREFOX_EXECUTABLE` 运行共享 runtime smoke；
- `test:verify-firefox` 要生成双版本证据，必须显式提供 `FIREFOX_140_EXECUTABLE` 和 `FIREFOX_STABLE_EXECUTABLE`。Firefox 140 角色使用仓库固定的 `puppeteer-firefox-140` 别名，因为当前 Puppeteer 已不再支持 Firefox 140。只有实际执行的二进制报告 140.x 时，才能声称 Firefox 140 已运行。

预期结果：`artifacts/firefox/better-github-stars-manager-firefox-<version>.zip`、其 `.zip.sha256`、审核员源码 ZIP 及其校验和。确认 ZIP 根目录包含 `manifest.json`，并且 `dist-firefox/manifest.json` 包含上面的 Gecko 块。

审核员源码 ZIP 包含干净的已跟踪构建输入、lockfile，以及带上述精确 Node/pnpm 命令的生成版审核员 README。它不包含 Token、账号数据、构建输出、个人路径、外部工作项文本或 VCS 元数据。已跟踪的 `scripts/deterministic-zip.mjs` 使用固定元数据生成两个 ZIP，Node.js `node:crypto` 负责创建并校验 SHA-256 sidecar；构建不依赖宿主机的 `zip`、`unzip` 或校验和工具。如果审核员构建输出与上传的 ZIP 不一致，在解释差异或让构建可复现之前不要提交。

## 版本批准前置条件

最终本地验证前，记录明确批准的安装包版本，以及本次发布决策直接观察到的当前公开版本和上次上传版本。`GSM_VERSION_APPROVAL` 必须是只包含 `approvedCandidateVersion`、`observedCurrentPublicVersion` 和 `observedPriorUploadVersion` 的 JSON。候选版本必须等于 `package.json` 中的 `version` 字段，并严格高于两个观察值。缺失、多余、过期或编造的值都会失败关闭。

## 本地发布门禁

只从已经干净提交的精确目标源码运行最终流水线，并从空的 `artifacts/firefox/` 目录开始。之前单独运行 `package:firefox` 得到的是安装包检查证据，不能作为可复用的最终门禁输入。

把所有尖括号占位符替换为本次发布直接观察到的值或可执行文件路径，然后运行：

```sh
export GSM_PACKAGE_TARGET=firefox
export GSM_BROWSER_TARGET=firefox
export GSM_VERSION_APPROVAL='{"approvedCandidateVersion":"<version>","observedCurrentPublicVersion":"<observed-version>","observedPriorUploadVersion":"<observed-version>"}'
export FIREFOX_140_EXECUTABLE=/path/to/firefox-140
export FIREFOX_STABLE_EXECUTABLE=/path/to/current/firefox
export PUPPETEER_HEADLESS=true
pnpm verify:agent-runtime
pnpm verify:agent-release-gates
```

runtime verifier 会运行完整 Vitest 与 regression、Firefox 生产构建、runtime/扩展场景、稳定版浏览器 smoke、互不替代的 Firefox 140 与稳定版矩阵、安装包输入稳定性检查和确定性 Firefox 打包。运行时证据只记录可执行文件身份的 SHA-256，不记录本地可执行文件路径。release-gate verifier 使用这些未改变的产物，先写最终证据，再写门禁标记；它不会重新构建或修改临时证据。

两个命令都不会上传、签名、提交、发布，也不能证明 AMO 审核状态。真实审核凭据、AMO 表单值、上传、签名、审核、listing 可见性和清理仍需人工观察。

## 权限说明

### `storage`

为轻量配置、加密的单一 GitHub Classic PAT 和 AI 服务凭据，以及查询或界面状态提供宿主浏览器的扩展存储区域（`chrome.storage.local`）。Star 和批注数据、Watch 快照、Cubby 有界的对话、恢复和产物账本，以及单独设置上限的 Organize 记录，使用扩展本地 IndexedDB。一次性的 `chrome.storage.session` 值把 Watch 恢复流程路由到对应的 Options 区域，使用后立即消费。

### `alarms`

在 Firefox 事件页后台脚本挂起后，为持久化的全库 Organize 分析和已批准的 Apply 操作安排恢复工作。扩展在工作可以恢复或结束时创建并清除命名 alarm。

### `https://github.com/*`

把管理面板挂载到 GitHub Stars 和仓库页面。Manifest 匹配模式不能匹配 `?tab=stars` 这样的 query string，因此 content script 匹配 GitHub 页面后，再在运行时判断是否启用行为。

### `https://api.github.com/*`

验证用户提供的 Token，获取 Star 和 Watch 仓库；只有启用 Watch Inbox 后才获取 Notifications；按请求执行有界的公开代码搜索；通过用户自己的 Secret Gist 同步批注。

### `https://api.openai.com/*`、`https://openrouter.ai/*`、`https://api.anthropic.com/*`

当用户配置 OpenAI、OpenRouter 或 Anthropic 后，用于测试连接，并让 Cubby 直接连接对应服务运行。

### 可选的自定义 AI 服务主机

由于安装时不知道自定义兼容服务的地址，manifest 将 `https://*/*`、`http://localhost/*` 和 `http://127.0.0.1/*` 声明为可选主机权限。Options 只有在用户明确点击 **Allow access** 后才会请求访问，并且凭据和请求仍绑定到精确的规范化服务地址，包括端口。拒绝可选访问后，扩展不会发起 Provider 请求。

### 数据收集权限

见[数据收集申报](#数据收集申报)。`authenticationInfo`、`websiteActivity` 和 `websiteContent` 为必需；`personalCommunications` 为可选，只在明确的 Cubby 同意操作中请求。

## 审核员证据清单

提交前收集并核对：

- 针对 Firefox 目标的 package-input 指纹清单；
- 针对模块化 `background.scripts` 入口的 manifest 闭包校验；
- ZIP 根目录 `manifest.json` 和资源闭包；
- 扩展包与源码包校验和（`.sha256`）；
- 标记 `browserTarget: 'firefox'` 并带有事件页后台身份的临时与最终证据；
- 远程可执行代码排除证明；
- 审核员源码产物证据；
- Firefox 运行时 smoke 和发布验证证据，只包含有界事实（不包含凭据、认证 Header 或原始 Provider 请求和响应正文）。

## 审核员测试步骤

使用专用、最小权限、可撤销的 GitHub **Classic PAT** 和 AI 服务凭据，并且只通过 AMO 私有审核备注渠道提供。不要把审核凭据提交到源码、Markdown、截图、日志、ZIP 或证据中。

GitHub 审核 PAT 应使用当前产品的 scope 集合：

```text
repo,gist,notifications,read:user
```

`repo` 和 `gist` 是完整核心体验的必需权限。`notifications` 启用 Watch Inbox，`read:user` 启用 Following Radar；缺少任一可选能力都必须让无关功能继续可用。不要授予组织管理、workflow、删除仓库、密钥、审计日志、enterprise、package 或 Webhook 管理权限。

1. 在新的 Firefox 配置文件中安装提交的 ZIP。确认 Firefox 使用永久 ID `{5aeb7340-40e6-428d-9566-f3cacbe06352}` 标识该扩展。扩展页面使用当前配置文件生成的 `moz-extension://<runtime-uuid>/...` 来源；运行时 UUID 不等于永久 Gecko ID。
2. 打开 Options，粘贴专用 Classic PAT，点击 **Save & verify**，确认显示正确的已认证账号。
3. 打开 `https://github.com/<你的用户名>?tab=stars`，运行 **Full Sync**，确认 Star、搜索、筛选、笔记和手动标签在本地可用。
4. 打开 **Watch**，确认扩展检查现有 Classic PAT 且不会要求第二份凭据；刷新并确认只显示当前已 Star 仓库的通知，并单独展示已 Watch 仓库的参考计数。关闭 Watch，确认缓存 thread 被删除，而 Stars 仍可用。
5. 打开 **Following Radar**，确认存在 `read:user` 时可以加载；如需测试缺少该能力的行为，请单独执行负向测试。
6. 使用 **Push** 和 **Pull** 检查专用 Secret Gist 同步流程。
7. 在 Options 中选择 AI 服务，确认披露文案写明选定服务和精确地址，然后点击明确的同意操作。在 Firefox 上这会先弹出可选的 `personalCommunications` 数据权限请求；确认提示只包含该类别。
8. 输入审核备注中的模型和专用 AI 服务 Key，运行 **Test connection**，并确认有界的 Cubby 任务只使用选定的 Provider。
9. 负向同意测试：在新的配置文件中拒绝 `personalCommunications` 提示。确认 Stars、同步、Watch、Radar 和本地整理仍然可用，不会发送任何 Provider 请求，也不会记录披露接受。
10. 对自定义兼容地址点击 **Allow access**（主机权限，与数据权限相互独立），并确认拒绝访问后不会发起请求。
11. 让 Cubby 执行一次普通且有界的标签修改，确认只应用提示词授权且有本地证据支持的变化。
12. 在一次 turn 提交后重新加载页面，确认对话仍然可用。只有出现可见的可重试失败后才测试 **Retry**。
13. 在 Options 中清除可重新获取的工具缓存，确认最终答案和对话历史仍保留。
14. 在两个 GitHub 页面上打开 Cubby，在其中一个页面启动全库 Organize；确认第二个页面在所有者断开连接并明确选择 **Take control** 前保持只读。在 Review 中选择建议并点击 **Apply**，确认两个页面都收敛到终态回执。
15. 删除来源对话，确认终态 Organize 结果仍可查看，然后点击 **Dismiss**。
16. 确认请求发送到选定地址。检查发布诊断和证据中只有有界事实，不包含凭据、认证 Header 或原始 Provider 请求和响应正文。
17. 删除审核专用 Gist，并在审核结束后撤销或轮换所有审核凭据。

不要把凭据值或清理用 Secret 放进本文档。

## 提交前检查清单

- `pnpm build:firefox` 成功，且 `dist-firefox/manifest.json` 包含 Gecko 块和 `background.scripts`，不含 `background.service_worker`；
- `pnpm check:firefox-output`、`pnpm lint:firefox`（固定 `web-ext@10.6.0`，只有五条已审核警告且没有 error/notice）和 `pnpm package:firefox` 成功；
- `pnpm test:smoke:firefox` 和 `pnpm test:verify-firefox` 在实际执行的 Firefox 版本上通过；Firefox 140 证明要求二进制报告 140.x 版本；
- ZIP 根目录直接包含 `manifest.json`；
- 扩展包与源码包校验和与生成的 `.sha256` 文件一致；
- 审核员源码包包含 lockfile 和审核员 README，并能重建 ZIP；
- 公开仓库包含审核过的隐私政策，且 URL 无需认证即可访问；
- AMO 数据收集申报与打包后的 manifest 和隐私政策一致；
- 远程代码回答为“无”：安装包不加载任何远程可执行代码；
- 权限说明与打包后的 manifest 一致；
- 审核备注写明必需的 GitHub Token scope，并只通过私有渠道提供专用凭据；
- README 中 Firefox 条目仍为“即将上架”；只有在直接观察到 AMO listing URL 后才能替换。

## Mozilla 官方参考

- [Source code submission（源码提交）](https://extensionworkshop.com/documentation/publish/source-code-submission/)
- [Add-on Policies（附加组件政策）](https://extensionworkshop.com/documentation/publish/add-on-policies/)
- [AMO Developer Hub（AMO 开发者中心）](https://addons.mozilla.org/developers/)
