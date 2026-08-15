import {
  TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT,
  FROZEN_SCOPE_PAGE_HARD_LIMIT,
  MAX_SEMANTIC_EVIDENCE_BYTES,
  MAX_SEMANTIC_TAG_NAME_BYTES,
  PROPOSAL_REVIEW_PAGE_HARD_LIMIT,
} from './policy';
import { isProposalId, isRunId, type ProposalId, type RunId } from './identity';
import { isScopeFingerprint, type ScopeFingerprint } from './scope';

declare const fingerprintBrand: unique symbol;

export type SourceFingerprint = string & {
  readonly [fingerprintBrand]: 'SourceFingerprint';
};
export type TaxonomyFingerprint = string & {
  readonly [fingerprintBrand]: 'TaxonomyFingerprint';
};

export const SOURCE_FINGERPRINT_PREFIX = 'sf:v1:';
export const TAXONOMY_FINGERPRINT_PREFIX = 'tf:v1:';

export const PROPOSAL_ACTION_KINDS = Object.freeze([
  'add_existing_tag',
  'propose_new_tag',
] as const);
export type ProposalActionKind = typeof PROPOSAL_ACTION_KINDS[number];

export const ORGANIZE_PROPOSAL_ANALYZER_TOOL_NAME = 'submit_semantic_tag_batch_proposal';
export const MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES = 1_048_576;
/** @deprecated The byte boundary applies to one review page, not the full proposal. */
export const MAX_PROPOSAL_REVIEW_SERIALIZED_BYTES = MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES;
export const ANALYZER_CLASSIFICATION_KINDS = Object.freeze([
  'add_existing_tag',
  'propose_new_tag',
  'unchanged',
  'insufficient_evidence',
] as const);
export type AnalyzerClassificationKind = typeof ANALYZER_CLASSIFICATION_KINDS[number];

export const NON_ACTIONABLE_OUTCOME_KINDS = Object.freeze([
  'missing',
  'tombstoned',
  'unchanged',
  'insufficient_evidence',
  'analysis_failed',
] as const);
export type NonActionableOutcomeKind = typeof NON_ACTIONABLE_OUTCOME_KINDS[number];

export type ProposalAction = Readonly<{
  kind: ProposalActionKind;
  tag: string;
  evidence: string;
}>;

export type AnalyzerNonActionableClassification = Readonly<{
  kind: 'unchanged' | 'insufficient_evidence';
  evidence: string;
}>;

export type AnalyzerClassification = ProposalAction | AnalyzerNonActionableClassification;

export type AnalyzerBatchProposalRow = Readonly<{
  frozenIndex: number;
  repositoryId: string;
  sourceFingerprint: SourceFingerprint;
  classifications: readonly AnalyzerClassification[];
}>;

export type AnalyzerBatchProposal = Readonly<{
  version: 1;
  runId: RunId;
  generation: number;
  scopeFingerprint: ScopeFingerprint;
  rows: readonly AnalyzerBatchProposalRow[];
}>;

export type AnalyzedFrozenPosition = Readonly<{
  frozenIndex: number;
  repositoryId: string;
  classification: 'actionable' | 'non_actionable';
}>;

export type NonActionableAnalysisOutcome = Readonly<{
  frozenIndex: number;
  repositoryId: string;
  kind: NonActionableOutcomeKind;
}>;

export type ActionableProposalRow = Readonly<{
  proposalRowId: string;
  frozenIndex: number;
  repositoryId: string;
  sourceFingerprint: SourceFingerprint;
  taxonomyFingerprint: TaxonomyFingerprint;
  actions: readonly ProposalAction[];
}>;

export type OrganizeProposal = Readonly<{
  version: 1;
  proposalId: ProposalId;
  runId: RunId;
  generation: number;
  rows: readonly ActionableProposalRow[];
}>;

export type ProposalReviewRow = Readonly<{
  proposalRowId: string;
  frozenIndex: number;
  repositoryId: string;
  proposedActions: readonly ProposalAction[];
  preselected: boolean;
}>;

export type ProposalReviewProjection = Readonly<{
  version: 1;
  proposalId: ProposalId;
  runId: RunId;
  generation: number;
  rows: readonly ProposalReviewRow[];
}>;

