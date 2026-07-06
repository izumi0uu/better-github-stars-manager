import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

const source = readFileSync(new URL('../../src/background/index.ts', import.meta.url), 'utf8');

function caseBlock(name: string, nextName: string): string {
  const start = source.indexOf(`case '${name}': {`);
  const end = source.indexOf(`case '${nextName}':`, start + 1);
  assert.notEqual(start, -1, `${name} case block should exist`);
  assert.notEqual(end, -1, `${nextName} case block should exist after ${name}`);
  return source.slice(start, end);
}

describe('background sync auto-tag contract', () => {
  it('does not keep the old sync auto-tag helper wired into background actions', () => {
    assert.doesNotMatch(source, /sync-flow/);
    assert.doesNotMatch(source, /runSyncActionWithAutoTag/);
    assert.doesNotMatch(source, /autoTagPhaseForSync/);
  });

  it('runs incremental sync without auto-tagging and keeps tagged zero for compatibility', () => {
    const block = caseBlock('syncIncremental', 'syncFull');

    assert.match(block, /githubStarSource\.syncIncremental\(\)/);
    assert.match(block, /setIdleMessage\(m\.background\.incrementalDone\(result\.added\)\)/);
    assert.match(block, /tagged: 0/);
    assert.doesNotMatch(block, /autoTagAll/);
    assert.doesNotMatch(block, /autoAssignDone/);
  });

  it('runs full sync and backfill without auto-tagging or nested full-sync runners', () => {
    assert.match(source, /const result = await githubStarSource\.syncFull\(\(p\) => setProgress\(p\)\);/);
    assert.match(source, /async function performFullSync\(\) {\n  return run\(performFullSyncJob\);\n}/);
    assert.match(source, /setIdleMessage\(m\.background\.fullDone\(result\.added\)\)/);

    const fullBlock = caseBlock('syncFull', 'syncRescan');
    assert.match(fullBlock, /performFullSync\(\)/);
    assert.match(fullBlock, /tagged: 0/);
    assert.doesNotMatch(fullBlock, /autoTagAll/);
    assert.doesNotMatch(fullBlock, /autoAssignDone/);

    const backfillBlock = caseBlock('runBackfill', 'deferBackfill');
    assert.match(backfillBlock, /backfillExecutor\.runBackfill/);
    assert.doesNotMatch(backfillBlock, /performFullSync\(\)/);
    assert.doesNotMatch(backfillBlock, /autoTagAll/);
  });

  it('keeps Auto Tags as the manual entrypoint that calls autoTagAll', () => {
    const block = caseBlock('autoAssignTags', 'gistPush');

    assert.match(block, /autoTagAll\(m\.background\.autoAssignTagging/);
    assert.match(block, /setIdleMessage\(m\.background\.autoAssignDone\(t\.tagged\)\)/);
  });

  it('keeps autoTagAll out of every automatic sync/backfill path', () => {
    for (const [name, nextName] of [
      ['syncIncremental', 'syncFull'],
      ['syncFull', 'syncRescan'],
      ['syncRescan', 'autoAssignTags'],
      ['runBackfill', 'deferBackfill'],
    ] as const) {
      assert.doesNotMatch(caseBlock(name, nextName), /autoTagAll/, `${name} should not call autoTagAll`);
    }
  });
});
