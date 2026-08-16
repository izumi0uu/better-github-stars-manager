<!--
Read CONTRIBUTING.md or CONTRIBUTING.en.md before submitting.
提交前请阅读 CONTRIBUTING.md 或 CONTRIBUTING.en.md。

Use a focused Conventional Commit style title. GitHub hides these comments in the rendered Pull Request.
PR 标题使用范围清晰的 Conventional Commit 格式。GitHub 不会在渲染后的 Pull Request 中显示这些注释。
-->

## Problem / 问题

<!-- Describe the incorrect or missing behavior and its user impact. 描述错误或缺失的行为，以及对用户的影响。 -->

Related issue / 关联 Issue: <!-- Closes #123 or N/A / 填写 Closes #123 或 N/A -->

## Decision / 方案

<!-- Explain what changed, why this approach was chosen, and what remains unchanged. 说明改了什么、为什么这样改，以及哪些边界保持不变。 -->

## Verification / 验证

<!-- List exact commands and manual scenarios that you actually ran. 只列出实际运行过的命令和手动场景。 -->

Tested / 已验证：

- <!-- Add each command or scenario / 添加每条命令或场景 -->

Not tested / 未验证：

- <!-- State each excluded scenario / 列出每个未验证场景 -->

## Risk / 风险

<!-- Cover permissions, data, storage, sync, browser compatibility, and release risk. Write N/A when none apply. 说明权限、数据、存储、同步、浏览器兼容和发布风险；不适用时写 N/A。 -->

## Visual evidence / 视觉证据

<!-- Required for visual changes. Use synthetic or explicitly approved public data. 视觉改动必须提供；只能使用合成数据或明确获准公开的数据。 -->

## Checklist / 检查清单

- [ ] The diff addresses one focused problem and contains no unrelated refactor or formatting work / 改动只解决一个明确问题，不含无关重构或格式化
- [ ] New behavior and bug fixes have suitable behavior tests / 新行为和 Bug 修复有合适的行为测试
- [ ] `pnpm typecheck` and the smallest relevant tests pass / `pnpm typecheck` 和适用的最小测试已通过
- [ ] English and Chinese documentation match user-visible behavior changes, when applicable / 如有用户可见变化，中英文文档已同步
- [ ] UI changes were verified in the real extension surface, when applicable / 如有界面改动，已在真实扩展页面验证
- [ ] The diff contains no generated output, credentials, private data, personal information, or copied external work-item text / 改动不含生成文件、凭据、私人数据、个人信息或外部工作项原文
- [ ] Tested and untested scope is stated accurately / 已准确说明验证和未验证范围
