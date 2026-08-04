import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import {
  ACTIONABLE_PROPOSAL_ROW_HARD_LIMIT,
  APPLY_CHUNK_ROW_LIMIT,
  AGENT_DATA_DISCLOSURE_VERSION,
  AGENT_NOT_SENT_AS_TASK_DATA_CATEGORIES,
  AGENT_PROVIDER_KEY_AUTHORIZATION_EXCEPTION,
  AGENT_SENT_TASK_DATA_CATEGORIES,
  ANALYZER_OUTPUT_TOKENS_DEFAULT,
  ANALYZER_OUTPUT_TOKENS_HARD_LIMIT,
  BUDGET_EXHAUSTION_REASON_PRIORITY,
  ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME,
  FROZEN_SCOPE_PAGE_DEFAULT,
  FROZEN_SCOPE_PAGE_HARD_LIMIT,
  MAX_SEMANTIC_EVIDENCE_BYTES,
  MAX_SEMANTIC_TAG_NAME_BYTES,
  MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES,
  PROPOSAL_REVIEW_PAGE_HARD_LIMIT,
  TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT,
  createAgentDataDisclosureAcceptance,
  createOrganizeJobRunCoverageSummary,
  createEmptyRunBudgetUsage,
  createFrozenScope,
  createFrozenScopeCursor,
  createLowerTestRunBudget,
  createProductionRunBudget,
  canonicalizeProposalReviewProjection,
  canonicalizeProposalReviewPageProjection,
  paginateProposalReviewProjection,
  isDisclosureAcceptedFor,
  isMonotonicRunBudgetUsage,
  parseControllerId,
  parseContinuationCursorToken,
  parsePreflightToken,
  parseProposalId,
  projectFrozenScope,
  parseRunId,
  parseScopeFingerprintV1,
  parseSourceFingerprintV1,
  parseTaxonomyFingerprintV1,
  selectBudgetExhaustionReason,
  validateAgentDataDisclosureAcceptance,
  validateAnalyzerBatchProposal,
  validateOrganizeJobRunEvent,
  validateOrganizeJobRunCoverageSummary,
  validateOrganizeJobRunSnapshot,
  validateOrganizeProposal,
  validateProposalReviewProjection,
  validateProposalReviewPageAgainstActionableRows,
  validateProposalReviewSummary,
  validateProposalReviewProjectionAgainstActionableRows,
  validateFrozenScope,
  validateFrozenScopeCursor,
  validateLaunchCandidateContract,
  validateProviderActualTokenTelemetry,
  validateProviderAttemptReservation,
  validateRowUniverses,
  validateRunBudget,
  validateRunBudgetUsage,
  type ActionableProposalRow,
  type ContinuationCursorToken,
  type PreflightToken,
  type ProposalAction,
  type ProposalReviewProjection,
} from '@/bgsm-agent';
import {
  validateBgsmOrganizeJobMessageIdentity,
  type BgsmOrganizeJobPortMessage,
} from '@/utils/messaging';
import { BGSM_AGENT_INSTRUCTIONS } from '@/bgsm-agent/instructions';

const DIGEST = 'A'.repeat(43);
const runId = parseRunId('run:v1:run-1');
const proposalId = parseProposalId('proposal:v1:proposal-1');
const controllerId = parseControllerId('controller:v1:controller-1');
const sourceFingerprint = parseSourceFingerprintV1(`sf:v1:${DIGEST}`);
const taxonomyFingerprint = parseTaxonomyFingerprintV1(`tf:v1:${DIGEST}`);

describe('Cubby response completeness contract', () => {
  it('keeps the Cubby persona warm, precise, and restrained', () => {
    assert.match(BGSM_AGENT_INSTRUCTIONS, /optional AI tag assistant in Better GitHub Stars Manager/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /calm, capable library companion/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /do not role-play, use pet sounds/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /errors, recovery steps, data boundaries, and write confirmations precise and neutral/u);
  });

  it('keeps full-library scope confirmation actions in the UI', () => {
    assert.match(BGSM_AGENT_INSTRUCTIONS, /confirmation_requested/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /analysis scope is being prepared/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /Do not ask the user to reply with a fixed phrase/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /Do not claim that the scope is ready/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /Do not mention the UI, tool, handoff, status, or protocol/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /Start analysis and Cancel controls/u);
  });

  it('requires exact requested counts or an explicit qualified-result shortage', () => {
    assert.match(BGSM_AGENT_INSTRUCTIONS, /exact number of repositories/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /exactly that many distinct qualifying repositories/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /follow nextCursor/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /after the bounded search/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /only how many qualified/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /at most four distinct query variants/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /direct initial query is variant one/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /at most three alternative term sets/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /Stop searching immediately/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /smallest practical limit/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /more than 50 repositories/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /enumerate at most 50 repositories/u);
  });

  it('treats any-mode search as discovery and requires positive evidence for every criterion', () => {
    assert.match(BGSM_AGENT_INSTRUCTIONS, /appliedMode any/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /discovery candidates, not proof/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /Read each result matchedTerms/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /all-mode search using one atomic term per criterion/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /direct user terms/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /match: all/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /separate bounded variants/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /joined by or, slash/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /never put two alternatives/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /terminal and CLI/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /Do not relax the requested product role/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /every required positive attribute/u);
  });

  it('keeps core products distinct from related ecosystem infrastructure', () => {
    assert.match(BGSM_AGENT_INSTRUCTIONS, /core product/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /multiplexer, orchestrator, host, integration, plugin, toolkit, framework, SDK, library, skill/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /template, tutorial, harness, or supporting component/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /merely contains, supports, or relates/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /broader ecosystem/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /required positive attribute/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /absence of an excluded role is not proof/u);
    assert.match(BGSM_AGENT_INSTRUCTIONS, /topics as supporting evidence/u);
  });
});

