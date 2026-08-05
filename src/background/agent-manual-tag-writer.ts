import type { ToolExecutionContext } from '@/agent-harness';
import type {
  BgsmAgentManualTagAdditionResult,
  GlobalTagBulkDeletionResult,
  VisibleTagBulkRemoval,
  VisibleTagBulkRemovalResult,
} from '@/storage/idb-tag-store';
import type { SerializedRunOptions } from './serialized-runner';

export type AgentManualTagWriter = (
  fullName: string,
  tags: readonly string[],
  context: ToolExecutionContext,
) => Promise<BgsmAgentManualTagAdditionResult>;

export type AgentVisibleTagRemovalWriter = (
  changes: readonly VisibleTagBulkRemoval[],
  context: ToolExecutionContext,
) => Promise<VisibleTagBulkRemovalResult>;

export type AgentGlobalTagDeletionWriter = (
  tags: readonly string[],
  context: ToolExecutionContext,
) => Promise<GlobalTagBulkDeletionResult>;

type AgentManualTagWriterDependencies = Readonly<{
  runSerialized: <T>(
    operation: () => Promise<T>,
    options?: SerializedRunOptions,
  ) => Promise<T>;
  isBlocked: () => boolean | Promise<boolean>;
  write: (
    fullName: string,
    tags: readonly string[],
  ) => Promise<BgsmAgentManualTagAdditionResult>;
}>;

export function createQueuedAgentManualTagWriter(
  dependencies: AgentManualTagWriterDependencies,
): AgentManualTagWriter {
  return (fullName, tags, context) => runQueuedAgentTagMutation(
    dependencies,
    context,
    () => dependencies.write(fullName, tags),
  );
}

export function createQueuedAgentVisibleTagRemovalWriter(
  dependencies: Readonly<{
    runSerialized: AgentManualTagWriterDependencies['runSerialized'];
    isBlocked: AgentManualTagWriterDependencies['isBlocked'];
    write: (
      changes: readonly VisibleTagBulkRemoval[],
    ) => Promise<VisibleTagBulkRemovalResult>;
  }>,
): AgentVisibleTagRemovalWriter {
  return (changes, context) => runQueuedAgentTagMutation(
    dependencies,
    context,
    () => dependencies.write(changes),
  );
}

export function createQueuedAgentGlobalTagDeletionWriter(
  dependencies: Readonly<{
    runSerialized: AgentManualTagWriterDependencies['runSerialized'];
    isBlocked: AgentManualTagWriterDependencies['isBlocked'];
    write: (tags: readonly string[]) => Promise<GlobalTagBulkDeletionResult>;
  }>,
): AgentGlobalTagDeletionWriter {
  return (tags, context) => runQueuedAgentTagMutation(
    dependencies,
    context,
    () => dependencies.write(tags),
  );
}

function runQueuedAgentTagMutation<TResult>(
  dependencies: Pick<AgentManualTagWriterDependencies, 'runSerialized' | 'isBlocked'>,
  context: ToolExecutionContext,
  write: () => Promise<TResult>,
): Promise<TResult> {
  return dependencies.runSerialized(async () => {
    if (await dependencies.isBlocked()) {
      throw new TypeError(
        'Cubby tag writes are unavailable while full-library tag changes are being applied.',
      );
    }
    context.markWriteStarted?.();
    return write();
  }, { signal: context.signal });
}
