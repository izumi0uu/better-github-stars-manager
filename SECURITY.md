# Security policy

[简体中文](#简体中文) | [English](#english)

This policy explains how to report a vulnerability without exposing users or maintainers to unnecessary risk.

本政策说明如何报告安全漏洞，避免给用户和维护者带来不必要的风险。

## 简体中文

### 支持范围

安全修复以当前 `master` 和每个已支持商店的最新公开版本为目标。旧版本不会单独发布补丁；修复会进入后续商店版本，实际可用时间还取决于各商店审核。

尚未发布的分支行为也可以报告，但请注明对应 commit。

### 私密报告漏洞

不要在公开 Issue、Pull Request、Discussion、截图或日志中披露漏洞细节、真实 Token、API Key、私人仓库数据或个人信息。

请按以下顺序报告：

1. 打开仓库的 [Security 页面](https://github.com/izumi0uu/better-github-stars-manager/security)
2. 如果页面显示 **Report a vulnerability**，使用该入口创建私密报告
3. 如果私密报告入口不可用，只创建一条[已脱敏的 Issue](https://github.com/izumi0uu/better-github-stars-manager/issues/new)，请求维护者提供私密联系方式
4. 在建立私密渠道前，不要在该 Issue 中加入漏洞原理、利用步骤或未发布的修复方案

报告中请提供：

- 受影响的扩展版本或 commit
- 浏览器和浏览器版本
- 漏洞影响和攻击前提
- 使用合成数据编写的最小复现步骤
- 已脱敏的日志、截图或概念验证
- 已知缓解方式

### 报告后的处理

维护者确认报告后，可能会请求补充信息、验证影响并准备修复。修复时间取决于漏洞范围、跨浏览器验证和商店审核，不承诺固定响应或发布时间。

在修复版本公开前，请勿公开漏洞细节。维护者会与报告者协调披露时间和署名。

### 不属于安全漏洞的问题

以下内容请使用普通 [GitHub Issues](https://github.com/izumi0uu/better-github-stars-manager/issues)：

- 不涉及安全边界的 Bug
- 功能建议
- 安装或配置问题
- 隐私政策解释请求
- 已公开且不包含敏感信息的依赖问题

## English

### Supported versions

Security fixes target the current `master` branch and the latest public version in each supported store. Older versions do not receive separate patches. Fixes ship through a later store release, and availability depends on each store's review.

You can also report behavior on an unreleased branch. Include the affected commit.

### Report a vulnerability privately

Do not disclose vulnerability details, real tokens, API keys, private repository data, or personal information in a public Issue, Pull Request, Discussion, screenshot, or log.

Report vulnerabilities in this order:

1. Open the repository's [Security page](https://github.com/izumi0uu/better-github-stars-manager/security)
2. Select **Report a vulnerability** when GitHub shows that option
3. If private reporting is unavailable, open only a [redacted Issue](https://github.com/izumi0uu/better-github-stars-manager/issues/new) asking the maintainer for a private contact route
4. Do not add vulnerability mechanics, exploitation steps, or an unpublished fix before a private route exists

Include these details in the private report:

- Affected extension version or commit
- Browser and browser version
- Impact and attack prerequisites
- Minimal reproduction steps using synthetic data
- Sanitized logs, screenshots, or proof of concept
- Known mitigations

### What happens after a report

After acknowledging the report, the maintainer may request details, validate impact, and prepare a fix. Timing depends on scope, cross-browser verification, and store review. This policy does not promise a fixed response or release deadline.

Do not publish vulnerability details before a fixed version is public. The maintainer will coordinate disclosure timing and credit with the reporter.

### Reports that are not security vulnerabilities

Use regular [GitHub Issues](https://github.com/izumi0uu/better-github-stars-manager/issues) for:

- Bugs that do not cross a security boundary
- Feature requests
- Installation or configuration problems
- Privacy policy questions
- Public dependency reports that contain no sensitive details
