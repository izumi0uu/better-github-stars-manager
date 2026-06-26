import type { OnboardingStage } from '@/types';

export function isOnboardingComplete(stage: OnboardingStage): boolean {
  return stage === 'done';
}

export function isOnboardingCardStage(stage: OnboardingStage): boolean {
  return stage !== 'coach' && stage !== 'done';
}

export function normalizeOnboardingStage(
  stage: OnboardingStage | null | undefined,
  seenOnboarding: boolean | null | undefined,
  hasToken: boolean,
): OnboardingStage {
  if (seenOnboarding || stage === 'done') return 'done';
  if (!hasToken) return 'needs_token';
  switch (stage) {
    case 'awaiting_sync':
    case 'syncing':
    case 'sync_failed':
    case 'empty_library':
    case 'coach':
      return stage;
    default:
      return 'awaiting_sync';
  }
}

export function stageMarksOnboardingSeen(stage: OnboardingStage): boolean {
  return stage === 'done';
}

export function resolveOnboardingStageAfterSync(
  hasToken: boolean,
  grandTotal: number,
): OnboardingStage {
  if (!hasToken) return 'needs_token';
  return grandTotal > 0 ? 'coach' : 'empty_library';
}

export function shouldTrackOnboardingSync(stage: OnboardingStage): boolean {
  return stage !== 'done';
}