function action(tag: string): ProposalAction {
  return { kind: 'add_existing_tag', tag, evidence: `Evidence for ${tag}` };
}

function proposalRow(index: number, repositoryId = `owner/repo-${index}`): ActionableProposalRow {
  return {
    proposalRowId: `row-${index}`,
    frozenIndex: index,
    repositoryId,
    sourceFingerprint,
    taxonomyFingerprint,
    actions: [action(`tag-${index}`)],
  };
}

function reviewProjection(
  rows: readonly ActionableProposalRow[],
  preselected = true,
): ProposalReviewProjection {
  return {
    version: 1,
    proposalId,
    runId,
    generation: 2,
    rows: rows.map((row) => ({
      proposalRowId: row.proposalRowId,
      frozenIndex: row.frozenIndex,
      repositoryId: row.repositoryId,
      proposedActions: row.actions,
      preselected,
    })),
  };
}

function validateProposalActions(actions: readonly ProposalAction[]): void {
  validateOrganizeProposal({
    version: 1,
    proposalId,
    runId,
    generation: 2,
    rows: [{ ...proposalRow(0), actions }],
  });
}

describe('Cubby frozen RunBudget contract', () => {
  it('exposes the exact production defaults and deeply immutable policy value', () => {
    const budget = createProductionRunBudget();
    assert.deepEqual(budget, {
      wallDeadlineMs: 300_000,
      maxConsumedFrozenPositions: 500,
      maxAnalyzerBatches: 20,
      maxProviderAttempts: 24,
      maxSerializedOutboundRequestBytes: 8_388_608,
      maxRequestedOutputTokens: 32_000,
    });
    assert.equal(Object.isFrozen(budget), true);
    assert.notEqual(createProductionRunBudget(), budget);
    assert.throws(() => Object.assign(budget, { maxProviderAttempts: 25 }), TypeError);
    assert.equal(FROZEN_SCOPE_PAGE_DEFAULT, 25);
    assert.equal(FROZEN_SCOPE_PAGE_HARD_LIMIT, 50);
    assert.equal(ANALYZER_OUTPUT_TOKENS_DEFAULT, 4_096);
    assert.equal(ANALYZER_OUTPUT_TOKENS_HARD_LIMIT, 8_192);
    assert.equal(ACTIONABLE_PROPOSAL_ROW_HARD_LIMIT, Number.MAX_SAFE_INTEGER);
    assert.equal(APPLY_CHUNK_ROW_LIMIT, 100);
    assert.equal(PROPOSAL_REVIEW_PAGE_HARD_LIMIT, 100);
    assert.equal(TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT, 5);
  });

  it('allows only lower immutable test policy values and rejects invalid shapes', () => {
    const lower = createLowerTestRunBudget({ maxProviderAttempts: 2 });
    assert.equal(lower.maxProviderAttempts, 2);
    assert.equal(Object.isFrozen(lower), true);
    assert.throws(
      () => createLowerTestRunBudget({ maxProviderAttempts: 25 }),
      /cannot raise/u,
    );
    assert.throws(
      () => validateRunBudget({ ...createProductionRunBudget(), extra: 1 }),
      /Unexpected contract keys/u,
    );
  });

  it('freezes monotonic usage and the atomic attempt/byte/requested-token reservation shape', () => {
    const empty = createEmptyRunBudgetUsage();
    const reserved = Object.freeze({
      firstAnalyzerRequestAt: 1_000,
      consumedFrozenPositions: 0,
      analyzerBatches: 1,
      providerAttempts: 1,
      serializedOutboundRequestBytes: 512,
      requestedOutputTokens: 4_096,
    });
    validateRunBudgetUsage(empty);
    assert.equal(isMonotonicRunBudgetUsage(empty, reserved), true);
    validateProviderAttemptReservation({
      reservedAt: 1_000,
      serializedRequestBytes: 512,
      requestedOutputTokens: 4_096,
      previousUsage: { ...empty, analyzerBatches: 1 },
      usage: reserved,
    });
    assert.throws(() => validateProviderAttemptReservation({
      reservedAt: 1_000,
      serializedRequestBytes: 512,
      requestedOutputTokens: 4_096,
      previousUsage: { ...empty, analyzerBatches: 1 },
      usage: { ...reserved, providerAttempts: 2 },
    }), /atomically reserve/u);
    assert.equal(isMonotonicRunBudgetUsage(reserved, { ...reserved, providerAttempts: 0 }), false);
    assert.equal(isMonotonicRunBudgetUsage(reserved, { ...reserved, firstAnalyzerRequestAt: 1_001 }), false);
    validateProviderActualTokenTelemetry({ inputTokens: null, outputTokens: 90_000, totalTokens: 90_000 });
  });

  it('selects simultaneous exhaustion with the exact six-reason priority', () => {
    assert.deepEqual(BUDGET_EXHAUSTION_REASON_PRIORITY, [
      'wall_deadline',
      'consumed_positions',
      'analyzer_batches',
      'provider_attempts',
      'outbound_request_bytes',
      'requested_output_tokens',
    ]);
    for (const expected of BUDGET_EXHAUSTION_REASON_PRIORITY) {
      const flags = Object.fromEntries(
        BUDGET_EXHAUSTION_REASON_PRIORITY.map((reason) => [reason, false]),
      ) as Record<(typeof BUDGET_EXHAUSTION_REASON_PRIORITY)[number], boolean>;
      for (const reason of BUDGET_EXHAUSTION_REASON_PRIORITY.slice(
        BUDGET_EXHAUSTION_REASON_PRIORITY.indexOf(expected),
      )) flags[reason] = true;
      assert.equal(selectBudgetExhaustionReason(flags), expected);
    }
  });
});

