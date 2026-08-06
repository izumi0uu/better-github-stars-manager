import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createBgsmAgentTools } from '@/bgsm-agent/tools';
import {
  buildBgsmAgentTagCoverageSnapshot,
  createBgsmAgentTagAssignmentPolicy,
  prospectiveBgsmAgentTagCoverage,
} from '@/bgsm-agent/tag-assignment-policy';
import type { Star, Tag, TagMeta } from '@/types';

const timestamp = '2026-08-01T00:00:00.000Z';

function star(
  fullName: string,
  topics: string[] = [],
  tombstone = false,
): Star {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: '',
    language: null,
    stargazers_count: 1,
    topics,
    pushed_at: timestamp,
    created_at: timestamp,
    fork: false,
    archived: false,
    starred_at: timestamp,
    tombstone,
    synced_at: timestamp,
  };
}

function tag(
  fullName: string,
  layers: Readonly<{
    manual?: string[];
    auto?: string[];
    dismissed?: string[];
  }> = {},
): Tag {
  return {
    full_name: fullName,
    manualTags: layers.manual ?? [],
    autoTags: layers.auto ?? [],
    dismissedAutoTags: layers.dismissed ?? [],
    manualTagsMtime: timestamp,
    autoTagsMtime: timestamp,
    dismissedAutoTagsMtime: timestamp,
    notes: '',
    favorite: false,
    mtime: timestamp,
  };
}

function tagMeta(name: string, excluded: boolean): TagMeta {
  return {
    name,
    dimension: null,
    color: null,
    excluded,
    mtime: timestamp,
  };
}

function assignmentTool(options: Parameters<typeof createBgsmAgentTools>[0]) {
  const tool = createBgsmAgentTools(options)
    .find((candidate) => candidate.name === 'assign_repo_tags');
  assert.ok(tool);
  return tool;
}

