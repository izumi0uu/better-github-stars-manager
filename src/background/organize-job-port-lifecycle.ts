import type {
  BgsmAgentController,
  OrganizeJobRunControllerIdentity,
  OrganizeRunIdentity,
} from './organize-job-controller';
import type {
  BgsmOrganizeControlRole,
  BgsmOrganizeJobControllerIdentity,
  BgsmOrganizeJobDisconnected,
  BgsmOrganizeJobServerMessage,
} from '@/utils/messaging';
import type { OrganizeJobRecord } from '@/types';

export function resolveBgsmOrganizeControlRole(input: Readonly<{
  page: BgsmOrganizeJobControllerIdentity;
  job: Pick<OrganizeJobRecord, 'status' | 'controllerId' | 'sessionId'> | null | undefined;
  ownerConnected: boolean;
}>): BgsmOrganizeControlRole | null {
  if (!input.job || input.job.status === 'completed' || input.job.status === 'cancelled') return null;
  if (!input.ownerConnected) return 'owner_lost';
  return input.job.controllerId === input.page.controllerId
    && input.job.sessionId === input.page.sessionId
    ? 'owner'
    : 'observer';
}

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
  page: BgsmOrganizeJobControllerIdentity;
  controller: Pick<BgsmAgentController, 'getSnapshot'>;
  post(message: BgsmOrganizeJobServerMessage): void;
}>): Promise<void> {
  let snapshot;
  try {
    snapshot = input.controller.getSnapshot(input.identity);
  } catch {
    input.post({
      type: 'bgsmOrganizeJobRunDisconnected',
      controllerId: input.page.controllerId,
      sessionId: input.page.sessionId,
      runId: input.identity.runId,
      generation: input.identity.generation,
    });
    return;
  }
  input.post({
    type: 'bgsmOrganizeJobRunSnapshot',
    snapshot: Object.freeze({
      ...snapshot,
      controllerId: input.page.controllerId,
      sessionId: input.page.sessionId,
    }),
  });
}

export async function settleBgsmOrganizeJobDisconnect(input: Readonly<{
  identity: OrganizeJobRunControllerIdentity;
  controller: Pick<BgsmAgentController, 'findLatestSnapshot'>;
  post?(message: BgsmOrganizeJobDisconnected): void;
}>): Promise<void> {
  let current: ReturnType<BgsmAgentController['findLatestSnapshot']> = null;
  try {
    current = input.controller.findLatestSnapshot(input.identity);
  } catch {
    current = null;
  }
  input.post?.({
    type: 'bgsmOrganizeJobRunDisconnected',
    controllerId: input.identity.controllerId,
    sessionId: input.identity.sessionId,
    runId: current?.runId ?? null,
    generation: current?.generation ?? null,
  });
}
