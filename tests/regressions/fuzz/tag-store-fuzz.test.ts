import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { db } from '@/storage/db';
import { idbTagStore, resetDirtyForDev, snapshotDirty } from '@/storage/idb-tag-store';
import type { Tag, TagMeta } from '@/types';
import { createRng, fuzzCases, fuzzFailure, type SeededRng } from '../../helpers/seeded-fuzz';

const FILE = 'tests/regressions/fuzz/tag-store-fuzz.test.ts';
const PREFIX = 'TAG_STORE_FUZZ';
const SUITE = 'tag-store fuzz';
const CASES = fuzzCases(PREFIX, '20260705-tags', 100);

const tagVocabulary = ['ai', 'ui', 'infra', 'database', 'testing', 'sync', 'tooling', 'archive'];

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
  resetDirtyForDev();
});

afterAll(async () => {
  await db.close();
});

describe('tag-store seeded fuzz', () => {
  for (const caseIndex of CASES.cases) {
    it(`matches the tag-store reference model for case ${caseIndex}`, async () => {
      const rng = createRng(CASES.seed, caseIndex);
      const model = seedModel(rng);
      await seedDb(model);
      const trace: OperationTrace[] = [];
      const opCount = rng.int(20, 50);

      for (let step = 0; step < opCount; step++) {
        const op = makeOperation(rng, model, step);
        trace.push(op);
        await applyProduct(op);
        applyModel(model, op);
        await assertModelMatches(model, caseIndex, trace);
      }
    });
  }
});

type ModelTag = {
  tags: string[];
  notes: string;
  favorite: boolean;
  gh_list_id?: number | null;
};

type ModelMeta = {
  dimension: string | null;
  color: string | null;
  excluded?: boolean;
};

type TagModel = {
  rows: Map<string, ModelTag>;
  meta: Map<string, ModelMeta>;
  dirty: Set<string>;
  dirtyMeta: boolean;
  repos: string[];
};

type OperationTrace =
  | { kind: 'setTags'; repo: string; tags: string[] }
  | { kind: 'setTagsBulk'; updates: Array<{ full_name: string; tags: string[] }> }
  | { kind: 'setNotes'; repo: string; notes: string }
  | { kind: 'setFavorite'; repo: string; favorite: boolean }
  | { kind: 'deleteTag'; tag: string }
  | { kind: 'deleteAllTags' }
  | { kind: 'upsertMeta'; tag: string; excluded?: boolean; dimension: string | null; color: string | null };

function seedModel(rng: SeededRng): TagModel {
  const repoCount = rng.int(1, 30);
  const repos = Array.from({ length: repoCount }, (_value, index) => `owner${index % 5}/repo${index}`);
  const rows = new Map<string, ModelTag>();
  for (const repo of repos) {
    if (rng.bool(0.85)) {
      rows.set(repo, {
        tags: rng.subset(tagVocabulary, 4),
        notes: rng.bool(0.45) ? `note-${rng.int(0, 20)}` : '',
        favorite: rng.bool(0.3),
        gh_list_id: rng.bool(0.2) ? rng.int(1, 10) : null,
      });
    }
  }
  const meta = new Map<string, ModelMeta>();
  for (const tag of tagVocabulary) {
    if (rng.bool(0.7)) {
      meta.set(tag, {
        dimension: rng.maybe(rng.pick(['topic', 'stack', 'workflow']), 0.7),
        color: rng.maybe(`#${rng.int(0, 0xffffff).toString(16).padStart(6, '0')}`, 0.5),
        excluded: rng.bool(0.25) ? true : undefined,
      });
    }
  }
  return { rows, meta, dirty: new Set(), dirtyMeta: false, repos };
}

async function seedDb(model: TagModel): Promise<void> {
  await db.tags.bulkPut([...model.rows.entries()].map(([full_name, row], index) => ({
    full_name,
    tags: row.tags,
    notes: row.notes,
    favorite: row.favorite,
    gh_list_id: row.gh_list_id,
    mtime: iso(index),
  } satisfies Tag)));
  await db.tagMeta.bulkPut([...model.meta.entries()].map(([name, meta], index) => ({
    name,
    dimension: meta.dimension,
    color: meta.color,
    excluded: meta.excluded,
    mtime: iso(index + 100),
  } satisfies TagMeta)));
}

function makeOperation(rng: SeededRng, model: TagModel, step: number): OperationTrace {
  const repo = rng.pick(model.repos);
  const tag = rng.pick(tagVocabulary);
  switch (rng.pick(['setTags', 'setTagsBulk', 'setNotes', 'setFavorite', 'deleteTag', 'deleteAllTags', 'upsertMeta'] as const)) {
    case 'setTags':
      return { kind: 'setTags', repo, tags: rng.subset(tagVocabulary, 4) };
    case 'setTagsBulk':
      return {
        kind: 'setTagsBulk',
        updates: rng.subset(model.repos, rng.int(1, Math.min(6, model.repos.length))).map((full_name) => ({
          full_name,
          tags: rng.subset(tagVocabulary, 4),
        })),
      };
    case 'setNotes':
      return { kind: 'setNotes', repo, notes: `fuzz-note-${step}-${rng.int(0, 99)}` };
    case 'setFavorite':
      return { kind: 'setFavorite', repo, favorite: rng.bool() };
    case 'deleteTag':
      return { kind: 'deleteTag', tag };
    case 'deleteAllTags':
      return { kind: 'deleteAllTags' };
    case 'upsertMeta':
      return {
        kind: 'upsertMeta',
        tag,
        dimension: rng.maybe(rng.pick(['topic', 'stack', 'workflow']), 0.7),
        color: rng.maybe(`#${rng.int(0, 0xffffff).toString(16).padStart(6, '0')}`, 0.5),
        excluded: rng.bool(0.35) ? true : undefined,
      };
  }
}

