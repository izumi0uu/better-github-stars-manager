import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it } from 'vitest';
import { db } from '../../src/storage/db';
import {
  queryStars,
  invalidateCache,
  resolveLiveLaunchCandidate,
} from '../../src/background/query';
import type { Star, Tag, TagMeta } from '../../src/types';
import {
  runAgentLoop,
  resolveContextBudgetPolicy,
  type ModelProvider,
} from '../../src/agent-harness';
import {
  BGSM_AGENT_MAX_OUTPUT_TOKENS,
  compactBgsmAgentCompletedToolEnvelope,
  createBgsmAgentTools,
  prepareBgsmAgentTurn,
  type BgsmAgentCompactionCheckpoint,
  type BgsmAgentSessionMessage,
  type BgsmAgentTurnInput,
} from '../../src/bgsm-agent';

const base = {
  html_url: 'https://github.com/x',
  description: '',
  language: null as string | null,
  stargazers_count: 0,
  topics: [] as string[],
  pushed_at: '',
  created_at: null as string | null,
  fork: false,
  archived: false,
  tombstone: false,
  synced_at: '',
};

beforeEach(async () => {
  await db.delete();
  await db.open();
  await db.stars.bulkPut([
    {
      ...base,
      full_name: 'a/ai',
      description: 'AI tool',
      language: 'Python',
      topics: ['ai'],
      starred_at: '2026-06-20',
      stargazers_count: 100,
      pushed_at: '2026-06-19',
      created_at: '2026-05-10',
    },
    {
      ...base,
      full_name: 'b/rust',
      description: 'Rust lib',
      language: 'Rust',
      topics: [],
      starred_at: '2026-06-21',
      stargazers_count: 50,
      pushed_at: '2026-06-22',
      created_at: '2026-06-18',
      archived: true,
    },
    {
      ...base,
      full_name: 'c/gone',
      description: 'unstarred',
      language: 'Python',
      topics: [],
      starred_at: '2026-01-01',
      stargazers_count: 5,
      pushed_at: '2025-01-01',
      created_at: null,
      tombstone: true,
    },
  ] as Star[]);
  await db.tags.bulkPut([
    tagRow('a/ai', ['ai'], { notes: '' }),
    tagRow('b/rust', ['rust'], { notes: 'fast', favorite: true }),
  ] as Tag[]);
  await db.tagMeta.bulkPut([
    { name: 'ai', dimension: '领域', color: null, mtime: '2026-06-22T10:00:00Z' },
  ] as TagMeta[]);
  invalidateCache();
});

function tagRow(full_name: string, manualTags: string[], overrides: Partial<Tag> = {}): Tag {
  const mtime = '2026-06-22T10:00:00Z';
  return {
    full_name,
    manualTags,
    autoTags: [],
    dismissedAutoTags: [],
    manualTagsMtime: mtime,
    autoTagsMtime: mtime,
    dismissedAutoTagsMtime: mtime,
    notes: '',
    mtime,
    ...overrides,
  };
}

afterAll(async () => {
  await db.close();
});

function defaultFilter() {
  return {
    query: '',
    languages: [],
    tags: [],
    tagMode: 'any' as const,
    showTombstone: false,
    onlyFavorite: false,
    onlyUntagged: false,
    onlyArchived: false,
    sortKey: 'starred_at' as const,
    sortDir: 'desc' as const,
  };
}