describe('FrozenScope and transport token identities', () => {
  it('keeps the active public transport tokens noninterchangeable', () => {
    const preflight = parsePreflightToken('preflight:v1:opaque');
    const cursor = parseContinuationCursorToken('cursor:v1:opaque');
    assert.doesNotThrow(() => parsePreflightToken(preflight));
    assert.doesNotThrow(() => parseContinuationCursorToken(cursor));
    assert.throws(() => parsePreflightToken(cursor));
    assert.throws(() => parseContinuationCursorToken(preflight));
    assert.equal(cursor, 'cursor:v1:opaque');
    assertPreflightType(preflight);
    if (false) {
      // @ts-expect-error ContinuationCursorToken is nominally distinct from PreflightToken.
      assertPreflightType(cursor);
      // @ts-expect-error PreflightToken is nominally distinct from ContinuationCursorToken.
      assertContinuationType(preflight);
    }
  });

  it('copies ordered IDs, deduplicates once, derives count, and freezes nested arrays', () => {
    const scope = createFrozenScope({
      kind: 'current_view',
      label: 'Current view',
      filterSnapshot: 'language:TypeScript',
      repositoryIds: ['a/one', 'b/two', 'a/one'],
      capturedAt: 100,
      fingerprint: parseScopeFingerprintV1(`fs:v1:${DIGEST}`),
    });
    assert.deepEqual(scope.repositoryIds, ['a/one', 'b/two']);
    assert.equal(scope.count, 2);
    assert.equal(Object.isFrozen(scope), true);
    assert.equal(Object.isFrozen(scope.repositoryIds), true);
    validateFrozenScope(scope);
    assert.throws(() => validateFrozenScope({ ...scope, count: 3 }), /count/u);
    assert.throws(() => validateFrozenScope({ ...scope, repositoryIds: ['a/one', 'a/one'] }), /deduplicated/u);
  });

  it('freezes the exact raw cursor identity and a candidate contract with no row IDs/counts', () => {
    const cursor = createFrozenScopeCursor(runId, 2, 25);
    assert.deepEqual(cursor, { runId, generation: 2, nextFrozenIndex: 25 });
    assert.equal(Object.isFrozen(cursor), true);
    validateFrozenScopeCursor(cursor);
    assert.throws(() => validateFrozenScopeCursor({ ...cursor, nextFrozenIndex: -1 }), /nonnegative/u);

    const candidate = {
      kind: 'current_view',
      filter: {
        query: 'agent',
        languages: ['TypeScript'],
        tags: ['tools'],
        tagMode: 'all',
        showTombstone: false,
        onlyFavorite: false,
        onlyUntagged: false,
        onlyArchived: false,
        sortKey: 'starred_at',
        sortDir: 'desc',
      },
    } as const;
    validateLaunchCandidateContract(candidate);
    assert.throws(() => validateLaunchCandidateContract({
      ...candidate,
      repositoryIds: ['forged/repo'],
    }), /Unexpected contract keys/u);
  });
});