async function applyProduct(op: OperationTrace): Promise<void> {
  switch (op.kind) {
    case 'setTags':
      await idbTagStore.setTags(op.repo, op.tags);
      break;
    case 'setTagsBulk':
      await idbTagStore.setTagsBulk(op.updates);
      break;
    case 'setNotes':
      await idbTagStore.setNotes(op.repo, op.notes);
      break;
    case 'setFavorite':
      await idbTagStore.setFavorite(op.repo, op.favorite);
      break;
    case 'deleteTag':
      await idbTagStore.deleteTag(op.tag);
      break;
    case 'deleteAllTags':
      await idbTagStore.deleteAllTags();
      break;
    case 'upsertMeta':
      await idbTagStore.upsertMeta({
        name: op.tag,
        dimension: op.dimension,
        color: op.color,
        excluded: op.excluded,
        mtime: iso(500),
      });
      break;
  }
}

function applyModel(model: TagModel, op: OperationTrace): void {
  switch (op.kind) {
    case 'setTags':
      setTagsModel(model, op.repo, op.tags);
      break;
    case 'setTagsBulk':
      for (const update of op.updates) setTagsModel(model, update.full_name, update.tags, { bulk: true });
      break;
    case 'setNotes': {
      const row = ensureModelRow(model, op.repo);
      row.notes = op.notes;
      model.dirty.add(op.repo);
      break;
    }
    case 'setFavorite': {
      const row = ensureModelRow(model, op.repo);
      row.favorite = op.favorite;
      model.dirty.add(op.repo);
      break;
    }
    case 'deleteTag': {
      let removedAny = false;
      for (const [repo, row] of model.rows) {
        if (!row.tags.includes(op.tag)) continue;
        row.tags = row.tags.filter((tag) => tag !== op.tag);
        model.dirty.add(repo);
        removedAny = true;
      }
      const previous = model.meta.get(op.tag);
      model.meta.set(op.tag, {
        dimension: previous?.dimension ?? null,
        color: previous?.color ?? null,
        excluded: true,
      });
      model.dirtyMeta = true;
      void removedAny;
      break;
    }
    case 'deleteAllTags':
      for (const [repo, row] of model.rows) {
        if (row.tags.length === 0) continue;
        row.tags = [];
        model.dirty.add(repo);
      }
      break;
    case 'upsertMeta':
      model.meta.set(op.tag, { dimension: op.dimension, color: op.color, excluded: op.excluded });
      model.dirtyMeta = true;
      break;
  }
}

function setTagsModel(
  model: TagModel,
  repo: string,
  tags: string[],
  options: { bulk?: boolean } = {},
): void {
  const existing = model.rows.get(repo);
  const existingTags = existing?.tags ?? [];
  const changed = !arraysEqual(existingTags, tags);
  if (options.bulk && !changed) return;
  const row = existing ?? ensureModelRow(model, repo);
  const previousTags = new Set(existingTags);
  row.tags = tags;
  model.dirty.add(repo);
  for (const tag of tags) {
    const meta = model.meta.get(tag);
    if (meta?.excluded && !previousTags.has(tag)) {
      model.meta.set(tag, { ...meta, excluded: false });
      model.dirtyMeta = true;
    }
  }
}

function ensureModelRow(model: TagModel, repo: string): ModelTag {
  let row = model.rows.get(repo);
  if (!row) {
    row = { tags: [], notes: '', favorite: false };
    model.rows.set(repo, row);
  }
  return row;
}

async function assertModelMatches(model: TagModel, caseIndex: number, trace: OperationTrace[]): Promise<void> {
  const [actualRows, actualMeta] = await Promise.all([db.tags.toArray(), db.tagMeta.toArray()]);
  const actual = {
    rows: actualRows
      .map((row) => ({
        full_name: row.full_name,
        tags: row.tags,
        notes: row.notes,
        favorite: row.favorite ?? false,
        gh_list_id: row.gh_list_id ?? null,
      }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    meta: actualMeta
      .map((meta) => ({
        name: meta.name,
        dimension: meta.dimension,
        color: meta.color,
        excluded: meta.excluded ?? undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    dirty: snapshotDirty().names.sort(),
    dirtyMeta: snapshotDirty().meta,
  };
  const expected = {
    rows: [...model.rows.entries()]
      .map(([full_name, row]) => ({
        full_name,
        tags: row.tags,
        notes: row.notes,
        favorite: row.favorite,
        gh_list_id: row.gh_list_id ?? null,
      }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    meta: [...model.meta.entries()]
      .map(([name, meta]) => ({
        name,
        dimension: meta.dimension,
        color: meta.color,
        excluded: meta.excluded ?? undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    dirty: [...model.dirty].sort(),
    dirtyMeta: model.dirtyMeta,
  };
  assert.deepEqual(
    actual,
    expected,
    fuzzFailure({
      suite: SUITE,
      prefix: PREFIX,
      seed: CASES.seed,
      caseIndex,
      file: FILE,
      invariant: 'tag-store state matches reference model',
      expected,
      actual,
      trace,
    }),
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function iso(offset: number): string {
  return new Date(Date.UTC(2026, 0, 1 + offset)).toISOString();
}