export type ProposalReviewSummary = Readonly<{
  version: 1;
  proposalId: ProposalId;
  runId: RunId;
  generation: number;
  totalRows: number;
}>;

export type ProposalReviewPageProjection = Readonly<{
  version: 1;
  proposalId: ProposalId;
  runId: RunId;
  generation: number;
  totalRows: number;
  rowOffset: number;
  rows: readonly ProposalReviewRow[];
  nextRowOffset: number | null;
}>;

export type CanonicalProposalReviewProjection = Readonly<{
  projection: ProposalReviewProjection;
  serialized: string;
  byteLength: number;
}>;

export type CanonicalProposalReviewPageProjection = Readonly<{
  projection: ProposalReviewPageProjection;
  serialized: string;
  byteLength: number;
}>;

export type RowUniverseSnapshot = Readonly<{
  consumedRange: Readonly<{ startFrozenIndex: number; endFrozenIndexExclusive: number }>;
  analyzedFrozenPositions: readonly AnalyzedFrozenPosition[];
  nonActionableAnalysisOutcomes: readonly NonActionableAnalysisOutcome[];
  actionableProposalRows: readonly ActionableProposalRow[];
}>;

export function parseSourceFingerprint(value: string): SourceFingerprint {
  if (!isSourceFingerprint(value)) {
    throw new TypeError('Source fingerprint must be sf:v1:<base64url SHA-256>.');
  }
  return value;
}

export function parseTaxonomyFingerprint(value: string): TaxonomyFingerprint {
  if (!isTaxonomyFingerprint(value)) {
    throw new TypeError('Taxonomy fingerprint must be tf:v1:<base64url SHA-256>.');
  }
  return value;
}

export function isSourceFingerprint(value: unknown): value is SourceFingerprint {
  return typeof value === 'string' && /^sf:v1:[A-Za-z0-9_-]{43}$/u.test(value);
}

export function isTaxonomyFingerprint(value: unknown): value is TaxonomyFingerprint {
  return typeof value === 'string' && /^tf:v1:[A-Za-z0-9_-]{43}$/u.test(value);
}

export function validateOrganizeProposal(value: unknown): asserts value is OrganizeProposal {
  if (!isRecord(value)) throw new TypeError('OrganizeProposal must be an object.');
  assertExactKeys(value, ['version', 'proposalId', 'runId', 'generation', 'rows']);
  if (value.version !== 1) throw new TypeError('OrganizeProposal version must be 1.');
  if (!isProposalId(value.proposalId)) throw new TypeError('OrganizeProposal proposalId is malformed.');
  if (!isRunId(value.runId)) throw new TypeError('OrganizeProposal runId is malformed.');
  assertNonnegativeSafeInteger(value.generation, 'OrganizeProposal generation');
  if (!Array.isArray(value.rows)) throw new TypeError('OrganizeProposal rows must be an array.');
  const repositoryIds = new Set<string>();
  const rowIds = new Set<string>();
  for (const row of value.rows) {
    validateActionableProposalRow(row);
    if (repositoryIds.has(row.repositoryId) || rowIds.has(row.proposalRowId)) {
      throw new TypeError('OrganizeProposal rows must identify unique repositories and proposal rows.');
    }
    repositoryIds.add(row.repositoryId);
    rowIds.add(row.proposalRowId);
  }
}

export function canonicalizeProposalReviewProjection(
  value: unknown,
): CanonicalProposalReviewProjection {
  validateProposalReviewProjectionStructure(value);
  const serialized = JSON.stringify(value);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  const projection: unknown = JSON.parse(serialized);
  validateProposalReviewProjectionStructure(projection);
  return Object.freeze({
    projection: deepFreeze(projection),
    serialized,
    byteLength,
  });
}

export function createProposalReviewSummary(
  value: ProposalReviewProjection,
): ProposalReviewSummary {
  validateProposalReviewProjectionStructure(value);
  return Object.freeze({
    version: 1,
    proposalId: value.proposalId,
    runId: value.runId,
    generation: value.generation,
    totalRows: value.rows.length,
  });
}

