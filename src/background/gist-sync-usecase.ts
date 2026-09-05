import { authStore } from '@/auth/auth-store';
import { translateError } from '@/api/errors';
import type { TagStore } from '@/api/tag-store';
import { getMessages } from '@/i18n';
import type { SyncProgress } from '@/types';
import type { SerializedRunner } from './serialized-runner';

export function createGistSyncUsecase(dependencies: {
  queue: SerializedRunner;
  tags: Pick<TagStore, 'syncPush' | 'syncPull'>;
  setProgress(progress: SyncProgress): void;
}) {
  const { queue, tags, setProgress } = dependencies;
  const idle = (message: string) => setProgress({ phase: 'idle', done: 0, total: null, message });
  return {
    push: () => queue.run(async () => {
      const m = getMessages(await authStore.getLocale());
      try {
        const progress = (done: number, total: number | null) => setProgress({ phase: 'gist', done, total, message: m.background.pushingTags });
        progress(0, null);
        const result = await tags.syncPush(progress);
        idle(result.pushed > 0 ? m.background.gistPushDone(result.pushed)
          : result.recreated ? m.background.gistPushRecreated : m.background.gistPushNoChanges);
        return result;
      } catch (error) {
        idle(translateError(error, m));
        throw error;
      }
    }, { kind: 'progress' }),
    pull: () => queue.run(async () => {
      const m = getMessages(await authStore.getLocale());
      try {
        const progress = (done: number, total: number | null) => setProgress({ phase: 'gist', done, total, message: m.background.pullingTags });
        progress(0, null);
        const result = await tags.syncPull(progress);
        idle(result.missing ? m.background.gistPullMissing : m.background.gistPullDone(result.merged, result.total));
        return result;
      } catch (error) {
        idle(translateError(error, m));
        throw error;
      }
    }, { kind: 'progress' }),
  };
}
