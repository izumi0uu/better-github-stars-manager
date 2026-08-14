# For You 推荐如何工作

本文说明 For You 如何选择、排序、存储和刷新公开仓库推荐，也明确了受支持的 GitHub 应用程序接口（API）边界，以及后续改动必须保留的行为约束。另见 [English version](../en/for-you-recommendation-strategy.md)。

## 目标与边界

For You 根据你已经 Star 的仓库推荐相关的公开仓库。它只使用 GitHub 支持的 API，并在本地进行确定性排序。它不是 GitHub Explore，界面也不能暗示两者使用了相同的私有推荐能力。

推荐缓存属于可重新生成的派生数据。Stars、标签、笔记、收藏状态和 tombstone 状态仍是独立的规范数据。

## 当前流程

这条流程读取本地规范 Stars，从 GitHub 获取数量受限的公开候选池，然后发布一份账号隔离的快照。每一步都有固定上限和确定的排序规则。

```mermaid
flowchart LR
  S["当前本地 Stars"] --> A["选择最多 12 个多样化种子"]
  A --> Q["构建最多 6 条 Search 查询"]
  Q --> G["GitHub REST 仓库 Search · 每条最多 100 行"]
  G --> F["校验、去重和排除"]
  F --> R["本地确定性排序"]
  R --> C["IndexedDB 推荐缓存"]
  C --> U["Discover > For You"]
```

### 1. 选择种子仓库

扩展从本地 IndexedDB 读取仍处于 Star 状态的仓库。它忽略 tombstone，以及 GitHub 已标记为 `viewer_has_starred: false` 的记录。

系统最多选择 12 个种子。较新的 Star 优先参与选择，同时限制同一语言和同一 owner 的数量，避免单一生态或组织占满查询计划。种子只包含仓库名、owner、语言、topics、Star 时间和 Star 数量。

实现位置：`src/recommendations/recommendation-model.ts` 中的 `selectRecommendationSeeds()`。

### 2. 获取候选仓库

扩展从种子中提取四类信号：

- 仓库 topics
- 主要语言
- 仓库 owner
- 仓库名中有意义的词

系统最多构建 6 条稳定的 Search 查询。每条查询只取第一页，最多返回 100 个仓库，并按 Star 数量排序。查询排除 archived 仓库和 fork，并采用以下最低 Star 数量：

| 信号 | Search 约束 |
|---|---:|
| Topic | 10 Stars |
| 语言 | 25 Stars |
| Owner | 5 Stars |
| 仓库名词元 | 10 Stars |

单次请求的超时时间是 20s，一轮完整刷新的总时限是 75s。GitHub Search 使用独立的认证限流额度。扩展记录本轮观察到的最低剩余额度和最新重置时间，冷却期间不反复重试。
如果成功响应显示 Search 剩余额度为 0，数据源会停止后续查询，并对已经取回的候选仓库排序。请求出错时仍会中止本轮刷新，不替换已保存快照。

有效快照可以少于 60 条。完成校验、排除和去重后，GitHub 返回的合格仓库可能不足 60 个。

实现位置：`src/recommendations/recommendation-model.ts` 中的 `buildRecommendationQueryPlan()`，以及 `src/api/github-recommendation-source.ts` 中的 `fetchGitHubRecommendations()`。

### 3. 校验与排除

所有 Search 响应都按不可信输入处理。候选仓库必须包含有效的 GitHub HTTPS 地址、仓库标识、owner、Star 数量、topics、archive 状态和 fork 状态，才能进入缓存。

排序前会排除：

- 已存在于当前本地 Stars 的仓库
- Archived 仓库
- Fork
- 重复的 Search 结果
- 与所有种子都没有可度量关联的候选仓库

最终列表最多包含 60 个仓库。

### 4. 本地排序

每个候选仓库都会与全部种子比较。关系最强的种子决定基础分，也决定界面显示的推荐原因。

| 信号 | 基础分 |
|---|---:|
| 共同 topic | $80 + 12 \times \min(\text{共同 topics 数}, 3)$ |
| 相同语言 | 50 |
| 相同 owner | 38 |
| 相关仓库名词元 | 22 |

基础分会再加上两个有上限的辅助分：

