import {
  type AgentTool,
  type ToolExecutionContext,
  MAX_TOOL_RESULT_BYTES,
  okToolResult,
  serializedToolResultByteLength,
  ToolOutputTooLargeError,
} from '@/agent-harness';
import {
  addBgsmAgentManualTags,
  idbTagStore,
  type BgsmAgentManualTagAdditionResult,
  type GlobalTagBulkDeletionResult,
  type VisibleTagBulkRemoval,
  type VisibleTagBulkRemovalResult,
} from '@/storage/idb-tag-store';
import { db } from '@/storage/db';
import {
  canonicalTagMetaWinners,
  excludedCanonicalTagKeys,
  includesTagName,
  visibleTagNames,
} from '@/tags/tag-model';
import type { OrganizeStoredJobStatus, Star, Tag } from '@/types';
import {
  MAX_SEMANTIC_TAG_NAME_BYTES,
  TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT,
} from './policy';
import {
  createRepositoryCodeTools,
  type RepositoryCodeRefAuthority,
} from './repository-code-search-tool';
import { createRepositoryNotesTool } from './repository-notes-tool';

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;
const DEFAULT_COMPACT_PAGE_LIMIT = 100;
const MAX_COMPACT_PAGE_LIMIT = 500;
const MAX_DESCRIPTION_BYTES = 512;
const MAX_LABEL_BYTES = 128;
const MAX_LABELS_PER_REPO = 12;
const MAX_SEARCH_TERMS = 8;
const MAX_SEARCH_TERM_BYTES = 128;
const MAX_REPOSITORY_FULL_NAME_BYTES = 201;
const MAX_SCOPE_LABEL_BYTES = 160;
const MAX_REPOSITORY_TAG_REMOVAL_CHANGES = 500;
const MAX_TAG_REMOVALS_PER_REPOSITORY = 20;
const MAX_TAG_REMOVAL_EFFECTS = 2_000;
const MAX_GLOBAL_TAG_DELETIONS = 50;
const DEFAULT_SCOPE_LABEL = 'Authorized repository scope';
const LIST_STARS_CURSOR_PREFIX = 'list-stars:v1:';
const MAX_LIST_STARS_CURSOR_CHARS = 2_048;

type PageArgs = {
  cursor: number;
  limit: number;
};

type StarToolDto = Pick<
  Star,
  | 'full_name'
  | 'description'
  | 'language'
  | 'topics'
  | 'stargazers_count'
  | 'pushed_at'
  | 'created_at'
  | 'fork'
  | 'archived'
  | 'starred_at'
>;

type InspectedRepoDto = StarToolDto & {
  tags: string[];
};

type IdentityAndTagCountDto = {
  full_name: string;
  visibleTagCount: number;
};

type VisibleTagCountOperator = 'eq' | 'lt' | 'lte' | 'gt' | 'gte';
type VisibleTagCountFilter = Readonly<{
  operator: VisibleTagCountOperator;
  value: number;
}>;
type ListStarsFilter = Readonly<{
  visibleTagCount: VisibleTagCountFilter;
}>;
type ListStarsProjection = 'full' | 'identity_and_tag_count';
type ListStarsArgs = PageArgs & Readonly<{
  filter?: ListStarsFilter;
  projection?: ListStarsProjection;
}>;

type ListStarsCursorPayload = Readonly<{
  version: 1;
  offset: number;
  filter: ListStarsFilter | null;
  projection: ListStarsProjection;
  scopeFingerprint: string | null;
}>;

type SearchMatchMode = 'auto' | 'all' | 'any';
type AppliedSearchMode = Exclude<SearchMatchMode, 'auto'>;
type SearchMatchField = 'full_name' | 'name' | 'topics' | 'language' | 'description';

type SearchStarDto = StarToolDto & {
  matchedFields: SearchMatchField[];
  matchedTerms: string[];
  score: number;
};

type RepositorySearchScope = Readonly<{
  repositoryIds: readonly string[];
  canonicalByNormalizedFullName: ReadonlyMap<string, string>;
  label: string;
  scopeFingerprint: string | null;
}>;

export type BgsmAgentManualTagWriter = (
  fullName: string,
  tags: readonly string[],
  context: ToolExecutionContext,
) => Promise<BgsmAgentManualTagAdditionResult>;

export type BgsmAgentVisibleTagRemovalWriter = (
  changes: readonly VisibleTagBulkRemoval[],
  context: ToolExecutionContext,
) => Promise<VisibleTagBulkRemovalResult>;

export type BgsmAgentGlobalTagDeletionWriter = (
  tags: readonly string[],
  context: ToolExecutionContext,
) => Promise<GlobalTagBulkDeletionResult>;

export const REQUEST_FULL_LIBRARY_ORGANIZATION_TOOL_NAME =
  'request_full_library_organization';
export const START_FULL_LIBRARY_ANALYSIS_TOOL_NAME =
  'start_full_library_analysis';

export type BgsmAgentOrganizeLibraryAction =
  | 'request_confirmation'
  | 'start_analysis';

export type BgsmAgentOrganizeLibraryHandoffDecision =
  | Readonly<{ status: 'accepted' }>
  | Readonly<{
      status: 'blocked_by_existing_job';
      activeJobStatus: OrganizeStoredJobStatus;
    }>;

export type BgsmAgentOrganizeLibraryHandoff = Readonly<{
  type: 'organize_whole_library';
  action: BgsmAgentOrganizeLibraryAction;
  instruction: string;
}>;

