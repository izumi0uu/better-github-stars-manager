# 参与贡献

[English](CONTRIBUTING.en.md)

感谢你改进 Better GitHub Stars Manager。请保持改动聚焦、可验证，并优先复用现有实现模式。

## 开始前

- 阅读 [AGENTS.md](AGENTS.md)，其中记录了数据、同步、隐私和验证规则。
- 修改或调试 Cubby Agent 前，阅读 [Cubby Agent 技术参考](docs/zh/cubby-agent.md)。
- 不要把真实账号、Token、API Key、本地绝对路径、私人仓库内容或外部工单原文写入代码、测试、日志、截图或文档。使用合成数据。

## 安装与常规构建

项目使用 `package.json` 中固定版本的 pnpm：

```bash
pnpm install
pnpm build
```

常规 Chrome 构建输出到 `dist/`。Firefox 构建使用：

```bash
pnpm build:firefox
```

## 调试 Cubby Agent

需要检查 Cubby Agent 的开发诊断、Provider 事件或恢复行为时，不要修改发布构建来临时暴露调试状态。使用仓库提供的开发入口。

生成一个可重复加载的 Agent 诊断构建：

```bash
pnpm build:agent-dev-diagnostics
```

构建输出位于 `artifacts/agent-diagnostics-dev-dist/`。在 `chrome://extensions` 中开启开发者模式，选择 **加载已解压的扩展程序**，并加载这个目录。

需要实时 Provider 监控时运行：

```bash
pnpm dev:agent-diagnostics
```

该命令会构建 `dist/`，随后启动本地诊断服务。按终端输出加载或重新加载 `dist/`，并在监控期间保持进程运行。

这些入口仅用于本地开发。`artifacts/agent-diagnostics-dev-dist/`、本地诊断服务和开发记录都不是商店包或发布证据；发布验证必须使用正式构建和发布门禁。

## 验证

代码改动至少运行：

```bash
pnpm typecheck
```

然后运行覆盖改动行为的最小测试层。Cubby Agent 改动通常从对应的命令开始：

```bash
pnpm test:logic
pnpm test:runtime:agent-diagnostics
pnpm test:runtime:agent-scenarios
```

其他 Agent runtime 命令见 `package.json`。不要为了方便跳过真实扩展运行边界，也不要把开发诊断构建当作发布构建。

## 提交 Pull Request

说明可观察到的行为变化、风险边界，以及实际运行过的命令。不要提交生成的构建目录、个人数据或未经脱敏的诊断产物。
