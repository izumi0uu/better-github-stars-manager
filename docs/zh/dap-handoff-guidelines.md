# DAP 调试交接指南

[English](../en/dap-handoff-guidelines.md)

本项目使用 DAP 交接文档，为普通测试不足以解释故障的模块定义调试契约。文档应告诉调试 Agent 要验证哪条不变量、哪个 fixture 能暴露问题、应该在哪里停下，以及最终要返回哪些证据。

DAP 是观察工具，不负责漫无目的地发现问题。连接调试器前，先确定一条有名称的不变量和一个确定性 fixture。

## 何时需要 DAP 交接

以下新模块或变更应编写 DAP 交接：

- 状态机，例如 sync、backfill、onboarding、队列 runner 和布局编辑；
- 异步竞态，例如存储变更、后台任务、content script 导航、GitHub Turbo/PJAX 事件和防抖 UI 状态；
- 数据安全路径，例如 Auth Token、Gist 同步、IndexedDB 写入、migration 和 backfill；
- 跨边界行为，例如 React UI、shadow root、content script、background service worker、存储和消息传递；
- 复杂 UI 机制，例如 popover、portal、drag、resize、布局模式切换，以及视觉上正确但状态错误的交互层；
- 任何要交给 DAP、debugger 或 QA Agent 独立调查的模块。

以下情况通常不需要：

- 只改文案；
- 不涉及状态切换的小型视觉调整；
- 已经有直接回归覆盖的纯函数；
- 重命名、只改类型或机械重构。

## 优先级

- P0：数据完整性、凭据、同步、持久化和远端写入。必须提供交接文档；
- P1：查询行为、本地批注、升级和核心交互流程。强烈建议提供；
- P2：onboarding、i18n、content 生命周期、portal、shadow root 行为和体验稳定性。行为跨边界或容易回归时提供；
- P3：孤立的视觉细节。除非问题反复出现，否则使用普通测试或截图。

## 必需结构

使用下面的紧凑结构。模板标题保持英文，便于 Agent 直接复制和识别：

```text
# DAP Agent Handoff: <Module> <Priority> Probe Plan

## Requirements Summary
What the DAP agent should diagnose. State clearly that this is diagnostic, not
an implementation plan.

## Delivery Location
Repository path and plan path.

## Diagnostic Edit Permission
Allowed test-only edits and forbidden product-source edits.

## System Invariants
Rules that must always hold.

## Phase Contract Map
Pipeline stages and the file/function responsible for each stage.

## Fixture Matrix
Small deterministic scenarios that can expose divergence.

## DAP Breakpoint And Watchpoint List
Exact files/functions and values to watch.

## Execution Procedure
Smallest test command first, then DAP only after a fixture fails or looks
suspicious.

## Evidence Package Format
What the DAP agent must return.

## Acceptance Criteria
What coverage makes the diagnostic complete.

## Risks And Mitigations
Known blind spots and how to avoid false conclusions.
```

各字段的中文含义：

- Requirements Summary：说明要诊断的问题，并明确这不是实现计划；
- Delivery Location：给出仓库路径和计划路径；
- Diagnostic Edit Permission：写清允许的测试专用修改和禁止的产品源码修改；
- System Invariants：列出任何时候都必须成立的规则；
- Phase Contract Map：列出 pipeline 阶段以及负责该阶段的文件和函数；
- Fixture Matrix：列出能够暴露偏差的小型确定性场景；
- DAP Breakpoint And Watchpoint List：列出准确的文件、函数和观察值；
- Execution Procedure：先运行最小测试命令，只有 fixture 失败或表现可疑时才进入 DAP；
- Evidence Package Format：规定调试 Agent 必须返回的内容；
- Acceptance Criteria：说明覆盖到什么程度才算诊断完成；
- Risks And Mitigations：记录已知盲区和避免错误结论的方法。

## 证据规则

合格的 DAP 交接应让 Agent 返回：

- fixture 或测试名称及命令；
- 正在验证的不变量；
- 输入状态和事件顺序；
- 预期状态或输出，以及实际状态或输出；
- 第一个出现偏差的 breakpoint 和 watch 值；
- 产品源码是否发生变化，通常应为 `no`；
- 根因假设和置信度。

“我单步检查过，看起来没问题”不算证据。调试器观察必须对应到有名称的 fixture 和不变量。

## 命名

文件名应包含模块和用途，并能直接说明诊断目标，例如：

- `dap-github-stars-sync-handoff.md`
- `dap-auth-token-probe-handoff.md`
- `dap-backfill-upgrade-handoff.md`
- `dap-query-filter-cache-handoff.md`
- `dap-onboarding-first-run-handoff.md`
- `dap-content-script-mount-toggle-handoff.md`
- `dap-portal-shadow-primitives-handoff.md`
- `dap-i18n-catalog-locale-handoff.md`