export function createBgsmAgentTools(options: Readonly<{
  repositoryScope: readonly string[];
  scopeFingerprint?: string;
  scopeLabel?: string;
  enableRepositoryCodeSearch?: boolean;
  repositoryCodeRefAuthority?: RepositoryCodeRefAuthority;
  enableRepositoryNotes?: boolean;
  enableOrganizeLibraryHandoff?: boolean;
  requestOrganizeLibraryHandoff?: (
    action: BgsmAgentOrganizeLibraryAction,
  ) => BgsmAgentOrganizeLibraryHandoffDecision | Promise<BgsmAgentOrganizeLibraryHandoffDecision>;
  assignManualTags?: BgsmAgentManualTagWriter;
  removeVisibleTags?: BgsmAgentVisibleTagRemovalWriter;
  deleteTagsEverywhere?: BgsmAgentGlobalTagDeletionWriter;
}>): AgentTool[] {
  if (options.enableOrganizeLibraryHandoff && !options.requestOrganizeLibraryHandoff) {
    throw new TypeError('Full-library handoff requires an execution callback.');
  }
  const repositoryScope = new Set(options.repositoryScope);
  const repositorySearchScope = createRepositorySearchScope(
    repositoryScope,
    options.scopeLabel,
    options.scopeFingerprint,
  );
  const tools: AgentTool[] = [
    ...(options.enableOrganizeLibraryHandoff
      ? [
          requestFullLibraryOrganizationTool(options.requestOrganizeLibraryHandoff!),
          startFullLibraryAnalysisTool(options.requestOrganizeLibraryHandoff!),
        ]
      : []),
    listTagsTool(),
    listStarsTool(repositorySearchScope),
    getStarTool(repositorySearchScope),
    searchStarsTool(repositorySearchScope),
    inspectTagTool(repositoryScope),
    assignRepoTagsTool(
      repositorySearchScope,
      options.scopeFingerprint,
      options.assignManualTags ?? directManualTagWriter,
    ),
    removeRepoTagsTool(
      repositorySearchScope,
      options.scopeFingerprint,
      options.removeVisibleTags ?? directVisibleTagRemovalWriter,
    ),
    deleteTagsEverywhereTool(
      options.deleteTagsEverywhere ?? directGlobalTagDeletionWriter,
    ),
  ];
  if (options.enableRepositoryCodeSearch) {
    tools.push(...createRepositoryCodeTools(
      options.repositoryScope,
      options.repositoryCodeRefAuthority,
    ));
  }
  if (options.enableRepositoryNotes) {
    tools.push(createRepositoryNotesTool(options.repositoryScope));
  }
  return tools;
}

function requestFullLibraryOrganizationTool(
  requestHandoff: (
    action: BgsmAgentOrganizeLibraryAction,
  ) => BgsmAgentOrganizeLibraryHandoffDecision | Promise<BgsmAgentOrganizeLibraryHandoffDecision>,
): AgentTool<Record<string, never>> {
  return {
    name: REQUEST_FULL_LIBRARY_ORGANIZATION_TOOL_NAME,
    description:
      'Request the dedicated full-library Organize workflow when the user explicitly asks to classify, organize, tag, or label their entire starred repository library. Call this tool by itself and without first paging through list_stars. It only opens scope confirmation; it does not read repositories or write tags. Do not call it for questions, summaries, hypothetical requests, selected/current/filtered subsets, or one repository.',
    risk: 'suggest',
    requiresExclusiveEnvelope: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      if (Object.keys(value).length > 0) {
        throw new TypeError(`${REQUEST_FULL_LIBRARY_ORGANIZATION_TOOL_NAME} accepts no arguments.`);
      }
      return {};
    },
    async execute() {
      const decision = await requestHandoff('request_confirmation');
      if (decision.status === 'blocked_by_existing_job') {
        return {
          status: decision.status,
          activeJobStatus: decision.activeJobStatus,
          writesPerformed: false,
        };
      }
      return {
        status: 'confirmation_requested',
        scope: 'all_current_starred_repositories',
        writesPerformed: false,
      };
    },
  };
}

function startFullLibraryAnalysisTool(
  requestHandoff: (
    action: BgsmAgentOrganizeLibraryAction,
  ) => BgsmAgentOrganizeLibraryHandoffDecision | Promise<BgsmAgentOrganizeLibraryHandoffDecision>,
): AgentTool<Record<string, never>> {
  return {
    name: START_FULL_LIBRARY_ANALYSIS_TOOL_NAME,
    description:
      'Start the dedicated full-library analysis only when the user explicitly says to start, begin, proceed with, or confirm that analysis now. If a scope confirmation is already visible, this confirms it. Otherwise the UI freezes the full library and starts automatically. This analyzes repository metadata but does not apply tag changes. Do not call it for an initial organization request that still needs confirmation, for a vague acknowledgement, or while an existing Organize job is under review or running.',
    risk: 'suggest',
    requiresExclusiveEnvelope: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      if (Object.keys(value).length > 0) {
        throw new TypeError(`${START_FULL_LIBRARY_ANALYSIS_TOOL_NAME} accepts no arguments.`);
      }
      return {};
    },
    async execute() {
      const decision = await requestHandoff('start_analysis');
      if (decision.status === 'blocked_by_existing_job') {
        return {
          status: decision.status,
          activeJobStatus: decision.activeJobStatus,
          writesPerformed: false,
        };
      }
      return {
        status: 'start_requested',
        scope: 'all_current_starred_repositories',
        writesPerformed: false,
      };
    },
  };
}

export async function loadLiveBgsmAgentRepositoryScope(): Promise<string[]> {
  const repositoryIds: string[] = [];
  await db.stars.each((star) => {
    if (!star.tombstone) repositoryIds.push(star.full_name);
  });
  return repositoryIds.sort((left, right) => left.localeCompare(right));
}

function listStarsTool(repositoryScope: RepositorySearchScope): AgentTool<
  ListStarsArgs,
  {
    stars: Array<InspectedRepoDto | IdentityAndTagCountDto>;
    totalRepositories: number;
    scope: { label: string; repositoryCount: number; liveRepositoryCount: number };
    totalMatches?: number;
    appliedFilter?: ListStarsFilter | null;
    projection?: ListStarsProjection;
    nextCursor: string | null;
  }
