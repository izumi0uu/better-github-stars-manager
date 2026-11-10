import { authStore, type GitHubCredentialSnapshot } from '@/auth/auth-store';
import { GH_NO_TOKEN, translateError } from '@/api/errors';
import type { StarSource } from '@/api/star-source';
import { getMessages, type MessageCatalog } from '@/i18n';
import { db } from '@/storage/db';
import { resolveOnboardingStageAfterSync, stageMarksOnboardingSeen } from '@/onboarding/state';
import type { OnboardingStage, SyncProgress } from '@/types';
import type { SerializedRunner } from './serialized-runner';

export function createStarsSyncUsecase(dependencies: {
  queue: SerializedRunner;
  source: StarSource;
  setProgress(progress: SyncProgress): void;
  reconcileWatchScope(): Promise<void>;
}) {
  const { queue, source, setProgress } = dependencies;
  const idle = (message: string) => setProgress({ phase: 'idle', done: 0, total: null, message });

  async function setOnboardingStage(stage: OnboardingStage, credential?: GitHubCredentialSnapshot) {
    const patch = { onboardingStage: stage, seenOnboarding: stageMarksOnboardingSeen(stage) };
    if (credential) await authStore.updateForGitHubCredential(credential, patch);
    else await authStore.update(patch);
  }

  async function finishOnboarding(credential: GitHubCredentialSnapshot, failed: boolean) {
    const config = await authStore.getConfig();
    if (config.onboardingStage !== 'syncing') return;
    const stage = failed ? 'sync_failed' : resolveOnboardingStageAfterSync(true, await db.stars.count());
    await setOnboardingStage(stage, credential);
  }

  async function execute<T>(
    phase: 'full' | 'incremental' | 'rescan',
    operation: (credential: GitHubCredentialSnapshot, messages: MessageCatalog) => Promise<T>,
    complete: (result: T, messages: MessageCatalog) => string,
  ): Promise<T> {
    const messages = getMessages(await authStore.getLocale());
    let credential: GitHubCredentialSnapshot | undefined;
    try {
      credential = await authStore.getGitHubCredentialSnapshot();
      if (!credential.mainToken) throw new Error(GH_NO_TOKEN);
      setProgress({ phase, done: 0, total: null, message: phase === 'full'
        ? messages.background.fetchingPages(1)
        : phase === 'rescan' ? messages.background.rescanningPages(1) : messages.background.incrementalSyncing });
      const result = await operation(credential, messages);
      await authStore.assertGitHubCredentialCurrent(credential);
      await dependencies.reconcileWatchScope();
      if (phase !== 'rescan') await finishOnboarding(credential, false);
      await authStore.assertGitHubCredentialCurrent(credential);
      idle(complete(result, messages));
      return result;
    } catch (error) {
      if (phase !== 'rescan' && credential) {
        // A replaced account must not inherit the old operation's onboarding terminal.
        await finishOnboarding(credential, true).catch(() => {});
      }
      idle(translateError(error, messages));
      throw error;
    }
  }

  // Backfill already owns a queue slot; calling the queued entry here would deadlock.
  const performFullSyncJob = (includeOwnedPublic = true) => execute('full',
    (credential) => source.syncFull(setProgress, { credential, includeOwnedPublic }),
    (result, messages) => messages.background.fullDone(result.added));

  return {
    setOnboardingStage,
    performFullSyncJob,
    syncFull: (includeOwnedPublic = true) => queue.run(() => performFullSyncJob(includeOwnedPublic), { kind: 'stars-sync' }),
    syncIncremental: () => queue.run(() => execute('incremental',
      (credential) => source.syncIncremental({ credential }),
      (result, messages) => messages.background.incrementalDone(result.added)), { kind: 'stars-sync' }),
    syncRescan: () => queue.run(() => execute('rescan',
      (credential) => source.syncRescan(setProgress, { credential }),
      (result, messages) => messages.background.rescanDone(result.tombstoned, result.revived)), { kind: 'stars-sync' }),
    syncOwnedPublicRepositories: () => queue.run(() => source.syncOwnedPublicRepositories(), { kind: 'stars-sync' }),
  };
}