export function validateProposalReviewSummary(
  value: unknown,
): asserts value is ProposalReviewSummary {
  if (!isRecord(value)) throw new TypeError('Proposal review summary must be an object.');
  assertExactKeys(value, ['version', 'proposalId', 'runId', 'generation', 'totalRows']);
  if (value.version !== 1) throw new TypeError('Proposal review summary version must be 1.');
  if (!isProposalId(value.proposalId)) throw new TypeError('Proposal review summary proposalId is malformed.');
  if (!isRunId(value.runId)) throw new TypeError('Proposal review summary runId is malformed.');
  assertNonnegativeSafeInteger(value.generation, 'Proposal review summary generation');
  assertPositiveSafeInteger(value.totalRows, 'Proposal review summary totalRows');
}

export function canonicalizeProposalReviewPageProjection(
  value: unknown,
): CanonicalProposalReviewPageProjection {
  validateProposalReviewPageProjectionStructure(value);
  const serialized = JSON.stringify(value);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES) {
    throw new RangeError(
      `Proposal review page exceeds ${MAX_PROPOSAL_REVIEW_PAGE_SERIALIZED_BYTES} UTF-8 bytes.`,
    );
  }
  const projection: unknown = JSON.parse(serialized);
  validateProposalReviewPageProjectionStructure(projection);
  return Object.freeze({
    projection: deepFreeze(projection),
    serialized,
    byteLength,
  });
}

export function validateProposalReviewPageProjection(
  value: unknown,
): asserts value is ProposalReviewPageProjection {
  canonicalizeProposalReviewPageProjection(value);
}

export function paginateProposalReviewProjection(
  value: ProposalReviewProjection,
  rowOffset: number,
  requestedLimit = PROPOSAL_REVIEW_PAGE_HARD_LIMIT,
): CanonicalProposalReviewPageProjection {
  validateProposalReviewProjectionStructure(value);
  assertNonnegativeSafeInteger(rowOffset, 'Proposal review page rowOffset');
  assertPositiveSafeInteger(requestedLimit, 'Proposal review page requestedLimit');
  if (requestedLimit > PROPOSAL_REVIEW_PAGE_HARD_LIMIT) {
    throw new RangeError(`Proposal review page cannot exceed ${PROPOSAL_REVIEW_PAGE_HARD_LIMIT} rows.`);
  }
  if (rowOffset >= value.rows.length) {
    throw new RangeError('Proposal review page rowOffset must identify an available row.');
  }

  let admitted: CanonicalProposalReviewPageProjection | null = null;
  const maximumEnd = Math.min(value.rows.length, rowOffset + requestedLimit);
  for (let end = rowOffset + 1; end <= maximumEnd; end += 1) {
    const candidate = createProposalReviewPageValue(value, rowOffset, end);
    try {
      admitted = canonicalizeProposalReviewPageProjection(candidate);
    } catch (error) {
      if (error instanceof RangeError && admitted !== null) break;
      throw error;
    }
  }
  if (!admitted) {
    throw new RangeError('One proposal review row cannot fit the review page byte boundary.');
  }
  return admitted;
}

export function validateProposalReviewProjection(
  value: unknown,
): asserts value is ProposalReviewProjection {
  canonicalizeProposalReviewProjection(value);
}

export function validateProposalReviewProjectionAgainstActionableRows(
  projection: ProposalReviewProjection,
  actionableRows: readonly ActionableProposalRow[],
): void {
  validateProposalReviewProjection(projection);
  if (projection.rows.length !== actionableRows.length) {
    throw new TypeError('Proposal review rows must equal the actionable proposal universe.');
  }
  projection.rows.forEach((row, index) => {
    const actionable = actionableRows[index];
    if (
      !actionable ||
      row.proposalRowId !== actionable.proposalRowId ||
      row.frozenIndex !== actionable.frozenIndex ||
      row.repositoryId !== actionable.repositoryId ||
      !sameActions(row.proposedActions, actionable.actions)
    ) {
      throw new TypeError('Proposal review rows must preserve actionable row identity, order, and actions.');
    }
  });
}

