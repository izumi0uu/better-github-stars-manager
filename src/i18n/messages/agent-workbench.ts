export type AgentWorkbenchMessages = {
  controlledElsewhere: string;
  ownerDisconnected: string;
  takeControl: string;
  takingControl: string;
  takeControlFailedOwnerConnected: string;
  takeControlFailedConflict: string;
  takeControlFailedUnavailable: string;
  takeControlFailed: string;
  takeControlSucceeded: string;
  organizeAlreadyRunning: string;
  organizeCommandFailed: string;
  receiptOriginDeleted: string;
  resolvingSubtitle: string;
  resolvingBody: string;
  resolvingHint: string;
  confirmScopeTitle: string;
  repositoriesFrozen: (count: number) => string;
  reviewBeforeApply: string;
  startAnalysis: string;
  startingAnalysis: string;
  analysisScopeIncomplete: string;
  nothingToAnalyzeBody: string;
  dismiss: string;
  continue: string;
  progressSummary: (processed: number, remaining: number, batches: number) => string;
  runProgressLabel: string;
  processed: string;
  remaining: string;
  batches: string;
  providerAttempts: string;
  analysisBlockedTitle: string;
  analysisCoverage: (processed: number, total: number) => string;
  analysisBlockedBody: (failed: number) => string;
  restartWholeLibrary: string;
  discardAnalysis: string;
  runStateRefreshed: string;
  continueRemaining: string;
  proposalSummary: (actionable: number, nonActionable: number) => string;
  proposalSelectionNote: string;
  reviewSuggestions: string;
  reviewCoverageComplete: (count: number) => string;
  reviewLoadFailedBody: string;
  proposalCounts: (actionable: number, nonActionable: number, selected: number) => string;
  selectRepository: (repositoryId: string) => string;
  applyingSelectedChanges: string;
  selectedRowsLocked: (count: number) => string;
  applying: string;
  applySelected: (count: number) => string;
  applyTagImpact: (tags: number, repositories: number) => string;
  selectAll: string;
  clear: string;
  previousPage: string;
  nextPage: string;
  reviewPageRange: (start: number, end: number, total: number) => string;
  applyingSubtitle: string;
  rowsSelectedLocked: (selected: number, total: number) => string;
  receiptPartial: (changed: number, skipped: number, failed: number) => string;
  receiptSingle: string;
  receiptComplete: (changed: number) => string;
  mutationReceipt: string;
  receiptSubtitle: string;
  receiptCountsLabel: string;
  changed: string;
  skipped: string;
  failed: string;
  unchanged: string;
  receiptCountSummary: (changed: number, skipped: number, failed: number) => string;
  unchangedCount: (count: number) => string;
  receiptRowsLabel: string;
  receiptLoadFailed: string;
  receiptLoadFailedBody: string;
  viewAllRows: string;
  viewFailedChanged: string;
  viewChanged: string;
  connectionInterrupted: string;
  workerLost: string;
  runStepsLabel: string;
  runStepScope: string;
  runStepAnalyze: string;
  runStepReview: string;
  runStepApply: string;
  runStepReceipt: string;
  reviewEvidence: string;
  reviewExistingTag: string;
  reviewNewTag: string;
  reviewOpenRepository: string;
  reviewExpandRow: string;
  reviewCollapseRow: string;
  reviewReject: string;
  reviewUndoReject: string;
  reviewRejectedWithReason: (reason: string) => string;
  reviewRejectWrongRepo: string;
  reviewRejectTooBroad: string;
  reviewRejectAlreadyCovered: string;
  reviewRejectNotUseful: string;
  reviewEditTag: string;
  reviewEditTagLabel: (repositoryId: string, tag: string) => string;
  reviewSaveEdit: string;
  reviewCancelEdit: string;
  reviewEditInvalidEmpty: string;
  reviewEditInvalidNormalized: string;
  reviewEditInvalidDuplicate: string;
  reviewEditInvalidTooLong: string;
  reviewCorrectedTo: (tag: string) => string;
  reviewNeedsReanalysis: string;
  reviewAskRevise: string;
  reviewReviseRejected: (count: number) => string;
  reviewReviseRejectedPrompt: (details: string) => string;
  reviewEditCorrectionPrompt: (repositoryId: string, fromTag: string, toTag: string) => string;
  reviewRejectCorrectionPrompt: (repositoryId: string, reason: string) => string;
  reviewLocalOnlyNote: string;
};

