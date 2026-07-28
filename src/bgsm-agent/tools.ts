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
} from '@/storage/idb-tag-store';
import { db } from '@/storage/db';
import { includesTagName, visibleTagNames } from '@/tags/tag-model';
import type { Star, Tag } from '@/types';
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
const MAX_DESCRIPTION_BYTES = 512;
const MAX_LABEL_BYTES = 128;
const MAX_LABELS_PER_REPO = 12;
const MAX_SEARCH_TERMS = 8;
const MAX_SEARCH_TERM_BYTES = 128;
const MAX_REPOSITORY_FULL_NAME_BYTES = 201;
const MAX_SCOPE_LABEL_BYTES = 160;
const DEFAULT_SCOPE_LABEL = 'Authorized repository scope';

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

type SearchMatchMode = 'auto' | 'all' | 'any';
type AppliedSearchMode = Exclude<SearchMatchMode, 'auto'>;
type SearchMatchField = 'full_name' | 'name' | 'topics' | 'language' | 'description';

type SearchStarDto = StarToolDto & {
  matchedFields: SearchMatchField[];
  score: number;
};

type RepositorySearchScope = Readonly<{
  repositoryIds: readonly string[];
  canonicalByNormalizedFullName: ReadonlyMap<string, string>;
  label: string;
}>;

export type BgsmAgentManualTagWriter = (
  fullName: string,
  tags: readonly string[],
  context: ToolExecutionContext,
) => Promise<BgsmAgentManualTagAdditionResult>;