- **热度**：$\min(24, 6 \log_{10}(\text{Stars} + 1))$
- **新鲜度**：$\max(0, 18 - 3 \log_2(\text{距上次 push 的天数} + 1))$

结果依次按总分、Star 数量和规范化仓库 key 排序。固定输入会得到固定顺序。界面显示 `Because you starred …`，并附上最终胜出的 topic、语言、owner 或仓库名信号。

### 5. 持久化与整批替换

独立的 IndexedDB 表保存已发布列表和刷新状态。状态记录账号、尝试时间、成功时间、错误、冷却截止时间、候选数、种子数、查询数和 Search 限流数据。

刷新成功后，候选缓存与状态在同一个事务中完成替换。刷新失败、取消、超时或触发限流时，上一份成功快照会保留。因此，刷新进行中或数据过期时，界面仍可显示已保存的推荐。

**New batch / 换一批** 会发起新一轮 GitHub Search。它不是分页，也不会轮换本地分组。有限查询全部执行完且没有错误，随后校验和排序成功后，新快照才会替换旧快照。

同一凭据身份下，入口触发、定时触发和手动触发共享同一个进行中的刷新。如果发布前凭据身份发生变化，协调器会丢弃旧结果。

### 6. 首次加载与每日刷新

刷新策略分别处理首次加载、每日维护、启动补偿和手动换批：

| 触发方式 | 资格条件 | 结果 |
|---|---|---|
| 首次进入扩展 | 主 GitHub 凭据有效、本地至少有一个当前 Star，且账号没有成功推荐快照 | 获取一次初始快照 |
| 每日闹钟 | 已有成功快照，且主 GitHub 凭据有效 | 在设备本地时间下一个 08:00 刷新 |
| Service worker 启动或唤醒 | 上次成功发生在更早的本地日期、当前已过 08:00，且当天尚未尝试 | 进行一次补偿刷新 |
| **New batch / 换一批** | 主 GitHub 凭据有效，且不在冷却期 | 手动发起整批替换 |

每日任务使用一次性的 `chrome.alarms` 闹钟，而不是固定的 24 小时间隔。每次闹钟执行后，调度器根据当前时区重新计算下一个本地 08:00。这样切换时区或跨越夏令时后，刷新仍按本地钟表时间运行。

只有账号已有成功快照时，调度器才安装每日闹钟。账号或凭据不再符合条件时，调度器会删除该闹钟。启动时的调度对账会修复缺失或时间过期的闹钟。

入口信号来自 Popup、Options 和 Stars 页面内容脚本。不满足资格时，入口检查直接返回，不发送 GitHub 请求，也不显示错误。同一天的启动补偿最多尝试一次；Search 处于冷却期时，`nextAllowedAt` 之前不会发送请求。

实现位置：`src/background/recommendation-refresh.ts` 中的 `createRecommendationRefreshCoordinator()`、`src/background/scheduled-refresh.ts` 中的 `createScheduledRefreshController()`，以及 `src/utils/recommendation-entry.ts` 中的 `signalRecommendationEntry()`。

### 7. Star 一条推荐

For You 显示一条推荐，不会自动把它写入规范 Stars。点击 **Star** 后，扩展会：

1. 调用 GitHub 支持的 `PUT /user/starred/{owner}/{repo}` 接口
2. 立即从 GitHub 读取规范仓库元数据
3. 把仓库写入本地 Stars 表
4. 广播数据变更并重新加载推荐投影

这次定向同步不等待全库同步。操作完成后，新 Star 的仓库会从 For You 消失，并出现在本地 Stars 中。

## 刷新与错误契约

刷新失败使用稳定的产品状态。同一账号保留有效主凭据时，已保存的候选仓库仍可查询。移除主凭据、切换账号或主动清除推荐时，派生缓存会被清理。

| 条件 | 状态 | 缓存行为 | 重试行为 |
|---|---|---|---|
| 没有有效的主 GitHub 凭据 | `not_configured` | 对账并清理账号绑定数据 | 不自动请求 |
| 从未完成刷新 | `never_loaded` | 没有已发布结果 | 首次符合条件的入口可以获取 |
| 24 小时内成功 | `fresh` | 显示新快照 | 按每日或手动策略刷新 |
| 已保存快照超过 24 小时，或后续刷新失败 | `stale` | 保留已保存快照 | 按每日、补偿或手动策略刷新 |
| 首次成功前发生失败 | `error` | 没有已发布结果 | 手动重试或等待后续合格触发 |
| Search 限流仍有效 | `cooldown` | 保留已保存快照 | 等到 `nextAllowedAt` 后再请求 |

