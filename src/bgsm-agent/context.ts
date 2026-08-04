export const BGSM_AGENT_CONTEXT_MAX_CHARS = 4_096;

export type BgsmAgentContext = {
  schemaVersion: 1;
  application: {
    name: 'Better GitHub Stars Manager';
    runtime: 'Chrome extension';
    purpose: 'Organize the user\'s GitHub starred repositories with local search, tags, notes, and favorites.';
  };
  dataBoundary: {
    sourceOfTruth: 'IndexedDB';
    repositoryScope: 'Currently starred repositories stored by the extension';
    repositoryDataAccess: 'Use the available tools; do not infer records that tools did not return';
  };
  capabilities: {
    read: string[];
    write: string[];
  };
  safety: {
    explicitUserRequestRequiredFor: string[];
    excludedTagPolicy: 'enforced_locally_not_disclosed';
  };
  contextStatus: {
    limited: boolean;
    reason: 'size_budget' | null;
  };
};

export function buildBgsmAgentContext(): BgsmAgentContext {
  return {
    schemaVersion: 1,
    application: {
      name: 'Better GitHub Stars Manager',
      runtime: 'Chrome extension',
      purpose: 'Organize the user\'s GitHub starred repositories with local search, tags, notes, and favorites.',
    },
    dataBoundary: {
      sourceOfTruth: 'IndexedDB',
      repositoryScope: 'Currently starred repositories stored by the extension',
      repositoryDataAccess: 'Use the available tools; do not infer records that tools did not return',
    },
    capabilities: {
      read: [
        'List existing tags',
        'List repositories, look up an exact repository, or search locally stored stars within the authorized scope',
        'Inspect repositories that use a tag',
        'List public repository directories at a fixed commit',
        'Search indexed public code in up to five frozen-scope repositories per call',
        'Read bounded public repository file lines at a fixed commit',
        'Read private user-authored notes on explicit request for repositories in the authorized scope',
      ],
      write: [
        'Add manual tags to a repository after inspecting local data',
        'Remove visible tags from repositories in the authorized scope after inspecting local data',
        'Delete tags from every repository after inspecting current tag usage',
      ],
    },
    safety: {
      explicitUserRequestRequiredFor: [
        'Remove a tag from a repository',
        'Delete a tag from every repository',
      ],
      excludedTagPolicy: 'enforced_locally_not_disclosed',
    },
    contextStatus: {
      limited: false,
      reason: null,
    },
  };
}

export function limitBgsmAgentContext(
  context: BgsmAgentContext,
  maxChars = BGSM_AGENT_CONTEXT_MAX_CHARS,
): BgsmAgentContext {
  if (JSON.stringify(context, null, 2).length <= maxChars) return context;
  return {
    schemaVersion: 1,
    application: {
      name: 'Better GitHub Stars Manager',
      runtime: 'Chrome extension',
      purpose: 'Organize the user\'s GitHub starred repositories with local search, tags, notes, and favorites.',
    },
    dataBoundary: {
      sourceOfTruth: 'IndexedDB',
      repositoryScope: 'Currently starred repositories stored by the extension',
      repositoryDataAccess: 'Use the available tools; do not infer records that tools did not return',
    },
    capabilities: {
      read: [
        'List existing tags',
        'List repositories, look up an exact repository, or search locally stored stars within the authorized scope',
        'Inspect repositories that use a tag',
        'List public repository directories at a fixed commit',
        'Search indexed public code in up to five frozen-scope repositories per call',
        'Read bounded public repository file lines at a fixed commit',
        'Read private user-authored notes on explicit request for repositories in the authorized scope',
      ],
      write: [
        'Add manual tags to a repository after inspecting local data',
        'Remove visible tags from repositories in the authorized scope after inspecting local data',
        'Delete tags from every repository after inspecting current tag usage',
      ],
    },
    safety: {
      explicitUserRequestRequiredFor: [
        'Remove a tag from a repository',
        'Delete a tag from every repository',
      ],
      excludedTagPolicy: 'enforced_locally_not_disclosed',
    },
    contextStatus: {
      limited: true,
      reason: 'size_budget',
    },
  };
}
