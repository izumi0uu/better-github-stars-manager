简体中文 · [English](./README.en.md)

<div align="center">
  <img src="public/icons/icon-128.png" alt="Better GitHub Stars Manager" width="96" height="96">

# Better GitHub Stars Manager

**把 GitHub Stars 变成一个可搜索、可分类、可持续维护的个人管理面板。**

直接在 GitHub Stars 页面搜索、筛选、添加标签和笔记。需要时再启用 Watch、Following、For You、Secret Gist 同步和 Cubby AI等功能。

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-立即安装-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Latest release](https://img.shields.io/github/v/release/izumi0uu/better-github-stars-manager?logo=github&label=release)](https://github.com/izumi0uu/better-github-stars-manager/releases)
[![License: MIT](https://img.shields.io/github/license/izumi0uu/better-github-stars-manager?logo=opensourceinitiative&logoColor=white)](./LICENSE)

  <img src="store-assets/screenshots/readme-promo.png" alt="Better GitHub Stars Manager 产品能力信息图" width="960" />
<sub>主视觉中的产品截图由项目维护者提供并明确批准公开使用；截图展示真实界面和公开 GitHub 数据。</sub>

</div>

## 目录

- [为什么需要这个管理面板](#你的-stars-可以是一个管理面板)
- [主要功能](#它可以干什么) — Stars 分类、Watch、发现和 Cubby
- [本地优先的数据边界](#本地优先可选连接)
- [开始使用](#开始使用) — [安装](#安装) · [首次同步](#首次同步)
- [产品边界](#它不会做什么)
- [本地开发](#本地开发)
- [相关文档](#相关文档)
- [参与贡献](#参与贡献) · [许可证](#许可证)
- [链接](#链接) · [友情链接](#友情链接)

## 开始使用

### 安装

| | 商店 | 适用浏览器 |
| :---: | --- | --- |
| [<img src="store-assets/store-badges/chrome.svg" alt="Get it on Chrome Web Store" height="55">](https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa) | [Chrome Web Store](https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa) | Chrome、Edge、Brave、Opera 等 Chromium 内核浏览器 |
| [<img src="store-assets/store-badges/edge.svg" alt="Get it on Edge Add-ons" height="55">](https://microsoftedge.microsoft.com/addons) | [Edge Add-ons](https://microsoftedge.microsoft.com/addons) · 即将上架 | Microsoft Edge |
| [<img src="store-assets/store-badges/firefox.svg" alt="Get it on Firefox Add-ons" height="55">](https://addons.mozilla.org/firefox/) | [Firefox Add-ons](https://addons.mozilla.org/firefox/) · 即将上架 | Firefox |
| [<img src="store-assets/store-badges/opera.svg" alt="Get it on Opera Add-ons" height="55">](https://addons.opera.com/extensions/) | [Opera Add-ons](https://addons.opera.com/extensions/) · 即将上架 | Opera |

<!-- TODO: Edge、Firefox、Opera 上架后，把对应的占位链接替换为扩展页地址 -->

扩展基于 Manifest V3。安装后打开 `https://github.com/{you}?tab=stars`，管理器会出现在 Stars 页面中。

### 首次同步

1. 打开扩展 **Options** 页
2. 创建 GitHub Classic PAT，并授予 `repo` 与 `gist` scope
3. 按需追加 `notifications`（Watch）和 `read:user`（Following）权限
4. 粘贴 Token，点击 **Save & verify**
5. 打开 `https://github.com/{you}?tab=stars` 自动启动
6. 首次进入时自动运行 **Full Sync**

打开[预填的 Classic PAT 表单](https://github.com/settings/tokens/new?scopes=repo,gist,notifications,read:user&description=Better%20GitHub%20Stars%20Manager)，按下图完成配置。

<details>
<summary><strong>展开图文配置 GitHub Token</strong></summary>

<br>

#### 1. 设置有效期

保留 Note，并选择有限有效期。

<img src="store-assets/screenshots/token-guide-create-classic-pat.webp" alt="Classic PAT 的 Note、有效期和 repo scope" width="1568" height="875" />

#### 2. 确认 scopes

保留 `repo`、`gist`、`notifications` 和 `read:user`；不要勾选 `user`。

<img src="store-assets/screenshots/token-guide-select-scopes.webp" alt="已勾选 gist、notifications 和 read:user，未勾选 user" width="1568" height="520" />

#### 3. 生成并保存

点击 **Generate token**，复制 Token，粘贴到 **Options > GitHub Classic PAT**，然后点击 **Save & verify**。

<img src="store-assets/screenshots/token-guide-generate-token.webp" alt="点击 Generate token 生成 GitHub Classic PAT" width="888" height="290" />

GitHub 只显示一次 Token，请妥善保管。

</details>

## 你的 Stars 可以是一个管理面板

GitHub Stars 可以浏览 star 项目，但是有时候你会忘了你 star 过什么。当 stars 超过几百个后，你难以回忆起你之前的收藏，看到仓库名字，你也忘记它是什么了。

Better GitHub Stars Manager 直接挂载在 Stars 页面。它把项目的数据、你自定义的标签、笔记整理到浏览器里中，同时保留 GitHub 原生页面作为随时可切换的入口。

| 你可以做的 | GitHub Stars | Better GitHub Stars Manager |
|---|---|---|
| 按语言和列表整理 | 基础支持 | 可组合语言、标签、状态和 owner 筛选 |
| 查看收藏项目的通知 | 需要离开 Stars 页面 | 可选 Watch 工作区 |
| 看看你关注的人 star 了什么 | 需要分别查看账号 | 可选 Following 工作区 |
| 自定义标签 | 不支持 | 支持手动标签、Auto Tags 和收藏 |
| 记录个人笔记 | 不支持 | 支持，默认保存在浏览器本地 |
| 仓库推荐 | GitHub Explore | 可选 For You，本地确定性排序 |
| 整理和比较你的所有 stars | 不支持 | 可选 Cubby AI |

## 它可以干什么

### 分类你的 stars

Stars 工作区用于检索和维护你的仓库收藏：

- 搜索仓库名、描述、GitHub topics 和私人笔记
- 按语言、标签、收藏、未标注、Archived 或本人公开仓库筛选
- 按 Star 时间、最近更新、创建时间、Star 数量或名称排序
- 添加自定义标签、私人笔记和添加'最爱'
- 根据 GitHub topics 批量生成本地 Auto Tags
- 在 GitHub 仓库页通过 tag filter 查看和编辑标签
- 调整面板列顺序、宽度、显隐、owner 名称和头像
- 隐藏应用，切回 GitHub 原生 Stars 列表

<div align="center">
  <img src="store-assets/screenshots/demo-stars.webp" alt="从 GitHub Stars 切换到管理器，筛选仓库并打开详情" width="960" />
</div>

#### 自定义面板

工具栏的 **编辑自定义布局** 按钮进入布局编辑模式：

- **拖拽排序**：拖拽列头调整列顺序，插入位置实时指示，其余列动画让位
- **拖拽调宽**：拖拽列边调整列宽并实时显示宽度，可一键 **重置列宽**
- **显示/隐藏列**：打开 **列** 菜单勾选可见列
- **信息密度**：独立开关 **显示仓库所有者** 与 **显示仓库头像**
- **状态与重置**：自定义布局与默认布局随意切换，也可随时 **重置** 回默认布局
- **本地持久化**：布局保存在 `chrome.storage.local`，下次访问自动恢复

<div align="center">
  <img src="store-assets/screenshots/demo-edit-layout.webp" alt="拖拽调整表格列顺序、宽度与显隐" width="900" />
</div>

仓库列表使用虚拟化渲染，可处理几百到几千条记录。增量 **Sync** 获取新 Star，**Full Sync** 重新拉取全部 Stars 和你拥有的公开仓库。重扫会对账已取消的 Star，并保留已有标签和笔记。

### Watch 某个项目的变化

Watch 工作区用于获取 GitHub 信箱的通知并整理给你:

- 按仓库分组查看未读或全部通知
- 搜索仓库名和通知标题，可以按通知原因筛选
- 按需读取 Issue 或 Pull Request 的正文、状态、作者、labels、assignees 和 milestone
- 将一条通知或整个仓库组标记为已读或完成

Watch Inbox 需要 Classic Personal Access Token (PAT) 的可选 `notifications` scope。完整行为见 [Watch 的工作方式](docs/zh/watch-strategy.md)。

### 发现你所爱

Following 与 For You 帮助你发现更多项目：

- **关注动态**：读取你关注的人的最近 30 天的公开 Star 活动，并支持搜索、隐藏、Star、收藏和添加标签
- **为你推荐**：从现有 Stars 选择数据，通过 GitHub 公开 Search 获取筛选后再推送给你

For You 会排除你已 Star 的仓库、Archived 仓库和 Fork。它使用 GitHub 支持的公开接口，不复刻 GitHub Explore 的私有推荐系统。候选来源、评分和每日刷新规则见 [For You 推荐如何工作](docs/zh/for-you-recommendation-strategy.md)。

Following 需要可选 `read:user` scope。缺少该 scope 不影响 Stars、Gist 或 Watch。

![Following 项目视图](store-assets/screenshots/readme-following-projects.webp)

![For You 仓库推荐](store-assets/screenshots/readme-for-you.webp)

### 让 Cubby 帮你整理 stars 仓库 <img src="src/ui/assets/index-agent-working.gif" alt="Cubby 正在工作" width="28" height="28" align="absmiddle" />

Cubby 是你的助手：

- **总结资料库**：归纳主题、技术栈和你的收藏喜好
- **比较项目**：结合仓库数据、topics 和公开代码，解释相似仓库的区别与适用场景
- **查找依据**：只在请求需要时读取范围内的个人笔记或搜索公开仓库代码
- **整理标签**：提出有依据的标签建议；全库 **Organize** 会先完成只读分析，再交给你 Review

普通对话中的标签写入受仓库范围、本轮证据和数量限制。Organize 只有在你选择建议并点击 **Apply** 后才会写入标签。会话、进度和结果保存在 IndexedDB 中，页面关闭或 Manifest V3 service worker 重启后仍可恢复。

![Cubby 分析资料库](store-assets/screenshots/readme-cubby-progress.webp)

![Cubby 整理结果](store-assets/screenshots/readme-cubby-review.webp)

详细的数据边界、Provider 协议和恢复规则见 [Cubby Agent 技术参考](docs/zh/cubby-agent.md)。

## 本地优先，可选连接

核心数据默认留在当前浏览器。只有 GitHub 同步、你主动使用的 Secret Gist 同步，以及你明确调用的 Cubby 会产生对应网络请求。

| 功能 | 数据存哪 | 网络 | 是否必须 |
|---|---|---|---|
| Stars、仓库元数据和筛选状态 | IndexedDB 与 `chrome.storage.local` | GitHub API | 核心能力 |
| 标签、笔记、收藏和标签元数据 | IndexedDB | 默认无；Push 或 Pull 时连接 GitHub Gist | Gist 传输可选 |
| Watch 快照与通知 | IndexedDB | GitHub API | 可选 `notifications` scope |
| Following 快照与 For You 缓存 | IndexedDB | GitHub API | Following 需要可选 `read:user` scope |
| Cubby 对话、恢复记录和产物 | IndexedDB | 你配置的 AI 服务 | 可选 |
| GitHub Token 和 AI API Key | 加密后存入 `chrome.storage.local` | 仅发送给各自目标服务 | 按能力配置 |

Secret Gist 的 **Push** 与 **Pull** 只同步笔记内容。仓库元数据始终从 GitHub 重建；
Watch、Following、For You、Cubby 对话和 Organize 记录不会写入 Gist。

Github token 会进行本地加密。Cubby 对话、恢复记录和产物以未加密形式保存在扩展的 IndexedDB 中。卸载扩展会删除 Chrome 的本地扩展存储，但不会删除 GitHub 账号中的同步 Gist。

项目没有其他后端服务、GitHub 代理、AI 代理、分析 SDK、广告网络或跟踪服务。完整说明见 [隐私政策](docs/zh/privacy-policy.md)。

## 它不会做什么

Better GitHub Stars Manager 是 Stars 页面的增强层，不是另一个平台：

- **不会擅自修改你的 Star 或 Watch 内容**：只读取和整理
- **不会复刻 GitHub Explore**：For You 使用公开 GitHub API 然后确定性排序
- **不会另起后端或代理**：请求直达 GitHub 与你配置的 AI 服务
- **不会收集遥测**：项目不包含分析 SDK、广告网络或跟踪服务
- **不会自动读取私人笔记**：Cubby 只在你的指令需要时读取范围内笔记

## 本地开发

项目使用 pnpm。构建扩展：

```bash
pnpm install
pnpm build
```

构建包含 Cubby Agent 开发诊断功能的扩展版本（输出至 `artifacts/agent-diagnostics-dev-dist/`）：

```bash
pnpm build:agent-dev-diagnostics
```

在 Chrome 中加载构建结果：

1. 打开 `chrome://extensions`
2. 开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目中的 `dist/` 目录
5. 打开 **Options**，按上文配置 GitHub Token

常用验证命令：

```bash
pnpm typecheck
pnpm test:logic
pnpm test:integration
pnpm test:regressions
pnpm test:runtime
pnpm test:smoke
```

## 相关文档

- [GitHub Token 权限](docs/zh/github-token-permissions.md)
- [Watch 的工作方式](docs/zh/watch-strategy.md)
- [For You 推荐如何工作](docs/zh/for-you-recommendation-strategy.md)
- [Cubby Agent 技术参考](docs/zh/cubby-agent.md)
- [隐私政策](docs/zh/privacy-policy.md)
- [Chrome Web Store 更新说明](docs/zh/chrome-web-store-submission.md)
- [Firefox Add-ons 提交参考](docs/zh/firefox-amo-submission.md)
- [Microsoft Edge Add-ons 提交参考](docs/zh/edge-addons-submission.md)
- [Opera Add-ons 提交参考](docs/zh/opera-addons-submission.md)

## 参与贡献

欢迎在 [GitHub Issues](https://github.com/izumi0uu/better-github-stars-manager/issues) 报告问题或提交功能建议。Pull request 也可以直接提交到本仓库。

## 许可证

MIT License，见 [LICENSE](./LICENSE)。

Copyright (c) 2026 izumi0uu。

## 链接

- [GitHub 仓库](https://github.com/izumi0uu/better-github-stars-manager)
- [Chrome Web Store](https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa)
- [GitHub Issues](https://github.com/izumi0uu/better-github-stars-manager/issues)

## 友情链接

- [Linux.do](https://linux.do/) · [NodeSeek](https://www.nodeseek.com/)
- [小黑盒](https://xiaoheihe.cn/app/bbs) · [V2EX](https://www.v2ex.com/)