export const enAgentWorkbenchMessages: AgentWorkbenchMessages = {
  controlledElsewhere: "This run is controlled from another Cubby page. This page is read-only.",
  ownerDisconnected: "The page controlling this run disconnected. Take control here to keep managing it.",
  takeControl: "Take control",
  takingControl: "Taking control…",
  takeControlFailedOwnerConnected: "The controlling page reconnected, so this page stays read-only.",
  takeControlFailedConflict: "This run changed while taking control. Try again.",
  takeControlFailedUnavailable: "This run is no longer available.",
  takeControlFailed: "Could not take control. Try again.",
  takeControlSucceeded: "You now control this run.",
  organizeAlreadyRunning: "An Organize run is already in progress. Wait for it to finish, or dismiss its result before starting another.",
  organizeCommandFailed: "Cubby couldn't update this Organize run. Refresh its latest state and try again.",
  receiptOriginDeleted: "Started from a conversation that has been deleted.",
  resolvingSubtitle: "Preparing your starred library",
  resolvingBody: "This analysis includes every currently starred repository. Filters and the selected row won't narrow the scope.",
  resolvingHint: "No tags change during this step",
  confirmScopeTitle: "Confirm analysis scope",
  repositoriesFrozen: (count) => `This analysis will include ${count} repositories.`,
  reviewBeforeApply: "Analysis prepares a complete review first. No tags are changed at this step.",
  startAnalysis: "Start analysis",
  startingAnalysis: "Starting analysis",
  analysisScopeIncomplete: "The saved analysis scope is incomplete. Prepare it again.",
  nothingToAnalyzeBody: "Either every visible repo already has tags, or the active filters hide the candidates. Change filters or broaden scope, then ask again.",
  dismiss: "Dismiss",
  continue: "Continue",
  progressSummary: (processed, remaining) => `${processed} analyzed · ${remaining} remaining`,
  runProgressLabel: "Analysis progress",
  processed: "Processed",
  remaining: "Remaining",
  batches: "Batches",
  providerAttempts: "AI requests",
  analysisBlockedTitle: "Analysis paused before completion",
  analysisCoverage: (processed, total) => `${processed} of ${total} repositories analyzed`,
  analysisBlockedBody: (failed) => failed > 0
    ? `${failed} ${failed === 1 ? "repository" : "repositories"} could not be analyzed. No partial suggestions are shown or applied. Continue the failed items or restart the full-library analysis to produce one complete review.`
    : "No partial suggestions are shown or applied. Continue the remaining items or restart the full-library analysis to produce one complete review.",
  restartWholeLibrary: "Restart full-library analysis",
  discardAnalysis: "Discard this analysis",
  runStateRefreshed: "The saved analysis state changed. Its latest progress has been restored; try continuing again or restart the full-library analysis.",
  continueRemaining: "Continue remaining",
  proposalSummary: (actionable, nonActionable) => `Cubby found ${actionable} tag suggestions. ${nonActionable} repositories need no changes or lack enough evidence.`,
  proposalSelectionNote: "Only selected suggestions will become manual tags.",
  reviewSuggestions: "Review tag suggestions",
  reviewCoverageComplete: (count) => `Full library covered · ${count} repositories analyzed`,
  reviewLoadFailedBody: "The analysis is complete, but its suggestions could not be loaded. Retry without rerunning the analysis.",
  proposalCounts: (actionable, nonActionable, selected) => `${actionable} suggestions · ${nonActionable} no change · ${selected} selected`,
  selectRepository: (repositoryId) => `Select ${repositoryId}`,
  applyingSelectedChanges: "Applying selected changes",
  selectedRowsLocked: (count) => `${count} selected · selection locked`,
  applying: "Applying…",
  applySelected: (count) => `Apply ${count} selected`,
  applyTagImpact: (tags, repositories) => `Apply ${tags} ${tags === 1 ? 'tag' : 'tags'} to ${repositories} ${repositories === 1 ? 'repository' : 'repositories'}`,
  selectAll: "Select all",
  clear: "Clear",
  previousPage: "Previous page",
  nextPage: "Next page",
  reviewPageRange: (start, end, total) => `${start}-${end} of ${total}`,
  applyingSubtitle: "Manual tags · scope remains locked",
  rowsSelectedLocked: (selected, total) => `${selected} of ${total} selected · selection locked`,
  receiptPartial: (changed, skipped, failed) => `${changed} applied. ${skipped} skipped. ${failed} no longer met the required conditions and were left unchanged.`,
  receiptSingle: "Applied the selected suggestion as a manual tag. Nothing was pushed to Gist.",
  receiptComplete: (changed) => `Applied ${changed} selected suggestions as manual tags. Nothing was pushed to Gist.`,
  mutationReceipt: "Tag update results",
  receiptSubtitle: "Final result · local manual tags · Gist not pushed",
  receiptCountsLabel: "Result totals",
  changed: "Changed",
  skipped: "Skipped",
  failed: "Failed",
  unchanged: "Unchanged",
  receiptCountSummary: (changed, skipped, failed) => `${changed} changed · ${skipped} skipped · ${failed} failed`,
  unchangedCount: (count) => `${count} unchanged`,
  receiptRowsLabel: "Result details",
  receiptLoadFailed: "Could not load result details",
  receiptLoadFailedBody: "The tag updates are complete. Retry loading the details, or dismiss these results.",
  viewAllRows: "View all results",
  viewFailedChanged: "View failed & changed",
  viewChanged: "View changed",
  connectionInterrupted: "Cubby connection was interrupted. Reconnecting…",
  workerLost: "The extension restarted, so this analysis can no longer continue. Start a new analysis.",
  runStepsLabel: "Cubby analysis steps",
  runStepScope: "Scope",
  runStepAnalyze: "Analyze",
  runStepReview: "Review",
  runStepApply: "Apply",
  runStepReceipt: "Results",
  reviewEvidence: "Evidence",
  reviewExistingTag: "Existing",
  reviewNewTag: "New",
  reviewOpenRepository: "Open repository on GitHub",
  reviewExpandRow: "Show review details",
  reviewCollapseRow: "Hide review details",
  reviewReject: "Reject",
  reviewUndoReject: "Undo reject",
  reviewRejectedWithReason: (reason) => `Rejected · ${reason}`,
  reviewRejectWrongRepo: "Wrong repository",
  reviewRejectTooBroad: "Tag too broad",
  reviewRejectAlreadyCovered: "Already covered",
  reviewRejectNotUseful: "Not useful",
  reviewEditTag: "Edit tag",
  reviewEditTagLabel: (repositoryId, tag) => `Edit tag ${tag} for ${repositoryId}`,
  reviewSaveEdit: "Save correction",
  reviewCancelEdit: "Cancel edit",
  reviewEditInvalidEmpty: "Enter a non-empty tag.",
  reviewEditInvalidNormalized: "This tag contains unsupported character variants.",
  reviewEditInvalidDuplicate: "Tag duplicates another action on this row.",
  reviewEditInvalidTooLong: "Tag is too long.",
  reviewCorrectedTo: (tag) => `Corrected to ${tag}`,
  reviewNeedsReanalysis: "Needs re-analysis before apply",
  reviewAskRevise: "Ask to revise",
  reviewReviseRejected: (count) => `Ask to revise rejected (${count})`,
  reviewReviseRejectedPrompt: (details) => `Revise this tag review before any apply. Keep the frozen scope unchanged, skip rejected rows, and re-analyze only the corrected intent. Rejections/corrections:\n${details}`,
  reviewEditCorrectionPrompt: (repositoryId, fromTag, toTag) => `For ${repositoryId}, do not apply the reviewed tag "${fromTag}". Re-analyze that repository with the corrected tag intent "${toTag}" and return a fresh review row before any apply.`,
  reviewRejectCorrectionPrompt: (repositoryId, reason) => `For ${repositoryId}, reject the current suggestion (${reason}). Re-analyze that repository with this correction in mind and return a fresh review row before any apply.`,
  reviewLocalOnlyNote: "Edits and rejections stay in this review. Only selected suggestions are applied.",
};

