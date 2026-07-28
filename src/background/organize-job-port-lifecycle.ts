import type {
  BgsmAgentController,
  OrganizeJobRunControllerIdentity,
  OrganizeRunIdentity,
} from './organize-job-controller';
import type {
  BgsmOrganizeJobDisconnected,
  BgsmOrganizeJobServerMessage,
} from '@/utils/messaging';
import type { OrganizeJobRecord } from '@/types';

export function canReplaceBlockedDurableRun(
  job: Pick<OrganizeJobRecord, 'status' | 'controllerId' | 'sessionId'> | null | undefined,
  identity: OrganizeJobRunControllerIdentity,
): boolean {
  return job?.status === 'analysis_blocked'
    && job.controllerId === identity.controllerId
    && job.sessionId === identity.sessionId;
}

export async function resolveBgsmOrganizeJobReconnect(input: Readonly<{
  identity: OrganizeRunIdentity;
  controller: Pick<BgsmAgentController, 'getSnapshot'>;
  post(message: BgsmOrganizeJobServerMessage): void;
}>): Promise<void> {
  let snapshot;
  try {
    snapshot = input.controller.getSnapshot(input.identity);
  } catch {
    input.post({
      type: 'bgsmOrganizeJobRunDisconnected',
      controllerId: input.identity.controllerId,
      sessionId: input.identity.sessionId,
      runId: input.identity.runId,
      generation: input.identity.generation,
    });
    return;
  }
  input.post({ type: 'bgsmOrganizeJobRunSnapshot', snapshot });
}

export async function settleBgsmOrganizeJobDisconnect(input: Readonly<{
  identity: OrganizeJobRunControllerIdentity;
  controller: Pick<
    BgsmAgentController,
    | 'findLatestSnapshot'
    | 'disconnectController'
    | 'releaseController'
  >;
  abortRun(runId: string): void;
  releaseRuns?(runIds: readonly string[]): void;
  post?(message: BgsmOrganizeJobDisconnected): void;
}>): Promise<void> {
  const current = input.controller.findLatestSnapshot(input.identity);
  if (!current) {
    input.post?.({
      type: 'bgsmOrganizeJobRunDisconnected',
      controllerId: input.identity.controllerId,
      sessionId: input.identity.sessionId,
      runId: null,
      generation: null,
    });
    const released = input.controller.releaseController(input.identity);
    input.releaseRuns?.(released);
    return;
  }

  input.abortRun(current.runId);
  const settled = input.controller.disconnectController(input.identity);
  input.post?.({
    type: 'bgsmOrganizeJobRunDisconnected',
    controllerId: input.identity.controllerId,
    sessionId: input.identity.sessionId,
    runId: settled?.runId ?? current.runId,
    generation: settled?.generation ?? current.generation,
  });
  const released = input.controller.releaseController(input.identity);
  input.releaseRuns?.(released);
}