describe('five semantic-tag row universes', () => {
  it('accepts more than 100 review rows while still rejecting an empty review', () => {
    validateProposalReviewProjection(reviewProjection([proposalRow(0)]));
    validateProposalReviewProjection(reviewProjection(
      Array.from({ length: 101 }, (_, index) => proposalRow(index)),
    ));
    assert.throws(() => validateProposalReviewProjection(reviewProjection([])), /nonempty/u);
  });

  it('rejects duplicate identities, non-increasing order, extra/private fields, and invalid actions', () => {
    const first = proposalRow(0);
    const second = proposalRow(1);
    const base = reviewProjection([first, second]);
    assert.throws(() => validateProposalReviewProjection({
      ...base,
      rows: [base.rows[0], { ...base.rows[1], proposalRowId: first.proposalRowId }],
    }), /unique proposal/u);
    assert.throws(() => validateProposalReviewProjection({
      ...base,
      rows: [base.rows[1], base.rows[0]],
    }), /strictly increasing/u);
    assert.throws(() => validateProposalReviewProjection({
      ...base,
      rows: [{ ...base.rows[0], sourceFingerprint, notes: 'private' }, base.rows[1]],
    }), /Unexpected contract keys/u);
    assert.throws(() => validateProposalReviewProjection({
      ...base,
      rows: [{ ...base.rows[0], proposedActions: [] }, base.rows[1]],
    }), /nonempty action array/u);
    assert.throws(() => validateProposalReviewProjection({
      ...base,
      rows: [{
        ...base.rows[0],
        proposedActions: [{ kind: 'add_existing_tag', tag: 'e\u0301', evidence: 'evidence' }],
      }, base.rows[1]],
    }), /NFKC-normalized/u);
  });

  it('bounds each review transport page at 1 MiB without bounding the whole job', () => {
    assert.equal(MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES, 1_048_576);
    const base = reviewProjection([proposalRow(0, 'r')]);
    const oversizedWholeReview = reviewProjection(Array.from(
      { length: 101 },
      (_, index) => proposalRow(index, `owner/${'r'.repeat(10_300)}-${index}`),
    ));
    const canonicalWhole = canonicalizeProposalReviewProjection(oversizedWholeReview);
    assert.ok(canonicalWhole.byteLength > MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES);

    const firstPage = paginateProposalReviewProjection(canonicalWhole.projection, 0);
    validateProposalReviewSummary({
      version: 1,
      proposalId,
      runId,
      generation: 2,
      totalRows: 101,
    });
    validateProposalReviewPageAgainstActionableRows(
      firstPage.projection,
      Array.from({ length: 101 }, (_, index) => proposalRow(
        index,
        `owner/${'r'.repeat(10_300)}-${index}`,
      )),
    );
    assert.equal(firstPage.projection.totalRows, 101);
    assert.equal(firstPage.projection.rowOffset, 0);
    assert.ok(firstPage.projection.rows.length > 0);
    assert.ok(firstPage.projection.rows.length <= PROPOSAL_REVIEW_PAGE_HARD_LIMIT);
    assert.ok(firstPage.byteLength <= MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES);
    assert.equal(firstPage.projection.nextRowOffset, firstPage.projection.rows.length);
    assert.equal(Object.isFrozen(firstPage.projection.rows), true);

    const pageBase = paginateProposalReviewProjection(base, 0).projection;
    const baseBytes = new TextEncoder().encode(JSON.stringify(pageBase)).byteLength;
    const exactRepositoryId = 'r'.repeat(
      1 + MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES - baseBytes,
    );
    const exact = {
      ...pageBase,
      rows: [{ ...pageBase.rows[0], repositoryId: exactRepositoryId }],
    };
    const canonicalPage = canonicalizeProposalReviewPageProjection(exact);
    assert.equal(canonicalPage.byteLength, MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES);
    assert.throws(() => canonicalizeProposalReviewPageProjection({
      ...exact,
      rows: [{ ...exact.rows[0], repositoryId: `${exactRepositoryId}r` }],
    }), /1048576 UTF-8 bytes/u);
  });

  it('measures normalized tag names at exactly 256 UTF-8 bytes and rejects byte 257', () => {
    assert.equal(MAX_SEMANTIC_TAG_NAME_BYTES, 256);
    const exactValues = [
      'a'.repeat(256),
      `${'界'.repeat(85)}a`,
      '😀'.repeat(64),
      '\u0300'.repeat(128),
    ];
    for (const tag of exactValues) {
      assert.equal(new TextEncoder().encode(tag).byteLength, MAX_SEMANTIC_TAG_NAME_BYTES);
      validateProposalActions([{ kind: 'add_existing_tag', tag, evidence: 'evidence' }]);
      assert.throws(() => validateProposalActions([
        { kind: 'add_existing_tag', tag: `${tag}a`, evidence: 'evidence' },
      ]), /256 UTF-8 bytes/u);
    }
    assert.throws(() => validateProposalActions([
      { kind: 'add_existing_tag', tag: 'e\u0301', evidence: 'evidence' },
    ]), /NFKC-normalized/u);
  });

  it('measures actionable and non-actionable evidence at 1,024 UTF-8 bytes', () => {
    assert.equal(MAX_SEMANTIC_EVIDENCE_BYTES, 1_024);
    const exactValues = [
      'a'.repeat(1_024),
      `${'界'.repeat(341)}a`,
      '😀'.repeat(256),
      '\u0300'.repeat(512),
    ];
    for (const evidence of exactValues) {
      assert.equal(new TextEncoder().encode(evidence).byteLength, MAX_SEMANTIC_EVIDENCE_BYTES);
      validateProposalActions([{ kind: 'add_existing_tag', tag: 'tools', evidence }]);
      assert.throws(() => validateProposalActions([
        { kind: 'add_existing_tag', tag: 'tools', evidence: `${evidence}a` },
      ]), /1024 UTF-8 bytes/u);
    }
    const analyzerBase = {
      version: 1,
      runId,
      generation: 2,
      scopeFingerprint: parseScopeFingerprintV1(`fs:v1:${DIGEST}`),
      rows: [{
        frozenIndex: 0,
        repositoryId: 'owner/repo-0',
        sourceFingerprint,
        classifications: [{ kind: 'unchanged', evidence: '😀'.repeat(256) }],
      }],
    } as const;
    validateAnalyzerBatchProposal(analyzerBase);
    assert.throws(() => validateAnalyzerBatchProposal({
      ...analyzerBase,
      rows: [{
        ...analyzerBase.rows[0],
        classifications: [{ kind: 'unchanged', evidence: `${'😀'.repeat(256)}a` }],
      }],
    }), /1024 UTF-8 bytes/u);
  });

  it('freezes one analyzer tool and exactly four classification kinds', () => {
    assert.equal(ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME, 'submit_semantic_tag_batch_proposal');
    const analyzerProposal = {
      version: 1,
      runId,
      generation: 2,
      scopeFingerprint: parseScopeFingerprintV1(`fs:v1:${DIGEST}`),
      rows: [{
        frozenIndex: 0,
        repositoryId: 'owner/repo-0',
        sourceFingerprint,
        classifications: [action('tools')],
      }],
    } as const;
    validateAnalyzerBatchProposal(analyzerProposal);
    assert.throws(() => validateAnalyzerBatchProposal({
      ...analyzerProposal,
      rows: [{
        ...analyzerProposal.rows[0],
        classifications: [action('tools'), { kind: 'unchanged', evidence: 'No change' }],
      }],
    }), /cannot contain tag actions/u);
    assert.throws(() => validateAnalyzerBatchProposal({
      ...analyzerProposal,
      rows: [{
        ...analyzerProposal.rows[0],
        classifications: [{ kind: 'remove_tag', tag: 'tools', evidence: 'No' }],
      }],
    }), /kind is invalid/u);
  });

  it('proves the contiguous analyzed partition', () => {
    const first = proposalRow(0);
    const third = proposalRow(2);
    validateRowUniverses({
      consumedRange: { startFrozenIndex: 0, endFrozenIndexExclusive: 3 },
      analyzedFrozenPositions: [
        { frozenIndex: 0, repositoryId: first.repositoryId, classification: 'actionable' },
        { frozenIndex: 1, repositoryId: 'owner/missing', classification: 'non_actionable' },
        { frozenIndex: 2, repositoryId: third.repositoryId, classification: 'actionable' },
      ],
      nonActionableAnalysisOutcomes: [
        { frozenIndex: 1, repositoryId: 'owner/missing', kind: 'missing' },
      ],
      actionableProposalRows: [first, third],
    });
    const projection = reviewProjection([first, third]);
    validateProposalReviewProjectionAgainstActionableRows(projection, [first, third]);
    assert.throws(() => validateProposalReviewProjectionAgainstActionableRows(
      reviewProjection([first, proposalRow(1, 'owner/missing'), third]),
      [first, third],
    ), /equal the actionable/u);
  });

  it('summarizes job-level coverage independently from generation budget usage', () => {
    const actionable = proposalRow(0);
    const coverage = createOrganizeJobRunCoverageSummary({
      total: 4,
      analyzedFrozenPositions: [
        { frozenIndex: 0, repositoryId: actionable.repositoryId, classification: 'actionable' },
        { frozenIndex: 1, repositoryId: 'owner/repo-1', classification: 'non_actionable' },
        { frozenIndex: 2, repositoryId: 'owner/repo-2', classification: 'non_actionable' },
      ],
      actionableProposalRows: [actionable],
      nonActionableAnalysisOutcomes: [
        { frozenIndex: 1, repositoryId: 'owner/repo-1', kind: 'unchanged' },
        { frozenIndex: 2, repositoryId: 'owner/repo-2', kind: 'analysis_failed' },
      ],
    });
    assert.deepEqual(coverage, {
      total: 4,
      analyzed: 3,
      actionable: 1,
      unchanged: 1,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: 1,
    });
    assert.throws(() => validateOrganizeJobRunCoverageSummary({
      ...coverage,
      analyzed: 4,
    }), /exactly partition/u);
  });

  it('rejects gaps and overlapping analysis classifications', () => {
    const first = proposalRow(0);
    const base = {
      consumedRange: { startFrozenIndex: 0, endFrozenIndexExclusive: 1 },
      analyzedFrozenPositions: [
        { frozenIndex: 0, repositoryId: first.repositoryId, classification: 'actionable' as const },
      ],
      nonActionableAnalysisOutcomes: [],
      actionableProposalRows: [first],
    };
    assert.throws(() => validateRowUniverses({
      ...base,
      analyzedFrozenPositions: [{ ...base.analyzedFrozenPositions[0], frozenIndex: 1 }],
    }), /contiguous/u);
    assert.throws(() => validateRowUniverses({
      ...base,
      nonActionableAnalysisOutcomes: [{
        frozenIndex: 0,
        repositoryId: first.repositoryId,
        kind: 'unchanged',
      }],
    }), /exactly one/u);
  });

  it('accepts proposal row 101 without imposing a transient Apply cap', () => {
    const rows = Array.from({ length: 101 }, (_, index) => proposalRow(index));
    validateOrganizeProposal({
      version: 1,
      proposalId,
      runId,
      generation: 2,
      rows,
    });
  });
});

