# 为 Better GitHub Stars Manager 贡献

[English](CONTRIBUTING.en.md)

本指南说明如何提出、实现、验证和提交一个范围清晰的改动。发布打包、商店提交和版本发布由维护者负责。

## 开始前

- 阅读 [AGENTS.md](AGENTS.md)，其中记录了数据、同步、隐私和验证规则
- 修改或调试 Cubby Agent 前，阅读 [Cubby Agent 技术参考](docs/zh/cubby-agent.md)
- 优先复用现有实现模式，避免为同一问题创建第二套约定

## 选择正确的提交方式

开始编码前，先搜索现有的 [GitHub Issues](https://github.com/izumi0uu/better-github-stars-manager/issues)，避免重复工作。

以下改动可以直接提交 Pull Request：

- 范围明确的 Bug 修复
- 回归测试或测试可靠性改进
- 与当前行为一致的文档修正
- 不改变产品行为的小型维护改动

以下改动应先创建 Issue 并确认范围：

- 新功能或明显的交互改版
- Manifest、权限或浏览器兼容性变化
- IndexedDB schema、索引、迁移或 backfill 变化
- GitHub 同步、认证、数据保留或数据传输语义变化
- 新依赖、大型重构或跨模块 API 变化

报告 Bug 时，请提供：

- 浏览器、浏览器版本和扩展版本或 commit
- 可去除私人数据后复现的最小步骤
- 预期行为和实际行为
- 已脱敏的错误信息、控制台输出或截图

不要在 Issue 中提交 Token、API Key、私人仓库数据或可识别个人身份的信息。报告安全漏洞时，请阅读[安全政策](SECURITY.md)，并优先使用仓库 [Security 页面](https://github.com/izumi0uu/better-github-stars-manager/security)中提供的私密报告入口。如果该入口不可用，只创建一条已脱敏的 Issue 请求私密联系方式，不要公开漏洞细节。

## 准备开发环境

项目的持续集成环境使用 Node.js 24 和 pnpm 10.33.2。使用相同版本可以减少本地与持续集成环境的差异。

1. Fork 本仓库并克隆你的 Fork
2. 从 `master` 创建一个范围明确的分支，例如 `fix/watch-account-fence`
3. 安装依赖并构建 Chrome 扩展

```bash
pnpm install --frozen-lockfile
pnpm build
```

`pnpm install` 会安装仓库的 commit message hook。Chrome 构建输出位于 `dist/`，该目录不会提交到 Git。

在 Chrome 中验证构建结果：

1. 打开 `chrome://extensions`
2. 开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目中的 `dist/` 目录

Firefox 专用改动使用以下命令：

```bash
pnpm build:firefox
pnpm lint:firefox
pnpm test:smoke:firefox
```

Firefox 构建输出位于 `dist-firefox/`。不要直接编辑 `dist/`、`dist-firefox/`、`dist-demo/` 或 `artifacts/` 中的生成文件。

## 调试 Cubby Agent

检查 Cubby Agent 的开发诊断、Provider 事件或恢复行为时，不要修改发布构建来临时暴露调试状态。使用仓库提供的开发入口。

生成一个可重复加载的 Agent 诊断构建：

```bash
pnpm build:agent-dev-diagnostics
```

构建输出位于 `artifacts/agent-diagnostics-dev-dist/`。在 `chrome://extensions` 中开启 **开发者模式**，点击 **加载已解压的扩展程序**，并加载这个目录。

需要实时 Provider 监控时运行：

```bash
pnpm dev:agent-diagnostics
```

该命令会构建 `dist/`，随后启动本地诊断服务。按终端输出加载或重新加载 `dist/`，并在监控期间保持进程运行。

这些入口仅用于本地开发。Agent 诊断构建、本地诊断服务和开发记录都不是商店包或发布证据；发布验证必须使用正式构建和发布门禁。

## 遵守数据和浏览器边界

改动数据模型、同步或 manifest 前，请保持以下约束：

- `src/storage/db.ts` 中的 IndexedDB 是 stars、tags 和 tag metadata 的本地事实来源
- `chrome.storage.local` 只保存轻量配置、界面状态、凭据材料和 backfill 状态
- GitHub 是 `archived`、`fork`、`created_at`、`pushed_at` 和 `starred_at` 等远端元数据的事实来源
- 新增 `Config` 字段时，在 `src/types/index.ts` 定义安全默认值，并在 `src/auth/auth-store.ts` 读取时规范化
- 改变持久化实体或索引时，同步更新类型、Dexie schema 和旧数据兼容逻辑
- 为现有行补充远端字段时，优先使用 capability backfill，不要在每次扩展更新时触发 full sync
- 修改 manifest 时更新 `manifest.config.ts` 或对应构建转换，不要修改生成后的 `manifest.json`
- 扩展不能下载或执行远程代码；外部响应只能作为数据处理

修复应解决拥有该行为的源代码，并迁移所有调用方。不要为尚未发布的实验行为保留兼容别名或双路径。

## 保护隐私和测试数据

所有 tracked 文件和资源都必须适合公开发布：

- 使用 `octocat`、`user@example.com` 和仓库相对路径等合成值
- 不提交真实用户名、姓名、邮箱、本机路径、Token、账号数据或私人仓库信息
- 不提交来自个人账号的截图，除非维护者已明确批准公开且截图不含私人数据
- 不把 Jira、支持工单、聊天或其他外部工作项的原文复制进代码、测试、注释、文档或资源
- 将外部需求改写为通用的产品行为和测试条件
- 提交前检查图片、JSON、日志和其他非代码资源中的元数据

## 验证改动

先运行覆盖改动边界的最小测试。所有代码改动都必须运行 `pnpm typecheck`。

| 改动范围 | 验证命令 |
| --- | --- |
| 纯逻辑、筛选或排序 | `pnpm test:logic` |
| Query 或 store 集成 | `pnpm test:integration` |
| 同步、存储兼容、迁移或 backfill | `pnpm test:regressions` |
| 扩展运行时行为 | `pnpm test:runtime` 或 `pnpm test:smoke` |
| Cubby Agent 逻辑或运行时 | `pnpm test:logic`、`pnpm test:runtime:agent-diagnostics` 或 `pnpm test:runtime:agent-scenarios` |
| Firefox 专用行为 | `pnpm build:firefox`、`pnpm lint:firefox` 和 `pnpm test:smoke:firefox` |
| 文档 | 检查链接、命令和中英文内容；代码测试可省略 |

Bug 修复需要能在修复前失败、修复后通过的回归测试。同步语义、存储兼容、迁移和 backfill 变化必须增加回归覆盖。

涉及界面的改动还需要在真实扩展页面中验证。视觉变化应附上使用合成数据生成的截图或录屏。Agent runtime 改动不能把开发诊断构建当作发布构建，也不能跳过真实扩展运行边界。

范围较大或风险较高的改动在提交前还应运行：

```bash
pnpm build
pnpm test
```

持续集成会在 Pull Request 上运行 `pnpm typecheck`、`pnpm build` 和 `pnpm test`，并执行无凭据的 Chrome 扩展 smoke check。

## 使用仓库的 commit 格式

Commit 标题使用 Conventional Commits 格式，最长 72 个字符，结尾不加句号。支持的类型为 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore` 和 `revert`。

`docs:` 和 `chore:` 可以只写一行。其他类型必须在标题后空一行，并填写仓库要求的 Lore trailers：

```text
fix(watch): preserve source account during bulk actions

Constraint: Keep each background request within the existing batch limit
Rejected: Retry against the new account | it could mutate the wrong account
Confidence: high
Scope-risk: narrow
Directive: Bind remote mutations to the projection that selected them
Tested: pnpm typecheck; focused Watch regression tests
Not-tested: Authenticated GitHub mutation against a live account
```

`Tested` 和 `Not-tested` 必须准确描述实际验证范围。Commit hook 会拒绝缺少必填字段或格式错误的消息。

## 提交 Pull Request

Pull Request 应以 `master` 为目标，并只解决一个清晰的问题。描述中请写明：

- **Problem**：当前行为哪里不正确或缺少什么
- **Decision**：采用了什么改动，以及为什么
- **Check**：运行了哪些验证，哪些场景没有验证
- **Risk**：权限、数据、兼容性或发布风险
- **Evidence**：相关测试、截图或录屏

提交前检查：

- [ ] 改动没有混入无关重构或格式化
- [ ] 新行为和 Bug 修复有合适的行为测试
- [ ] 已运行 `pnpm typecheck` 和适用的最小测试
- [ ] 用户可见行为对应的中英文文档已同步
- [ ] 视觉改动已在真实扩展页面验证
- [ ] 没有提交生成目录、凭据、私人数据或外部工作项原文
- [ ] Pull Request 描述准确列出已测试和未测试范围

维护者会根据正确性、隐私边界、跨浏览器行为和后续维护成本审查改动。商店发布、版本号和发布凭据不属于普通 Pull Request 的范围。

## 许可证

提交贡献即表示你同意按照本仓库的 [MIT License](LICENSE) 发布该贡献。