数据源把认证、权限、限流、取消、总时限、网络、GitHub 服务、Content-Type、响应结构和候选结构错误映射为稳定的 `RecommendationErrorCode`。只要计划内任一请求失败，就不会发布部分结果。

## 实现约束

后续改动必须保留以下契约：

- 规范 Stars 与可重新生成的推荐使用不同的数据表
- 排除 tombstone、已取消 Star、已存在于 Stars、archived、fork、重复和无关的候选仓库
- 明确限制种子数、查询数、单条查询结果数、请求超时、总时限和最终快照大小
- 固定种子、候选和抓取时间时，排序结果必须确定
- 只原子替换完整快照，失败时保留上一份快照
- 同一凭据身份下的并发刷新必须合并，凭据变化后拒绝发布旧结果
- 每日刷新按本地日历边界计算，不能使用固定的协调世界时（UTC）偏移或 24 小时周期
- 首次入口和启动补偿不符合条件时必须静默返回
- 只使用 GitHub 支持的 API，不抓取 Explore，也不依赖未公开接口

测试必须覆盖模型上限与排序、Search 校验与失败、存储替换与账号隔离、刷新合并、入口资格、本地 08:00 边界、补偿抑制、闹钟修复、界面换批，以及扩展浏览器冒烟路径。

## 为什么无法复刻 GitHub Explore 的私有推荐图谱

GitHub 文档说明 Explore 会根据账号活动显示个性化推荐，但没有提供受支持的 REST 或 GraphQL 接口来返回 Explore 候选集、排序分数、模型特征或反馈状态。

公开数据接口的职责更窄：

- Repository Search 返回符合明确查询条件的仓库，不返回 Explore 的个性化排序
- Stars 接口读取或修改认证账号的 Stars，不暴露 GitHub 的推荐图谱
- Personal dashboard 文档说明关注对象的 Star 等动态，不定义 Explore 排序
- `User.viewerRelevantRepositories` 正在更名为 `viewerCopilotChatRepositorySuggestions`，它服务于 Copilot Chat 的仓库建议，不是通用 Explore 推荐接口

复刻 Explore 还需要 GitHub 未公开的数据，包括完整的账号与仓库交互图、曝光和点击历史、负反馈、训练出的 embeddings、模型权重、候选召回服务、滥用控制、实验数据和最终分数。抓取 GitHub 页面或未公开接口会产生依赖登录会话且不受支持的契约。

For You 的承诺更有限：使用 GitHub 支持的数据，限制请求规模，在本地进行确定性排序，显示明确原因，不声称与 Explore 等价。

## 当前模型的限制

当前模型选择有上限、可解释的召回策略，不追求大范围或训练式个性化。

- 只推荐公开的 Search 候选仓库
- 候选召回使用有上限的 Search 计划；GitHub Search 本身受权限、超时、限流和结果数量限制，因此有效快照可能少于 60 条
- Star 只能表示偏好，无法说明你为什么 Star 某个仓库，也不能证明兴趣仍然有效
- 热度与新鲜度是有上限的公式，不是通过训练得到的个性化模型
- 当前模型不使用负反馈或点击历史
- 固定输入下排序是确定的，但 Search 结果和仓库元数据会随时间变化

## GitHub API 参考资料

以下 GitHub 文档定义了本策略依赖的受支持 API 与产品边界。

- [GitHub：发现 GitHub 上的项目](https://docs.github.com/en/get-started/exploring-projects-on-github/discovering-projects-on-github)
- [GitHub REST API：搜索仓库](https://docs.github.com/en/rest/search/search#search-repositories)
- [GitHub REST API：Starring](https://docs.github.com/en/rest/activity/starring)
- [GitHub：个人 Dashboard](https://docs.github.com/en/account-and-profile/reference/personal-dashboard)
- [GitHub GraphQL breaking changes](https://docs.github.com/en/graphql/overview/breaking-changes)
