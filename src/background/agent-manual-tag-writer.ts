import type { ToolExecutionContext } from '@/agent-harness';
import type { BgsmAgentManualTagAdditionResult } from '@/storage/idb-tag-store';
import type { SerializedRunOptions } from './serialized-runner';

export type AgentManualTagWriter = (
  fullName: string,
  tags: readonly string[],
  context: ToolExecutionContext,
) => Promise<BgsmAgentManualTagAdditionResult>;

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
  return (fullName, tags, context) => dependencies.runSerialized(async () => {
    if (await dependencies.isBlocked()) {
      throw new TypeError(
        'Cubby tag writes are unavailable while full-library tag changes are being applied.',
      );
    }
    context.markWriteStarted?.();
    return dependencies.write(fullName, tags);
  }, { signal: context.signal });
}
