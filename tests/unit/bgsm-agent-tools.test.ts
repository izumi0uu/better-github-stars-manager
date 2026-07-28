import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import {
  MAX_TOOL_RESULT_BYTES,
  okToolResult,
  serializedToolResultByteLength,
} from '@/agent-harness';
import { createBgsmAgentTools, loadLiveBgsmAgentRepositoryScope } from '@/bgsm-agent';
import { db } from '@/storage/db';
import { resetDirtyForDev, snapshotDirty } from '@/storage/idb-tag-store';
import { visibleTagNames } from '@/tags/tag-model';
import type { Star } from '@/types';

const encoder = new TextEncoder();

function resultAllowance(maxSerializedBytes: number) {
  return {
    maxSerializedBytes,
    contextRemainingTokens: 10_000,
    memoryRemainingBytes: maxSerializedBytes,
  };
}

const star = {
  full_name: 'owner/repo',
  html_url: 'https://github.com/owner/repo',
  description: 'A TypeScript build tool',
  language: 'TypeScript',
  topics: ['typescript', 'build-tool'],
  stargazers_count: 100,
  archived: false,
  fork: false,
  starred_at: '2026-07-01T00:00:00Z',
  pushed_at: '2026-07-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  tombstone: false,
  synced_at: '2026-07-01T00:00:00Z',
} satisfies Star;

function createTools(repositoryScope: readonly string[] = [star.full_name]) {
  return createBgsmAgentTools({ repositoryScope, scopeFingerprint: 'scope:test' });
}

function createToolsWithDestructive(repositoryScope: readonly string[] = [star.full_name]) {
  return createBgsmAgentTools({
    repositoryScope,
    scopeFingerprint: 'scope:test',
    allowDestructiveWrites: true,
  });
}

