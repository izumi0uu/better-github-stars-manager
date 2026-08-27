import { parseProposalId, parseRunId } from '@/bgsm-agent/identity';
import {
  restoreOrganizeJobRunAnalysisState,
  type OrganizeJobRunAnalysisState,
  type OrganizeJobRunPagePosition,
} from '@/bgsm-agent/organize-job';
import {
  createOrganizeTagPolicySnapshot,
  type RunBudget,
  type RunBudgetUsage,
} from '@/bgsm-agent/policy';
import {
  parseSourceFingerprint,
  parseTaxonomyFingerprint,
  type ActionableProposalRow,
  type NonActionableAnalysisOutcome,
} from '@/bgsm-agent/proposal';
import { createFrozenScope, parseScopeFingerprint } from '@/bgsm-agent/scope';
import type { SemanticTaxonomyDto } from '@/bgsm-agent/semantic-dto';
import type { OrganizeAnalysisOutcome } from '@/storage/organize-job-store';
import type { OrganizeItemRecord, OrganizeJobRecord } from '@/types';

/**
 * Projections between durable organize rows and the in-memory analysis state.
 * The frozen index is the only stable row identity across a restore, so every
 * projection here keys on it rather than on array order.
 */
export type StoredOrganizeTaxonomy = Readonly<{
  taxonomy: SemanticTaxonomyDto;
  policyTaxonomy: SemanticTaxonomyDto;
}>;

export function isStoredOrganizeTaxonomy(value: unknown): value is StoredOrganizeTaxonomy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return !!record.taxonomy && typeof record.taxonomy === "object" &&
    !!record.policyTaxonomy && typeof record.policyTaxonomy === "object";
}

export function organizeOutcomesForPage(
  state: OrganizeJobRunAnalysisState,
  positions: readonly OrganizeJobRunPagePosition[],
): readonly OrganizeAnalysisOutcome[] {
  const actionable = new Map(state.actionableProposalRows.map((row) => [row.frozenIndex, row]));
  const nonActionable = new Map(
    state.nonActionableAnalysisOutcomes.map((row) => [row.frozenIndex, row]),
  );
  return positions.map((position): OrganizeAnalysisOutcome => {
    const proposal = actionable.get(position.frozenIndex);
    if (proposal) {
      return {
        position: position.frozenIndex,
        state: "actionable",
        sourceFingerprint: proposal.sourceFingerprint,
        proposedActions: proposal.actions,
      };
    }
    const outcome = nonActionable.get(position.frozenIndex);
    if (!outcome) throw new TypeError("Finalized organize page is missing a row outcome.");
    return {
      position: position.frozenIndex,
      state: outcome.kind === "analysis_failed" ? "failed" : outcome.kind,
      failure: outcome.kind === "analysis_failed" ? "provider_failed" : null,
    };
  });
}

export function sameOrganizeAnalysisRanges(
  left: readonly Readonly<{
    startFrozenIndex: number;
    endFrozenIndexExclusive: number;
    depth: number;
  }>[],
  right: readonly Readonly<{
    startFrozenIndex: number;
    endFrozenIndexExclusive: number;
    depth: number;
  }>[],
): boolean {
  return left.length === right.length && left.every((range, index) => {
    const other = right[index];
    return other !== undefined
      && range.startFrozenIndex === other.startFrozenIndex
      && range.endFrozenIndexExclusive === other.endFrozenIndexExclusive
      && range.depth === other.depth;
  });
}

export function buildRestoredOrganizeAnalysisState(
  job: OrganizeJobRecord,
  items: readonly OrganizeItemRecord[],
  taxonomyFingerprintValue: string,
): OrganizeJobRunAnalysisState {
  if (job.frozenScope.kind !== 'all_live_stars' || typeof job.frozenScope.filterSnapshot !== 'string') {
    throw new TypeError('Stored organize FrozenScope is invalid.');
  }
  const runId = parseRunId(job.runId);
  const proposalId = parseProposalId(job.proposalId);
  const taxonomyFingerprint = items.find((row) => row.analysisState === 'actionable')
    ? parseTaxonomyFingerprint(taxonomyFingerprintValue)
    : null;
  const analyzed = items
    .filter((row) => row.analysisState !== 'pending' && row.analysisState !== 'leased')
    .map((row) => ({
      frozenIndex: row.position,
      repositoryId: row.fullName,
      classification: row.analysisState === 'actionable' ? 'actionable' as const : 'non_actionable' as const,
    }));
  const nonActionable: NonActionableAnalysisOutcome[] = items.flatMap((row) => {
    if (row.analysisState === 'pending' || row.analysisState === 'leased' || row.analysisState === 'actionable') {
      return [];
    }
    return [{
      frozenIndex: row.position,
      repositoryId: row.fullName,
      kind: row.analysisState === 'failed' ? 'analysis_failed' as const : row.analysisState,
    }];
  });
  const actionable: ActionableProposalRow[] = items.flatMap((row) => {
    if (row.analysisState !== 'actionable') return [];
    if (!taxonomyFingerprint || !row.sourceFingerprint) {
      throw new TypeError('Stored actionable organize row is missing sealed fingerprints.');
    }
    return [{
      proposalRowId: `${proposalId}:row:${row.position}`,
      frozenIndex: row.position,
      repositoryId: row.fullName,
      sourceFingerprint: parseSourceFingerprint(row.sourceFingerprint),
      taxonomyFingerprint,
      actions: row.proposedActions,
    }];
  });
  return restoreOrganizeJobRunAnalysisState({
    runId,
    generation: job.generation,
    proposalId,
    frozenScope: createFrozenScope({
      kind: 'all_live_stars',
      label: job.frozenScope.label,
      filterSnapshot: job.frozenScope.filterSnapshot,
      repositoryIds: job.frozenScope.repositoryIds,
      capturedAt: job.frozenScope.capturedAt,
      fingerprint: parseScopeFingerprint(job.frozenScope.fingerprint),
    }),
    tagPolicy: createOrganizeTagPolicySnapshot(job.tagPolicy),
    budget: job.budget as RunBudget,
    usage: job.usage as RunBudgetUsage,
    nextFrozenIndex: job.nextFrozenIndex,
    analysisPendingRanges: job.analysisPendingRanges ?? [],
    status: ['review', 'apply_sealed', 'applying', 'paused', 'completed'].includes(job.status)
      ? 'review'
      : job.status === 'analysis_blocked'
        ? 'analysis_blocked'
        : 'analyzing',
    analyzedFrozenPositions: analyzed,
    nonActionableAnalysisOutcomes: nonActionable,
    actionableProposalRows: actionable,
  });
}