> {
  return {
    name: 'list_stars',
    description:
      'List local starred repositories in stable full-name order within the authorized scope. For local visible-tag-count conditions, use filter.visibleTagCount with operator eq, lt, lte, gt, or gte and use projection identity_and_tag_count to avoid loading full metadata; for example, tag count <= 3 maps to operator lte and value 3. A filtered or compact opaque nextCursor retains the same query, so reuse it exactly until null. Use the default full projection only when repository metadata and visible tag names are needed.',
    risk: 'read',
    parameters: listStarsParameters(),
    validate(input) {
      return parseListStarsArgs(input, repositoryScope);
    },
    async execute(args, context) {
      const repositoryIds = [...repositoryScope.repositoryIds]
        .sort((left, right) => left.localeCompare(right));
      const scopedRows = await db.stars.bulkGet(repositoryIds);
      const liveStars = scopedRows.flatMap((star) => star && !star.tombstone ? [star] : []);
      const [tagRows, excluded] = await Promise.all([
        db.tags.bulkGet(liveStars.map((star) => star.full_name)),
        loadExcludedTagKeys(),
      ]);
      const tagsByRepository = new Map(tagRows.flatMap((row) => row ? [[row.full_name, row] as const] : []));
      const indexedStars = liveStars.map((star) => ({
        star,
        visibleTags: visibleToolTagNames(tagsByRepository.get(star.full_name), excluded),
      }));
      const countFilter = args.filter?.visibleTagCount;
      const matches = countFilter
        ? indexedStars.filter(({ visibleTags }) => matchesVisibleTagCount(
            visibleTags.length,
            countFilter,
          ))
        : indexedStars;
      const projection = args.projection ?? 'full';
      const stars = matches.map(({ star: matchedStar, visibleTags }) => (
        projection === 'identity_and_tag_count'
          ? {
              full_name: matchedStar.full_name,
              visibleTagCount: visibleTags.length,
            }
          : toInspectedRepoDtoFromVisibleTags(matchedStar, visibleTags)
      ));
      const queryIsDefault = args.filter === undefined && projection === 'full';
      const metadata = {
        totalRepositories: indexedStars.length,
        scope: {
          ...compactScopeDiagnostics(repositoryScope),
          liveRepositoryCount: indexedStars.length,
        },
        ...(queryIsDefault ? {} : {
          totalMatches: matches.length,
          appliedFilter: args.filter ?? null,
          projection,
        }),
      };
      return buildBoundedPage(
        stars,
        args,
        (page, nextCursor) => ({ stars: page, ...metadata, nextCursor }),
        resultAllowanceBytes(context),
        (nextOffset) => queryIsDefault
          ? String(nextOffset)
          : encodeListStarsCursor(nextOffset, args, repositoryScope),
      );
    },
  };
}

function listTagsTool(): AgentTool<
  PageArgs,
  { tags: Array<{ name: string; repos: number }>; nextCursor: string | null }
> {
  return {
    name: 'list_tags',
    description: 'List current non-excluded tags and repository counts, including metadata-only tags used by zero repositories.',
    risk: 'read',
    parameters: paginationParameters(),
    validate: parsePageArgs,
    async execute(args, context) {
      const [tagRows, tagMeta] = await Promise.all([db.tags.toArray(), db.tagMeta.toArray()]);
      const metaWinners = canonicalTagMetaWinners(tagMeta);
      const excluded = excludedCanonicalTagKeys(tagMeta);
      const usage = buildTagUsage(tagRows);
      for (const [key, meta] of metaWinners) {
        if (meta.excluded) continue;
        const existing = usage.get(key);
        usage.set(key, {
          name: meta.name,
          repositories: existing?.repositories ?? [],
        });
      }
      const tags = Array.from(usage.entries())
        .filter(([key]) => !excluded.has(key))
        .map(([, entry]) => ({
          name: entry.name,
          repos: entry.repositories.length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return buildBoundedPage(
        tags,
        args,
        (page, nextCursor) => ({ tags: page, nextCursor }),
        resultAllowanceBytes(context),
      );
    },
  };
}

function getStarTool(repositoryScope: RepositorySearchScope): AgentTool<
  { full_name: string },
  {
    star: InspectedRepoDto | null;
    normalizedFullName: string;
    status: 'found' | 'outside_scope' | 'unavailable';
    scope: { label: string; repositoryCount: number };
  }
> {
  return {
    name: 'get_star',
    description: 'Look up one local starred repository by its exact owner/name within the authorized scope.',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        full_name: { type: 'string' },
      },
      required: ['full_name'],
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      assertOnlyKeys(value, ['full_name'], 'get_star');
      const fullName = expectString(value.full_name, 'full_name').trim().normalize('NFKC');
      if (
        !fullName
        || new TextEncoder().encode(fullName).byteLength > MAX_REPOSITORY_FULL_NAME_BYTES
        || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(fullName)
      ) {
        throw new TypeError('full_name must be a bounded repository identifier.');
      }
      return { full_name: fullName };
    },
    async execute(args, context) {
      const normalizedFullName = normalizeRepositoryIdentity(args.full_name);
      const canonicalFullName = repositoryScope.canonicalByNormalizedFullName
        .get(normalizedFullName);
      const scope = compactScopeDiagnostics(repositoryScope);
      if (!canonicalFullName) {
        return ensureToolResultFits({
          star: null,
          normalizedFullName,
          status: 'outside_scope' as const,
          scope,
        }, context);
      }

      const [star, tag, excluded] = await Promise.all([
        db.stars.get(canonicalFullName),
        db.tags.get(canonicalFullName),
        loadExcludedTagKeys(),
      ]);
      if (!star || star.tombstone) {
        return ensureToolResultFits({
          star: null,
          normalizedFullName,
          status: 'unavailable' as const,
          scope,
        }, context);
      }
      return ensureToolResultFits({
        star: toInspectedRepoDto(star, tag, excluded),
        normalizedFullName,
        status: 'found' as const,
        scope,
      }, context);
    },
  };
}

function searchStarsTool(repositoryScope: RepositorySearchScope): AgentTool<
  { terms: string[]; match: SearchMatchMode } & PageArgs,
  {
    stars: SearchStarDto[];
    normalizedTerms: string[];
    requestedMode: SearchMatchMode;
    appliedMode: AppliedSearchMode;
    totalMatches: number;
    scope: { label: string; repositoryCount: number; liveRepositoryCount: number };
    nextCursor: string | null;
  }
> {
  return {
    name: 'search_stars',
    description:
      'Search local starred repositories with structured terms across name, description, language, and topics. Each result reports matchedTerms. An appliedMode of any only discovers candidates; it does not prove that every requested attribute matched. For exact-count requests, start with direct atomic terms and match all. Put exactly one term per logical criterion in a query; alternatives such as terminal or CLI belong in separate variants, never together. Use a small explicit limit, follow useful nextCursor pages, and stop once enough candidates qualify. Use no more than four distinct term variants total before reporting a shortage: the initial direct query counts as the first.',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        terms: {
          type: 'array',
          items: { type: 'string', maxLength: MAX_SEARCH_TERM_BYTES },
          minItems: 1,
          maxItems: MAX_SEARCH_TERMS,
        },
        match: { type: 'string', enum: ['auto', 'all', 'any'] },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
      required: ['terms'],
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      assertOnlyKeys(value, ['terms', 'match', 'limit', 'cursor'], 'search_stars');
      return {
        terms: parseSearchTerms(value.terms),
        match: parseSearchMatchMode(value.match),
        ...parsePageArgs(value),
      };
    },
    async execute(args, context) {
      const scopedRows = await db.stars.bulkGet([...repositoryScope.repositoryIds]);
      const liveStars = scopedRows.flatMap((star) => star && !star.tombstone ? [star] : []);
      const scored = liveStars.map((star) => scoreSearchStar(star, args.terms));
      const allMatches = scored.filter((candidate) => (
        candidate.matchedTermCount === args.terms.length
      ));
      const anyMatches = scored.filter((candidate) => candidate.matchedTermCount > 0);
      const appliedMode: AppliedSearchMode = args.match === 'auto'
        ? (allMatches.length > 0 ? 'all' : 'any')
        : args.match;
      const matches = (appliedMode === 'all' ? allMatches : anyMatches)
        .sort(compareScoredStars)
        .map(({ star }) => star);
      const resultMetadata = {
        normalizedTerms: args.terms,
        requestedMode: args.match,
        appliedMode,
        totalMatches: matches.length,
        scope: {
          ...compactScopeDiagnostics(repositoryScope),
          liveRepositoryCount: liveStars.length,
        },
      };
      return buildBoundedPage(
        matches,
        args,
        (page, nextCursor) => ({ stars: page, ...resultMetadata, nextCursor }),
        resultAllowanceBytes(context),
      );
    },
  };
}

