import type { Locale } from '@/types';
import type { AgentDiagnosticFinding } from './diagnostic-report';

export interface AgentDiagnosticsMessages {
  openAgentDiagnostics: string;
  title: string;
  provider: string;
  providerDebug: string;
  providerDebugNotice: string;
  refreshProvider: string;
  loadingProvider: string;
  providerLoadFailed: (error: string) => string;
  providerService: string;
  providerModel: string;
  providerProtocol: string;
  providerEndpoint: string;
  providerCredential: string;
  providerCredentialSaved: string;
  providerCredentialMissing: string;
  providerHostAccess: string;
  providerHostAccessBuiltIn: string;
  providerHostAccessGranted: string;
  providerHostAccessRequired: string;
  checkingProviderHostAccess: string;
  grantProviderHostAccess: string;
  grantingProviderHostAccess: string;
  providerHostAccessFailed: (error: string) => string;
  providerDeclaredContext: string;
  providerWorkingContext: string;
  providerCapability: string;
  providerCapabilitySource: string;
  providerCapabilityMissing: string;
  providerVerifiedAt: string;
  providerFingerprint: string;
  notConfigured: string;
  testSavedProvider: string;
  testingProvider: string;
  providerTestSucceeded: (provider: string, model: string, latencyMs: number) => string;
  providerTestFailed: (error: string) => string;
  providerFailurePhase: string;
  providerFailureCode: string;
  providerFailureStatus: string;
  localAgentBridge: string;
  localAgentBridgeNotice: string;
  shareProviderDiagnostics: string;
  sharingProviderDiagnostics: string;
  stopSharingProviderDiagnostics: string;
  stoppingProviderDiagnostics: string;
  providerDiagnosticsSharedUntil: (expiresAt: string) => string;
  providerDiagnosticsShareFailed: (error: string) => string;
  sharedProviderDiagnostics: string;
  refreshSharedProviderDiagnostics: string;
  loadingSharedProviderDiagnostics: string;
  noSharedProviderDiagnostics: string;
  sharedProviderDiagnosticsFailed: (error: string) => string;
  providerMonitorEvents: string;
  providerMonitorLatestEvent: string;
  providerMonitorRecentEvents: string;
  providerMonitorNoEvents: string;
  developmentBuild: (hash: string) => string;
  standaloneViewer: string;
  openingImportedArtifact: string;
  importedArtifact: (count: number) => string;
  connectingTraceRecorder: string;
  loadingTraceEvidence: string;
  retainedOperations: (count: number) => string;
  importTraceArtifact: string;
  returnToLiveTraces: string;
  export: string;
  allRetained: string;
  selectedSession: string;
  selectedOperation: string;
  refreshTraces: string;
  exportTraces: string;
  clearLocalTraces: string;
  viewsLabel: string;
  analysis: string;
  deterministicAnalysis: string;
  analysisNotice: string;
  analysisScope: string;
  allOperations: string;
  currentOperation: string;
  copyAgentReport: string;
  downloadAgentReport: string;
  agentReportCopied: string;
  agentReportCopyFailed: string;
  health: string;
  healthy: string;
  active: string;
  degraded: string;
  failed: string;
  errors: string;
  warnings: string;
  providerRequests: string;
  contextReductions: string;
  toolCalls: string;
  findings: string;
  noFindings: string;
  inspectEvidence: string;
  noProviderRequests: string;
  requestKind: string;
  rootOperation: string;
  providerClass: string;
  capabilityRevision: string;
  requestAttempt: string;
  providerStep: string;
  providerState: string;
  requestSize: string;
  historySize: string;
  estimatedInput: string;
  outputReserve: string;
  workingWindow: string;
  preflightDecision: string;
  preflightReason: string;
  firstResponse: string;
  totalDuration: string;
  streamItems: string;
  streamBytes: string;
  usage: string;
  finishReason: string;
  providerError: string;
  httpStatus: string;
  retryable: string;
  overflow: string;
  contextActivity: string;
  noContextActivity: string;
  toolLifecycle: string;
  noToolCalls: string;
  authorization: string;
  toolClass: string;
  risk: string;
  resultReduction: string;
  admittedResult: string;
  toolOutcome: string;
  writeOutcome: string;
  agentReadableReport: string;
  agentReadableReportNotice: string;
  reportOmitted: (count: number) => string;
  yes: string;
  no: string;
  traces: string;
  scenarioLab: string;
  rawCapture: string;
  rawCaptureNotice: string;
  rawNotArmed: string;
  rawLoadingExclusions: string;
  rawArmed: (captureId: string | null) => string;
  rawCapturing: (rootOperationId: string | null) => string;
  rawCompleted: (rootOperationId: string | null) => string;
  captureNextRun: string;
  disarm: string;
  droppedEvents: (count: number, bytes: number, reason: string) => string;
  operations: string;
  noOperations: string;
  timeline: string;
  eventType: string;
  allEvents: string;
  selectOperation: string;
  details: string;
  sequence: string;
  span: string;
  state: string;
  events: string;
  firstSequence: string;
  lastSequence: string;
  noOperationSelected: string;
  scenario: string;
  delay: string;
  contextWindow: string;
  ready: string;
  connecting: string;
  running: string;
  completed: string;
  runScenario: string;
  artifactWorkerFailed: string;
  evidenceRequestFailed: (code: string) => string;
  evidenceIntegrityFailed: string;
  exportRequestFailed: (code: string) => string;
  exportIntegrityFailed: string;
  exportFinalizeFailed: string;
  rawCaptureRequestFailed: (code: string) => string;
  scenarioRequestFailed: (code: string) => string;
  exportConnectionClosed: string;
  connectionClosed: string;
  clearTraceConfirmation: string;
  selectExportScope: string;
  waitForExport: string;
  artifactTooLarge: string;
  scenarioControlNotReady: string;
  rawCaptureControlNotReady: string;
}