export function createBgsmAgentTools(options: Readonly<{
  repositoryScope: readonly string[];
  scopeFingerprint?: string;
  scopeLabel?: string;
  enableRepositoryCodeSearch?: boolean;
  repositoryCodeRefAuthority?: RepositoryCodeRefAuthority;
  enableRepositoryNotes?: boolean;
  assignManualTags?: BgsmAgentManualTagWriter;
  /** Opt-in only. Default false: first safe release is additive manual tags. */
  allowDestructiveWrites?: boolean;
}>): AgentTool[] {
  const repositoryScope = new Set(options.repositoryScope);
  const repositorySearchScope = createRepositorySearchScope(
    repositoryScope,
    options.scopeLabel,
  );
  const tools: AgentTool[] = [
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
  if (options.allowDestructiveWrites) {
    tools.push(removeRepoTagTool(repositoryScope), deleteTagEverywhereTool());
  }
  return tools;
}

export async function loadLiveBgsmAgentRepositoryScope(): Promise<string[]> {
  const repositoryIds: string[] = [];
  await db.stars.each((star) => {
    if (!star.tombstone) repositoryIds.push(star.full_name);
  });
  return repositoryIds.sort((left, right) => left.localeCompare(right));
}

function listStarsTool(repositoryScope: RepositorySearchScope): AgentTool<
  PageArgs,
  {
    stars: InspectedRepoDto[];
    totalRepositories: number;
    scope: { label: string; repositoryCount: number; liveRepositoryCount: number };
    nextCursor: string | null;
  }
> {
  return {
    name: 'list_stars',
    description:
      'List local starred repositories and visible tags in stable full-name order within the authorized scope. Follow nextCursor until null only when the user requests a complete inventory.',
    risk: 'read',
    parameters: paginationParameters(),
    validate(input) {
      const value = expectObject(input);
      assertOnlyKeys(value, ['limit', 'cursor'], 'list_stars');
      return parsePageArgs(value);
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
      const stars = liveStars.map((star): InspectedRepoDto => ({
        ...toStarToolDto(star),
        tags: visibleTagNames(tagsByRepository.get(star.full_name))
          .filter((tag) => !excluded.has(policyTagKey(tag)))
          .slice(0, MAX_LABELS_PER_REPO)
          .map((tag) => truncateUtf8(tag, MAX_LABEL_BYTES)),
      }));
      const metadata = {
        totalRepositories: stars.length,
        scope: {
          ...compactScopeDiagnostics(repositoryScope),
          liveRepositoryCount: stars.length,
        },
      };
      return buildBoundedPage(
        stars,
        args,
        (page, nextCursor) => ({ stars: page, ...metadata, nextCursor }),
        resultAllowanceBytes(context),
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
    description: 'List current non-excluded tags and repository counts.',
    risk: 'read',
    parameters: paginationParameters(),
    validate: parsePageArgs,
    async execute(args, context) {
      const [tagRows, tagMeta] = await Promise.all([db.tags.toArray(), db.tagMeta.toArray()]);
      const excluded = new Set(
        tagMeta.filter((meta) => meta.excluded).map((meta) => policyTagKey(meta.name)),
      );
      const usage = buildTagUsage(tagRows);
      const tags = Array.from(usage.entries())
        .filter(([name]) => !excluded.has(policyTagKey(name)))
        .map(([name, repos]) => ({ name, repos: repos.length }))
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
    star: StarToolDto | null;
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

      const star = await db.stars.get(canonicalFullName);
      if (!star || star.tombstone) {
        return ensureToolResultFits({
          star: null,
          normalizedFullName,
          status: 'unavailable' as const,
          scope,
        }, context);
      }
      return ensureToolResultFits({
        star: toStarToolDto(star),
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
      'Search local starred repositories with structured terms across name, description, language, and topics.',
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

function removeRepoTagTool(repositoryScope: ReadonlySet<string>): AgentTool<
  { full_name: string; tag: string },
  { full_name: string; tag: string; removed: boolean }
> {
  return {
    name: 'remove_repo_tag',
    description:
      'Remove one visible tag from one repository. Arguments: full_name string, tag string. Use only when the user asks to remove tags.',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        full_name: { type: 'string' },
        tag: { type: 'string' },
      },
      required: ['full_name', 'tag'],
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      return {
        full_name: expectString(value.full_name, 'full_name').trim(),
        tag: expectString(value.tag, 'tag').trim(),
      };
    },
    async execute(args) {
      assertRepositoryInScope(repositoryScope, args.full_name);
      const result = await idbTagStore.removeVisibleTag(args.full_name, args.tag);
      return {
        full_name: args.full_name,
        tag: args.tag,
        removed: result.removed,
      };
    },
  };
}

function deleteTagEverywhereTool(): AgentTool<
  { tag: string },
  { tag: string; removed: number }
> {
  return {
    name: 'delete_tag_everywhere',
    description:
      'Delete one tag from every repository and prevent automatic re-adding. Arguments: tag string. Use only when the user explicitly asks to delete a tag.',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string' },
      },
      required: ['tag'],
      additionalProperties: false,
    },
    validate(input) {
      const value = expectObject(input);
      const tag = expectString(value.tag, 'tag').trim();
      if (!tag) throw new TypeError('tag must be a non-empty string.');
      return { tag };
    },
    async execute(args) {
      if (!args.tag.trim()) throw new TypeError('tag must be a non-empty string.');
      const result = await idbTagStore.deleteTagEverywhere(args.tag);
      return { tag: args.tag, removed: result.removed };
    },
  };
}

function buildTagUsage(tags: Tag[]): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const row of tags) {
    for (const tag of visibleTagNames(row)) {
      const repos = usage.get(tag) ?? [];
      repos.push(row.full_name);
      usage.set(tag, repos);
    }
  }
  return usage;
}

function assertRepositoryInScope(repositoryScope: ReadonlySet<string>, fullName: string): void {
  if (!repositoryScope.has(fullName)) {
    throw new TypeError(`Repository is outside the authorized scope: ${fullName}`);
  }
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
  return new Set(meta.filter((entry) => entry.excluded).map((entry) => policyTagKey(entry.name)));
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
  const limit = value.limit === undefined
    ? DEFAULT_PAGE_LIMIT
    : expectPositiveInteger(value.limit, 'limit');
  let cursor = 0;
  if (value.cursor !== undefined) {
    const rawCursor = expectString(value.cursor, 'cursor');
    if (!/^\d+$/.test(rawCursor)) throw new Error('Expected cursor to be a non-negative integer string.');
    cursor = Number(rawCursor);
    if (!Number.isSafeInteger(cursor)) throw new Error('Expected cursor to be a safe integer string.');
  }
  return { cursor, limit: Math.min(limit, MAX_PAGE_LIMIT) };
}

function expectString(input: unknown, field: string): string {
  if (typeof input !== 'string') {
    throw new Error(`Expected ${field} to be a string.`);
  }
  return input;
}

function expectAgentTagArray(input: unknown, field: string): string[] {
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
  if (tags.length > TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT) {
    throw new Error(`Expected ${field} to include at most ${TAG_ADDITIONS_PER_REPOSITORY_HARD_LIMIT} tags.`);
  }
  return tags;
}

function expectPositiveInteger(input: unknown, field: string): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input <= 0) {
    throw new Error(`Expected ${field} to be a positive integer.`);
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

function buildBoundedPage<TItem, TResult>(
  items: TItem[],
  args: PageArgs,
  build: (page: TItem[], nextCursor: string | null) => TResult,
  maxSerializedBytes = MAX_TOOL_RESULT_BYTES,
): TResult {
  const available = items.slice(args.cursor, args.cursor + args.limit);
  for (let count = available.length; count > 0; count--) {
    const nextOffset = args.cursor + count;
    const result = build(available.slice(0, count), nextOffset < items.length ? String(nextOffset) : null);
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