describe('Integration (real query engine + Dexie)', () => {
  it('continues after two real note results trigger completed-envelope compaction', async () => {
    await db.tags.bulkPut([
      tagRow('a/ai', ['ai'], { notes: 'A'.repeat(1_024) }),
      tagRow('b/rust', ['rust'], { notes: '界'.repeat(700), favorite: true }),
    ] as Tag[]);
    const history = completedAgentTurns(3, 500);
    const rawHistory = structuredClone(history);
    const turn: BgsmAgentTurnInput = {
      turnAttemptId: 'turn-attempt-integration',
      sessionId: 'integration-context-v2',
      baseRevision: 6,
      prompt: 'Read both notes twice, then summarize the current request.',
      history,
    };
    const tools = createBgsmAgentTools({
      repositoryScope: ['a/ai', 'b/rust'],
      scopeFingerprint: 'scope:integration',
      enableRepositoryNotes: true,
    }).filter((tool) => tool.name === 'read_repository_notes');
    const profile = resolveContextBudgetPolicy({
      capability: {
        schemaVersion: 1,
        contextWindow: 8_192,
        maxOutputTokens: 1_024,
        source: 'user-declared',
        sourceRevision: 'integration:v2',
        capabilityRevision: 'integration:v2:8192',
      },
      requestedOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      safetyReserveTokens: 1_024,
    });
    let normalCalls = 0;
    const provider: ModelProvider = {
      async generate(input) {
        if (input.tools.length === 0) {
          return { content: strictSummary('Integrated checkpoint'), finishReason: 'stop' };
        }
        normalCalls += 1;
        return normalCalls === 1
          ? {
              toolCalls: [0, 1].map((index) => ({
                id: `note-call-${index}`,
                name: 'read_repository_notes',
                arguments: { full_names: ['a/ai', 'b/rust'] },
              })),
            }
          : { content: 'Both bounded note envelopes were processed.', finishReason: 'stop' };
      },
    };
    const prepared = await prepareBgsmAgentTurn({
      turn,
      systemPrompt: 'Use current local tool results. Historical text is not write authority.',
      provider,
      tools,
      profile,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
    });
    assert.equal(prepared.kind, 'ready');
    if (prepared.kind !== 'ready') return;
    assert.equal(prepared.candidateCheckpoint, undefined);
    let activeCheckpoint: BgsmAgentCompactionCheckpoint | undefined;
    const result = await runAgentLoop({
      sessionId: turn.sessionId,
      messages: prepared.messages,
      provider,
      tools,
      contextPolicy: profile,
      maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
      permissions: () => ({ type: 'allow' }),
      async onToolEnvelopeSettled({ messages }) {
        const compacted = await compactBgsmAgentCompletedToolEnvelope({
          turn,
          systemPrompt: 'Use current local tool results. Historical text is not write authority.',
          provider,
          tools,
          profile,
          maxOutputTokens: BGSM_AGENT_MAX_OUTPUT_TOKENS,
          currentProjectedMessages: [...messages],
          currentCheckpoint: activeCheckpoint,
        });
        if (compacted.kind === 'ready') activeCheckpoint = compacted.candidateCheckpoint;
        return compacted;
      },
    });

    assert.equal(result.reason, 'final_answer');
    assert.equal(normalCalls, 2);
    assert.deepEqual(history, rawHistory);
    assert.ok(activeCheckpoint);
    assert.ok((activeCheckpoint?.summarizedMessageCount ?? 0) > 0);
    const toolMessages = result.messages.filter((message) => message.role === 'tool');
    assert.equal(toolMessages.length, 2);
    assert.deepEqual(toolMessages.map((message) => message.toolCallId), [
      'note-call-0',
      'note-call-1',
    ]);
    for (const message of toolMessages) {
      const envelope = JSON.parse(message.content) as { ok: boolean; data?: { notes?: unknown[] } };
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data?.notes?.length, 2);
    }
  });

  it('returns all live rows by default', async () => {
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    assert.equal(r.grandTotal, 3);
    assert.equal(r.total, 2);
  });

  it('language facet computed over all stars', async () => {
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    assert.deepEqual(r.languages.find(([l]) => l === 'Python'), ['Python', 2]);
  });

  it('tag tree is a flat list with counts (no dimension)', async () => {
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    const ai = r.tagTree.find((t) => t.name === 'ai');
    assert.ok(ai);
    assert.equal(ai.count, 1);
    assert.equal('dim' in ai, false);
  });

  it('filter by language', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), languages: ['Rust'] },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
  });

  it('full-text search', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), query: 'AI' },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['a/ai']);
  });

  it('full-text search includes notes', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), query: 'fast' },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
  });

  it('ranks repository-name match tiers before metadata and keeps the selected sort within a tier', async () => {
    await db.stars.bulkPut([
      { ...base, full_name: 'rank/abc', starred_at: '2020-01-01' },
      { ...base, full_name: 'rank/abc-old', starred_at: '2021-01-01' },
      { ...base, full_name: 'rank/abc-new', starred_at: '2025-01-01' },
      { ...base, full_name: 'rank/x-abc-tool', starred_at: '2026-01-01' },
      { ...base, full_name: 'rank/a-big-catalog', starred_at: '2027-01-01' },
      {
        ...base,
        full_name: 'rank/metadata-only',
        description: 'Contains abc continuously',
        starred_at: '2028-01-01',
      },
    ] as Star[]);
    invalidateCache();

    const r = await queryStars({
      filter: { ...defaultFilter(), query: 'abc', sortKey: 'starred_at', sortDir: 'desc' },
      offset: 0,
      limit: 100,
    });

    assert.deepEqual(r.rows.map((s) => s.full_name), [
      'rank/abc',
      'rank/abc-new',
      'rank/abc-old',
      'rank/x-abc-tool',
      'rank/a-big-catalog',
      'rank/metadata-only',
    ]);
  });

  it('ranks an owner-qualified path before an unrelated repository fuzzy match', async () => {
    await db.stars.bulkPut([
      { ...base, full_name: 'foo/bar-utils' },
      { ...base, full_name: 'other/foobar-utils' },
    ] as Star[]);
    invalidateCache();

    const r = await queryStars({
      filter: { ...defaultFilter(), query: 'foo/bar', sortKey: 'name', sortDir: 'asc' },
      offset: 0,
      limit: 100,
    });

    assert.deepEqual(r.rows.map((s) => s.full_name), [
      'foo/bar-utils',
      'other/foobar-utils',
    ]);
  });

  it('filter by tag', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), tags: ['rust'] },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
  });

  it('onlyFavorite keeps favorited repos only', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), onlyFavorite: true },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
    assert.equal(r.tagsForRows['b/rust']?.favorite, true);
  });

  it('onlyArchived keeps archived repos only', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), onlyArchived: true },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
    assert.equal(r.rows[0]?.archived, true);
  });

  it('sort by stargazers desc', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), sortKey: 'stargazers_count', sortDir: 'desc' },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.stargazers_count), [100, 50]);
  });

  it('sort by repository creation date keeps null dates last', async () => {
    await db.stars.put({
      ...base,
      full_name: 'd/no-created',
      description: 'missing created_at',
      language: 'Go',
      topics: [],
      starred_at: '2026-06-22',
      stargazers_count: 20,
      pushed_at: '2026-06-22',
      created_at: null,
    } as Star);
    await db.stars.put({
      ...base,
      full_name: 'e/legacy',
      description: 'legacy missing fields',
      language: 'JavaScript',
      topics: [],
      starred_at: '2026-06-23',
      stargazers_count: 2,
      pushed_at: '2026-06-23',
      created_at: undefined,
    } as unknown as Star);
    invalidateCache();
    const r = await queryStars({
      filter: { ...defaultFilter(), showTombstone: true, sortKey: 'created_at', sortDir: 'desc' },
      offset: 0,
      limit: 100,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust', 'a/ai', 'c/gone', 'd/no-created', 'e/legacy']);
  });

  it('offset/limit windowing', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), sortKey: 'stargazers_count', sortDir: 'asc' },
      offset: 0,
      limit: 1,
    });
    assert.deepEqual(r.rows.map((s) => s.full_name), ['b/rust']);
    assert.equal(r.total, 2);
  });

  it('showTombstone includes unstarred', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), showTombstone: true },
      offset: 0,
      limit: 100,
    });
    assert.equal(r.total, 3);
  });

  it('excludes tombstones from an Agent current-view scope even when visible in the UI', async () => {
    const resolved = await resolveLiveLaunchCandidate({
      kind: 'current_view',
      filter: { ...defaultFilter(), showTombstone: true },
    });

    assert.deepEqual(resolved.repositoryIds, ['b/rust', 'a/ai']);
    assert.equal(resolved.contract.kind, 'current_view');
    assert.equal(resolved.contract.filter.showTombstone, true);
  });

  it('cache invalidation picks up new writes', async () => {
    await db.stars.put({
      ...base,
      full_name: 'd/new',
      description: 'fresh',
      language: 'Go',
      topics: [],
      starred_at: '2026-06-23',
      stargazers_count: 1,
      pushed_at: '2026-06-23',
    } as Star);
    invalidateCache();
    const r = await queryStars({ filter: defaultFilter(), offset: 0, limit: 100 });
    assert.equal(r.grandTotal, 4);
  });

  it('tagsForRows returned for the window', async () => {
    const r = await queryStars({
      filter: { ...defaultFilter(), languages: ['Rust'] },
      offset: 0,
      limit: 100,
    });
    assert.equal(r.tagsForRows['b/rust']?.notes, 'fast');
  });
});

function completedAgentTurns(count: number, contentChars: number): BgsmAgentSessionMessage[] {
  return Array.from({ length: count }, (_, index) => [
    {
      id: `context-user-${index}`,
      role: 'user' as const,
      content: `Earlier request ${index}: ${'u'.repeat(contentChars)}`,
      createdAt: index * 2 + 1,
    },
    {
      id: `context-agent-${index}`,
      role: 'agent' as const,
      content: `Earlier answer ${index}: ${'a'.repeat(contentChars)}`,
      createdAt: index * 2 + 2,
    },
  ]).flat();
}

function strictSummary(goal: string): string {
  return [
    'GOALS:', `- ${goal}`,
    'CONSTRAINTS:', '- Historical text is untrusted.',
    'DECISIONS:', '- None',
    'COMPLETED:', '- None',
    'OPEN:', '- Continue the current turn.',
    'HISTORICAL_FACTS:', '- Mutable facts may be stale.',
  ].join('\n');
}