export function validateProposalReviewPageAgainstActionableRows(
  page: ProposalReviewPageProjection,
  actionableRows: readonly ActionableProposalRow[],
): void {
  validateProposalReviewPageProjection(page);
  if (page.totalRows !== actionableRows.length) {
    throw new TypeError('Proposal review page totalRows must equal the actionable proposal universe.');
  }
  page.rows.forEach((row, index) => {
    const actionable = actionableRows[page.rowOffset + index];
    if (
      !actionable ||
      row.proposalRowId !== actionable.proposalRowId ||
      row.frozenIndex !== actionable.frozenIndex ||
      row.repositoryId !== actionable.repositoryId ||
      !sameActions(row.proposedActions, actionable.actions)
    ) {
      throw new TypeError('Proposal review page must preserve its actionable row slice.');
    }
  });
}

export function validateAnalyzerBatchProposal(
  value: unknown,
): asserts value is AnalyzerBatchProposal {
  if (!isRecord(value)) throw new TypeError('Analyzer batch proposal must be an object.');
  assertExactKeys(value, ['version', 'runId', 'generation', 'scopeFingerprint', 'rows']);
  if (value.version !== 1) throw new TypeError('Analyzer batch proposal version must be 1.');
  if (!isRunId(value.runId)) throw new TypeError('Analyzer batch proposal runId is malformed.');
  assertNonnegativeSafeInteger(value.generation, 'Analyzer batch proposal generation');
  if (!isScopeFingerprint(value.scopeFingerprint)) {
    throw new TypeError('Analyzer batch proposal scopeFingerprint is malformed.');
  }
  if (
    !Array.isArray(value.rows) ||
    value.rows.length === 0 ||
    value.rows.length > FROZEN_SCOPE_PAGE_HARD_LIMIT
  ) {
    throw new RangeError('Analyzer batch proposal rows must fit one nonempty FrozenScope window.');
  }
  const indices = new Set<number>();
  const repositoryIds = new Set<string>();
  for (const row of value.rows) {
    validateAnalyzerBatchProposalRow(row);
    if (indices.has(row.frozenIndex) || repositoryIds.has(row.repositoryId)) {
      throw new TypeError('Analyzer batch proposal rows must be unique.');
    }
    indices.add(row.frozenIndex);
    repositoryIds.add(row.repositoryId);
  }
}

export function validateActionableProposalRow(
  value: unknown,
): asserts value is ActionableProposalRow {
  if (!isRecord(value)) throw new TypeError('Actionable proposal row must be an object.');
  assertExactKeys(value, [
    'proposalRowId',
    'frozenIndex',
    'repositoryId',
    'sourceFingerprint',
    'taxonomyFingerprint',
    'actions',
  ]);
  assertTrimmedNonempty(value.proposalRowId, 'proposalRowId');
  assertNonnegativeSafeInteger(value.frozenIndex, 'frozenIndex');
  assertTrimmedNonempty(value.repositoryId, 'repositoryId');
  if (!isSourceFingerprint(value.sourceFingerprint)) {
    throw new TypeError('Actionable proposal source fingerprint is malformed.');
  }
  if (!isTaxonomyFingerprint(value.taxonomyFingerprint)) {
    throw new TypeError('Actionable proposal taxonomy fingerprint is malformed.');
  }
  validateActions(value.actions, 'actions');
}