const messages: Record<Locale, AgentDiagnosticsMessages> = {
  en: {
    openAgentDiagnostics: 'Open Agent Diagnostics',
    title: 'Agent Diagnostics',
    provider: 'Provider',
    providerDebug: 'Provider Debug',
    providerDebugNotice:
      'Shows the saved Provider configuration without exposing the API key. Tests use the saved encrypted key and record the verified capability.',
    refreshProvider: 'Refresh Provider settings',
    loadingProvider: 'Loading saved Provider settings...',
    providerLoadFailed: (error) => `Could not load Provider settings: ${error}`,
    providerService: 'Service',
    providerModel: 'Model',
    providerProtocol: 'Protocol',
    providerEndpoint: 'Completion endpoint',
    providerCredential: 'API key',
    providerCredentialSaved: 'Saved (never displayed)',
    providerCredentialMissing: 'Not saved',
    providerHostAccess: 'Host access',
    providerHostAccessBuiltIn: 'Built-in service access',
    providerHostAccessGranted: 'Granted for this origin',
    providerHostAccessRequired: 'Required for this origin',
    checkingProviderHostAccess: 'Checking...',
    grantProviderHostAccess: 'Grant host access',
    grantingProviderHostAccess: 'Granting access...',
    providerHostAccessFailed: (error) => `Could not grant host access: ${error}`,
    providerDeclaredContext: 'Declared context window',
    providerWorkingContext: 'Working context window',
    providerCapability: 'Verified context window',
    providerCapabilitySource: 'Capability source',
    providerCapabilityMissing: 'No successful connection probe has been recorded.',
    providerVerifiedAt: 'Verified at',
    providerFingerprint: 'Provider fingerprint',
    notConfigured: 'Not configured',
    testSavedProvider: 'Test saved Provider',
    testingProvider: 'Testing Provider...',
    providerTestSucceeded: (provider, model, latencyMs) =>
      `Connected to ${provider} · ${model} (${latencyMs} ms)`,
    providerTestFailed: (error) => `Provider test failed: ${error}`,
    providerFailurePhase: 'Failure phase',
    providerFailureCode: 'Error code',
    providerFailureStatus: 'HTTP status',
    localAgentBridge: 'Local Agent bridge',
    localAgentBridgeNotice:
      'Starts a 15-minute, bounded Provider monitor on the loopback development server. Credentials, chat content, raw capture and Provider response content are excluded.',
    shareProviderDiagnostics: 'Start monitoring',
    sharingProviderDiagnostics: 'Starting monitor...',
    stopSharingProviderDiagnostics: 'Stop monitoring',
    stoppingProviderDiagnostics: 'Stopping monitor...',
    providerDiagnosticsSharedUntil: (expiresAt) => `Local Agents can monitor until ${expiresAt}`,
    providerDiagnosticsShareFailed: (error) => `Could not update the local Provider monitor: ${error}`,
    sharedProviderDiagnostics: 'Provider monitor',
    refreshSharedProviderDiagnostics: 'Refresh Provider monitor',
    loadingSharedProviderDiagnostics: 'Loading Provider monitor...',
    noSharedProviderDiagnostics: 'No Provider monitor is currently active.',
    sharedProviderDiagnosticsFailed: (error) => `Could not read Provider monitor: ${error}`,
    providerMonitorEvents: 'Events',
    providerMonitorLatestEvent: 'Latest event',
    providerMonitorRecentEvents: 'Recent events',
    providerMonitorNoEvents: 'No monitor events have been received.',
    developmentBuild: (hash) => `Development build ${hash}`,
    standaloneViewer: 'Standalone read-only artifact viewer',
    openingImportedArtifact: 'Opening imported artifact...',
    importedArtifact: (count) => `Read-only imported artifact · ${count} operation(s)`,
    connectingTraceRecorder: 'Connecting to development trace recorder...',
    loadingTraceEvidence: 'Loading retained trace evidence...',
    retainedOperations: (count) => `${count} retained operation(s)`,
    importTraceArtifact: 'Import trace artifact',
    returnToLiveTraces: 'Return to live traces',
    export: 'Export',
    allRetained: 'All retained',
    selectedSession: 'Selected session',
    selectedOperation: 'Selected operation',
    refreshTraces: 'Refresh traces',
    exportTraces: 'Export traces',
    clearLocalTraces: 'Clear local traces',
    viewsLabel: 'Agent diagnostics views',
    analysis: 'Analysis',
    deterministicAnalysis: 'Deterministic analysis',
    analysisNotice:
      'Derived from bounded, redacted Service Worker trace events. Findings link back to retained evidence; raw capture and credentials are excluded.',
    analysisScope: 'Scope',
    allOperations: 'All operations',
    currentOperation: 'Selected operation',
    copyAgentReport: 'Copy Agent-readable report',
    downloadAgentReport: 'Download Agent-readable report',
    agentReportCopied: 'Agent-readable report copied.',
    agentReportCopyFailed: 'Could not copy the Agent-readable report.',
    health: 'Health',
    healthy: 'Healthy',
    active: 'Active',
    degraded: 'Degraded',
    failed: 'Failed',
    errors: 'Errors',
    warnings: 'Warnings',
    providerRequests: 'Provider requests',
    contextReductions: 'Context reductions',
    toolCalls: 'Tool calls',
    findings: 'Findings',
    noFindings: 'No deterministic issue was found in the retained scope.',
    inspectEvidence: 'Inspect evidence',
    noProviderRequests: 'No Provider request was recorded in this scope.',
    requestKind: 'Request kind',
    rootOperation: 'Root operation',
    providerClass: 'Provider class',
    capabilityRevision: 'Capability revision',
    requestAttempt: 'Attempt',
    providerStep: 'Provider step',
    providerState: 'State',
    requestSize: 'Request bytes',
    historySize: 'History bytes',
    estimatedInput: 'Estimated input tokens',
    outputReserve: 'Max output tokens',
    workingWindow: 'Working window',
    preflightDecision: 'Preflight',
    preflightReason: 'Preflight reason',
    firstResponse: 'First response',
    totalDuration: 'Total duration',
    streamItems: 'Stream items',
    streamBytes: 'Stream bytes',
    usage: 'Usage (input / output / total)',
    finishReason: 'Finish reason',
    providerError: 'Error code',
    httpStatus: 'HTTP status',
    retryable: 'Retryable',
    overflow: 'Overflow',
    contextActivity: 'Context and continuation activity',
    noContextActivity: 'No context reduction, continuation, or watchdog activity was recorded.',
    toolLifecycle: 'Tool lifecycle',
    noToolCalls: 'No tool call was recorded in this scope.',
    authorization: 'Authorization',
    toolClass: 'Tool class',
    risk: 'Risk',
    resultReduction: 'Result reduction',
    admittedResult: 'Result bytes (admitted / original)',
    toolOutcome: 'Tool outcome',
    writeOutcome: 'Write outcome',
    agentReadableReport: 'Agent-readable report',
    agentReadableReportNotice:
      'External agents can inspect this stable JSON in the page DOM or use the copy/download actions. Omitted counts are explicit; use the full trace export when deeper evidence is required.',
    reportOmitted: (count) => `${count} additional item(s) omitted from this bounded report.`,
    yes: 'Yes',
    no: 'No',
    traces: 'Traces',
    scenarioLab: 'Scenario Lab',
    rawCapture: 'One-shot raw capture',
    rawCaptureNotice:
      'Raw capture may display repository code and private notes. Codex or browser automation can inspect this page-memory content. BGSM excludes and scrubs configured API keys, GitHub tokens, authorization and cookie values, and Provider headers, but arbitrary user-authored text may still contain an unrecognized secret.',
    rawNotArmed: 'Not armed',
    rawLoadingExclusions: 'Loading configured credential exclusions...',
    rawArmed: (captureId) => `Armed for the next real Agent run (${captureId})`,
    rawCapturing: (rootOperationId) => `Capturing ${rootOperationId ?? 'Agent run'}`,
    rawCompleted: (rootOperationId) => `Capture completed for ${rootOperationId ?? 'Agent run'}`,
    captureNextRun: 'Capture next run',
    disarm: 'Disarm',
    droppedEvents: (count, bytes, reason) => `${count} event(s), ${bytes} byte(s), ${reason}`,
    operations: 'Operations',
    noOperations: 'No Agent operation has been recorded in this development build.',
    timeline: 'Timeline',
    eventType: 'Event type',
    allEvents: 'All events',
    selectOperation: 'Select an operation to inspect its events.',
    details: 'Details',
    sequence: 'Sequence',
    span: 'Span',
    state: 'State',
    events: 'Events',
    firstSequence: 'First sequence',
    lastSequence: 'Last sequence',
    noOperationSelected: 'No operation selected.',
    scenario: 'Scenario',
    delay: 'Delay (ms)',
    contextWindow: 'Context window',
    ready: 'Ready',
    connecting: 'Connecting',
    running: 'Running',
    completed: 'Completed',
    runScenario: 'Run scenario',
    artifactWorkerFailed: 'Artifact worker failed.',
    evidenceRequestFailed: (code) => `Evidence request failed: ${code}`,
    evidenceIntegrityFailed: 'Evidence transfer failed integrity checks.',
    exportRequestFailed: (code) => `Export request failed: ${code}`,
    exportIntegrityFailed: 'Export transfer failed integrity checks.',
    exportFinalizeFailed: 'Export stream could not be finalized.',
    rawCaptureRequestFailed: (code) => `Raw capture request failed: ${code}`,
    scenarioRequestFailed: (code) => `Scenario request failed: ${code}`,
    exportConnectionClosed: 'Export connection closed before the artifact was complete.',
    connectionClosed: 'Diagnostics connection closed. Reload this page to reconnect.',
    clearTraceConfirmation: 'Clear all local Agent diagnostic traces?',
    selectExportScope: 'Select an operation with the requested scope.',
    waitForExport: 'Wait for the current export to finish before importing an artifact.',
    artifactTooLarge: 'too_large: Trace artifact exceeds the size limit.',
    scenarioControlNotReady: 'Scenario control connection is not ready.',
    rawCaptureControlNotReady: 'Raw capture control connection is not ready.',
  },
  'zh-CN': {
    openAgentDiagnostics: '打开 Agent 诊断',
    title: 'Agent 诊断',
    provider: 'Provider',
    providerDebug: 'Provider 调试',
    providerDebugNotice:
      '显示已保存的 Provider 配置，但不会暴露 API Key。测试只使用已保存的加密 Key，并记录验证后的能力信息。',
    refreshProvider: '刷新 Provider 设置',
    loadingProvider: '正在加载已保存的 Provider 设置...',
    providerLoadFailed: (error) => `无法加载 Provider 设置: ${error}`,
    providerService: '服务',
    providerModel: '模型',
    providerProtocol: '协议',
    providerEndpoint: '补全端点',
    providerCredential: 'API Key',
    providerCredentialSaved: '已保存（不会显示）',
    providerCredentialMissing: '未保存',
    providerHostAccess: 'Host 访问权限',
    providerHostAccessBuiltIn: '内置服务访问权限',
    providerHostAccessGranted: '已授予此 origin',
    providerHostAccessRequired: '需要授予此 origin',
    checkingProviderHostAccess: '检查中...',
    grantProviderHostAccess: '授予 Host 访问权限',
    grantingProviderHostAccess: '正在授予访问权限...',
    providerHostAccessFailed: (error) => `无法授予 Host 访问权限: ${error}`,
    providerDeclaredContext: '声明的上下文窗口',
    providerWorkingContext: '工作上下文窗口',
    providerCapability: '已验证上下文窗口',
    providerCapabilitySource: '能力来源',
    providerCapabilityMissing: '尚未记录成功的连接探针。',
    providerVerifiedAt: '验证时间',
    providerFingerprint: 'Provider 指纹',
    notConfigured: '未配置',
    testSavedProvider: '测试已保存的 Provider',
    testingProvider: '正在测试 Provider...',
    providerTestSucceeded: (provider, model, latencyMs) =>
      `已连接 ${provider} · ${model} (${latencyMs} ms)`,
    providerTestFailed: (error) => `Provider 测试失败: ${error}`,
    providerFailurePhase: '失败阶段',
    providerFailureCode: '错误码',
    providerFailureStatus: 'HTTP 状态',
    localAgentBridge: '本机 Agent 桥接',
    localAgentBridgeNotice:
      '启动一个保留 15 分钟的有界 Provider 监控，并将事件发送到回环开发服务器。不会包含凭据、聊天内容、原始捕获或 Provider 响应内容。',
    shareProviderDiagnostics: '开始监控',
    sharingProviderDiagnostics: '正在启动监控...',
    stopSharingProviderDiagnostics: '停止监控',
    stoppingProviderDiagnostics: '正在停止监控...',
    providerDiagnosticsSharedUntil: (expiresAt) => `本机 Agent 可监控至 ${expiresAt}`,
    providerDiagnosticsShareFailed: (error) => `无法更新本机 Provider 监控: ${error}`,
    sharedProviderDiagnostics: 'Provider 监控',
    refreshSharedProviderDiagnostics: '刷新 Provider 监控',
    loadingSharedProviderDiagnostics: '正在加载 Provider 监控...',
    noSharedProviderDiagnostics: '当前没有启用 Provider 监控。',
    sharedProviderDiagnosticsFailed: (error) => `无法读取 Provider 监控: ${error}`,
    providerMonitorEvents: '事件数',
    providerMonitorLatestEvent: '最新事件',
    providerMonitorRecentEvents: '最近事件',
    providerMonitorNoEvents: '尚未收到监控事件。',
    developmentBuild: (hash) => `开发构建 ${hash}`,
    standaloneViewer: '独立只读诊断文件查看器',
    openingImportedArtifact: '正在打开导入的诊断文件...',
    importedArtifact: (count) => `只读导入诊断文件 · ${count} 个操作`,
    connectingTraceRecorder: '正在连接开发跟踪记录器...',
    loadingTraceEvidence: '正在加载保留的跟踪证据...',
    retainedOperations: (count) => `${count} 个保留操作`,
    importTraceArtifact: '导入跟踪文件',
    returnToLiveTraces: '返回实时跟踪',
    export: '导出',
    allRetained: '所有保留记录',
    selectedSession: '所选会话',
    selectedOperation: '所选操作',
    refreshTraces: '刷新跟踪',
    exportTraces: '导出跟踪',
    clearLocalTraces: '清除本地跟踪',
    viewsLabel: 'Agent 诊断视图',
    analysis: '分析',
    deterministicAnalysis: '确定性分析',
    analysisNotice:
      '根据 Service Worker 中有界、已脱敏的跟踪事件生成。每项问题都可返回保留证据；原始捕获和凭据不会包含在内。',
    analysisScope: '范围',
    allOperations: '所有操作',
    currentOperation: '所选操作',
    copyAgentReport: '复制 Agent 可读报告',
    downloadAgentReport: '下载 Agent 可读报告',
    agentReportCopied: '已复制 Agent 可读报告。',
    agentReportCopyFailed: '无法复制 Agent 可读报告。',
    health: '健康状态',
    healthy: '正常',
    active: '运行中',
    degraded: '需要关注',
    failed: '失败',
    errors: '错误',
    warnings: '警告',
    providerRequests: 'Provider 请求',
    contextReductions: '上下文压缩',
    toolCalls: '工具调用',
    findings: '问题',
    noFindings: '当前保留范围内没有发现确定性问题。',
    inspectEvidence: '检查证据',
    noProviderRequests: '当前范围内没有记录 Provider 请求。',
    requestKind: '请求类型',
    rootOperation: '根操作',
    providerClass: 'Provider 类型',
    capabilityRevision: '能力版本',
    requestAttempt: '尝试次数',
    providerStep: 'Provider 步骤',
    providerState: '状态',
    requestSize: '请求字节数',
    historySize: '历史字节数',
    estimatedInput: '估算输入 Token',
    outputReserve: '最大输出 Token',
    workingWindow: '工作上下文窗口',
    preflightDecision: '预检决定',
    preflightReason: '预检原因',
    firstResponse: '首包耗时',
    totalDuration: '总耗时',
    streamItems: '流事件数',
    streamBytes: '流字节数',
    usage: '用量（输入 / 输出 / 总计）',
    finishReason: '结束原因',
    providerError: '错误代码',
    httpStatus: 'HTTP 状态',
    retryable: '可重试',
    overflow: '上下文溢出',
    contextActivity: '上下文与继续执行活动',
    noContextActivity: '没有记录上下文压缩、继续执行或 watchdog 活动。',
    toolLifecycle: '工具生命周期',
    noToolCalls: '当前范围内没有记录工具调用。',
    authorization: '授权决定',
    toolClass: '工具类型',
    risk: '风险等级',
    resultReduction: '结果裁剪',
    admittedResult: '结果字节数（采用 / 原始）',
    toolOutcome: '工具结果',
    writeOutcome: '写入结果',
    agentReadableReport: 'Agent 可读报告',
    agentReadableReportNotice:
      '外部 Agent 可以从页面 DOM 读取这份稳定 JSON，也可以使用复制或下载操作。报告会明确标注省略数量；需要更深证据时请使用完整跟踪导出。',
    reportOmitted: (count) => `这份有界报告还省略了 ${count} 项。`,
    yes: '是',
    no: '否',
    traces: '跟踪',
    scenarioLab: '场景实验室',
    rawCapture: '单次原始捕获',
    rawCaptureNotice:
      '原始捕获可能显示仓库代码和私密笔记。Codex 或浏览器自动化可以读取这部分页面内存内容。BGSM 会排除并清理已配置的 API Key、GitHub token、授权和 Cookie 值以及 Provider 请求头，但任意用户编写的文本仍可能包含未被识别的密钥。',
    rawNotArmed: '未启用',
    rawLoadingExclusions: '正在加载已配置的凭据排除规则...',
    rawArmed: (captureId) => `已为下一次真实 Agent 运行启用捕获 (${captureId})`,
    rawCapturing: (rootOperationId) => `正在捕获 ${rootOperationId ?? 'Agent 运行'}`,
    rawCompleted: (rootOperationId) => `已完成 ${rootOperationId ?? 'Agent 运行'} 的捕获`,
    captureNextRun: '捕获下一次运行',
    disarm: '停用捕获',
    droppedEvents: (count, bytes, reason) => `${count} 个事件，${bytes} 字节，${reason}`,
    operations: '操作',
    noOperations: '此开发构建尚未记录任何 Agent 操作。',
    timeline: '时间线',
    eventType: '事件类型',
    allEvents: '所有事件',
    selectOperation: '选择一个操作以检查其事件。',
    details: '详情',
    sequence: '序号',
    span: 'Span',
    state: '状态',
    events: '事件',
    firstSequence: '首个序号',
    lastSequence: '最后序号',
    noOperationSelected: '未选择操作。',
    scenario: '场景',
    delay: '延迟 (ms)',
    contextWindow: '上下文窗口',
    ready: '就绪',
    connecting: '连接中',
    running: '运行中',
    completed: '已完成',
    runScenario: '运行场景',
    artifactWorkerFailed: '诊断文件处理器失败。',
    evidenceRequestFailed: (code) => `获取证据失败: ${code}`,
    evidenceIntegrityFailed: '证据传输未通过完整性校验。',
    exportRequestFailed: (code) => `导出请求失败: ${code}`,
    exportIntegrityFailed: '导出传输未通过完整性校验。',
    exportFinalizeFailed: '无法完成导出流。',
    rawCaptureRequestFailed: (code) => `原始捕获请求失败: ${code}`,
    scenarioRequestFailed: (code) => `场景请求失败: ${code}`,
    exportConnectionClosed: '诊断文件完成前，导出连接已关闭。',
    connectionClosed: '诊断连接已关闭。请重新加载此页面以重新连接。',
    clearTraceConfirmation: '要清除所有本地 Agent 诊断跟踪吗？',
    selectExportScope: '请选择与当前导出范围匹配的操作。',
    waitForExport: '请等待当前导出完成后再导入诊断文件。',
    artifactTooLarge: 'too_large: 跟踪文件超过大小限制。',
    scenarioControlNotReady: '场景控制连接尚未就绪。',
    rawCaptureControlNotReady: '原始捕获控制连接尚未就绪。',
  },
};

