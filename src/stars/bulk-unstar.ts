export const MAX_BULK_UNSTAR_REPOSITORIES = 100;

export type BulkUnstarInput = Readonly<{
  accountLogin: string;
  fullNames: readonly string[];
}>;

export type BulkUnstarResult = {
  succeeded: string[];
  failed: { fullName: string; error: string }[];
  notAttempted: string[];
};

/** Stop after a failed request so retries never silently repeat a partial batch. */
export async function bulkUnstarRepositories(
  fullNames: readonly string[],
  operations: {
    assertCurrent(): Promise<void>;
    unstar(fullName: string): Promise<void>;
    commit(fullName: string): Promise<void>;
  },
): Promise<BulkUnstarResult> {
  if (!Array.isArray(fullNames) || fullNames.length === 0
    || fullNames.length > MAX_BULK_UNSTAR_REPOSITORIES
    || fullNames.some((name) => typeof name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(name))
    || new Set(fullNames.map((name) => name.toLowerCase())).size !== fullNames.length) {
    throw new Error('INVALID_UNSTAR_BATCH');
  }
  const result: BulkUnstarResult = { succeeded: [], failed: [], notAttempted: [] };
  for (const [index, fullName] of fullNames.entries()) {
    try {
      await operations.assertCurrent();
      await operations.unstar(fullName);
      await operations.assertCurrent();
      await operations.commit(fullName);
      result.succeeded.push(fullName);
    } catch (error) {
      result.failed.push({ fullName, error: error instanceof Error ? error.message : String(error) });
      result.notAttempted = fullNames.slice(index + 1);
      break;
    }
  }
  return result;
}