describe('BGSM Agent tools', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    resetDirtyForDev();
    await db.stars.put(star);
  });

  afterAll(async () => {
    await db.close();
  });

  it('assigns tags through the direct agent write tool', async () => {
    const tool = createTools().find((candidate) => candidate.name === 'assign_repo_tags');
    assert.ok(tool);

    const args = tool.validate?.({
      full_name: 'owner/repo',
      tags: ['typescript', 'build'],
    });
    const result = await tool.execute(args, {
      sessionId: 's1',
      callId: 'call-1',
    }) as { changed: boolean; tags: string[] };

    assert.equal(result.changed, true);
    assert.deepEqual(visibleTagNames(await db.tags.get('owner/repo')), ['typescript', 'build']);
    assert.deepEqual(snapshotDirty().names, ['owner/repo']);
  });

  it('does not expose the removed local suggestion tools', () => {
    const names = createTools().map((tool) => tool.name);
    assert.equal(names.includes('suggest_repo_tags'), false);
    assert.equal(names.includes('suggest_tag_cleanup'), false);
  });

  it('omits destructive write tools by default and keeps them opt-in only', () => {
    const defaultNames = createTools().map((tool) => tool.name);
    assert.equal(defaultNames.includes('remove_repo_tag'), false);
    assert.equal(defaultNames.includes('delete_tag_everywhere'), false);
    assert.equal(defaultNames.includes('assign_repo_tags'), true);
    const assign = createTools().find((tool) => tool.name === 'assign_repo_tags');
    assert.match(assign?.description ?? '', /only when the user wants its tags changed/);
    assert.match(assign?.description ?? '', /current turn/);

    const optInNames = createToolsWithDestructive().map((tool) => tool.name);
    assert.equal(optInNames.includes('remove_repo_tag'), true);
    assert.equal(optInNames.includes('delete_tag_everywhere'), true);
  });

  it('registers repository list/search/read only when explicitly enabled with frozen-scope schemas', () => {
    const disabled = createBgsmAgentTools({ repositoryScope: [star.full_name] });
    const enabled = createBgsmAgentTools({
      repositoryScope: [star.full_name],
      enableRepositoryCodeSearch: true,
    });
    for (const name of [
      'list_repository_files',
      'search_repository_code',
      'read_repository_file',
    ]) {
      assert.equal(disabled.some((tool) => tool.name === name), false);
      assert.equal(enabled.some((tool) => tool.name === name), true);
    }
    assert.deepEqual(
      enabled
        .filter((tool) => [
          'list_repository_files',
          'search_repository_code',
          'read_repository_file',
        ].includes(tool.name))
        .map((tool) => tool.name),
      ['list_repository_files', 'search_repository_code', 'read_repository_file'],
    );

    const list = enabled.find((tool) => tool.name === 'list_repository_files');
    const search = enabled.find((tool) => tool.name === 'search_repository_code');
    const read = enabled.find((tool) => tool.name === 'read_repository_file');
    assert.ok(list);
    assert.ok(search);
    assert.ok(read);
    const ref = 'a'.repeat(40);
    assert.deepEqual(list.validate?.({ repository: 'OWNER/REPO', path: 'src', ref, limit: 10 }), {
      repository: 'owner/repo',
      path: 'src',
      ref,
      limit: 10,
    });
    assert.deepEqual(search.parameters, {
      type: 'object',
      properties: {
        query: { type: 'string' },
        repository: { type: 'string', enum: ['owner/repo'] },
      },
      required: ['query'],
      additionalProperties: false,
    });
    assert.deepEqual(search.validate?.({ query: 'createFrozenScope' }), {
      query: 'createFrozenScope',
    });
    assert.throws(
      () => search.validate?.({ query: 'needle', repository: 'other/repo' }),
      /outside the frozen scope/i,
    );
    assert.deepEqual(read.validate?.({
      repository: 'owner/repo',
      path: 'src/index.ts',
      ref,
      lineStart: 5,
      lineEnd: 12,
    }), {
      repository: 'owner/repo',
      path: 'src/index.ts',
      ref,
      lineStart: 5,
      lineEnd: 12,
    });
    assert.throws(
      () => list.validate?.({ repository: 'other/repo' }),
      /outside the frozen scope/i,
    );
  });

  it('registers scoped repository notes only when explicitly enabled with a strict schema', () => {
    const disabled = createBgsmAgentTools({ repositoryScope: [star.full_name] });
    const enabled = createBgsmAgentTools({
      repositoryScope: [star.full_name],
      enableRepositoryNotes: true,
    });
    assert.equal(disabled.some((tool) => tool.name === 'read_repository_notes'), false);
    const readNotes = enabled.find((tool) => tool.name === 'read_repository_notes');
    assert.ok(readNotes);
    assert.deepEqual(readNotes.parameters, {
      type: 'object',
      properties: {
        full_names: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 5,
        },
      },
      required: ['full_names'],
      additionalProperties: false,
    });
    assert.deepEqual(readNotes.validate?.({ full_names: [' owner/repo '] }), {
      full_names: ['owner/repo'],
    });
    assert.throws(() => readNotes.validate?.({ full_names: [] }), /at least one/u);
    assert.throws(
      () => readNotes.validate?.({ full_names: ['owner/repo'], extra: true }),
      /only full_names/u,
    );
    assert.throws(
      () => readNotes.validate?.({ full_names: ['owner/repo', 'OWNER/REPO'] }),
      /duplicate/u,
    );
    assert.throws(
      () => readNotes.validate?.({ full_names: Array.from({ length: 6 }, (_, index) => `owner/${index}`) }),
      /at most 5/u,
    );
  });

  it('reads only ordered in-scope notes with UTF-8 and result-byte bounds', async () => {
    const repositories = [star.full_name, 'owner/empty', 'owner/unicode'];
    await db.stars.bulkPut([
      { ...star, full_name: 'owner/empty' },
      { ...star, full_name: 'owner/unicode' },
      { ...star, full_name: 'owner/outside' },
    ]);
    await db.tags.bulkPut([
      {
        full_name: star.full_name,
        manualTags: ['private-tag'],
        autoTags: [],
        dismissedAutoTags: [],
        manualTagsMtime: star.synced_at,
        autoTagsMtime: star.synced_at,
        dismissedAutoTagsMtime: star.synced_at,
        notes: 'Remember this build tool',
        favorite: true,
        mtime: star.synced_at,
      },
      {
        full_name: 'owner/unicode',
        manualTags: [],
        autoTags: [],
        dismissedAutoTags: [],
        manualTagsMtime: star.synced_at,
        autoTagsMtime: star.synced_at,
        dismissedAutoTagsMtime: star.synced_at,
        notes: '界'.repeat(500),
        favorite: false,
        mtime: star.synced_at,
      },
    ]);
    const readNotes = createBgsmAgentTools({
      repositoryScope: repositories,
      enableRepositoryNotes: true,
    }).find((tool) => tool.name === 'read_repository_notes');
    assert.ok(readNotes);

    const result = await readNotes.execute(readNotes.validate?.({
      full_names: ['owner/unicode', star.full_name, 'owner/empty'],
    }), { sessionId: 's-notes', callId: 'call-notes' }) as {
      notes: Array<Record<string, unknown>>;
    };
    assert.deepEqual(result.notes.map((entry) => entry.full_name), [
      'owner/unicode',
      star.full_name,
      'owner/empty',
    ]);
    assert.equal(encoder.encode(result.notes[0]?.note as string).byteLength, 1_023);
    assert.equal(result.notes[0]?.truncated, true);
    assert.equal(result.notes[1]?.note, 'Remember this build tool');
    assert.equal(result.notes[1]?.truncated, false);
    assert.equal(result.notes[2]?.note, null);
    assert.deepEqual(Object.keys(result.notes[1]!).sort(), ['full_name', 'note', 'truncated']);
    assert.ok(serializedToolResultByteLength(okToolResult(result)) <= MAX_TOOL_RESULT_BYTES);

    const reduced = await readNotes.execute(readNotes.validate?.({
      full_names: ['owner/unicode', star.full_name, 'owner/empty'],
    }), {
      sessionId: 's-notes-small-allowance',
      callId: 'call-notes-small-allowance',
      resultAllowance: resultAllowance(420),
    }) as { notes: Array<{ full_name: string; note: string | null; truncated: boolean }> };
    assert.deepEqual(reduced.notes.map((entry) => entry.full_name), [
      'owner/unicode',
      star.full_name,
      'owner/empty',
    ]);
    assert.equal(reduced.notes[0]?.truncated, true);
    assert.equal(reduced.notes[1]?.note, 'Remember this build tool');
    assert.equal(reduced.notes[1]?.truncated, false);
    assert.equal(reduced.notes[2]?.truncated, false);
    assert.ok(serializedToolResultByteLength(okToolResult(reduced)) <= 420);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(okToolResult(reduced))));

    assert.throws(
      () => readNotes.validate?.({ full_names: ['owner/outside'] }),
      /outside the authorized scope/u,
    );
    await assert.rejects(
      () => readNotes.execute(
        { full_names: ['owner/outside'] },
        { sessionId: 's-notes-bypass', callId: 'call-notes-bypass' },
      ),
      /outside the authorized scope/u,
    );
  });

  it('rejects a repository that becomes tombstoned before its note is read', async () => {
    const readNotes = createBgsmAgentTools({
      repositoryScope: [star.full_name],
      enableRepositoryNotes: true,
    }).find((tool) => tool.name === 'read_repository_notes');
    assert.ok(readNotes);
    await db.stars.update(star.full_name, { tombstone: true });
    await assert.rejects(
      () => readNotes.execute(
        readNotes.validate?.({ full_names: [star.full_name] }),
        { sessionId: 's-notes-race', callId: 'call-notes-race' },
      ),
      /no longer available/u,
    );
  });

  it('adds only manual tags and never rewrites auto tags or promotes auto into manual', async () => {
    await db.tags.put({
      full_name: star.full_name,
      manualTags: ['manual-existing'],
      autoTags: ['auto-only'],
      dismissedAutoTags: [],
      manualTagsMtime: star.synced_at,
      autoTagsMtime: star.synced_at,
      dismissedAutoTagsMtime: star.synced_at,
      notes: 'private note must stay local',
      favorite: true,
      mtime: star.synced_at,
    });
    const tool = createTools().find((candidate) => candidate.name === 'assign_repo_tags');
    assert.ok(tool);
    const result = await tool.execute(tool.validate?.({
      full_name: star.full_name,
      tags: ['manual-new'],
    }), { sessionId: 's-manual', callId: 'call-manual' }) as {
      changed: boolean;
      tags: string[];
    };
    assert.equal(result.changed, true);
    // Return surface is the manual layer after additive write.
    assert.deepEqual(result.tags, ['manual-existing', 'manual-new']);
    const stored = await db.tags.get(star.full_name);
    assert.deepEqual(stored?.manualTags, ['manual-existing', 'manual-new']);
    assert.deepEqual(stored?.autoTags, ['auto-only']);
    assert.equal(stored?.notes, 'private note must stay local');
    assert.equal(stored?.favorite, true);
  });

  it('routes manual-tag assignment through the injected background writer', async () => {
    let received: unknown = null;
    const context = { sessionId: 's-queued-write', callId: 'call-queued-write' };
    const assign = createBgsmAgentTools({
      repositoryScope: [star.full_name],
      assignManualTags: async (fullName, tags, executionContext) => {
        received = { fullName, tags, executionContext };
        return {
          manualTags: ['queued'],
          changed: true,
          reason: null,
        };
      },
    }).find((candidate) => candidate.name === 'assign_repo_tags');
    assert.ok(assign);

    const result = await assign.execute(assign.validate?.({
      full_name: star.full_name,
      tags: ['queued'],
    }), context);

    assert.deepEqual(received, {
      fullName: star.full_name,
      tags: ['queued'],
      executionContext: context,
    });
    assert.deepEqual(result, {
      full_name: star.full_name,
      tags: ['queued'],
      changed: true,
      reason: null,
    });
    assert.equal(await db.tags.get(star.full_name), undefined);
  });

  it('rejects empty or whitespace-only assign and delete tags', async () => {
    const assign = createTools().find((candidate) => candidate.name === 'assign_repo_tags');
    assert.ok(assign);
    assert.throws(
      () => assign.validate?.({ full_name: star.full_name, tags: ['  ', ''] }),
      /at least one tag|non-empty/u,
    );

    const del = createToolsWithDestructive().find((candidate) => candidate.name === 'delete_tag_everywhere');
    assert.ok(del);
    assert.throws(() => del.validate?.({ tag: '   ' }), /non-empty/u);
  });

  it('normalizes direct tag arguments and enforces semantic hard limits', () => {
    const assign = createTools().find((candidate) => candidate.name === 'assign_repo_tags');
    assert.ok(assign);
    assert.deepEqual(assign.validate?.({
      full_name: star.full_name,
      tags: ['  Ｒｅａｃｔ  ', 'React'],
    }), {
      full_name: star.full_name,
      tags: ['React'],
    });
    assert.throws(() => assign.validate?.({
      full_name: star.full_name,
      tags: ['a', 'b', 'c', 'd', 'e', 'f'],
    }), /at most 5 tags/u);
    assert.throws(() => assign.validate?.({
      full_name: star.full_name,
      tags: ['界'.repeat(86)],
    }), /256 UTF-8 bytes/u);
  });

  it('canonicalizes assignment effects by scope, repository, and normalized tag', () => {
    const assign = createBgsmAgentTools({
      repositoryScope: [star.full_name],
      scopeFingerprint: 'scope:canonical',
    }).find((candidate) => candidate.name === 'assign_repo_tags');
    assert.ok(assign?.writeEffectPlan);
    const args = assign.validate?.({
      full_name: ' OWNER／REPO ',
      tags: [' Ｒｅａｃｔ ', 'react', 'Build'],
    });
    assert.deepEqual(assign.writeEffectPlan.canonicalEffects(args), [
      ['assign_repo_tags', 'scope:canonical', 'owner/repo', 'build'],
      ['assign_repo_tags', 'scope:canonical', 'owner/repo', 'react'],
    ]);
    assert.deepEqual(
      assign.writeEffectPlan.selectEffects?.(args, [
        ['assign_repo_tags', 'scope:canonical', 'owner/repo', 'react'],
      ]),
      { full_name: 'owner/repo', tags: ['React'] },
    );
  });

  it('loads a stable all-live scope for a standalone Chat turn', async () => {
    await db.stars.bulkPut([
      { ...star, full_name: 'z/live' },
      { ...star, full_name: 'a/tombstoned', tombstone: true },
      { ...star, full_name: 'a/live' },
    ]);
    assert.deepEqual(await loadLiveBgsmAgentRepositoryScope(), [
      'a/live',
      'owner/repo',
      'z/live',
    ]);
  });

  it('never resurrects excluded tags through model-facing assignment', async () => {
    await db.tags.put({
      full_name: star.full_name,
      manualTags: ['kept'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: star.synced_at,
      autoTagsMtime: star.synced_at,
      dismissedAutoTagsMtime: star.synced_at,
      notes: 'private note must stay local',
      favorite: true,
      mtime: star.synced_at,
    });
    await db.tagMeta.put({
      name: 'old-test',
      dimension: null,
      color: null,
      mtime: star.synced_at,
      excluded: true,
    });

    const assign = createTools().find((candidate) => candidate.name === 'assign_repo_tags');
    assert.ok(assign);
    const excluded = await assign.execute(assign.validate?.({
      full_name: star.full_name,
      tags: ['OLD-TEST'],
    }), { sessionId: 's-excluded', callId: 'call-excluded' }) as {
      changed: boolean;
      reason: string | null;
    };
    assert.equal(excluded.changed, false);
    assert.equal(excluded.reason, 'excluded_tag');

    // Safe path may still add a non-excluded tag without clearing the tombstone.
    const result = await assign.execute(assign.validate?.({
      full_name: star.full_name,
      tags: ['safe-new'],
    }), { sessionId: 's-safe', callId: 'call-safe' }) as {
      changed: boolean;
      tags: string[];
    };
    assert.equal(result.changed, true);
    assert.deepEqual(result.tags, ['kept', 'safe-new']);

    const stored = await db.tags.get(star.full_name);
    assert.deepEqual(stored?.manualTags, ['kept', 'safe-new']);
    assert.equal(stored?.notes, 'private note must stay local');
    assert.equal(stored?.favorite, true);
    assert.equal((await db.tagMeta.get('old-test'))?.excluded, true);
    assert.equal(snapshotDirty().meta, false);
  });

  it('returns compact, cursor-paginated star search results', async () => {
    await db.stars.bulkPut([
      star,
      { ...star, full_name: 'owner/repo-2', html_url: 'https://github.com/owner/repo-2' },
      { ...star, full_name: 'owner/repo-3', html_url: 'https://github.com/owner/repo-3' },
    ]);
    const tool = createTools(['owner/repo', 'owner/repo-2', 'owner/repo-3'])
      .find((candidate) => candidate.name === 'search_stars');
    assert.ok(tool);

    const firstArgs = tool.validate?.({ terms: ['owner/repo'], limit: 2 });
    const first = await tool.execute(firstArgs, {
      sessionId: 's-search',
      callId: 'call-search-1',
    }) as {
      stars: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };

    assert.deepEqual(first.stars.map((item) => item.full_name), ['owner/repo', 'owner/repo-2']);
    assert.equal(first.nextCursor, '2');
    assert.equal('html_url' in first.stars[0]!, false);
    assert.equal('synced_at' in first.stars[0]!, false);
    assert.equal('tombstone' in first.stars[0]!, false);

    const secondArgs = tool.validate?.({
      terms: ['owner/repo'],
      limit: 2,
      cursor: first.nextCursor,
    });
    const second = await tool.execute(secondArgs, {
      sessionId: 's-search',
      callId: 'call-search-2',
    }) as { stars: Array<{ full_name: string }>; nextCursor: string | null };

    assert.deepEqual(second.stars.map((item) => item.full_name), ['owner/repo-3']);
    assert.equal(second.nextCursor, null);
  });

  it('lists the complete authorized live-star inventory in stable bounded pages', async () => {
    const candidates = [
      { ...star, full_name: 'zeta/last', html_url: 'https://github.com/zeta/last' },
      { ...star, full_name: 'alpha/first', html_url: 'https://github.com/alpha/first' },
      {
        ...star,
        full_name: 'middle/removed',
        html_url: 'https://github.com/middle/removed',
        tombstone: true,
      },
    ];
    await db.stars.bulkPut(candidates);
    await db.tags.bulkPut(candidates.slice(0, 2).map((candidate) => ({
      full_name: candidate.full_name,
      manualTags: ['visible', 'excluded'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: star.synced_at,
      autoTagsMtime: star.synced_at,
      dismissedAutoTagsMtime: star.synced_at,
      notes: 'private note',
      favorite: true,
      mtime: star.synced_at,
    })));
    await db.tagMeta.put({
      name: 'excluded',
      dimension: null,
      color: null,
      excluded: true,
      mtime: star.synced_at,
    });
    const list = createBgsmAgentTools({
      repositoryScope: candidates.map((candidate) => candidate.full_name),
      scopeLabel: 'All starred repositories',
    }).find((candidate) => candidate.name === 'list_stars');
    assert.ok(list);

    const first = await list.execute(list.validate?.({ limit: 1 }), {
      sessionId: 's-list-stars',
      callId: 'c-list-stars-1',
    }) as {
      stars: Array<Record<string, unknown>>;
      totalRepositories: number;
      scope: { label: string; repositoryCount: number; liveRepositoryCount: number };
      nextCursor: string | null;
    };
    assert.deepEqual(first.stars.map((candidate) => candidate.full_name), ['alpha/first']);
    assert.deepEqual(first.stars[0]?.tags, ['visible']);
    assert.equal('notes' in first.stars[0]!, false);
    assert.equal('favorite' in first.stars[0]!, false);
    assert.equal(first.totalRepositories, 2);
    assert.deepEqual(first.scope, {
      label: 'All starred repositories',
      repositoryCount: 3,
      liveRepositoryCount: 2,
    });
    assert.equal(first.nextCursor, '1');

    const second = await list.execute(list.validate?.({ cursor: first.nextCursor, limit: 10 }), {
      sessionId: 's-list-stars',
      callId: 'c-list-stars-2',
    }) as { stars: Array<{ full_name: string }>; nextCursor: string | null };
    assert.deepEqual(second.stars.map((candidate) => candidate.full_name), ['zeta/last']);
    assert.equal(second.nextCursor, null);
    assert.ok(serializedToolResultByteLength(okToolResult(first)) <= MAX_TOOL_RESULT_BYTES);
  });

  it('normalizes and deduplicates structured search terms with strict bounds', () => {
    const search = createTools().find((candidate) => candidate.name === 'search_stars');
    assert.ok(search);

    assert.deepEqual(search.validate?.({
      terms: ['  Better_GitHub.Stars  ', 'better/github/stars', ' ＲＥＡＣＴ '],
      match: 'all',
      limit: 3,
    }), {
      terms: ['better github stars', 'react'],
      match: 'all',
      cursor: 0,
      limit: 3,
    });
    assert.throws(() => search.validate?.({ terms: [] }), /at least one term/u);
    assert.throws(() => search.validate?.({ terms: ['x'.repeat(129)] }), /128 UTF-8 bytes/u);
    assert.throws(
      () => search.validate?.({ terms: Array.from({ length: 9 }, (_, index) => `${index}`) }),
      /at most 8 terms/u,
    );
    assert.throws(() => search.validate?.({ terms: ['repo'], match: 'some' }), /auto, all, or any/u);
    assert.throws(() => search.validate?.({ terms: ['repo'], query: 'legacy' }), /accepts only/u);
    assert.throws(
      () => search.validate?.({ terms: ['star OR stars manager'] }),
      /must not contain Boolean operators/u,
    );
    assert.throws(
      () => search.validate?.({ terms: ['star ＯＲ stars manager'] }),
      /must not contain Boolean operators/u,
    );
    assert.throws(
      () => search.validate?.({ terms: ['star/ＯＲ/stars'] }),
      /must not contain Boolean operators/u,
    );
    assert.throws(
      () => search.validate?.({ terms: ['star-AND-manager'] }),
      /must not contain Boolean operators/u,
    );
    assert.deepEqual(search.validate?.({
      terms: ['research and development', 'android', 'orchestration', 'notable'],
    }), {
      terms: ['research and development', 'android', 'orchestration', 'notable'],
      match: 'auto',
      cursor: 0,
      limit: 20,
    });
  });

  it('supports all and any matching and makes auto fallback explicit', async () => {
    const candidates = [
      {
        ...star,
        full_name: 'izumi0uu/better-github-stars-manager',
        description: 'A browser extension',
        language: 'TypeScript',
        topics: ['github-stars', 'bookmark-manager'],
      },
      {
        ...star,
        full_name: 'owner/better-bookmarks',
        description: 'A bookmark organizer',
        language: 'JavaScript',
        topics: ['bookmarks'],
      },
    ];
    await db.stars.bulkPut(candidates);
    const search = createTools(candidates.map((candidate) => candidate.full_name))
      .find((candidate) => candidate.name === 'search_stars');
    assert.ok(search);

    const all = await search.execute(search.validate?.({
      terms: ['better', 'typescript'],
      match: 'all',
    }), { sessionId: 's-search-all', callId: 'c-search-all' }) as {
      stars: Array<{ full_name: string }>;
      requestedMode: string;
      appliedMode: string;
      totalMatches: number;
    };
    assert.deepEqual(all.stars.map((candidate) => candidate.full_name), [
      'izumi0uu/better-github-stars-manager',
    ]);
    assert.equal(all.requestedMode, 'all');
    assert.equal(all.appliedMode, 'all');
    assert.equal(all.totalMatches, 1);

    const any = await search.execute(search.validate?.({
      terms: ['better', 'typescript'],
      match: 'any',
    }), { sessionId: 's-search-any', callId: 'c-search-any' }) as {
      stars: Array<{ full_name: string }>;
      appliedMode: string;
      totalMatches: number;
    };
    assert.deepEqual(new Set(any.stars.map((candidate) => candidate.full_name)), new Set([
      'izumi0uu/better-github-stars-manager',
      'owner/better-bookmarks',
    ]));
    assert.equal(any.appliedMode, 'any');
    assert.equal(any.totalMatches, 2);

    const fallback = await search.execute(search.validate?.({
      terms: ['github stars', 'rust'],
    }), { sessionId: 's-search-auto', callId: 'c-search-auto' }) as {
      stars: Array<{ full_name: string }>;
      normalizedTerms: string[];
      requestedMode: string;
      appliedMode: string;
    };
    assert.deepEqual(fallback.stars.map((candidate) => candidate.full_name), [
      'izumi0uu/better-github-stars-manager',
    ]);
    assert.deepEqual(fallback.normalizedTerms, ['github stars', 'rust']);
    assert.equal(fallback.requestedMode, 'auto');
    assert.equal(fallback.appliedMode, 'any');
  });

  it('ranks deterministic field matches and reports evidence without reading notes', async () => {
    const candidates = [
      { ...star, full_name: 'owner/needle', description: '', language: null, topics: [] },
      { ...star, full_name: 'another/owner-needle', description: '', language: null, topics: [] },
      { ...star, full_name: 'another/owner-needle-kit', description: '', language: null, topics: [] },
      { ...star, full_name: 'another/x-owner-needle', description: '', language: null, topics: [] },
      { ...star, full_name: 'another/topic-only', description: '', language: null, topics: ['owner-needle'] },
      { ...star, full_name: 'another/language-only', description: '', language: 'owner needle', topics: [] },
      { ...star, full_name: 'another/description-only', description: 'Uses owner needle internally', language: null, topics: [] },
      { ...star, full_name: 'another/note-only', description: '', language: null, topics: [] },
    ];
    await db.stars.bulkPut(candidates);
    await db.tags.put({
      full_name: 'another/note-only',
      manualTags: [],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: star.synced_at,
      autoTagsMtime: star.synced_at,
      dismissedAutoTagsMtime: star.synced_at,
      notes: 'owner needle is private',
      favorite: false,
      mtime: star.synced_at,
    });
    const search = createTools(candidates.map((candidate) => candidate.full_name))
      .find((candidate) => candidate.name === 'search_stars');
    assert.ok(search);

    const result = await search.execute(search.validate?.({
      terms: ['owner/needle'],
      match: 'all',
    }), { sessionId: 's-search-rank', callId: 'c-search-rank' }) as {
      stars: Array<{ full_name: string; matchedFields: string[]; score: number }>;
    };
    assert.deepEqual(result.stars.map((candidate) => candidate.full_name), [
      'owner/needle',
      'another/owner-needle',
      'another/owner-needle-kit',
      'another/x-owner-needle',
      'another/topic-only',
      'another/language-only',
      'another/description-only',
    ]);
    assert.deepEqual(result.stars.map((candidate) => candidate.matchedFields), [
      ['full_name'],
      ['full_name', 'name'],
      ['full_name', 'name'],
      ['full_name', 'name'],
      ['topics'],
      ['language'],
      ['description'],
    ]);
    assert.equal(result.stars.every((candidate, index, array) => (
      index === 0 || array[index - 1]!.score > candidate.score
    )), true);
    assert.equal(result.stars.some((candidate) => candidate.full_name === 'another/note-only'), false);
  });

  it('gets an exact in-scope repository case-insensitively and returns its canonical name', async () => {
    const canonical = 'Izumi0uu/Better-GitHub-Stars-Manager';
    await db.stars.put({ ...star, full_name: canonical });
    const getStar = createBgsmAgentTools({
      repositoryScope: [canonical],
      scopeLabel: 'Selected repository',
    }).find((candidate) => candidate.name === 'get_star');
    assert.ok(getStar);

    const found = await getStar.execute(getStar.validate?.({
      full_name: ' izumi0UU/better-github-stars-manager ',
    }), { sessionId: 's-get-star', callId: 'c-get-star' }) as {
      star: { full_name: string } | null;
      normalizedFullName: string;
      status: string;
      scope: { label: string; repositoryCount: number };
    };
    assert.equal(found.status, 'found');
    assert.equal(found.star?.full_name, canonical);
    assert.equal(found.normalizedFullName, 'izumi0uu/better-github-stars-manager');
    assert.deepEqual(found.scope, { label: 'Selected repository', repositoryCount: 1 });
    assert.throws(
      () => getStar.validate?.({ full_name: `owner/${'x'.repeat(300)}` }),
      /bounded repository identifier/u,
    );
    assert.throws(
      () => getStar.validate?.({ full_name: 'owner/repo\nother' }),
      /bounded repository identifier/u,
    );
  });

  it('does not disclose scope-external repositories and rejects tombstoned scoped rows', async () => {
    await db.stars.bulkPut([
      { ...star, full_name: 'outside/existing' },
      { ...star, full_name: 'inside/tombstoned', tombstone: true },
    ]);
    const getStar = createTools(['inside/tombstoned'])
      .find((candidate) => candidate.name === 'get_star');
    assert.ok(getStar);

    const outsideExisting = await getStar.execute(
      getStar.validate?.({ full_name: 'outside/existing' }),
      { sessionId: 's-get-outside', callId: 'c-get-outside-existing' },
    ) as { star: unknown; status: string };
    const outsideMissing = await getStar.execute(
      getStar.validate?.({ full_name: 'outside/missing' }),
      { sessionId: 's-get-outside', callId: 'c-get-outside-missing' },
    ) as { star: unknown; status: string };
    const tombstoned = await getStar.execute(
      getStar.validate?.({ full_name: 'inside/tombstoned' }),
      { sessionId: 's-get-tombstone', callId: 'c-get-tombstone' },
    ) as { star: unknown; status: string };

    assert.deepEqual(
      [outsideExisting.status, outsideExisting.star, outsideMissing.status, outsideMissing.star],
      ['outside_scope', null, 'outside_scope', null],
    );
    assert.deepEqual([tombstoned.status, tombstoned.star], ['unavailable', null]);
  });

  it('returns scope diagnostics when structured search has no matches', async () => {
    await db.stars.bulkPut([
      { ...star, full_name: 'scope/live' },
      { ...star, full_name: 'scope/tombstoned', tombstone: true },
    ]);
    const search = createBgsmAgentTools({
      repositoryScope: ['scope/live', 'scope/tombstoned', 'scope/missing'],
      scopeLabel: 'Current filtered view',
    }).find((candidate) => candidate.name === 'search_stars');
    assert.ok(search);

    const result = await search.execute(search.validate?.({ terms: ['not-present'] }), {
      sessionId: 's-search-empty',
      callId: 'c-search-empty',
    }) as {
      stars: unknown[];
      totalMatches: number;
      requestedMode: string;
      appliedMode: string;
      scope: { label: string; repositoryCount: number; liveRepositoryCount: number };
    };
    assert.deepEqual(result.stars, []);
    assert.equal(result.totalMatches, 0);
    assert.equal(result.requestedMode, 'auto');
    assert.equal(result.appliedMode, 'any');
    assert.deepEqual(result.scope, {
      label: 'Current filtered view',
      repositoryCount: 3,
      liveRepositoryCount: 1,
    });
  });

  it('paginates list_tags and inspect_tag with compact DTOs', async () => {
    await db.stars.put({
      ...star,
      description: 'x'.repeat(20_000),
    });
    await db.tags.put({
      full_name: star.full_name,
      manualTags: ['build', 'typescript'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: star.synced_at,
      autoTagsMtime: star.synced_at,
      dismissedAutoTagsMtime: star.synced_at,
      notes: 'important',
      favorite: true,
      mtime: star.synced_at,
    });
    const tools = createTools();
    const listTags = tools.find((candidate) => candidate.name === 'list_tags');
    const inspectTag = tools.find((candidate) => candidate.name === 'inspect_tag');
    assert.ok(listTags);
    assert.ok(inspectTag);

    const listArgs = listTags.validate?.({ limit: 1 });
    const listed = await listTags.execute(listArgs, {
      sessionId: 's-tags',
      callId: 'call-tags',
    }) as { tags: Array<{ name: string }>; nextCursor: string | null };
    assert.deepEqual(listed.tags, [{ name: 'build', repos: 1 }]);
    assert.equal(listed.nextCursor, '1');

    const inspectArgs = inspectTag.validate?.({ tag: 'build', limit: 10 });
    const inspected = await inspectTag.execute(inspectArgs, {
      sessionId: 's-inspect',
      callId: 'call-inspect',
    }) as { repos: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.equal(inspected.repos.length, 1);
    assert.equal(inspected.repos[0]?.full_name, star.full_name);
    assert.equal('favorite' in inspected.repos[0]!, false);
    assert.equal('notes' in inspected.repos[0]!, false);
    assert.equal('tagRecord' in inspected.repos[0]!, false);
    assert.equal('html_url' in inspected.repos[0]!, false);
    assert.equal('synced_at' in inspected.repos[0]!, false);
    assert.equal('tombstone' in inspected.repos[0]!, false);
    assert.deepEqual(Object.keys(inspected.repos[0]!).sort(), [
      'archived',
      'created_at',
      'description',
      'fork',
      'full_name',
      'language',
      'pushed_at',
      'stargazers_count',
      'starred_at',
      'tags',
      'topics',
    ]);
    assert.equal(inspected.nextCursor, null);
    assert.ok(serializedToolResultByteLength(okToolResult(inspected)) <= MAX_TOOL_RESULT_BYTES);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(okToolResult(inspected))));
  });

  it('rejects invalid pagination cursors', () => {
    const tool = createTools().find((candidate) => candidate.name === 'search_stars');
    assert.ok(tool);
    assert.throws(() => tool.validate?.({ terms: ['repo'], cursor: '-1' }), /cursor/);
    assert.throws(() => tool.validate?.({ terms: ['repo'], cursor: '1.5' }), /cursor/);
  });

  it('keeps cursor continuity when the byte guard shrinks a requested page', async () => {
    const largeStars = Array.from({ length: 30 }, (_, index) => ({
      ...star,
      full_name: `owner/large-${String(index).padStart(2, '0')}`,
      html_url: `https://github.com/owner/large-${String(index).padStart(2, '0')}`,
      description: '界'.repeat(1_000),
      topics: Array.from({ length: 20 }, () => '界'.repeat(100)),
    }));
    await db.stars.bulkPut(largeStars);
    const tool = createTools(largeStars.map((item) => item.full_name))
      .find((candidate) => candidate.name === 'search_stars');
    assert.ok(tool);

    const first = await tool.execute(tool.validate?.({ terms: ['owner/large-'], limit: 30 }), {
      sessionId: 's-shrunk-page',
      callId: 'call-page-1',
    }) as { stars: Array<{ full_name: string; description: string }>; nextCursor: string | null };
    assert.ok(first.stars.length > 0 && first.stars.length < 30);
    assert.equal(first.nextCursor, String(first.stars.length));
    assert.ok(encoder.encode(first.stars[0]!.description).byteLength <= 512);
    assert.ok(serializedToolResultByteLength(okToolResult(first)) <= MAX_TOOL_RESULT_BYTES);

    const second = await tool.execute(tool.validate?.({
      terms: ['owner/large-'],
      limit: 30,
      cursor: first.nextCursor,
    }), {
      sessionId: 's-shrunk-page',
      callId: 'call-page-2',
    }) as { stars: Array<{ full_name: string }>; nextCursor: string | null };
    assert.equal(second.stars[0]?.full_name, `owner/large-${String(first.stars.length).padStart(2, '0')}`);
    assert.equal(new Set([...first.stars, ...second.stars].map((item) => item.full_name)).size,
      first.stars.length + second.stars.length);
  });

  it('uses the per-call allowance for list, search, and inspect pagination', async () => {
    const scopedStars = [
      { ...star, full_name: 'owner/allowance-1', description: '界'.repeat(1_000) },
      { ...star, full_name: 'owner/allowance-2', description: '界'.repeat(1_000) },
    ];
    await db.stars.bulkPut(scopedStars);
    await db.tags.bulkPut(scopedStars.map((item, index) => ({
      full_name: item.full_name,
      manualTags: [`build-${index}-${'x'.repeat(80)}`, 'shared-build'],
      autoTags: [],
      dismissedAutoTags: [],
      manualTagsMtime: star.synced_at,
      autoTagsMtime: star.synced_at,
      dismissedAutoTagsMtime: star.synced_at,
      notes: '',
      favorite: false,
      mtime: star.synced_at,
    })));
    const tools = createTools(scopedStars.map((item) => item.full_name));
    const list = tools.find((tool) => tool.name === 'list_tags');
    const search = tools.find((tool) => tool.name === 'search_stars');
    const inspect = tools.find((tool) => tool.name === 'inspect_tag');
    assert.ok(list);
    assert.ok(search);
    assert.ok(inspect);

    const oneListed = await list.execute(list.validate?.({ limit: 1 }), {
      sessionId: 's-list-measure', callId: 'c-list-measure',
    }) as { tags: unknown[]; nextCursor: string | null };
    const listBudget = serializedToolResultByteLength(okToolResult(oneListed));
    const listed = await list.execute(list.validate?.({ limit: 50 }), {
      sessionId: 's-list-allowance',
      callId: 'c-list-allowance',
      resultAllowance: resultAllowance(listBudget),
    }) as { tags: unknown[]; nextCursor: string | null };
    assert.equal(listed.tags.length, 1);
    assert.equal(listed.nextCursor, '1');
    assert.ok(serializedToolResultByteLength(okToolResult(listed)) <= listBudget);

    const oneSearched = await search.execute(search.validate?.({
      terms: ['owner/allowance'],
      limit: 1,
    }), {
      sessionId: 's-search-measure',
      callId: 'c-search-measure',
    }) as { stars: unknown[]; nextCursor: string | null };
    const searchBudget = serializedToolResultByteLength(okToolResult(oneSearched));
    const searched = await search.execute(search.validate?.({ terms: ['owner/allowance'], limit: 50 }), {
      sessionId: 's-search-allowance',
      callId: 'c-search-allowance',
      resultAllowance: resultAllowance(searchBudget),
    }) as { stars: Array<{ full_name: string }>; nextCursor: string | null };
    assert.equal(searched.stars.length, 1);
    assert.equal(searched.nextCursor, '1');
    assert.ok(serializedToolResultByteLength(okToolResult(searched)) <= searchBudget);

    const oneInspected = await inspect.execute(inspect.validate?.({ tag: 'shared-build', limit: 1 }), {
      sessionId: 's-inspect-measure', callId: 'c-inspect-measure',
    }) as { repos: unknown[]; nextCursor: string | null };
    const inspectBudget = serializedToolResultByteLength(okToolResult(oneInspected));
    const inspected = await inspect.execute(inspect.validate?.({ tag: 'shared-build', limit: 50 }), {
      sessionId: 's-inspect-allowance',
      callId: 'c-inspect-allowance',
      resultAllowance: resultAllowance(inspectBudget),
    }) as { repos: unknown[]; nextCursor: string | null };
    assert.equal(inspected.repos.length, 1);
    assert.equal(inspected.nextCursor, '1');
    assert.ok(serializedToolResultByteLength(okToolResult(inspected)) <= inspectBudget);
  });

  it('rejects empty searches and never returns repositories outside the authorized scope', async () => {
    await db.stars.put({
      ...star,
      full_name: 'other/private-scope',
      html_url: 'https://github.com/other/private-scope',
    });
    const search = createTools().find((candidate) => candidate.name === 'search_stars');
    assert.ok(search);
    assert.throws(() => search.validate?.({ terms: ['   '] }), /nonempty/u);

    const result = await search.execute(search.validate?.({ terms: ['scope'] }), {
      sessionId: 's-scope-search',
      callId: 'call-scope-search',
    }) as { stars: Array<{ full_name: string }> };
    assert.deepEqual(result.stars, []);
  });

  it('limits tag inspection and repository writes to scope and local excluded-tag policy', async () => {
    await db.stars.put({
      ...star,
      full_name: 'other/outside',
      html_url: 'https://github.com/other/outside',
    });
    await db.tags.bulkPut([
      {
        full_name: star.full_name,
        manualTags: ['build'],
        autoTags: ['automatic-only', 'old-test'],
        dismissedAutoTags: [],
        manualTagsMtime: star.synced_at,
        autoTagsMtime: star.synced_at,
        dismissedAutoTagsMtime: star.synced_at,
        notes: '',
        favorite: false,
        mtime: star.synced_at,
      },
      {
        full_name: 'other/outside',
        manualTags: ['build'],
        autoTags: [],
        dismissedAutoTags: [],
        manualTagsMtime: star.synced_at,
        autoTagsMtime: star.synced_at,
        dismissedAutoTagsMtime: star.synced_at,
        notes: '',
        favorite: false,
        mtime: star.synced_at,
      },
    ]);
    await db.tagMeta.put({
      name: 'ＯＬＤ－ＴＥＳＴ',
      dimension: null,
      color: null,
      mtime: star.synced_at,
      excluded: true,
    });
    const tools = createTools();
    const destructiveTools = createToolsWithDestructive();
    const inspect = tools.find((candidate) => candidate.name === 'inspect_tag');
    const assign = tools.find((candidate) => candidate.name === 'assign_repo_tags');
    const remove = destructiveTools.find((candidate) => candidate.name === 'remove_repo_tag');
    const listTags = tools.find((candidate) => candidate.name === 'list_tags');
    assert.ok(inspect);
    assert.ok(assign);
    assert.ok(remove);
    assert.ok(listTags);

    const listed = await listTags.execute(listTags.validate?.({}), {
      sessionId: 's-excluded-list',
      callId: 'call-excluded-list',
    }) as { tags: Array<{ name: string }> };
    assert.equal(listed.tags.some((tag) => tag.name === 'old-test'), false);

    const inspected = await inspect.execute(inspect.validate?.({ tag: 'build' }), {
      sessionId: 's-scope-inspect',
      callId: 'call-scope-inspect',
    }) as { repos: Array<{ full_name: string; tags: string[] }> };
    assert.equal(inspected.repos.length, 1);
    assert.deepEqual(inspected.repos[0]?.tags, ['build', 'automatic-only']);
    assert.equal(JSON.stringify(inspected).includes('old-test'), false);
    await assert.rejects(
      () => inspect.execute(inspect.validate?.({ tag: 'old-test' }), {
        sessionId: 's-excluded-inspect',
        callId: 'call-excluded-inspect',
      }),
      /excluded/u,
    );
    await assert.rejects(
      () => assign.execute(assign.validate?.({ full_name: 'other/outside', tags: ['manual'] }), {
        sessionId: 's-outside-assign',
        callId: 'call-outside-assign',
      }),
      /outside the authorized scope/u,
    );
    await assert.rejects(
      () => remove.execute(remove.validate?.({ full_name: 'other/outside', tag: 'build' }), {
        sessionId: 's-outside-remove',
        callId: 'call-outside-remove',
      }),
      /outside the authorized scope/u,
    );
    const excludedAssignment = await assign.execute(
      assign.validate?.({ full_name: star.full_name, tags: ['old-test'] }),
      { sessionId: 's-excluded-assign', callId: 'call-excluded-assign' },
    ) as { changed: boolean; reason: string | null };
    assert.equal(excludedAssignment.changed, false);
    assert.equal(excludedAssignment.reason, 'excluded_tag');

    await assign.execute(assign.validate?.({ full_name: star.full_name, tags: ['manual-new'] }), {
      sessionId: 's-manual-layer',
      callId: 'call-manual-layer',
    });
    const stored = await db.tags.get(star.full_name);
    assert.deepEqual(stored?.manualTags, ['build', 'manual-new']);
    assert.deepEqual(stored?.autoTags, ['automatic-only', 'old-test']);
    assert.equal((await db.tagMeta.get('ＯＬＤ－ＴＥＳＴ'))?.excluded, true);
  });
});
