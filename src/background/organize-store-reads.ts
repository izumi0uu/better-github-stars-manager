import { parseProposalId, parseRunId } from '@/bgsm-agent/identity';
import type { SemanticRepositoryRecord } from '@/bgsm-agent/organize-scope-reader';
import {
  buildSemanticPolicyTaxonomyFromStorage,
  buildSemanticTaxonomyFromStorage,
  fingerprintSemanticTaxonomy,
} from '@/bgsm-agent/semantic-dto';
import { db } from '@/storage/db';
import { idbTagStore } from '@/storage/idb-tag-store';
import {
  getOrganizeApplyProgress,
  getOrganizeCoverage,
  getOrganizeJobForRun,
  getOrganizeSelectionSummary,
  getOrganizeTaxonomy,
} from '@/storage/organize-job-store';
import { normalizeStoredTag, type LegacyTagRow } from '@/storage/tag-shape';
import type { OrganizeJobRecord } from '@/types';
import type { BgsmOrganizeJobPresentation } from '@/utils/messaging';
import { isStoredOrganizeTaxonomy } from './organize-analysis-projection';
import type { OrganizeRunIdentity } from './organize-job-controller';

/**
 * Read-only durable organize projections. A frozen run must read the taxonomy
 * sealed with it rather than the live one, so the frozen and live loaders stay
 * separate entrypoints.
 */
export async function loadOrganizeJobRunRepositoryRecords(repositoryIds: readonly string[]) {
  const [stars, tags] = await Promise.all([
    db.stars.bulkGet([...repositoryIds]),
    idbTagStore.getMany([...repositoryIds]),
  ]);
  const records = new Map<string, SemanticRepositoryRecord>();
  repositoryIds.forEach((repositoryId, index) => {
    const star = stars[index];
    if (star) records.set(repositoryId, { star, tag: tags.get(repositoryId) ?? null });
  });
  return records;
}

export async function loadOrganizeJobRunTaxonomy() {
  const [rawTags, tagMeta] = await Promise.all([db.tags.toArray(), db.tagMeta.toArray()]);
  const tags = rawTags.map((rawTag) => normalizeStoredTag(rawTag as LegacyTagRow));
  const taxonomy = buildSemanticTaxonomyFromStorage(tagMeta, tags);
  const policyTaxonomy = buildSemanticPolicyTaxonomyFromStorage(tagMeta, tags);
  return Object.freeze({
    taxonomy,
    policyTaxonomy,
    fingerprint: await fingerprintSemanticTaxonomy(policyTaxonomy),
  });
}

export async function loadFrozenOrganizeTaxonomy(identity: OrganizeRunIdentity) {
  const job = await getOrganizeJobForRun(identity.runId, identity.generation);
  if (!job) throw new TypeError("Durable organize job is unavailable for taxonomy loading.");
  const stored = await getOrganizeTaxonomy(job.jobId);
  if (!stored || !isStoredOrganizeTaxonomy(stored.snapshot)) {
    throw new TypeError("Durable organize taxonomy snapshot is invalid.");
  }
  return Object.freeze({
    taxonomy: stored.snapshot.taxonomy,
    policyTaxonomy: stored.snapshot.policyTaxonomy,
    fingerprint: stored.fingerprint as Awaited<ReturnType<typeof fingerprintSemanticTaxonomy>>,
  });
}

export async function buildOrganizeJobPresentation(
  job: OrganizeJobRecord,
): Promise<BgsmOrganizeJobPresentation> {
  if (job.status === 'preflight_ready') {
    throw new TypeError('A preflight cannot be presented as an active organize job.');
  }
  const [coverage, selection, apply] = await Promise.all([
    getOrganizeCoverage(job.jobId),
    getOrganizeSelectionSummary(job.jobId),
    job.applyId ? getOrganizeApplyProgress(job.applyId) : Promise.resolve(undefined),
  ]);
  return Object.freeze({
    controllerId: job.controllerId as BgsmOrganizeJobPresentation['controllerId'],
    sessionId: job.sessionId,
    runId: parseRunId(job.runId),
    generation: job.generation,
    jobId: job.jobId,
    originAgentSessionId: job.originAgentSessionId,
    revision: job.revision,
    status: job.status,
    scopeLabel: job.frozenScope.label,
    scopeCount: job.itemCount,
    capturedAt: job.frozenScope.capturedAt,
    proposalId: parseProposalId(job.proposalId),
    coverage: Object.freeze({
      total: coverage.total,
      analyzed: coverage.analyzed,
      actionable: coverage.actionable,
      unchanged: coverage.unchanged,
      insufficientEvidence: coverage.insufficientEvidence,
      missing: coverage.missing,
      tombstoned: coverage.tombstoned,
      analysisFailed: coverage.failed,
    }),
    selectedRepositories: selection.selectedRepositories,
    selectedActions: selection.selectedActions,
    apply: apply ? Object.freeze({ ...apply }) : null,
  });
}
