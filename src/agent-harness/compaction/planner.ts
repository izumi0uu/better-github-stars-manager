import { toModelMessage, type AgentMessage, type ModelMessage } from '../messages';
import {
  isSummaryRequestWithinEffectiveWindow,
  isWithinSummaryInputCap,
  SUMMARY_MAX_OUTPUT_TOKENS,
  type ContextBudgetProfile,
} from './budgets';
import {
  estimateContext,
  estimateMessageTokens,
  estimateUtf8Tokens,
  MESSAGE_FRAMING_TOKENS,
} from './estimator';
import {
  parseCommittedHistory,
  verifyCheckpointCursor,
  type CompactionCheckpointCursor,
} from './turns';

export type CompactionCheckpoint = CompactionCheckpointCursor & {
  summary: string;
};

export type SummaryRange = {
  kind: 'initial' | 'incremental';
  start: number;
  end: number;
  allHistory: boolean;
  previousSummary?: string;
  messages: AgentMessage[];
  summarizedThroughMessageId: string;
};

export type CandidateRequestBase = {
  messages: readonly ModelMessage[];
  toolSchemas?: readonly unknown[];
};

export type SelectCompactionCandidateInput = {
  history: readonly AgentMessage[];
  checkpoint?: CompactionCheckpoint;
  profile: ContextBudgetProfile;
  summaryRequestBase: CandidateRequestBase;
  agentRequestBase: CandidateRequestBase & { maxOutputTokens: number };
  projectedSummaryOverheadTokens?: number;
  previousSummaryOverheadTokens?: number;
  /** Allows a deterministic local summary when the Provider summary request cannot fit. */
  allowOversizedSummaryInput?: boolean;
  acceptCandidate?: (candidate: CompactionCandidate) => boolean;
};

export type CompactionCandidate = {
  boundary: number;
  range: SummaryRange;
  retainedHistory: AgentMessage[];
  retainedHistoryTokens: number;
  summaryInputTokens: number;
  projectedAgentInputTokens: number;
  projectedAgentContextDemandTokens: number;
};

export type SelectActiveTurnCompactionCandidateInput = {
  /** The current user message followed only by fully settled raw envelopes. */
  rawMessages: readonly AgentMessage[];
  /** First raw message not already represented by an active-turn summary. */
  start: number;
  previousSummary?: string;
  profile: ContextBudgetProfile;
  summaryRequestBase: CandidateRequestBase;
  agentRequestBase: CandidateRequestBase & { maxOutputTokens: number };
  projectedSummaryOverheadTokens?: number;
  previousSummaryOverheadTokens?: number;
  /** Allows a deterministic local summary when the Provider summary request cannot fit. */
  allowOversizedSummaryInput?: boolean;
  /** Allows a memory-only intermediate projection before historical context is reduced. */
  allowOversizedAgentProjection?: boolean;
  acceptCandidate?: (candidate: CompactionCandidate) => boolean;
};

export function buildSummaryRange(
  history: readonly AgentMessage[],
  boundary: number,
  checkpoint?: CompactionCheckpoint,
): SummaryRange {
  const parsed = parseCommittedHistory(history);
  const start = checkpoint ? verifyCheckpointCursor(history, checkpoint, parsed) : 0;
  if (
    !Number.isSafeInteger(boundary) ||
    boundary <= start ||
    !parsed.legalBoundaries.includes(boundary)
  ) {
    throw new RangeError('Summary boundary must be an advancing complete-turn boundary.');
  }

  return {
    kind: checkpoint ? 'incremental' : 'initial',
    start,
    end: boundary,
    allHistory: boundary === history.length,
    ...(checkpoint ? { previousSummary: checkpoint.summary } : {}),
    messages: history.slice(start, boundary),
    summarizedThroughMessageId: history[boundary - 1].id,
  };
}