describe('first-use disclosure and messaging identities', () => {
  it('freezes the provider/origin-bound version, 6+3 categories, and key-header exception', () => {
    assert.equal(AGENT_DATA_DISCLOSURE_VERSION, 2);
    assert.equal(AGENT_SENT_TASK_DATA_CATEGORIES.length, 6);
    assert.equal(AGENT_NOT_SENT_AS_TASK_DATA_CATEGORIES.length, 3);
    assert.deepEqual(AGENT_PROVIDER_KEY_AUTHORIZATION_EXCEPTION, {
      category: 'selected_provider_api_key_authorization_header',
      destination: 'bound_provider_origin_only',
      modelVisible: false,
      logged: false,
    });
    const acceptance = createAgentDataDisclosureAcceptance({
      provider: 'openai',
      origin: 'https://api.openai.com',
      acceptedAt: 1,
    });
    validateAgentDataDisclosureAcceptance(acceptance);
    assert.equal(isDisclosureAcceptedFor(acceptance, 'openai', 'https://api.openai.com'), true);
    assert.equal(isDisclosureAcceptedFor(acceptance, 'openrouter', 'https://api.openai.com'), false);
    assert.equal(isDisclosureAcceptedFor(acceptance, 'openai', 'https://api.openai.com/v1'), false);
  });

  it('validates preflight ready/no-work and analysis event identities', () => {
    const preflightRequest = {
      type: 'requestBgsmOrganizeJobPreflight' as const,
      controllerId,
      sessionId: 'session-1',
      requestId: 'request-1',
      taskInstruction: 'Organize every starred repository.',
    };
    validateBgsmOrganizeJobMessageIdentity(preflightRequest);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      ...preflightRequest,
      candidateContract: { kind: 'selected_repository', selectedRepositoryIdHint: 'owner/repo' },
    } as unknown as BgsmOrganizeJobPortMessage), /Unexpected BGSM OrganizeJobRun message keys/u);

    const preflightReady: BgsmOrganizeJobPortMessage = {
      type: 'bgsmOrganizeJobRunPreflightResult',
      status: 'ready',
      controllerId,
      sessionId: 'session-1',
      requestId: 'request-1',
      preflightToken: parsePreflightToken('preflight:v1:opaque'),
      label: 'Current view',
      count: 4,
    };
    validateBgsmOrganizeJobMessageIdentity(preflightReady);
    const noWork: BgsmOrganizeJobPortMessage = {
      ...preflightReady,
      status: 'no_work',
      preflightToken: null,
      count: 0,
    };
    validateBgsmOrganizeJobMessageIdentity(noWork);
    const progress: BgsmOrganizeJobPortMessage = {
      type: 'bgsmOrganizeJobAnalysisProgress',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      processed: 2,
      total: 4,
    };
    validateBgsmOrganizeJobMessageIdentity(progress);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      ...progress,
      processed: 5,
    }), /cannot exceed/u);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      ...progress,
      debug: true,
    } as unknown as BgsmOrganizeJobPortMessage), /Unexpected BGSM OrganizeJobRun message keys/u);
    validateBgsmOrganizeJobMessageIdentity({
      type: 'cancelBgsmOrganizeJobPreflight',
      controllerId,
      sessionId: 'session-1',
      requestId: 'request-1',
    });
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      ...noWork,
      count: 1,
    } as BgsmOrganizeJobPortMessage), /inconsistent/u);

    const event = {
      type: 'run_state_changed' as const,
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      eventId: 'event-1',
      state: 'analyzing' as const,
    };
    validateOrganizeJobRunEvent(event);
    validateBgsmOrganizeJobMessageIdentity({ type: 'bgsmOrganizeJobRunEvent', event });
    assert.throws(() => validateOrganizeJobRunEvent({
      type: 'run_state_changed',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      eventId: 'event-2',
      state: 'completed',
    }), /dedicated reason contract/u);
    validateOrganizeJobRunEvent({
      type: 'run_terminal',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      eventId: 'event-3',
      state: 'failed',
      reason: 'timeout',
    });
    assert.throws(() => validateOrganizeJobRunEvent({
      type: 'run_terminal',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      eventId: 'event-4',
      state: 'completed',
      reason: 'timeout',
    }), /inconsistent/u);
  });

  it('binds proposal-summary events to the durable paged-review identity and count', () => {
    const event = {
      type: 'proposal_summary_ready' as const,
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      eventId: 'event-proposal-1',
      state: 'review' as const,
      proposalId,
      actionableCount: 2,
      nonActionableCount: 3,
      proposalReviewSummary: {
        version: 1 as const,
        proposalId,
        runId,
        generation: 2,
        totalRows: 2,
      },
      coverage: {
        total: 5,
        analyzed: 5,
        actionable: 2,
        unchanged: 3,
        insufficientEvidence: 0,
        missing: 0,
        tombstoned: 0,
        analysisFailed: 0,
      },
    };
    validateOrganizeJobRunEvent(event);
    validateBgsmOrganizeJobMessageIdentity({ type: 'bgsmOrganizeJobRunEvent', event });
    assert.throws(() => validateOrganizeJobRunEvent({ ...event, actionableCount: 1 }), /must match/u);
    assert.throws(() => validateOrganizeJobRunEvent({
      ...event,
      proposalId: parseProposalId('proposal:v1:other'),
    }), /must match/u);

    const manyRows = 101;
    validateOrganizeJobRunEvent({
      ...event,
      eventId: 'event-proposal-many',
      actionableCount: manyRows,
      nonActionableCount: 0,
      proposalReviewSummary: { ...event.proposalReviewSummary, totalRows: manyRows },
      coverage: {
        total: manyRows,
        analyzed: manyRows,
        actionable: manyRows,
        unchanged: 0,
        insufficientEvidence: 0,
        missing: 0,
        tombstoned: 0,
        analysisFailed: 0,
      },
    });
  });

  it('requires generation-gated result subsets and consistent terminal snapshots', () => {
    validateLaunchCandidateContract({ kind: 'result_subset', sourceRunId: runId, sourceGeneration: 2 });
    assert.throws(
      () => validateLaunchCandidateContract({ kind: 'result_subset', sourceRunId: runId }),
      /Unexpected contract keys|sourceGeneration/u,
    );
    const frozenScope = createFrozenScope({
      kind: 'current_view',
      label: 'Current view',
      filterSnapshot: '',
      repositoryIds: ['owner/repo-0'],
      capturedAt: 10,
      fingerprint: parseScopeFingerprintV1(`fs:v1:${DIGEST}`),
    });
    const baseSnapshot = {
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      state: 'frozen' as const,
      terminalReason: null,
      frozenScope: projectFrozenScope(frozenScope),
      budget: createProductionRunBudget(),
      usage: createEmptyRunBudgetUsage(),
      proposalId: null,
      continuationCursor: null,
    };
    validateOrganizeJobRunSnapshot(baseSnapshot);
    const blockedCoverage = {
      total: 1,
      analyzed: 1,
      actionable: 0,
      unchanged: 0,
      insufficientEvidence: 0,
      missing: 0,
      tombstoned: 0,
      analysisFailed: 1,
    } as const;
    validateOrganizeJobRunEvent({
      type: 'run_state_changed',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      eventId: 'event-analysis-blocked',
      state: 'analysis_blocked',
    });
    validateOrganizeJobRunSnapshot({
      ...baseSnapshot,
      state: 'analysis_blocked',
      terminalReason: 'analysis_failed',
      coverage: blockedCoverage,
    });
    assert.throws(() => validateOrganizeJobRunSnapshot({
      ...baseSnapshot,
      state: 'review',
      terminalReason: null,
      coverage: blockedCoverage,
      proposalId,
      proposalReviewSummary: {
        version: 1,
        proposalId,
        runId,
        generation: 2,
        totalRows: 1,
      },
    }), /complete and failure-free/u);
    const summary = {
      version: 1 as const,
      proposalId,
      runId,
      generation: 2,
      totalRows: 1,
    };
    validateOrganizeJobRunSnapshot({
      ...baseSnapshot,
      state: 'review',
      proposalId,
      proposalReviewSummary: summary,
      coverage: {
        ...blockedCoverage,
        actionable: 1,
        analysisFailed: 0,
      },
    });
    assert.throws(() => validateOrganizeJobRunSnapshot({
      ...baseSnapshot,
      state: 'review',
      proposalId,
    }), /if and only if|require review authority/u);
    assert.throws(() => validateOrganizeJobRunSnapshot({
      ...baseSnapshot,
      proposalId,
      proposalReviewSummary: summary,
    }), /Pre-review/u);
    validateOrganizeJobRunSnapshot({
      ...baseSnapshot,
      state: 'budget_exhausted',
      terminalReason: 'provider_attempts',
      continuationCursor: parseContinuationCursorToken('cursor:v1:remaining'),
    });
    assert.throws(() => validateOrganizeJobRunSnapshot({
      ...baseSnapshot,
      state: 'review',
      proposalId,
      proposalReviewSummary: {
        ...summary,
        runId: parseRunId('run:v1:other'),
      },
    }), /identity is inconsistent/u);
  });

  it('bounds durable review transport and excludes storage-only row fields', () => {
    const presentation = {
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      jobId: 'organize-job:v1:contracts',
      revision: 4,
      status: 'review' as const,
      scopeLabel: 'All stars',
      scopeCount: 3,
      capturedAt: 1,
      proposalId,
      coverage: {
        total: 3,
        analyzed: 3,
        actionable: 2,
        unchanged: 1,
        insufficientEvidence: 0,
        missing: 0,
        tombstoned: 0,
        analysisFailed: 0,
      },
      selectedRepositories: 2,
      selectedActions: 2,
      apply: null,
    };
    validateBgsmOrganizeJobMessageIdentity({
      type: 'bgsmOrganizeJobState',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      presentation,
    });
    const page: BgsmOrganizeJobPortMessage = {
      type: 'bgsmOrganizeReviewPage',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      requestId: 'page-0',
      jobId: presentation.jobId,
      revision: presentation.revision,
      proposalId,
      totalRows: 2,
      selectedRepositories: 2,
      selectedActions: 2,
      rowOffset: 0,
      rows: [{
        position: 0,
        proposalRowId: `${proposalId}:row:0`,
        repositoryId: 'owner/repo-0',
        proposedActions: [{ kind: 'add_existing_tag', tag: 'TypeScript', evidence: 'Topic' }],
        selected: true,
      }],
      nextRowOffset: 1,
    };
    validateBgsmOrganizeJobMessageIdentity(page);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      ...page,
      rows: [{ ...page.rows[0], sourceFingerprint: `sf:v1:${'x'.repeat(43)}` }],
    } as unknown as BgsmOrganizeJobPortMessage), /Unexpected contract keys/u);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      type: 'updateBgsmOrganizeSelection',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      requestId: 'too-many',
      jobId: presentation.jobId,
      expectedRevision: presentation.revision,
      rowOffset: 0,
      selections: Array.from({ length: 101 }, (_, position) => ({ position, selected: true })),
    }), /1 to 100/u);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      type: 'setAllBgsmOrganizeSelections',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      requestId: 'invalid-select-all',
      jobId: presentation.jobId,
      expectedRevision: presentation.revision,
      rowOffset: 0,
      selected: 'yes',
    } as unknown as BgsmOrganizeJobPortMessage), /select-all value must be boolean/u);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      type: 'requestBgsmOrganizeReceiptPage',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      requestId: 'invalid-filter',
      jobId: presentation.jobId,
      applyId: 'organize-apply:v1:contracts',
      rowOffset: 0,
      limit: 100,
      filter: 'bogus',
    } as unknown as BgsmOrganizeJobPortMessage), /receipt filter is invalid/u);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      type: 'bgsmOrganizeJobState',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      presentation: { ...presentation, status: 'unknown' },
    } as unknown as BgsmOrganizeJobPortMessage), /presentation status is invalid/u);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      ...page,
      totalRows: 2,
      rows: [page.rows[0], page.rows[0]],
      nextRowOffset: null,
    } as unknown as BgsmOrganizeJobPortMessage), /canonical and unique/u);
    assert.throws(() => validateBgsmOrganizeJobMessageIdentity({
      type: 'bgsmOrganizeReceiptPage',
      controllerId,
      sessionId: 'session-1',
      runId,
      generation: 2,
      requestId: 'invalid-receipt-reason',
      applyId: 'organize-apply:v1:contracts',
      rowOffset: 0,
      rows: [{
        position: 0,
        proposalRowId: `${proposalId}:row:0`,
        repositoryId: 'owner/repo-0',
        outcome: 'changed',
        reason: 'no_change',
      }],
      nextRowOffset: null,
    }), /outcome and reason are inconsistent/u);
  });
});

describe('OrganizeJobRun dependency freeze', () => {
  it('keeps app-owned contracts independent from generic suspended-turn/checkpoint modules', () => {
    for (const relativePath of [
      '../../src/bgsm-agent/policy.ts',
      '../../src/bgsm-agent/scope.ts',
      '../../src/bgsm-agent/proposal.ts',
      '../../src/bgsm-agent/receipt.ts',
      '../../src/bgsm-agent/disclosure.ts',
      '../../src/bgsm-agent/events.ts',
    ]) {
      const source = readSource(relativePath);
      assert.doesNotMatch(source, /suspended-turn|interaction-token|candidateSetToken|scope_selector/u);
    }
  });
});

function assertPreflightType(_value: PreflightToken): void {}
function assertContinuationType(_value: ContinuationCursorToken): void {}

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}