export function getAgentDiagnosticsMessages(locale: Locale): AgentDiagnosticsMessages {
  return messages[locale] ?? messages.en;
}

export function getAgentDiagnosticsFindingText(
  locale: Locale,
  finding: AgentDiagnosticFinding,
): string {
  if (locale !== 'zh-CN') return finding.message;
  const evidence = finding.evidence;
  const count = typeof evidence.count === 'number' ? evidence.count : null;
  switch (finding.code) {
    case 'operation_terminal_failure':
      return `操作 ${finding.rootOperationId ?? 'unknown'} 以 ${String(evidence.terminalState ?? 'unknown')} 状态结束。`;
    case 'provider_request_failed':
      return `Provider 请求 ${finding.requestId ?? 'unknown'} 失败：${String(evidence.errorCode ?? 'unknown_error')}${evidence.httpStatus === null || evidence.httpStatus === undefined ? '' : `（HTTP ${String(evidence.httpStatus)}）`}。`;
    case 'provider_request_incomplete':
      return `操作已经结束，但 Provider 请求 ${finding.requestId ?? 'unknown'} 没有终止事件。`;
    case 'context_irreducible':
      return `上下文预检无法采用或继续压缩请求 ${finding.requestId ?? 'unknown'}。`;
    case 'context_reduction_failed':
      return `上下文压缩 episode ${String(evidence.episode ?? 'unknown')} 失败。`;
    case 'context_reduction_fallback':
      return `上下文压缩 episode ${String(evidence.episode ?? 'unknown')} 使用了 fallback 摘要。`;
    case 'continuation_failed':
      return `继续执行 episode ${String(evidence.episode ?? 'unknown')} 以 ${String(evidence.outcome ?? 'unknown')} 结束。`;
    case 'watchdog_expired':
      return `${String(evidence.watchdog ?? 'unknown')} watchdog 在 ${String(evidence.limitMs ?? 'unknown')} ms 后超时。`;
    case 'tool_failed':
      return `工具 ${String(evidence.toolName ?? 'unknown')} 返回错误。`;
    case 'tool_write_failed':
      return `写入工具 ${String(evidence.toolName ?? 'unknown')} 执行失败。`;
    case 'active_port_disconnected':
      return 'Agent 尝试仍在运行时 Port 已断开。';
    case 'trace_storage_failure':
      return `跟踪存储进入 ${String(evidence.state ?? 'unknown')} 状态。`;
    case 'organize_preflight_failed':
      return `OrganizeJobRun 预检以 ${String(evidence.state ?? 'unknown')} 状态结束。`;
    case 'organize_preflight_stale':
      return 'OrganizeJobRun 预检证据已经过期。';
    case 'organize_restore_failed':
      return `OrganizeJobRun 恢复失败：${String(evidence.reasonCode ?? 'unknown')}。`;
    case 'organize_batch_failed':
      return `OrganizeJobRun 批次 ${String(evidence.batchStart ?? 'unknown')}-${String(evidence.batchEnd ?? 'unknown')} 以 ${String(evidence.state ?? 'unknown')} 状态结束。`;
    case 'organize_provider_attempt_failed':
      return `OrganizeJobRun Provider 第 ${String(evidence.attempt ?? 'unknown')} 次尝试以 ${String(evidence.state ?? 'unknown')} 状态结束。`;
    case 'organize_apply_failed':
      return `OrganizeJobRun 应用 ${String(evidence.applyId ?? 'unknown')} 失败。`;
    case 'trace_roots_evicted':
      return `${count ?? 0} 个保留操作已被淘汰，证据不完整。`;
    case 'trace_events_dropped':
      return `${count ?? 0} 个跟踪事件已丢弃，证据不完整。`;
    case 'trace_fields_truncated':
      return `${count ?? 0} 个跟踪字段已截断，证据不完整。`;
    case 'trace_events_unknown':
      return `保留了 ${count ?? 0} 个未知跟踪事件，证据可能不完整。`;
    case 'trace_started_after_operation':
      return '至少一个操作在跟踪开始前已经运行。';
    case 'trace_sequence_gap':
      return `操作 ${finding.rootOperationId ?? 'unknown'} 缺少序号 ${String(evidence.firstMissingSequence ?? 'unknown')}-${String(evidence.lastMissingSequence ?? 'unknown')} 的跟踪事件。`;
    default:
      return finding.message;
  }
}