export function validateRowUniverses(value: RowUniverseSnapshot): void {
  const { startFrozenIndex, endFrozenIndexExclusive } = value.consumedRange;
  assertNonnegativeSafeInteger(startFrozenIndex, 'consumedRange.startFrozenIndex');
  assertNonnegativeSafeInteger(endFrozenIndexExclusive, 'consumedRange.endFrozenIndexExclusive');
  if (endFrozenIndexExclusive < startFrozenIndex) {
    throw new TypeError('Consumed range end cannot precede its start.');
  }
  const expectedLength = endFrozenIndexExclusive - startFrozenIndex;
  if (value.analyzedFrozenPositions.length !== expectedLength) {
    throw new TypeError('Analyzed positions must equal the consumed contiguous prefix.');
  }

  const analyzedByIndex = new Map<number, AnalyzedFrozenPosition>();
  value.analyzedFrozenPositions.forEach((position, offset) => {
    const expectedIndex = startFrozenIndex + offset;
    validateAnalyzedPosition(position);
    if (position.frozenIndex !== expectedIndex) {
      throw new TypeError('Analyzed positions must be ordered and contiguous.');
    }
    analyzedByIndex.set(position.frozenIndex, position);
  });

  const nonActionableByIndex = new Map<number, NonActionableAnalysisOutcome>();
  for (const outcome of value.nonActionableAnalysisOutcomes) {
    validateNonActionableOutcome(outcome);
    if (nonActionableByIndex.has(outcome.frozenIndex)) {
      throw new TypeError('A FrozenScope position cannot have two non-actionable outcomes.');
    }
    nonActionableByIndex.set(outcome.frozenIndex, outcome);
  }

  const proposalRowIds = new Set<string>();
  const proposalByIndex = new Map<number, ActionableProposalRow>();
  const proposalRepositoryIds = new Set<string>();
  for (const row of value.actionableProposalRows) {
    validateActionableProposalRow(row);
    if (
      proposalRowIds.has(row.proposalRowId) ||
      proposalByIndex.has(row.frozenIndex) ||
      proposalRepositoryIds.has(row.repositoryId)
    ) {
      throw new TypeError('Actionable proposal universe contains duplicate rows.');
    }
    proposalRowIds.add(row.proposalRowId);
    proposalByIndex.set(row.frozenIndex, row);
    proposalRepositoryIds.add(row.repositoryId);
  }

  for (const [index, analyzed] of analyzedByIndex) {
    const nonActionable = nonActionableByIndex.get(index);
    const actionable = proposalByIndex.get(index);
    if ((nonActionable ? 1 : 0) + (actionable ? 1 : 0) !== 1) {
      throw new TypeError('Every analyzed position must be exactly one actionable or non-actionable row.');
    }
    const classified = nonActionable ?? actionable;
    if (
      classified?.repositoryId !== analyzed.repositoryId ||
      analyzed.classification !== (nonActionable ? 'non_actionable' : 'actionable')
    ) {
      throw new TypeError('Analyzed position classification does not match its universe row.');
    }
  }
  for (const index of [...nonActionableByIndex.keys(), ...proposalByIndex.keys()]) {
    if (!analyzedByIndex.has(index)) {
      throw new TypeError('Classified rows must belong to the analyzed contiguous prefix.');
    }
  }
}

function validateAnalyzedPosition(value: unknown): asserts value is AnalyzedFrozenPosition {
  if (!isRecord(value)) throw new TypeError('Analyzed position must be an object.');
  assertExactKeys(value, ['frozenIndex', 'repositoryId', 'classification']);
  assertNonnegativeSafeInteger(value.frozenIndex, 'analyzed frozenIndex');
  assertTrimmedNonempty(value.repositoryId, 'analyzed repositoryId');
  if (value.classification !== 'actionable' && value.classification !== 'non_actionable') {
    throw new TypeError('Analyzed position classification is invalid.');
  }
}

function validateNonActionableOutcome(
  value: unknown,
): asserts value is NonActionableAnalysisOutcome {
  if (!isRecord(value)) throw new TypeError('Non-actionable outcome must be an object.');
  assertExactKeys(value, ['frozenIndex', 'repositoryId', 'kind']);
  assertNonnegativeSafeInteger(value.frozenIndex, 'non-actionable frozenIndex');
  assertTrimmedNonempty(value.repositoryId, 'non-actionable repositoryId');
  if (!NON_ACTIONABLE_OUTCOME_KINDS.includes(value.kind as NonActionableOutcomeKind)) {
    throw new TypeError('Non-actionable outcome kind is invalid.');
  }
}

