import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { backgroundSource } from '../helpers/background-case-block';

describe('background auto-tag frequency contract', () => {
  function autoTagAllBlock(): string {
    const block = backgroundSource.match(/async function autoTagAll\([\s\S]*?\n}\n\nasync function performFullSync/)?.[0] ?? '';
    assert.ok(block, 'autoTagAll block should exist');
    return block;
  }

  it('computes topic repo frequency before bulk auto-tag suggestions', () => {
    assert.match(backgroundSource, /import \{ countTopicRepoFrequency, reconcileAutoTagAssignments, suggestTags \} from '@\/ui\/suggest';/);
    assert.match(backgroundSource, /const topicRepoCounts = countTopicRepoFrequency\(stars\);/);
  });

  it('uses split auto-tag policy fields for cap and minimum repo coverage', () => {
    const block = backgroundSource.match(/const nextAutoTags = suggestTags\([\s\S]*?\n    \}\);/)?.[0] ?? '';
    assert.ok(block, 'autoTagAll should call suggestTags with a policy object');
    assert.match(block, /\.\.\.manualTags, \.\.\.dismissed/);
    assert.match(block, /limit: cfg\.maxTagsPerRepo/);
    assert.match(block, /minRepoCount: cfg\.minTopicRepoCount/);
    assert.match(block, /topicRepoCounts/);
    assert.doesNotMatch(block, /cfg\.autoTagLimit/);
  });

  it('computes the full update plan before one bulk write', () => {
    const block = autoTagAllBlock();
    const bulkWrites = block.match(/idbTagStore\.setAutoTagsBulk\(/g) ?? [];
    const perRepoWrites = block.match(/idbTagStore\.setTags\(/g) ?? [];

    assert.equal(bulkWrites.length, 1, 'autoTagAll should have exactly one bulk write site');
    assert.equal(perRepoWrites.length, 0, 'autoTagAll should not use per-repo setTags writes');
    assert.match(block, /const plans: AutoTagBulkUpdate\[\] = \[\];/);
    assert.match(block, /plans\.push\(\{ full_name: star\.full_name, autoTags: nextAutoTags \}\);/);
    assert.match(block, /const updates = reconcileAutoTagAssignments\(plans, cfg\.minTopicRepoCount\)/);
    assert.match(block, /updates\.length > 0 \? await idbTagStore\.setAutoTagsBulk\(updates\) : \{ updated: 0 \}/);
    assert.ok(
      block.indexOf('const updates = reconcileAutoTagAssignments(plans, cfg.minTopicRepoCount)') <
        block.indexOf('await idbTagStore.setAutoTagsBulk(updates)'),
      'autoTagAll should reconcile planned assignments before the storage write',
    );
  });

  it('keeps manual Auto Tags as the only autoTagAll call site', () => {
    const calls = backgroundSource.match(/return autoTagAll\(m\.background\.autoAssignTagging/g) ?? [];
    assert.equal(calls.length, 1);
  });
});
