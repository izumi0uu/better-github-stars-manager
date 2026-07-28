import type { Star, Tag } from '@/types';
import { isRunId, type RunId } from './identity';
import {
  FROZEN_SCOPE_PAGE_DEFAULT,
  FROZEN_SCOPE_PAGE_HARD_LIMIT,
} from './policy';
import {
  createFrozenScopeCursor,
  validateFrozenScope,
  validateFrozenScopeCursor,
  type FrozenScope,
  type FrozenScopeCursor,
} from './scope';
import { buildSemanticRepositoryDto } from './semantic-dto';
import type { OrganizeJobRunPagePosition } from './organize-job';

export type SemanticRepositoryRecord = Readonly<{
  star: Star;
  tag: Tag | null;
}>;

export type FrozenScopePage = Readonly<{
  positions: readonly OrganizeJobRunPagePosition[];
  nextCursor: FrozenScopeCursor;
}>;

export async function loadFrozenScopePage(input: Readonly<{
  runId: RunId;
  generation: number;
  frozenScope: FrozenScope;
  cursor: FrozenScopeCursor;
  excludedTagNames: readonly string[];
  limit?: number;
  load: (
    repositoryIds: readonly string[],
  ) => Promise<ReadonlyMap<string, SemanticRepositoryRecord>>;
}>): Promise<FrozenScopePage> {
  if (!isRunId(input.runId)) throw new TypeError('FrozenScope page runId is malformed.');
  validateFrozenScope(input.frozenScope);
  validateFrozenScopeCursor(input.cursor);
  if (input.cursor.runId !== input.runId || input.cursor.generation !== input.generation) {
    throw new TypeError('FrozenScope cursor belongs to another run generation.');
  }
  if (input.cursor.nextFrozenIndex > input.frozenScope.count) {
    throw new RangeError('FrozenScope cursor exceeds the frozen scope.');
  }
  const limit = input.limit ?? FROZEN_SCOPE_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError('FrozenScope page limit must be a positive safe integer.');
  }
  const start = input.cursor.nextFrozenIndex;
  const end = Math.min(
    start + Math.min(limit, FROZEN_SCOPE_PAGE_HARD_LIMIT),
    input.frozenScope.count,
  );
  const repositoryIds = Object.freeze(input.frozenScope.repositoryIds.slice(start, end));
  const records = await input.load(repositoryIds);
  const positions: OrganizeJobRunPagePosition[] = [];
  for (let offset = 0; offset < repositoryIds.length; offset += 1) {
    const frozenIndex = start + offset;
    const repositoryId = repositoryIds[offset];
    const record = records.get(repositoryId);
    if (!record) {
      positions.push(Object.freeze({ frozenIndex, repositoryId, kind: 'missing' }));
    } else if (record.star.tombstone) {
      positions.push(Object.freeze({ frozenIndex, repositoryId, kind: 'tombstoned' }));
    } else {
      positions.push(Object.freeze({
        frozenIndex,
        repositoryId,
        kind: 'live',
        repository: await buildSemanticRepositoryDto({
          frozenIndex,
          ...record,
          excludedTagNames: input.excludedTagNames,
        }),
      }));
    }
  }
  return Object.freeze({
    positions: Object.freeze(positions),
    nextCursor: createFrozenScopeCursor(input.runId, input.generation, end),
  });
}
