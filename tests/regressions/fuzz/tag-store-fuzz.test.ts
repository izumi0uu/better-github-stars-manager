import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { db } from '@/storage/db';
import { idbTagStore, resetDirtyForDev, snapshotDirty } from '@/storage/idb-tag-store';
import { visibleTagNames } from '@/tags/tag-model';
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
  manualTags: string[];
  autoTags: string[];
  dismissedAutoTags: string[];
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
  | { kind: 'setAutoTagsBulk'; updates: Array<{ full_name: string; autoTags: string[] }> }
  | { kind: 'removeVisibleTag'; repo: string; tag: string }
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
      const manualTags = rng.subset(tagVocabulary, 4);
      const nonManualTags = tagVocabulary.filter((tag) => !includesTagName(manualTags, tag));
      const dismissedAutoTags = rng.subset(nonManualTags, 2);
      rows.set(repo, {
        manualTags,
        autoTags: rng.subset(nonManualTags.filter((tag) => !includesTagName(dismissedAutoTags, tag)), 3),
        dismissedAutoTags,
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
  await db.tags.bulkPut([...model.rows.entries()].map(([full_name, row], index) => {
    const mtime = iso(index);
    return {
      full_name,
      manualTags: row.manualTags,
      autoTags: row.autoTags,
      dismissedAutoTags: row.dismissedAutoTags,
      manualTagsMtime: mtime,
      autoTagsMtime: mtime,
      dismissedAutoTagsMtime: mtime,
      notes: row.notes,
      favorite: row.favorite,
      gh_list_id: row.gh_list_id,
      mtime,
    } satisfies Tag;
  }));
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
  switch (rng.pick(['setTags', 'setTagsBulk', 'setAutoTagsBulk', 'removeVisibleTag', 'setNotes', 'setFavorite', 'deleteTag', 'deleteAllTags', 'upsertMeta'] as const)) {
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
    case 'setAutoTagsBulk':
      return {
        kind: 'setAutoTagsBulk',
        updates: rng.subset(model.repos, rng.int(1, Math.min(6, model.repos.length))).map((full_name) => ({
          full_name,
          autoTags: rng.subset(tagVocabulary, 4),
        })),
      };
    case 'removeVisibleTag':
      return { kind: 'removeVisibleTag', repo, tag };
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
    case 'setAutoTagsBulk':
      await idbTagStore.setAutoTagsBulk(op.updates);
      break;
    case 'removeVisibleTag':
      await idbTagStore.removeVisibleTag(op.repo, op.tag);
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
    case 'setAutoTagsBulk':
      for (const update of op.updates) setAutoTagsModel(model, update.full_name, update.autoTags);
      break;
    case 'removeVisibleTag': {
      const row = model.rows.get(op.repo);
      if (!row) break;
      const hadManual = includesTagName(row.manualTags, op.tag);
      const hadAuto = includesTagName(row.autoTags, op.tag);
      if (!hadManual && !hadAuto) break;
      row.manualTags = withoutTagName(row.manualTags, op.tag);
      row.autoTags = withoutTagName(row.autoTags, op.tag);
      row.dismissedAutoTags = addTagNames(row.dismissedAutoTags, [op.tag]);
      model.dirty.add(op.repo);
      break;
    }
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
        const hadManual = includesTagName(row.manualTags, op.tag);
        const hadAuto = includesTagName(row.autoTags, op.tag);
        if (!hadManual && !hadAuto) continue;
        row.manualTags = withoutTagName(row.manualTags, op.tag);
        row.autoTags = withoutTagName(row.autoTags, op.tag);
        if (hadAuto) row.dismissedAutoTags = addTagNames(row.dismissedAutoTags, [op.tag]);
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
        if (visibleModelTags(row).length === 0 && row.dismissedAutoTags.length === 0) continue;
        row.manualTags = [];
        row.autoTags = [];
        row.dismissedAutoTags = [];
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
  const existingTags = existing?.manualTags ?? [];
  const manualTags = addTagNames([], tags);
  const removedManualTags = existingTags.filter((tag) => !includesTagName(manualTags, tag));
  const existingDismissed = existing?.dismissedAutoTags ?? [];
  const dismissedAutoTags = addTagNames(existingDismissed, removedManualTags)
    .filter((tag) => !includesTagName(manualTags, tag));
  const changed = !arraysEqual(existingTags, manualTags) || !arraysEqual(existingDismissed, dismissedAutoTags);
  for (const tag of manualTags) {
    const meta = model.meta.get(tag);
    if (meta?.excluded) {
      model.meta.set(tag, { ...meta, excluded: false });
      model.dirtyMeta = true;
    }
  }
  if (options.bulk && !changed) return;
  const row = existing ?? ensureModelRow(model, repo);
  row.manualTags = manualTags;
  row.autoTags = row.autoTags.filter((tag) => !includesTagName(manualTags, tag));
  row.dismissedAutoTags = dismissedAutoTags;
  model.dirty.add(repo);
}

function setAutoTagsModel(model: TagModel, repo: string, tags: string[]): void {
  const existing = model.rows.get(repo);
  const manualTags = existing?.manualTags ?? [];
  const dismissedAutoTags = existing?.dismissedAutoTags ?? [];
  const autoTags = addTagNames([], tags).filter((tag) => (
    !includesTagName(manualTags, tag)
    && !includesTagName(dismissedAutoTags, tag)
    && !model.meta.get(tag)?.excluded
  ));
  if (!existing && autoTags.length === 0) return;
  const row = existing ?? ensureModelRow(model, repo);
  if (arraysEqual(row.autoTags, autoTags)) return;
  row.autoTags = autoTags;
  model.dirty.add(repo);
}

function ensureModelRow(model: TagModel, repo: string): ModelTag {
  let row = model.rows.get(repo);
  if (!row) {
    row = { manualTags: [], autoTags: [], dismissedAutoTags: [], notes: '', favorite: false };
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
        manualTags: row.manualTags ?? [],
        autoTags: row.autoTags ?? [],
        dismissedAutoTags: row.dismissedAutoTags ?? [],
        tags: visibleTagNames(row),
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
        manualTags: row.manualTags,
        autoTags: row.autoTags,
        dismissedAutoTags: row.dismissedAutoTags,
        tags: visibleModelTags(row),
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

function normalizeTagNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = canonicalTagKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function addTagNames(names: string[], additions: string[]): string[] {
  return normalizeTagNames([...names, ...additions]);
}

function withoutTagName(names: string[], name: string): string[] {
  const key = canonicalTagKey(name);
  return names.filter((tag) => canonicalTagKey(tag) !== key);
}

function includesTagName(names: string[], name: string): boolean {
  const key = canonicalTagKey(name);
  return names.some((tag) => canonicalTagKey(tag) === key);
}

function canonicalTagKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function visibleModelTags(row: ModelTag): string[] {
  return normalizeTagNames([...row.manualTags, ...row.autoTags]);
}

function iso(offset: number): string {
  return new Date(Date.UTC(2026, 0, 1 + offset)).toISOString();
}