export const zhAgentWorkbenchMessages: AgentWorkbenchMessages = {
  controlledElsewhere: "本次任务正由另一个 Cubby 页面控制，本页面为只读。",
  ownerDisconnected: "控制本次任务的页面已断开连接。可在本页面接管并继续管理。",
  takeControl: "接管控制",
  takingControl: "正在接管…",
  takeControlFailedOwnerConnected: "原控制页面已重新连接，本页面保持只读。",
  takeControlFailedConflict: "接管期间任务状态已变化，请重试。",
  takeControlFailedUnavailable: "该任务已不可用。",
  takeControlFailed: "暂时无法接管，请重试。",
  takeControlSucceeded: "你已接管本次任务。",
  organizeAlreadyRunning: "已有整理任务正在进行。请等待其完成，或先关闭其结果，再开始新的整理。",
  organizeCommandFailed: "Cubby 无法更新本次整理任务。请刷新最新状态后重试。",
  receiptOriginDeleted: "该结果来自一个已删除的对话。",
  resolvingSubtitle: "正在准备你的星标资料库",
  resolvingBody: "本次分析会包含全部仍在星标的仓库。筛选条件和当前选中行都不会缩小范围。",
  resolvingHint: "此步骤不会修改标签",
  confirmScopeTitle: "确认分析范围",
  repositoriesFrozen: (count) => `将分析 ${count} 个仓库。`,
  reviewBeforeApply: "分析完成后会先生成一次完整审阅；此步骤不会修改标签。",
  startAnalysis: "开始分析",
  startingAnalysis: "正在启动分析",
  analysisScopeIncomplete: "已保存的分析范围不完整，请重新准备后再试。",
  nothingToAnalyzeBody: "可见仓库可能都已有标签，或当前筛选隐藏了候选项。请调整筛选或扩大范围后重试。",
  dismiss: "关闭",
  continue: "继续",
  progressSummary: (processed, remaining) => `已分析 ${processed} · 剩余 ${remaining}`,
  runProgressLabel: "分析进度",
  processed: "已处理",
  remaining: "剩余",
  batches: "批次",
  providerAttempts: "AI 请求",
  analysisBlockedTitle: "分析未完成，已暂停",
  analysisCoverage: (processed, total) => `已分析 ${processed} / ${total} 个仓库`,
  analysisBlockedBody: (failed) => failed > 0
    ? `${failed} 个仓库分析失败。不会展示或应用部分建议；可以继续处理失败项，或重新分析整个资料库，以生成一次完整审阅。`
    : "不会展示或应用部分建议。可以继续处理剩余项，或重新分析整个资料库，以生成一次完整审阅。",
  restartWholeLibrary: "重新分析整个资料库",
  discardAnalysis: "放弃本次分析",
  runStateRefreshed: "已恢复最新的分析进度。请再次继续，或重新分析整个资料库。",
  continueRemaining: "继续处理剩余项",
  proposalSummary: (actionable, nonActionable) => `Cubby 找到了 ${actionable} 条标签建议。另有 ${nonActionable} 个仓库无需变更或证据不足。`,
  proposalSelectionNote: "只有选中的建议会写入手动标签。",
  reviewSuggestions: "审阅标签建议",
  reviewCoverageComplete: (count) => `已覆盖完整资料库 · 已分析 ${count} 个仓库`,
  reviewLoadFailedBody: "分析已完成，但建议暂时无法加载。可以直接重试，无需重新分析。",
  proposalCounts: (actionable, nonActionable, selected) => `${actionable} 条建议 · ${nonActionable} 个无需变更 · 已选择 ${selected} 条`,
  selectRepository: (repositoryId) => `选择 ${repositoryId}`,
  applyingSelectedChanges: "正在应用所选变更",
  selectedRowsLocked: (count) => `已选择 ${count} 项 · 选择已锁定`,
  applying: "正在应用…",
  applySelected: (count) => `应用所选 ${count} 项`,
  applyTagImpact: (tags, repositories) => `将 ${tags} 个标签应用到 ${repositories} 个仓库`,
  selectAll: "全选",
  clear: "清除",
  previousPage: "上一页",
  nextPage: "下一页",
  reviewPageRange: (start, end, total) => `${start}-${end} / ${total}`,
  applyingSubtitle: "手动标签 · 范围仍保持锁定",
  rowsSelectedLocked: (selected, total) => `已选择 ${selected} / ${total} 项 · 选择已锁定`,
  receiptPartial: (changed, skipped, failed) => `已应用 ${changed} 项，跳过 ${skipped} 项；${failed} 项不再满足所需条件，因此保持不变。`,
  receiptSingle: "已将所选建议应用为手动标签，未推送到 Gist。",
  receiptComplete: (changed) => `已将所选 ${changed} 条建议应用为手动标签，未推送到 Gist。`,
  mutationReceipt: "标签更新结果",
  receiptSubtitle: "最终结果 · 本地手动标签 · 未推送 Gist",
  receiptCountsLabel: "结果统计",
  changed: "已变更",
  skipped: "已跳过",
  failed: "失败",
  unchanged: "未变化",
  receiptCountSummary: (changed, skipped, failed) => `已变更 ${changed} · 已跳过 ${skipped} · 失败 ${failed}`,
  unchangedCount: (count) => `${count} 项未变化`,
  receiptRowsLabel: "结果详情",
  receiptLoadFailed: "无法加载结果详情",
  receiptLoadFailedBody: "标签更新已经完成。可以重试加载详情，或关闭本次结果。",
  viewAllRows: "查看全部结果",
  viewFailedChanged: "查看失败和已变更项",
  viewChanged: "查看已变更项",
  connectionInterrupted: "Cubby 连接已中断，正在重新连接…",
  workerLost: "扩展已重启，本次分析无法继续。请开始新的分析。",
  runStepsLabel: "Cubby 分析步骤",
  runStepScope: "范围",
  runStepAnalyze: "分析",
  runStepReview: "审阅",
  runStepApply: "应用",
  runStepReceipt: "结果",
  reviewEvidence: "证据",
  reviewExistingTag: "已有",
  reviewNewTag: "新建",
  reviewOpenRepository: "在 GitHub 打开仓库",
  reviewExpandRow: "展开审阅细节",
  reviewCollapseRow: "收起审阅细节",
  reviewReject: "拒绝",
  reviewUndoReject: "撤销拒绝",
  reviewRejectedWithReason: (reason) => `已拒绝 · ${reason}`,
  reviewRejectWrongRepo: "仓库不匹配",
  reviewRejectTooBroad: "标签过宽",
  reviewRejectAlreadyCovered: "已被覆盖",
  reviewRejectNotUseful: "价值不高",
  reviewEditTag: "编辑标签",
  reviewEditTagLabel: (repositoryId, tag) => `编辑 ${repositoryId} 的标签 ${tag}`,
  reviewSaveEdit: "保存修正",
  reviewCancelEdit: "取消编辑",
  reviewEditInvalidEmpty: "请输入非空标签。",
  reviewEditInvalidNormalized: "这个标签包含不受支持的字符变体。",
  reviewEditInvalidDuplicate: "标签与这条建议中的其他操作重复。",
  reviewEditInvalidTooLong: "标签过长。",
  reviewCorrectedTo: (tag) => `已修正为 ${tag}`,
  reviewNeedsReanalysis: "需重新分析后才能应用",
  reviewAskRevise: "要求修正",
  reviewReviseRejected: (count) => `要求修正已拒绝项（${count}）`,
  reviewReviseRejectedPrompt: (details) => `请在任何应用前修正这次标签审阅。保持冻结范围不变，跳过已拒绝行，只按修正后的意图重新分析。拒绝/修正：\n${details}`,
  reviewEditCorrectionPrompt: (repositoryId, fromTag, toTag) => `对于 ${repositoryId}，不要应用已审阅标签「${fromTag}」。请按修正后的标签意图「${toTag}」重新分析该仓库，并在任何应用前返回新的审阅行。`,
  reviewRejectCorrectionPrompt: (repositoryId, reason) => `对于 ${repositoryId}，拒绝当前建议（${reason}）。请带着这个修正重新分析该仓库，并在任何应用前返回新的审阅行。`,
  reviewLocalOnlyNote: "编辑和拒绝只影响本次审阅，最终只会应用选中的建议。",
};