function inspectTagTool(repositoryScope: ReadonlySet<string>): AgentTool<
  { tag: string } & PageArgs,
  { tag: string; repos: InspectedRepoDto[]; nextCursor: string | null }
> {
  return {
    name: 'inspect_tag',
    description: 'Inspect repositories that currently use one tag.',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
      required: ['tag'],
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      return { tag: expectString(value.tag, 'tag').trim(), ...parsePageArgs(value) };
    },
    async execute(args, context) {
      const excluded = await loadExcludedTagKeys();
      if (excluded.has(policyTagKey(args.tag))) {
        throw new TypeError('Tag is excluded by local policy.');
      }
      const tagRows = await db.tags
        .filter((row) => (
          repositoryScope.has(row.full_name) && includesTagName(visibleTagNames(row), args.tag)
        ))
        .toArray();
      const stars = await db.stars.bulkGet(tagRows.map((row) => row.full_name));
      const tagByRepo = new Map(tagRows.map((row) => [row.full_name, row]));
      const repos = stars
        .flatMap((star) => {
          if (!star || star.tombstone) return [];
          const tagRecord = tagByRepo.get(star.full_name);
          return [{
            ...toStarToolDto(star),
            tags: visibleTagNames(tagRecord)
              .filter((tag) => !excluded.has(policyTagKey(tag)))
              .slice(0, MAX_LABELS_PER_REPO)
              .map((tag) => truncateUtf8(tag, MAX_LABEL_BYTES)),
          }];
        })
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
      return buildBoundedPage(repos, args, (page, nextCursor) => ({
        tag: args.tag,
        repos: page,
        nextCursor,
      }), resultAllowanceBytes(context));
    },
  };
}

function assignRepoTagsTool(
  repositoryScope: RepositorySearchScope,
  scopeFingerprint: string | undefined,
  assignManualTags: BgsmAgentManualTagWriter,
): AgentTool<
  { full_name: string; tags: string[] },
  { full_name: string; tags: string[]; changed: boolean; reason: BgsmAgentManualTagAdditionResult['reason'] }
> {
  return {
    name: 'assign_repo_tags',
    description:
      'Add one or more manual tags to a repository only when the user wants its tags changed. Arguments: full_name string, tags string array. Use after inspecting local repository data in the current turn.',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        full_name: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          maxItems: TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT,
        },
      },
      required: ['full_name', 'tags'],
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      const requestedFullName = expectString(value.full_name, 'full_name').trim().normalize('NFKC');
      return {
        full_name: repositoryScope.canonicalByNormalizedFullName.get(
          normalizeRepositoryIdentity(requestedFullName),
        ) ?? requestedFullName,
        tags: expectAgentTagArray(value.tags, 'tags'),
      };
    },
    ...(scopeFingerprint ? { writeEffectPlan: {
      canonicalEffects(args: { full_name: string; tags: string[] }) {
        const repositoryKey = normalizeRepositoryIdentity(args.full_name);
        return args.tags
          .map((tag) => [
            'assign_repo_tags',
            scopeFingerprint,
            repositoryKey,
            policyTagKey(tag),
          ] as const)
          .sort((left, right) => left[3].localeCompare(right[3]));
      },
      selectEffects(
        args: { full_name: string; tags: string[] },
        effects: readonly (readonly [string, ...string[]])[],
      ) {
        const selectedTagKeys = new Set(effects.map((effect) => effect[3]));
        return {
          ...args,
          tags: args.tags
            .filter((tag) => selectedTagKeys.has(policyTagKey(tag)))
            .sort((left, right) => policyTagKey(left).localeCompare(policyTagKey(right))),
        };
      },
      replayResult(args: { full_name: string; tags: string[] }) {
        return {
          full_name: args.full_name,
          tags: args.tags,
          changed: false,
          reason: null,
        };
      },
      classifyResult(result: { reason: BgsmAgentManualTagAdditionResult['reason'] }) {
        return result.reason === null ? 'committed' : 'failed';
      },
      startBoundary: 'delegated',
    } } : {}),
    async execute(args, context) {
      assertRepositoryInSearchScope(repositoryScope, args.full_name);
      const write = await assignManualTags(args.full_name, args.tags, context);
      const excluded = await loadExcludedTagKeys();
      return {
        full_name: args.full_name,
        tags: write.manualTags.filter((tag) => !excluded.has(policyTagKey(tag))),
        changed: write.changed,
        reason: write.reason,
      };
    },
  };
}

const directManualTagWriter: BgsmAgentManualTagWriter = (fullName, tags, context) => {
  context.markWriteStarted?.();
  return addBgsmAgentManualTags(fullName, tags);
};

function removeRepoTagsTool(
  repositoryScope: RepositorySearchScope,
  scopeFingerprint: string | undefined,
  removeVisibleTags: BgsmAgentVisibleTagRemovalWriter,
): AgentTool<
  { changes: VisibleTagBulkRemoval[] },
  VisibleTagBulkRemovalResult