function validateActions(value: unknown, field: string): asserts value is readonly ProposalAction[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a nonempty action array.`);
  }
  if (value.length > TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT) {
    throw new RangeError(`${field} exceeds five tag additions.`);
  }
  const normalizedTags = new Set<string>();
  for (const action of value) {
    if (!isRecord(action)) throw new TypeError(`${field} action must be an object.`);
    assertExactKeys(action, ['kind', 'tag', 'evidence']);
    if (!PROPOSAL_ACTION_KINDS.includes(action.kind as ProposalActionKind)) {
      throw new TypeError(`${field} action kind is invalid.`);
    }
    assertTrimmedNonempty(action.tag, `${field} tag`);
    assertNormalizedTag(action.tag, `${field} tag`);
    assertUtf8Bound(action.tag, MAX_SEMANTIC_TAG_NAME_BYTES, `${field} tag`);
    assertTrimmedNonempty(action.evidence, `${field} evidence`);
    assertUtf8Bound(action.evidence, MAX_SEMANTIC_EVIDENCE_BYTES, `${field} evidence`);
    const normalized = action.tag.normalize('NFKC').toLocaleLowerCase('en-US');
    if (normalizedTags.has(normalized)) {
      throw new TypeError(`${field} tags must be normalized-unique.`);
    }
    normalizedTags.add(normalized);
  }
}

function validateAnalyzerBatchProposalRow(
  value: unknown,
): asserts value is AnalyzerBatchProposalRow {
  if (!isRecord(value)) throw new TypeError('Analyzer batch proposal row must be an object.');
  assertExactKeys(value, ['frozenIndex', 'repositoryId', 'sourceFingerprint', 'classifications']);
  assertNonnegativeSafeInteger(value.frozenIndex, 'Analyzer row frozenIndex');
  assertTrimmedNonempty(value.repositoryId, 'Analyzer row repositoryId');
  if (!isSourceFingerprint(value.sourceFingerprint)) {
    throw new TypeError('Analyzer row sourceFingerprint is malformed.');
  }
  if (!Array.isArray(value.classifications) || value.classifications.length === 0) {
    throw new TypeError('Analyzer row classifications must be nonempty.');
  }
  const nonActionable = value.classifications.filter((entry) =>
    isRecord(entry) && (entry.kind === 'unchanged' || entry.kind === 'insufficient_evidence'));
  if (nonActionable.length > 0) {
    if (value.classifications.length !== 1) {
      throw new TypeError('Unchanged or insufficient-evidence rows cannot contain tag actions.');
    }
    const entry = nonActionable[0];
    if (!entry) throw new TypeError('Analyzer non-actionable classification is missing.');
    assertExactKeys(entry, ['kind', 'evidence']);
    assertTrimmedNonempty(entry.evidence, 'Analyzer classification evidence');
    assertUtf8Bound(
      entry.evidence,
      MAX_SEMANTIC_EVIDENCE_BYTES,
      'Analyzer classification evidence',
    );
    return;
  }
  validateActions(value.classifications, 'Analyzer classifications');
}

function validateProposalReviewProjectionStructure(
  value: unknown,
): asserts value is ProposalReviewProjection {
  if (!isRecord(value)) throw new TypeError('Proposal review projection must be an object.');
  assertExactKeys(value, ['version', 'proposalId', 'runId', 'generation', 'rows']);
  if (value.version !== 1) throw new TypeError('Proposal review projection version must be 1.');
  if (!isProposalId(value.proposalId)) throw new TypeError('Proposal review proposalId is malformed.');
  if (!isRunId(value.runId)) throw new TypeError('Proposal review runId is malformed.');
  assertNonnegativeSafeInteger(value.generation, 'Proposal review generation');
  if (!Array.isArray(value.rows) || value.rows.length === 0) {
    throw new TypeError('Proposal review rows must be a nonempty array.');
  }
  let previousFrozenIndex = -1;
  const proposalRowIds = new Set<string>();
  const repositoryIds = new Set<string>();
  for (const row of value.rows) {
    validateProposalReviewRow(row);
    if (row.frozenIndex <= previousFrozenIndex) {
      throw new TypeError('Proposal review rows must be ordered by strictly increasing FrozenScope index.');
    }
    if (proposalRowIds.has(row.proposalRowId) || repositoryIds.has(row.repositoryId)) {
      throw new TypeError('Proposal review rows must have unique proposal and repository identities.');
    }
    previousFrozenIndex = row.frozenIndex;
    proposalRowIds.add(row.proposalRowId);
    repositoryIds.add(row.repositoryId);
  }
}

function validateProposalReviewPageProjectionStructure(
  value: unknown,
): asserts value is ProposalReviewPageProjection {
  if (!isRecord(value)) throw new TypeError('Proposal review page must be an object.');
  assertExactKeys(value, [
    'version',
    'proposalId',
    'runId',
    'generation',
    'totalRows',
    'rowOffset',
    'rows',
    'nextRowOffset',
  ]);
  if (value.version !== 1) throw new TypeError('Proposal review page version must be 1.');
  if (!isProposalId(value.proposalId)) throw new TypeError('Proposal review page proposalId is malformed.');
  if (!isRunId(value.runId)) throw new TypeError('Proposal review page runId is malformed.');
  assertNonnegativeSafeInteger(value.generation, 'Proposal review page generation');
  assertPositiveSafeInteger(value.totalRows, 'Proposal review page totalRows');
  assertNonnegativeSafeInteger(value.rowOffset, 'Proposal review page rowOffset');
  if (
    !Array.isArray(value.rows) ||
    value.rows.length === 0 ||
    value.rows.length > PROPOSAL_REVIEW_PAGE_HARD_LIMIT
  ) {
    throw new RangeError(
      `Proposal review page rows must contain between 1 and ${PROPOSAL_REVIEW_PAGE_HARD_LIMIT} rows.`,
    );
  }
  if (value.rowOffset + value.rows.length > value.totalRows) {
    throw new TypeError('Proposal review page rows exceed its totalRows boundary.');
  }
  const expectedNext = value.rowOffset + value.rows.length < value.totalRows
    ? value.rowOffset + value.rows.length
    : null;
  if (value.nextRowOffset !== expectedNext) {
    throw new TypeError('Proposal review page nextRowOffset is inconsistent.');
  }
  let previousFrozenIndex = -1;
  const proposalRowIds = new Set<string>();
  const repositoryIds = new Set<string>();
  for (const row of value.rows) {
    validateProposalReviewRow(row);
    if (row.frozenIndex <= previousFrozenIndex) {
      throw new TypeError('Proposal review page rows must be strictly ordered by FrozenScope index.');
    }
    if (proposalRowIds.has(row.proposalRowId) || repositoryIds.has(row.repositoryId)) {
      throw new TypeError('Proposal review page rows must have unique identities.');
    }
    previousFrozenIndex = row.frozenIndex;
    proposalRowIds.add(row.proposalRowId);
    repositoryIds.add(row.repositoryId);
  }
}

function createProposalReviewPageValue(
  value: ProposalReviewProjection,
  rowOffset: number,
  end: number,
): ProposalReviewPageProjection {
  return {
    version: 1,
    proposalId: value.proposalId,
    runId: value.runId,
    generation: value.generation,
    totalRows: value.rows.length,
    rowOffset,
    rows: value.rows.slice(rowOffset, end),
    nextRowOffset: end < value.rows.length ? end : null,
  };
}

function validateProposalReviewRow(value: unknown): asserts value is ProposalReviewRow {
  if (!isRecord(value)) throw new TypeError('Proposal review row must be an object.');
  assertExactKeys(value, [
    'proposalRowId',
    'frozenIndex',
    'repositoryId',
    'proposedActions',
    'preselected',
  ]);
  assertTrimmedNonempty(value.proposalRowId, 'Proposal review proposalRowId');
  assertNonnegativeSafeInteger(value.frozenIndex, 'Proposal review frozenIndex');
  assertTrimmedNonempty(value.repositoryId, 'Proposal review repositoryId');
  validateActions(value.proposedActions, 'Proposal review proposedActions');
  if (typeof value.preselected !== 'boolean') {
    throw new TypeError('Proposal review preselected must be boolean.');
  }
}

function sameActions(
  left: readonly ProposalAction[],
  right: readonly ProposalAction[],
): boolean {
  return (
    left.length === right.length &&
    left.every((action, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        action.kind === other.kind &&
        action.tag === other.tag &&
        action.evidence === other.evidence
      );
    })
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertNormalizedTag(value: string, field: string): void {
  if (value !== value.normalize('NFKC')) {
    throw new TypeError(`${field} must be NFKC-normalized.`);
  }
}

function assertUtf8Bound(value: string, maximum: number, field: string): void {
  if (new TextEncoder().encode(value).byteLength > maximum) {
    throw new RangeError(`${field} exceeds ${maximum} UTF-8 bytes.`);
  }
}

function assertTrimmedNonempty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a trimmed nonempty string.`);
  }
}

function assertNonnegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`Unexpected contract keys: ${actual.join(', ')}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
