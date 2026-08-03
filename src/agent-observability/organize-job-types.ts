import type { OrganizeJobId, RunId } from '@/bgsm-agent/identity';
import type {
  DevTraceEventDataByKind,
  DevTraceTerminalState,
} from './contracts';

export type OrganizeJobRunTraceStart = Readonly<{
  jobId: OrganizeJobId;
  executionEpochId: string;
  startedAt: number;
  resumeExisting?: boolean;
}>;

export type OrganizeJobRunTrace = Readonly<{
  recordPreflight(
    state: DevTraceEventDataByKind['organize_preflight_state']['state'],
    repositoryCount: number | null,
  ): void;
  recordGeneration(input: Readonly<{
    runId: RunId;
    generation: number;
    state: DevTraceEventDataByKind['organize_generation_state']['state'];
    cause: DevTraceEventDataByKind['organize_generation_state']['cause'];
    parentRunId: RunId | null;
    parentGeneration: number | null;
    repositoryCount: number;
  }>): void;
  recordBatch(input: DevTraceEventDataByKind['organize_batch_state']): void;
  recordProviderAttempt(input: DevTraceEventDataByKind['organize_provider_attempt']): void;
  recordWatchdog(input: DevTraceEventDataByKind['watchdog_state']): void;
  recordDurableState(input: Readonly<{
    revision: number;
    source: DevTraceEventDataByKind['organize_durable_state']['source'];
  }>): void;
  recordRestore(input: DevTraceEventDataByKind['organize_restore_state']): void;
  recordReview(input: DevTraceEventDataByKind['organize_review_state']): void;
  recordSelection(input: DevTraceEventDataByKind['organize_selection_state']): void;
  recordApply(input: DevTraceEventDataByKind['organize_apply_state']): void;
  recordApplyChunk(input: DevTraceEventDataByKind['organize_apply_chunk']): void;
  recordReceipt(input: DevTraceEventDataByKind['organize_receipt_state']): void;
  recordCancellation(source: 'user' | 'port' | 'runtime' | 'scenario'): void;
  finish(state: DevTraceTerminalState, reasonCode: string | null): void;
  flush(): Promise<void>;
}>;

export type OrganizeJobRunTraceFactory = (input: OrganizeJobRunTraceStart) => OrganizeJobRunTrace;

export function organizeJobRunRootOperationId(jobId: OrganizeJobId): string {
  return `organize_job:${jobId}`;
}