> {
  return {
    name: 'remove_repo_tags',
    description:
      'Remove visible tags from one or more repositories only when the user asks for those repository-level removals. Pass changes as an array of {full_name, tags}; one call is one atomic local batch. Inspect every requested repository/tag assignment in the current turn first. This does not delete a tag globally.',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_REPOSITORY_TAG_REMOVAL_CHANGES,
          items: {
            type: 'object',
            properties: {
              full_name: { type: 'string' },
              tags: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_TAG_REMOVALS_PER_REPOSITORY,
                items: { type: 'string' },
              },
            },
            required: ['full_name', 'tags'],
            additionalProperties: false,
          },
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      assertOnlyKeys(value, ['changes'], 'remove_repo_tags');
      return {
        changes: parseVisibleTagRemovalChanges(value.changes, repositoryScope),
      };
    },
    writeEffectPlan: {
      canonicalEffects(args: { changes: VisibleTagBulkRemoval[] }) {
        const scopeKey = scopeFingerprint ?? 'unbound-scope';
        return args.changes.flatMap((change) => change.tags.map((tag) => [
          'remove_repo_tags',
          scopeKey,
          normalizeRepositoryIdentity(change.full_name),
          policyTagKey(tag),
        ] as const)).sort(compareCanonicalEffects);
      },
      selectEffects(
        args: { changes: VisibleTagBulkRemoval[] },
        effects: readonly (readonly [string, ...string[]])[],
      ) {
        const selected = new Set(effects.map((effect) => `${effect[2]}\u0000${effect[3]}`));
        return {
          changes: args.changes.flatMap((change) => {
            const repositoryKey = normalizeRepositoryIdentity(change.full_name);
            const tags = change.tags.filter((tag) => (
              selected.has(`${repositoryKey}\u0000${policyTagKey(tag)}`)
            ));
            return tags.length > 0 ? [{ ...change, tags }] : [];
          }),
        };
      },
      replayResult(args: { changes: VisibleTagBulkRemoval[] }) {
        return {
          requested: countVisibleTagRemovalEffects(args.changes),
          changed: 0,
          skipped: 0,
          repositoriesChanged: 0,
        };
      },
      startBoundary: 'delegated',
    },
    async execute(args, context) {
      for (const change of args.changes) {
        assertRepositoryInSearchScope(repositoryScope, change.full_name);
      }
      return removeVisibleTags(args.changes, context);
    },
  };
}

function deleteTagsEverywhereTool(
  deleteTagsEverywhere: BgsmAgentGlobalTagDeletionWriter,
): AgentTool<
  { tags: string[] },
  GlobalTagBulkDeletionResult
> {
  return {
    name: 'delete_tags_everywhere',
    description:
      'Delete one or more tag names from every local repository and prevent automatic re-adding. Pass tags as an array; one call is one atomic local batch. Use only when the user explicitly asks for global deletion, after inspecting each tag in the current turn. For selected repositories only, use remove_repo_tags instead.',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_GLOBAL_TAG_DELETIONS,
          items: { type: 'string' },
        },
      },
      required: ['tags'],
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      assertOnlyKeys(value, ['tags'], 'delete_tags_everywhere');
      return {
        tags: expectTagArray(value.tags, 'tags', MAX_GLOBAL_TAG_DELETIONS),
      };
    },
    writeEffectPlan: {
      canonicalEffects(args: { tags: string[] }) {
        return args.tags.map((tag) => [
          'delete_tags_everywhere',
          policyTagKey(tag),
        ] as const).sort(compareCanonicalEffects);
      },
      selectEffects(
        args: { tags: string[] },
        effects: readonly (readonly [string, ...string[]])[],
      ) {
        const selected = new Set(effects.map((effect) => effect[1]));
        return { tags: args.tags.filter((tag) => selected.has(policyTagKey(tag))) };
      },
      replayResult(args: { tags: string[] }) {
        return {
          requestedTags: args.tags.length,
          assignmentsRemoved: 0,
          repositoriesChanged: 0,
        };
      },
      startBoundary: 'delegated',
    },
    async execute(args, context) {
      return deleteTagsEverywhere(args.tags, context);
    },
  };
}

const directVisibleTagRemovalWriter: BgsmAgentVisibleTagRemovalWriter = (
  changes,
  context,
) => {
  context.markWriteStarted?.();
  return idbTagStore.removeVisibleTagsBulk(changes);
};

const directGlobalTagDeletionWriter: BgsmAgentGlobalTagDeletionWriter = (
  tags,
  context,
) => {
  context.markWriteStarted?.();
  return idbTagStore.deleteTagsEverywhere(tags);
};

function buildTagUsage(tags: Tag[]): Map<string, { name: string; repositories: string[] }> {
  const usage = new Map<string, { name: string; repositories: string[] }>();
  for (const row of tags) {
    for (const name of visibleTagNames(row)) {
      const key = policyTagKey(name);
      const entry = usage.get(key) ?? { name, repositories: [] };
      entry.repositories.push(row.full_name);
      usage.set(key, entry);
    }
  }
  return usage;
}

function assertRepositoryInSearchScope(
  repositoryScope: RepositorySearchScope,
  fullName: string,
): void {
  if (!repositoryScope.canonicalByNormalizedFullName.has(normalizeRepositoryIdentity(fullName))) {
    throw new TypeError(`Repository is outside the authorized scope: ${fullName}`);
  }
}

function createRepositorySearchScope(
  repositoryScope: ReadonlySet<string>,
  scopeLabel: string | undefined,
  scopeFingerprint: string | undefined,
): RepositorySearchScope {
  const canonicalByNormalizedFullName = new Map<string, string>();
  for (const fullName of repositoryScope) {
    const normalized = normalizeRepositoryIdentity(fullName);
    if (!canonicalByNormalizedFullName.has(normalized)) {
      canonicalByNormalizedFullName.set(normalized, fullName);
    }
  }
  const normalizedLabel = scopeLabel?.trim().normalize('NFKC');
  return {
    repositoryIds: Array.from(canonicalByNormalizedFullName.values()),
    canonicalByNormalizedFullName,
    label: truncateUtf8(normalizedLabel || DEFAULT_SCOPE_LABEL, MAX_SCOPE_LABEL_BYTES),
    scopeFingerprint: scopeFingerprint?.trim() || null,
  };
}

function compactScopeDiagnostics(repositoryScope: RepositorySearchScope): {
  label: string;
  repositoryCount: number;
} {
  return {
    label: repositoryScope.label,
    repositoryCount: repositoryScope.repositoryIds.length,
  };
}

function normalizeRepositoryIdentity(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[-_./\s]+/gu, ' ')
    .trim();
}