export function selectCompactionCandidate(
  input: SelectCompactionCandidateInput,
): CompactionCandidate | null {
  const parsed = parseCommittedHistory(input.history);
  const start = input.checkpoint
    ? verifyCheckpointCursor(input.history, input.checkpoint, parsed)
    : 0;
  const summaryBaseInput = estimateContext({
    ...input.summaryRequestBase,
    maxOutputTokens: 0,
  }).inputTokens;
  const agentBaseInput = estimateContext({
    ...input.agentRequestBase,
  }).inputTokens;
  const previousSummaryTokens = input.checkpoint
    ? (input.previousSummaryOverheadTokens ?? MESSAGE_FRAMING_TOKENS) +
      estimateUtf8Tokens(input.checkpoint.summary)
    : 0;
  const projectedSummaryTokens =
    (input.projectedSummaryOverheadTokens ?? MESSAGE_FRAMING_TOKENS) +
    SUMMARY_MAX_OUTPUT_TOKENS;

  for (const boundary of parsed.legalBoundaries) {
    if (boundary <= start) continue;

    const compactedMessages = input.history.slice(start, boundary);
    const retainedHistory = input.history.slice(boundary);
    const compactedTokens = messageTokens(compactedMessages);
    const retainedHistoryTokens = messageTokens(retainedHistory);
    if (retainedHistoryTokens > input.profile.recentHistoryTarget) continue;

    const summaryInputTokens =
      summaryBaseInput + previousSummaryTokens + compactedTokens;
    if (
      !input.allowOversizedSummaryInput
      && (
        !isWithinSummaryInputCap(summaryInputTokens, input.profile)
        || !isSummaryRequestWithinEffectiveWindow(summaryInputTokens, input.profile)
      )
    ) continue;

    const projectedAgentInputTokens =
      agentBaseInput +
      projectedSummaryTokens +
      retainedHistoryTokens;
    if (projectedAgentInputTokens > input.profile.hardLimit) continue;
    const projectedAgentContextDemandTokens =
      projectedAgentInputTokens + input.agentRequestBase.maxOutputTokens;

    const candidate: CompactionCandidate = {
      boundary,
      range: buildSummaryRange(input.history, boundary, input.checkpoint),
      retainedHistory,
      retainedHistoryTokens,
      summaryInputTokens,
      projectedAgentInputTokens,
      projectedAgentContextDemandTokens,
    };
    if (input.acceptCandidate && !input.acceptCandidate(candidate)) continue;
    return candidate;
  }

  return null;
}

/**
 * Chooses a Pi-style split inside an active turn. A retained suffix always
 * begins at an assistant envelope, so no tool result is detached from its
 * declaring tool call. The original user message is intentionally outside the
 * summarized range and remains verbatim in the rebuilt Provider projection.
 */
export function selectActiveTurnCompactionCandidate(
  input: SelectActiveTurnCompactionCandidateInput,
): CompactionCandidate | null {
  if (!Number.isSafeInteger(input.start) || input.start < 1 || input.start >= input.rawMessages.length) {
    return null;
  }
  if (input.rawMessages[0]?.role !== 'user') return null;

  const summaryBaseInput = estimateContext({
    ...input.summaryRequestBase,
    maxOutputTokens: 0,
  }).inputTokens;
  const agentBaseInput = estimateContext({
    ...input.agentRequestBase,
  }).inputTokens;
  const previousSummaryTokens = input.previousSummary
    ? (input.previousSummaryOverheadTokens ?? MESSAGE_FRAMING_TOKENS) +
      estimateUtf8Tokens(input.previousSummary)
    : 0;
  const projectedSummaryTokens =
    (input.projectedSummaryOverheadTokens ?? MESSAGE_FRAMING_TOKENS) +
    SUMMARY_MAX_OUTPUT_TOKENS;

  for (let boundary = input.start + 1; boundary <= input.rawMessages.length; boundary += 1) {
    const retainsSuffix = boundary < input.rawMessages.length;
    if (retainsSuffix && input.rawMessages[boundary]?.role !== 'agent') continue;
    if (input.rawMessages[boundary - 1]?.role !== 'tool') continue;

    const compactedMessages = input.rawMessages.slice(input.start, boundary);
    const retainedHistory = input.rawMessages.slice(boundary);
    const retainedHistoryTokens = messageTokens(retainedHistory);
    if (retainedHistoryTokens > input.profile.recentHistoryTarget) continue;

    const summaryInputTokens =
      summaryBaseInput + previousSummaryTokens + messageTokens(compactedMessages);
    if (
      !input.allowOversizedSummaryInput
      && (
        !isWithinSummaryInputCap(summaryInputTokens, input.profile)
        || !isSummaryRequestWithinEffectiveWindow(summaryInputTokens, input.profile)
      )
    ) continue;

    const projectedAgentInputTokens =
      agentBaseInput + projectedSummaryTokens + retainedHistoryTokens;
    if (
      !input.allowOversizedAgentProjection
      && projectedAgentInputTokens > input.profile.hardLimit
    ) continue;

    const candidate: CompactionCandidate = {
      boundary,
      range: {
        kind: input.previousSummary ? 'incremental' : 'initial',
        start: input.start,
        end: boundary,
        allHistory: false,
        ...(input.previousSummary ? { previousSummary: input.previousSummary } : {}),
        messages: compactedMessages,
        summarizedThroughMessageId: input.rawMessages[boundary - 1]!.id,
      },
      retainedHistory,
      retainedHistoryTokens,
      summaryInputTokens,
      projectedAgentInputTokens,
      projectedAgentContextDemandTokens:
        projectedAgentInputTokens + input.agentRequestBase.maxOutputTokens,
    };
    if (input.acceptCandidate && !input.acceptCandidate(candidate)) continue;
    return candidate;
  }

  return null;
}

function messageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(toModelMessage(message)),
    0,
  );
}