describe('Cubby Chat tag assignment policy', () => {
  it('snapshots normalized preferences and loads library coverage lazily', async () => {
    let loads = 0;
    const policy = createBgsmAgentTagAssignmentPolicy(
      { maxTagsPerRepo: '8', minTopicRepoCount: '3' },
      () => {
        loads += 1;
        return { stars: [], tags: [], tagMeta: [] };
      },
    );

    assert.equal(policy.maxTagsPerRepo, 8);
    assert.equal(policy.minRepoCount, 3);
    assert.equal(loads, 0);
    const [first, second] = await Promise.all([
      policy.loadCoverage(),
      policy.loadCoverage(),
    ]);
    assert.strictEqual(first, second);
    assert.equal(loads, 1);

    policy.invalidateCoverage();
    assert.notStrictEqual(await policy.loadCoverage(), first);
    assert.equal(loads, 2);
  });

  it('unions topics and visible tags by canonical live-repository coverage', () => {
    const coverage = buildBgsmAgentTagCoverageSnapshot({
      stars: [
        star('one/repo', ['React', 'third', 'build']),
        star('two/repo'),
        star('target/repo'),
        star('dismissed/repo'),
        star('dead/repo', ['third'], true),
      ],
      tags: [
        tag('one/repo', { manual: ['Ｒｅａｃｔ'], auto: ['BUILD'] }),
        tag('two/repo', { manual: ['ＴＨＩＲＤ'], auto: ['react'] }),
        tag('dismissed/repo', { dismissed: ['third'] }),
        tag('dead/repo', { manual: ['third'] }),
        tag('missing/repo', { manual: ['third'] }),
      ],
      tagMeta: [tagMeta('ＢＵＩＬＤ', true)],
    });

    assert.deepEqual([...coverage.repositoriesByTag.get('react') ?? []].sort(), [
      'one/repo',
      'two/repo',
    ]);
    assert.deepEqual([...coverage.repositoriesByTag.get('third') ?? []].sort(), [
      'one/repo',
      'two/repo',
    ]);
    assert.equal(coverage.repositoriesByTag.has('build'), false);
    assert.equal(coverage.visibleTagsByRepository.get('dismissed/repo')?.has('third'), false);
    assert.equal(coverage.visibleTagsByRepository.has('missing/repo'), false);
    assert.equal(prospectiveBgsmAgentTagCoverage(coverage, 'target/repo', 'ＴＨＩＲＤ'), 3);
    assert.equal(prospectiveBgsmAgentTagCoverage(coverage, 'one/repo', 'third'), 2);
    assert.equal(prospectiveBgsmAgentTagCoverage(coverage, 'target/repo', 'build'), 0);
  });

  it('enforces dynamic schema and cumulative per-turn limits above and below five', async () => {
    const writes: string[][] = [];
    const lowPolicy = createBgsmAgentTagAssignmentPolicy(
      { maxTagsPerRepo: 2, minTopicRepoCount: 1 },
      () => ({ stars: [], tags: [], tagMeta: [] }),
    );
    const low = assignmentTool({
      repositoryScope: ['owner/repo'],
      tagAssignmentPolicy: lowPolicy,
      assignManualTags: async (_fullName, tags) => {
        writes.push([...tags]);
        return { manualTags: [...tags], changed: true, reason: null };
      },
    });

    assert.throws(() => low.validate?.({
      full_name: 'owner/repo',
      tags: ['one', 'two', 'three'],
    }), /at most 2 tags/u);
    const calls = ['one', 'two', 'three'].map((name, index) => low.execute(
      low.validate?.({ full_name: 'owner/repo', tags: [name] }),
      { sessionId: 'limit', callId: `limit-${index}` },
    ));
    const results = await Promise.allSettled(calls);
    assert.deepEqual(results.map((result) => result.status), [
      'fulfilled',
      'fulfilled',
      'rejected',
    ]);
    assert.match(String((results[2] as PromiseRejectedResult).reason), /at most 2 tags/u);
    assert.deepEqual(writes, [['one'], ['two']]);

    const high = assignmentTool({
      repositoryScope: ['owner/repo'],
      tagAssignmentPolicy: createBgsmAgentTagAssignmentPolicy(
        { maxTagsPerRepo: 8, minTopicRepoCount: 1 },
        () => ({ stars: [], tags: [], tagMeta: [] }),
      ),
    });
    const parameters = high.parameters as {
      properties: { tags: { maxItems: number } };
    };
    assert.equal(parameters.properties.tags.maxItems, 8);
    const validated = high.validate?.({
      full_name: 'owner/repo',
      tags: ['one', 'two', 'three', 'four', 'five', 'six'],
    }) as { tags: string[] };
    assert.equal(validated.tags.length, 6);
  });

  it('does not consume the turn limit when the writer rejects the repository', async () => {
    let attempts = 0;
    const assign = assignmentTool({
      repositoryScope: ['owner/repo'],
      tagAssignmentPolicy: createBgsmAgentTagAssignmentPolicy(
        { maxTagsPerRepo: 1, minTopicRepoCount: 1 },
        () => ({ stars: [], tags: [], tagMeta: [] }),
      ),
      assignManualTags: async (_fullName, tags) => {
        attempts += 1;
        if (attempts === 1) {
          return { manualTags: [], changed: false, reason: 'missing' };
        }
        return { manualTags: [...tags], changed: true, reason: null };
      },
    });

    const first = await assign.execute(
      assign.validate?.({ full_name: 'owner/repo', tags: ['first'] }),
      { sessionId: 'failed-write', callId: 'failed-write-1' },
    ) as { reason: string | null };
    assert.equal(first.reason, 'missing');
    await assign.execute(
      assign.validate?.({ full_name: 'owner/repo', tags: ['second'] }),
      { sessionId: 'failed-write', callId: 'failed-write-2' },
    );
    await assert.rejects(
      () => assign.execute(
        assign.validate?.({ full_name: 'owner/repo', tags: ['third'] }),
        { sessionId: 'failed-write', callId: 'failed-write-3' },
      ),
      /at most 1 tags/u,
    );
    assert.equal(attempts, 2);
  });

  it('checks only new effects and rejects a mixed ineligible batch before writing', async () => {
    const library = {
      stars: [star('one/repo'), star('two/repo'), star('target/repo')],
      tags: [
        tag('one/repo', { manual: ['shared'] }),
        tag('two/repo', { auto: ['ＳＨＡＲＥＤ'] }),
        tag('target/repo', { manual: ['rare'] }),
      ],
      tagMeta: [],
    };
    const writes: string[][] = [];
    const assign = assignmentTool({
      repositoryScope: ['target/repo'],
      tagAssignmentPolicy: createBgsmAgentTagAssignmentPolicy(
        { maxTagsPerRepo: 5, minTopicRepoCount: 3 },
        () => library,
      ),
      assignManualTags: async (_fullName, tags) => {
        writes.push([...tags]);
        return { manualTags: [...tags], changed: true, reason: null };
      },
    });

    await assign.execute(
      assign.validate?.({ full_name: 'target/repo', tags: ['rare', 'shared'] }),
      { sessionId: 'coverage', callId: 'coverage-1' },
    );
    await assert.rejects(
      () => assign.execute(
        assign.validate?.({ full_name: 'target/repo', tags: ['shared', 'novel'] }),
        { sessionId: 'coverage', callId: 'coverage-2' },
      ),
      /minimum live-repository coverage of 3.*novel/u,
    );
    assert.deepEqual(writes, [['rare', 'shared']]);

    let minOneWrites = 0;
    const minOne = assignmentTool({
      repositoryScope: ['target/repo'],
      tagAssignmentPolicy: createBgsmAgentTagAssignmentPolicy(
        { maxTagsPerRepo: 5, minTopicRepoCount: 1 },
        () => ({ stars: [], tags: [], tagMeta: [] }),
      ),
      assignManualTags: async (_fullName, tags) => {
        minOneWrites += 1;
        return { manualTags: [...tags], changed: true, reason: null };
      },
    });
    await minOne.execute(
      minOne.validate?.({ full_name: 'target/repo', tags: ['novel'] }),
      { sessionId: 'min-one', callId: 'min-one-1' },
    );
    assert.equal(minOneWrites, 1);
  });

  it('reuses cached coverage safely across sequential successful assignments', async () => {
    const stars = [
      star('a/repo'),
      star('b/repo'),
      star('c/repo'),
      star('d/repo'),
    ];
    let tags = [
      tag('a/repo', { manual: ['shared'] }),
      tag('b/repo', { manual: ['shared'] }),
    ];
    let loads = 0;
    const writes: string[] = [];
    const assign = assignmentTool({
      repositoryScope: stars.map((item) => item.full_name),
      tagAssignmentPolicy: createBgsmAgentTagAssignmentPolicy(
        { maxTagsPerRepo: 5, minTopicRepoCount: 3 },
        () => {
          loads += 1;
          return { stars, tags, tagMeta: [] };
        },
      ),
      assignManualTags: async (fullName, submitted) => {
        writes.push(fullName);
        tags = [...tags, tag(fullName, { manual: [...submitted] })];
        return { manualTags: [...submitted], changed: true, reason: null };
      },
    });

    await assign.execute(
      assign.validate?.({ full_name: 'c/repo', tags: ['shared'] }),
      { sessionId: 'monotonic-coverage', callId: 'assign-c' },
    );
    await assign.execute(
      assign.validate?.({ full_name: 'd/repo', tags: ['shared'] }),
      { sessionId: 'monotonic-coverage', callId: 'assign-d' },
    );

    assert.deepEqual(writes, ['c/repo', 'd/repo']);
    assert.equal(tags.length, 4);
    assert.equal(loads, 1);
  });

  it('reloads coverage after repository removals and global deletions', async () => {
    const stars = [
      star('one/repo'),
      star('two/repo'),
      star('three/repo'),
      star('target/repo'),
    ];
    let tags = [
      tag('one/repo', { manual: ['shared'] }),
      tag('two/repo', { manual: ['shared'] }),
      tag('three/repo', { manual: ['shared'] }),
    ];
    let tagMetaRows: TagMeta[] = [];
    let loads = 0;
    let assignmentWrites = 0;
    const policy = createBgsmAgentTagAssignmentPolicy(
      { maxTagsPerRepo: 5, minTopicRepoCount: 3 },
      () => {
        loads += 1;
        return { stars, tags, tagMeta: tagMetaRows };
      },
    );
    const tools = createBgsmAgentTools({
      repositoryScope: stars.map((item) => item.full_name),
      tagAssignmentPolicy: policy,
      assignManualTags: async (_fullName, submitted) => {
        assignmentWrites += 1;
        return { manualTags: [...submitted], changed: true, reason: null };
      },
      removeVisibleTags: async (changes) => {
        const removedRepositories = new Set(changes.map((change) => change.full_name));
        tags = tags.filter((row) => !removedRepositories.has(row.full_name));
        return { requested: 2, changed: 2, skipped: 0, repositoriesChanged: 2 };
      },
      deleteTagsEverywhere: async (submitted) => {
        tagMetaRows = submitted.map((name) => tagMeta(name, true));
        return { requestedTags: submitted.length, assignmentsRemoved: 1, repositoriesChanged: 1 };
      },
    });
    const remove = tools.find((tool) => tool.name === 'remove_repo_tags');
    const assign = tools.find((tool) => tool.name === 'assign_repo_tags');
    const del = tools.find((tool) => tool.name === 'delete_tags_everywhere');
    assert.ok(remove);
    assert.ok(assign);
    assert.ok(del);

    await policy.loadCoverage();
    assert.equal(loads, 1);
    await remove.execute(remove.validate?.({
      changes: [
        { full_name: 'two/repo', tags: ['shared'] },
        { full_name: 'three/repo', tags: ['shared'] },
      ],
    }), { sessionId: 'invalidate', callId: 'remove' });
    await assert.rejects(
      () => assign.execute(
        assign.validate?.({ full_name: 'target/repo', tags: ['shared'] }),
        { sessionId: 'invalidate', callId: 'assign' },
      ),
      /minimum live-repository coverage of 3/u,
    );
    assert.equal(loads, 2);
    assert.equal(assignmentWrites, 0);

    await del.execute(
      del.validate?.({ tags: ['shared'] }),
      { sessionId: 'invalidate', callId: 'delete' },
    );
    const afterDelete = await policy.loadCoverage();
    assert.equal(loads, 3);
    assert.equal(afterDelete.excludedTagKeys.has('shared'), true);
  });
});
