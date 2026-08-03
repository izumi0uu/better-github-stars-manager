import type { TraceArtifactV1 } from '@/agent-observability';

export const DEV_ARTIFACT_WORKER_MARKER = 'bgsm-agent-artifact-worker-v1';

export type ArtifactWorkerRequest =
  | Readonly<{
      type: 'artifact_parse_start';
      jobId: string;
      maxBytes: number;
    }>
  | Readonly<{
      type: 'artifact_parse_chunk';
      jobId: string;
      jsonChunk: string;
      done: boolean;
    }>
  | Readonly<{
      type: 'artifact_parse_file';
      jobId: string;
      file: File;
      maxBytes: number;
    }>
  | Readonly<{
      type: 'artifact_parse_cancel';
      jobId: string;
    }>;

export type ArtifactWorkerErrorCode =
  | 'too_large'
  | 'invalid_json'
  | 'unsupported_schema'
  | 'invalid_artifact'
  | 'worker_failed';

export type ArtifactWorkerResponse =
  | Readonly<{
      type: 'artifact_parse_result';
      jobId: string;
      artifact: TraceArtifactV1;
    }>
  | Readonly<{
      type: 'artifact_parse_error';
      jobId: string;
      code: ArtifactWorkerErrorCode;
      message: string;
    }>;