function parseSearchTerms(input: unknown): string[] {
  if (!Array.isArray(input)) throw new TypeError('Expected terms to be an array.');
  if (input.length === 0) throw new TypeError('Search terms must include at least one term.');
  if (input.length > MAX_SEARCH_TERMS) {
    throw new TypeError(`Search terms must include at most ${MAX_SEARCH_TERMS} terms.`);
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') throw new TypeError('Expected terms entries to be strings.');
    const normalizedInput = item.normalize('NFKC');
    const operatorCheckInput = normalizedInput.replace(/[-_./\s]+/gu, ' ').trim();
    if (/(?:^|\s)(?:AND|OR|NOT)(?:\s|$)/u.test(operatorCheckInput)) {
      throw new TypeError('Search terms must not contain Boolean operators; pass separate terms instead.');
    }
    const term = normalizeSearchText(normalizedInput);
    if (!term) throw new TypeError('Search terms must be nonempty.');
    if (new TextEncoder().encode(term).byteLength > MAX_SEARCH_TERM_BYTES) {
      throw new TypeError(`Search terms must fit ${MAX_SEARCH_TERM_BYTES} UTF-8 bytes each.`);
    }
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function parseSearchMatchMode(input: unknown): SearchMatchMode {
  if (input === undefined) return 'auto';
  if (input !== 'auto' && input !== 'all' && input !== 'any') {
    throw new TypeError('match must be auto, all, or any.');
  }
  return input;
}

function scoreSearchStar(star: Star, terms: readonly string[]): {
  star: SearchStarDto;
  matchedTermCount: number;
} {
  const fullName = normalizeSearchText(star.full_name);
  const repositoryName = normalizeSearchText(star.full_name.split('/').at(-1) ?? star.full_name);
  const description = normalizeSearchText(star.description);
  const language = normalizeSearchText(star.language ?? '');
  const topics = star.topics.map(normalizeSearchText);
  const matchedFields = new Set<SearchMatchField>();
  const matchedTerms: string[] = [];
  let matchedTermCount = 0;
  let highestTier = 0;
  let signalCount = 0;

  for (const term of terms) {
    const fullNameMatch = fullName.includes(term);
    const nameMatch = repositoryName.includes(term);
    const topicMatch = topics.some((topic) => topic.includes(term));
    const languageMatch = language.includes(term);
    const descriptionMatch = description.includes(term);
    if (!fullNameMatch && !nameMatch && !topicMatch && !languageMatch && !descriptionMatch) continue;

    matchedTermCount += 1;
    matchedTerms.push(term);
    if (fullNameMatch) matchedFields.add('full_name');
    if (nameMatch) matchedFields.add('name');
    if (topicMatch) matchedFields.add('topics');
    if (languageMatch) matchedFields.add('language');
    if (descriptionMatch) matchedFields.add('description');
    signalCount += Number(fullNameMatch)
      + Number(nameMatch)
      + Number(topicMatch)
      + Number(languageMatch)
      + Number(descriptionMatch);

    const tier = fullName === term
      ? 7
      : repositoryName === term
        ? 6
        : repositoryName.startsWith(term)
          ? 5
          : (nameMatch || fullNameMatch)
            ? 4
            : topicMatch
              ? 3
              : languageMatch
                ? 2
                : 1;
    highestTier = Math.max(highestTier, tier);
  }

  return {
    star: {
      ...toStarToolDto(star),
      matchedFields: SEARCH_MATCH_FIELD_ORDER.filter((field) => matchedFields.has(field)),
      matchedTerms,
      score: highestTier * 100_000 + matchedTermCount * 1_000 + signalCount,
    },
    matchedTermCount,
  };
}

const SEARCH_MATCH_FIELD_ORDER: readonly SearchMatchField[] = [
  'full_name',
  'name',
  'topics',
  'language',
  'description',
];

function compareScoredStars(
  left: ReturnType<typeof scoreSearchStar>,
  right: ReturnType<typeof scoreSearchStar>,
): number {
  if (left.star.score !== right.star.score) return right.star.score - left.star.score;
  const leftName = normalizeRepositoryIdentity(left.star.full_name);
  const rightName = normalizeRepositoryIdentity(right.star.full_name);
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  return left.star.full_name < right.star.full_name ? -1 : left.star.full_name > right.star.full_name ? 1 : 0;
}

async function loadExcludedTagKeys(): Promise<Set<string>> {
  const meta = await db.tagMeta.toArray();
  return excludedCanonicalTagKeys(meta);
}


function policyTagKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function expectObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Expected an object.');
  }
  return input as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  toolName: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${toolName} accepts only ${allowed.join(', ')}.`);
  }
}

function listStarsParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        properties: {
          visibleTagCount: {
            type: 'object',
            properties: {
              operator: { type: 'string', enum: ['eq', 'lt', 'lte', 'gt', 'gte'] },
              value: { type: 'integer', minimum: 0 },
            },
            required: ['operator', 'value'],
            additionalProperties: false,
          },
        },
        required: ['visibleTagCount'],
        additionalProperties: false,
      },
      projection: {
        type: 'string',
        enum: ['full', 'identity_and_tag_count'],
      },
      cursor: { type: 'string', maxLength: MAX_LIST_STARS_CURSOR_CHARS },
      limit: { type: 'integer', minimum: 1, maximum: MAX_COMPACT_PAGE_LIMIT },
    },
    additionalProperties: false,
  };
}

function parseListStarsArgs(
  input: unknown,
  repositoryScope: RepositorySearchScope,
): ListStarsArgs {
  const value = expectObject(input);
  assertOnlyKeys(value, ['filter', 'projection', 'limit', 'cursor'], 'list_stars');
  const filterProvided = value.filter !== undefined;
  const projectionProvided = value.projection !== undefined;
  const explicitFilter = filterProvided ? parseListStarsFilter(value.filter) : undefined;
  const explicitProjection = projectionProvided
    ? parseListStarsProjection(value.projection)
    : undefined;
  const rawCursor = value.cursor === undefined
    ? undefined
    : expectString(value.cursor, 'cursor');

  let cursor = 0;
  let filter = explicitFilter;
  let projection = explicitProjection ?? 'full';
  if (rawCursor?.startsWith(LIST_STARS_CURSOR_PREFIX)) {
    const payload = decodeListStarsCursor(rawCursor);
    if (payload.scopeFingerprint !== repositoryScope.scopeFingerprint) {
      throw new TypeError('list_stars cursor belongs to another authorized scope.');
    }
    if (filterProvided && !sameListStarsFilter(explicitFilter, payload.filter ?? undefined)) {
      throw new TypeError('list_stars cursor query does not match the supplied filter.');
    }
    if (projectionProvided && explicitProjection !== payload.projection) {
      throw new TypeError('list_stars cursor query does not match the supplied projection.');
    }
    cursor = payload.offset;
    filter = payload.filter ?? undefined;
    projection = payload.projection;
  } else if (rawCursor !== undefined) {
    cursor = parsePageCursor(rawCursor);
    if (cursor > 0 && (filter !== undefined || projection !== 'full')) {
      throw new TypeError('A filtered or compact list_stars query requires its opaque nextCursor.');
    }
  }

  const compact = projection === 'identity_and_tag_count';
  const limit = parsePageLimit(
    value.limit,
    compact ? DEFAULT_COMPACT_PAGE_LIMIT : DEFAULT_PAGE_LIMIT,
    compact ? MAX_COMPACT_PAGE_LIMIT : MAX_PAGE_LIMIT,
  );
  return {
    cursor,
    limit,
    ...(filter ? { filter } : {}),
    ...(projection === 'full' ? {} : { projection }),
  };
}

function parseListStarsFilter(input: unknown): ListStarsFilter {
  const value = expectObject(input);
  assertOnlyKeys(value, ['visibleTagCount'], 'list_stars filter');
  if (value.visibleTagCount === undefined) {
    throw new TypeError('list_stars filter requires visibleTagCount.');
  }
  const count = expectObject(value.visibleTagCount);
  assertOnlyKeys(count, ['operator', 'value'], 'list_stars visibleTagCount filter');
  const operator = expectString(count.operator, 'visibleTagCount operator');
  if (!isVisibleTagCountOperator(operator)) {
    throw new TypeError('visibleTagCount operator must be eq, lt, lte, gt, or gte.');
  }
  const filterValue = expectNonNegativeInteger(count.value, 'visibleTagCount value');
  return {
    visibleTagCount: {
      operator,
      value: filterValue,
    },
  };
}

function parseListStarsProjection(input: unknown): ListStarsProjection {
  const value = expectString(input, 'projection');
  if (value !== 'full' && value !== 'identity_and_tag_count') {
    throw new TypeError('list_stars projection must be full or identity_and_tag_count.');
  }
  return value;
}

function isVisibleTagCountOperator(value: string): value is VisibleTagCountOperator {
  return value === 'eq' || value === 'lt' || value === 'lte' || value === 'gt' || value === 'gte';
}

function sameListStarsFilter(
  left: ListStarsFilter | undefined,
  right: ListStarsFilter | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.visibleTagCount.operator === right.visibleTagCount.operator
    && left.visibleTagCount.value === right.visibleTagCount.value;
}

function encodeListStarsCursor(
  offset: number,
  args: ListStarsArgs,
  repositoryScope: RepositorySearchScope,
): string {
  const payload: ListStarsCursorPayload = {
    version: 1,
    offset,
    filter: args.filter ?? null,
    projection: args.projection ?? 'full',
    scopeFingerprint: repositoryScope.scopeFingerprint,
  };
  return LIST_STARS_CURSOR_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

function decodeListStarsCursor(cursor: string): ListStarsCursorPayload {
  if (cursor.length > MAX_LIST_STARS_CURSOR_CHARS) {
    throw new TypeError('list_stars cursor is too long.');
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(cursor.slice(LIST_STARS_CURSOR_PREFIX.length)));
  } catch {
    throw new TypeError('list_stars cursor is malformed.');
  }
  const payload = expectObject(value);
  assertOnlyKeys(
    payload,
    ['version', 'offset', 'filter', 'projection', 'scopeFingerprint'],
    'list_stars cursor',
  );
  if (payload.version !== 1) throw new TypeError('list_stars cursor version is unsupported.');
  const offset = expectNonNegativeInteger(payload.offset, 'list_stars cursor offset');
  const filter = payload.filter === null ? null : parseListStarsFilter(payload.filter);
  const projection = parseListStarsProjection(payload.projection);
  const scopeFingerprint = payload.scopeFingerprint;
  if (scopeFingerprint !== null && typeof scopeFingerprint !== 'string') {
    throw new TypeError('list_stars cursor scope fingerprint is malformed.');
  }
  return {
    version: 1,
    offset,
    filter,
    projection,
    scopeFingerprint,
  };
}

function parsePageLimit(input: unknown, fallback: number, maximum: number): number {
  const limit = input === undefined ? fallback : expectPositiveInteger(input, 'limit');
  return Math.min(limit, maximum);
}

function parsePageCursor(rawCursor: string): number {
  if (!/^\d+$/u.test(rawCursor)) {
    throw new Error('Expected cursor to be a non-negative integer string.');
  }
  const cursor = Number(rawCursor);
  if (!Number.isSafeInteger(cursor)) throw new Error('Expected cursor to be a safe integer string.');
  return cursor;
}

function paginationParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      cursor: { type: 'string' },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  };
}

function parsePageArgs(input: unknown): PageArgs {
  const value = expectObject(input);
  const limit = parsePageLimit(value.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const cursor = value.cursor === undefined
    ? 0
    : parsePageCursor(expectString(value.cursor, 'cursor'));
  return { cursor, limit };
}

function expectString(input: unknown, field: string): string {
  if (typeof input !== 'string') {
    throw new Error(`Expected ${field} to be a string.`);
  }
  return input;
}

function expectAgentTagArray(input: unknown, field: string): string[] {
  return expectTagArray(input, field, TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT);
}

function expectTagArray(input: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(input)) {
    throw new Error(`Expected ${field} to be an array.`);
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') throw new Error(`Expected ${field} entries to be strings.`);
    const tag = item.trim().normalize('NFKC');
    if (!tag) throw new Error(`Expected ${field} entries to be non-empty.`);
    if (new TextEncoder().encode(tag).byteLength > MAX_SEMANTIC_TAG_NAME_BYTES) {
      throw new Error(`Expected ${field} entries to fit ${MAX_SEMANTIC_TAG_NAME_BYTES} UTF-8 bytes.`);
    }
    const key = policyTagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length === 0) throw new Error(`Expected ${field} to include at least one tag.`);
  if (tags.length > maxItems) {
    throw new Error(`Expected ${field} to include at most ${maxItems} tags.`);
  }
  return tags;
}

function parseVisibleTagRemovalChanges(
  input: unknown,
  repositoryScope: RepositorySearchScope,
): VisibleTagBulkRemoval[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('remove_repo_tags changes must be a non-empty array.');
  }
  if (input.length > MAX_REPOSITORY_TAG_REMOVAL_CHANGES) {
    throw new TypeError(
      `remove_repo_tags changes must contain at most ${MAX_REPOSITORY_TAG_REMOVAL_CHANGES} repositories.`,
    );
  }

  const changesByRepository = new Map<string, { full_name: string; tags: Map<string, string> }>();
  for (const item of input) {
    const value = expectObject(item);
    assertOnlyKeys(value, ['full_name', 'tags'], 'remove_repo_tags change');
    const requestedFullName = expectRepositoryFullName(value.full_name, 'full_name');
    const repositoryKey = normalizeRepositoryIdentity(requestedFullName);
    const fullName = repositoryScope.canonicalByNormalizedFullName.get(repositoryKey)
      ?? requestedFullName;
    const entry = changesByRepository.get(repositoryKey) ?? {
      full_name: fullName,
      tags: new Map<string, string>(),
    };
    for (const tag of expectTagArray(
      value.tags,
      'tags',
      MAX_TAG_REMOVALS_PER_REPOSITORY,
    )) {
      entry.tags.set(policyTagKey(tag), entry.tags.get(policyTagKey(tag)) ?? tag);
    }
    changesByRepository.set(repositoryKey, entry);
  }

  const changes = Array.from(changesByRepository.values(), (entry) => ({
    full_name: entry.full_name,
    tags: Array.from(entry.tags.values()),
  })).sort((left, right) => (
    normalizeRepositoryIdentity(left.full_name)
      .localeCompare(normalizeRepositoryIdentity(right.full_name))
  ));
  if (countVisibleTagRemovalEffects(changes) > MAX_TAG_REMOVAL_EFFECTS) {
    throw new TypeError(
      `remove_repo_tags must contain at most ${MAX_TAG_REMOVAL_EFFECTS} unique repository/tag pairs.`,
    );
  }
  return changes;
}

function expectRepositoryFullName(input: unknown, field: string): string {
  const fullName = expectString(input, field).trim().normalize('NFKC');
  if (
    !fullName
    || new TextEncoder().encode(fullName).byteLength > MAX_REPOSITORY_FULL_NAME_BYTES
    || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(fullName)
  ) {
    throw new TypeError(`${field} must be a bounded repository identifier.`);
  }
  return fullName;
}

function countVisibleTagRemovalEffects(changes: readonly VisibleTagBulkRemoval[]): number {
  return changes.reduce((total, change) => total + change.tags.length, 0);
}

function compareCanonicalEffects(
  left: readonly string[],
  right: readonly string[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = (left[index] ?? '').localeCompare(right[index] ?? '');
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function expectPositiveInteger(input: unknown, field: string): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input <= 0) {
    throw new Error(`Expected ${field} to be a positive integer.`);
  }
  return input;
}

function expectNonNegativeInteger(input: unknown, field: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`Expected ${field} to be a non-negative integer.`);
  }
  return input;
}

function toStarToolDto(star: Star): StarToolDto {
  return {
    full_name: star.full_name,
    description: truncateUtf8(star.description, MAX_DESCRIPTION_BYTES),
    language: star.language,
    topics: star.topics
      .slice(0, MAX_LABELS_PER_REPO)
      .map((topic) => truncateUtf8(topic, MAX_LABEL_BYTES)),
    stargazers_count: star.stargazers_count,
    pushed_at: star.pushed_at,
    created_at: star.created_at,
    fork: star.fork,
    archived: star.archived,
    starred_at: star.starred_at,
  };
}

function toInspectedRepoDto(
  star: Star,
  tag: Tag | undefined,
  excluded: ReadonlySet<string>,
): InspectedRepoDto {
  return toInspectedRepoDtoFromVisibleTags(star, visibleToolTagNames(tag, excluded));
}

function visibleToolTagNames(
  tag: Tag | undefined,
  excluded: ReadonlySet<string>,
): string[] {
  return visibleTagNames(tag).filter((name) => !excluded.has(policyTagKey(name)));
}

function toInspectedRepoDtoFromVisibleTags(
  star: Star,
  visibleTags: readonly string[],
): InspectedRepoDto {
  return {
    ...toStarToolDto(star),
    tags: visibleTags
      .slice(0, MAX_LABELS_PER_REPO)
      .map((name) => truncateUtf8(name, MAX_LABEL_BYTES)),
  };
}

function matchesVisibleTagCount(count: number, filter: VisibleTagCountFilter): boolean {
  switch (filter.operator) {
    case 'eq': return count === filter.value;
    case 'lt': return count < filter.value;
    case 'lte': return count <= filter.value;
    case 'gt': return count > filter.value;
    case 'gte': return count >= filter.value;
  }
}

function buildBoundedPage<TItem, TResult>(
  items: TItem[],
  args: PageArgs,
  build: (page: TItem[], nextCursor: string | null) => TResult,
  maxSerializedBytes = MAX_TOOL_RESULT_BYTES,
  cursorForOffset: (offset: number) => string = String,
): TResult {
  const available = items.slice(args.cursor, args.cursor + args.limit);
  for (let count = available.length; count > 0; count--) {
    const nextOffset = args.cursor + count;
    const result = build(
      available.slice(0, count),
      nextOffset < items.length ? cursorForOffset(nextOffset) : null,
    );
    if (serializedToolResultByteLength(okToolResult(result)) <= maxSerializedBytes) return result;
  }

  if (available.length === 0) {
    const result = build([], null);
    if (serializedToolResultByteLength(okToolResult(result)) <= maxSerializedBytes) return result;
  }

  throw new ToolOutputTooLargeError('The next item is too large to return safely.');
}

function resultAllowanceBytes(context: ToolExecutionContext): number {
  return context.resultAllowance?.maxSerializedBytes ?? MAX_TOOL_RESULT_BYTES;
}

function ensureToolResultFits<TResult>(result: TResult, context: ToolExecutionContext): TResult {
  if (
    serializedToolResultByteLength(okToolResult(result))
    <= resultAllowanceBytes(context)
  ) return result;
  throw new ToolOutputTooLargeError('The tool result is too large to return safely.');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const output: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    output.push(character);
    bytes += characterBytes;
  }
  return output.join('');
}
