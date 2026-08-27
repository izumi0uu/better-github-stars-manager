import type { AutoTagBulkUpdate } from '@/api/tag-store';
import { authStore } from '@/auth/auth-store';
import { db } from '@/storage/db';
import { idbTagStore } from '@/storage/idb-tag-store';
import { dismissedAutoTagNames, manualTagNames, sameTagNames } from '@/tags/tag-model';
import type { SyncProgress } from '@/types';
import { countTopicRepoFrequency, reconcileAutoTagAssignments, suggestTags } from '@/ui/suggest';

/**
 * Auto-tag every star from its topics (NOT language — language is a sidebar
 * filter, not a tag; full rationale in suggest.ts). Pure-local, idempotent,
 * preserves notes. Excluded names are skipped so deleted tags don't resurrect.
 */
export async function autoTagAll(
  progressLabel: string,
  onProgress?: (p: SyncProgress) => void,
  phase: SyncProgress['phase'] = 'incremental',
): Promise<{ tagged: number; remainingUntagged: number }> {
  const cfg = await authStore.getConfig();
  const stars = (await db.stars.toArray()).filter((star) => (
    !star.tombstone && star.viewer_has_starred !== false
  ));
  const excluded = new Set(await idbTagStore.listExcluded());
  const existingTags = await idbTagStore.getMany(stars.map((star) => star.full_name));
  const topicRepoCounts = countTopicRepoFrequency(stars);
  const plans: AutoTagBulkUpdate[] = [];
  const total = stars.length;
  console.log(
    '[GSM] autoTag START | stars:',
    total,
    '| excluded:',
    excluded.size,
    '| phase:',
    phase,
    '| limit:',
    cfg.maxTagsPerRepo,
    '| minRepoCount:',
    cfg.minTopicRepoCount,
  );
  for (let i = 0; i < stars.length; i++) {
    const star = stars[i];
    const existing = existingTags.get(star.full_name);
    const manualTags = manualTagNames(existing);
    const dismissed = dismissedAutoTagNames(existing);
    const nextAutoTags = suggestTags(star, [...manualTags, ...dismissed], excluded, {
      limit: cfg.maxTagsPerRepo,
      minRepoCount: cfg.minTopicRepoCount,
      topicRepoCounts,
    });
    plans.push({ full_name: star.full_name, autoTags: nextAutoTags });
    const done = i + 1;
    if (onProgress && (done === 1 || done === total || done % 100 === 0)) {
      onProgress({
        phase,
        done,
        total,
        message: progressLabel,
      });
    }
    if (done % 100 === 0) await Promise.resolve();
  }
  const updates = reconcileAutoTagAssignments(plans, cfg.minTopicRepoCount)
    .filter((plan) => !sameTagNames(existingTags.get(plan.full_name)?.autoTags ?? [], plan.autoTags));
  const { updated: tagged } =
    updates.length > 0 ? await idbTagStore.setAutoTagsBulk(updates) : { updated: 0 };
  console.log('[GSM] autoTag END | newly tagged:', tagged, 'of', total);
  const afterTags = await idbTagStore.getMany(stars.map((star) => star.full_name));
  let remainingUntagged = 0;
  for (const star of stars) {
    if (star.tombstone) continue;
    const row = afterTags.get(star.full_name);
    const hasManual = (row?.manualTags?.length ?? 0) > 0;
    const hasAuto = (row?.autoTags?.length ?? 0) > 0;
    if (!hasManual && !hasAuto) remainingUntagged += 1;
  }
  return { tagged, remainingUntagged };
}
