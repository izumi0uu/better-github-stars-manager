[English](./README.md) · [简体中文](./README.zh-CN.md)

# Better GitHub Stars Manager

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-立即安装-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Latest release](https://img.shields.io/github/v/release/izumi0uu/better-github-stars-manager?logo=github&label=release)](https://github.com/izumi0uu/better-github-stars-manager/releases)
[![License: MIT](https://img.shields.io/github/license/izumi0uu/better-github-stars-manager?logo=opensourceinitiative&logoColor=white)](./LICENSE)

> 一个为重度 GitHub 用户打造的 Chrome 扩展 —— 本地优先、零服务端、个人专属。它把 `https://github.com/{user}?tab=stars` 变成一个可搜索、可打标签、可筛选、可批注的快速工作台,管理成千上万个 star，而不必离开 GitHub。

Chrome 商店安装地址:
[前往 Chrome 商店下载](https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa)

![Better GitHub Stars Manager](public/poster/img_01.png)

## 目录

- [为什么需要 Better GitHub Stars Manager?](#为什么需要-better-github-stars-manager)
- [功能特性](#功能特性)
- [截图](#截图)
- [如何使用](#如何使用)
- [安装](#安装)
- [隐私与存储](#隐私与存储)
- [开发](#开发)
- [许可证](#许可证)
- [参与贡献](#参与贡献)

## 为什么需要 Better GitHub Stars Manager?

GitHub Stars 适合收藏,但做不了长期管理。

当你的star项目收藏到几百几千个的时候，通过原生list功能难以管理，ai时代，github项目指数级增长，而你又想收藏各种各样的项目，过后又忘记在哪，叫什么名字了，所以有很多难解决的问题:

- 分页看不到全部stars仓库
- 没有个人打标签系统
- 没有真正的笔记层
- 很难回看当时存了什么、为什么存

Better GitHub Stars Manager 让 GitHub Stars 对重度用户真正可管理。

## 功能特性

- **一次管理所有已star项目**
  把你 star 的仓库加载进虚拟化表格。

- **快速搜索与筛选**
  在仓库名、描述、topics、笔记中全文搜索;按语言、标签、未打标签筛选。

- **悬浮按钮一键切换**
  在你自己的Github star页， 提供悬浮按钮一键切换到管理面板。

- **自定义标签与笔记**
  加你自己的标签和笔记,让 star 从被动列表变成一个可用的资料库。

- **自动推荐标签**
  一键或批量把仓库的 topics 与语言转成推荐标签。

- **增量同步与全量重扫**
  快速拉取新 star 的仓库;需要时可全量重扫来对账 unstar,同时保留你的批注。

- **repo 页 tag chip**
  直接在单个 GitHub 仓库页查看和编辑你的标签。

- **跨设备批注同步**
  通过你自己的私有 GitHub Gist 推送/拉取标签与笔记。

- **Gist 支撑的存储层**
  把批注层放在一个专用 secret Gist 里,可移植、可恢复、跨设备同步,无需后端。

## 截图

<p align="center">
  <img src="public/poster/img_02.png" alt="Better GitHub Stars Manager 在 GitHub Stars Main page" width="920">
  <img src="public/store/screenshots/screenshot-plugin.png" alt="Better GitHub Stars Manager Plugin" width="300">
</p>

## 如何使用

1. 先从 Chrome Web Store 安装扩展。
2. 打开插件，点击跳转 Options 页,粘贴一个 GitHub personal access token 并验证。
3. 访问你的 GitHub stars 页:`https://github.com/{you}?tab=stars`。
4. 运行 **Sync** 导入你的 star。
5. 边浏览仓库边搜索、筛选、打标签、加笔记。
6. 想让批注跨设备流转时用 **Push** 和 **Pull**。

## 安装

Chrome 商店安装地址:

[前往 Chrome 商店下载](https://chromewebstore.google.com/detail/better-github-stars-manag/jbiacpcceoffcnmpepifoegagjopjpfa)

然后:

1. 点击 **添加至 Chrome**
2. 打开扩展的 **Options** 页
3. 按下方权限创建一个 GitHub token
4. 把 token 粘贴到 Options 并点 **Save & verify**
5. 访问 `https://github.com/{you}?tab=stars`
6. 运行 **Sync** 导入你的 star

通过商店安装后，Chrome 会自动处理后续更新。

### Token 配置

Step 1: 创建一个 **fine-grained personal access token**,点 **Generate new token**。

![创建 fine-grained token](public/tutorial/img_01.png)

Step 2: Repository access 选 **Public repositories**。

![选择仓库访问范围](public/tutorial/img_02.png)

Step 3: 加上 **Gists: read and write**,以便跨设备同步可用。

![授予 Gists 权限](public/tutorial/img_03.png)

推荐的 GitHub token 权限:

- **Public Repositories (read)**
- **Gists (read/write)**

> 细粒度 token 的 Gist 权限是账号级的(不能按 gist 隔离)。扩展会为同步创建一个专用 secret gist。

### 另一种方式 --> 本地开发安装

```bash
pnpm install
pnpm build
```

然后在 Chrome 中:

1. 打开 `chrome://extensions`
2. 开启 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择 `dist/` 文件夹
5. 打开扩展的 **Options** 页，并继续按上方 Token 配置完成设置

## 隐私与存储

扩展的设计是:重数据本地保存,只同步个人批注层。

- star 元数据本地存在 IndexedDB。
- 轻量配置在 `chrome.storage.local`。
- 标签、笔记与标签元数据可存在你自己 GitHub 账号下的一个专用 secret Gist。

Push / Pull 只同步批注层:

- `Push` 把标签、笔记、标签元数据上传到你的私有 Gist。
- `Pull` 把最新的标签、笔记、标签元数据合并回本地数据库。
- star 元数据本身留在本地,始终从 GitHub 重建。

没有自建后端,也没有独立的应用账号。

面向商店的隐私声明 [docs/privacy-policy.md](docs/privacy-policy.md)。

## 许可证

MIT 许可证 —— 见 [LICENSE](./LICENSE)。

Copyright (c) 2026 izumi0uu.

## Friendly Links

- [Linux.do](https://linux.do/) [nodeseek](https://www.nodeseek.com/)
- [xiaoheihe](https://xiaoheihe.cn) [v2ex](https://www.v2ex.com/)

## 参与贡献

欢迎在[仓库](https://github.com/izumi0uu/better-github-stars-manager/issues)提 issue 和 PR。
